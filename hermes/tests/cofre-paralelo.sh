#!/usr/bin/env bash
# Cofre do motor sob gravação em paralelo (contêiner, volume e chave de teste; nada de dados reais).
#
# Antes, o gocryptfs montado como root trocava de usuário a cada arquivo e, com várias threads gravando, metade
# das criações voltava "Operation not permitted" (instalar uma dependência do motor falhava; o estado do gateway
# não era salvo). Agora ele roda como o usuário do motor. Este teste:
#   1. monta um cofre do jeito antigo (gocryptfs como root) e grava dados nele;
#   2. abre o mesmo cofre pela imagem nova (ergon-vault.py) e confere que os dados continuam lá;
#   3. grava em paralelo (16 threads) como o motor e exige 0 erros;
#   4. confere que o motor não lê a memória do gocryptfs e não tem o privilégio de montar.
# Uso: bash hermes/tests/cofre-paralelo.sh [imagem]   (padrão: constrói ./hermes como ergon-hermes:teste)
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
IMG="${1:-}"
if [ -z "$IMG" ]; then IMG=ergon-hermes:teste; docker build -q -t "$IMG" ./hermes >/dev/null || { echo "FALHA: build"; exit 1; }; fi
TOK=tokentestetokentestetokenteste123
KEY=$(printf 'c3%.0s' $(seq 1 32))
C=ergon-cofre-paralelo
V=ergon-cofre-paralelo-vault
HOSTDIR="$(pwd)/hermes/tests"
falhas=0
ok() { echo "ok    $1"; }
falha() { echo "FALHA $1"; falhas=$((falhas + 1)); }
limpa() { docker rm -f $C ${C}-antigo >/dev/null 2>&1; docker volume rm $V >/dev/null 2>&1; }
limpa
docker volume create $V >/dev/null
CAPS=(--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined --cap-drop NET_RAW --cap-drop MKNOD
      --cap-drop AUDIT_WRITE --cap-drop SETFCAP --security-opt no-new-privileges:true)

# 1. cofre do jeito antigo, com arquivos do motor e de root
docker run -d --name ${C}-antigo "${CAPS[@]}" --network none -v $V:/vault --entrypoint sleep "$IMG" infinity >/dev/null
docker exec ${C}-antigo sh -c "mkdir -p /m && printf %s $KEY | gocryptfs -q -init -passfile /dev/stdin /vault >/dev/null 2>&1 \
  && printf %s $KEY | gocryptfs -q -nosyslog -passfile /dev/stdin -allow_other -nonempty /vault /m \
  && chown 10000:10000 /m && mkdir -p /m/memories && echo dado-de-antes > /m/memories/antes.md && chown -R 10000:10000 /m/memories \
  && echo de-root > /m/de-root.txt && touch /m/.ergon-vault && chown 10000:10000 /m/.ergon-vault && umount /m" \
  && ok "cofre antigo criado (gocryptfs como root)" || falha "cofre antigo"
docker rm -f ${C}-antigo >/dev/null

# 2. a imagem nova abre o mesmo cofre
docker run -d --name $C "${CAPS[@]}" --network none --tmpfs /opt/data:mode=0700,uid=10000,gid=10000 \
  -e ERGON_VAULT=1 -e ERGON_BRIDGE_TOKEN=$TOK -e API_SERVER_ENABLED=false -e API_SERVER_KEY=chave-api-de-teste-123456 \
  -v $V:/vault "$IMG" gateway run >/dev/null
sleep 4
docker exec $C /opt/hermes/.venv/bin/python -c "
import urllib.request,json
H={'X-Ergon-Bridge-Token':'$TOK','Content-Type':'application/json'}
print(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8644/unlock',data=json.dumps({'key':'$KEY'}).encode(),headers=H),timeout=600).read().decode())" \
  | grep -q '"ok": true' && ok "imagem nova abriu o cofre" || falha "abrir o cofre"
sleep 6
[ "$(docker exec -u 10000:10000 $C cat /opt/data/memories/antes.md 2>/dev/null)" = "dado-de-antes" ] && ok "dados de antes preservados" || falha "dados de antes"
[ "$(docker exec -u 10000:10000 $C cat /opt/data/de-root.txt 2>/dev/null)" = "de-root" ] && ok "arquivo criado por root legível" || falha "arquivo de root"
docker exec $C sh -c 'ps -eo user,args | grep -q "^hermes .*[g]ocryptfs"' && ok "gocryptfs roda como o usuário do motor" || falha "gocryptfs ainda como root"

# 3. gravação em paralelo
docker exec -i $C sh -c 'cat > /tmp/eperm-stress.py' < "$HOSTDIR/eperm-stress.py"
out=$(docker exec -u 10000:10000 $C /opt/hermes/.venv/bin/python /tmp/eperm-stress.py /opt/data/cache/stress 16 150 2>&1 | tail -1)
echo "      $out"
echo "$out" | grep -q "erros=0 " && ok "16 threads gravando: nenhum erro" || falha "gravação em paralelo"

# 4. isolamento
G=$(docker exec $C sh -c 'pgrep -u 10000 -x gocryptfs | head -1')
docker exec -u 10000:10000 $C sh -c "head -c 1 /proc/$G/mem >/dev/null 2>&1" && falha "motor leu a memória do gocryptfs" || ok "motor não lê a memória do gocryptfs"
docker exec -u 10000:10000 $C sh -c "head -c 1 /proc/$G/environ >/dev/null 2>&1" && falha "motor leu o ambiente do gocryptfs" || ok "motor não lê o ambiente do gocryptfs"
P=$(docker exec $C sh -c 'pgrep -u 10000 -f "gateway run" | head -1')
bnd=$(docker exec $C sh -c "grep CapBnd /proc/$P/status | cut -f2")
[ $(( 0x$bnd & (1 << 21) )) -eq 0 ] && ok "motor sem o privilégio de montar (CapBnd $bnd)" || falha "motor com CAP_SYS_ADMIN"

limpa
[ $falhas -eq 0 ] && echo "TUDO OK" || echo "$falhas FALHA(S)"
exit $falhas

#!/bin/sh
# Confere a imagem única da nuvem (app + motor num contêiner só) como o orquestrador a sobe: root só com SETUID, SETGID
# e KILL, rootfs só leitura, os dois discos. Espera: o app como 1000 e o motor como 10000, cada disco fechado (700), um
# sem ler o do outro, o motor sem as variáveis do app, e o supervisor encerrando os dois no SIGTERM.
# Uso: sh nuvem/conferir.sh <imagem>
set -eu
IMG="$1"; N="ergon-nuvem-conferir-$$"
falha() { echo "::error::imagem única: $1"; docker logs "$N" 2>&1 | tail -30; docker rm -f "$N" >/dev/null 2>&1; docker volume rm -f "$N-a" "$N-m" >/dev/null 2>&1; exit 1; }
docker volume create "$N-a" >/dev/null; docker volume create "$N-m" >/dev/null
# os discos de verdade nascem com o dono certo (mkfs root_owner): aqui, o mesmo à mão
docker run --rm -v "$N-a:/a" -v "$N-m:/m" --entrypoint sh "$IMG" -c 'chown 1000:1000 /a && chown 10000:10000 /m && chmod 755 /a /m && echo segredo > /a/teste && chmod 644 /a/teste'
docker run -d --name "$N" --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --init -v "$N-a:/data" -v "$N-m:/opt/data" \
  -e ERGON_SETUP_TOKEN=segredo-do-app-nao-pode-ir-ao-motor -e ERGON_DATA_DIR=/data \
  -e MOTOR__HOME=/opt/data -e MOTOR__HERMES_HOME=/opt/data -e MOTOR__ERGON_VAULT=plano -e MOTOR__API_SERVER_ENABLED=true -e MOTOR__API_SERVER_HOST=127.0.0.1 -e MOTOR__API_SERVER_PORT=8642 "$IMG" >/dev/null
i=0; until docker exec "$N" sh -c 'ps -eo user,args | grep -q "^1000 .*node server" && ps -eo user,args | grep -q "^hermes .*ergon-vault"' 2>/dev/null; do i=$((i+1)); [ $i -lt 60 ] || falha "app e motor não subiram com os usuários certos"; sleep 1; done
[ "$(docker exec "$N" stat -c %a /data)" = 700 ] || falha "o disco do app não ficou fechado (700)"
[ "$(docker exec "$N" stat -c %a /opt/data)" = 700 ] || falha "o disco do motor não ficou fechado (700)"
docker exec -u 10000:10000 "$N" cat /data/teste >/dev/null 2>&1 && falha "o motor lê o disco do app"
docker exec -u 1000:1000 "$N" ls /opt/data >/dev/null 2>&1 && falha "o app lê o disco do motor"
# nada do app legível pelo motor fora do disco dele: o segredo do Google e qualquer arquivo de /app só de dono
docker exec -u 10000:10000 "$N" sh -c 'test ! -e /app/google-app.secret || ! cat /app/google-app.secret >/dev/null 2>&1' || falha "o motor lê o segredo do app do Google"
p=$(docker exec "$N" sh -c 'ps -eo pid,user,args | awk "\$2==\"hermes\" && /ergon-vault/ {print \$1; exit}"')
amb=$(docker exec -u 10000:10000 "$N" sh -c "tr '\\0' '\\n' < /proc/$p/environ") || falha "não consegui ler o ambiente do motor"
echo "$amb" | grep -q '^HERMES_HOME=/opt/data$' || falha "o motor não recebeu as variáveis dele (MOTOR__)"
echo "$amb" | grep -q '^ERGON_SETUP_TOKEN=' && falha "o motor recebeu variável do app"
docker exec "$N" sh -c "grep '^CapEff' /proc/$p/status" | grep -q ':\s*0000000000000000$' || falha "o motor ficou com capacidades"
docker stop -t 30 "$N" >/dev/null
[ "$(docker inspect -f '{{.State.Running}}' "$N")" = false ] || falha "não encerrou no SIGTERM"
docker rm -f "$N" >/dev/null; docker volume rm -f "$N-a" "$N-m" >/dev/null
echo "imagem única conferida: app 1000, motor 10000, discos fechados e separados, ambiente do motor limpo, encerra no SIGTERM"

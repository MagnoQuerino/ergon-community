#!/usr/bin/env bash
# rc.46: o registro alternativo do lançador (ergon.sh), para instalar da China, onde o ghcr.io falha. Com um Docker e um
# curl de mentira (nenhuma instalação real é tocada) confere: com ERGON_REGISTRY (no ambiente ou no .env), as imagens do
# Ergon vêm de lá e ganham o nome de sempre, sem "compose pull"; sem ele, o espelho publicado com a versão só entra
# quando o ghcr.io não responde; o registro que falha cai no de sempre; presas a um digest, o docker-compose.yml passa a
# citar o registro alternativo com o mesmo digest; um registro com jeito estranho para tudo; e
# ERGON_MANIFESTO_URL troca o endereço da versão publicada.
#   bash scripts/teste-registro.sh            (ERGON_SH=<outro ergon.sh> testa outra cópia)
set -u
unset LC_ALL LC_MESSAGES ERGON_LANG ERGON_REGISTRY ERGON_MANIFESTO_URL; export LANG=pt_BR.UTF-8
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ERGON_SH="${ERGON_SH:-$AQUI/../ergon.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
OKS=0; FALHAS=0
check() { if eval "$2"; then OKS=$((OKS + 1)); echo "  ok    $1"; else FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; fi; }

C=ghcr.io/dono/ergon-community; M=ghcr.io/dono/ergon-community-hermes; V=1.1.0-rc.46
CN=registry.cn-hangzhou.aliyuncs.com/ergon
mkdir -p "$T/inst" "$T/bin"
cp "$ERGON_SH" "$T/inst/ergon.sh"
compose_com() {
  cat > "$T/inst/docker-compose.yml" <<EOF
services:
  ergon:
    image: $C:$V
  hermes:
    image: $M:$V
  motores:
    image: $C:$V
    environment:
      ERGON_MOTOR_IMAGE: $M:$V
      ERGON_REGISTRY: \${ERGON_REGISTRY:-}
      ERGON_REGISTRY_ESPELHO: "$1"
EOF
}
# Docker de mentira: "pull" só dá certo para o que casa com FAKE_PULL_OK; tudo fica registrado
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
case "$1" in
  pull) [[ "${@: -1}" =~ $FAKE_PULL_OK ]] ;;
  *) exit 0 ;;
esac
EOF
# curl de mentira: o código HTTP do ghcr.io (000 = não responde, como na China)
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$LOG"
printf '%s' "${FAKE_GHCR:-401}"
EOF
chmod +x "$T/bin/docker" "$T/bin/curl"
export PATH="$T/bin:$PATH" LOG="$T/log" ERGON_MOTOR=docker ERGON_GHCR_URL=https://ghcr.invalido/v2/

# roda baixar_imagens no lançador carregado (só as funções), com o compose registrado no LOG
rodar() {
  : > "$LOG"
  ( cd "$T/inst" && source ./ergon.sh && compose() { echo "compose $*" >> "$LOG"; } && baixar_imagens ) > "$T/saida" 2>&1
}
puxou() { grep -qxF "docker pull -q $1" "$LOG"; }
nomeou() { grep -qxF "docker tag $1 $2" "$LOG"; }

echo "Registro escolhido (ERGON_REGISTRY)"
compose_com ""
export FAKE_PULL_OK="^$CN/"
ERGON_REGISTRY="https://$CN/" rodar; r=$?
check 'as duas imagens do Ergon vêm do registro escolhido (https:// e a barra final saem)' "[[ $r == 0 ]] && puxou $CN/ergon-community:$V && puxou $CN/ergon-community-hermes:$V"
check 'e ganham o nome de sempre (o compose e o gerente acham sem mudar nada)' "nomeou $CN/ergon-community:$V $C:$V && nomeou $CN/ergon-community-hermes:$V $M:$V"
check 'sem compose pull e sem perguntar ao ghcr.io' "! grep -q '^compose pull' '$LOG' && ! grep -q '^curl' '$LOG'"
printf 'ERGON_MOTOR=docker\nERGON_REGISTRY=%s\n' "$CN" > "$T/inst/.env"
rodar
check 'também pelo .env da pasta do Ergon' "puxou $CN/ergon-community-hermes:$V && ! grep -q '^compose pull' '$LOG'"
rm -f "$T/inst/.env"
export FAKE_PULL_OK='^ghcr\.io/'
ERGON_REGISTRY="$CN" rodar
check 'o registro escolhido não entregou: cai no de sempre (compose pull)' "puxou $CN/ergon-community-hermes:$V && grep -q '^compose pull' '$LOG' && grep -q 'tentando o de sempre' '$T/saida'"
ERGON_REGISTRY='registro com espaço' rodar; r=$?
check 'registro com jeito estranho: para, sem baixar nada' "[[ $r != 0 ]] && ! grep -q '^docker pull' '$LOG' && ! grep -q '^compose' '$LOG' && grep -q 'formato inesperado' '$T/saida'"

echo "Espelho da versão (ERGON_REGISTRY_ESPELHO no docker-compose.yml)"
compose_com "$CN"
export FAKE_PULL_OK="^$CN/" FAKE_GHCR=000
rodar
check 'ghcr.io sem resposta: as imagens vêm do espelho da versão, com o nome de sempre' "grep -q '^curl.*ghcr.invalido' '$LOG' && puxou $CN/ergon-community-hermes:$V && nomeou $CN/ergon-community-hermes:$V $M:$V && ! grep -q '^compose pull' '$LOG'"
export FAKE_GHCR=401
rodar
check 'ghcr.io respondendo: o de sempre, e o espelho nem é tentado' "grep -q '^compose pull' '$LOG' && ! grep -q '^docker pull -q $CN' '$LOG'"
compose_com ""
export FAKE_GHCR=000
rodar
check 'versão sem espelho e ghcr.io sem resposta: o de sempre (sem inventar endereço)' "grep -q '^compose pull' '$LOG' && ! grep -q 'aliyuncs' '$LOG'"
compose_com "__ESPELHO__"
rodar
check 'pacote montado sem trocar o marcador do espelho: ignorado' "grep -q '^compose pull' '$LOG' && ! grep -q '__ESPELHO__/' '$LOG'"

echo "Imagens presas a um digest (o Ergon Desktop prende as do manifesto)"
D1=sha256:$(printf 'c%063d' 1); D2=sha256:$(printf 'd%063d' 2)
cat > "$T/inst/docker-compose.yml" <<EOF
services:
  ergon:
    image: $C@$D1
  hermes:
    image: $M@$D2
  motores:
    image: $C@$D1
    environment:
      ERGON_MOTOR_IMAGE: $M@$D2
      ERGON_REGISTRY_ESPELHO: ""
EOF
export FAKE_PULL_OK="^$CN/" FAKE_GHCR=401
ERGON_REGISTRY="$CN" rodar; r=$?
check 'pelo digest no registro escolhido, e o docker-compose.yml cita o registro com o MESMO digest' "[[ $r == 0 ]] && puxou $CN/ergon-community@$D1 && puxou $CN/ergon-community-hermes@$D2 && ! grep -q '^docker tag' '$LOG' \
  && [[ \$(grep -c '$CN/ergon-community@$D1' '$T/inst/docker-compose.yml') == 2 && \$(grep -c 'ERGON_MOTOR_IMAGE: $CN/ergon-community-hermes@$D2' '$T/inst/docker-compose.yml') == 1 ]] && ! grep -q 'ghcr.io' '$T/inst/docker-compose.yml'"

echo "Endereço da versão publicada (ERGON_MANIFESTO_URL)"
m="$( cd "$T/inst" && source ./ergon.sh && printf '%s' "$MANIFESTO" )"
check 'sem nada: o do GitHub' "[[ '$m' == https://github.com/*/latest.json ]]"
m="$( cd "$T/inst" && ERGON_MANIFESTO_URL=https://exemplo.cn/ergon/latest.json && export ERGON_MANIFESTO_URL && source ./ergon.sh && printf '%s' "$MANIFESTO" )"
check 'com ERGON_MANIFESTO_URL: o endereço dado' "[[ '$m' == https://exemplo.cn/ergon/latest.json ]]"
printf 'ERGON_MANIFESTO_URL=https://exemplo.cn/b/latest.json\n' > "$T/inst/.env"
m="$( cd "$T/inst" && source ./ergon.sh && printf '%s' "$MANIFESTO" )"
check 'também pelo .env' "[[ '$m' == https://exemplo.cn/b/latest.json ]]"

echo "$OKS ok, $FALHAS falha(s)"
[[ $FALHAS == 0 ]]

#!/usr/bin/env bash
# Homologação do pacote Docker numa máquina limpa e SEM login no registro de imagens, como uma pessoa faria:
# baixa o pacote publicado (ou usa PACOTE_DIR, montado do repositório), instala, apaga a pasta do zip, usa o comando
# "ergon" de outra pasta, testa conta, loja, modelos da comunidade, WhatsApp experimental, backup e "atualizar";
# depois "ergon remover" (os dados ficam), instala de novo (a conta volta) e "ergon remover --tudo" (nada fica).
#   REPO=dono/ergon-community bash scripts/homologar-pacote.sh
#   REPO=dono/ergon-community PACOTE_DIR=pacote bash scripts/homologar-pacote.sh
set -uo pipefail
REPO="${REPO:?REPO=dono/ergon-community}"
B=http://localhost:8787
E="$HOME/.local/bin/ergon"; PROG="$HOME/.local/share/ergon"
export ERGON_SEM_NAVEGADOR=1
R=0
ok() { echo "ok    $1 — $2"; }
falha() { echo "FALHA $1 — $2"; R=1; }
no_ar() { for _ in $(seq 1 150); do curl -fsS "$B/api/health" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }

[[ -n "${PACOTE_DIR:-}" ]] && PACOTE_DIR="$(cd "$PACOTE_DIR" && pwd)"
W="$(mktemp -d)"; cd "$W"
if [[ -n "${PACOTE_DIR:-}" ]]; then
  cp -r "$PACOTE_DIR" "$W/pacote"; V="$(cat "$W/pacote/VERSAO")"; ok "pacote do repositório" "versão $V (imagens publicadas)"
else
  M="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json")" || { falha "latest.json" "não baixou"; exit 1; }
  V="$(jq -r .version <<<"$M")"; URL="$(jq -r .bundle <<<"$M")"; SHA="$(jq -r .sha256 <<<"$M")"
  ok "latest.json" "versão $V"
  if curl -fsSL -o ergon.zip "$URL" && echo "$SHA  ergon.zip" | sha256sum -c - >/dev/null 2>&1; then ok "pacote baixado e conferido" "SHA-256 igual ao do latest.json"; else falha "pacote" "download ou SHA-256"; exit 1; fi
  mkdir pacote && (cd pacote && unzip -q ../ergon.zip)
fi
ok "conteúdo do pacote" "$(ls "$W/pacote" | tr '\n' ' ')"
DONO="$(echo "${REPO%%/*}" | tr 'A-Z' 'a-z')"
for img in ergon-community ergon-community-hermes; do
  if docker manifest inspect "ghcr.io/$DONO/$img:$V" >/dev/null 2>&1; then ok "imagem pública" "ghcr.io/$DONO/$img:$V baixa sem login"
  else falha "imagem pública" "ghcr.io/$DONO/$img:$V não baixa sem login"; fi
done
[[ $R == 0 ]] || exit 1

# ---------------------------------------------------------------- instalar a partir da pasta do zip
cp -r "$W/pacote" "$W/zip"; cd "$W/zip"
if ./ergon.sh instalar > "$W/instalar.log" 2>&1; then ok "ergon.sh instalar" "$(grep -v '^\s*$' "$W/instalar.log" | tail -1)"; else falha "ergon.sh instalar" "$(tail -5 "$W/instalar.log" | tr '\n' ' ')"; fi
[[ -x "$E" && -f "$PROG/ergon.sh" && -f "$PROG/docker-compose.yml" ]] && ok "instalado numa pasta fixa" "$PROG, comando $E" || falha "instalado numa pasta fixa" "$(ls -la "$PROG" "$E" 2>&1 | head -3 | tr '\n' ' ')"
cd /; rm -rf "$W/zip"; cd "$(mktemp -d)"
ok "pasta do zip apagada" "o resto roda pelo comando ergon, de outra pasta ($(pwd))"
no_ar && H="$(curl -fsS "$B/api/health")" && ok "no ar" "$H" || { falha "no ar" "sem resposta"; (cd "$PROG" && docker compose logs --tail 50); exit 1; }
grep -q "\"version\":\"$V\"" <<<"$H" && ok "versão no ar" "$V" || falha "versão no ar" "$H"
grep -q "\"raiz\":\"$PROG\"" "$HOME/.ergon/instalacao.json" && ok "registro da instalação" "aponta para a pasta fixa" || falha "registro da instalação" "$(cat "$HOME/.ergon/instalacao.json" 2>&1)"

J="$W/cookies"
PW="Hom-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
S=$(curl -sS -c "$J" -o "$W/setup.json" -w '%{http_code}' -H 'content-type: application/json' -H "origin: $B" -d "{\"username\":\"homologacao\",\"password\":\"$PW\",\"displayName\":\"Homologação\"}" "$B/api/auth/setup")
[[ "$S" == 200 ]] && ok "conta criada" "primeiro acesso" || falha "conta" "setup $S"
CSRF=$(curl -sS -b "$J" "$B/api/me" | jq -r .csrf)
c() { curl -sS -b "$J" -H "origin: $B" -H "x-csrf-token: $CSRF" "$@"; }
D=$(c "$B/api/distribution" | jq -r .distribution)
[[ "$D" == community ]] && ok "distribuição" "community" || falha "distribuição" "$D"
N=$(c "$B/api/packages/catalog/official" | jq '[.[] | select(.verified)] | length')
[[ "${N:-0}" -ge 15 ]] && ok "loja: oficiais" "$N pacotes verificados" || falha "loja: oficiais" "$N"
C=$(c "$B/api/packages/catalog/community")
NC=$(jq 'length' <<<"$C" 2>/dev/null)
[[ "${NC:-0}" -ge 1 ]] && ok "loja: modelos da comunidade" "$NC no catálogo público ($(jq -r '[.[].title] | join(", ")' <<<"$C"))" || falha "loja: modelos da comunidade" "$(head -c 200 <<<"$C")"
I=$(c -o "$W/inst.json" -w '%{http_code}' -H 'content-type: application/json' -d '{"id":"comunidade.exemplos.tema-mar-egeu"}' "$B/api/packages/catalog/community/install")
[[ "$I" == 200 ]] && ok "instalar modelo da comunidade" "baixado do repositório público, tamanho e SHA-256 conferidos" || falha "instalar modelo da comunidade" "$I $(head -c 200 "$W/inst.json")"
WA=$(c -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$B/api/integrations/whatsapp/start")
[[ "$WA" == 409 ]] && ok "WhatsApp experimental" "sem o aceite dos riscos, não conecta" || falha "WhatsApp experimental" "$WA"
T=$(c -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"title":"Tarefa da homologação"}' "$B/api/tasks")
[[ "$T" == 201 ]] && ok "tarefa" "criada" || falha "tarefa" "$T"

"$E" status > "$W/status.log" 2>&1 && ok "ergon status" "$(tail -1 "$W/status.log")" || falha "ergon status" "$(tail -2 "$W/status.log" | tr '\n' ' ')"
"$E" backup > "$W/backup.log" 2>&1 && ok "ergon backup" "$(tail -1 "$W/backup.log")" || falha "ergon backup" "$(tail -3 "$W/backup.log" | tr '\n' ' ')"
"$E" atualizar > "$W/atualizar.log" 2>&1 && ok "ergon atualizar" "$(tail -1 "$W/atualizar.log")" || falha "ergon atualizar" "$(tail -3 "$W/atualizar.log" | tr '\n' ' ')"

# ---------------------------------------------------------------- remover: o Ergon sai, os dados ficam
"$E" remover > "$W/remover.log" 2>&1 && ok "ergon remover" "$(tail -1 "$W/remover.log")" || falha "ergon remover" "$(tail -3 "$W/remover.log" | tr '\n' ' ')"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=ergon)" && -z "$(docker ps -aq --filter label=ergon.motor)" ]] && ok "contêineres" "nenhum do Ergon" || falha "contêineres" "$(docker ps -a --format '{{.Names}}' | tr '\n' ' ')"
[[ -z "$(docker images -q "ghcr.io/$DONO/ergon-community")" ]] && ok "imagens" "removidas" || falha "imagens" "ficaram"
docker volume ls -q | grep -q '^ergon_ergon-data$' && ok "dados guardados" "volume ergon_ergon-data continua" || falha "dados guardados" "o volume sumiu"
[[ ! -e "$E" && ! -d "$PROG" && -f "$HOME/.ergon/secrets/ergon.env" && -n "$(ls "$HOME/.ergon/backups" 2>/dev/null)" ]] && ok "comando e pasta do programa" "removidos; segredos e backups guardados" || falha "comando e pasta do programa" "$(ls -d "$E" "$PROG" "$HOME/.ergon"/* 2>&1 | tr '\n' ' ')"

# ---------------------------------------------------------------- instalar de novo: a conta volta
cp -r "$W/pacote" "$W/zip2"; (cd "$W/zip2" && ./ergon.sh instalar > "$W/reinstalar.log" 2>&1) && ok "instalar de novo" "$(tail -1 "$W/reinstalar.log")" || falha "instalar de novo" "$(tail -3 "$W/reinstalar.log" | tr '\n' ' ')"
rm -rf "$W/zip2"
no_ar || falha "no ar de novo" "sem resposta"
L=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $B" -d "{\"username\":\"homologacao\",\"password\":\"$PW\"}" "$B/api/auth/login")
[[ "$L" == 200 ]] && ok "dados de volta" "a mesma conta entra com a mesma senha" || falha "dados de volta" "login $L"

# ---------------------------------------------------------------- remover --tudo: nada fica
ERGON_CONFIRMAR=errado "$E" remover --tudo > "$W/nao.log" 2>&1; docker volume ls -q | grep -q '^ergon_ergon-data$' && ok "remover --tudo sem confirmar" "nada apagado" || falha "remover --tudo sem confirmar" "apagou"
ERGON_CONFIRMAR=APAGAR "$E" remover --tudo > "$W/tudo.log" 2>&1 && ok "ergon remover --tudo" "$(tail -1 "$W/tudo.log")" || falha "ergon remover --tudo" "$(tail -3 "$W/tudo.log" | tr '\n' ' ')"
[[ -z "$(docker volume ls -q | grep -E '^ergon_')" ]] && ok "volumes" "nenhum do Ergon" || falha "volumes" "$(docker volume ls -q | grep -E '^ergon_' | tr '\n' ' ')"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=ergon)" && -z "$(docker images -q "ghcr.io/$DONO/ergon-community")" ]] && ok "contêineres e imagens" "nenhum" || falha "contêineres e imagens" "ficaram"
[[ ! -e "$HOME/.ergon" && ! -e "$E" && ! -d "$PROG" ]] && ok "vestígios" "sem ~/.ergon, sem comando, sem pasta do programa" || falha "vestígios" "$(ls -d "$HOME/.ergon" "$E" "$PROG" 2>&1 | tr '\n' ' ')"

echo "resultado: $([[ $R == 0 ]] && echo 'tudo ok' || echo 'com falhas')"
exit $R

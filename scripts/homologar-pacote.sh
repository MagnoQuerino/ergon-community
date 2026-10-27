#!/usr/bin/env bash
# Homologação do pacote Docker publicado, numa máquina limpa e SEM login no registro de imagens: baixa o latest.json e o
# pacote da página de versões, confere o SHA-256, instala com o lançador como uma pessoa faria e testa conta,
# distribuição, loja oficial, modelos da comunidade (internet de verdade), WhatsApp experimental, backup e "atualizar".
#   REPO=dono/ergon-community bash scripts/homologar-pacote.sh
set -uo pipefail
REPO="${REPO:?REPO=dono/ergon-community}"
B=http://localhost:8787
R=0
ok() { echo "ok    $1 — $2"; }
falha() { echo "FALHA $1 — $2"; R=1; }

W="$(mktemp -d)"; cd "$W"
M="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json")" || { falha "latest.json" "não baixou"; exit 1; }
V="$(jq -r .version <<<"$M")"; URL="$(jq -r .bundle <<<"$M")"; SHA="$(jq -r .sha256 <<<"$M")"
ok "latest.json" "versão $V"
if curl -fsSL -o ergon.zip "$URL" && echo "$SHA  ergon.zip" | sha256sum -c - >/dev/null 2>&1; then ok "pacote baixado e conferido" "SHA-256 igual ao do latest.json"; else falha "pacote" "download ou SHA-256"; exit 1; fi
mkdir ergon && cd ergon && unzip -q ../ergon.zip
ok "conteúdo do pacote" "$(ls | tr '\n' ' ')"
DONO="$(echo "${REPO%%/*}" | tr 'A-Z' 'a-z')"
for img in ergon-community ergon-community-hermes; do
  if docker manifest inspect "ghcr.io/$DONO/$img:$V" >/dev/null 2>&1; then ok "imagem pública" "ghcr.io/$DONO/$img:$V baixa sem login"
  else falha "imagem pública" "ghcr.io/$DONO/$img:$V não baixa sem login: em github.com/$REPO › Packages › $img › Package settings › Change visibility › Public"; fi
done
[[ $R == 0 ]] || exit 1

if ./ergon.sh instalar > "$W/instalar.log" 2>&1; then ok "ergon.sh instalar" "$(tail -1 "$W/instalar.log")"; else falha "ergon.sh instalar" "$(tail -5 "$W/instalar.log" | tr '\n' ' ')"; fi
for _ in $(seq 1 120); do curl -fsS "$B/api/health" >/dev/null 2>&1 && break; sleep 2; done
H="$(curl -fsS "$B/api/health")" && ok "no ar" "$H" || { falha "no ar" "sem resposta"; docker compose ps; docker compose logs --tail 50; exit 1; }
grep -q "\"version\":\"$V\"" <<<"$H" && ok "versão no ar" "$V" || falha "versão no ar" "$H"
ok "imagens" "$(docker compose images --format json 2>/dev/null | jq -r '.[] | "\(.Repository):\(.Tag)"' 2>/dev/null | sort -u | tr '\n' ' ')"

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
c "$B/api/packages/catalog/community" | jq -e '.[] | select(.id=="comunidade.exemplos.tema-mar-egeu") | .installed' >/dev/null && ok "modelo instalado" "marcado como instalado" || falha "modelo instalado" "não marcado"
WA=$(c -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$B/api/integrations/whatsapp/start")
[[ "$WA" == 409 ]] && ok "WhatsApp experimental" "sem o aceite dos riscos, não conecta" || falha "WhatsApp experimental" "$WA"
T=$(c -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"title":"Tarefa da homologação"}' "$B/api/tasks")
[[ "$T" == 201 ]] && ok "tarefa" "criada" || falha "tarefa" "$T"
echo "      contêineres: $(docker ps --format '{{.Names}} ({{.Status}})' | tr '\n' ' ')"

./ergon.sh status > "$W/status.log" 2>&1 && ok "ergon.sh status" "$(tail -1 "$W/status.log")" || falha "ergon.sh status" "$(tail -2 "$W/status.log" | tr '\n' ' ')"
./ergon.sh backup > "$W/backup.log" 2>&1 && ok "ergon.sh backup" "$(tail -1 "$W/backup.log")" || falha "ergon.sh backup" "$(tail -3 "$W/backup.log" | tr '\n' ' ')"
./ergon.sh atualizar > "$W/atualizar.log" 2>&1 && ok "ergon.sh atualizar" "$(tail -1 "$W/atualizar.log")" || falha "ergon.sh atualizar" "$(tail -3 "$W/atualizar.log" | tr '\n' ' ')"
echo "resultado: $([[ $R == 0 ]] && echo 'tudo ok' || echo 'com falhas')"
exit $R

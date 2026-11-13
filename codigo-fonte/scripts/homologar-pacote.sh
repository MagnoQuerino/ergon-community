#!/usr/bin/env bash
# Homologação do pacote com contêineres (Podman; o de uma versão antiga, Docker) numa máquina limpa e SEM login no
# registro de imagens, como uma pessoa faria. Parte de uma versão ANTERIOR publicada (PACOTE_ANTIGO): instala, cria a
# conta, entra e espera o motor de IA da pessoa ligar na imagem dela. Depois ATUALIZA de verdade para a versão nova (o
# pacote publicado mais recente, ou PACOTE_DIR, montado do repositório) por um manifesto servido nesta máquina
# (scripts/distribuicao/servidor-teste.mjs) e confere que o motor mudou: a imagem exata da versão nova, o plugin com
# as Conexões dentro do cofre, a marca da configuração do cofre (2 ou mais) com ergon_conexoes na API, os mesmos
# volumes e a mesma conta. Em seguida apaga a pasta do zip, usa o comando "ergon" de outra pasta, testa loja, modelos
# da comunidade, WhatsApp experimental e backup; "ergon uninstall" (os dados ficam; as imagens dos dois repositórios do
# Ergon, o do serviço e o -hermes do motor de IA, saem), instala de novo (a conta volta) e "ergon uninstall --purge"
# (nada fica). Com o lançador da versão de partida, os nomes de antes (instalar, atualizar), que ele conhece; com o da
# versão nova, os nomes novos se ele os conhece (desde a 1.1.0-rc.26; os de antes continuam valendo, e
# scripts/teste-lancador.sh confere os dois), e os de antes se for um pacote publicado anterior a eles.
#   REPO=dono/ergon-community bash scripts/homologar-pacote.sh
#   REPO=dono/ergon-community PACOTE_DIR=pacote PACOTE_ANTIGO=1.1.0-rc.22 bash scripts/homologar-pacote.sh
# PACOTE_ANTIGO: a pasta de um pacote, ou uma versão publicada em REPO (1.1.0-rc.22 ou v1.1.0-rc.22); "anterior" (o
# padrão) é a publicada logo antes da nova; "nenhum" instala direto a nova, sem a atualização.
# DISTRIBUICAO: a esperada em /api/distribution (padrão: community). GH_TOKEN, se houver, só para listar as versões.
set -uo pipefail
REPO="${REPO:?REPO=dono/ergon-community}"
B=http://localhost:8787
E="$HOME/.local/bin/ergon"; PROG="$HOME/.local/share/ergon"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTA_TESTE="${PORTA_TESTE:-18999}"
export ERGON_NO_BROWSER=1 ERGON_SEM_NAVEGADOR=1   # o novo e o de antes (o lançador da versão de partida)
R=0
ok() { echo "ok    $1 — $2"; }
falha() { echo "FALHA $1 — $2"; R=1; }
no_ar() { for _ in $(seq 1 150); do curl -fsS "$B/api/health" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
# a versão $1 no ar (logo depois de atualizar, a anterior ainda pode responder)
no_ar_na() { local h; for _ in $(seq 1 150); do h="$(curl -fsS "$B/api/health" 2>/dev/null)" && grep -q "\"version\":\"$1\"" <<<"$h" && return 0; sleep 2; done; return 1; }
mais_nova() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; }
# as imagens de um pacote (a do serviço e a do motor de IA) e os repositórios delas
refs() { sed -nE 's/^[[:space:]]*(image|ERGON_MOTOR_IMAGE):[[:space:]]*"?([^"[:space:]#]+)"?.*$/\2/p' "$1" | sort -u; }
repo_de() { local r="${1%%@*}"; [[ "${r##*/}" == *:* ]] && r="${r%:*}"; printf '%s\n' "$r"; }
motor_do() { sed -nE 's/^[[:space:]]*ERGON_MOTOR_IMAGE:[[:space:]]*"?([^"[:space:]#]+)"?.*$/\1/p' "$1" | head -1; }
# as ferramentas de teste: em scripts/distribuicao (repositório público: ao lado; de desenvolvimento: na raiz)
achar() { local s; for s in "$AQUI/distribuicao/$1" "$AQUI/../../../scripts/distribuicao/$1"; do [[ -f "$s" ]] && { echo "$(cd "$(dirname "$s")" && pwd)/$1"; return; }; done; }
SERVIDOR="${SERVIDOR_TESTE:-$(achar servidor-teste.mjs)}"; DIAG="$(achar diagnostico-motor.sh)"

[[ -n "${PACOTE_DIR:-}" ]] && PACOTE_DIR="$(cd "$PACOTE_DIR" && pwd)"
[[ -n "${PACOTE_ANTIGO:-}" && -d "${PACOTE_ANTIGO:-}" ]] && PACOTE_ANTIGO="$(cd "$PACOTE_ANTIGO" && pwd)"
W="$(mktemp -d)"; cd "$W"
SRV=''; trap '[[ -n "$SRV" ]] && kill "$SRV" 2>/dev/null' EXIT
if [[ -n "${PACOTE_DIR:-}" ]]; then
  cp -r "$PACOTE_DIR" "$W/pacote"; V="$(cat "$W/pacote/VERSAO")"; ok "pacote do repositório" "versão $V"
else
  # VERSAO_ALVO (ex.: v1.1.0-rc.24): a versão daquele lançamento, inclusive pré-versão; vazio = a estável mais recente
  if [[ -n "${VERSAO_ALVO:-}" ]]; then M="$(curl -fsSL "https://github.com/$REPO/releases/download/${VERSAO_ALVO}/latest.json")" || { falha "latest.json" "não baixou ($VERSAO_ALVO)"; exit 1; }
  else M="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json")" || { falha "latest.json" "não baixou"; exit 1; }; fi
  V="$(jq -r .version <<<"$M")"; URL="$(jq -r .bundle <<<"$M")"; SHA="$(jq -r .sha256 <<<"$M")"
  ok "latest.json" "versão $V"
  if curl -fsSL -o ergon.zip "$URL" && echo "$SHA  ergon.zip" | sha256sum -c - >/dev/null 2>&1; then ok "pacote baixado e conferido" "SHA-256 igual ao do latest.json"; else falha "pacote" "download ou SHA-256"; exit 1; fi
  mkdir pacote && (cd pacote && unzip -q ../ergon.zip)
fi
ok "conteúdo do pacote" "$(ls "$W/pacote" | tr '\n' ' ')"

# ---------------------------------------------------------------- a versão de partida (a atualização de verdade)
baixar_pacote() {   # $1 versão, $2 pasta: o zip da página de versões, conferido pelo latest.json da própria versão
  local m u s
  m="$(curl -fsSL "https://github.com/$REPO/releases/download/v$1/latest.json")" || return 1
  u="$(jq -r .bundle <<<"$m")"; s="$(jq -r .sha256 <<<"$m")"
  curl -fsSL -o "$2.zip" "$u" && echo "$s  $2.zip" | sha256sum -c - >/dev/null 2>&1 || return 1
  mkdir -p "$2" && (cd "$2" && unzip -q "$2.zip")
}
ANTIGO="${PACOTE_ANTIGO:-anterior}"; VA=''
if [[ "$ANTIGO" == nenhum ]]; then ok "versão de partida" "nenhuma: instala direto a $V"
else
  if [[ -d "$ANTIGO" ]]; then cp -r "$ANTIGO" "$W/antigo"
  else
    if [[ "$ANTIGO" == anterior ]]; then
      auth=(); [[ -n "${GH_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GH_TOKEN")
      tags="$(curl -fsSL ${auth[@]+"${auth[@]}"} "https://api.github.com/repos/$REPO/releases?per_page=30" | jq -r '.[] | select((.draft | not) and any(.assets[]; .name | test("^ergon-local-.*[.]zip$"))) | .tag_name')"
      ANTIGO="$(for t in $tags; do mais_nova "$V" "${t#v}" && echo "${t#v}"; done | sort -V | tail -1)"
      [[ -n "$ANTIGO" ]] || { falha "versão de partida" "nenhuma versão publicada em $REPO antes da $V"; exit 1; }
    fi
    baixar_pacote "${ANTIGO#v}" "$W/antigo" || { falha "versão de partida" "o pacote da ${ANTIGO#v} não baixou ou não confere (SHA-256)"; exit 1; }
  fi
  VA="$(cat "$W/antigo/VERSAO")"
  if mais_nova "$V" "$VA"; then ok "versão de partida" "$VA (atualiza para a $V)"; else falha "versão de partida" "$VA não é anterior à $V"; exit 1; fi
fi

# as imagens do registro público baixam sem login (as de um registro desta máquina, da CI deste commit, não)
for P in antigo pacote; do
  [[ -f "$W/$P/docker-compose.yml" ]] || continue
  for ref in $(refs "$W/$P/docker-compose.yml"); do
    if [[ "$ref" != ghcr.io/* ]]; then ok "imagem local" "$ref (construída nesta máquina)"; continue; fi
    if skopeo inspect --raw "docker://$ref" >/dev/null 2>&1; then ok "imagem pública" "$ref baixa sem login"
    else falha "imagem pública" "$ref não baixa sem login"; fi
  done
done
[[ $R == 0 ]] || exit 1

# ---------------------------------------------------------------- instalar a partir da pasta do zip
PARTIDA=pacote; V0="$V"; [[ -n "$VA" ]] && { PARTIDA=antigo; V0="$VA"; }
cp -r "$W/$PARTIDA" "$W/zip"; cd "$W/zip"
# "instalar": o nome que o lançador da versão de partida conhece
if ./ergon.sh instalar > "$W/instalar.log" 2>&1; then ok "ergon.sh instalar ($V0)" "$(grep -v '^\s*$' "$W/instalar.log" | tail -1)"; else falha "ergon.sh instalar ($V0)" "$(tail -5 "$W/instalar.log" | tr '\n' ' ')"; fi
[[ -x "$E" && -f "$PROG/ergon.sh" && -f "$PROG/docker-compose.yml" ]] && ok "instalado numa pasta fixa" "$PROG, comando $E" || falha "instalado numa pasta fixa" "$(ls -la "$PROG" "$E" 2>&1 | head -3 | tr '\n' ' ')"
# o motor de contêineres que o lançador escolheu (gravado no .env; o lançador de uma versão antiga usa o Docker)
MC="$(sed -n 's/^ERGON_MOTOR=//p' "$PROG/.env" 2>/dev/null | tail -1)"; MC="${MC:-docker}"
ok "motor de contêineres" "$MC"
cd /; rm -rf "$W/zip"; cd "$(mktemp -d)"
ok "pasta do zip apagada" "o resto roda pelo comando ergon, de outra pasta ($(pwd))"
no_ar && H="$(curl -fsS "$B/api/health")" && ok "no ar" "$H" || { falha "no ar" "sem resposta"; "$E" logs; exit 1; }
grep -q "\"version\":\"$V0\"" <<<"$H" && ok "versão no ar" "$V0" || falha "versão no ar" "$H"
grep -q "\"raiz\":\"$PROG\"" "$HOME/.ergon/instalacao.json" && ok "registro da instalação" "aponta para a pasta fixa" || falha "registro da instalação" "$(cat "$HOME/.ergon/instalacao.json" 2>&1)"

J="$W/cookies"
PW="Hom-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
S=$(curl -sS -c "$J" -o "$W/setup.json" -w '%{http_code}' -H 'content-type: application/json' -H "origin: $B" -d "{\"username\":\"homologacao\",\"password\":\"$PW\",\"displayName\":\"Homologação\"}" "$B/api/auth/setup")
[[ "$S" == 200 ]] && ok "conta criada" "primeiro acesso ($V0)" || falha "conta" "setup $S"
CSRF=$(curl -sS -b "$J" "$B/api/me" | jq -r .csrf)
c() { curl -sS -b "$J" -H "origin: $B" -H "x-csrf-token: $CSRF" "$@"; }
# entrar (o Ergon reiniciado fica trancado até a pessoa entrar; entrar abre a parte dela e liga o motor dela)
entrar() {
  local s; s=$(curl -sS -c "$J" -b "$J" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $B" -d "{\"username\":\"homologacao\",\"password\":\"$PW\"}" "$B/api/auth/login")
  CSRF=$(curl -sS -b "$J" "$B/api/me" | jq -r .csrf); [[ "$s" == 200 ]]
}

# ---------------------------------------------------------------- atualizar de verdade, com o motor da pessoa ligado
motor_id() { "$MC" ps -aq --filter label=ergon.motor | head -1; }
img_de() { if [[ "$MC" == podman ]]; then "$MC" inspect --format '{{.ImageName}}' "$1" 2>/dev/null; else "$MC" inspect --format '{{.Config.Image}}' "$1" 2>/dev/null; fi; }
# dentro do cofre do motor, como o usuário dele (o cofre é um ponto FUSE desse usuário; como root, não abre)
no_cofre() { local m="$1"; shift; "$MC" exec --user 10000 "$m" "$@" 2>/dev/null; }
# o motor da pessoa ligado na imagem $1, com o cofre aberto (a cópia do plugin no lugar), em até $2 s; a tela pede o
# estado da IA (é isso que faz o Ergon pedir o motor ao gerente)
esperar_motor() {
  local ref="$1" fim=$((SECONDS + $2)) m
  while (( SECONDS < fim )); do
    c "$B/api/ai/status" >/dev/null 2>&1
    m="$(motor_id)"
    if [[ -n "$m" && "$("$MC" inspect --format '{{.State.Running}}' "$m" 2>/dev/null)" == true && "$(img_de "$m")" == "$ref" ]] \
      && no_cofre "$m" test -f /opt/data/plugins/ergon_bridge/__init__.py; then return 0; fi
    sleep 5
  done
  return 1
}
# a marca da configuração do cofre (.ergon-migracoes = {"versao": N}; sem ela, a antiga .ergon-config, texto "1" = 1)
# e as ferramentas da API, só os nomes
read -r -d '' PY_MARCA <<'PY'
import json, os, sys
sys.path.insert(0, "/opt/hermes")
import hermes_yaml as yaml  # o leitor de YAML do próprio Hermes (a imagem não traz o PyYAML)
p = "/opt/data/.ergon-migracoes" if os.path.exists("/opt/data/.ergon-migracoes") else "/opt/data/.ergon-config"
t = open(p, encoding="utf-8").read().strip()
try:
    v = json.loads(t)
    v = v.get("versao") if isinstance(v, dict) else min(int(v), 1)  # texto puro (marca antiga): no máximo 1
except Exception:
    v = 0
c = yaml.safe_load(open("/opt/data/config.yaml", encoding="utf-8")) or {}
print(int(v), ",".join(map(str, (c.get("platform_toolsets") or {}).get("api_server") or [])) or "-")
PY
URL_TESTE=''
if [[ -n "$VA" ]]; then
  entrar && ok "entrou na $VA" "parte da pessoa aberta" || falha "entrar na $VA" "login"
  IMG_A="$(motor_do "$PROG/docker-compose.yml")"
  if esperar_motor "$IMG_A" 600; then ok "motor de IA ligado na $VA" "$IMG_A"
  else falha "motor de IA na $VA" "não ligou na imagem $IMG_A: $("$MC" ps -a --filter label=ergon.motor --format '{{.Names}} {{.State}}' | tr '\n' ' ')"; fi
  ID_A="$("$MC" inspect --format '{{.Image}}' "$(motor_id)" 2>/dev/null)"
  VOL_A="$("$MC" volume ls -q | sort | tr '\n' ' ')"
  # o pacote novo, servido nesta máquina com o manifesto que o "ergon atualizar" lê (o lançador da versão de partida)
  mkdir -p "$W/servir"; (cd "$W/pacote" && zip -qr "$W/servir/ergon-local-$V.zip" .)
  SHA_V="$(sha256sum "$W/servir/ergon-local-$V.zip" | cut -d' ' -f1)"
  printf '{"version":"%s","bundle":"http://127.0.0.1:%s/ergon-local-%s.zip","sha256":"%s"}\n' "$V" "$PORTA_TESTE" "$V" "$SHA_V" > "$W/servir/latest.json"
  [[ -n "$SERVIDOR" ]] || { falha "manifesto local" "servidor-teste.mjs não encontrado"; exit 1; }
  node "$SERVIDOR" "$W/servir" --porta "$PORTA_TESTE" > "$W/servidor.log" 2>&1 & SRV=$!
  sleep 2
  URL_TESTE="http://127.0.0.1:$PORTA_TESTE/latest.json"
  if ERGON_UPDATE_URL="$URL_TESTE" ERGON_CONFIRMAR=sim "$E" atualizar > "$W/atualizar-de-verdade.log" 2>&1; then ok "ergon atualizar $VA → $V" "$(tail -1 "$W/atualizar-de-verdade.log")"
  else falha "ergon atualizar $VA → $V" "$(tail -5 "$W/atualizar-de-verdade.log" | tr '\n' ' ')"; fi
  no_ar_na "$V" && ok "versão no ar depois de atualizar" "$V" || falha "versão no ar depois de atualizar" "$(curl -fsS "$B/api/health" 2>&1)"
  entrar && ok "a mesma conta entra na $V" "a conta de antes continua" || falha "conta depois de atualizar" "login"
  IMG_V="$(motor_do "$PROG/docker-compose.yml")"
  [[ "$IMG_V" != "$IMG_A" ]] && ok "o pacote novo troca o motor" "$IMG_A → $IMG_V" || falha "o pacote novo troca o motor" "a mesma imagem nos dois ($IMG_V)"
  if esperar_motor "$IMG_V" 900; then ok "motor da pessoa na imagem da $V" "$IMG_V (renovado, não só religado)"
  else
    falha "motor da pessoa na imagem da $V" "continua em $(img_de "$(motor_id)") com a configurada $IMG_V"
    [[ -n "$DIAG" ]] && bash "$DIAG" estado "$MC" 2>&1 | sed 's/^/      /'
  fi
  MOT="$(motor_id)"
  n="$(no_cofre "$MOT" grep -c conexoes_executar /opt/data/plugins/ergon_bridge/__init__.py)"
  [[ "${n:-0}" -ge 1 ]] && ok "Conexões no plugin do cofre" "conexoes_executar ${n}x em /opt/data/plugins" || falha "Conexões no plugin do cofre" "conexoes_executar ${n:-0}x em /opt/data/plugins"
  # a cópia do plugin vem antes das migrações (cada uma roda comandos do motor, alguns segundos): espera a configuração
  # terminar, até 3 min, antes de conferir a marca
  for _ in $(seq 1 60); do
    read -r MARCA API <<<"$(no_cofre "$MOT" /opt/hermes/.venv/bin/python -c "$PY_MARCA")"
    [[ "${MARCA:-0}" =~ ^[0-9]+$ && "$MARCA" -ge 2 ]] && break; sleep 3
  done
  [[ "${MARCA:-0}" =~ ^[0-9]+$ && "$MARCA" -ge 2 ]] && ok "configuração do cofre migrada" "marca $MARCA" || { falha "configuração do cofre migrada" "marca ${MARCA:-ausente} (esperado 2 ou mais)"
    no_cofre "$MOT" sh -c 'ls -la /opt/data/.ergon-config /opt/data/.ergon-migracoes 2>&1; cat /opt/data/.ergon-migracoes 2>/dev/null; echo' 2>&1 | sed 's/^/      /'
    "$MC" logs "$MOT" 2>&1 | grep -iE "migra|configura|marca|travas|enforce|erro" | tail -20 | sed 's/^/      /'; }
  [[ ",${API:-}," == *,ergon_conexoes,* ]] && ok "Conexões ligadas na API do motor" "${API}" || falha "Conexões ligadas na API do motor" "ferramentas: ${API:-nenhuma}"
  VOL_V="$("$MC" volume ls -q | sort | tr '\n' ' ')"
  [[ "$VOL_V" == "$VOL_A" ]] && ok "volumes com os mesmos nomes" "$VOL_V" || falha "volumes com os mesmos nomes" "antes: $VOL_A; depois: $VOL_V"
  if [[ -n "$ID_A" ]] && "$MC" image inspect "$ID_A" >/dev/null 2>&1; then echo "info  a imagem anterior do motor (${ID_A:0:19}) ainda está no disco: sai quando a troca for confirmada e a limpeza rodar"
  else ok "imagem anterior do motor" "já saiu do disco"; fi
fi

# ---------------------------------------------------------------- a versão nova em uso
D=$(c "$B/api/distribution" | jq -r .distribution)
[[ "$D" == "${DISTRIBUICAO:-community}" ]] && ok "distribuição" "$D" || falha "distribuição" "$D (esperada ${DISTRIBUICAO:-community})"
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
# os nomes dos comandos no lançador instalado: os novos (em inglês) desde a 1.1.0-rc.26; num pacote anterior, os de antes
# (o lançador antigo responde a um comando que não conhece com a ajuda, que não começa por "Ergon <número>")
VER="$("$E" version 2>/dev/null | head -1)"
if [[ "$VER" =~ ^Ergon\ [0-9] ]]; then
  [[ "$VER" == "Ergon $V" ]] && ok "ergon version" "$VER" || falha "ergon version" "$VER (esperado: Ergon $V)"
  N_UPDATE=update; N_UNINSTALL=uninstall; N_PURGE=--purge; N_INSTALL=install; CONFIRMA=ERGON_CONFIRM; PALAVRA=DELETE
else
  ok "ergon version" "pacote anterior aos nomes novos: seguem os de antes"
  N_UPDATE=atualizar; N_UNINSTALL=remover; N_PURGE=--tudo; N_INSTALL=instalar; CONFIRMA=ERGON_CONFIRMAR; PALAVRA=APAGAR
fi
"$E" backup > "$W/backup.log" 2>&1 && ok "ergon backup" "$(tail -1 "$W/backup.log")" || falha "ergon backup" "$(tail -3 "$W/backup.log" | tr '\n' ' ')"
# sem versão mais nova publicada: nada muda (com a atualização de verdade, pelo mesmo manifesto local)
ERGON_UPDATE_URL="$URL_TESTE" "$E" "$N_UPDATE" > "$W/atualizar.log" 2>&1 && ok "ergon $N_UPDATE" "$(tail -1 "$W/atualizar.log")" || falha "ergon $N_UPDATE" "$(tail -3 "$W/atualizar.log" | tr '\n' ' ')"

# ---------------------------------------------------------------- remover: o Ergon sai, os dados ficam
REPOS="$(refs "$PROG/docker-compose.yml" | while read -r r; do repo_de "$r"; done | sort -u | tr '\n' ' ')"
# a lista vai inteira para uma variável antes da busca: com "pipefail", um "| grep -q" que acha logo na primeira linha
# fecha o cano, o programa da esquerda sai com erro e a conferência reprova o que está certo
sobra() { local r s='' i; i="$("$MC" images --format '{{.Repository}}' 2>/dev/null || true)"; for r in $REPOS; do grep -qxF "$r" <<<"$i" && s="$s $r"; done; printf '%s' "$s"; }
tem_volume() { local v; v="$("$MC" volume ls -q 2>/dev/null || true)"; grep -q "$1" <<<"$v"; }
"$E" "$N_UNINSTALL" > "$W/remover.log" 2>&1 && ok "ergon $N_UNINSTALL" "$(tail -1 "$W/remover.log")" || falha "ergon $N_UNINSTALL" "$(tail -3 "$W/remover.log" | tr '\n' ' ')"
[[ -z "$("$MC" ps -aq --filter label=com.docker.compose.project=ergon)" && -z "$("$MC" ps -aq --filter label=ergon.motor)" ]] && ok "contêineres" "nenhum do Ergon" || falha "contêineres" "$("$MC" ps -a --format '{{.Names}}' | tr '\n' ' ')"
S="$(sobra)"; [[ -z "$S" ]] && ok "imagens" "nenhuma dos repositórios do Ergon (o do serviço e o do motor de IA: $REPOS)" || falha "imagens" "ficaram de$S"
tem_volume '^ergon_ergon-data$' && ok "dados guardados" "volume ergon_ergon-data continua" || falha "dados guardados" "o volume sumiu"
if [[ -n "$VA" ]]; then tem_volume '^ergon_motor-' && ok "cofre do motor guardado" "o volume do motor da pessoa continua" || falha "cofre do motor guardado" "o volume sumiu"; fi
[[ ! -e "$E" && ! -d "$PROG" && -f "$HOME/.ergon/secrets/ergon.env" && -n "$(ls "$HOME/.ergon/backups" 2>/dev/null)" ]] && ok "comando e pasta do programa" "removidos; segredos e backups guardados" || falha "comando e pasta do programa" "$(ls -d "$E" "$PROG" "$HOME/.ergon"/* 2>&1 | tr '\n' ' ')"

# ---------------------------------------------------------------- instalar de novo: a conta volta
cp -r "$W/pacote" "$W/zip2"; (cd "$W/zip2" && ./ergon.sh "$N_INSTALL" > "$W/reinstalar.log" 2>&1) && ok "instalar de novo" "$(tail -1 "$W/reinstalar.log")" || falha "instalar de novo" "$(tail -3 "$W/reinstalar.log" | tr '\n' ' ')"
rm -rf "$W/zip2"
no_ar || falha "no ar de novo" "sem resposta"
L=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $B" -d "{\"username\":\"homologacao\",\"password\":\"$PW\"}" "$B/api/auth/login")
[[ "$L" == 200 ]] && ok "dados de volta" "a mesma conta entra com a mesma senha" || falha "dados de volta" "login $L"

# ---------------------------------------------------------------- uninstall --purge: nada fica
env "$CONFIRMA=errado" "$E" "$N_UNINSTALL" "$N_PURGE" > "$W/nao.log" 2>&1; tem_volume '^ergon_ergon-data$' && ok "$N_UNINSTALL $N_PURGE sem confirmar" "nada apagado" || falha "$N_UNINSTALL $N_PURGE sem confirmar" "apagou"
env "$CONFIRMA=$PALAVRA" "$E" "$N_UNINSTALL" "$N_PURGE" > "$W/tudo.log" 2>&1 && ok "ergon $N_UNINSTALL $N_PURGE" "$(tail -1 "$W/tudo.log")" || falha "ergon $N_UNINSTALL $N_PURGE" "$(tail -3 "$W/tudo.log" | tr '\n' ' ')"
[[ -z "$("$MC" volume ls -q | grep -E '^ergon_')" ]] && ok "volumes" "nenhum do Ergon" || falha "volumes" "$("$MC" volume ls -q | grep -E '^ergon_' | tr '\n' ' ')"
S="$(sobra)"; [[ -z "$("$MC" ps -aq --filter label=com.docker.compose.project=ergon)" && -z "$S" ]] && ok "contêineres e imagens" "nenhum" || falha "contêineres e imagens" "ficaram:$S"
[[ ! -e "$HOME/.ergon" && ! -e "$E" && ! -d "$PROG" ]] && ok "vestígios" "sem ~/.ergon, sem comando, sem pasta do programa" || falha "vestígios" "$(ls -d "$HOME/.ergon" "$E" "$PROG" 2>&1 | tr '\n' ' ')"

echo "resultado: $([[ $R == 0 ]] && echo 'tudo ok' || echo 'com falhas')"
exit $R

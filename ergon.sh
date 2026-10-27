#!/usr/bin/env bash
# Ergon — lançador local (macOS e Linux). Depois de instalar, use de qualquer terminal: ergon <comando>
#
#   instalar                     instala o Ergon numa pasta sua (~/.local/share/ergon), põe o comando "ergon" em
#                                ~/.local/bin, prepara os segredos, sobe o Ergon e abre o navegador; a pasta do zip
#                                pode ser apagada depois
#   remover                      tira o Ergon do computador e GUARDA os dados (conversas, tarefas, arquivos,
#                                conexões, segredos e backups): instalar de novo volta de onde parou
#   remover --tudo               tira o Ergon e APAGA os dados, os segredos e os backups (pede confirmação)
#   iniciar | parar | status     liga, desliga, mostra o estado
#   subir                        só liga os serviços (sem instalar nada no início da sessão): é o que o
#                                aplicativo Ergon Desktop usa
#   abrir                        abre http://localhost:8787
#   backup                       backup completo e conferido (banco cifrado, keyring, arquivos e conexões) numa
#                                pasta em ~/.ergon/backups
#   restaurar <pasta>            confere o backup, guarda o que está no lugar (nada é apagado) e restaura
#   desfazer-restauracao <pre-restore-…>   volta ao que era antes de uma restauração
#   atualizar                    backup + versão nova (cópia do código: git pull; pacote: baixa a versão publicada)
#   logs                         últimas linhas do Ergon e do motor
#   ajudante                     (roda sozinho ao entrar no computador) guarda a chave do "destrancar sozinho"
#                                no cofre do sistema quando você liga o botão em Configuração › Segurança, e
#                                destranca o Ergon depois de reiniciar
#   ajudante remover             tira o ajudante do início da sessão e apaga a chave guardada
#
# Nunca exibe segredos. Não altera nada fora da pasta do Ergon, de ~/.ergon, de ~/.local/share/ergon, do comando
# ~/.local/bin/ergon (e de uma linha marcada no ~/.profile, se ~/.local/bin não estiver no PATH) e do início
# automático do ajudante.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FONTE=0; [[ -f "$RAIZ/Dockerfile" && -d "$RAIZ/server" ]] && FONTE=1
BACKUPS="${ERGON_BACKUPS_DIR:-$HOME/.ergon/backups}"   # outra pasta: disco externo, por exemplo
MANIFESTO="https://github.com/MagnoQuerino/ergon-community/releases/latest/download/latest.json"
SO="$(uname -s)"

say() { printf '[ergon] %s\n' "$*"; }
fail() { printf '[ergon] %s\n' "$*" >&2; exit 1; }
dotenv() { [[ -f "$RAIZ/.env" ]] && sed -n "s/^$1=//p" "$RAIZ/.env" | tail -1 | tr -d '"'"'" || true; }

PORTA="$(dotenv ERGON_PORT)"; PORTA="${PORTA:-8787}"
URL="http://localhost:$PORTA"
# nome do projeto Compose (volumes: <projeto>_ergon-data e <projeto>_hermes-vault)
PROJETO="${COMPOSE_PROJECT_NAME:-$(dotenv COMPOSE_PROJECT_NAME)}"; PROJETO="${PROJETO:-ergon}"
SEGREDOS="$(dotenv ERGON_SECRETS_DIR)"; SEGREDOS="${SEGREDOS:-${ERGON_SECRETS_DIR:-$HOME/.ergon/secrets}}"

compose() { (cd "$RAIZ" && docker compose --profile hermes "$@"); }
need_docker() { docker info >/dev/null 2>&1 || fail 'O Docker não está rodando. Abra o Docker e tente de novo.'; }
health() { curl -fsS --max-time 5 "$URL/api/health" 2>/dev/null || true; }
# campo simples de um JSON de uma linha (texto ou true/false); sed -E funciona no macOS e no Linux
field() { sed -nE "s/.*\"$1\":(\"([^\"]*)\"|(true|false)).*/\2\3/p"; }
# texto seguro dentro de aspas JSON
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
wait_health() {
  local fim=$((SECONDS + ${1:-180})) h
  while (( SECONDS < fim )); do h="$(health)"; [[ -n "$h" ]] && { printf '%s' "$h"; return 0; }; sleep 2; done
  return 1
}
token() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
abrir() { if [[ "$SO" == Darwin ]]; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || say "Abra $URL"; fi; }

init_secrets() {
  mkdir -p "$SEGREDOS"; chmod 700 "$SEGREDOS"
  if [[ -f "$SEGREDOS/ergon.env" || -f "$SEGREDOS/hermes.env" ]]; then say "Segredos já existem em $SEGREDOS (não alterados)."
  else
    local api ponte; api="$(token)"; ponte="$(token)"
    (umask 077
     printf '# Ergon — segredos locais (não versionar, não sincronizar)\nERGON_HERMES_API_KEY=%s\nERGON_BRIDGE_TOKEN=%s\nERGON_AGENT_TOKEN=%s\n' "$api" "$ponte" "$(token)" > "$SEGREDOS/ergon.env"
     printf '# Motor de IA do Ergon — segredos locais\nAPI_SERVER_KEY=%s\nERGON_BRIDGE_TOKEN=%s\nHERMES_DASHBOARD_SESSION_TOKEN=%s\n' "$api" "$ponte" "$(token)" > "$SEGREDOS/hermes.env")
    say "Segredos gerados em $SEGREDOS (valores não exibidos)."
  fi
  # instalações anteriores: acrescenta só o token do ajudante (valor não exibido)
  if [[ -f "$SEGREDOS/ergon.env" ]] && ! grep -q '^ERGON_AGENT_TOKEN=' "$SEGREDOS/ergon.env"; then
    printf 'ERGON_AGENT_TOKEN=%s\n' "$(token)" >> "$SEGREDOS/ergon.env"; say 'ergon.env: token do ajudante acrescentado.'
  fi
  touch "$RAIZ/.env"
  grep -q '^ERGON_SECRETS_DIR=' "$RAIZ/.env" || echo "ERGON_SECRETS_DIR=$SEGREDOS" >> "$RAIZ/.env"
  grep -q '^ERGON_EXECUTOR=' "$RAIZ/.env" || echo 'ERGON_EXECUTOR=hermes' >> "$RAIZ/.env"
}

# Onde esta instalação está (lido pelo Ergon Desktop para achar o lançador e a porta). Só caminho e porta.
registrar() {
  local f="${ERGON_INSTALACAO:-$HOME/.ergon/instalacao.json}"   # ERGON_INSTALACAO: testes isolados
  mkdir -p "$(dirname "$f")"
  printf '{"raiz":"%s","porta":%s,"atualizado":"%s"}\n' "$(esc "$RAIZ")" "$PORTA" "$(date +%Y-%m-%dT%H:%M:%S)" > "$f" || true
}

# up [semfalha]: com "semfalha", não responder devolve 1 em vez de encerrar (quem chama decide o que fazer)
up() {
  if (( FONTE )); then compose up -d --build; else compose pull; compose up -d; fi
  local h; if ! h="$(wait_health 240)"; then [[ "${1:-}" == semfalha ]] && return 1; fail 'O Ergon não respondeu. Veja: ./ergon.sh logs'; fi
  if [[ "$(field sealed <<<"$h")" == true ]]; then say "Ergon no ar e TRANCADO: abra $URL e digite a senha."; else say "Ergon no ar em $URL"; fi
}
# a versão $1 é mais nova que a $2? (números: 0.10 > 0.9; sem a atual, sim)
mais_nova() { [[ -z "$2" ]] && return 0; [[ "$1" == "$2" ]] && return 1; [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; }

backup() {
  local h; h="$(health)"
  [[ -z "$h" ]] && { say 'Ergon parado: sem backup agora.'; return 1; }
  [[ "$(field sealed <<<"$h")" == true ]] && { say 'Ergon trancado: destranque para fazer o backup.'; return 1; }
  local nome id; nome="$(compose exec -T ergon node server/src/backup-cli.ts)" || fail 'O backup falhou.'
  id="$(compose ps -q ergon)"; mkdir -p "$BACKUPS"
  docker cp "$id:/data/backups/$nome" "$BACKUPS/$nome" >/dev/null && [[ -f "$BACKUPS/$nome/manifest.json" ]] \
    || fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $BACKUPS falhou."
  chmod -R go-rwx "$BACKUPS/$nome"
  say "Backup completo e conferido (banco, arquivos e conexões): $BACKUPS/$nome"
}

# Ferramenta de restauração (server/src/restore-cli.ts) num contêiner de uso único com o volume de dados: funciona
# com o Ergon parado. Imprime a linha JSON que ela devolve. Uso: restore_tool [opções do run --] <args>
restore_tool() {
  local extra=(); while [[ $# -gt 0 && "$1" != -- ]]; do extra+=("$1"); shift; done; [[ "${1:-}" == -- ]] && shift
  (cd "$RAIZ" && docker compose --profile hermes run --rm --no-deps -T ${extra[@]+"${extra[@]}"} ergon node server/src/restore-cli.ts "$@" 2>/dev/null) | grep '^{' | tail -1 || true
}
# cofre do motor: arquivos do usuário do motor (10000), com dono e permissões que o gocryptfs usa. O serviço do
# Ergon descarta todas as capacidades; este passo devolve só as de ler, copiar com dono e ajustar permissões.
MOTOR_ROOT=(--user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "${PROJETO}_hermes-vault:/vault")
num() { sed -nE "s/.*\"$1\":([0-9]+).*/\1/p"; }
confirmar() { [[ "${ERGON_CONFIRMAR:-}" == sim ]] && return 0; local r; read -r -p "$1 (s/N) " r; [[ "$r" == s ]]; }
carimbo() { date -u +%Y-%m-%dT%H-%M-%S-000Z; }

# Restaurar: confere o backup inteiro antes; para o Ergon; o que estava no lugar vai para
# /data/backups/pre-restore-<data> (nada é apagado); sobe de novo. Backup de outra instalação: o cofre do motor de
# IA desta máquina é de outra chave, então vai inteiro para o pre-restore e o motor começa um novo.
restaurar() {
  local origem="${1:-}"
  [[ -n "$origem" ]] || fail "Diga qual backup: ./ergon.sh restaurar <pasta do backup>   (os backups ficam em $BACKUPS)"
  [[ -e "$origem" ]] || { [[ -e "$BACKUPS/$origem" ]] && origem="$BACKUPS/$origem"; } || fail "Não achei o backup $origem."
  origem="$(cd "$(dirname "$origem")" && pwd)/$(basename "$origem")"
  [[ "$(basename "$origem")" == manifest.json ]] && origem="$(dirname "$origem")"
  if [[ -d "$origem" ]]; then [[ -f "$origem/manifest.json" ]] || fail 'Essa pasta não é um backup do Ergon (falta o manifest.json).'
  else [[ "$origem" == *.sqlite ]] || fail 'Indique a pasta do backup (ou um backup antigo .sqlite).'; fi
  need_docker
  local id; id="$(compose ps -aq ergon)"
  [[ -n "$id" ]] || fail 'O Ergon não está instalado aqui. Rode ./ergon.sh instalar e restaure antes de criar a conta.'
  local c; c="$(carimbo)"; local entrada="/data/backups/entrada-$c" alvo
  [[ "$(restore_tool -- preparar | field ok)" == true ]] || fail 'Não consegui preparar o volume do Ergon; nada foi alterado.'
  # o backup entra no volume como cópia (o original fica onde está)
  if [[ -d "$origem" ]]; then alvo="$entrada"; docker cp "$origem" "$id:$entrada" >/dev/null || fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.'
  else
    local tmp; tmp="$(mktemp -d)"; cp "$origem" "$tmp/"; [[ -f "$origem.keyring.json" ]] && cp "$origem.keyring.json" "$tmp/"
    docker cp "$tmp" "$id:$entrada" >/dev/null || { rm -rf "$tmp"; fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.'; }
    rm -rf "$tmp"; alvo="$entrada/$(basename "$origem")"
  fi
  local conf; conf="$(restore_tool -- conferir "$alvo")"
  [[ "$(field ok <<<"$conf")" == true ]] || fail "O backup não confere; nada foi alterado. $(field error <<<"$conf") $conf"
  if [[ "$(field legacy <<<"$conf")" == true ]]; then say 'Backup antigo: volta o banco (e o keyring); os arquivos e as conexões atuais ficam como estão.'
  else say "Backup de $(field createdAt <<<"$conf") (versão $(field version <<<"$conf")), conferido: $(num artifacts <<<"$conf") arquivo(s), $(num secrets <<<"$conf") credencial(is) de conexão."; fi
  local chave; chave="$(field keyring <<<"$conf")"
  [[ "$chave" == outra ]] && say 'É o backup de outra instalação: o motor de IA começa um cofre novo (o atual fica guardado).'
  [[ -n "$chave" && "$chave" != sem ]] && say 'Depois, o Ergon pode pedir a senha (ou a frase de recuperação) da época do backup.'
  say "O que está no lugar agora vai para /data/backups/pre-restore-$c (nada é apagado)."
  confirmar 'Restaurar agora?' || { say 'Nada foi alterado.'; return 0; }
  local motor; motor="$(compose ps -q hermes 2>/dev/null || true)"
  compose stop ergon
  local r; r="$(restore_tool -- restaurar "$alvo" "$c")"
  [[ "$(field ok <<<"$r")" == true ]] || { compose start ergon; fail "A restauração não foi feita; os dados atuais continuam no lugar. $(field error <<<"$r")"; }
  if [[ "$(field keyring <<<"$r")" == outra ]]; then
    [[ -n "$motor" ]] && compose stop hermes
    local m; m="$(restore_tool "${MOTOR_ROOT[@]}" -- motor /vault "/data/backups/pre-restore-$c/motor")"
    [[ "$(field ok <<<"$m")" == true ]] || say "Atenção: o cofre do motor não foi posto de lado ($(field error <<<"$m")); o motor pode não abrir com a chave restaurada."
  fi
  compose start ergon; [[ -n "$motor" ]] && compose start hermes
  local h; h="$(wait_health 240)" || fail "O Ergon não respondeu depois de restaurar. Para voltar: ./ergon.sh desfazer-restauracao pre-restore-$c"
  if [[ "$(field sealed <<<"$h")" == true ]]; then say "Restaurado. Abra $URL e digite a senha (ou a frase) da época do backup."; else say "Restaurado. No ar em $URL."; fi
  say "Para voltar ao que era antes: ./ergon.sh desfazer-restauracao pre-restore-$c"
}

desfazer_restauracao() {
  local pre="${1:-}"
  [[ "$pre" =~ ^pre-restore-[A-Za-z0-9_-]+$ ]] || fail 'Diga qual: ./ergon.sh desfazer-restauracao pre-restore-<data>  (o nome aparece ao restaurar)'
  need_docker
  confirmar "Voltar ao que era antes da restauração $pre?" || { say 'Nada foi alterado.'; return 0; }
  local motor; motor="$(compose ps -q hermes 2>/dev/null || true)"
  compose stop ergon
  local r; r="$(restore_tool -- desfazer "/data/backups/$pre")"
  [[ "$(field ok <<<"$r")" == true ]] || { compose start ergon; fail "Não deu para desfazer: $(field error <<<"$r")"; }
  local aside; aside="$(field aside <<<"$r")"
  if [[ "$(field motor <<<"$r")" == true ]]; then
    [[ -n "$motor" ]] && compose stop hermes
    local m; m="$(restore_tool "${MOTOR_ROOT[@]}" -- motor-volta /vault "/data/backups/$pre/motor" "$aside/motor")"
    [[ "$(field ok <<<"$m")" == true ]] || say "Atenção: o cofre do motor não voltou ($(field error <<<"$m"))."
  fi
  compose start ergon; [[ -n "$motor" ]] && compose start hermes
  say "Voltou ao que era antes da restauração. O restaurado ficou guardado em $aside."
}

# Atualizar: backup antes; só versão mais nova; a atual fica guardada; se a nova não responder, volta sozinho. O banco
# não volta sozinho (a nova pode ter migrado): se nem a anterior responder, diz qual backup restaurar.
atualizar() {
  local antes; antes="$(ls -1 "$BACKUPS" 2>/dev/null || true)"
  if ! backup; then confirmar 'Continuar sem backup?' || exit 1; fi
  local feito; feito="$(comm -13 <(printf '%s\n' "$antes" | sort) <(ls -1 "$BACKUPS" 2>/dev/null | sort) | head -1)"
  local voltar; [[ -n "$feito" ]] && voltar="restaure o backup de antes: ./ergon.sh restaurar \"$BACKUPS/$feito\"" || voltar='restaure o backup mais recente: ./ergon.sh restaurar <pasta>'
  if (( FONTE )); then
    local rev; rev="$(cd "$RAIZ" && git rev-parse --short HEAD 2>/dev/null || true)"
    (cd "$RAIZ" && git pull --ff-only) || fail 'git pull falhou (há mudanças locais, ou a branch não acompanha uma remota). Nada foi alterado.'
    up semfalha && return
    fail "A versão nova não respondeu. Para voltar: git checkout $rev e ./ergon.sh iniciar; se ainda assim não subir, $voltar"
  fi
  local m ver bundle sha atual tmp
  m="$(curl -fsSL --max-time 20 "${ERGON_UPDATE_URL:-$MANIFESTO}")" || fail 'Não consegui ler a versão publicada.'
  ver="$(field version <<<"$m")"; bundle="$(field bundle <<<"$m")"; sha="$(field sha256 <<<"$m")"
  atual="$(head -1 "$RAIZ/VERSAO" 2>/dev/null || true)"
  mais_nova "$ver" "$atual" || { say "Já está na versão $atual (publicada: $ver)."; return; }
  [[ -n "$bundle" && -n "$sha" ]] || fail 'Manifesto da versão sem pacote.'
  tmp="$(mktemp -d)"; curl -fsSL "$bundle" -o "$tmp/ergon.zip" || fail 'Não consegui baixar o pacote. Nada foi alterado.'
  local got; if command -v sha256sum >/dev/null; then got="$(sha256sum "$tmp/ergon.zip" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/ergon.zip" | cut -d' ' -f1)"; fi
  [[ "$got" == "$sha" ]] || fail 'Pacote baixado não confere (SHA-256). Nada foi alterado.'
  (cd "$tmp" && unzip -q ergon.zip -d x)
  # a versão atual fica guardada (arquivos do pacote; o .env e os dados não mudam)
  local guardada="$HOME/.ergon/versoes/${atual:-anterior}"
  rm -rf "$guardada"; mkdir -p "$guardada"
  (cd "$RAIZ" && tar --exclude=.env -cf - .) | (cd "$guardada" && tar -xf -)
  (cd "$tmp/x" && tar --exclude=.env -cf - .) | (cd "$RAIZ" && tar -xf -)
  say "Pacote $ver aplicado (a $atual ficou guardada em $guardada)."
  up semfalha && return
  say "A versão $ver não respondeu: voltando para a $atual."
  (cd "$guardada" && tar -cf - .) | (cd "$RAIZ" && tar -xf -)
  up semfalha && { say "Voltou para a $atual e está no ar. A $ver fica para depois (veja ./ergon.sh logs)."; return; }
  fail "Nem a versão $atual respondeu (a nova pode ter mudado o banco): $voltar"
}

# ---------------------------------------------------------------- ajudante (destrancar sozinho)
# O Ergon roda no Docker e não alcança o cofre do sistema. O ajudante roda na sua conta desde que você entra no
# computador: avisa o Ergon que está ali; quando você liga "Destrancar sozinho" na tela, busca a chave e a guarda
# nas Chaves do macOS (ou no chaveiro do Linux, via libsecret); se o Ergon reiniciar trancado, destranca.
# Desligar na tela invalida a chave, e o ajudante apaga a dela.
LOCAL="${ERGON_LOCAL_DIR:-$HOME/.ergon}"
INICIO_MAC="$HOME/Library/LaunchAgents/com.ergon.ajudante.plist"
INICIO_LINUX="$HOME/.config/autostart/ergon-ajudante.desktop"
log_ajudante() { mkdir -p "$LOCAL"; printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$*" >> "$LOCAL/ajudante.log"; }
agent_token() { sed -n 's/^ERGON_AGENT_TOKEN=//p' "$SEGREDOS/ergon.env" 2>/dev/null | head -1 | tr -d '\r'; }
# o guardado é "id:chave", ou várias separadas por ";" (uma por pessoa que ligou "abrir sozinho" nesta conta)
guardar_chave() {
  if [[ "$SO" == Darwin ]]; then security add-generic-password -U -a "$USER" -s ergon-destravar -w "$1" >/dev/null
  else printf '%s' "$1" | secret-tool store --label='Ergon — destrancar sozinho' service ergon account destravar; fi
}
ler_chave() {
  if [[ "$SO" == Darwin ]]; then security find-generic-password -a "$USER" -s ergon-destravar -w 2>/dev/null || true
  else secret-tool lookup service ergon account destravar 2>/dev/null || true; fi
}
apagar_chave() {
  if [[ "$SO" == Darwin ]]; then security delete-generic-password -a "$USER" -s ergon-destravar >/dev/null 2>&1 || true
  else secret-tool clear service ergon account destravar 2>/dev/null || true; fi
}
# uma chave a mais (substitui a de mesmo id) / uma a menos; o item some quando não sobra nenhuma
por_chave() { local id="${1%%:*}" e out=''; for e in $(ler_chave | tr ';' ' '); do [[ "${e%%:*}" == "$id" ]] || out="$out${out:+;}$e"; done; guardar_chave "$out${out:+;}$1"; }
tirar_chave() { local e out=''; for e in $(ler_chave | tr ';' ' '); do [[ "${e%%:*}" == "$1" ]] || out="$out${out:+;}$e"; done; if [[ -n "$out" ]]; then guardar_chave "$out"; else apagar_chave; fi; }
chave_de() { local e; for e in ${2//;/ }; do [[ "${e%%:*}" == "$1" ]] && { printf '%s' "${e#*:}"; return; }; done; }
# itens de uma lista JSON de textos ("invalid": ["a","b"]) do corpo da resposta
lista() { sed -n "s/.*\"$1\":\[\([^]]*\)\].*/\1/p" | tr ',' '\n' | tr -d '" '; }
# POST com o token do ajudante; imprime o corpo e, na última linha, o código HTTP
agent_post() { curl -sS --max-time "${3:-5}" -X POST "$URL$1" -H "X-Ergon-Agent-Token: $TOK" -H 'Content-Type: application/json' --data-binary "$2" -w '\n%{http_code}' 2>/dev/null || printf '\n000'; }

ajudante() {
  mkdir -p "$LOCAL"
  # um ajudante por sessão
  if [[ -f "$LOCAL/ajudante.pid" ]] && kill -0 "$(cat "$LOCAL/ajudante.pid")" 2>/dev/null; then return 0; fi
  echo $$ > "$LOCAL/ajudante.pid"
  [[ "$SO" == Darwin ]] || command -v secret-tool >/dev/null || { log_ajudante 'sem secret-tool (instale libsecret-tools)'; return 1; }
  TOK="$(agent_token)"; [[ -n "$TOK" ]] || { log_ajudante 'sem ERGON_AGENT_TOKEN em ergon.env (rode "ergon instalar")'; return 1; }
  local label; label="$(hostname) ($USER)"
  log_ajudante 'ajudante iniciado'
  while true; do
    local saved id key body out code ids e
    saved="$(ler_chave)"; ids=''
    for e in ${saved//;/ }; do ids="$ids${ids:+,}\"${e%%:*}\""; done
    id="${saved%%:*}"
    body="{\"label\":\"$(esc "$label")\",\"platform\":\"$( [[ "$SO" == Darwin ]] && echo macos || echo linux )\"${saved:+,\"keyId\":\"$id\",\"keyIds\":[$ids]}}"
    out="$(agent_post /api/agent/hello "$body")"; code="${out##*$'\n'}"; out="${out%$'\n'*}"
    if [[ "$code" == 200 ]]; then
      for e in $(lista invalid <<<"$out"); do tirar_chave "$e"; log_ajudante 'abrir sozinho desligado na tela: uma chave apagada'; done
      # várias pessoas: a parte de quem ligou "abrir sozinho" ainda está fechada → abre com a chave dela
      for e in $(lista closed <<<"$out"); do
        key="$(chave_de "$e" "$saved")"; [[ -n "$key" ]] || continue
        code="$(agent_post /api/agent/open "{\"key\":\"$key\"}" 30 | tail -1)"
        if [[ "$code" == 200 ]]; then log_ajudante 'parte de uma pessoa aberta'; elif [[ "$code" == 401 ]]; then tirar_chave "$e"; log_ajudante 'chave recusada (foi desligada): apagada'; fi
      done
      if [[ "$(field enroll <<<"$out")" == true ]]; then
        out="$(agent_post /api/agent/auto-unlock/claim '{}' 10)"; code="${out##*$'\n'}"; out="${out%$'\n'*}"
        if [[ "$code" == 200 ]]; then por_chave "$(field id <<<"$out"):$(field key <<<"$out")"; out=''; log_ajudante 'abrir sozinho ligado: chave guardada no cofre do sistema'; fi
      fi
    elif [[ "$code" == 423 && -n "$saved" ]]; then
      # o Ergon reiniciou e está trancado → destranca com uma das chaves guardadas
      for e in ${saved//;/ }; do
        key="${e#*:}"
        code="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$URL/api/unseal/auto" -H 'Content-Type: application/json' --data-binary @- <<<"{\"key\":\"$key\"}" 2>/dev/null || echo 000)"
        if [[ "$code" == 200 ]]; then log_ajudante 'Ergon destrancado'; break; elif [[ "$code" == 401 ]]; then tirar_chave "${e%%:*}"; log_ajudante 'chave recusada (foi desligada): apagada'; fi
      done
    fi
    saved=''; key=''
    sleep 5
  done
}
instalar_ajudante() {
  if [[ "$SO" == Darwin ]]; then
    mkdir -p "$(dirname "$INICIO_MAC")"
    cat > "$INICIO_MAC" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ergon.ajudante</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RAIZ/ergon.sh</string><string>ajudante</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
    launchctl unload "$INICIO_MAC" >/dev/null 2>&1 || true; launchctl load "$INICIO_MAC" >/dev/null 2>&1 || true
  else
    mkdir -p "$(dirname "$INICIO_LINUX")"
    printf '[Desktop Entry]\nType=Application\nName=Ergon — ajudante\nExec=/bin/bash "%s/ergon.sh" ajudante\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$RAIZ" > "$INICIO_LINUX"
    nohup /bin/bash "$RAIZ/ergon.sh" ajudante >/dev/null 2>&1 &
  fi
  say 'Ajudante do computador ativo (começa sozinho ao entrar no computador).'
}
remover_ajudante() {
  [[ "$SO" == Darwin ]] && launchctl unload "$INICIO_MAC" >/dev/null 2>&1 || true
  [[ -f "$LOCAL/ajudante.pid" ]] && kill "$(cat "$LOCAL/ajudante.pid")" 2>/dev/null || true
  apagar_chave; rm -f "$INICIO_MAC" "$INICIO_LINUX" "$LOCAL/ajudante.pid"
  say 'Ajudante removido e chave apagada deste computador. O destrancar sozinho fica desligado.'
}

# ---------------------------------------------------------------- instalação fixa e "ergon" em qualquer terminal
PROGRAMA="${ERGON_PROGRAM_DIR:-$HOME/.local/share/ergon}"
BIN="${ERGON_BIN_DIR:-$HOME/.local/bin}"
MARCA='# ergon: comando no PATH'
mesma() { [[ -d "$1" && -d "$2" && "$(cd "$1" && pwd -P)" == "$(cd "$2" && pwd -P)" ]]; }
perfis() { if [[ "$SO" == Darwin ]]; then echo "$HOME/.zprofile $HOME/.profile"; else echo "$HOME/.profile"; fi; }
# o comando "ergon": um atalho pequeno em ~/.local/bin que chama o lançador instalado
ligar_comando() {
  mkdir -p "$BIN"
  printf '#!/bin/sh\nexec /bin/bash "%s/ergon.sh" "$@"\n' "$1" > "$BIN/ergon"; chmod 755 "$BIN/ergon"
  case ":$PATH:" in
    *":$BIN:"*) say "Comando ergon disponível em qualquer terminal ($BIN/ergon)." ;;
    *) local p; for p in $(perfis); do grep -qF "$MARCA" "$p" 2>/dev/null || printf '\nexport PATH="%s:$PATH" %s\n' "$BIN" "$MARCA" >> "$p"; done
       say "Comando ergon instalado em $BIN/ergon. Abra um terminal novo para usar: ergon status" ;;
  esac
}
desligar_comando() {
  rm -f "$BIN/ergon"
  local p; for p in $(perfis); do [[ -f "$p" ]] && grep -qF "$MARCA" "$p" && { grep -vF "$MARCA" "$p" > "$p.ergon-tmp" && mv "$p.ergon-tmp" "$p"; }; done
  return 0
}
# Pacote de versão: copia o lançador e o compose para a pasta do programa (DESTINO). Cópia do código
# (desenvolvimento): fica onde está, e o "ergon" passa a apontar para ela.
instalar_programa() {
  if (( FONTE )); then DESTINO="$RAIZ"; ligar_comando "$RAIZ"; say "Cópia do código: o comando ergon usa esta pasta ($RAIZ). Não a apague."; return; fi
  DESTINO="$PROGRAMA"; mkdir -p "$PROGRAMA"
  if ! mesma "$RAIZ" "$PROGRAMA"; then
    local a; for a in ergon.sh ergon.ps1 ergon.cmd docker-compose.yml LEIA-ME.md VERSAO; do [[ -f "$RAIZ/$a" ]] && cp -f "$RAIZ/$a" "$PROGRAMA/$a"; done
    # o .env de uma instalação anterior (porta, opções) fica; o do zip só entra se não houver nenhum
    [[ -f "$RAIZ/.env" && ! -f "$PROGRAMA/.env" ]] && cp "$RAIZ/.env" "$PROGRAMA/.env"
    chmod 755 "$PROGRAMA/ergon.sh"; say "Ergon instalado em $PROGRAMA."
  fi
  ligar_comando "$PROGRAMA"
}

# Tira o Ergon do computador. Sem --tudo, os dados ficam (volumes do Docker, segredos e backups em ~/.ergon).
remover() {
  local tudo=0; [[ "${1:-}" == --tudo ]] && tudo=1
  if (( tudo )); then
    say 'Isto APAGA tudo o que o Ergon guardou neste computador: conversas, tarefas, agentes, conexões, arquivos, a memória do motor, os segredos e os backups. Não tem volta.'
    local r="${ERGON_CONFIRMAR:-}"; [[ -n "$r" ]] || read -r -p 'Para confirmar, digite APAGAR: ' r
    [[ "$r" == APAGAR ]] || fail 'Nada foi apagado.'
  fi
  if docker info >/dev/null 2>&1; then
    # motores por pessoa (criados pelo gerente): os contêineres saem; os cofres deles são dados
    local motores cofres='' m vols
    motores="$(docker ps -aq --filter label=ergon.motor 2>/dev/null || true)"
    for m in $motores; do cofres="$cofres $(docker inspect --format '{{ index .Config.Labels "ergon.motor.volume" }}' "$m" 2>/dev/null || true)"; done
    [[ -n "$motores" ]] && { docker rm -f $motores >/dev/null 2>&1 || true; }
    if (( tudo )); then
      compose down --remove-orphans --rmi all -v >/dev/null 2>&1 || true
      vols="$(docker volume ls -q 2>/dev/null | grep -E "^${PROJETO}_" || true) $cofres"; vols="$(echo $vols)"
      [[ -n "$vols" ]] && { docker volume rm -f $vols >/dev/null 2>&1 || true; }
      say 'Contêineres, imagens e volumes do Ergon apagados.'
    else
      compose down --remove-orphans --rmi all >/dev/null 2>&1 || true
      say "Contêineres e imagens do Ergon removidos. Os dados ficaram guardados no Docker (volumes ${PROJETO}_*)."
    fi
  else say 'O Docker não está rodando: contêineres, imagens e volumes ficam até você abrir o Docker e rodar "ergon remover" de novo.'; fi
  remover_ajudante || true
  rm -f "${ERGON_INSTALACAO:-$HOME/.ergon/instalacao.json}"
  if (( tudo )); then rm -rf "$SEGREDOS" "$BACKUPS" "$LOCAL" "$HOME/.ergon"; say 'Segredos, backups e registros do Ergon apagados.'
  else say "Segredos e backups guardados em $(dirname "$SEGREDOS")."; fi
  desligar_comando
  if (( ! FONTE )) && mesma "$RAIZ" "$PROGRAMA"; then rm -rf "$PROGRAMA"; fi
  if (( tudo )); then say 'Pronto: o Ergon saiu deste computador, com os dados.'
  else say 'Pronto: o Ergon saiu deste computador. Para voltar com os mesmos dados: baixe o pacote e rode "./ergon.sh instalar".'; fi
}

case "${1:-ajuda}" in
  instalar) instalar_programa
    if ! mesma "$DESTINO" "$RAIZ"; then
      # continua pela cópia instalada: o registro, o ajudante e o Docker passam a usar a pasta do programa
      /bin/bash "$DESTINO/ergon.sh" instalar; say "Pode apagar a pasta do zip ($RAIZ). Em um terminal novo: ergon status"; exit 0
    fi
    need_docker; init_secrets; registrar; up; instalar_ajudante; [[ -n "${ERGON_SEM_NAVEGADOR:-}" ]] || abrir ;;
  remover) remover "${2:-}" ;;
  iniciar) need_docker; registrar; compose up -d; instalar_ajudante; wait_health 240 >/dev/null && say "No ar em $URL" || fail 'Não respondeu.' ;;
  subir) need_docker; registrar; say 'Ligando os serviços do Ergon e o motor de IA…'; compose up -d
    h="$(wait_health 240)" || fail 'O Ergon não respondeu. Veja: ./ergon.sh logs'; say "No ar em $URL" ;;
  parar) compose stop ;;
  status) compose ps; h="$(health)"; [[ -n "$h" ]] && say "Ergon $(field version <<<"$h") · $([[ "$(field sealed <<<"$h")" == true ]] && echo trancado || echo aberto) · $URL" || say 'Ergon não responde.' ;;
  abrir) abrir ;;
  logs) compose logs --tail 80 ergon motores ;;
  backup) backup ;;
  restaurar) restaurar "${2:-}" ;;
  desfazer-restauracao) desfazer_restauracao "${2:-}" ;;
  atualizar) need_docker; atualizar ;;
  ajudante) case "${2:-}" in remover) remover_ajudante ;; instalar) instalar_ajudante ;; *) ajudante ;; esac ;;
  *) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' ;;
esac

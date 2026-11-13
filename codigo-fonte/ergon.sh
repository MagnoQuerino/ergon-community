#!/usr/bin/env bash
# Ergon — lançador local (macOS e Linux). Depois de instalar, use de qualquer terminal: ergon <comando>
#
# Comandos (os nomes em português de antes continuam aceitos para sempre; a ajuda completa: ergon help):
#   install (instalar) · uninstall (remover; aceita remove) · uninstall --purge (remover --tudo; aceita --all e --tudo)
#   start (iniciar) · up (subir: só liga os serviços, é o que o Ergon Desktop usa) · stop (parar) · status
#   open (abrir) · backup · restore <pasta> (restaurar) · restore --undo <pre-restore-…> (desfazer-restauracao;
#   aceita undo-restore) · update (atualizar; aceita upgrade) · clean (limpar) · logs
#   helper [install|uninstall] (ajudante [instalar|remover]) · help · version
#
# Mensagens em português quando o sistema está em português e em inglês nos outros casos; ERGON_LANG=pt|en força.
# Confirmações: ERGON_CONFIRM (ou ERGON_CONFIRMAR). Sem abrir o navegador: ERGON_NO_BROWSER (ou ERGON_SEM_NAVEGADOR).
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

# ---------------------------------------------------------------- idioma das mensagens
# ERGON_LANG=pt|en força. Senão, o do sistema: LC_ALL, LC_MESSAGES, LANG (no macOS sem nenhum deles, a preferência
# do sistema). Português quando está em português; inglês nos outros casos, inclusive sem indicação nenhuma (vazio,
# C ou POSIX: o padrão de VMs de nuvem, contêineres e sessões SSH). A exceção é o ambiente do Ergon Desktop no
# Windows (roda sem locale, e as telas do Desktop ainda são em português): a imagem dele grava /etc/ergon-ambiente.
AMBIENTE_DESKTOP="${ERGON_AMBIENTE_MARCA:-/etc/ergon-ambiente}"   # outro caminho: só nos testes
lingua() {
  local v
  for v in "${ERGON_LANG:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    case "$v" in '' | C | C.* | POSIX) continue ;; pt* | PT*) echo pt; return ;; *) echo en; return ;; esac
  done
  if [[ "$SO" == Darwin ]]; then
    v="$(defaults read -g AppleLocale 2>/dev/null || true)"
    case "$v" in pt*) echo pt; return ;; ?*) echo en; return ;; esac
  fi
  if [[ -f "$AMBIENTE_DESKTOP" ]]; then echo pt; else echo en; fi
}
EN=0; [[ "$(lingua)" == en ]] && EN=1
# txt 'português' 'english': o texto no idioma das mensagens
txt() { if (( EN )) && [[ $# -ge 2 ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
say() { printf '[ergon] %s\n' "$(txt "$@")"; }
fail() { printf '[ergon] %s\n' "$(txt "$@")" >&2; exit 1; }
dotenv() { [[ -f "$RAIZ/.env" ]] && sed -n "s/^$1=//p" "$RAIZ/.env" | tail -1 | tr -d '"'"'" || true; }

PORTA="$(dotenv ERGON_PORT)"; PORTA="${PORTA:-8787}"
URL="http://localhost:$PORTA"
# nome do projeto Compose (volumes: <projeto>_ergon-data e <projeto>_hermes-vault)
PROJETO="${COMPOSE_PROJECT_NAME:-$(dotenv COMPOSE_PROJECT_NAME)}"; PROJETO="${PROJETO:-ergon}"
SEGREDOS="$(dotenv ERGON_SECRETS_DIR)"; SEGREDOS="${SEGREDOS:-${ERGON_SECRETS_DIR:-$HOME/.ergon/secrets}}"

# Motor de contêineres: o Podman. Uma instalação de antes dele, feita com o Docker, segue no Docker até migrar (a
# escolha fica no .env, para não trocar sozinha e perder de vista os dados guardados no outro motor).
MOTOR="${ERGON_MOTOR:-$(dotenv ERGON_MOTOR)}"
if [[ -z "$MOTOR" ]]; then
  if [[ -n "$(dotenv ERGON_SECRETS_DIR)" ]] && command -v docker >/dev/null 2>&1; then MOTOR=docker
  elif command -v podman >/dev/null 2>&1; then MOTOR=podman; else MOTOR=docker; fi
fi
[[ "$MOTOR" == podman || "$MOTOR" == docker ]] || fail "ERGON_MOTOR desconhecido: $MOTOR (use podman)." "Unknown ERGON_MOTOR: $MOTOR (use podman)."
# a API que o gerente de motores usa: a do Podman (do sistema, como root, ou da conta) ou o socket do Docker
if [[ "$MOTOR" == podman ]]; then
  if [[ "$(id -u)" == 0 ]]; then SOCKET=/run/podman/podman.sock; else SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"; fi
else SOCKET=/var/run/docker.sock; fi
# podman-compose: o que vem com o Ergon Desktop no Linux (mesma versão em todas as distribuições) ou o do sistema
PODMAN_COMPOSE=(podman-compose)
[[ -f /usr/lib/ergon/podman-compose ]] && PODMAN_COMPOSE=(python3 /usr/lib/ergon/podman-compose)
compose() {
  if [[ "$MOTOR" == podman ]]; then (cd "$RAIZ" && ERGON_SOCKET="$SOCKET" "${PODMAN_COMPOSE[@]}" --profile hermes "$@")
  else (cd "$RAIZ" && ERGON_SOCKET="$SOCKET" docker compose --profile hermes "$@"); fi
}
# contêiner de um serviço do projeto (ligado; com "todos", também parado), pelos rótulos que os dois motores põem
cid() { "$MOTOR" ps ${2:+-a} -q --filter "label=com.docker.compose.project=$PROJETO" --filter "label=com.docker.compose.service=$1" | head -1; }
# A API do Podman, que o gerente de motores usa. No ambiente do Windows quem liga é o próprio ambiente; na conta de uma
# pessoa (Linux), o soquete do systemd da conta (podman.socket) ou, sem ele, o serviço do Podman em segundo plano.
garantir_api() {
  [[ "$MOTOR" == podman && ! -S "$SOCKET" ]] || return 0
  if [[ "$(id -u)" != 0 ]] && command -v systemctl >/dev/null 2>&1; then systemctl --user enable --now podman.socket >/dev/null 2>&1 || true; fi
  if [[ ! -S "$SOCKET" ]]; then
    mkdir -p "$(dirname "$SOCKET")"
    nohup podman system service --time=0 "unix://$SOCKET" >/dev/null 2>&1 &
  fi
  local i; for i in $(seq 1 30); do [[ -S "$SOCKET" ]] && return 0; sleep 1; done
  fail 'A API do Podman não ligou (o gerente dos motores de IA precisa dela).' 'The Podman API did not start (the AI engine manager needs it).'
}
need_motor() {
  if "$MOTOR" info >/dev/null 2>&1; then garantir_api; return 0; fi
  if [[ "$MOTOR" == podman ]]; then fail 'O Podman não está respondendo. Instale o Ergon Desktop (pacote .deb, que traz o Podman) ou o Podman e tente de novo.' \
    'Podman is not responding. Install Ergon Desktop (the .deb package, which brings Podman) or Podman, and try again.'
  else fail 'O Docker não está rodando. Abra o Docker e tente de novo.' 'Docker is not running. Open Docker and try again.'; fi
}
# imagem do motor de IA: o gerente cria os motores com ela, então precisa estar aqui antes (o serviço dela não tem
# contêiner, e o "pull" do podman-compose só traz as imagens de serviços com contêiner)
imagem_motor() { sed -nE 's/^ *ERGON_MOTOR_IMAGE: *//p' "$RAIZ/docker-compose.yml" | head -1 | tr -d '"'; }
# Liga os serviços. Com o Podman, os contêineres do projeto saem antes e são criados de novo: o podman-compose não
# reaproveita contêiner existente (o "up" tenta criar outro com o mesmo nome). Os volumes, com os dados, ficam; os
# motores de cada pessoa (criados pelo gerente, sem os rótulos do projeto) também.
ligar_servicos() {
  if [[ "$MOTOR" == podman ]]; then
    local ids; ids="$("$MOTOR" ps -aq --filter "label=com.docker.compose.project=$PROJETO")"
    [[ -n "$ids" ]] && { "$MOTOR" rm -f $ids >/dev/null || fail 'Não consegui desligar os serviços de antes.' 'Could not stop the previous services.'; }
  fi
  compose up -d "$@"
}
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
abrir() { if [[ "$SO" == Darwin ]]; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || say "Abra $URL" "Open $URL"; fi; }

init_secrets() {
  mkdir -p "$SEGREDOS"; chmod 700 "$SEGREDOS"
  if [[ -f "$SEGREDOS/ergon.env" || -f "$SEGREDOS/hermes.env" ]]; then say "Segredos já existem em $SEGREDOS (não alterados)." "Secrets already exist in $SEGREDOS (left unchanged)."
  else
    local api ponte; api="$(token)"; ponte="$(token)"
    (umask 077
     printf '# Ergon — segredos locais (não versionar, não sincronizar)\nERGON_HERMES_API_KEY=%s\nERGON_BRIDGE_TOKEN=%s\nERGON_AGENT_TOKEN=%s\n' "$api" "$ponte" "$(token)" > "$SEGREDOS/ergon.env"
     printf '# Motor de IA do Ergon — segredos locais\nAPI_SERVER_KEY=%s\nERGON_BRIDGE_TOKEN=%s\nHERMES_DASHBOARD_SESSION_TOKEN=%s\n' "$api" "$ponte" "$(token)" > "$SEGREDOS/hermes.env")
    say "Segredos gerados em $SEGREDOS (valores não exibidos)." "Secrets created in $SEGREDOS (values not shown)."
  fi
  # instalações anteriores: acrescenta só o token do ajudante (valor não exibido)
  if [[ -f "$SEGREDOS/ergon.env" ]] && ! grep -q '^ERGON_AGENT_TOKEN=' "$SEGREDOS/ergon.env"; then
    printf 'ERGON_AGENT_TOKEN=%s\n' "$(token)" >> "$SEGREDOS/ergon.env"; say 'ergon.env: token do ajudante acrescentado.' 'ergon.env: helper token added.'
  fi
  touch "$RAIZ/.env"
  grep -q '^ERGON_SECRETS_DIR=' "$RAIZ/.env" || echo "ERGON_SECRETS_DIR=$SEGREDOS" >> "$RAIZ/.env"
  grep -q '^ERGON_EXECUTOR=' "$RAIZ/.env" || echo 'ERGON_EXECUTOR=hermes' >> "$RAIZ/.env"
  grep -q '^ERGON_MOTOR=' "$RAIZ/.env" || echo "ERGON_MOTOR=$MOTOR" >> "$RAIZ/.env"
}

# Onde esta instalação está (lido pelo Ergon Desktop para achar o lançador e a porta). Só caminho e porta.
registrar() {
  local f="${ERGON_INSTALACAO:-$HOME/.ergon/instalacao.json}"   # ERGON_INSTALACAO: testes isolados
  mkdir -p "$(dirname "$f")"
  printf '{"raiz":"%s","porta":%s,"atualizado":"%s"}\n' "$(esc "$RAIZ")" "$PORTA" "$(date +%Y-%m-%dT%H:%M:%S)" > "$f" || true
}

# up [semfalha]: com "semfalha", não responder devolve 1 em vez de encerrar (quem chama decide o que fazer)
up() {
  if (( FONTE )); then ligar_servicos --build; else compose pull; [[ "$MOTOR" == podman ]] && { "$MOTOR" pull -q "$(imagem_motor)" >/dev/null || fail 'Não consegui baixar a imagem do motor de IA.' 'Could not download the AI engine image.'; }; ligar_servicos; fi
  local h; if ! h="$(wait_health 240)"; then [[ "${1:-}" == semfalha ]] && return 1; fail 'O Ergon não respondeu. Veja: ./ergon.sh logs' 'Ergon did not respond. See: ./ergon.sh logs'; fi
  if [[ "$(field sealed <<<"$h")" == true ]]; then say "Ergon no ar e TRANCADO: abra $URL e digite a senha." "Ergon is running and LOCKED: open $URL and type the password."
  else say "Ergon no ar em $URL" "Ergon is running at $URL"; fi
}
# a versão $1 é mais nova que a $2? (números: 0.10 > 0.9; sem a atual, sim)
mais_nova() { [[ -z "$2" ]] && return 0; [[ "$1" == "$2" ]] && return 1; [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; }

backup() {
  local h; h="$(health)"
  [[ -z "$h" ]] && { say 'Ergon parado: sem backup agora.' 'Ergon is stopped: no backup now.'; return 1; }
  [[ "$(field sealed <<<"$h")" == true ]] && { say 'Ergon trancado: destranque para fazer o backup.' 'Ergon is locked: unlock it to make the backup.'; return 1; }
  local nome id; nome="$(compose exec -T ergon node server/src/backup-cli.ts)" || fail 'O backup falhou.' 'The backup failed.'
  id="$(cid ergon)"; mkdir -p "$BACKUPS"
  "$MOTOR" cp "$id:/data/backups/$nome" "$BACKUPS/$nome" >/dev/null && [[ -f "$BACKUPS/$nome/manifest.json" ]] \
    || fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $BACKUPS falhou." "The backup is in the volume (/data/backups/$nome), but copying it to $BACKUPS failed."
  chmod -R go-rwx "$BACKUPS/$nome"
  say "Backup completo e conferido (banco, arquivos e conexões): $BACKUPS/$nome" "Full backup, checked (database, files and connections): $BACKUPS/$nome"
  girar_backups "$nome"
}

# Ferramenta de restauração (server/src/restore-cli.ts) num contêiner de uso único com o volume de dados: funciona
# com o Ergon parado. Imprime a linha JSON que ela devolve. Uso: restore_tool [opções do run --] <args>
restore_tool() {
  local extra=(); while [[ $# -gt 0 && "$1" != -- ]]; do extra+=("$1"); shift; done; [[ "${1:-}" == -- ]] && shift
  compose run --rm --no-deps -T ${extra[@]+"${extra[@]}"} ergon node server/src/restore-cli.ts "$@" 2>/dev/null | grep '^{' | tail -1 || true
}
# cofre do motor: arquivos do usuário do motor (10000), com dono e permissões que o gocryptfs usa. O serviço do
# Ergon descarta todas as capacidades; este passo devolve só as de ler, copiar com dono e ajustar permissões.
MOTOR_ROOT=(--user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "${PROJETO}_hermes-vault:/vault")
num() { sed -nE "s/.*\"$1\":([0-9]+).*/\1/p"; }
minusculas() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# sim? (s, sim, y, yes; maiúsculas também)
e_sim() { case "$(minusculas "$1")" in s | sim | y | yes) return 0 ;; *) return 1 ;; esac; }
# confirmação: ERGON_CONFIRM (ou ERGON_CONFIRMAR) com sim/yes responde sem perguntar
confirmar() {
  e_sim "${ERGON_CONFIRM:-${ERGON_CONFIRMAR:-}}" && return 0
  local r=''; read -r -p "$1 $(txt '(s/N)' '(y/N)') " r || true; e_sim "$r"
}
carimbo() { date -u +%Y-%m-%dT%H-%M-%S-000Z; }

# Restaurar: confere o backup inteiro antes; para o Ergon; o que estava no lugar vai para
# /data/backups/pre-restore-<data> (nada é apagado); sobe de novo. Backup de outra instalação: o cofre do motor de
# IA desta máquina é de outra chave, então vai inteiro para o pre-restore e o motor começa um novo.
restaurar() {
  local origem="${1:-}"
  [[ -n "$origem" ]] || fail "Diga qual backup: ./ergon.sh restore <pasta do backup>   (os backups ficam em $BACKUPS)" "Say which backup: ./ergon.sh restore <backup folder>   (backups are in $BACKUPS)"
  [[ -e "$origem" ]] || { [[ -e "$BACKUPS/$origem" ]] && origem="$BACKUPS/$origem"; } || fail "Não achei o backup $origem." "Backup not found: $origem."
  origem="$(cd "$(dirname "$origem")" && pwd)/$(basename "$origem")"
  [[ "$(basename "$origem")" == manifest.json ]] && origem="$(dirname "$origem")"
  if [[ -d "$origem" ]]; then [[ -f "$origem/manifest.json" ]] || fail 'Essa pasta não é um backup do Ergon (falta o manifest.json).' 'This folder is not an Ergon backup (manifest.json is missing).'
  else [[ "$origem" == *.sqlite ]] || fail 'Indique a pasta do backup (ou um backup antigo .sqlite).' 'Give the backup folder (or an old .sqlite backup).'; fi
  need_motor
  local id; id="$(cid ergon todos)"
  [[ -n "$id" ]] || fail 'O Ergon não está instalado aqui. Rode ./ergon.sh install e restaure antes de criar a conta.' 'Ergon is not installed here. Run ./ergon.sh install and restore before creating the account.'
  local c; c="$(carimbo)"; local entrada="/data/backups/entrada-$c" alvo
  [[ "$(restore_tool -- preparar | field ok)" == true ]] || fail 'Não consegui preparar o volume do Ergon; nada foi alterado.' 'Could not prepare the Ergon volume; nothing was changed.'
  # o backup entra no volume como cópia (o original fica onde está)
  if [[ -d "$origem" ]]; then alvo="$entrada"; "$MOTOR" cp "$origem" "$id:$entrada" >/dev/null || fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.' 'Could not copy the backup into the Ergon volume; nothing was changed.'
  else
    local tmp; tmp="$(mktemp -d)"; cp "$origem" "$tmp/"; [[ -f "$origem.keyring.json" ]] && cp "$origem.keyring.json" "$tmp/"
    "$MOTOR" cp "$tmp" "$id:$entrada" >/dev/null || { rm -rf "$tmp"; fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.' 'Could not copy the backup into the Ergon volume; nothing was changed.'; }
    rm -rf "$tmp"; alvo="$entrada/$(basename "$origem")"
  fi
  local conf; conf="$(restore_tool -- conferir "$alvo")"
  [[ "$(field ok <<<"$conf")" == true ]] || fail "O backup não confere; nada foi alterado. $(field error <<<"$conf") $conf" "The backup does not check out; nothing was changed. $(field error <<<"$conf") $conf"
  if [[ "$(field legacy <<<"$conf")" == true ]]; then say 'Backup antigo: volta o banco (e o keyring); os arquivos e as conexões atuais ficam como estão.' 'Old backup: the database (and the keyring) come back; current files and connections stay as they are.'
  else say "Backup de $(field createdAt <<<"$conf") (versão $(field version <<<"$conf")), conferido: $(num artifacts <<<"$conf") arquivo(s), $(num secrets <<<"$conf") credencial(is) de conexão." \
    "Backup from $(field createdAt <<<"$conf") (version $(field version <<<"$conf")), checked: $(num artifacts <<<"$conf") file(s), $(num secrets <<<"$conf") connection credential(s)."; fi
  local chave; chave="$(field keyring <<<"$conf")"
  [[ "$chave" == outra ]] && say 'É o backup de outra instalação: o motor de IA começa um cofre novo (o atual fica guardado).' 'This backup is from another installation: the AI engine starts a new vault (the current one is kept).'
  [[ -n "$chave" && "$chave" != sem ]] && say 'Depois, o Ergon pode pedir a senha (ou a frase de recuperação) da época do backup.' 'Afterwards, Ergon may ask for the password (or the recovery phrase) from the time of the backup.'
  say "O que está no lugar agora vai para /data/backups/pre-restore-$c (nada é apagado)." "What is in place now goes to /data/backups/pre-restore-$c (nothing is deleted)."
  confirmar "$(txt 'Restaurar agora?' 'Restore now?')" || { say 'Nada foi alterado.' 'Nothing was changed.'; return 0; }
  compose stop ergon
  local r; r="$(restore_tool -- restaurar "$alvo" "$c")"
  [[ "$(field ok <<<"$r")" == true ]] || { compose start ergon; fail "A restauração não foi feita; os dados atuais continuam no lugar. $(field error <<<"$r")" "The restore was not done; the current data is still in place. $(field error <<<"$r")"; }
  if [[ "$(field keyring <<<"$r")" == outra ]]; then
    local m; m="$(restore_tool "${MOTOR_ROOT[@]}" -- motor /vault "/data/backups/pre-restore-$c/motor")"
    [[ "$(field ok <<<"$m")" == true ]] || say "Atenção: o cofre do motor não foi posto de lado ($(field error <<<"$m")); o motor pode não abrir com a chave restaurada." \
      "Warning: the engine vault was not set aside ($(field error <<<"$m")); the engine may not open with the restored key."
  fi
  compose start ergon
  local h; h="$(wait_health 240)" || fail "O Ergon não respondeu depois de restaurar. Para voltar: ./ergon.sh restore --undo pre-restore-$c" "Ergon did not respond after the restore. To go back: ./ergon.sh restore --undo pre-restore-$c"
  if [[ "$(field sealed <<<"$h")" == true ]]; then say "Restaurado. Abra $URL e digite a senha (ou a frase) da época do backup." "Restored. Open $URL and type the password (or the phrase) from the time of the backup."
  else say "Restaurado. No ar em $URL." "Restored. Running at $URL."; fi
  say "Para voltar ao que era antes: ./ergon.sh restore --undo pre-restore-$c" "To go back to how it was before: ./ergon.sh restore --undo pre-restore-$c"
}

desfazer_restauracao() {
  local pre="${1:-}"
  [[ "$pre" =~ ^pre-restore-[A-Za-z0-9_-]+$ ]] || fail 'Diga qual: ./ergon.sh restore --undo pre-restore-<data>  (o nome aparece ao restaurar)' 'Say which one: ./ergon.sh restore --undo pre-restore-<date>  (the name is shown when restoring)'
  need_motor
  confirmar "$(txt "Voltar ao que era antes da restauração $pre?" "Go back to how it was before the restore $pre?")" || { say 'Nada foi alterado.' 'Nothing was changed.'; return 0; }
  compose stop ergon
  local r; r="$(restore_tool -- desfazer "/data/backups/$pre")"
  [[ "$(field ok <<<"$r")" == true ]] || { compose start ergon; fail "Não deu para desfazer: $(field error <<<"$r")" "Could not undo: $(field error <<<"$r")"; }
  local aside; aside="$(field aside <<<"$r")"
  if [[ "$(field motor <<<"$r")" == true ]]; then
    local m; m="$(restore_tool "${MOTOR_ROOT[@]}" -- motor-volta /vault "/data/backups/$pre/motor" "$aside/motor")"
    [[ "$(field ok <<<"$m")" == true ]] || say "Atenção: o cofre do motor não voltou ($(field error <<<"$m"))." "Warning: the engine vault did not come back ($(field error <<<"$m"))."
  fi
  compose start ergon
  say "Voltou ao que era antes da restauração. O restaurado ficou guardado em $aside." "Back to how it was before the restore. The restored data was kept in $aside."
}

# Atualizar: backup antes; só versão mais nova; a atual fica guardada; se a nova não responder, volta sozinho. O banco
# não volta sozinho (a nova pode ter migrado): se nem a anterior responder, diz qual backup restaurar.
atualizar() {
  local antes; antes="$(ls -1 "$BACKUPS" 2>/dev/null || true)"
  if ! backup; then confirmar "$(txt 'Continuar sem backup?' 'Continue without a backup?')" || exit 1; fi
  local feito; feito="$(comm -13 <(printf '%s\n' "$antes" | sort) <(ls -1 "$BACKUPS" 2>/dev/null | sort) | head -1)"
  local voltar
  if [[ -n "$feito" ]]; then voltar="$(txt "restaure o backup de antes: ./ergon.sh restore \"$BACKUPS/$feito\"" "restore the backup made before: ./ergon.sh restore \"$BACKUPS/$feito\"")"
  else voltar="$(txt 'restaure o backup mais recente: ./ergon.sh restore <pasta>' 'restore the most recent backup: ./ergon.sh restore <folder>')"; fi
  if (( FONTE )); then
    local rev; rev="$(cd "$RAIZ" && git rev-parse --short HEAD 2>/dev/null || true)"
    (cd "$RAIZ" && git pull --ff-only) || fail 'git pull falhou (há mudanças locais, ou a branch não acompanha uma remota). Nada foi alterado.' 'git pull failed (there are local changes, or the branch does not track a remote). Nothing was changed.'
    if up semfalha; then limpar || true; return; fi
    fail "A versão nova não respondeu. Para voltar: git checkout $rev e ./ergon.sh start; se ainda assim não subir, $voltar" "The new version did not respond. To go back: git checkout $rev and ./ergon.sh start; if it still does not start, $voltar"
  fi
  local m ver bundle sha atual tmp
  m="$(curl -fsSL --max-time 20 "${ERGON_UPDATE_URL:-$MANIFESTO}")" || fail 'Não consegui ler a versão publicada.' 'Could not read the published version.'
  ver="$(field version <<<"$m")"; bundle="$(field bundle <<<"$m")"; sha="$(field sha256 <<<"$m")"
  atual="$(head -1 "$RAIZ/VERSAO" 2>/dev/null || true)"
  mais_nova "$ver" "$atual" || { say "Já está na versão $atual (publicada: $ver)." "Already on version $atual (published: $ver)."; return; }
  [[ -n "$bundle" && -n "$sha" ]] || fail 'Manifesto da versão sem pacote.' 'The version manifest has no package.'
  tmp="$(mktemp -d)"; curl -fsSL "$bundle" -o "$tmp/ergon.zip" || fail 'Não consegui baixar o pacote. Nada foi alterado.' 'Could not download the package. Nothing was changed.'
  local got; if command -v sha256sum >/dev/null; then got="$(sha256sum "$tmp/ergon.zip" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/ergon.zip" | cut -d' ' -f1)"; fi
  [[ "$got" == "$sha" ]] || fail 'Pacote baixado não confere (SHA-256). Nada foi alterado.' 'The downloaded package does not match (SHA-256). Nothing was changed.'
  (cd "$tmp" && unzip -q ergon.zip -d x)
  # a versão atual fica guardada (arquivos do pacote; o .env e os dados não mudam)
  local guardada="$HOME/.ergon/versoes/${atual:-anterior}"
  rm -rf "$guardada"; mkdir -p "$guardada"
  (cd "$RAIZ" && tar --exclude=.env -cf - .) | (cd "$guardada" && tar -xf -)
  (cd "$tmp/x" && tar --exclude=.env -cf - .) | (cd "$RAIZ" && tar -xf -)
  say "Pacote $ver aplicado (a $atual ficou guardada em $guardada)." "Package $ver applied ($atual was kept in $guardada)."
  # no ar: as imagens antigas sem uso saem; das versões guardadas, fica só esta (a anterior)
  if up semfalha; then limpar || true; limpar_versoes "$guardada"; return; fi
  say "A versão $ver não respondeu: voltando para a $atual." "Version $ver did not respond: going back to $atual."
  (cd "$guardada" && tar -cf - .) | (cd "$RAIZ" && tar -xf -)
  up semfalha && { say "Voltou para a $atual e está no ar. A $ver fica para depois (veja ./ergon.sh logs)." "Back on $atual and running. $ver is left for later (see ./ergon.sh logs)."; return; }
  fail "Nem a versão $atual respondeu (a nova pode ter mudado o banco): $voltar" "Not even version $atual responded (the new one may have changed the database): $voltar"
}

# ---------------------------------------------------------------- limpeza: imagens, backups e versões guardadas
# Imagens: só as dos repositórios do Ergon (o do serviço e o do motor de IA, lidos do docker-compose.yml desta pasta),
# sem forçar (rmi sem -f: imagem em uso por um contêiner, parado também, nunca sai) e nunca volume. Ficam a imagem de
# qualquer contêiner, a atual de cada repositório e a anterior anotada no motor (rótulo ergon.motor.prev-image: enquanto
# a troca não é confirmada ela fica no disco; depois de confirmar, o gerente já a apagou e o rótulo só fica de registro). Nada de "prune": ele apagaria justamente a imagem atual que ainda não tem contêiner.
#   limpar        depois de atualizar (o gerente de motores faz a mesma limpeza pela API, com as mesmas regras)
#   limpar tudo   no remover, com os contêineres já fora: também as atuais
refs_ergon() {
  [[ -f "$RAIZ/docker-compose.yml" ]] || return 0
  sed -nE 's/^[[:space:]]*(image|ERGON_MOTOR_IMAGE):[[:space:]]*"?([^"[:space:]#$]+)"?.*$/\2/p' "$RAIZ/docker-compose.yml" | sort -u
}
# repositório de uma referência: sem o digest (@…) e sem a etiqueta (o ":" depois da última "/")
repo_de() { local r="${1%%@*}"; [[ "${r##*/}" == *:* ]] && r="${r%:*}"; printf '%s\n' "$r"; }
# ID completo sem o "sha256:" (o Docker põe, o Podman não); nada, se não for um ID
id_puro() { local i="${1#sha256:}"; [[ "$i" =~ ^[0-9a-f]{64}$ ]] && printf '%s\n' "$i"; return 0; }
limpar() {
  local tudo=0; [[ "${1:-}" == tudo ]] && tudo=1
  local repos ref c cs id repo tag dig i t lista filas='' cand=' ' guardar=' ' n=0 bytes=0 ficaram=0
  repos=" $(refs_ergon | while read -r ref; do repo_de "$ref"; done | sort -u | tr '\n' ' ')"
  [[ -n "${repos// /}" ]] || return 0
  # em uso: a imagem de cada contêiner (parado também, de qualquer projeto) e a anterior de um motor ainda não confirmada
  cs="$("$MOTOR" ps -aq 2>/dev/null || true)"
  if [[ -n "$cs" ]]; then
    for c in $("$MOTOR" inspect --format '{{.Image}} {{ index .Config.Labels "ergon.motor.prev-image" }}' $cs 2>/dev/null || true); do
      id="$(id_puro "$c")"; [[ -n "$id" ]] && guardar="$guardar$id "
    done
  fi
  # as atuais (a do serviço e a do motor de IA) ficam, a não ser no remover
  if (( ! tudo )); then
    for ref in $(refs_ergon); do
      id="$(id_puro "$("$MOTOR" image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)")"; [[ -n "$id" ]] && guardar="$guardar$id "
    done
  fi
  # candidatas: as dos repositórios do Ergon que não ficam (o Podman chama "localhost/x" a imagem x construída aqui)
  # o ID inteiro: no Podman é {{.Id}} ({{.ID}} sai curto); no Docker, {{.ID}} com --no-trunc
  local fid='{{.ID}}'; [[ "$MOTOR" == podman ]] && fid='{{.Id}}'
  lista="$("$MOTOR" images --no-trunc --digests --format "$fid {{.Repository}} {{.Tag}} {{.Digest}}" 2>/dev/null || true)"
  while read -r id repo tag dig; do
    id="$(id_puro "${id:-}")"; [[ -n "$id" ]] || continue
    [[ "$repos" == *" $repo "* || "$repos" == *" ${repo#localhost/} "* ]] || continue
    [[ "$guardar" == *" $id "* ]] && continue
    filas="$filas$id $repo $tag $dig"$'\n'
    [[ "$cand" == *" $id "* ]] || cand="$cand$id "
  done <<<"$lista"
  for id in $cand; do
    t="$("$MOTOR" image inspect --format '{{.Size}}' "$id" 2>/dev/null || true)"; [[ "$t" =~ ^[0-9]+$ ]] || t=0
    if ! "$MOTOR" rmi "$id" >/dev/null 2>&1; then
      # com mais de um nome, o ID sozinho não sai sem forçar: tira os nomes do Ergon, um a um (os de fora ficam)
      while read -r i repo tag dig; do
        [[ "${i:-}" == "$id" ]] || continue
        if [[ -n "$tag" && "$tag" != '<none>' ]]; then "$MOTOR" rmi "$repo:$tag" >/dev/null 2>&1 || true
        elif [[ "$dig" == sha256:* ]]; then "$MOTOR" rmi "$repo@$dig" >/dev/null 2>&1 || true; fi
      done <<<"$filas"
    fi
    if "$MOTOR" image inspect "$id" >/dev/null 2>&1; then ficaram=$((ficaram + 1)); else n=$((n + 1)); bytes=$((bytes + t)); fi
  done
  if (( n )); then say "Limpeza: $n imagem(ns) antiga(s) do Ergon removida(s), $((bytes / 1048576)) MB liberados." "Cleanup: $n old Ergon image(s) removed, $((bytes / 1048576)) MB freed."; fi
  if (( ficaram )); then say "$ficaram imagem(ns) antiga(s) do Ergon ficaram (em uso, ou com um nome de fora do Ergon)." "$ficaram old Ergon image(s) were kept (in use, or with a name from outside Ergon)."; fi
  return 0
}
# Backups: ficam os 7 mais recentes (ERGON_BACKUPS_MANTER muda o número; 0 guarda todos). Só os do próprio Ergon, pelo
# nome (a pasta ergon-<data>, ou o antigo ergon-<data>.sqlite com o .keyring.json dele): a data no nome dá a ordem. O
# que acabou de ser feito ($1) conta como o mais novo e nunca sai. Outros arquivos da pasta não são tocados.
girar_backups() {
  local manter="${ERGON_BACKUPS_MANTER:-7}" feito="${1:-}" todos e i=0 sairam=0
  [[ "$manter" =~ ^[0-9]+$ && "$manter" -gt 0 && -d "$BACKUPS" ]] || return 0
  todos="$( { if [[ -n "$feito" && -e "$BACKUPS/$feito" ]]; then printf '%s\n' "$feito"; fi
              ls -1 "$BACKUPS" 2>/dev/null | grep -E '^ergon-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9A-Za-z-]+(\.sqlite)?$' | grep -vxF -- "$feito" | sort -r; } || true)"
  while read -r e; do
    [[ -n "$e" ]] || continue
    i=$((i + 1)); (( i > manter )) || continue
    rm -rf -- "${BACKUPS:?}/$e"; rm -f -- "$BACKUPS/$e.keyring.json"; sairam=$((sairam + 1))
  done <<<"$todos"
  if (( sairam )); then say "Backups: ficaram os $manter mais recentes ($sairam antigo(s) apagado(s) em $BACKUPS)." "Backups: the $manter most recent were kept ($sairam old one(s) deleted in $BACKUPS)."; fi
  return 0
}
# Versões guardadas pelo atualizar (~/.ergon/versoes): fica só a anterior ($1), a que ele usa para voltar.
limpar_versoes() {
  local d; for d in "$HOME/.ergon/versoes"/*; do [[ -d "$d" && "$d" != "$1" ]] && rm -rf -- "$d"; done
  return 0
}

# ---------------------------------------------------------------- ajudante (destrancar sozinho)
# O Ergon roda em contêineres (Podman; Docker numa instalação antiga) e não alcança o cofre do sistema. O ajudante
# roda na sua conta desde que você entra no computador: avisa o Ergon que está ali; quando você liga "Destrancar
# sozinho" na tela, busca a chave e a guarda nas Chaves do macOS (ou no chaveiro do Linux, via libsecret); se o
# Ergon reiniciar trancado, destranca.
# Desligar na tela invalida a chave, e o ajudante apaga a dela.
LOCAL="${ERGON_LOCAL_DIR:-$HOME/.ergon}"
INICIO_MAC="$HOME/Library/LaunchAgents/com.ergon.ajudante.plist"
INICIO_LINUX="$HOME/.config/autostart/ergon-ajudante.desktop"
log_ajudante() { mkdir -p "$LOCAL"; printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$(txt "$@")" >> "$LOCAL/ajudante.log"; }
agent_token() { sed -n 's/^ERGON_AGENT_TOKEN=//p' "$SEGREDOS/ergon.env" 2>/dev/null | head -1 | tr -d '\r'; }
# o guardado é "id:chave", ou várias separadas por ";" (uma por pessoa que ligou "abrir sozinho" nesta conta)
guardar_chave() {
  if [[ "$SO" == Darwin ]]; then security add-generic-password -U -a "$USER" -s ergon-destravar -w "$1" >/dev/null
  else printf '%s' "$1" | secret-tool store --label="$(txt 'Ergon — destrancar sozinho' 'Ergon — unlock automatically')" service ergon account destravar; fi
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
  [[ "$SO" == Darwin ]] || command -v secret-tool >/dev/null || { log_ajudante 'sem secret-tool (instale libsecret-tools)' 'no secret-tool (install libsecret-tools)'; return 1; }
  TOK="$(agent_token)"; [[ -n "$TOK" ]] || { log_ajudante 'sem ERGON_AGENT_TOKEN em ergon.env (rode "ergon install")' 'no ERGON_AGENT_TOKEN in ergon.env (run "ergon install")'; return 1; }
  local label; label="$(hostname) ($USER)"
  log_ajudante 'ajudante iniciado' 'helper started'
  while true; do
    local saved id key body out code ids e
    saved="$(ler_chave)"; ids=''
    for e in ${saved//;/ }; do ids="$ids${ids:+,}\"${e%%:*}\""; done
    id="${saved%%:*}"
    body="{\"label\":\"$(esc "$label")\",\"platform\":\"$( [[ "$SO" == Darwin ]] && echo macos || echo linux )\"${saved:+,\"keyId\":\"$id\",\"keyIds\":[$ids]}}"
    out="$(agent_post /api/agent/hello "$body")"; code="${out##*$'\n'}"; out="${out%$'\n'*}"
    if [[ "$code" == 200 ]]; then
      for e in $(lista invalid <<<"$out"); do tirar_chave "$e"; log_ajudante 'abrir sozinho desligado na tela: uma chave apagada' 'automatic unlock turned off on screen: one key deleted'; done
      # várias pessoas: a parte de quem ligou "abrir sozinho" ainda está fechada → abre com a chave dela
      for e in $(lista closed <<<"$out"); do
        key="$(chave_de "$e" "$saved")"; [[ -n "$key" ]] || continue
        code="$(agent_post /api/agent/open "{\"key\":\"$key\"}" 30 | tail -1)"
        if [[ "$code" == 200 ]]; then log_ajudante 'parte de uma pessoa aberta' "one person's part opened"; elif [[ "$code" == 401 ]]; then tirar_chave "$e"; log_ajudante 'chave recusada (foi desligada): apagada' 'key refused (it was turned off): deleted'; fi
      done
      if [[ "$(field enroll <<<"$out")" == true ]]; then
        out="$(agent_post /api/agent/auto-unlock/claim '{}' 10)"; code="${out##*$'\n'}"; out="${out%$'\n'*}"
        if [[ "$code" == 200 ]]; then por_chave "$(field id <<<"$out"):$(field key <<<"$out")"; out=''; log_ajudante 'abrir sozinho ligado: chave guardada no cofre do sistema' 'automatic unlock turned on: key kept in the system keychain'; fi
      fi
    elif [[ "$code" == 423 && -n "$saved" ]]; then
      # o Ergon reiniciou e está trancado → destranca com uma das chaves guardadas
      for e in ${saved//;/ }; do
        key="${e#*:}"
        code="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$URL/api/unseal/auto" -H 'Content-Type: application/json' --data-binary @- <<<"{\"key\":\"$key\"}" 2>/dev/null || echo 000)"
        if [[ "$code" == 200 ]]; then log_ajudante 'Ergon destrancado' 'Ergon unlocked'; break; elif [[ "$code" == 401 ]]; then tirar_chave "${e%%:*}"; log_ajudante 'chave recusada (foi desligada): apagada' 'key refused (it was turned off): deleted'; fi
      done
    fi
    saved=''; key=''
    sleep 5
  done
}
# O início automático chama "ajudante" (o nome de antes): assim ele funciona também se a pessoa voltar a uma versão
# anterior do lançador.
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
    printf '[Desktop Entry]\nType=Application\nName=%s\nExec=/bin/bash "%s/ergon.sh" ajudante\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$(txt 'Ergon — ajudante' 'Ergon — helper')" "$RAIZ" > "$INICIO_LINUX"
    nohup /bin/bash "$RAIZ/ergon.sh" ajudante >/dev/null 2>&1 &
  fi
  say 'Ajudante do computador ativo (começa sozinho ao entrar no computador).' 'Computer helper active (starts on its own when you sign in).'
}
remover_ajudante() {
  [[ "$SO" == Darwin ]] && launchctl unload "$INICIO_MAC" >/dev/null 2>&1 || true
  [[ -f "$LOCAL/ajudante.pid" ]] && kill "$(cat "$LOCAL/ajudante.pid")" 2>/dev/null || true
  apagar_chave; rm -f "$INICIO_MAC" "$INICIO_LINUX" "$LOCAL/ajudante.pid"
  say 'Ajudante removido e chave apagada deste computador. O destrancar sozinho fica desligado.' 'Helper removed and key deleted from this computer. Automatic unlock is now off.'
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
    *":$BIN:"*) say "Comando ergon disponível em qualquer terminal ($BIN/ergon)." "The ergon command is available in any terminal ($BIN/ergon)." ;;
    *) local p; for p in $(perfis); do grep -qF "$MARCA" "$p" 2>/dev/null || printf '\nexport PATH="%s:$PATH" %s\n' "$BIN" "$MARCA" >> "$p"; done
       say "Comando ergon instalado em $BIN/ergon. Abra um terminal novo para usar: ergon status" "The ergon command was installed in $BIN/ergon. Open a new terminal to use it: ergon status" ;;
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
  if (( FONTE )); then DESTINO="$RAIZ"; ligar_comando "$RAIZ"; say "Cópia do código: o comando ergon usa esta pasta ($RAIZ). Não a apague." "Source copy: the ergon command uses this folder ($RAIZ). Do not delete it."; return; fi
  DESTINO="$PROGRAMA"; mkdir -p "$PROGRAMA"
  if ! mesma "$RAIZ" "$PROGRAMA"; then
    local a; for a in ergon.sh ergon.ps1 ergon.cmd docker-compose.yml LEIA-ME.md VERSAO; do [[ -f "$RAIZ/$a" ]] && cp -f "$RAIZ/$a" "$PROGRAMA/$a"; done
    # o .env de uma instalação anterior (porta, opções) fica; o do zip só entra se não houver nenhum
    [[ -f "$RAIZ/.env" && ! -f "$PROGRAMA/.env" ]] && cp "$RAIZ/.env" "$PROGRAMA/.env"
    chmod 755 "$PROGRAMA/ergon.sh"; say "Ergon instalado em $PROGRAMA." "Ergon installed in $PROGRAMA."
  fi
  ligar_comando "$PROGRAMA"
}

# Tira o Ergon do computador. Sem --purge (ou --all, ou o --tudo de antes), os dados ficam (volumes, segredos e
# backups em ~/.ergon). Com ele, pede para digitar APAGAR (ou DELETE).
remover() {
  local tudo=0; case "${1:-}" in --purge | --all | --tudo) tudo=1 ;; esac
  if (( tudo )); then
    say 'Isto APAGA tudo o que o Ergon guardou neste computador: conversas, tarefas, agentes, conexões, arquivos, a memória do motor, os segredos e os backups. Não tem volta.' \
      'This DELETES everything Ergon kept on this computer: conversations, tasks, agents, connections, files, the engine memory, the secrets and the backups. It cannot be undone.'
    local r="${ERGON_CONFIRM:-${ERGON_CONFIRMAR:-}}"; [[ -n "$r" ]] || read -r -p "$(txt 'Para confirmar, digite APAGAR: ' 'To confirm, type DELETE: ')" r || true
    [[ "$r" == APAGAR || "$r" == DELETE ]] || fail 'Nada foi apagado.' 'Nothing was deleted.'
  fi
  if "$MOTOR" info >/dev/null 2>&1; then
    # motores por pessoa (criados pelo gerente): os contêineres saem; os cofres deles são dados
    local motores cofres='' m vols
    motores="$("$MOTOR" ps -aq --filter label=ergon.motor 2>/dev/null || true)"
    for m in $motores; do cofres="$cofres $("$MOTOR" inspect --format '{{ index .Config.Labels "ergon.motor.volume" }}' "$m" 2>/dev/null || true)"; done
    [[ -n "$motores" ]] && { "$MOTOR" rm -f $motores >/dev/null 2>&1 || true; }
    if (( tudo )); then
      compose down --remove-orphans --rmi all -v >/dev/null 2>&1 || true
      # as imagens dos dois repositórios do Ergon (o do serviço e o do motor de IA), de todas as versões, sem forçar
      limpar tudo || true
      vols="$("$MOTOR" volume ls -q 2>/dev/null | grep -E "^${PROJETO}_" || true) $cofres"; vols="$(echo $vols)"
      [[ -n "$vols" ]] && { "$MOTOR" volume rm -f $vols >/dev/null 2>&1 || true; }
      say 'Contêineres, imagens e volumes do Ergon apagados.' 'Ergon containers, images and volumes deleted.'
    else
      compose down --remove-orphans --rmi all >/dev/null 2>&1 || true
      limpar tudo || true
      say "Contêineres e imagens do Ergon removidos. Os dados ficaram guardados nos volumes ${PROJETO}_* do $MOTOR." "Ergon containers and images removed. The data was kept in the ${PROJETO}_* volumes of $MOTOR."
    fi
  else say "O $MOTOR não está respondendo: contêineres, imagens e volumes ficam até ele voltar e você rodar \"ergon uninstall\" de novo." \
    "$MOTOR is not responding: containers, images and volumes stay until it is back and you run \"ergon uninstall\" again."; fi
  remover_ajudante || true
  rm -f "${ERGON_INSTALACAO:-$HOME/.ergon/instalacao.json}"
  if (( tudo )); then rm -rf "$SEGREDOS" "$BACKUPS" "$LOCAL" "$HOME/.ergon"; say 'Segredos, backups e registros do Ergon apagados.' 'Ergon secrets, backups and records deleted.'
  else say "Segredos e backups guardados em $(dirname "$SEGREDOS")." "Secrets and backups kept in $(dirname "$SEGREDOS")."; fi
  desligar_comando
  if (( ! FONTE )) && mesma "$RAIZ" "$PROGRAMA"; then rm -rf "$PROGRAMA"; fi
  if (( tudo )); then say 'Pronto: o Ergon saiu deste computador, com os dados.' 'Done: Ergon was removed from this computer, along with its data.'
  else say 'Pronto: o Ergon saiu deste computador. Para voltar com os mesmos dados: baixe o pacote e rode "./ergon.sh install".' 'Done: Ergon was removed from this computer. To come back with the same data: download the package and run "./ergon.sh install".'; fi
}

# ---------------------------------------------------------------- ajuda, versão e os nomes dos comandos
# A versão: o arquivo VERSAO do pacote; numa cópia do código, a do package.json.
versao() {
  local v; v="$(head -1 "$RAIZ/VERSAO" 2>/dev/null | tr -d '\r' || true)"
  [[ -z "$v" && -f "$RAIZ/package.json" ]] && v="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$RAIZ/package.json" | head -1)"
  [[ -n "$v" ]] || fail 'Versão desconhecida (falta o arquivo VERSAO).' 'Unknown version (the VERSAO file is missing).'
  printf 'Ergon %s\n' "$v"
}
ajuda() {
  if (( EN )); then cat <<'EOF'
Ergon launcher. Usage: ergon <command>

  install                 installs Ergon in a folder of yours (~/.local/share/ergon), puts the "ergon" command in
                          ~/.local/bin, prepares the secrets, starts Ergon and opens the browser; the zip folder can
                          be deleted afterwards
  uninstall               removes Ergon from this computer and KEEPS the data (conversations, tasks, files,
                          connections, secrets and backups): installing again picks up where you left off
  uninstall --purge       removes Ergon and DELETES the data, the secrets and the backups (asks for confirmation)
  start | stop | status   starts, stops, shows the state
  up                      only starts the services (installs nothing at sign-in): what the Ergon Desktop app uses
  open                    opens http://localhost:8787
  backup                  full, checked backup (encrypted database, keyring, files and connections) in a folder in
                          ~/.ergon/backups (the 7 most recent are kept)
  restore <folder>        checks the backup, keeps what is in place (nothing is deleted) and restores
  restore --undo <pre-restore-…>   goes back to how it was before a restore
  update                  backup + new version (source copy: git pull; package: downloads the published version)
  clean                   removes old Ergon images nothing uses (runs on its own after updating)
  logs                    last lines from Ergon and the engine
  helper                  (runs on its own at sign-in) keeps the "unlock automatically" key in the system keychain
                          when you turn it on in Settings › Security, and unlocks Ergon after a restart
  helper uninstall        removes the helper from sign-in and deletes the stored key
  help                    shows this help
  version                 shows the version

Messages follow the system language; ERGON_LANG=pt|en forces one.
EOF
  else cat <<'EOF'
Lançador do Ergon. Uso: ergon <comando>

  install  (antes: instalar)
      instala o Ergon numa pasta sua (~/.local/share/ergon), põe o comando "ergon" em ~/.local/bin, prepara os
      segredos, sobe o Ergon e abre o navegador; a pasta do zip pode ser apagada depois
  uninstall  (antes: remover)
      tira o Ergon do computador e GUARDA os dados (conversas, tarefas, arquivos, conexões, segredos e backups):
      instalar de novo volta de onde parou
  uninstall --purge  (antes: remover --tudo)
      tira o Ergon e APAGA os dados, os segredos e os backups (pede confirmação)
  start | stop | status  (antes: iniciar | parar | status)
      liga, desliga, mostra o estado
  up  (antes: subir)
      só liga os serviços (sem instalar nada no início da sessão): é o que o aplicativo Ergon Desktop usa
  open  (antes: abrir)
      abre http://localhost:8787
  backup
      backup completo e conferido (banco cifrado, keyring, arquivos e conexões) numa pasta em ~/.ergon/backups
      (ficam os 7 mais recentes)
  restore <pasta>  (antes: restaurar)
      confere o backup, guarda o que está no lugar (nada é apagado) e restaura
  restore --undo <pre-restore-…>  (antes: desfazer-restauracao)
      volta ao que era antes de uma restauração
  update  (antes: atualizar)
      backup + versão nova (cópia do código: git pull; pacote: baixa a versão publicada)
  clean  (antes: limpar)
      tira as imagens antigas do Ergon que nada usa (roda sozinho depois de atualizar)
  logs
      últimas linhas do Ergon e do motor
  helper  (antes: ajudante)
      (roda sozinho ao entrar no computador) guarda a chave do "destrancar sozinho" no cofre do sistema quando você
      liga o botão em Configuração › Segurança, e destranca o Ergon depois de reiniciar
  helper uninstall  (antes: ajudante remover)
      tira o ajudante do início da sessão e apaga a chave guardada
  help · version
      esta ajuda · a versão

Os nomes de antes continuam valendo. As mensagens seguem o idioma do sistema; ERGON_LANG=pt|en escolhe um.
EOF
  fi
}
# o nome novo (em inglês) de um comando; os de antes, em português, continuam aceitos para sempre
canonico() {
  case "$1" in
    install | instalar) echo install ;;
    uninstall | remove | remover) echo uninstall ;;
    start | iniciar) echo start ;;
    up | subir) echo up ;;
    stop | parar) echo stop ;;
    status) echo status ;;
    open | abrir) echo open ;;
    logs) echo logs ;;
    backup) echo backup ;;
    restore | restaurar) echo restore ;;
    undo-restore | desfazer-restauracao) echo undo-restore ;;
    update | upgrade | atualizar) echo update ;;
    clean | limpar) echo clean ;;
    helper | ajudante) echo helper ;;
    help | --help | -h | ajuda) echo help ;;
    version | --version | versao) echo version ;;
    *) return 1 ;;
  esac
}

comando() {
  local c; c="$(canonico "${1:-help}")" || { say "Comando desconhecido: ${1:-}" "Unknown command: ${1:-}"; ajuda; exit 1; }
  case "$c" in
    install) instalar_programa
      if ! mesma "$DESTINO" "$RAIZ"; then
        # continua pela cópia instalada: o registro, o ajudante e o motor de contêineres passam a usar a pasta do programa
        /bin/bash "$DESTINO/ergon.sh" install
        say "Pode apagar a pasta do zip ($RAIZ). Em um terminal novo: ergon status" "You can delete the zip folder ($RAIZ). In a new terminal: ergon status"; exit 0
      fi
      need_motor; init_secrets; registrar; up; instalar_ajudante
      [[ -n "${ERGON_NO_BROWSER:-}${ERGON_SEM_NAVEGADOR:-}" ]] || abrir ;;
    uninstall) remover "${2:-}" ;;
    start) need_motor; registrar; ligar_servicos; instalar_ajudante; wait_health 240 >/dev/null && say "No ar em $URL" "Running at $URL" || fail 'Não respondeu.' 'Did not respond.' ;;
    up) need_motor; registrar; say 'Ligando os serviços do Ergon e o motor de IA…' 'Starting the Ergon services and the AI engine…'; ligar_servicos
      wait_health 240 >/dev/null || fail 'O Ergon não respondeu. Veja: ./ergon.sh logs' 'Ergon did not respond. See: ./ergon.sh logs'; say "No ar em $URL" "Running at $URL" ;;
    stop) compose stop ;;
    status) compose ps; local h v; h="$(health)"; v="$(field version <<<"$h")"
      if [[ -z "$h" ]]; then say 'Ergon não responde.' 'Ergon is not responding.'
      elif [[ "$(field sealed <<<"$h")" == true ]]; then say "Ergon $v · trancado · $URL" "Ergon $v · locked · $URL"
      else say "Ergon $v · aberto · $URL" "Ergon $v · open · $URL"; fi ;;
    open) abrir ;;
    logs) compose logs --tail 80 ergon motores ;;
    backup) backup ;;
    restore) if [[ "${2:-}" == --undo ]]; then desfazer_restauracao "${3:-}"; else restaurar "${2:-}"; fi ;;
    undo-restore) desfazer_restauracao "${2:-}" ;;
    update) need_motor; atualizar ;;
    clean) "$MOTOR" info >/dev/null 2>&1 || fail "O $MOTOR não está respondendo: nada foi limpo." "$MOTOR is not responding: nothing was cleaned."; limpar ;;
    helper) case "${2:-}" in uninstall | remove | remover) remover_ajudante ;; install | instalar) instalar_ajudante ;; *) ajudante ;; esac ;;
    help) ajuda ;;
    version) versao ;;
  esac
}

# carregado por outro script (os testes do lançador): só as funções
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0
comando "$@"

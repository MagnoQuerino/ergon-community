#!/usr/bin/env bash
# Diagnóstico do motor de IA (bateria e desenvolvimento; nada aqui é para quem usa o Ergon). Dois modos:
#
#   diagnostico-motor.sh estado [podman|docker]
#     Só lê. Mostra o gerente de motores (GET /health direto, sem esperar "healthy": no Podman sem systemd a
#     verificação periódica nunca roda) e a imagem que ele usa para criar motores (ERGON_MOTOR_IMAGE); e, por motor,
#     a imagem em uso ao lado da configurada (DESATUALIZADO quando o ID é outro), os rótulos da renovação, a cópia do
#     plugin no cofre (com ou sem as Conexões), a marca da configuração do cofre, as ferramentas da API e as
#     capacidades do plugin (GET /ergon/v1/health). Segredo nenhum sai: das variáveis de ambiente, só os NOMES.
#
#   diagnostico-motor.sh <soquete da API> <imagem do motor> <rede>
#     Cria, pela API do motor de contêineres, um contêiner com a mesma especificação que o gerente de motores usa
#     para o motor de IA de uma pessoa (server/src/services/motor-manager.ts, motorSpec) e mostra a resposta. Serve
#     para achar o que a API recusa. Apaga o que criar.
set -u

# ------------------------------------------------------------------------------------------------- estado (só lê)
# roda dentro do motor, como o usuário dele (o cofre é um ponto FUSE desse usuário): só contagens, marcas e nomes
read -r -d '' DENTRO_DO_MOTOR <<'PY'
import json, os, urllib.request
def ler(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return None
for nome, p in (("cópia no cofre", "/opt/data/plugins/ergon_bridge/__init__.py"), ("da imagem", "/opt/ergon/plugins/ergon_bridge/__init__.py")):
    t = ler(p)
    print(f"  plugin ({nome}): " + ("ausente" if t is None else f"conexoes_executar aparece {t.count('conexoes_executar')} vez(es)"))
# a marca das migrações (.ergon-migracoes, {"versao": N}); a antiga (.ergon-config) fica "1" para as imagens de antes
m = ler("/opt/data/.ergon-migracoes")
a = ler("/opt/data/.ergon-config")
print("  marca da configuração do cofre: " + ((m.strip()[:60] or "vazia (não conta: vale a antiga)") if m is not None else ("ausente (cofre fechado ou nunca configurado)" if a is None else "só a antiga: " + a.strip()[:20]))
      + ("" if a is None or m is None else "; antiga: " + a.strip()[:20]))
try:
    import sys
    sys.path.insert(0, "/opt/hermes")
    import hermes_yaml as yaml  # o leitor de YAML do próprio Hermes (a imagem não traz o PyYAML)
    c = yaml.safe_load(open("/opt/data/config.yaml", encoding="utf-8")) or {}
    api = (c.get("platform_toolsets") or {}).get("api_server") or []
    print("  ferramentas da API: " + (", ".join(map(str, api)) or "nenhuma"))
    k = c.get("known_plugin_toolsets")
    print("  conjuntos de plugin conhecidos: " + (json.dumps(k, ensure_ascii=False) if k else "nenhum"))
except Exception as e:
    print("  ferramentas da API: não deu para ler (" + type(e).__name__ + ")")
try:
    r = urllib.request.Request("http://127.0.0.1:8643/ergon/v1/health", headers={"X-Ergon-Bridge-Token": os.environ.get("ERGON_BRIDGE_TOKEN", "")})
    h = json.loads(urllib.request.urlopen(r, timeout=5).read() or b"{}")
    campos = {k: h[k] for k in ("ok", "plugin_version", "vault_config", "capacidades", "dashboard") if k in h}
    print("  plugin /ergon/v1/health: " + json.dumps(campos, ensure_ascii=False))
    if "capacidades" not in h:
        print("  plugin sem a lista de capacidades: anterior ao contrato de versão (motor desatualizado)")
except Exception as e:
    print("  plugin /ergon/v1/health: sem resposta (" + type(e).__name__ + ")")
PY

id_puro() { local i="${1#sha256:}"; printf '%s' "${i:0:64}"; }
nomes_env() { "$M" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/=.*//p' | sort | tr '\n' ' '; }
rotulo() { local v; v="$("$M" inspect --format "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null)"; [[ "$v" == '<no value>' ]] && v=''; printf '%s' "$v"; }
# versão do plugin do Ergon gravada na imagem (rótulo ergon.plugin.version; imagens antigas não têm)
plugin_da() { local v; v="$("$M" image inspect --format '{{ index .Config.Labels "ergon.plugin.version" }}' "$1" 2>/dev/null)"; [[ "$v" == '<no value>' ]] && v=''; printf '%s' "${v:-sem marca}"; }

estado() {
  M="${1:-${ERGON_MOTOR:-podman}}"
  "$M" info >/dev/null 2>&1 || { echo "o $M não respondeu"; return 1; }
  local g conf='' conf_id='' m nome est ref uso prev motores
  g="$("$M" ps -aq --filter label=com.docker.compose.service=motores | head -1)"
  if [[ -z "$g" ]]; then echo "gerente de motores: não existe (instalação sem gerente: motor único)"
  else
    echo "gerente de motores: $("$M" inspect --format '{{.Name}} {{.State.Status}}' "$g")"
    if [[ "$("$M" inspect --format '{{.State.Running}}' "$g")" == true ]]; then
      echo "  /health: $("$M" exec "$g" node -e "fetch('http://127.0.0.1:8645/health').then(r=>r.text()).then(t=>console.log(t.slice(0,200))).catch(e=>console.log('sem resposta: '+e.message))" 2>&1 | head -1)"
    fi
    echo "  variáveis (só os nomes): $(nomes_env "$g")"
    conf="$("$M" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$g" 2>/dev/null | sed -n 's/^ERGON_MOTOR_IMAGE=//p' | head -1)"
    [[ -n "$conf" ]] && conf_id="$(id_puro "$("$M" image inspect --format '{{.Id}}' "$conf" 2>/dev/null)")"
    echo "  imagem configurada para os motores: ${conf:-?} ($([[ -n "$conf_id" ]] && echo "${conf_id:0:12}, plugin $(plugin_da "$conf_id")" || echo 'não está neste computador'))"
  fi
  motores="$("$M" ps -aq --filter label=ergon.motor)"
  [[ -n "$motores" ]] || { echo "motores de IA: nenhum ainda (cada pessoa ganha o dela ao entrar)"; return 0; }
  for m in $motores; do
    nome="$("$M" inspect --format '{{.Name}}' "$m")"; est="$("$M" inspect --format '{{.State.Status}}' "$m")"
    if [[ "$M" == podman ]]; then ref="$("$M" inspect --format '{{.ImageName}}' "$m")"; else ref="$("$M" inspect --format '{{.Config.Image}}' "$m")"; fi
    uso="$(id_puro "$("$M" inspect --format '{{.Image}}' "$m")")"
    echo "motor ${nome#/} ($est):"
    echo "  na imagem $ref (${uso:0:12}, plugin $(plugin_da "$uso")); configurada ${conf:-?} (${conf_id:0:12})"
    if [[ -n "$conf_id" && "$uso" != "$conf_id" ]]; then echo "  DESATUALIZADO: o motor roda uma imagem diferente da configurada"
    elif [[ -n "$conf_id" ]]; then echo "  em dia com a imagem configurada"; fi
    prev="$(rotulo "$m" ergon.motor.prev-image)"
    # o rótulo fica no contêiner depois da confirmação (só a imagem sai): o que diz se ainda dá para voltar é a imagem no disco
    anterior=''
    if [[ -n "$prev" ]]; then
      if "$M" image inspect "$prev" >/dev/null 2>&1; then anterior="; imagem anterior guardada ($(id_puro "$prev" | cut -c1-12): dá para voltar)"
      else anterior="; imagem anterior já apagada (troca confirmada)"; fi
    fi
    echo "  cofre: $(rotulo "$m" ergon.motor.volume)${anterior}$([[ -n "$(rotulo "$m" ergon.motor.spec)" ]] && echo '; especificação marcada' || echo '; sem a marca da especificação (criado antes da renovação)')"
    echo "  variáveis (só os nomes): $(nomes_env "$m")"
    if [[ "$est" == running ]]; then
      "$M" exec --user 10000 "$m" /opt/hermes/.venv/bin/python -c "$DENTRO_DO_MOTOR" 2>&1 | head -20
    else echo "  (parado: sem leitura do cofre)"; fi
  done
}

if [[ "${1:-}" == estado ]]; then estado "${2:-}"; exit $?; fi

# ------------------------------------------------------------- especificação do motor pela API (cria e apaga)
SOCK="$1"; IMG="$2"; REDE="$3"
api() { curl -sS --unix-socket "$SOCK" -H 'Content-Type: application/json' "$@"; }
spec() {
  cat <<EOF
{ "Image": "$IMG", "Cmd": ["gateway", "run"], "Labels": { "ergon.diagnostico": "1" },
  "HostConfig": { $1 "NetworkMode": "$REDE" } }
EOF
}
tentar() {
  local nome="ergon-diag-$1"; shift
  local r; r="$(api -X POST "http://d/v1.41/containers/create?name=$nome" -d "$(spec "$*")")"
  echo "[$nome] $r"
  api -X DELETE "http://d/v1.41/containers/$nome?force=true" > /dev/null 2>&1
}
api -X POST "http://d/v1.41/volumes/create" -d '{"Name":"ergon-diag-vol"}' > /dev/null
tentar base ''
tentar mounts '"Mounts": [{ "Type": "volume", "Source": "ergon-diag-vol", "Target": "/vault" }],'
tentar tmpfs '"Tmpfs": { "/opt/data": "mode=0700,uid=10000,gid=10000" },'
tentar fuse '"Devices": [{ "PathOnHost": "/dev/fuse", "PathInContainer": "/dev/fuse", "CgroupPermissions": "rwm" }],'
tentar caps '"CapAdd": ["SYS_ADMIN"], "CapDrop": ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SETFCAP"],'
tentar secopt '"SecurityOpt": ["apparmor:unconfined", "no-new-privileges:true"],'
tentar limites '"Memory": 2147483648, "NanoCpus": 2000000000,'
tentar restart '"RestartPolicy": { "Name": "unless-stopped" },'
tentar log '"LogConfig": { "Type": "json-file", "Config": { "max-size": "10m", "max-file": "3" } },'
api -X DELETE "http://d/v1.41/volumes/ergon-diag-vol" > /dev/null 2>&1
true

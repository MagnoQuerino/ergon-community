#!/usr/bin/env bash
# Diagnóstico da bateria: cria, pela API do motor de contêineres, um contêiner com a mesma especificação que o gerente
# de motores usa para o motor de IA de uma pessoa (server/src/services/motor-manager.ts, motorSpec) e mostra a resposta.
# Serve para achar o que a API recusa. Apaga o que criar.
#   diagnostico-motor.sh <soquete da API> <imagem do motor> <rede>
set -u
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

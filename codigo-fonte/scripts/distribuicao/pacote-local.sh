#!/usr/bin/env bash
# Pacote local de uma versão, igual ao ergon-local-<versão>.zip da página de versões: o lançador e o compose deste
# código, com as imagens publicadas daquela versão (nada é compilado na máquina de quem instala).
#   pacote-local.sh <versão> <dono das imagens (minúsculas)> <dono/repositório> <saída.zip (caminho absoluto)>
set -euo pipefail
V="$1"; DONO="$2"; REPO="$3"; SAIDA="$4"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
sed -e "s/__VERSAO__/$V/g" -e "s/__DONO__/$DONO/g" -e "s#__REPO__#$REPO#g" deploy/local/docker-compose.yml > "$d/docker-compose.yml"
if grep -q '__[A-Z]*__' "$d/docker-compose.yml"; then echo "compose com marcadores sobrando" >&2; exit 1; fi
cp ergon.ps1 ergon.cmd ergon.sh "$d/" && chmod +x "$d/ergon.sh"
# o guia de instalação: docs/ no repositório de desenvolvimento; ../docs/ no público (código em codigo-fonte/)
if [[ -f docs/INSTALAR.md ]]; then cp docs/INSTALAR.md "$d/LEIA-ME.md"; else cp ../docs/INSTALAR.md "$d/LEIA-ME.md"; fi
echo "$V" > "$d/VERSAO"
rm -f "$SAIDA"; (cd "$d" && zip -qr "$SAIDA" .)
echo "pacote local $V: $SAIDA"

#!/usr/bin/env bash
# Instalação num sistema LIMPO: contêiner novo da distribuição (ubuntu:22.04, ubuntu:24.04, debian:12), sem nada do
# Ergon nem do WebKitGTK antes. Modo "deb": o apt instala o pacote como uma pessoa faria (sudo apt install ./Ergon.deb,
# com as recomendações, que é o padrão do apt), o aplicativo abre e diz o que falta, a remoção leva os arquivos dele.
# Modo "appimage": o AppImage roda sem instalar nada (extraído na hora: o contêiner não tem FUSE).
# Entradas: /pkg (pacotes da CI); saída: /out/<distro>-<modo>.   Uso: bash testar-limpo.sh deb|appimage
set -uo pipefail
MODO="${1:?deb|appimage}"
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
O="/out/${ID}-${VERSION_ID}-${MODO}"; mkdir -p "$O"
R=0
ok() { echo "ok   $1 — $2"; }
falha() { echo "FALHA $1 — $2"; R=1; }
echo "--- ${PRETTY_NAME} (${MODO})"
apt-get update -qq > /dev/null

if [[ "$MODO" == deb ]]; then
  antes="$(dpkg-query -W -f '${Package}\n' | sort)"
  if apt-get install -y /pkg/*.deb > "$O/apt-install.log" 2>&1; then
    novos="$(comm -13 <(echo "$antes") <(dpkg-query -W -f '${Package}\n' | sort))"
    ok ".deb instalado pelo apt" "ergon $(dpkg-query -W -f '${Version}' ergon), $(echo "$novos" | wc -l) pacotes novos (dependências incluídas)"
    echo "$novos" > "$O/pacotes-novos.txt"
    docker_veio="$(echo "$novos" | grep -E '^(docker\.io|docker-ce|containerd|runc)$' | tr '\n' ' ')"
    [[ -z "$docker_veio" ]] && ok "o Docker não vem junto" "nenhum pacote do Docker instalado" \
      || falha "o Docker não vem junto" "o apt instalou: $docker_veio"
  else
    falha ".deb instalado pelo apt" "$(tail -3 "$O/apt-install.log")"; exit 1
  fi
  dpkg -L ergon > "$O/arquivos.txt"
  [[ -x /usr/bin/ergon-desktop ]] && ok "programa no lugar" "/usr/bin/ergon-desktop" || falha "programa no lugar" "não há /usr/bin/ergon-desktop"
  DESK="$(ls /usr/share/applications/*.desktop 2>/dev/null | grep -i ergon | head -1)"
  [[ -n "$DESK" ]] && ok "atalho no menu" "$DESK ($(grep -E '^(Name|Exec|Icon)=' "$DESK" | tr '\n' ' '))" || falha "atalho no menu" "sem .desktop"
  ICONES="$(grep -c '/usr/share/icons/hicolor/.*\.png$' "$O/arquivos.txt")"
  [[ "$ICONES" -gt 0 ]] && ok "ícones" "$ICONES tamanhos em hicolor" || falha "ícones" "nenhum"
  APP=/usr/bin/ergon-desktop
else
  APPIMAGE="$(ls /pkg/*.AppImage | head -1)"
  cp "$APPIMAGE" /tmp/Ergon.AppImage && chmod +x /tmp/Ergon.AppImage
  # o AppImage leva o WebKitGTK e o GTK, mas usa do sistema as bibliotecas gráficas (Mesa, X11/Wayland, fontes), que
  # qualquer desktop tem: a imagem da distribuição não tem desktop, então entra só essa base (GTK3 + Mesa), sem WebKitGTK
  (cd /tmp && ./Ergon.AppImage --appimage-extract > /dev/null 2>&1)
  faltam() { LD_LIBRARY_PATH=/tmp/squashfs-root/usr/lib ldd /tmp/squashfs-root/usr/bin/ergon-desktop | grep 'not found' | awk '{print $1}' | sort -u | tr '\n' ' '; }
  echo "     sem desktop, faltariam: $(faltam)"
  apt-get install -y -qq --no-install-recommends libgtk-3-0t64 libgl1 libegl1 libgles2 libgbm1 > "$O/apt-base-desktop.log" 2>&1 \
    || apt-get install -y -qq --no-install-recommends libgtk-3-0 libgl1 libegl1 libgles2 libgbm1 >> "$O/apt-base-desktop.log" 2>&1
  f="$(faltam)"; [[ -z "$f" ]] && ok "roda sobre a base de um desktop (GTK3 + Mesa com GLES, sem WebKitGTK do sistema)" "nenhuma biblioteca faltando" \
    || falha "roda sobre a base de um desktop" "ainda faltam: $f"
  rm -rf /tmp/squashfs-root
  export APPIMAGE_EXTRACT_AND_RUN=1
  APP=/tmp/Ergon.AppImage
fi

# só agora o que o teste precisa para ver a tela (tela virtual e captura): não entra na conta do que o pacote pediu
apt-get install -y -qq --no-install-recommends xvfb xauth imagemagick dbus-x11 desktop-file-utils procps > "$O/apt-teste.log" 2>&1
[[ "$MODO" == deb && -n "${DESK:-}" ]] && { desktop-file-validate "$DESK" > "$O/desktop-file-validate.txt" 2>&1 \
  && ok "atalho válido (desktop-file-validate)" "sem avisos" || falha "atalho válido (desktop-file-validate)" "$(head -3 "$O/desktop-file-validate.txt" | tr '\n' ' ')"; }

export DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1
Xvfb :99 -screen 0 1366x860x24 > /dev/null 2>&1 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
"$APP" > "$O/app.log" 2>&1 &
sleep 15
import -window root "$O/janela.png" 2> /dev/null
REG="$HOME/.local/share/io.github.magnoquerino.ergon/logs/ergon-desktop.log"
if pgrep -f 'ergon-desktop' > /dev/null; then
  diag="$(grep -o 'diagnóstico: .*' "$REG" 2> /dev/null | tail -1)"
  [[ "$diag" == *docker_ausente* ]] && ok "abre e diz o que falta" "$diag" || falha "abre e diz o que falta" "${diag:-sem diagnóstico no registro} (app.log: $(tail -2 "$O/app.log" | tr '\n' ' '))"
else
  falha "abre e diz o que falta" "o aplicativo não ficou aberto: $(tail -5 "$O/app.log" | tr '\n' ' ')"
fi
pkill -f ergon-desktop; sleep 1
cp "$REG" "$O/" 2> /dev/null

if [[ "$MODO" == deb ]]; then
  apt-get remove -y ergon > "$O/apt-remove.log" 2>&1
  sobrou="$(grep -E '^/usr/(bin|share/applications)/' "$O/arquivos.txt" | while read -r f; do [[ -e "$f" ]] && echo "$f"; done)"
  [[ -z "$sobrou" && ! -x /usr/bin/ergon-desktop ]] && ok "remover leva o aplicativo" "programa e atalho removidos" || falha "remover leva o aplicativo" "sobrou: $sobrou"
fi
exit $R

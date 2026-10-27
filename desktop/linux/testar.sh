#!/usr/bin/env bash
# Testes do Ergon Desktop no Linux, dentro do contêiner ergon-desktop-teste, que divide a rede (localhost) com um
# Ergon DESCARTÁVEL. Instala o .deb de verdade, roda sob Xvfb com um gerenciador de janelas e dirige o app pelo
# WebDriver do WebKitGTK. Entradas: /pkg (pacotes), /testes (roteiros); saída: /out.
set -uo pipefail
mkdir -p /out
dpkg -i /pkg/*.deb > /out/instalacao-deb.log 2>&1 || { apt-get install -f -y >> /out/instalacao-deb.log 2>&1; }
echo "instalado: $(dpkg -s ergon 2>/dev/null | sed -n 's/^Version: //p') em $(command -v ergon-desktop)"
ls /usr/share/applications/ | grep -i ergon && grep -E '^(Name|Exec|Icon|Categories)=' /usr/share/applications/*rgon*.desktop

export DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1
Xvfb :99 -screen 0 1366x860x24 >/dev/null 2>&1 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
openbox >/dev/null 2>&1 &
sleep 1

# 1) sem override e sem Docker no contêiner: a tela de abertura explica o que falta
ergon-desktop > /out/sem-docker.log 2>&1 &
APP=$!; sleep 8
import -window root /out/linux-1-sem-docker.png
kill $APP 2>/dev/null; wait $APP 2>/dev/null

# 2) instância de teste: a bateria inteira pelo WebDriver
node /testes/preparar-conta.mjs http://localhost:8787 /out/conta.json || exit 1
export ERGON_DESKTOP_URL=http://localhost:8787 ERGON_DESKTOP_SEM_NAVEGADOR=1
tauri-driver --port 4444 > /out/tauri-driver.log 2>&1 &
DRV=$!; sleep 2
node /testes/autenticacao.mjs --driver webdriver --webdriver http://127.0.0.1:4444 --app /usr/bin/ergon-desktop \
  --ergon http://localhost:8787 --conta /out/conta.json --saida /out/testes \
  --downloads "$HOME/.local/share/io.github.magnoquerino.ergon/downloads-teste" --registro "$HOME/.local/share/io.github.magnoquerino.ergon/logs"
R=$?
kill $DRV 2>/dev/null

# 3) a janela com moldura, aberta no Ergon (sessão nova, tela de login)
ergon-desktop > /out/janela.log 2>&1 &
APP=$!; sleep 10
import -window root /out/linux-2-janela.png
kill $APP 2>/dev/null
cp "$HOME"/.local/share/io.github.magnoquerino.ergon/logs/*.log /out/ 2>/dev/null
rm -f /out/conta.json
exit $R

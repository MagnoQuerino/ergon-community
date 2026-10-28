#!/usr/bin/env bash
# Estados do Docker no Linux e o "Iniciar Ergon" de ponta a ponta, dentro do contêiner ergon-desktop-teste, com o .deb
# instalado de verdade. O Docker é o do computador de teste (socket em /sock/docker.sock), num projeto ISOLADO
# (ergon-desktop-teste, porta 18792, volume próprio): nunca a instalação real. Entradas: /pkg (pacotes), /testes
# (roteiros), /lancador/ergon.sh; saída: /out. Quem orquestra desmonta o projeto no fim (docker compose down -v).
set -uo pipefail
mkdir -p /out/docker
dpkg -i /pkg/*.deb > /out/docker/instalacao-deb.log 2>&1 || apt-get install -f -y >> /out/docker/instalacao-deb.log 2>&1

export DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1
Xvfb :99 -ac -screen 0 1366x860x24 >/dev/null 2>&1 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
openbox >/dev/null 2>&1 &
sleep 1

# a instalação de teste: lançador de verdade, compose de teste, registro num arquivo à parte (ERGON_INSTALACAO)
RAIZ=/opt/ergon-teste
mkdir -p "$RAIZ" /tmp/ergon-teste
cp /lancador/ergon.sh "$RAIZ/" && chmod 755 "$RAIZ/ergon.sh"
cat > "$RAIZ/docker-compose.yml" <<'EOF'
# Instalação de TESTE do Ergon Desktop: outro projeto, outra porta, outro volume. Nunca toca na instalação real.
name: ergon-desktop-teste
services:
  ergon:
    image: ergon:dev
    ports:
      - "127.0.0.1:${ERGON_PORT:-18792}:8787"
    environment:
      ERGON_EXECUTOR: simulated
      ERGON_MODE: local
      ERGON_PUBLIC_URL: http://localhost:18792
      ERGON_ALLOWED_ORIGINS: http://localhost:18792
      ERGON_KDF: test
    volumes:
      - dados:/data
volumes:
  dados: {}
EOF
echo 'ERGON_PORT=18792' > "$RAIZ/.env"
export ERGON_INSTALACAO=/tmp/ergon-teste/instalacao.json
printf '{"raiz":"%s","porta":18792}\n' "$RAIZ" > "$ERGON_INSTALACAO"
chmod 755 /tmp/ergon-teste && chmod 644 "$ERGON_INSTALACAO"

# o Docker publica a porta no computador de teste; aqui dentro, uma ponte leva 127.0.0.1:18792 até lá
cat > /tmp/ponte.mjs <<'EOF'
import net from 'node:net';
net.createServer((c) => { const s = net.connect(18792, 'host.docker.internal'); c.pipe(s).pipe(c); s.on('error', () => c.destroy()); c.on('error', () => s.destroy()); }).listen(18792, '127.0.0.1');
EOF
node /tmp/ponte.mjs &

estado() { # $1 driver, $2 prefixo
  sozinho  # nenhuma janela de um passo anterior aberta (a instância única passaria o pedido para ela)
  node /testes/iniciar.mjs --driver webdriver --webdriver "$1" --app /usr/bin/ergon-desktop --ergon http://localhost:18792 --saida /out/docker --so-estado 1 --prefixo "$2" > "/out/docker/$2.log" 2>&1; tail -1 "/out/docker/$2.log"
}
R=0
# o WebDriver fecha a janela no fim de cada sessão; se o processo ficar, registra e encerra antes do próximo passo
sozinho() { local p; p="$(pgrep -x ergon-desktop || true)"; [[ -n "$p" ]] && { echo "  (processo do passo anterior ainda vivo: $p; encerrado)" >&2; pkill -x ergon-desktop; sleep 1; }; true; }
confere() { # $1 nome, $2 esperado (trecho), $3 obtido
  if [[ "$3" == *"$2"* ]]; then echo "ok   $1 — $3"; else echo "FALHA $1 — esperava \"$2\", veio: $3"; R=1; fi
}

tauri-driver --port 4444 > /out/docker/tauri-driver.log 2>&1 &
DRV=$!; sleep 2

# 1) Docker não instalado (o programa "docker" não existe)
mv /usr/bin/docker /usr/bin/docker.oculto
confere "Docker não instalado" "O Docker não está instalado" "$(estado http://127.0.0.1:4444 linux-docker-1-ausente-)"
mv /usr/bin/docker.oculto /usr/bin/docker

# 2) Docker instalado, serviço parado (não há socket)
confere "serviço do Docker parado" "O serviço do Docker está parado" "$(estado http://127.0.0.1:4444 linux-docker-2-parado-)"

# 3) sem permissão: um usuário comum, fora do grupo do socket; o aplicativo explica e não muda grupos
ln -sf /sock/docker.sock /var/run/docker.sock
antes="$(id pessoa)"
runuser -u pessoa -- env DISPLAY=:99 ERGON_INSTALACAO="$ERGON_INSTALACAO" WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 \
  HOME=/home/pessoa tauri-driver --port 4446 --native-port 4447 > /out/docker/tauri-driver-pessoa.log 2>&1 &
DRV2=$!; sleep 2
confere "sem permissão no Docker" "Sem acesso ao Docker" "$(estado http://127.0.0.1:4446 linux-docker-3-sem-permissao-)"
kill $DRV2 2>/dev/null; wait $DRV2 2>/dev/null
depois="$(id pessoa)"
confere "grupos do usuário intactos" "$antes" "$depois"

# 4) com acesso ao Docker: "Iniciar Ergon" roda o lançador (ergon.sh subir) e a janela abre o Ergon
sozinho
r="$(node /testes/iniciar.mjs --driver webdriver --webdriver http://127.0.0.1:4444 --app /usr/bin/ergon-desktop --ergon http://localhost:18792 --saida /out/docker --prefixo linux-docker-4- 2>&1 | tee /out/docker/iniciar.log | tail -1)"
confere "Iniciar Ergon (ponta a ponta)" "ok: iniciou e abriu" "$r"
grep -E "^(fases|linhas)" /out/docker/iniciar.log

# 5) fechar a janela (pelo gerenciador de janelas, como uma pessoa) encerra o aplicativo e os serviços seguem; ao
#    reabrir, vai direto ao Ergon
W="$(xdotool search --onlyvisible --name '^Ergon$' | head -1)"
[[ -n "$W" ]] && { xdotool windowactivate --sync "$W" key --clearmodifiers alt+F4; sleep 3; }
confere "fechar a janela encerra o aplicativo" "encerrado" "$(pgrep -x ergon-desktop >/dev/null && echo "ainda rodando (janela: ${W:-nenhuma})" || echo encerrado)"
sozinho
confere "serviço segue com a janela fechada" "running" "$(docker ps --filter label=com.docker.compose.project=ergon-desktop-teste --format '{{.State}}')"
confere "reabrir vai direto ao Ergon" "ok: abriu http://localhost:18792 sozinho" "$(estado http://127.0.0.1:4444 linux-docker-5-reaberto-)"

# 6) parar pelo lançador: a abertura volta a dizer "desligado"
"$RAIZ/ergon.sh" parar > /out/docker/parar.log 2>&1
confere "desligado depois de parar" "O Ergon está desligado" "$(estado http://127.0.0.1:4444 linux-docker-6-parado-)"

kill $DRV 2>/dev/null
cp "$HOME"/.local/share/io.github.magnoquerino.ergon/logs/*.log /out/docker/ 2>/dev/null
cp "$ERGON_INSTALACAO" /out/docker/instalacao-registrada.json
exit $R

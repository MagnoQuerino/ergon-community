"""Navegador ao vivo com "Assumir o controle" (rc.41), com o laço de verdade do motor, o agent-browser e o Chromium da
imagem, um modelo falso e um Ergon simulado (sem rede, HERMES_HOME descartável).

O navegador do motor tem duas formas, e o teste roda nas duas (a segunda num processo novo, NAV_MODO=classico), com a
configuração que o próprio plugin monta para o perfil do agente (_config_do_perfil):
- agente com navegador E Terminal: a forma padrão do Hermes 0.22 (browser_exec, que roda código no Chromium do
  agent-browser e por isso só é entregue a quem tem o Terminal);
- agente só com navegador: as ferramentas browser_* de sempre (o plugin grava browser.backend: off no perfil dele; sem
  isso ele ficava sem navegador nenhum).

Confere, dentro da imagem do motor:
- o agente abre uma página: o Ergon é avisado de que há navegador naquele trabalho; a ponte de controle
  diz o estado e abre a transmissão (quadros JPEG do viewport) só com o token; sem token, 401; sessão desconhecida, 404;
- a pessoa assume: a ferramenta do navegador que o agente chama ESPERA (não age nem lê); a pessoa digita usuário e senha
  pela transmissão e entra; devolve: a ferramenta que esperava é recusada com o pedido de reler a página, e o
  browser_snapshot seguinte mostra a página já logada;
- a senha que a pessoa digitou não aparece em NENHUMA mensagem que foi ao modelo, em nenhum pedido ao Ergon, em nenhum
  registro e em nenhum arquivo do motor;
- o que a pessoa deixou digitado e não enviou (senha, e também um código num campo de texto comum) é apagado na
  devolução, e o que a página já trazia fica (o agente não lê depois o que ela digitou);
- a pessoa que não devolve: a ferramenta desiste de esperar com o aviso certo; o prazo acaba: o controle volta sozinho,
  o Ergon é avisado e o agente recebe o aviso do prazo;
- enquanto a pessoa está no controle, o navegador não é fechado por estar "parado" (a atividade é tocada);
- fim do turno: o navegador fecha, o registro some e o Ergon é avisado.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_navegador.py
"""
import base64
import io
import json
import logging
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODO = os.environ.get("NAV_MODO", "exec")
os.environ.setdefault("NAV_HOME_ORIGINAL", os.environ.get("HERMES_HOME", "/tmp/h"))
HOME = os.environ["NAV_HOME_ORIGINAL"] + ("-classico" if MODO == "classico" else "")
os.environ["HERMES_HOME"] = HOME
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
TOKEN = "token-da-ponte-de-teste-0123456789"
# a senha de teste, montada por partes (nenhum arquivo do repositório traz um segredo inteiro)
SENHA = "".join(["s3nh", "@-", "Secr", "eta", "-77"])
CODIGO = "".join(["77", "88", "99", "-cod"])   # um código de verificação, digitado num campo de texto comum
ESTADO = f"/tmp/ergon-navegador-teste-{MODO}"
shutil.rmtree(ESTADO, ignore_errors=True)


def porta_livre():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORTA_CONTROLE = porta_livre()
os.environ.update({"HERMES_PLATFORM": "api_server", "ERGON_BRIDGE_TOKEN": TOKEN, "ERGON_CONTROL_PORT": str(PORTA_CONTROLE),
                   "ERGON_NAVEGADOR_DIR": ESTADO, "ERGON_NAVEGADOR_ESPERA_S": "6", "ERGON_NAVEGADOR_PASSO_S": "0.2",
                   "ERGON_NAVEGADOR_VIGIA_S": "0.5", "TERMINAL_ENV": "local"})
sys.path.insert(0, "/opt/hermes")

registros = io.StringIO()
_h = logging.StreamHandler(registros)
_h.setLevel(logging.DEBUG)
logging.getLogger().addHandler(_h)
logging.getLogger().setLevel(logging.DEBUG)

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""), flush=True)
    ok = ok and bool(cond)


def servir(Handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


class Base(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def responder(self, obj, status=200, tipo="application/json"):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def corpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")


def ponte(metodo, caminho, corpo=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{PORTA_CONTROLE}{caminho}", method=metodo, data=None if corpo is None else json.dumps(corpo).encode(),
                                 headers={"Content-Type": "application/json", **({"X-Ergon-Bridge-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


# ---------- a página de teste: um formulário de login que só mostra o pedido depois de entrar
PAGINA = ("""<!doctype html><html><head><meta charset="utf-8"><title>Entrar - Loja Teste</title>
<style>body{font:16px sans-serif;margin:0;padding:40px}input{display:block;width:300px;height:40px;margin:0 0 20px;font-size:16px}button{width:120px;height:40px}</style></head><body>
<h1 id="titulo">Loja Teste</h1>
<input id="pre" aria-label="Loja" value="mantido"><form id="f"><input id="u" name="u" aria-label="Usuário" autocomplete="off"><input id="p" name="p" type="password" aria-label="Senha"><button id="entrar" type="submit">Entrar</button></form>
<div id="ok" hidden><h2>Bem-vinda, <span id="quem"></span>!</h2><p>Pedido 4471: entregue.</p></div>
<script>document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var u=document.getElementById('u').value,p=document.getElementById('p').value;
if(u==='ana'&&p==='__SENHA__'){document.getElementById('f').remove();document.getElementById('quem').textContent=u;document.getElementById('ok').hidden=false;document.title='Minha conta';}
else{document.getElementById('titulo').textContent='Senha incorreta';}});</script></body></html>""").replace("__SENHA__", SENHA).encode()


class Site(Base):
    def do_GET(self):
        return self.responder(PAGINA, tipo="text/html; charset=utf-8")


URL_SITE = f"http://127.0.0.1:{servir(Site)}/entrar"

# ---------- Ergon simulado: a política do agente e os avisos do navegador
pedidos = []
# o browser_exec roda código no computador do motor: o Hermes só o entrega a quem também tem o Terminal (model_tools.py,
# _rewrite_browser_exec); as ferramentas browser_* não pedem isso
CONJUNTOS = ["todo", "browser"] + ([] if MODO == "classico" else ["terminal"])
policy = {"known": True, "agent": "Aspásia", "toolsets": CONJUNTOS, "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        if self.path.endswith("/tool-policy"):
            return self.responder(policy)
        pedidos.append({"path": self.path, "token": self.headers.get("X-Ergon-Bridge-Token"), "body": b})
        return self.responder({"ok": True})


os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{servir(Ergon)}/internal/bridge/v1/events"

# ---------- modelo falso: cada passo do roteiro é uma mensagem ou uma função que a devolve (roda na hora da chamada)
chamadas = []
roteiro = []


def fala(texto):
    return {"role": "assistant", "content": texto}


def ferramenta(nome, args):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{len(chamadas)}_{nome}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        chamadas.append(b)
        m = roteiro.pop(0) if roteiro else fala("Pronto.")
        if callable(m):
            m = m()
        if b.get("stream"):
            return self.transmitir(b, m)
        return self.responder({"id": "x", "object": "chat.completion", "created": 1, "model": b.get("model", "teste"),
                               "choices": [{"index": 0, "finish_reason": "tool_calls" if m.get("tool_calls") else "stop", "message": m}],
                               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    def transmitir(self, b, m):
        def pedaco(delta, fim=None):
            return "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "created": 1, "model": b.get("model", "teste"), "choices": [{"index": 0, "delta": delta, "finish_reason": fim}]}) + "\n\n"
        partes = [pedaco({"role": "assistant"})]
        if m.get("content"):
            partes.append(pedaco({"content": m["content"]}))
        for i, t in enumerate(m.get("tool_calls") or []):
            partes.append(pedaco({"tool_calls": [{"index": i, "id": t["id"], "type": "function", "function": {"name": t["function"]["name"], "arguments": t["function"]["arguments"]}}]}))
        partes.append(pedaco({}, "tool_calls" if m.get("tool_calls") else "stop"))
        partes.append("data: [DONE]\n\n")
        data = "".join(partes).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        return self.responder({"object": "list", "data": [{"id": "modelo-falso", "object": "model", "context_length": 200000}]})


URL_MODELO = f"http://127.0.0.1:{servir(Modelo)}/v1"
# a configuração é a que o plugin monta para o perfil de um agente com estas ferramentas (a da equipe com o do agente por cima)
import importlib.util  # noqa: E402
import yaml  # noqa: E402

_spec = importlib.util.spec_from_file_location("ergon_bridge_solto", os.path.join(HOME, "plugins", "ergon_bridge", "__init__.py"))
solto = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(solto)
DA_EQUIPE = {"plugins": {"enabled": ["ergon_bridge"]}, "platform_toolsets": {"api_server": ["todo", "browser", "terminal"]},
             "known_plugin_toolsets": {"api_server": ["ergon_conexoes", "ergon_cartoes"]}, "tools": {"tool_search": {"enabled": "off"}},
             "agent": {"max_turns": 30}, "model": {"provider": "custom", "base_url": URL_MODELO, "default": "modelo-falso", "api_key": "chave-falsa"}}
pedido = {"ferramentas": list(CONJUNTOS), "memoria": False, "busca": False, "ajudantes": {"ligado": False}}
DO_PERFIL = solto._config_do_perfil(DA_EQUIPE, pedido)
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    yaml.safe_dump(DO_PERFIL, f, sort_keys=False, allow_unicode=True)
if MODO == "classico":
    check("agente só com navegador: o perfil dele pede as ferramentas browser_* (browser.backend: off)", (DO_PERFIL.get("browser") or {}).get("backend") == "off"
          and "terminal" not in DO_PERFIL["platform_toolsets"]["api_server"], str(DO_PERFIL.get("browser")))
else:
    check("agente com navegador e Terminal: o navegador fica como a equipe está (browser_exec)", "backend" not in (DO_PERFIL.get("browser") or {})
          and "terminal" in DO_PERFIL["platform_toolsets"]["api_server"], str(DO_PERFIL.get("browser")))
    escolha = solto._config_do_perfil({**DA_EQUIPE, "browser": {"backend": "off", "engine": "auto"}}, pedido)
    check("com Terminal, o que a equipe já tinha escolhido para o navegador não muda", escolha["browser"] == {"backend": "off", "engine": "auto"}, str(escolha.get("browser")))
    sem = solto._config_do_perfil({**DA_EQUIPE, "browser": {"engine": "auto"}}, {**pedido, "ferramentas": ["todo", "browser"]})
    check("sem Terminal, o resto da configuração do navegador fica", sem["browser"] == {"engine": "auto", "backend": "off"}, str(sem.get("browser")))
    nenhum = solto._config_do_perfil(DA_EQUIPE, {**pedido, "ferramentas": ["todo"]})
    check("agente sem navegador: nada muda", "browser" not in nenhum)
    a, b_ = solto._carimbo_do_perfil(solto.Path(HOME), pedido), None
    solto._PERFIL_GERACAO += 1
    b_ = solto._carimbo_do_perfil(solto.Path(HOME), pedido)
    solto._PERFIL_GERACAO -= 1
    check("perfis que já existem são refeitos sozinhos: a forma de montar entra no carimbo do perfil", solto._PERFIL_GERACAO >= 2 and a != b_)
    # migração, como na partida do motor depois de atualizar: um perfil gravado pela versão de antes (sem o backend, com
    # o carimbo da forma anterior) é refeito sem o Ergon mandar nada
    NOME = "erg-" + "ab12" * 5
    corpo = {"alma": "Você é a Aspásia.", "ferramentas": ["todo", "browser"], "memoria": False, "busca": False, "ajudantes": {"ligado": False}}
    try:
        solto.perfil_garantir(NOME, corpo)
        dperfil = solto._perfil_dir(NOME)
        estado_p = json.loads((dperfil / solto._PERFIL_ESTADO).read_text(encoding="utf-8"))
        antigo = yaml.safe_load((dperfil / "config.yaml").read_text(encoding="utf-8"))
        novo_ok = (antigo.get("browser") or {}).get("backend") == "off"
        antigo.pop("browser", None)
        (dperfil / "config.yaml").write_text(yaml.safe_dump(antigo, sort_keys=False), encoding="utf-8")
        solto._PERFIL_GERACAO -= 1
        estado_p["carimbo"] = solto._carimbo_do_perfil(solto._raiz(), estado_p["pedido"])
        solto._PERFIL_GERACAO += 1
        (dperfil / solto._PERFIL_ESTADO).write_text(json.dumps(estado_p), encoding="utf-8")
        solto._perfis_vistos["sinal"] = ""
        refeitos = solto._perfis_acompanhar()
        depois_p = yaml.safe_load((dperfil / "config.yaml").read_text(encoding="utf-8"))
        check("perfil novo de agente só com navegador: nasce com browser.backend off", novo_ok)
        check("perfil que já existia: refeito sozinho na partida, agora com as ferramentas browser_*", refeitos == 1 and (depois_p.get("browser") or {}).get("backend") == "off"
              and solto._perfis_acompanhar() == 0, f"{refeitos} {depois_p.get('browser')}")
        shutil.rmtree(dperfil, ignore_errors=True)
    except Exception as exc:  # noqa: BLE001
        check("migração dos perfis que já existem", False, repr(exc))

# ---------- o motor de verdade
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
from run_agent import AIAgent  # noqa: E402
from gateway.session_context import set_session_vars  # noqa: E402
from tools import browser_tool as bt  # noqa: E402

bridge = sys.modules.get("hermes_plugins.ergon_bridge") or next((m for n, m in sys.modules.items() if n.endswith("ergon_bridge") and hasattr(m, "navegador")), None)
check("o plugin carregou no motor, com o navegador ao vivo", bridge is not None and "navegador" in bridge.CAPACIDADES)
nav = bridge.navegador


def rodar(sessao, texto):
    """Como a API do motor: a sessão da execução fica no contexto (gateway/platforms/api_server_runs.py)."""
    set_session_vars(platform="api_server", chat_id=sessao, session_key=f"run_{sessao}", session_id=sessao)
    ag = AIAgent(base_url=URL_MODELO, api_key="chave-falsa", provider="custom", model="modelo-falso", max_iterations=20, quiet_mode=True,
                 enabled_toolsets=list(CONJUNTOS), session_id=sessao, platform="api_server", skip_memory=True, skip_context_files=True)
    return ag.run_conversation(texto, task_id=sessao)


def resultados():
    """O que cada ferramenta devolveu ao modelo, na ordem (as mensagens de ferramenta da última chamada)."""
    msgs = [m for m in chamadas[-1].get("messages", []) if m.get("role") == "tool"] if chamadas else []
    return [str(m.get("content")) for m in msgs]


# ---------- cliente WebSocket mínimo (a ponta do Ergon): aperto de mão com o token, quadros de texto nos dois sentidos
class Fluxo:
    def __init__(self, sessao, token=TOKEN):
        self.s = socket.create_connection(("127.0.0.1", PORTA_CONTROLE), timeout=10)
        chave = base64.b64encode(os.urandom(16)).decode()
        cab = f"GET /ergon/v1/navegador/fluxo?sessao={sessao} HTTP/1.1\r\nHost: motor\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {chave}\r\nSec-WebSocket-Version: 13\r\n"
        if token:
            cab += f"X-Ergon-Bridge-Token: {token}\r\n"
        self.s.sendall((cab + "\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            d = self.s.recv(4096)
            if not d:
                break
            self.buf += d
        topo, _, self.buf = self.buf.partition(b"\r\n\r\n")
        self.status = int(topo.split(b" ")[1]) if topo else 0

    def _ler(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def receber(self):
        """A próxima mensagem de texto (JSON), juntando os pedaços."""
        dados = b""
        while True:
            b1, b2 = self._ler(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._ler(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._ler(8))[0]
            parte = self._ler(n)
            if b1 & 0x0F in (0x1, 0x0):
                dados += parte
                if b1 & 0x80:
                    return json.loads(dados.decode())
            elif b1 & 0x0F == 0x8:
                raise EOFError

    def quadro(self, prazo=10):
        fim = time.time() + prazo
        while time.time() < fim:
            m = self.receber()
            if m.get("type") == "frame":
                return m
        return None

    def enviar(self, obj):
        dados = json.dumps(obj).encode()
        mascara = os.urandom(4)
        n = len(dados)
        topo = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(topo + mascara + bytes(b ^ mascara[i % 4] for i, b in enumerate(dados)))

    def clicar(self, x, y):
        for tipo, extra in (("mouseMoved", {}), ("mousePressed", {"button": "left", "clickCount": 1}), ("mouseReleased", {"button": "left", "clickCount": 1})):
            self.enviar({"type": "input_mouse", "eventType": tipo, "x": x, "y": y, **extra})
        time.sleep(0.3)

    def digitar(self, texto):
        for c in texto:
            self.enviar({"type": "input_keyboard", "eventType": "keyDown", "key": c, "code": "", "text": c, "windowsVirtualKeyCode": 0, "modifiers": 0})
            self.enviar({"type": "input_keyboard", "eventType": "keyUp", "key": c, "code": "", "text": "", "windowsVirtualKeyCode": 0, "modifiers": 0})
        time.sleep(0.3)

    def fechar(self):
        try:
            self.s.close()
        except OSError:
            pass


def avisos(evento):
    return [p["body"] for p in pedidos if p["path"].endswith("/navegador") and p["body"].get("evento") == evento]


def esperar(cond, prazo=10):
    fim = time.time() + prazo
    while time.time() < fim:
        if cond():
            return True
        time.sleep(0.1)
    return False


# campos do formulário (página sem margem: 40 px de borda; o título ocupa a primeira faixa): mede pelo próprio navegador
def caixa(seletor, sessao):
    reg = nav.registro(sessao)
    r = nav._cli(reg, ["get", "box", seletor]) or {}
    d = r.get("data") or {}
    return d.get("x", 0) + d.get("width", 0) / 2, d.get("y", 0) + d.get("height", 0) / 2


# ---------- as ferramentas do navegador, na forma deste modo
if MODO == "classico":
    def abrir():
        return ferramenta("browser_navigate", {"url": URL_SITE})

    def ler():
        return ferramenta("browser_snapshot", {})

    def agir():
        return ferramenta("browser_click", {"ref": "@e1"})

    def ler_senha():
        return ferramenta("browser_console", {"expression": "'campo=[' + ['u', 'p', 'pre'].map(function (i) { return document.getElementById(i).value; }).join('|') + ']'"})
    RELER = "browser_snapshot"
else:
    def abrir():
        return ferramenta("browser_exec", {"code": f'# Abrindo a Loja Teste\nnew_tab("{URL_SITE}")\nprint(page_info())'})

    def ler():
        return ferramenta("browser_exec", {"code": '# Lendo a página\nprint(page_info())\nprint(js("document.body.innerText"))'})

    def agir():
        return ferramenta("browser_exec", {"code": "# Clicando em Entrar\nprint(js(\"document.getElementById('entrar').click()\"))"})

    def ler_senha():
        return ferramenta("browser_exec", {"code": "# Lendo o campo\nprint('campo=[' + str(js(\"['u', 'p', 'pre'].map(function (i) { return document.getElementById(i).value; }).join('|')\")) + ']')"})
    RELER = "browser_exec"

# ============ 1. o agente abre a página; a pessoa assiste; assume; faz o login; devolve; o agente lê a página logada
S1 = "sessao-nav-a"
medidas = {}


def passo_assistir():
    """O modelo foi chamado depois do browser_navigate: o navegador está aberto e o turno segue."""
    medidas["ativo"] = esperar(lambda: len(avisos("ativo")) == 1, 5)
    medidas["estado"] = ponte("GET", f"/ergon/v1/navegador?sessao={S1}")
    medidas["sem_token"] = Fluxo(S1, token="").status
    medidas["token_errado"] = Fluxo(S1, token="x" * 40).status
    medidas["desconhecida"] = Fluxo("sessao-que-nao-existe").status
    medidas["estado_desconhecida"] = ponte("GET", "/ergon/v1/navegador?sessao=sessao-que-nao-existe")
    fl = Fluxo(S1)
    medidas["fluxo"] = fl.status
    q = fl.quadro() if fl.status == 101 else None
    medidas["quadro"] = bool(q and base64.b64decode(q["data"])[:3] == b"\xff\xd8\xff")
    medidas["meta"] = (q or {}).get("metadata")
    fl.fechar()
    return ler()


def passo_assumir():
    """A pessoa assume e o agente, sem saber, chama browser_click: a ferramenta espera. Enquanto isso a pessoa digita."""
    medidas["assumir"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S1, "pessoa": True, "prazo_s": 120})
    medidas["estado_pessoa"] = ponte("GET", f"/ergon/v1/navegador?sessao={S1}")

    def pessoa():
        try:
            time.sleep(1.0)
            medidas["esperando"] = len(chamadas)   # o modelo ainda não foi chamado de novo: a ferramenta está parada
            antes = bt._session_last_activity.get(S1, 0)
            fl = Fluxo(S1)
            ux, uy = caixa("#u", S1)
            px, py = caixa("#p", S1)
            fl.clicar(ux, uy)
            fl.digitar("ana")
            fl.clicar(px, py)
            fl.digitar(SENHA)
            fl.enviar({"type": "input_keyboard", "eventType": "keyDown", "key": "Enter", "code": "Enter", "text": "\r", "windowsVirtualKeyCode": 13, "modifiers": 0})
            fl.enviar({"type": "input_keyboard", "eventType": "keyUp", "key": "Enter", "code": "Enter", "text": "", "windowsVirtualKeyCode": 13, "modifiers": 0})
            time.sleep(1.0)
            medidas["tocou_atividade"] = esperar(lambda: bt._session_last_activity.get(S1, 0) > antes, 4)
            fl.fechar()
            medidas["chamadas_antes_de_devolver"] = len(chamadas)
            medidas["devolver"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S1, "pessoa": False})
        except Exception as exc:  # noqa: BLE001
            medidas["erro_pessoa"] = repr(exc)
            ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S1, "pessoa": False})

    threading.Thread(target=pessoa, daemon=True).start()
    return agir()


roteiro[:] = [abrir(), passo_assistir, passo_assumir, ler, fala("O pedido 4471 foi entregue.")]
n0 = len(chamadas)
r = rodar(S1, "veja a situação do meu pedido na Loja Teste")
res = resultados()
oferecidas = {t.get("function", {}).get("name") for t in chamadas[n0].get("tools", [])}
if MODO == "classico":
    check("só com navegador: o modelo recebe as ferramentas browser_* (e não o browser_exec)", {"browser_navigate", "browser_snapshot", "browser_click"} <= oferecidas and "browser_exec" not in oferecidas, str(sorted(x for x in oferecidas if x)))
else:
    check("com navegador e Terminal: o modelo recebe o browser_exec, como hoje", "browser_exec" in oferecidas and "browser_navigate" not in oferecidas, str(sorted(x for x in oferecidas if x)))
check("o agente abriu a página pelo navegador do motor", len(res) >= 1 and "Loja Teste" in res[0], res[0][:300] if res else "")
check("o Ergon foi avisado de que há navegador neste trabalho (com o token da ponte e a sessão)", medidas.get("ativo")
      and avisos("ativo")[0].get("session_id") == S1 and [p["token"] for p in pedidos if p["path"].endswith("/navegador")][0] == TOKEN, str(pedidos)[:300])
check("a ponte diz: navegador ativo, com o agente", medidas.get("estado", (0, {}))[0] == 200 and medidas["estado"][1].get("ativo") is True
      and medidas["estado"][1].get("controle") == "agente", str(medidas.get("estado")))
check("transmissão sem token: 401; com token errado: 401", medidas.get("sem_token") == 401 and medidas.get("token_errado") == 401, f'{medidas.get("sem_token")} {medidas.get("token_errado")}')
check("sessão desconhecida: sem transmissão (404) e estado inativo", medidas.get("desconhecida") == 404 and medidas.get("estado_desconhecida", (0, {}))[1].get("ativo") is False,
      f'{medidas.get("desconhecida")} {medidas.get("estado_desconhecida")}')
check("com o token: a transmissão abre e chega um quadro JPEG do viewport", medidas.get("fluxo") == 101 and medidas.get("quadro"), f'{medidas.get("fluxo")} {medidas.get("meta")}')
check("o quadro traz o tamanho do viewport (para a escala das coordenadas)", isinstance(medidas.get("meta"), dict) and medidas["meta"].get("deviceWidth", 0) > 0
      and medidas["meta"].get("deviceHeight", 0) > 0, str(medidas.get("meta")))
check("assumir: a ponte confirma, com prazo", medidas.get("assumir", (0, {}))[0] == 200 and medidas["assumir"][1].get("controle") == "pessoa"
      and medidas["assumir"][1].get("ate", 0) > time.time() - 60 and medidas.get("estado_pessoa", (0, {}))[1].get("controle") == "pessoa", str(medidas.get("assumir")))
check("a pessoa no controle: a ferramenta do agente esperou (o modelo não foi chamado de novo antes da devolução)",
      "erro_pessoa" not in medidas and medidas.get("esperando") == medidas.get("chamadas_antes_de_devolver") == n0 + 3, str({k: medidas.get(k) for k in ("esperando", "chamadas_antes_de_devolver", "erro_pessoa")}))
check("o navegador não é dado como parado enquanto a pessoa usa (a atividade é tocada)", medidas.get("tocou_atividade") is True)
check("devolver: a ponte confirma e a época sobe", medidas.get("devolver", (0, {}))[0] == 200 and medidas["devolver"][1].get("controle") == "agente"
      and medidas["devolver"][1].get("epoca") == 1, str(medidas.get("devolver")))
check("a ferramenta que esperava foi recusada com o pedido de reler a página (não clicou numa referência velha)",
      len(res) >= 3 and "já devolveu" in res[2] and RELER in res[2], res[2][:300] if len(res) >= 3 else str(res))
check("a releitura seguinte mostra a página já logada, pelo que a pessoa digitou", len(res) >= 4 and "Bem-vinda" in res[3] and "4471" in res[3], res[3][:400] if len(res) >= 4 else "")
check("e o trabalho seguiu até o fim", r.get("final_response") == "O pedido 4471 foi entregue.", str(r.get("final_response")))
check("fim do turno: o Ergon é avisado e o registro some", esperar(lambda: len(avisos("fim")) == 1, 8) and nav.registro(S1) is None
      and ponte("GET", f"/ergon/v1/navegador?sessao={S1}")[1].get("ativo") is False, str(avisos("fim")))
check("sem navegador: assumir responde 404", ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S1, "pessoa": True})[0] == 404)

# ============ 2. senha digitada e não enviada é apagada na devolução; a pessoa que não devolve; o prazo
S2 = "sessao-nav-b"
pedidos.clear()
medidas.clear()


def passo_senha_sem_enviar():
    ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S2, "pessoa": True, "prazo_s": 120})
    fl = Fluxo(S2)
    ux, uy = caixa("#u", S2)
    fl.clicar(ux, uy)
    fl.digitar(CODIGO)
    px, py = caixa("#p", S2)
    fl.clicar(px, py)
    fl.digitar(SENHA)
    reg = nav.registro(S2)
    medidas["codigo"] = ((nav._cli(reg, ["eval", "document.getElementById('u').value"]) or {}).get("data") or {}).get("result")
    medidas["digitada"] = ((nav._cli(reg, ["eval", "document.getElementById('p').value.length"]) or {}).get("data") or {}).get("result")
    fl.fechar()
    medidas["devolver"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S2, "pessoa": False})
    # o agente relê a página e tenta ler o campo logo depois
    return ler()


def passo_nao_devolve():
    medidas["t0"] = time.time()
    ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S2, "pessoa": True, "prazo_s": 9})
    return ler()


def passo_prazo():
    medidas["espera_1"] = time.time() - medidas["t0"]
    return agir()


roteiro[:] = [abrir(), passo_senha_sem_enviar, ler_senha, passo_nao_devolve, passo_prazo, ler, fala("Falta a senha.")]
r = rodar(S2, "entre na Loja Teste")
res = resultados()
check("a pessoa digitou a senha no campo (pela transmissão)", medidas.get("digitada") == len(SENHA), str(medidas.get("digitada")))
check("e um código num campo de texto comum", medidas.get("codigo") == CODIGO, str(medidas.get("codigo")))
check("devolveu sem enviar: a ponte diz que apagou os 2 campos digitados", medidas.get("devolver", (0, {}))[1].get("senhas") == 2, str(medidas.get("devolver")))
check("o agente lê os campos depois da devolução: vazios, e o que a página já trazia continua lá", len(res) >= 3 and "campo=[||mantido]" in res[2]
      and not any(x in r_ for x in (SENHA, CODIGO) for r_ in res), res[2][:300] if len(res) >= 3 else str(res))
check("a pessoa não devolve: a ferramenta desiste de esperar (6 s) com o aviso de que ela ainda está usando",
      len(res) >= 4 and "ainda está" in res[3] and 5 <= medidas.get("espera_1", 0) < 9, f'{medidas.get("espera_1")} {res[3][:200] if len(res) >= 4 else res}')
check("o prazo acaba: o controle volta sozinho e o agente recebe o aviso do prazo", len(res) >= 5 and "prazo" in res[4], res[4][:300] if len(res) >= 5 else str(res))
check("e o Ergon é avisado da devolução pelo prazo", esperar(lambda: any(a.get("motivo") == "prazo" and a.get("session_id") == S2 for a in avisos("devolvido")), 5), str(pedidos)[:400])
check("depois do prazo o agente relê a página e segue", len(res) >= 6 and "Loja Teste" in res[5] and r.get("final_response") == "Falta a senha.", res[5][:200] if len(res) >= 6 else "")

# ============ 2b. browser_exec abre outra aba por fora do agent-browser: a transmissão e a entrada da pessoa vão com ela
if MODO != "classico":
    S3 = "sessao-nav-c"
    medidas.clear()

    def passo_aba_nova():
        return ferramenta("browser_exec", {"code": f'# Abrindo outra aba\nnew_tab("{URL_SITE}?aba=2")\nprint(page_info())'})

    def passo_pessoa_na_aba():
        ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S3, "pessoa": True, "prazo_s": 60})
        fl = Fluxo(S3)
        q0 = fl.quadro(5)
        ux, uy = 190, 0
        reg = nav.registro(S3)
        d = ((nav._cli(reg, ["get", "box", "#u"]) or {}).get("data") or {})
        ux, uy = d.get("x", 0) + d.get("width", 0) / 2, d.get("y", 0) + d.get("height", 0) / 2
        fl.clicar(ux, uy)
        fl.digitar("zz")
        medidas["quadro"] = bool(q0)
        medidas["onde"] = ((nav._cli(reg, ["eval", "location.search + '|' + document.getElementById('u').value"]) or {}).get("data") or {}).get("result")
        fl.fechar()
        ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S3, "pessoa": False})
        return ler()

    def passo_onde_digitou():
        return ferramenta("browser_exec", {"code": "# Conferindo\nprint('onde=[' + str(js(\"location.search + '|' + document.getElementById('u').value\")) + ']')"})

    roteiro[:] = [abrir(), passo_aba_nova, passo_pessoa_na_aba, passo_onde_digitou, fala("Certo.")]
    r = rodar(S3, "abra a loja em duas abas")
    res = resultados()
    check("browser_exec abriu outra aba: a pessoa vê e digita na aba em uso (não na anterior)", medidas.get("quadro") and medidas.get("onde") == "?aba=2|zz", str(medidas.get("onde")))
    check("e, devolvido, o agente segue na mesma aba sem o que ela digitou", len(res) >= 4 and "onde=[?aba=2|]" in res[3], res[3][:300] if len(res) >= 4 else str(res)[:400])

# ============ 2c. uma ferramenta do navegador JÁ em curso quando a pessoa assume (lê a página devagar): assumir espera ela
# terminar antes de dar o controle (a trava só segura as chamadas novas); se não terminar a tempo, a tomada é desfeita
S4 = "sessao-nav-d"
medidas.clear()
LENTO_JS = "(function(){var t=Date.now();while(Date.now()-t<4000){}return 'lento='+document.title})()"
if MODO == "classico":
    def lento():
        return ferramenta("browser_console", {"expression": LENTO_JS})
else:
    def lento():
        return ferramenta("browser_exec", {"code": "# Lendo devagar\nprint(js(" + json.dumps(LENTO_JS) + "))"})


def passo_lento():
    def pessoa():
        try:
            esperar(lambda: bool(nav.em_curso(S4)), 5)
            medidas["em_curso_antes"] = list(nav.em_curso(S4))
            t0 = time.time()
            medidas["assumir"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S4, "pessoa": True, "prazo_s": 60})
            medidas["assumir_s"] = time.time() - t0
            medidas["em_curso_ao_assumir"] = list(nav.em_curso(S4))
            medidas["devolver"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S4, "pessoa": False})
        except Exception as exc:  # noqa: BLE001
            medidas["erro_pessoa"] = repr(exc)
    threading.Thread(target=pessoa, daemon=True).start()
    return lento()


def passo_nao_termina():
    # uma chamada que não termina dentro da espera (marca posta à mão, prazo curto): assumir recusa e desfaz. (Antes,
    # a pessoa do passo anterior devolve: a ferramenta lenta acabou e a tomada dela pode ainda estar terminando agora)
    esperar(lambda: "devolver" in medidas or "erro_pessoa" in medidas and medidas["erro_pessoa"] is not None, 15)
    medidas["estado_antes"] = ponte("GET", f"/ergon/v1/navegador?sessao={S4}")[1].get("controle")
    velho = nav.EM_CURSO_S
    nav.EM_CURSO_S = 0.6
    nav._marcar_em_curso(S4, "browser_exec")
    try:
        medidas["recusa"] = ponte("PUT", "/ergon/v1/navegador/controle", {"sessao": S4, "pessoa": True, "prazo_s": 60})
        medidas["estado_recusa"] = ponte("GET", f"/ergon/v1/navegador?sessao={S4}")[1].get("controle")
    finally:
        nav._desmarcar_em_curso()
        nav.EM_CURSO_S = velho
    medidas["em_curso_fim"] = list(nav.em_curso(S4))
    return ler()


roteiro[:] = [abrir(), passo_lento, passo_nao_termina, fala("Pronto.")]
r = rodar(S4, "leia a Loja Teste com calma")
res = resultados()
check("a ferramenta lenta estava em curso quando a pessoa pediu o controle", bool(medidas.get("em_curso_antes")), str(medidas))
check("assumir esperou ela terminar (e só então deu o controle)", medidas.get("assumir", (0, {}))[0] == 200 and medidas.get("assumir_s", 0) >= 2.0
      and medidas.get("em_curso_ao_assumir") == [], str({k: medidas.get(k) for k in ("assumir", "assumir_s", "em_curso_ao_assumir", "erro_pessoa")}))
check("a leitura em curso terminou normalmente (antes de a pessoa mexer)", len(res) >= 2 and "lento=" in res[1], res[1][:200] if len(res) >= 2 else str(res))
check("em curso além da espera: assumir recusa (409) e o controle segue com o agente", medidas.get("recusa", (0, {}))[0] == 409
      and medidas.get("estado_antes") == "agente" and medidas.get("estado_recusa") == "agente" and medidas.get("em_curso_fim") == [], str({k: medidas.get(k) for k in ("recusa", "estado_antes", "estado_recusa", "em_curso_fim")}))

# ============ 3. a máquina de estados, direto no módulo (sem navegador)
c0 = nav.controle("sessao-solta")
check("sem nada gravado: com o agente, época 0", c0["pessoa"] is False and c0["epoca"] == 0)
a1 = nav.assumir("sessao-solta", 60)
a2 = nav.assumir("sessao-solta", 900)
check("assumir de novo renova o prazo sem mudar o começo", a2["desde"] == a1["desde"] and a2["ate"] > a1["ate"])
check("o prazo pedido tem teto (900 s) e a tomada inteira também (1800 s do começo)", a2["ate"] - time.time() <= 900.5 and a2["ate"] <= a2["desde"] + 1800)
d1 = nav.devolver("sessao-solta")
d2 = nav.devolver("sessao-solta")
check("devolver sobe a época uma vez (devolver de novo não muda)", d1["epoca"] == 1 and d2["epoca"] == 1 and d2["pessoa"] is False)
nav._marcar_em_curso("sessao-solta", "browser_snapshot")
check("em curso: a marca da chamada aparece e esperar por ela, sem terminar, devolve o que resta", nav.em_curso("sessao-solta") == ["browser_snapshot"]
      and nav.esperar_em_curso("sessao-solta", 0.3) == ["browser_snapshot"])
nav._desmarcar_em_curso()
check("terminada (post_tool_call), não está mais em curso", nav.em_curso("sessao-solta") == [] and nav.esperar_em_curso("sessao-solta", 0.3) == [])
check("ferramentas que não são do navegador nunca esperam", nav.antes("terminal", "sessao-solta") is None and nav.antes("web_search", S2) is None)
modo = oct(os.stat(ESTADO).st_mode & 0o777)
check("a pasta do estado é só do usuário do motor (0700)", modo == "0o700", modo)

# ============ 4. a senha não ficou em lugar nenhum
conversa = json.dumps(chamadas, ensure_ascii=False)
check("a senha não foi ao modelo em nenhuma mensagem", SENHA not in conversa)
check("nem o código digitado no campo de texto", CODIGO not in conversa)
check("nem ao Ergon, em nenhum pedido", SENHA not in json.dumps(pedidos, ensure_ascii=False))
check("nem aos registros do motor", SENHA not in registros.getvalue())
achados = []
for raiz in (HOME, ESTADO):
    for base, _dirs, arquivos in os.walk(raiz):
        if os.path.join(HOME, "plugins") in base:
            continue
        for a in arquivos:
            try:
                with open(os.path.join(base, a), "rb") as fh:
                    if SENHA.encode() in fh.read():
                        achados.append(os.path.join(base, a))
            except OSError:
                pass
check("nem a nenhum arquivo do motor", not achados, str(achados))

print(f"[{MODO}] " + ("TUDO CERTO" if ok else "HOUVE FALHAS"), flush=True)
if MODO != "classico":
    # as ferramentas browser_* de sempre (browser.backend: off), num processo novo (a configuração do motor é lida uma vez)
    try:
        bt.cleanup_all_browsers()
    except Exception:  # noqa: BLE001
        pass
    outro = subprocess.run([sys.executable, os.path.abspath(__file__)], env={**os.environ, "NAV_MODO": "classico", "HERMES_HOME": os.environ.get("NAV_HOME_ORIGINAL", "/tmp/h")}, check=False)
    ok = ok and outro.returncode == 0
sys.exit(0 if ok else 1)

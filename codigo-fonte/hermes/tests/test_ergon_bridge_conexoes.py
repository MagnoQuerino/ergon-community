"""Conexões no motor (plugin do Ergon + Hermes de verdade, sem rede, HERMES_HOME descartável, Ergon simulado).

Confere: as ferramentas registradas pelo plugin chegam à plataforma da API e ao modelo sem passar pela busca de
ferramentas; o despacho real entrega sessão e tarefa ao plugin; o plugin só repassa ao Ergon, com o token da ponte; a trava
por agente vale para elas; depois de ler conteúdo privado, o que alcança endereços arbitrários é barrado e a busca não.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_conexoes.py
"""
import json
import os
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("""plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, web, vision, image_gen, skills, ergon_conexoes]
tools:
  tool_search:
    enabled: "off"
""")
TOKEN = "token-da-ponte-de-teste-0123456789"
os.environ["HERMES_PLATFORM"] = "api_server"
os.environ["ERGON_BRIDGE_TOKEN"] = TOKEN
sys.path.insert(0, "/opt/hermes")

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


# ---------- Ergon simulado
seen = []
policy = {"known": True, "agent": "Aspásia", "toolsets": ["todo", "web", "ergon_conexoes"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


class Ergon(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        seen.append({"path": self.path, "token": self.headers.get("X-Ergon-Bridge-Token"), "body": body})
        out = policy if self.path.endswith("/tool-policy") else {"ok": True, "status": "feita", "texto": f"recebi {body.get('op')}"}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Ergon)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{srv.server_address[1]}/internal/bridge/v1/events"

# ---------- o Hermes de verdade carrega o plugin
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
from tools.registry import registry  # noqa: E402

check("o plugin registra conexoes_listar", registry.get_entry("conexoes_listar") is not None)
check("o plugin registra conexoes_executar", registry.get_entry("conexoes_executar") is not None)
check("no conjunto ergon_conexoes", getattr(registry.get_entry("conexoes_executar"), "toolset", "") == "ergon_conexoes")

from hermes_cli.config import load_config  # noqa: E402
from hermes_cli.tools_config import _get_platform_tools  # noqa: E402

cfg = load_config()
enabled = _get_platform_tools(cfg, "api_server", include_default_mcp_servers=False)
check("a plataforma da API liga o conjunto", "ergon_conexoes" in enabled, str(enabled))

from toolsets import resolve_toolset  # noqa: E402

check("o conjunto resolve para as duas ferramentas", {"conexoes_listar", "conexoes_executar"} <= set(resolve_toolset("ergon_conexoes")), str(resolve_toolset("ergon_conexoes")))

import model_tools  # noqa: E402

defs = model_tools.get_tool_definitions(enabled_toolsets=sorted(enabled), quiet_mode=True)
names = {d.get("function", {}).get("name") for d in defs}
check("o modelo vê as duas ferramentas", {"conexoes_listar", "conexoes_executar"} <= names, str(sorted(n for n in names if n)))

from tools.tool_search import ToolSearchConfig, should_activate  # noqa: E402

ts = ToolSearchConfig.from_raw(cfg.get("tools", {}).get("tool_search"))
check("a busca de ferramentas fica desligada (o modelo chama direto)", ts.enabled == "off" and not should_activate(ts, 1000, 100000), str(ts))

# ---------- despacho real: sessão e tarefa chegam ao plugin, e o plugin só repassa
raw = model_tools.handle_function_call("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {"titulo": "Teste"}}, task_id="tarefa-1", session_id="sessao-1")
r = json.loads(raw) if isinstance(raw, str) else raw
check("o resultado do Ergon volta ao modelo", r.get("texto") == "recebi executar", str(r))
envio = [s for s in seen if s["path"].endswith("/conexoes")]
check("vai à rota certa, com o token da ponte", bool(envio) and envio[-1]["token"] == TOKEN, str(envio))
b = envio[-1]["body"] if envio else {}
check("com a sessão e a tarefa do motor", b.get("session_id") == "sessao-1" and b.get("task_id") == "tarefa-1", str(b))
check("com conexão, ação e parâmetros", b.get("conexao") == "asana" and b.get("acao") == "tarefa.criar" and b.get("parametros") == {"titulo": "Teste"}, str(b))

raw = model_tools.handle_function_call("conexoes_listar", {"conexao": "asana"}, task_id="tarefa-1", session_id="sessao-1")
check("listar também passa", json.loads(raw).get("texto") == "recebi listar", str(raw))

# ---------- travas, pelo hook de verdade
bridge = next(m for m in list(sys.modules.values()) if hasattr(m, "tool_conexoes_executar"))  # o módulo que o Hermes carregou

call = lambda tool, sess="sessao-2": bridge.on_pre_tool_call(tool, {}, "tarefa-2", sess)
check("agente com a ferramenta: passa", call("conexoes_executar") is None)
policy["toolsets"] = ["todo"]
policy["holders"] = {"ergon_conexoes": ["Aspásia"]}
r = call("conexoes_executar", "sessao-3")
check("agente sem a ferramenta: barrado, dizendo quem tem", isinstance(r, dict) and r.get("action") == "block" and "Aspásia" in r.get("message", ""), str(r))
policy["toolsets"] = ["todo", "web", "ergon_conexoes"]
policy["holders"] = {}
policy["bloqueadas"] = ["web_extract", "terminal", "execute_code", "vision_analyze"]
r = call("web_extract", "sessao-4")
check("depois de ler conteúdo privado: abrir endereço é barrado", isinstance(r, dict) and r.get("action") == "block" and "conteúdo privado" in r.get("message", ""), str(r))
check("a busca na web segue valendo", call("web_search", "sessao-4") is None)
check("e as conexões também", call("conexoes_executar", "sessao-4") is None)
r = call("terminal", "sessao-4")
check("terminal barrado sem oferecer senha", isinstance(r, dict) and "pedir-permissao" not in r.get("message", ""), str(r))

# ---------- ler conteúdo privado vale na hora: a política é relida depois da ferramenta
policy["bloqueadas"] = []
check("antes de ler: abrir endereço passa", call("web_extract", "sessao-5") is None)
policy["bloqueadas"] = ["web_extract"]
check("cache: sem a leitura, ainda vale o que foi visto", call("web_extract", "sessao-5") is None)
model_tools.handle_function_call("conexoes_executar", {"conexao": "microsoft", "acao": "email.buscar", "parametros": {}}, task_id="tarefa-2", session_id="sessao-5")
r = call("web_extract", "sessao-5")
check("depois da ferramenta de conexão, a nova política vale sem esperar", isinstance(r, dict) and r.get("action") == "block", str(r))

# ---------- avisa quando já passou por internet
model_tools.handle_function_call("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-2", session_id="sessao-2")
check("sessão sem internet: leu_web falso", [s for s in seen if s["path"].endswith("/conexoes")][-1]["body"].get("leu_web") is False)
call("web_search", "sessao-6")
model_tools.handle_function_call("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-2", session_id="sessao-6")
check("sessão que abriu a internet: leu_web verdadeiro", [s for s in seen if s["path"].endswith("/conexoes")][-1]["body"].get("leu_web") is True)
bridge.on_pre_tool_call("vision_analyze", {"image_url": "https://atacante.example/a.png", "question": "o que diz?"}, "tarefa-2", "sessao-7")
model_tools.handle_function_call("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-2", session_id="sessao-7")
check("imagem lida por endereço também conta como internet", [s for s in seen if s["path"].endswith("/conexoes")][-1]["body"].get("leu_web") is True)
bridge.on_pre_tool_call("vision_analyze", {"image_url": "data:image/png;base64,iVBORw0KGgo=", "question": "o que diz?"}, "tarefa-2", "sessao-8")
model_tools.handle_function_call("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-2", session_id="sessao-8")
check("imagem em data: (já na conversa) não conta", [s for s in seen if s["path"].endswith("/conexoes")][-1]["body"].get("leu_web") is False)

# ---------- Ergon fora: o hook barra antes (sem política, só o básico), e a ferramenta, se chamada, diz que não sabe
srv.shutdown()
srv.server_close()
r = bridge.on_pre_tool_call("conexoes_executar", {}, "tarefa-9", "sessao-9")
check("Ergon fora: o hook barra a ferramenta", isinstance(r, dict) and r.get("action") == "block", str(r))
raw = bridge.tool_conexoes_executar({"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-9", session_id="sessao-9")
check("Ergon fora: a ferramenta diz que não sabe se foi feito", '"ok": false' in raw and "Não sei se" in raw, str(raw))

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

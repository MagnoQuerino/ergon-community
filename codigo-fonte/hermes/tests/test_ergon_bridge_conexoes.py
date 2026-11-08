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

# ---------- a lista do Ergon com prefixo: "browser_" barra o navegador inteiro, pelo hook de verdade
policy["bloqueadas"] = ["web_extract", "process_manage", "browser_"]
for t in ("browser_console", "browser_cdp", "browser_navigate", "process_manage"):
    r = call(t, "sessao-10")
    check(f"depois de ler conteúdo privado: {t} barrada", isinstance(r, dict) and "conteúdo privado" in r.get("message", ""), str(r))
check("depois de ler conteúdo privado: a busca segue valendo com o prefixo na lista", call("web_search", "sessao-10") is None)
policy["bloqueadas"] = []

# ---------- ferramentas da plataforma da API pela ponte de controle: desligar as Conexões vale de verdade
# O painel do motor é simulado com o mesmo que o PUT /api/config do Hermes faz: lê o disco, funde por cima e salva.
from pathlib import Path  # noqa: E402

from hermes_cli import config as hc  # noqa: E402


def gravar(cfg):
    hc.save_config(cfg)
    hc._LOAD_CONFIG_CACHE.clear()


def painel(method, path, query, body):
    if method == "PUT" and path == "/api/config":
        gravar(hc._deep_merge(hc.require_readable_config_before_write(), body["config"]))
        return 200, b'{"ok": true}'
    if path == "/api/model/info":
        return 200, b"{}"
    return 404, b"{}"


class Resp:
    def __init__(self):
        self.out = None

    def _json(self, status, obj):
        self.out = (status, obj)

    def _send(self, status, data):
        self.out = (status, json.loads(data or b"{}"))


def ponte(metodo, corpo=None):
    resp = Resp()
    if metodo == "GET":
        bridge._ControlHandler._api_toolsets_get(resp)
    else:
        bridge._ControlHandler._api_toolsets_put(resp, corpo or {})
    return resp.out


def api_ligadas():
    return _get_platform_tools(load_config(), "api_server", include_default_mcp_servers=False)


bridge._dash_call = painel
# o que o Hermes já marcou como conhecido (recurso que saiu do núcleo) tem de continuar
disco = hc.read_user_config_raw(Path(HOME) / "config.yaml")
disco["known_plugin_toolsets"] = {"api_server": ["homeassistant"], "teams": ["homeassistant"]}
gravar(disco)
st = ponte("GET")
check("consulta: Conexões ligadas e o que o Hermes conhece", st[0] == 200 and "ergon_conexoes" in st[1]["enabled"] and st[1].get("known") == ["homeassistant"], str(st))
st = ponte("PUT", {"enabled": ["todo", "web"]})
check("desligar: a ponte grava também o conjunto como conhecido (unido ao que estava)",
      st == (200, {"ok": True, "enabled": ["todo", "web"], "known": ["ergon_conexoes", "homeassistant"]}), str(st))
check("desligar: o Hermes deixa de ligar as Conexões na API", "ergon_conexoes" not in api_ligadas(), str(api_ligadas()))
kn = hc.read_user_config_raw(Path(HOME) / "config.yaml").get("known_plugin_toolsets")
check("desligar: o que o Hermes conhecia continua (API e Teams)", kn == {"api_server": ["ergon_conexoes", "homeassistant"], "teams": ["homeassistant"]}, str(kn))
st = ponte("PUT", {"enabled": ["todo", "web", "ergon_conexoes", "browser", "file"]})
check("religar: Conexões de volta; o que não é do conjunto seguro não entra", st[0] == 200 and st[1]["enabled"] == ["ergon_conexoes", "todo", "web"]
      and "ergon_conexoes" in api_ligadas(), str((st, api_ligadas())))
check("consulta depois: conhecido sem repetir", ponte("GET")[1].get("known") == ["ergon_conexoes", "homeassistant"])


# a saúde diz a versão do plugin, a configuração do cofre e o que este motor sabe fazer
def saude():
    resp = Resp()
    getattr(bridge._ControlHandler, "_health", lambda r: r._json(200, {}))(resp)  # plugin de antes: sem a rota nova
    return resp.out


marca = Path(HOME) / ".ergon-config"
marca.write_text('{"versao": 2}', encoding="utf-8")
st = saude()
check("saúde: versão do plugin, migração do cofre e capacidades", st[0] == 200 and st[1].get("plugin_version") == bridge.PLUGIN_VERSION
      and st[1].get("vault_config") == 2 and {"conexoes", "bloqueio_prefixo", "known_plugin_toolsets"} <= set(st[1].get("capacidades") or [])
      and st[1].get("ok") is True and st[1].get("dashboard") is True, str(st))
marca.write_text("1", encoding="utf-8")
check("saúde: marca antiga vale 1", saude()[1].get("vault_config") == 1)
# a marca das migrações (.ergon-migracoes) vale antes da antiga, que fica "1" para as imagens de antes
(Path(HOME) / ".ergon-migracoes").write_text('{"versao": 2}', encoding="utf-8")
check("saúde: a marca das migrações primeiro", saude()[1].get("vault_config") == 2)
(Path(HOME) / ".ergon-migracoes").unlink()
marca.unlink()
check("saúde: sem marca, 0", saude()[1].get("vault_config") == 0)

# ---------- Ergon fora: o hook barra antes (sem política, só o básico), e a ferramenta, se chamada, diz que não sabe
srv.shutdown()
srv.server_close()
r = bridge.on_pre_tool_call("conexoes_executar", {}, "tarefa-9", "sessao-9")
check("Ergon fora: o hook barra a ferramenta", isinstance(r, dict) and r.get("action") == "block", str(r))
raw = bridge.tool_conexoes_executar({"conexao": "asana", "acao": "tarefa.criar", "parametros": {}}, task_id="tarefa-9", session_id="sessao-9")
check("Ergon fora: a ferramenta diz que não sabe se foi feito", '"ok": false' in raw and "Não sei se" in raw, str(raw))

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

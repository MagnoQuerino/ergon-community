"""Modelos por tarefa (rc.27), com o painel interno DE VERDADE do Hermes (a aplicação dele, com as rotas, a validação e
o token dele), a ponte de controle do plugin e um provedor falso no 127.0.0.1 (sem rede, HERMES_HOME descartável).

Confere:
  1) pela ponte, GET /api/model/auxiliary devolve TODAS as tarefas de apoio do Hermes (as 12 dele e a que um plugin
     registra), cada uma em "auto" (usar o modelo principal), e o modelo principal;
  2) POST /api/model/set com scope "auxiliary" grava o modelo de UMA tarefa (auxiliary.<tarefa>.provider/model no
     config.yaml), sem tocar no modelo principal nem nas outras tarefas; "auto" volta a usar o principal;
  3) o valor gravado é o que o motor USA: o resolvedor das tarefas de apoio (agent/auxiliary_client.py,
     _resolve_task_provider_model) passa a devolver o modelo escolhido, e uma chamada de verdade de dar nome à conversa
     (title_generation) e de resumir (compression) chega ao provedor com esse modelo; sem escolha, chega com o principal;
  4) a tarefa de plugin que segue outra (inherit_from) acompanha a escolha da base;
  5) os ajudantes temporários (/ergon/v1/delegacao): grava delegation.provider/model, e a delegação do Hermes resolve as
     credenciais do ajudante para esse modelo; vazio = o de quem pediu a ajuda;
  6) por perfil (/p/<perfil>/...): lê e grava no config.yaml do perfil, sem tocar no do motor; perfil que não existe: 404;
  7) recusas da ponte: sem o token; endereço, chave ou tarefa estranha no corpo; rota fora da lista com /p/<perfil>/;
  8) /ergon/v1/modelos/visao: uma resposta por modelo (sim, não ou não se sabe), sem ir à rede.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_modelos_tarefa.py

Fora da imagem (outro Python com o Hermes v0.22.2): ERGON_HERMES_SRC = pasta do código do Hermes, ERGON_PLUGINS = pasta
hermes/plugins, HERMES_HOME = pasta descartável.
"""
import json
import os
import shutil
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
PLUGINS = os.environ.get("ERGON_PLUGINS", "/p")
SRC = os.environ.get("ERGON_HERMES_SRC", "/opt/hermes")
if os.path.exists(os.path.join(HOME, ".ergon-vault")):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree(os.path.join(PLUGINS, "ergon_bridge"), os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
# um plugin de terceiro que registra uma tarefa de apoio que segue a de resumir a conversa
os.makedirs(os.path.join(HOME, "plugins", "apoio_teste"), exist_ok=True)
with open(os.path.join(HOME, "plugins", "apoio_teste", "plugin.yaml"), "w", encoding="utf-8") as f:
    f.write('name: apoio_teste\nversion: "0.0.1"\ndescription: "tarefa de apoio de teste"\nkind: standalone\n')
with open(os.path.join(HOME, "plugins", "apoio_teste", "__init__.py"), "w", encoding="utf-8") as f:
    f.write('def register(ctx):\n    ctx.register_auxiliary_task("memoria_longa", display_name="Long memory", description="Recalls old notes", inherit_from="compression")\n')

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and bool(cond)


# ---------- o provedor falso (compatível com a OpenAI): guarda o modelo de cada pedido
pedidos = []


class Provedor(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def _json(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json({"object": "list", "data": [{"id": m, "object": "model"} for m in ("principal-1", "barato-1", "ajudante-1")]})

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        pedidos.append(b.get("model"))
        msg = {"role": "assistant", "content": "Resumo curto do pedido"}
        if b.get("stream"):
            partes = [{"id": "c1", "object": "chat.completion.chunk", "model": b.get("model"), "choices": [{"index": 0, "delta": msg, "finish_reason": None}]},
                      {"id": "c1", "object": "chat.completion.chunk", "model": b.get("model"), "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9}}]
            data = "".join(f"data: {json.dumps(p)}\n\n" for p in partes).encode() + b"data: [DONE]\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._json({"id": "c1", "object": "chat.completion", "model": b.get("model"), "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9}})


def servir(Handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


porta_provedor = servir(Provedor)
BASE = f"http://127.0.0.1:{porta_provedor}/v1"
CHAVE = "sk-" + "teste-" * 5
CONFIG = f"""plugins:
  enabled: [ergon_bridge, apoio_teste]
platform_toolsets:
  api_server: [todo, web, skills, ergon_conexoes]
model:
  default: principal-1
  provider: byok-conta
  base_url: {BASE}
custom_providers:
  - name: byok-conta
    base_url: {BASE}
    api_key: {CHAVE}
    model: principal-1
    models: [principal-1, barato-1, ajudante-1]
    api_mode: chat_completions
agent:
  max_turns: 20
"""
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(CONFIG)
# um perfil (um agente da equipe): a mesma conta, o próprio config.yaml
PERFIL = "socrates"
os.makedirs(os.path.join(HOME, "profiles", PERFIL), exist_ok=True)
with open(os.path.join(HOME, "profiles", PERFIL, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(CONFIG.replace("enabled: [ergon_bridge, apoio_teste]", "enabled: []"))

TOKEN = "token-da-ponte-de-teste-0123456789"
TOKEN_PAINEL = "token-do-painel-de-teste-0123456789"
os.environ["HERMES_PLATFORM"] = "api_server"
os.environ["ERGON_BRIDGE_TOKEN"] = TOKEN
os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = TOKEN_PAINEL
os.environ.pop("ERGON_CONTROL_PORT", None)
for k in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY"):
    os.environ.pop(k, None)
sys.path.insert(0, SRC)
sys.path.insert(0, os.path.join(HOME, "plugins"))

import ergon_bridge as bridge  # noqa: E402
import hermes_yaml as yaml  # noqa: E402 - o YAML do próprio Hermes
from starlette.testclient import TestClient  # noqa: E402

import hermes_cli.web_server as web_server  # noqa: E402

painel = TestClient(web_server.app)
vistos_no_painel = []


def dash(metodo, caminho, query, corpo):
    """O que a ponte faria por HTTP no 127.0.0.1:9119, entregue à aplicação de verdade do painel (com o token dele)."""
    vistos_no_painel.append((metodo, caminho, query, corpo))
    r = painel.request(metodo, caminho + (f"?{query}" if query else ""), json=corpo if metodo in ("POST", "PUT") else None,
                       headers={"X-Hermes-Session-Token": os.environ["HERMES_DASHBOARD_SESSION_TOKEN"]})
    return r.status_code, r.content


check("o painel de verdade exige o token dele", painel.get("/api/model/auxiliary").status_code == 401)
bridge._dash_call = dash
porta = servir(bridge._ControlHandler)


def ponte(metodo, caminho, corpo=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{porta}{caminho}", method=metodo, data=None if corpo is None else json.dumps(corpo).encode(),
                                 headers={"Content-Type": "application/json", **({"X-Ergon-Bridge-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def disco(perfil=None):
    with open(os.path.join(HOME, *(["profiles", perfil] if perfil else []), "config.yaml"), encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def linha(resposta, tarefa):
    return next((t for t in resposta.get("tasks", []) if t.get("task") == tarefa), None)


# ---------- 1) a lista
from hermes_cli.web_server_config import _AUX_TASK_SLOTS  # noqa: E402

st = ponte("GET", "/ergon/v1/health")
check("1: a saúde diz que o motor tem os modelos por tarefa", st[0] == 200 and "modelos_tarefa" in (st[1].get("capacidades") or []), str(st))
st = ponte("GET", "/api/model/auxiliary")
tarefas = [t["task"] for t in st[1].get("tasks", [])]
check("1: a ponte devolve as tarefas de apoio do Hermes, todas", st[0] == 200 and tarefas[:len(_AUX_TASK_SLOTS)] == list(_AUX_TASK_SLOTS), str(st)[:400])
check("1: as 12 do Hermes v0.22.2", set(_AUX_TASK_SLOTS) == {"vision", "compression", "skills_hub", "approval", "mcp", "title_generation", "review", "voice_chat",
                                                               "triage_specifier", "kanban_decomposer", "profile_describer", "curator"}, str(_AUX_TASK_SLOTS))
ml = linha(st[1], "memoria_longa")
check("1: e a que o plugin registrou, com o nome e a explicação dele", bool(ml) and ml.get("label") == "Long memory" and ml.get("hint") == "Recalls old notes"
      and ml.get("plugin") == "apoio_teste" and ml.get("inherit_from") == "compression", str(ml))
check("1: todas usando o principal (auto, sem modelo)", all(t.get("provider") == "auto" and t.get("model") == "" for t in st[1]["tasks"]), str(st[1]["tasks"])[:300])
check("1: e o modelo principal", st[1].get("main") == {"provider": "byok-conta", "model": "principal-1"}, str(st[1].get("main")))
check("1: sem o token da ponte, nada", ponte("GET", "/api/model/auxiliary", token="")[0] == 401)

# ---------- 2) e 3) gravar e usar
from agent.auxiliary_client import _resolve_task_provider_model, call_llm  # noqa: E402


def chamar(tarefa):
    """Uma chamada de verdade da tarefa de apoio; devolve o modelo que chegou ao provedor."""
    antes = len(pedidos)
    resp = call_llm(task=tarefa, messages=[{"role": "user", "content": "Dê um nome curto para esta conversa: relatório de vendas"}], max_tokens=30, timeout=30)
    texto = resp.choices[0].message.content if resp is not None else None
    return (pedidos[antes:] or [None])[-1], texto


check("3: sem escolha, o resolvedor diz 'auto' (o principal)", _resolve_task_provider_model("title_generation")[:2] == ("auto", None), str(_resolve_task_provider_model("title_generation")))
m0 = chamar("title_generation")
check("3: sem escolha, dar nome à conversa chega ao provedor com o modelo principal", m0 == ("principal-1", "Resumo curto do pedido"), str(m0))

st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "title_generation", "provider": "byok-conta", "model": "barato-1"})
check("2: a ponte grava o modelo de dar nome à conversa", st[0] == 200 and st[1].get("ok") is True, str(st))
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "compression", "provider": "byok-conta", "model": "barato-1"})
check("2: e o de resumir a conversa", st[0] == 200 and st[1].get("ok") is True, str(st))
d = disco()
check("2: no config.yaml: auxiliary.<tarefa>.provider/model", all((d.get("auxiliary", {}).get(t) or {}).get("provider") == "byok-conta" and (d["auxiliary"][t]).get("model") == "barato-1"
                                                                  for t in ("title_generation", "compression")), str(d.get("auxiliary"))[:300])
check("2: o modelo principal fica como estava", (d.get("model") or {}).get("default") == "principal-1" and (d.get("model") or {}).get("provider") == "byok-conta", str(d.get("model")))
check("2: nada de endereço ou chave gravado na tarefa", not any(k in (d["auxiliary"]["compression"]) for k in ("base_url", "api_key")), str(d["auxiliary"]["compression"]))
st = ponte("GET", "/api/model/auxiliary")
check("2: a leitura devolve a escolha, e as outras seguem no principal",
      linha(st[1], "title_generation")["model"] == "barato-1" and linha(st[1], "compression")["provider"] == "byok-conta"
      and all(t["provider"] == "auto" for t in st[1]["tasks"] if t["task"] not in ("title_generation", "compression")), str(st[1]["tasks"])[:400])
for t in ("title_generation", "compression"):
    r = _resolve_task_provider_model(t)
    check(f"3: o resolvedor do Hermes passa a devolver o modelo escolhido ({t})", r[0] == "byok-conta" and r[1] == "barato-1", str(r))
m1 = chamar("title_generation")
check("3: dar nome à conversa chega ao provedor com o modelo escolhido", m1 == ("barato-1", "Resumo curto do pedido"), str(m1))
m2 = chamar("compression")
check("3: resumir a conversa também", m2[0] == "barato-1", str(m2))
m3 = chamar("approval")
check("3: tarefa sem escolha continua no principal", m3[0] == "principal-1", str(m3))

# o título de verdade, pela função que o motor chama no fim do primeiro pedido de uma conversa
try:
    from agent.title_generator import generate_title  # noqa: E402

    antes = len(pedidos)
    titulo = generate_title("Preciso do relatório de vendas da semana com os dez maiores clientes")
    check("3: generate_title (o nome da conversa de verdade) usa o modelo escolhido", pedidos[antes:] == ["barato-1"] and bool(titulo), f"{pedidos[antes:]} {titulo!r}")
except ImportError as exc:  # este Python não tem a função: as chamadas acima já provam
    print(f"      (sem generate_title aqui: {exc})")

# ---------- 4) a tarefa de plugin que segue a base
st = ponte("GET", "/api/model/auxiliary")
ml = linha(st[1], "memoria_longa")
check("4: a tarefa do plugin segue a de resumir: sem escolha própria, resolve para o modelo dela",
      ml["provider"] == "auto" and ml.get("effective", {}).get("provider") == "byok-conta" and ml["effective"].get("model") == "barato-1", str(ml))
check("4: e roda com ele", chamar("memoria_longa")[0] == "barato-1")
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "memoria_longa", "provider": "byok-conta", "model": "ajudante-1"})
check("4: e pode ter o próprio modelo", st[0] == 200 and chamar("memoria_longa")[0] == "ajudante-1" and chamar("compression")[0] == "barato-1", str(st))

# voltar a usar o principal
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "title_generation", "provider": "auto", "model": ""})
check("2: 'usar o principal' (auto) grava", st[0] == 200 and st[1].get("ok") is True, str(st))
check("3: e a tarefa volta a rodar com o principal", _resolve_task_provider_model("title_generation")[:2] == ("auto", None) and chamar("title_generation")[0] == "principal-1")
check("2: sem mexer na outra", chamar("compression")[0] == "barato-1")

# ---------- 5) os ajudantes temporários
from tools.delegate_tool_config import _load_config as delegacao_do_motor  # noqa: E402
from tools.delegate_tool_config import _resolve_delegation_credentials  # noqa: E402

check("5: sem escolha, vazio (o modelo de quem pediu a ajuda)", ponte("GET", "/ergon/v1/delegacao") == (200, {"provider": "", "model": ""}), str(ponte("GET", "/ergon/v1/delegacao")))
outras = {k: v for k, v in (delegacao_do_motor() or {}).items() if k not in ("provider", "model")}
st = ponte("PUT", "/ergon/v1/delegacao", {"provider": "byok-conta", "model": "ajudante-1"})
check("5: a ponte grava o modelo dos ajudantes", st == (200, {"ok": True, "provider": "byok-conta", "model": "ajudante-1"}), str(st))
dm = delegacao_do_motor()
check("5: o motor lê delegation.provider/model no próximo pedido, sem reiniciar", dm.get("provider") == "byok-conta" and dm.get("model") == "ajudante-1", str(dm)[:200])
check("5: o resto da delegação fica como estava", {k: v for k, v in dm.items() if k not in ("provider", "model")} == outras, str(dm)[:300])
try:
    cred = _resolve_delegation_credentials(dm, None)
    check("5: a delegação do Hermes resolve o ajudante para esse modelo, nessa conta",
          cred.get("model") == "ajudante-1" and str(cred.get("base_url") or "").rstrip("/") == BASE and cred.get("api_key") == CHAVE, str({k: cred.get(k) for k in ("model", "provider", "base_url")}))
except Exception as exc:  # noqa: BLE001
    check("5: a delegação do Hermes resolve o ajudante para esse modelo", False, f"{type(exc).__name__}: {exc}")
check("5: a ponte devolve a escolha", ponte("GET", "/ergon/v1/delegacao") == (200, {"provider": "byok-conta", "model": "ajudante-1"}))
st = ponte("PUT", "/ergon/v1/delegacao", {"provider": "", "model": ""})
dm = delegacao_do_motor()
check("5: vazio volta ao modelo de quem pediu", st[0] == 200 and not dm.get("provider") and not dm.get("model") and _resolve_delegation_credentials(dm, None).get("model") is None, str(dm)[:200])
for ruim in ({"provider": "byok-conta", "model": ""}, {"provider": "", "model": "x"}, {"provider": "A B", "model": "x"}, {"provider": "byok-conta", "model": "x y"}):
    check(f"5: {ruim!r} recusado", ponte("PUT", "/ergon/v1/delegacao", ruim)[0] == 400)
check("5: sem o token, nada", ponte("PUT", "/ergon/v1/delegacao", {"provider": "byok-conta", "model": "ajudante-1"}, token="")[0] == 401 and not delegacao_do_motor().get("model"))
check("2: e as tarefas de apoio continuam como estavam", chamar("compression")[0] == "barato-1" and disco()["model"]["default"] == "principal-1")

# ---------- 6) por perfil
antes_motor = json.dumps(disco(), sort_keys=True)
st = ponte("GET", f"/p/{PERFIL}/api/model/auxiliary")
check("6: o perfil tem a própria lista, ainda no principal", st[0] == 200 and all(t["provider"] == "auto" for t in st[1]["tasks"]) and len(st[1]["tasks"]) >= 12, str(st)[:300])
check("6: (a ponte pede ao painel com ?profile=)", vistos_no_painel[-1][:3] == ("GET", "/api/model/auxiliary", f"profile={PERFIL}"), str(vistos_no_painel[-1]))
st = ponte("POST", f"/p/{PERFIL}/api/model/set", {"scope": "auxiliary", "task": "vision", "provider": "byok-conta", "model": "ajudante-1"})
check("6: grava a tarefa no perfil", st[0] == 200 and st[1].get("ok") is True, str(st))
dp = disco(PERFIL)
check("6: no config.yaml do perfil", (dp.get("auxiliary", {}).get("vision") or {}).get("model") == "ajudante-1", str(dp.get("auxiliary"))[:200])
check("6: o do motor não mudou", json.dumps(disco(), sort_keys=True) == antes_motor)
check("6: a leitura do perfil devolve; a do motor, não", linha(ponte("GET", f"/p/{PERFIL}/api/model/auxiliary")[1], "vision")["model"] == "ajudante-1"
      and linha(ponte("GET", "/api/model/auxiliary")[1], "vision")["provider"] == "auto")
st = ponte("PUT", f"/p/{PERFIL}/ergon/v1/delegacao", {"provider": "byok-conta", "model": "barato-1"})
check("6: os ajudantes do perfil", st[0] == 200 and (disco(PERFIL).get("delegation") or {}).get("model") == "barato-1" and not (disco().get("delegation") or {}).get("model"), str(st))
check("6: e a leitura deles", ponte("GET", f"/p/{PERFIL}/ergon/v1/delegacao") == (200, {"provider": "byok-conta", "model": "barato-1"}) and ponte("GET", "/ergon/v1/delegacao")[1].get("model") == "")
# o motor, rodando no perfil, usa o que o perfil gravou
try:
    from hermes_cli.web_server_profiles import _config_profile_scope  # noqa: E402

    with _config_profile_scope(PERFIL):
        r = _resolve_task_provider_model("vision")
    check("6: no perfil, o resolvedor do Hermes devolve o modelo do perfil", r[0] == "byok-conta" and r[1] == "ajudante-1", str(r))
    check("6: fora dele, o do motor", _resolve_task_provider_model("vision")[:2] == ("auto", None))
except ImportError as exc:
    print(f"      (sem o escopo de perfil aqui: {exc})")
st = ponte("GET", "/p/perfil-que-nao-existe/api/model/auxiliary")
check("6: perfil que não existe: o Hermes recusa (404), nada é criado", st[0] == 404 and not os.path.exists(os.path.join(HOME, "profiles", "perfil-que-nao-existe")), str(st))
st = ponte("POST", "/p/perfil-que-nao-existe/api/model/set", {"scope": "auxiliary", "task": "vision", "provider": "byok-conta", "model": "barato-1"})
check("6: nem na gravação", st[0] == 404 and not os.path.exists(os.path.join(HOME, "profiles", "perfil-que-nao-existe")), str(st))

# ---------- 7) recusas da ponte
n_painel = len(vistos_no_painel)
antes_motor = json.dumps(disco(), sort_keys=True)
for ruim in ({"scope": "auxiliary", "task": "", "provider": "byok-conta", "model": "barato-1"},  # no Hermes, tarefa vazia = TODAS de uma vez
             {"scope": "auxiliary", "task": "Vision", "provider": "byok-conta", "model": "barato-1"},
             {"scope": "auxiliary", "task": "vision", "provider": "byok-conta", "model": ""},
             {"scope": "auxiliary", "task": "vision", "provider": "auto", "model": "barato-1"},
             {"scope": "auxiliary", "task": "vision", "provider": "A B", "model": "barato-1"}):
    check(f"7: {ruim!r} recusado pela ponte", ponte("POST", "/api/model/set", ruim)[0] == 400)
check("7: e nada disso chegou ao painel", len(vistos_no_painel) == n_painel)
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "nao_existe", "provider": "byok-conta", "model": "barato-1"})
check("7: tarefa que o Hermes não tem: ele recusa (400)", st[0] == 400, str(st))
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "vision", "provider": "byok-conta", "model": "barato-1", "base_url": "http://10.0.0.1/v1", "api_key": "segredo-que-nao-passa",
                                      "reasoning_effort": "max", "profile": PERFIL})
check("7: endereço, chave, esforço e perfil no corpo não passam da ponte", st[0] == 200 and set(vistos_no_painel[-1][3]) == {"scope", "task", "provider", "model", "confirm_expensive_model"}, str(vistos_no_painel[-1]))
dv = disco()["auxiliary"]["vision"]
check("7: gravou só a conta e o modelo, no motor (não no perfil do corpo)", dv.get("model") == "barato-1" and "base_url" not in dv and "api_key" not in dv and not dv.get("reasoning_effort")
      and disco(PERFIL)["auxiliary"]["vision"]["model"] == "ajudante-1", str(dv))
for caminho in (f"/p/{PERFIL}/api/config", f"/p/{PERFIL}/ergon/v1/passos", f"/p/{PERFIL}/api/skills", "/p/../api/model/auxiliary", "/p/A%20B/api/model/auxiliary", f"/p/{PERFIL}/ergon/v1/byok"):
    check(f"7: {caminho} não é rota da ponte", ponte("GET", caminho)[0] == 404)
st = ponte("POST", "/api/model/set", {"provider": "byok-conta", "model": "principal-1"})
check("7: o modelo principal continua pela mesma rota (scope main), como antes", st[0] == 200 and vistos_no_painel[-1][3].get("scope") == "main", str(st)[:200])
st = ponte("POST", "/api/model/set", {"scope": "auxiliary", "task": "__reset__", "provider": "x", "model": "y"})
check("7: __reset__ volta todas ao principal", st[0] == 200 and all(t["provider"] == "auto" and t["model"] == "" for t in ponte("GET", "/api/model/auxiliary")[1]["tasks"]), str(st))
check("7: e o motor volta a usar o principal em tudo", chamar("compression")[0] == "principal-1" and chamar("memoria_longa")[0] == "principal-1")

# ---------- 8) quais modelos enxergam imagens
st = ponte("POST", "/ergon/v1/modelos/visao", {"modelos": [{"provider": "byok-conta", "model": "barato-1"}, {"provider": "A B", "model": "x"}, "lixo", {"provider": "nous", "model": "anthropic/claude-opus-4.6"}]})
check("8: uma resposta por modelo (sim, não ou não se sabe)", st[0] == 200 and len(st[1].get("visao", [])) == 4 and all(v in (True, False, None) for v in st[1]["visao"]) and st[1]["visao"][1] is None and st[1]["visao"][2] is None, str(st))
print(f"      (o que este motor sabe, sem rede: {st[1].get('visao')})")
check("8: sem o token, nada", ponte("POST", "/ergon/v1/modelos/visao", {"modelos": []}, token="")[0] == 401)

print("\nTUDO CERTO" if ok else "\nHOUVE FALHA")
sys.exit(0 if ok else 1)

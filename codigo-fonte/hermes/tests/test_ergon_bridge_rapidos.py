"""rc.27, ganhos rápidos: o que o Ergon liga no Hermes pela ponte de controle e pelo plugin, no motor de verdade (sem rede,
HERMES_HOME descartável, modelo falso, Ergon simulado).

Confere:
  1. ajustes (/ergon/v1/ajustes), gravados pela rota de verdade do painel interno: modelos reserva (o motor passa a carregar
     a cadeia no próximo agente), não treinar com os dados, busca privada (recusada num motor sem a busca direta: a equipe
     não fica sem busca), arrumar competências sem uso, idioma das mensagens do motor;
  2. "não treinar com os meus dados" vai de fato em cada chamada pelo OpenRouter (o laço do motor com o modelo falso), e
     não vai para outros provedores nem com a escolha desligada;
  3. pausa (/ergon/v1/pausa): a parada geral do Hermes liga e desliga, e os agendamentos do motor a respeitam;
  4. cota (/ergon/v1/cota): o resumo dos limites e do saldo a partir do que o Hermes lê do provedor (sem credenciais);
  5. gravações automáticas: a revisão de fundo do Hermes (cria competência sozinha depois da conversa) não grava nada fora
     de um treinamento autorizado; com o padrão do Ergon (revisão ligada, intervalo 0 das competências) só a anotação de
     memória dispara, e o que ela grava fica em espera; a competência treinada fica fixada (no motor e em cada perfil) e a
     arrumação automática (Curator) não a arquiva, mesmo ligada e com a competência sem uso há meses; desligada (o padrão
     do Ergon), ela nem roda.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_rapidos.py
"""
import asyncio
import json
import os
import shutil
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("""plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, web, skills, ergon_conexoes]
tools:
  tool_search:
    enabled: "off"
skills:
  write_approval: true
agent:
  max_turns: 20
model:
  provider: openai-codex
  default: modelo-falso
""")
TOKEN = "token-da-ponte-de-teste-0123456789"
os.environ["HERMES_PLATFORM"] = "api_server"
os.environ["ERGON_BRIDGE_TOKEN"] = TOKEN
os.environ.pop("ERGON_CONTROL_PORT", None)  # a ponte de controle sobe aqui, só no 127.0.0.1
os.environ.pop("SEARXNG_URL", None)
sys.path.insert(0, "/opt/hermes")

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


def servir(Handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


class Base(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def responder(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def corpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")


# ---------- Ergon simulado: a política da sessão (um agente comum, com as competências ligadas) e os avisos
NAME = "ergon-abc123-fidias-diagnostico-gc"
policy = {"known": True, "agent": "Fídias", "toolsets": ["todo", "web", "skills"], "holders": {}, "guarded": {}, "skills": [NAME], "bloqueadas": []}
avisos = []


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        if self.path.endswith("/tool-policy"):
            return self.responder(policy)
        avisos.append({"path": self.path, "body": b})
        return self.responder({"ok": True})


os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{servir(Ergon)}/internal/bridge/v1/events"

# ---------- modelo falso, compatível com a API de chat
chamadas = []
roteiro = []


def fala(texto):
    return {"role": "assistant", "content": texto}


def ferramenta(nome, args):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{len(chamadas)}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        chamadas.append({"path": self.path, "body": b})
        m = roteiro.pop(0) if roteiro else fala("Pronto.")
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


PORTA_MODELO = servir(Modelo)
URL_MODELO = f"http://127.0.0.1:{PORTA_MODELO}/v1"
# o mesmo modelo falso num endereço com cara de OpenRouter (o motor e o plugin reconhecem pelo endereço)
URL_OPENROUTER = f"http://127.0.0.1:{PORTA_MODELO}/openrouter.ai/api/v1"

# ---------- o motor de verdade
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
sys.path.insert(0, "/p")
import ergon_bridge as bridge  # noqa: E402  (o módulo do teste: os auxiliares; o motor carregou a cópia dele de HOME/plugins)
from hermes_cli.config import load_config  # noqa: E402
from run_agent import AIAgent  # noqa: E402

porta = servir(bridge._ControlHandler)


def ponte(metodo, caminho, corpo=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{porta}{caminho}", method=metodo, data=None if corpo is None else json.dumps(corpo).encode(),
                                 headers={"Content-Type": "application/json", **({"X-Ergon-Bridge-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


# o painel interno: a rota de verdade dele (PUT /api/config), sem o servidor HTTP — como em test_ergon_bridge_custo.py
try:
    from hermes_cli.web_models import ConfigUpdate  # noqa: E402
    from hermes_cli.web_routers.config_env import update_config  # noqa: E402

    def painel(metodo, caminho, query, corpo):
        if metodo == "PUT" and caminho == "/api/config":
            asyncio.run(update_config(ConfigUpdate(config=corpo["config"])))
            return 200, b'{"ok": true}'
        return 404, b"{}"
    pelo_painel = True
except Exception as exc:  # noqa: BLE001 - sem o painel neste Python: a mesma mescla, pelas funções do Hermes
    print(f"      (sem o painel interno aqui: {type(exc).__name__}; mescla pelas funções do Hermes)")
    from hermes_cli.config import _deep_merge, read_raw_config, save_config  # noqa: E402

    def painel(metodo, caminho, query, corpo):
        save_config(_deep_merge(read_raw_config(), corpo["config"]))
        return 200, b'{"ok": true}'
    pelo_painel = False
bridge._dash_call = painel

# ================================================================ 1. ajustes
st = ponte("GET", "/ergon/v1/health")
check("saúde: o motor diz que sabe os ajustes, a cota, a pausa e o não treinar",
      st[0] == 200 and {"ajustes", "cota", "pausa", "nao_treinar"} <= set(st[1].get("capacidades") or []), str(st))
st = ponte("GET", "/ergon/v1/ajustes")
check("ajustes: motor sem escolha nenhuma (os padrões do Hermes): sem reserva, treino permitido, busca comum, arrumação LIGADA, inglês",
      st[0] == 200 and st[1].get("reserva") == [] and st[1].get("nao_treinar") is False and st[1].get("busca_privada") is False
      and st[1].get("arrumar_competencias") is True and st[1].get("idioma") == "en", str(st))
check("ajustes: sem o token, nada", ponte("GET", "/ergon/v1/ajustes", token="")[0] == 401 and ponte("PUT", "/ergon/v1/ajustes", {"nao_treinar": True}, token="")[0] == 401)

# -- modelos reserva
from gateway.run import GatewayRunner  # noqa: E402

check("reserva: o motor começa sem cadeia", not GatewayRunner._load_fallback_model(), str(GatewayRunner._load_fallback_model()))
RESERVA = [{"provider": "nous", "model": "anthropic/claude-sonnet-4.5"}, {"provider": "openrouter", "model": "openai/gpt-5-mini"}]
st = ponte("PUT", "/ergon/v1/ajustes", {"reserva": RESERVA + [RESERVA[0]]})
check("reserva: a ponte grava, sem repetidos e na ordem", st[0] == 200 and st[1].get("reserva") == RESERVA, str(st))
cadeia = GatewayRunner._load_fallback_model() or []
check("reserva: o motor carrega a cadeia no próximo agente, sem reiniciar (a mesma que a rota de execuções usa)",
      [(e.get("provider"), e.get("model")) for e in cadeia] == [(e["provider"], e["model"]) for e in RESERVA], str(cadeia))
st = ponte("PUT", "/ergon/v1/ajustes", {"reserva": [{"provider": f"p{i}", "model": f"m/{i}"} for i in range(9)]})
check("reserva: no máximo 5", st[0] == 200 and len(st[1].get("reserva") or []) == bridge.RESERVA_MAX == 5, str(st))
for ruim in ("nous", [{"provider": "nous"}], [{"provider": "a b", "model": "x"}], [{"provider": "nous", "model": "x y; rm"}], [["nous", "x"]]):
    check(f"reserva: {str(ruim)[:40]!r} recusada", ponte("PUT", "/ergon/v1/ajustes", {"reserva": ruim})[0] == 400)
st = ponte("PUT", "/ergon/v1/ajustes", {"reserva": []})
check("reserva: lista vazia desliga", st[0] == 200 and st[1].get("reserva") == [] and not GatewayRunner._load_fallback_model(), str(st))

# -- busca privada: este motor não traz o pacote da busca direta → recusada, e a busca de hoje continua
from agent import web_search_registry as wsr  # noqa: E402

tem_ddgs = bridge.busca_privada_backend() == "ddgs"
antes = getattr(wsr._resolve(None, capability="search"), "name", None)
if not tem_ddgs:
    st = ponte("PUT", "/ergon/v1/ajustes", {"busca_privada": True})
    check("busca privada, motor sem a busca direta: recusada com o motivo (a equipe não fica sem busca)",
          st[0] == 409 and st[1].get("codigo") == "busca_privada_indisponivel", str(st))
    check("busca privada recusada: nada mudou na busca", getattr(wsr._resolve(None, capability="search"), "name", None) == antes
          and ponte("GET", "/ergon/v1/ajustes")[1].get("busca_privada_disponivel") is False, str(antes))
# com a busca direta instalada (aqui, dita pelo teste; na imagem nova, o pacote está lá)
real_backend = bridge.busca_privada_backend
bridge.busca_privada_backend = lambda: "ddgs"
st = ponte("PUT", "/ergon/v1/ajustes", {"busca_privada": True})
web = load_config().get("web") or {}
check("busca privada: sem os serviços gratuitos de terceiros e com a busca direta", st[0] == 200 and st[1].get("busca_privada") is True
      and web.get("keyless_fallback") is False and web.get("search_backend") == "ddgs", str((st, {k: web.get(k) for k in ("keyless_fallback", "search_backend")})))
check("busca privada: o Hermes deixa de usar o anel gratuito, e a leitura de páginas fica sem leitor fixado",
      wsr._keyless_tier_enabled() is False and web.get("extract_backend") == "", str(web.get("extract_backend")))
escolhido = wsr._resolve(wsr._read_config_key("web", "search_backend"), capability="search")
check("busca privada: a busca do motor passa a ser a direta (DuckDuckGo)", getattr(escolhido, "name", None) == "ddgs", str(getattr(escolhido, "name", None)))
check("busca privada: ler página inteira fica sem serviço (no Hermes, só por terceiros)", wsr._resolve(None, capability="extract") is None,
      str(getattr(wsr._resolve(None, capability="extract"), "name", None)))
st = ponte("PUT", "/ergon/v1/ajustes", {"busca_privada": False})
web = load_config().get("web") or {}
check("busca privada desligada: a leitura de páginas volta pela Exa, sem chave (a experiência completa da migração 10)", web.get("extract_backend") == "exa", str(web))
check("busca privada desligada: volta ao que era", st[0] == 200 and st[1].get("busca_privada") is False and web.get("keyless_fallback", True) is True
      and not web.get("search_backend") and getattr(wsr._resolve(None, capability="search"), "name", None) == antes, str((st, web.get("search_backend"))))
bridge.busca_privada_backend = real_backend

# -- anotar na memória depois da conversa (a revisão de fundo do Hermes só com a parte de memória) e profundidade do raciocínio
st = ponte("GET", "/ergon/v1/ajustes")
check("ajustes: o motor sem escolha diz a anotação de memória (padrão do Hermes: ligada) e o raciocínio (o que está gravado)",
      st[0] == 200 and st[1].get("anotar_memoria") is True and isinstance(st[1].get("raciocinio"), str), str(st))
st = ponte("PUT", "/ergon/v1/ajustes", {"anotar_memoria": False})
_cfg = load_config()
check("anotar na memória desligado: a revisão de fundo desligada e a de competências com intervalo 0",
      st[0] == 200 and st[1].get("anotar_memoria") is False and _cfg["auxiliary"]["background_review"]["enabled"] is False
      and _cfg["skills"]["creation_nudge_interval"] == 0 and _cfg["skills"].get("write_approval") is True, str((st, _cfg.get("skills"))))
st = ponte("PUT", "/ergon/v1/ajustes", {"anotar_memoria": True})
check("anotar na memória ligado de novo (a revisão de competências continua de fora)", st[0] == 200 and st[1].get("anotar_memoria") is True
      and load_config()["skills"]["creation_nudge_interval"] == 0, str(st))
for nivel in ("high", "medium", "low", ""):
    st = ponte("PUT", "/ergon/v1/ajustes", {"raciocinio": nivel})
    check(f"raciocínio {nivel or 'do modelo'}: gravado em agent.reasoning_effort", st[0] == 200 and st[1].get("raciocinio") == nivel
          and str(load_config()["agent"].get("reasoning_effort") or "") == nivel, str(st))
for ruim in ("ultra", "xhigh", True, 3):
    check(f"raciocínio {ruim!r}: recusado", ponte("PUT", "/ergon/v1/ajustes", {"raciocinio": ruim})[0] == 400)
check("anotar na memória: valor que não é sim ou não, recusado", ponte("PUT", "/ergon/v1/ajustes", {"anotar_memoria": "sim"})[0] == 400)
ponte("PUT", "/ergon/v1/ajustes", {"raciocinio": "high"})

# -- idioma das mensagens do motor
from agent import i18n  # noqa: E402

st = ponte("PUT", "/ergon/v1/ajustes", {"idioma": "pt"})
with __import__("contextlib").suppress(Exception):
    i18n.reset_language_cache()
check("idioma: gravado, e o motor passa a falar português nas mensagens fixas", st[0] == 200 and st[1].get("idioma") == "pt" and i18n.get_language() == "pt", str((st, i18n.get_language())))
check("idioma: só pt e en", ponte("PUT", "/ergon/v1/ajustes", {"idioma": "xx"})[0] == 400 and ponte("PUT", "/ergon/v1/ajustes", {"idioma": "en"})[0] == 200)
for ruim in ({}, {"outra": 1}, {"nao_treinar": "sim"}, {"arrumar_competencias": 1}, {"busca_privada": None}):
    check(f"ajustes: {ruim!r} recusado", ponte("PUT", "/ergon/v1/ajustes", ruim)[0] == 400)
cfg = load_config()
check("ajustes: o resto da configuração fica (plugin, ferramentas, trava do Treinar)",
      "ergon_conexoes" in (cfg.get("platform_toolsets", {}).get("api_server") or []) and cfg.get("skills", {}).get("write_approval") is True
      and cfg.get("agent", {}).get("max_turns") == 20, str({k: cfg.get(k) for k in ("platform_toolsets", "skills", "agent")})[:300])

# ================================================================ 2. não treinar com os meus dados
def agente(sessao, url=URL_MODELO, conjuntos=("todo",)):
    return AIAgent(base_url=url, api_key="chave-falsa", provider="custom", model="modelo-falso", max_iterations=8, quiet_mode=True,
                   enabled_toolsets=list(conjuntos), session_id=sessao, platform="api_server", skip_memory=True, skip_context_files=True)


def pedido_ao_provedor(url, sessao):
    chamadas.clear()
    roteiro[:] = [fala("Certo.")]
    agente(sessao, url).run_conversation("oi", task_id=sessao)
    return chamadas[-1]["body"] if chamadas else {}


from hermes_cli.middleware import apply_llm_request_middleware  # noqa: E402

corpo = pedido_ao_provedor(URL_OPENROUTER, "s-treino-0")
check("não treinar, escolha desligada: o pedido ao OpenRouter vai sem o pedido de privacidade", "provider" not in corpo or "data_collection" not in (corpo.get("provider") or {}), str(corpo.get("provider")))
st = ponte("PUT", "/ergon/v1/ajustes", {"nao_treinar": True})
check("não treinar: gravado (provider_routing.data_collection: deny)", st[0] == 200 and st[1].get("nao_treinar") is True
      and (load_config().get("provider_routing") or {}).get("data_collection") == "deny", str(st))
# o motor carregou a cópia do plugin de HOME/plugins: a memória curta dela (15 s) é zerada pelo intermediário do próprio Hermes
r = apply_llm_request_middleware({"model": "m", "messages": [{"role": "user", "content": "oi"}]}, base_url="https://openrouter.ai/api/v1", provider="openrouter", model="m")
for _ in range(40):
    if (r.payload.get("extra_body") or {}).get("provider", {}).get("data_collection") == "deny":
        break
    time.sleep(0.5)
    r = apply_llm_request_middleware({"model": "m", "messages": [{"role": "user", "content": "oi"}]}, base_url="https://openrouter.ai/api/v1", provider="openrouter", model="m")
check("não treinar: o intermediário do Hermes põe o pedido no corpo (extra_body.provider.data_collection)",
      (r.payload.get("extra_body") or {}).get("provider", {}).get("data_collection") == "deny" and r.changed, str(r.payload.get("extra_body")))
r2 = apply_llm_request_middleware({"model": "m", "messages": [], "extra_body": {"provider": {"sort": "price"}, "outra": 1}}, base_url="https://openrouter.ai/api/v1")
check("não treinar: o que já estava no corpo fica (outras preferências de provedor)",
      r2.payload.get("extra_body") == {"provider": {"sort": "price", "data_collection": "deny"}, "outra": 1}, str(r2.payload.get("extra_body")))
corpo = pedido_ao_provedor(URL_OPENROUTER, "s-treino-1")
check("não treinar: no laço de verdade, o pedido chega ao OpenRouter com data_collection = deny",
      (corpo.get("provider") or {}).get("data_collection") == "deny", str({k: corpo.get(k) for k in corpo if k not in ("messages", "tools")})[:300])
corpo = pedido_ao_provedor(URL_MODELO, "s-treino-2")
check("não treinar: outro provedor não recebe campo que não entende", "provider" not in corpo, str(corpo.get("provider")))
r3 = apply_llm_request_middleware({"model": "m", "messages": []}, base_url="https://api.openai.com/v1")
check("não treinar: fora do OpenRouter o intermediário não muda nada", not r3.changed and "extra_body" not in r3.payload)
check("não treinar: o plugin nunca derruba a chamada (entrada estranha)", bridge.on_llm_request(request=None, base_url=None) is None
      and bridge.on_llm_request(request={"messages": [], "extra_body": "x"}, base_url="https://openrouter.ai/api/v1") is not None)
st = ponte("PUT", "/ergon/v1/ajustes", {"nao_treinar": False})
check("não treinar desligado: gravado como permitido", st[0] == 200 and st[1].get("nao_treinar") is False
      and (load_config().get("provider_routing") or {}).get("data_collection") == "allow", str(st))

# ================================================================ 3. pausa
from agent import estop  # noqa: E402

check("pausa: começa solta", ponte("GET", "/ergon/v1/pausa") == (200, {"pausada": False, "desde": None}) and not estop.is_engaged())
st = ponte("PUT", "/ergon/v1/pausa", {"pausada": True})
check("pausa: a ponte liga a parada geral do motor", st[0] == 200 and st[1].get("pausada") is True and isinstance(st[1].get("desde"), str)
      and estop.is_engaged() and os.path.exists(os.path.join(HOME, "ESTOP")), str(st))
import logging  # noqa: E402

check("pausa: os agendamentos e os canais diretos do motor param de começar trabalho", estop.check_paused("cron", logging.getLogger("teste")) is True
      and bool(estop.paused_reply()))
desde = st[1].get("desde")
st = ponte("PUT", "/ergon/v1/pausa", {"pausada": True})
check("pausa: pausar de novo não muda a hora da pausa", st[0] == 200 and st[1].get("desde") == desde, str(st))
check("pausa: sem o token, nada", ponte("PUT", "/ergon/v1/pausa", {"pausada": False}, token="")[0] == 401 and estop.is_engaged())
check("pausa: valor estranho recusado", ponte("PUT", "/ergon/v1/pausa", {"pausada": "sim"})[0] == 400 and estop.is_engaged())
st = ponte("PUT", "/ergon/v1/pausa", {"pausada": False})
check("pausa: retomar solta", st == (200, {"ok": True, "pausada": False, "desde": None}) and not estop.is_engaged()
      and estop.check_paused("cron", logging.getLogger("teste")) is False, str(st))

# ================================================================ 4. cota
from agent import account_usage as au  # noqa: E402

agora = datetime.now(timezone.utc)
snap = au.AccountUsageSnapshot(provider="openai-codex", source="usage_api", fetched_at=agora, plan="Plus", windows=(
    au.AccountUsageWindow(label="Session", used_percent=12.34, reset_at=agora + timedelta(hours=3)),
    au.AccountUsageWindow(label="Weekly", used_percent=61.0, reset_at=agora + timedelta(days=4)),
    au.AccountUsageWindow(label="Novidade", used_percent=140.0)), details=("Credits balance: $7.50", "You have 1 reset banked - use /usage reset to activate"),
    identity="alguem@exemplo", raw={"segredo": "nao-pode-sair"})
r = bridge.cota_resumo(snap)
check("cota: as janelas da assinatura (5 horas e semana) com o usado e quando renova",
      r is not None and [(j["tipo"], j["usado"]) for j in r["janelas"]] == [("sessao", 12.3), ("semana", 61.0), ("outro", 100.0)]
      and r["janelas"][1]["renova_em"].startswith(str((agora + timedelta(days=4)).date())) and r["plano"] == "Plus" and r["saldo_usd"] == 7.5, str(r))
check("cota: nada do corpo cru, da identidade nem das instruções de comando", "nao-pode-sair" not in json.dumps(r) and "alguem@" not in json.dumps(r) and "/usage" not in json.dumps(r))
conta = types.SimpleNamespace(logged_in=True, paid_service_access=True, portal_base_url=None, org_slug=None,
                              subscription=types.SimpleNamespace(monthly_credits=20.0, credits_remaining=5.0, rollover_credits=0, current_period_end="2026-12-01", plan="plus"),
                              paid_service_access_info=types.SimpleNamespace(subscription_credits_remaining=5.0, purchased_credits_remaining=2.0, total_usable_credits=7.0))
try:
    r = bridge.cota_resumo(au.build_nous_credits_snapshot(conta))
except Exception as exc:  # noqa: BLE001
    r = f"{type(exc).__name__}: {exc}"
check("cota: os créditos do Nous Portal (75% usados, saldo de 7, renova na data do plano)", isinstance(r, dict) and r["provedor"] == "nous"
      and r["janelas"] and r["janelas"][0]["tipo"] == "assinatura" and r["janelas"][0]["usado"] == 75.0 and r["saldo_usd"] == 7.0 and r["renova_em"] == "2026-12-01", str(r))
check("cota: nada a mostrar = None", bridge.cota_resumo(None) is None and bridge.cota_resumo(au.AccountUsageSnapshot(provider="x", source="y", fetched_at=agora)) is None)
pedidos_cota = []
au.fetch_account_usage = lambda provedor, **_k: (pedidos_cota.append(provedor), snap)[1]
au._nous_logged_in = lambda: False
st = ponte("GET", "/ergon/v1/cota")
check("cota: a ponte pergunta pela conta do modelo padrão e devolve o resumo", st[0] == 200 and pedidos_cota == ["openai-codex"]
      and len(st[1].get("contas") or []) == 1 and st[1]["contas"][0]["janelas"][1]["usado"] == 61.0 and isinstance(st[1].get("agora"), (int, float)), str(st)[:300])
ponte("GET", "/ergon/v1/cota")
check("cota: guardada por alguns minutos (o provedor não é perguntado a cada tela)", pedidos_cota == ["openai-codex"], str(pedidos_cota))
ponte("GET", "/ergon/v1/cota?atualizar=1")
check("cota: 'atualizar' pergunta de novo", pedidos_cota == ["openai-codex", "openai-codex"], str(pedidos_cota))
au.fetch_account_usage = lambda provedor, **_k: (_ for _ in ()).throw(RuntimeError("sem rede"))
st = ponte("GET", "/ergon/v1/cota?atualizar=1")
check("cota: provedor fora do ar = lista vazia, sem erro", st[0] == 200 and st[1].get("contas") == [], str(st))
check("cota: sem o token, nada", ponte("GET", "/ergon/v1/cota", token="")[0] == 401)

# ================================================================ 5. gravações automáticas do Hermes
from tools import skill_usage, write_approval as wa  # noqa: E402

SKILL_MD = "---\nname: x\ndescription: Diagnóstico de GC.\n---\n# Diagnóstico\n\nPasso 1: conferir a linha de base.\n"
CONTROLE = "controle-sem-uso"
SKILLS = os.path.join(HOME, "skills")


def existe(nome):
    return bool(bridge._skill_dir(nome))


# -- a revisão de fundo (cria competência sozinha depois da conversa): fora de um treinamento autorizado, nada é gravado
from agent.background_review import load_background_review_settings  # noqa: E402

ligada, _cfg_rev = load_background_review_settings()
check("revisão de fundo: ligada por padrão no Hermes (por isso a conferência)", ligada is True)
pai = agente("s-revisao", conjuntos=("todo", "skills"))
check("revisão de fundo: o agente do Ergon tem skill_manage à vista (é o que dispara a revisão de competências)", "skill_manage" in pai.valid_tool_names)
roteiro[:] = [fala("Feito.")]
pai.run_conversation("organize a planilha", task_id="s-revisao")
chamadas.clear(); avisos.clear()
NOVA = "aprendizado-automatico"
roteiro[:] = [ferramenta("skill_manage", {"action": "create", "name": NOVA, "category": "geral", "content": SKILL_MD}),
              ferramenta("skill_manage", {"operations": [{"action": "create", "name": NAME, "category": "ergon", "content": SKILL_MD}]}),
              fala("Nada a salvar.")]
antes_fios = {t.ident for t in threading.enumerate()}
pai._spawn_background_review(messages_snapshot=[{"role": "user", "content": "organize a planilha"}, {"role": "assistant", "content": "Feito."}], review_memory=False, review_skills=True)
for _ in range(240):
    if not [t for t in threading.enumerate() if t.name == "bg-review" and t.ident not in antes_fios and t.is_alive()] and len(chamadas) >= 1:
        break
    time.sleep(0.25)
time.sleep(0.5)
retornos = [str(m.get("content")) for c in chamadas for m in c["body"].get("messages", []) if m.get("role") == "tool"]
check("revisão de fundo: rodou de verdade (chamou o modelo e tentou gravar)", len(chamadas) >= 2 and len(retornos) >= 1, f"{len(chamadas)} chamadas, {len(retornos)} retornos")
check("revisão de fundo: a escrita foi barrada pela trava do Treinar (competência só em treinamento autorizado)",
      any("treinamento autorizado" in r for r in retornos), str(retornos)[:400])
check("revisão de fundo: nenhuma competência criada", not existe(NOVA) and not existe(NAME), str(os.listdir(SKILLS) if os.path.isdir(SKILLS) else []))
check("revisão de fundo: nada ficou em espera no motor", wa.list_pending(wa.SKILLS) == [], str(wa.list_pending(wa.SKILLS))[:300])
check("revisão de fundo: nenhum aviso de treinamento ao Ergon", not [a for a in avisos if a["path"].endswith("/training-event")], str(avisos)[:300])
print(f"      (a revisão de fundo gastou {len(chamadas)} chamadas ao modelo para não gravar nada)")
# desligada na configuração (o padrão do Ergon a partir da rc.27): não chama o modelo
painel("PUT", "/api/config", "", {"config": {"auxiliary": {"background_review": {"enabled": False}}}})
chamadas.clear()
pai._spawn_background_review(messages_snapshot=[{"role": "user", "content": "x"}, {"role": "assistant", "content": "y"}], review_memory=False, review_skills=True)
time.sleep(1.5)
check("revisão de fundo desligada: nenhuma chamada ao modelo", load_background_review_settings()[0] is False and chamadas == [], str(len(chamadas)))

# -- o padrão do Ergon a partir da rc.27 (migração 5): revisão ligada, competências com intervalo 0 — só a anotação de memória
# dispara, depois da entrega, e o que ela grava fica em espera até a pessoa aprovar. A política de ferramentas do Ergon
# continua reconhecendo a sessão depois do fim da execução (a revisão roda depois da entrega).
painel("PUT", "/api/config", "", {"config": {"auxiliary": {"background_review": {"enabled": True}}, "skills": {"creation_nudge_interval": 0},
                                             "memory": {"nudge_interval": 1, "write_approval": True, "memory_enabled": True}}})
policy["toolsets"] = ["todo", "web", "skills", "memory"]
bridge._policy_cache.clear()
from tools import write_approval as wa  # noqa: E402

mem_antes = wa.list_pending(wa.MEMORY)
chamadas.clear()
agm = agente("s-memoria", conjuntos=("todo", "skills", "memory"))
check("anotação de memória: o agente tem memory e skill_manage à vista", {"memory", "skill_manage"} <= set(agm.valid_tool_names), str(sorted(agm.valid_tool_names)))
check("anotação de memória: o agente lê o intervalo 0 das competências", agm._skill_nudge_interval == 0, str(agm._skill_nudge_interval))
NOTA = "A pessoa prefere relatórios curtos, com a conclusão no começo."
roteiro[:] = [fala("Relatório pronto."), ferramenta("memory", {"action": "add", "target": "memory", "content": NOTA}), fala("Anotado.")]
antes_fios = {t.ident for t in threading.enumerate()}
agm.run_conversation("faça o relatório, curto e com a conclusão no começo", task_id="s-memoria")
for _ in range(240):
    if not [t for t in threading.enumerate() if t.name == "bg-review" and t.ident not in antes_fios and t.is_alive()] and len(chamadas) >= 3:
        break
    time.sleep(0.25)
time.sleep(0.5)
pend = [r for r in wa.list_pending(wa.MEMORY) if r not in mem_antes]
textos = json.dumps(pend, ensure_ascii=False)
check("anotação de memória: a revisão rodou depois da entrega (chamou o modelo de novo)", len(chamadas) >= 2, f"{len(chamadas)} chamadas")
check("anotação de memória: a anotação ficou em espera (a pessoa aprova na aba Memória)", NOTA in textos, textos[:400])
check("anotação de memória: nenhuma competência foi tentada (a revisão de competências não dispara com intervalo 0)",
      not any(m.get("role") == "assistant" and "skill_manage" in json.dumps(m.get("tool_calls") or []) for c in chamadas for m in c["body"].get("messages", []))
      and wa.list_pending(wa.SKILLS) == [], str(wa.list_pending(wa.SKILLS))[:300])
print(f"      (a anotação de memória gastou {max(0, len(chamadas) - 1)} chamada(s) a mais ao modelo)")
policy["toolsets"] = ["todo", "web", "skills"]
bridge._policy_cache.clear()
painel("PUT", "/api/config", "", {"config": {"memory": {"nudge_interval": 10}}})

# -- competência treinada (aprovada pela pessoa): fixada; a arrumação automática não a toca
from agent import curator  # noqa: E402

bridge.skills_restore(NAME, {"SKILL.md": SKILL_MD, "references/guia.md": "conteúdo"})
check("treinada: gravada e fixada no motor", existe(NAME) and skill_usage.get_record(NAME).get("pinned") is True, str(skill_usage.get_record(NAME)))
r = bridge._apply_write({"action": "create", "name": CONTROLE, "category": "geral", "content": SKILL_MD.replace("name: x", f"name: {CONTROLE}")})
check("controle: uma competência criada por agente, sem fixar", bool(r.get("success")) and existe(CONTROLE), str(r)[:300])
velho = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
# o pior caso: as duas marcadas como "criadas por agente" (as que o Curator administra) e sem uso há 200 dias
for nome in (NAME, CONTROLE):
    skill_usage.mark_agent_created(nome)
uso = skill_usage.load_usage()
for nome in (NAME, CONTROLE):
    uso[nome].update({"created_at": velho, "last_used_at": velho, "last_viewed_at": velho, "last_patched_at": velho, "last_activity_at": velho, "use_count": 3, "first_seen_at": velho})
skill_usage.save_usage(uso)
check("as duas são administradas pelo Curator e estão paradas há 200 dias", {NAME, CONTROLE} <= set(skill_usage.list_agent_created_skill_names())
      and skill_usage.get_record(NAME).get("pinned") is True and not skill_usage.get_record(CONTROLE).get("pinned"), str(skill_usage.list_agent_created_skill_names()))
# desligada (o padrão do Ergon: migração do cofre): não roda
painel("PUT", "/api/config", "", {"config": {"curator": {"enabled": False}}})
check("arrumação desligada: o Curator não roda", curator.is_enabled() is False and curator.should_run_now() is False
      and curator.maybe_run_curator(idle_for_seconds=float("inf")) is None and existe(CONTROLE) and existe(NAME))
# a pessoa liga "Arrumar competências sem uso": as treinadas são fixadas antes (inclusive uma que tenha perdido a marca)
skill_usage.set_pinned(NAME, False)
st = ponte("PUT", "/ergon/v1/ajustes", {"arrumar_competencias": True})
check("arrumação ligada pela ponte: as treinadas ficam fixadas antes", st[0] == 200 and st[1].get("arrumar_competencias") is True and st[1].get("fixadas") == 1
      and curator.is_enabled() is True and skill_usage.get_record(NAME).get("pinned") is True, str(st))
contagem = curator.apply_automatic_transitions()
check("arrumação ligada: a competência sem uso e sem fixar é arquivada (o Hermes de verdade)", not existe(CONTROLE) and contagem.get("archived") == 1, str(contagem))
check("arrumação ligada: a competência treinada pela pessoa fica onde está, ativa",
      existe(NAME) and skill_usage.get_record(NAME).get("state", "active") == "active" and "SKILL.md" in bridge._read_skill(NAME), str(skill_usage.get_record(NAME)))
# rc.27: a competência treinada que mora no perfil do agente (profiles/<perfil>/skills) também fica fixada
PERF = "erg-" + "0123456789abcdef0123"
NAME_P = "ergon-abc123-hipatia-fontes-datadas"
os.makedirs(os.path.join(HOME, "profiles", PERF, "skills", "ergon", NAME_P), exist_ok=True)
with open(os.path.join(HOME, "profiles", PERF, "skills", "ergon", NAME_P, "SKILL.md"), "w", encoding="utf-8") as f:
    f.write(SKILL_MD.replace("name: x", f"name: {NAME_P}"))
fixadas = bridge.fixar_treinadas()
with bridge._no_perfil(PERF):
    reg_p = skill_usage.get_record(NAME_P) or {}
check("arrumação: a competência treinada dentro do perfil do agente também fica fixada", reg_p.get("pinned") is True and fixadas >= 2, str((fixadas, reg_p)))
st = ponte("PUT", "/ergon/v1/ajustes", {"arrumar_competencias": False})
check("arrumação desligada de novo pela ponte", st[0] == 200 and st[1].get("arrumar_competencias") is False and curator.is_enabled() is False, str(st))
print(f"      (gravado {'pela rota do painel interno' if pelo_painel else 'pelas funções de configuração do Hermes'})")

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

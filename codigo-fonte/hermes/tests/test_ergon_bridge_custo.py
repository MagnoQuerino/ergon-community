"""Custo das chamadas (rc.25), com o laço de verdade do motor e um modelo falso (sem rede, HERMES_HOME descartável, Ergon
simulado).

Confere:
  A) a medição: em cada chamada ao modelo, o plugin guarda o tamanho de cada parte do pedido que foi DE VERDADE ao
     provedor (prompt de sistema, com a memória e a lista de competências separadas; definições das ferramentas;
     conversa) e o total que o provedor informou (entrada, lidos do cache, saída) — sem guardar conteúdo; a ponte de
     controle devolve as chamadas da sessão (/ergon/v1/medicao), com o token;
  B) a busca de ferramentas: ligada, ela esconderia as Conexões atrás dela (toda ferramenta de plugin) para poupar pouco;
     desligada (como o cofre deixa), o agente lista e executa uma ação de conta direto;
  25) os passos por pedido: a ponte grava agent.max_turns (/ergon/v1/passos) e o motor usa o valor no pedido seguinte
     (gateway/run.py, _current_max_iterations), sem reiniciar; fora do intervalo, recusa.
  rc.26) a conversa resumida: o tamanho do resumo (reconhecido pelo próprio Hermes) em cada chamada, sem o texto; e a
     ponte liga e desliga o resumo mais cedo (/ergon/v1/compactacao): ligado, um agente novo resume a partir de 150 mil (96 mil numa janela de 128 mil);
     desligado, só perto do fim da janela, como o Hermes faz sozinho.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_custo.py

Fora da imagem (outro Python com o Hermes v0.22.2): ERGON_HERMES_SRC = pasta do código do Hermes, ERGON_PLUGINS = pasta
hermes/plugins, HERMES_HOME = pasta descartável.
"""
import asyncio
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
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
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("""plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, web, skills, ergon_conexoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
memory:
  memory_enabled: true
""")
# uma nota na memória e uma competência: as duas partes que o motor põe no prompt de sistema
NOTA = "A pessoa prefere relatórios curtos, com a conclusão primeiro."
os.makedirs(os.path.join(HOME, "memories"), exist_ok=True)
with open(os.path.join(HOME, "memories", "MEMORY.md"), "w", encoding="utf-8") as f:
    f.write(NOTA)
os.makedirs(os.path.join(HOME, "skills", "produtividade", "relatorio-curto"), exist_ok=True)
with open(os.path.join(HOME, "skills", "produtividade", "relatorio-curto", "SKILL.md"), "w", encoding="utf-8") as f:
    f.write("---\nname: relatorio-curto\ndescription: Escreve um relatório curto com a conclusão primeiro.\n---\n\nConclusão primeiro, depois os dados.\n")
TOKEN = "token-da-ponte-de-teste-0123456789"
os.environ["HERMES_PLATFORM"] = "api_server"
os.environ["ERGON_BRIDGE_TOKEN"] = TOKEN
os.environ.pop("ERGON_CONTROL_PORT", None)  # a ponte de controle sobe aqui, só no 127.0.0.1
sys.path.insert(0, SRC)

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


# ---------- Ergon simulado
pedidos = []
policy = {"known": True, "agent": "Aspásia", "toolsets": ["todo", "web", "skills", "ergon_conexoes"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        if self.path.endswith("/tool-policy"):
            return self.responder(policy)
        pedidos.append({"path": self.path, "body": b})
        if b.get("op") == "listar":
            return self.responder({"ok": True, "texto": "asana: tarefa.criar (titulo, quadro)"})
        return self.responder({"ok": True, "status": "feita", "texto": "Tarefa criada em Vendas."})


os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{servir(Ergon)}/internal/bridge/v1/events"

# ---------- modelo falso, compatível com a API de chat, que informa o uso como a OpenAI (com a parte lida do cache)
chamadas = []
roteiro = []
USO = {"prompt_tokens": 4321, "completion_tokens": 55, "total_tokens": 4376, "prompt_tokens_details": {"cached_tokens": 4000}}


def fala(texto):
    return {"role": "assistant", "content": texto}


def ferramenta(nome, args):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{len(chamadas)}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        chamadas.append(b)
        m = roteiro.pop(0) if roteiro else fala("Pronto.")
        if b.get("stream"):
            return self.transmitir(b, m)
        return self.responder({"id": "x", "object": "chat.completion", "created": 1, "model": b.get("model", "teste"),
                               "choices": [{"index": 0, "finish_reason": "tool_calls" if m.get("tool_calls") else "stop", "message": m}],
                               "usage": USO})

    def transmitir(self, b, m):
        def pedaco(delta, fim=None, uso=None):
            o = {"id": "x", "object": "chat.completion.chunk", "created": 1, "model": b.get("model", "teste"), "choices": [{"index": 0, "delta": delta, "finish_reason": fim}]}
            if uso:
                o["usage"] = uso
            return "data: " + json.dumps(o) + "\n\n"
        partes = [pedaco({"role": "assistant"})]
        if m.get("content"):
            partes.append(pedaco({"content": m["content"]}))
        for i, t in enumerate(m.get("tool_calls") or []):
            partes.append(pedaco({"tool_calls": [{"index": i, "id": t["id"], "type": "function", "function": {"name": t["function"]["name"], "arguments": t["function"]["arguments"]}}]}))
        partes.append(pedaco({}, "tool_calls" if m.get("tool_calls") else "stop", USO))
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

# ---------- o motor de verdade
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
from run_agent import AIAgent  # noqa: E402

bridge = next(m for m in list(sys.modules.values()) if hasattr(m, "tool_conexoes_executar"))  # o módulo que o Hermes carregou
check("o plugin traz os ganchos do custo", callable(getattr(bridge, "on_pre_api_request", None)) and callable(getattr(bridge, "on_post_api_request", None)))
from hermes_cli.lifecycle import has_hook  # noqa: E402

check("o motor vê os dois ganchos registrados", has_hook("pre_api_request") and has_hook("post_api_request"))

# as instruções do agente no Ergon (vão no fim do prompt de sistema, como o servidor manda em "instructions")
SEGREDO = "palavra-que-nao-pode-ir-para-o-arquivo"
INSTRUCOES = "Você é Aristóteles, coordenador, no Ergon — setor Coordenação.\n" + ("Regra da equipe. " * 300) + SEGREDO
SESSAO = "ergon:ws_teste:conv:cnv_teste:agent:agt_teste"

roteiro[:] = [ferramenta("conexoes_listar", {"conexao": "asana"}),
              ferramenta("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {"titulo": "Revisar a proposta", "quadro": "Vendas"}}),
              fala("Criei a tarefa no Asana.")]
agente = AIAgent(base_url=URL_MODELO, api_key="chave-falsa", provider="custom", model="modelo-falso", max_iterations=8, quiet_mode=True,
                 enabled_toolsets=["todo", "web", "skills", "ergon_conexoes"], session_id=SESSAO, platform="api_server",
                 skip_context_files=True, ephemeral_system_prompt=INSTRUCOES)
r = agente.run_conversation(f"joga no Asana: revisar a proposta ({SEGREDO})", task_id="tarefa-custo")

# ---------- B) o agente lista e executa uma ação de conta, com as ferramentas à vista
ops = [p["body"].get("op") for p in pedidos if p["path"].endswith("/conexoes")]
check("B: o agente listou as ações da conta", "listar" in ops, str(pedidos))
check("B: e executou uma ação de conta", "executar" in ops, str(pedidos))
check("B: a conversa termina com a resposta dele", r.get("final_response") == "Criei a tarefa no Asana.", str(r.get("final_response")))
nomes0 = {t.get("function", {}).get("name") for t in chamadas[0].get("tools", [])} if chamadas else set()
check("B: sem a busca de ferramentas, as Conexões vão à vista", {"conexoes_listar", "conexoes_executar"} <= nomes0 and "tool_search" not in nomes0, str(sorted(n for n in nomes0 if n)))

# ---------- A) a medição, comparada com o que o modelo recebeu de verdade
med = bridge.medicao(SESSAO)
check("A: uma medição por chamada ao modelo", len(med) == len(chamadas) == 3, f"{len(med)} medições, {len(chamadas)} chamadas")
for i, (m, c) in enumerate(zip(med, chamadas)):
    sistema = next((x.get("content") for x in c.get("messages", []) if x.get("role") == "system"), "") or ""
    sistema = sistema if isinstance(sistema, str) else "\n\n".join(p.get("text", "") for p in sistema if isinstance(p, dict))
    tools = c.get("tools") or []
    ferr_real = sum(len(json.dumps(t, ensure_ascii=False, separators=(",", ":"))) for t in tools)
    conv_real = sum(len(json.dumps(x, ensure_ascii=False, separators=(",", ":"))) for x in c.get("messages", []) if x.get("role") != "system")
    check(f"A{i}: o prompt de sistema medido é o que foi ao modelo", m.get("sistema") == len(sistema), f"{m.get('sistema')} × {len(sistema)}")
    check(f"A{i}: as instruções do Ergon estão dentro dele, no fim", sistema.endswith(INSTRUCOES) and m["sistema"] >= len(INSTRUCOES))
    check(f"A{i}: a memória foi achada e separada", m.get("memoria", 0) >= len(NOTA) and NOTA in sistema and m["memoria"] < 1000, str(m.get("memoria")))
    check(f"A{i}: a lista de competências foi achada e separada", m.get("competencias", 0) > 0 and "relatorio-curto" in sistema, str(m.get("competencias")))
    check(f"A{i}: as partes cabem no prompt de sistema", m["memoria"] + m["competencias"] + len(INSTRUCOES) <= m["sistema"])
    check(f"A{i}: as definições de ferramentas batem com as que foram (±3%) e o número bate",
          m.get("ferramentas_exato") is True and m.get("n_ferramentas") == len(tools) and abs(m.get("ferramentas", 0) - ferr_real) <= ferr_real * 0.03,
          f"{m.get('ferramentas')} × {ferr_real} ({m.get('n_ferramentas')} × {len(tools)})")
    check(f"A{i}: a conversa medida bate com a que foi (±3%)", abs(m.get("conversa", 0) - conv_real) <= max(50, conv_real * 0.03), f"{m.get('conversa')} × {conv_real}")
    check(f"A{i}: o total informado pelo provedor, com a parte do cache", m.get("uso") == {"entrada": 4321, "cache_lido": 4000, "cache_gravado": 0, "saida": 55}, str(m.get("uso")))
check("A: as chamadas do mesmo pedido levam a mesma marca (o turno), sem o id do motor", len({x.get("turno") for x in med}) == 1 and len(med[0].get("turno") or "") == 16
      and SESSAO not in med[0]["turno"], str([x.get("turno") for x in med]))
check("A: o número de cada chamada vai de 1 a N no pedido", [x.get("n") for x in med] == [1, 2, 3], str([x.get("n") for x in med]))
check("A: a conversa cresce a cada volta (o que as ferramentas devolveram)", len(med) == 3 and med[0]["conversa"] < med[1]["conversa"] < med[2]["conversa"],
      str([x.get("conversa") for x in med]))
bruto = "".join(open(os.path.join(bridge._medicao_dir(), n), encoding="utf-8").read() for n in os.listdir(bridge._medicao_dir()))
check("A: nada do conteúdo vai para o arquivo (só tamanhos)", SEGREDO not in bruto and "Aristóteles" not in bruto and NOTA not in bruto and "Asana" not in bruto)
check("A: o nome do arquivo não diz a sessão", all("ws_teste" not in n for n in os.listdir(bridge._medicao_dir())))
check("A: só as chamadas depois de um instante", len(bridge.medicao(SESSAO, med[1]["t"])) == 2 and bridge.medicao("outra-sessao") == [])

# a resposta que não chega (tentativa que falhou) não vira medição, e a medição nunca derruba a chamada
bridge.on_pre_api_request(session_id=SESSAO, api_request_id="req-sem-resposta", system_prompt="x", request_messages=[], tool_count=0)
check("A: pedido sem resposta não é gravado", len(bridge.medicao(SESSAO)) == 3)
check("A: entrada estranha não derruba", bridge.on_pre_api_request(session_id=SESSAO, api_request_id="r2", system_prompt=object(), request_messages="x", tool_count="?") is None
      and bridge.on_post_api_request(session_id=SESSAO, api_request_id="r2", usage="lixo") is None)
check("A: provedor que não informa o uso: a medição fica, sem o total", (bridge.medicao(SESSAO)[-1].get("uso") is None) and len(bridge.medicao(SESSAO)) == 4)

# imagem na conversa: conta pelo custo dela, não pelo tamanho do base64
img = "data:image/png;base64," + "A" * 200000
bridge.on_pre_api_request(session_id="s-img", api_request_id="ri", system_prompt="s", request_messages=[{"role": "user", "content": [{"type": "text", "text": "olha"}, {"type": "image_url", "image_url": {"url": img}}]}], tool_count=0)
bridge.on_post_api_request(session_id="s-img", api_request_id="ri", usage={"prompt_tokens": 900})
mi = bridge.medicao("s-img")
check("A: imagem conta ~750, não o base64 inteiro", len(mi) == 1 and mi[0]["imagens"] == 1 and mi[0]["conversa"] < 5000, str(mi))

# rc.26: a conversa resumida pelo motor (o resumo de verdade, com o prefixo do Hermes): só o tamanho dele, nunca o texto
from agent.context_compressor import SUMMARY_PREFIX  # noqa: E402

check("A: conversa sem resumo, resumo 0", all(x.get("resumo") == 0 for x in bridge.medicao(SESSAO)), str([x.get("resumo") for x in bridge.medicao(SESSAO)]))
texto_resumo = SUMMARY_PREFIX + "\n## Objetivo\nRelatório de vendas da semana, segredo-do-resumo"
bridge.on_pre_api_request(session_id="s-resumo", api_request_id="rr", system_prompt="s", request_messages=[
    {"role": "user", "content": texto_resumo}, {"role": "user", "content": "e agora?"}], tool_count=0)
bridge.on_post_api_request(session_id="s-resumo", api_request_id="rr", usage={"prompt_tokens": 900})
mr = bridge.medicao("s-resumo")
check("A: conversa resumida: o tamanho do resumo, reconhecido pelo próprio Hermes", len(mr) == 1 and mr[0]["resumo"] == len(texto_resumo), str(mr))
check("A: e nada do texto dele", "segredo-do-resumo" not in json.dumps(mr))

# ---------- a ponte de controle: /ergon/v1/medicao e /ergon/v1/passos, só com o token
porta = servir(bridge._ControlHandler)


def ponte(metodo, caminho, corpo=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{porta}{caminho}", method=metodo, data=None if corpo is None else json.dumps(corpo).encode(),
                                 headers={"Content-Type": "application/json", **({"X-Ergon-Bridge-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


q = urllib.parse.urlencode({"sessao": SESSAO, "desde": "0"})
st = ponte("GET", f"/ergon/v1/medicao?{q}")
check("ponte: devolve as chamadas da sessão", st[0] == 200 and len(st[1].get("chamadas", [])) == 4, str(st)[:300])
check("ponte: e o relógio do motor (o Ergon compensa a diferença)", isinstance(st[1].get("agora"), (int, float)) and abs(st[1]["agora"] - time.time()) < 60, str(st[1].get("agora")))
check("ponte: sem o token, nada", ponte("GET", f"/ergon/v1/medicao?{q}", token="")[0] == 401)
check("ponte: sessão inválida recusada", ponte("GET", "/ergon/v1/medicao?sessao=")[0] == 400 and ponte("GET", "/ergon/v1/medicao?sessao=a%0Ab")[0] == 400)
st = ponte("GET", "/ergon/v1/health")
check("ponte: saúde diz que sabe medir e mudar os passos", st[0] == 200 and {"medicao", "passos"} <= set(st[1].get("capacidades") or []), str(st))

# ---------- 25) passos por pedido: o painel interno grava (aqui, a rota de verdade dele, sem o servidor HTTP)
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
from gateway.run import _current_max_iterations  # noqa: E402

check("passos: o motor começa com 20", _current_max_iterations() == 20, str(_current_max_iterations()))
st = ponte("PUT", "/ergon/v1/passos", {"max_turns": 33})
check("passos: a ponte grava", st == (200, {"ok": True, "max_turns": 33}), str(st))
check("passos: o motor usa o valor novo no próximo pedido, sem reiniciar", _current_max_iterations() == 33, str(_current_max_iterations()))
check("passos: a ponte devolve o valor", ponte("GET", "/ergon/v1/passos") == (200, {"max_turns": 33}))
from hermes_cli.config import load_config  # noqa: E402

cfg = load_config()
check("passos: o resto da configuração fica (plugin, ferramentas, busca desligada)",
      "ergon_conexoes" in (cfg.get("platform_toolsets", {}).get("api_server") or []) and str(cfg.get("tools", {}).get("tool_search", {}).get("enabled")).lower() in ("off", "false"),
      str({k: cfg.get(k) for k in ("platform_toolsets", "tools")})[:300])
for ruim in (4, 61, "20", True, None, 20.5):
    check(f"passos: {ruim!r} recusado", ponte("PUT", "/ergon/v1/passos", {"max_turns": ruim})[0] == 400)
check("passos: sem o token, nada", ponte("PUT", "/ergon/v1/passos", {"max_turns": 10}, token="")[0] == 401 and _current_max_iterations() == 33)
print(f"      (gravado {'pela rota do painel interno' if pelo_painel else 'pelas funções de configuração do Hermes'})")

# ---------- rc.26: resumir as conversas longas mais cedo (/ergon/v1/compactacao), pelo mesmo painel interno
import types  # noqa: E402

from agent.agent_init import _parse_compression_config  # noqa: E402
from agent.context_compressor import ContextCompressor  # noqa: E402


def onde_resume(janela):
    """Onde o motor resume a conversa numa janela deste tamanho, com a configuração do disco (como num agente novo)."""
    cs = _parse_compression_config(types.SimpleNamespace(model="modelo-falso", provider="custom", api_mode="chat_completions"), load_config())
    cc = ContextCompressor("modelo-falso", threshold_percent=cs.threshold, threshold_tokens_cap=cs.threshold_tokens, quiet_mode=True)
    return cs.enabled, cc.preview_threshold_tokens("modelo-falso", janela)


st = ponte("GET", "/ergon/v1/health")
check("compactação: a saúde diz que sabe", "compactacao" in (st[1].get("capacidades") or []), str(st))
check("compactação: sem o teto do Ergon (cofre sem a migração 3), desligada", ponte("GET", "/ergon/v1/compactacao") == (200, {"ligada": False, "limite": None}))
antes_resume = onde_resume(200_000)
check("compactação: desligada, o motor só resume perto do fim da janela", antes_resume[0] is True and antes_resume[1] > 100_000, str(antes_resume))
st = ponte("PUT", "/ergon/v1/compactacao", {"ligada": True})
check("compactação: a ponte liga", st == (200, {"ok": True, "ligada": True, "limite": bridge.COMPACTAR_LIMITE}), str(st))
check("compactação: ligada, a ponte devolve", ponte("GET", "/ergon/v1/compactacao") == (200, {"ligada": True, "limite": 150000}))
check("compactação: num agente novo, resume a partir de 150 mil (96 mil numa janela de 128 mil)",
      onde_resume(128_000) == (True, 96000) and onde_resume(200_000) == (True, 150000), str((onde_resume(128_000), onde_resume(200_000))))
check("compactação: os passos e o resto ficam", _current_max_iterations() == 33 and "ergon_conexoes" in (load_config().get("platform_toolsets", {}).get("api_server") or []))
st = ponte("PUT", "/ergon/v1/compactacao", {"ligada": False})
check("compactação: a ponte desliga", st == (200, {"ok": True, "ligada": False, "limite": None}) and ponte("GET", "/ergon/v1/compactacao") == (200, {"ligada": False, "limite": None}), str(st))
check("compactação: desligada de novo, só o limite do motor (nunca sem resumo nenhum)", onde_resume(200_000) == antes_resume, str(onde_resume(200_000)))
for ruim in ("sim", 1, None, []):
    check(f"compactação: {ruim!r} recusado", ponte("PUT", "/ergon/v1/compactacao", {"ligada": ruim})[0] == 400)
check("compactação: sem o token, nada", ponte("PUT", "/ergon/v1/compactacao", {"ligada": True}, token="")[0] == 401
      and ponte("GET", "/ergon/v1/compactacao")[1].get("ligada") is False)

# ---------- B) a busca de ferramentas, medida: o que ela esconderia e quanto pouparia
import model_tools  # noqa: E402
from hermes_cli.tools_config import _get_platform_tools  # noqa: E402
from tools.tool_search import ToolSearchConfig, assemble_tool_defs, estimate_tokens_from_schemas  # noqa: E402

defs = model_tools.get_tool_definitions(enabled_toolsets=sorted(_get_platform_tools(cfg, "api_server", include_default_mcp_servers=False)), quiet_mode=True)
ligada = assemble_tool_defs(defs, config=ToolSearchConfig.from_raw({"enabled": "on"}))
desligada = assemble_tool_defs(defs, config=ToolSearchConfig.from_raw({"enabled": "off"}))
nomes_l = {d["function"]["name"] for d in ligada.tool_defs}
nomes_d = {d["function"]["name"] for d in desligada.tool_defs}
antes, depois = estimate_tokens_from_schemas(defs), estimate_tokens_from_schemas(ligada.tool_defs)
print(f"      (definições das ferramentas: ~{antes} tokens; com a busca ligada: ~{depois}; escondidas: {ligada.deferred_count}, ~{ligada.deferred_tokens} tokens)")
check("B: ligada, a busca esconde as Conexões atrás dela (toda ferramenta de plugin)", "conexoes_executar" not in nomes_l and "tool_search" in nomes_l, str(sorted(nomes_l)))
check("B: desligada (como o cofre deixa), as Conexões ficam à vista", {"conexoes_listar", "conexoes_executar"} <= nomes_d and "tool_search" not in nomes_d)
check("B: o que ela pouparia é pouco (menos de 1.500 tokens por chamada)", antes - depois < 1500, f"{antes} → {depois}")

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

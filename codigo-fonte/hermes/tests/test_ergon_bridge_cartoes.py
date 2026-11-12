"""Cartões: perguntar de volta, pedido seguro de chave e senha de administrador, com o laço de verdade do motor e um
modelo falso (sem rede, HERMES_HOME descartável, Ergon simulado).

Confere, dentro da imagem do motor:
- o modelo recebe perguntar, pedir_chave e pedir_senha_admin à vista; a pergunta vira cartão no Ergon, a ferramenta espera
  e a resposta volta ao modelo NO MESMO pedido, no formato do clarify do Hermes; sem resposta no prazo, o modelo é avisado
  de que o cartão continua com a pessoa;
- os ganchos de espera humana do Hermes disparam (on_human_input_request / on_human_input_resolved) e chegam ao Ergon;
- a chave que a pessoa digita vai do Ergon direto à ponte de controle e ao .env do motor (o gravador do Hermes); o modelo
  recebe só o nome; um comando do Terminal usa a variável e, se imprimir o valor, o que volta ao modelo vem mascarado;
- nomes do sistema e chaves de provedor não entram por aqui; listar devolve só nomes; apagar tira do .env;
- a senha de administrador "só para este trabalho" fica no cache do sudo do Hermes, no escopo da sessão (a execução), e
  sai no fim do pedido; guardada, vira SUDO_PASSWORD no .env;
- o juiz da meta e o pedido de revisão do Hermes respondem pela ponte de controle;
- o valor de teste não aparece em NENHUM arquivo do motor (fora o .env, quando guardado), em nenhuma mensagem que foi ao
  modelo, em nenhum pedido ao Ergon e em nenhum registro.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_cartoes.py
"""
import io
import json
import logging
import os
import shutil
import socket
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
TOKEN = "token-da-ponte-de-teste-0123456789"
# os valores de teste, montados por partes (nenhum arquivo do repositório traz um segredo inteiro)
SEGREDO = "-".join(["zq7", "Kp2mXv9", "Lw4Rt8", "Yb3Nc6"])
SENHA_ADMIN = "".join(["Adm", "!n-", "s3nh4", "-de-", "t3ste"])
SENHA_GUARDADA = "".join(["Gu4rd", "ad4-", "sud0", "-xyz"])
CHAVE = "CLIMA_TESTE_TOKEN"


def porta_livre():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORTA_CONTROLE = porta_livre()
os.environ.update({"HERMES_PLATFORM": "api_server", "ERGON_BRIDGE_TOKEN": TOKEN, "ERGON_CONTROL_PORT": str(PORTA_CONTROLE),
                   "ERGON_CARTAO_PASSO_S": "0.2", "ERGON_CARTAO_ESPERA_S": "3", "TERMINAL_ENV": "local"})
sys.path.insert(0, "/opt/hermes")

registros = io.StringIO()
_h = logging.StreamHandler(registros)
_h.setLevel(logging.DEBUG)
logging.getLogger().addHandler(_h)
logging.getLogger().setLevel(logging.DEBUG)

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


def ponte(metodo, caminho, corpo=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{PORTA_CONTROLE}{caminho}", method=metodo, data=None if corpo is None else json.dumps(corpo).encode(),
                                 headers={"Content-Type": "application/json", **({"X-Ergon-Bridge-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


# ---------- Ergon simulado: guarda os cartões; "a pessoa" responde conforme o plano de cada teste
pedidos = []      # tudo o que o plugin mandou ao Ergon (fora a política)
esperas = []      # o que os ganchos de espera humana avisaram
plano = {"depois_de": 2, "resposta": None}   # responde depois de N consultas; None = nunca responde
consultas = {}
policy = {"known": True, "agent": "Aspásia", "toolsets": ["todo", "terminal"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


def responder_cartao(cartao):
    """O que o servidor do Ergon faz quando a pessoa responde: a chave vai direto à ponte de controle do motor."""
    r = plano["resposta"]
    if callable(r):
        r = r(cartao)
    return r


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        if self.path.endswith("/tool-policy"):
            return self.responder(policy)
        if self.path.endswith("/espera"):
            esperas.append(b)
            return self.responder({"ok": True})
        pedidos.append({"path": self.path, "token": self.headers.get("X-Ergon-Bridge-Token"), "body": b})
        if self.path.endswith("/cartao"):
            consultas[b["pedido"]] = {"n": 0, "cartao": b}
            return self.responder({"estado": "esperando"})
        if self.path.endswith("/cartao/estado"):
            c = consultas.get(b.get("pedido"))
            if not c:
                return self.responder({"estado": "falhou", "texto": "cartão desconhecido"})
            c["n"] += 1
            c["desistiu"] = c.get("desistiu") or bool(b.get("desistir"))
            if plano["resposta"] is None or c["n"] < plano["depois_de"]:
                return self.responder({"estado": "esperando"})
            return self.responder(responder_cartao(c["cartao"]))
        return self.responder({}, 404)


os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{servir(Ergon)}/internal/bridge/v1/events"

# ---------- modelo falso, compatível com a API de chat: responde conforme o roteiro
chamadas = []
roteiro = []
ao_chamar = []   # funções rodadas a cada chamada ao modelo (para olhar o motor por dentro no meio do pedido)


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
        for fn in ao_chamar:
            fn(b)
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


URL_MODELO = f"http://127.0.0.1:{servir(Modelo)}/v1"
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(f"""plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, terminal, ergon_cartoes]
known_plugin_toolsets:
  api_server: [ergon_conexoes, ergon_cartoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
model:
  provider: custom
  base_url: {URL_MODELO}
  default: modelo-falso
  api_key: chave-falsa
""")

# ---------- o motor de verdade
from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
from run_agent import AIAgent  # noqa: E402
from gateway.session_context import set_session_vars  # noqa: E402
from tools import terminal_tool_sudo as sudo  # noqa: E402

bridge = sys.modules.get("hermes_plugins.ergon_bridge") or next((m for n, m in sys.modules.items() if n.endswith("ergon_bridge") and hasattr(m, "tool_perguntar")), None)
check("o plugin carregou no motor", bridge is not None)


def agente(sessao):
    return AIAgent(base_url=URL_MODELO, api_key="chave-falsa", provider="custom", model="modelo-falso", max_iterations=8, quiet_mode=True,
                   enabled_toolsets=["todo", "terminal", "ergon_cartoes"], session_id=sessao, platform="api_server", skip_memory=True, skip_context_files=True)


def rodar(sessao, texto, execucao=None):
    """Como a API do motor: a sessão da execução fica no contexto (gateway/platforms/api_server_runs.py)."""
    set_session_vars(platform="api_server", chat_id=sessao, session_key=execucao or f"run_{sessao}", session_id=sessao)
    return agente(sessao).run_conversation(texto, task_id=f"tarefa-{sessao}")


def resultado(i=1):
    """O que a ferramenta devolveu ao modelo (a última mensagem de ferramenta na chamada i)."""
    msgs = [m for m in chamadas[i].get("messages", []) if m.get("role") == "tool"] if len(chamadas) > i else []
    try:
        return json.loads(msgs[-1]["content"]) if msgs else {}
    except Exception:  # noqa: BLE001
        return {"bruto": str(msgs[-1].get("content"))}


def limpar():
    pedidos.clear(); chamadas.clear(); esperas.clear(); consultas.clear(); ao_chamar.clear()


def aguardar_esperas(n):
    import time
    for _ in range(50):
        if len(esperas) >= n:
            return
        time.sleep(0.1)


# 1. perguntar: o cartão, a espera e a resposta no mesmo pedido
plano.update({"depois_de": 2, "resposta": {"estado": "respondida", "respostas": {"q0": "Azul", "q1": "No fim do mês"}}})
roteiro[:] = [ferramenta("perguntar", {"questions": [{"question": "Qual cor uso na capa?", "choices": ["Azul", "Verde"]}, {"question": "Para quando?"}]}), fala("Capa azul, para o fim do mês.")]
r = rodar("sessao-a", "prepare a capa do relatório")
nomes = {t.get("function", {}).get("name") for t in chamadas[0].get("tools", [])}
check("o modelo recebe as três ferramentas dos cartões à vista", {"perguntar", "pedir_chave", "pedir_senha_admin"} <= nomes, str(sorted(n for n in nomes if n)))
desc = next((t["function"].get("description", "") for t in chamadas[0].get("tools", []) if t.get("function", {}).get("name") == "perguntar"), "")
check("perguntar leva o esquema e a explicação do clarify do Hermes", "Recommended" in desc and "questions" in json.dumps(chamadas[0].get("tools")), desc[:120])
cart = [p for p in pedidos if p["path"].endswith("/cartao")]
check("a pergunta chegou ao Ergon como cartão, com o token da ponte e a sessão", len(cart) == 1 and cart[0]["token"] == TOKEN and cart[0]["body"].get("session_id") == "sessao-a"
      and cart[0]["body"].get("tipo") == "pergunta", str(cart)[:400])
if cart:
    pg = cart[0]["body"].get("perguntas") or []
    check("com as perguntas e as opções (sem a marca de recomendada)", [p.get("pergunta") for p in pg] == ["Qual cor uso na capa?", "Para quando?"]
          and pg[0].get("opcoes") == ["Azul", "Verde"] and pg[1].get("opcoes") == [], str(pg))
check("a ferramenta esperou consultando o estado", sum(1 for p in pedidos if p["path"].endswith("/cartao/estado")) >= 2, str(len(pedidos)))
res = resultado()
check("a resposta voltou ao modelo no mesmo pedido, no formato do clarify", res.get("outcome") == "submitted"
      and [x.get("user_response") for x in res.get("responses", [])] == ["Azul", "No fim do mês"] and res["responses"][0].get("status") == "answered", str(res))
check("e o trabalho seguiu até o fim", r.get("final_response") == "Capa azul, para o fim do mês.", str(r.get("final_response")))
aguardar_esperas(2)
check("ganchos do Hermes: a espera humana foi avisada ao Ergon (pedido e resolvido, sem a resposta)",
      [(e.get("fase"), e.get("kind"), e.get("outcome")) for e in esperas] == [("pedido", "clarify", ""), ("resolvido", "clarify", "submitted")]
      and esperas[0].get("request_id") and esperas[0]["request_id"] == esperas[1]["request_id"] and "Azul" not in json.dumps(esperas), str(esperas))

# 2. sem resposta no prazo: o cartão fica com a pessoa e o modelo é avisado
limpar()
plano.update({"resposta": None})
roteiro[:] = [ferramenta("perguntar", {"questions": [{"question": "Posso enviar?", "choices": ["Sim", "Não"]}]}), fala("Aguardo a sua resposta.")]
r = rodar("sessao-b", "envie o relatório")
res = resultado()
check("sem resposta no prazo: o modelo sabe que o cartão continua com a pessoa", res.get("outcome") == "timed_out" and "próxima mensagem" in str(res.get("notice"))
      and res["responses"][0].get("status") == "unanswered", str(res))
check("e o Ergon é avisado de que a ferramenta parou de esperar", any(c.get("desistiu") for c in consultas.values()), str(consultas)[:300])
aguardar_esperas(2)
check("ganchos: resolvido como prazo esgotado", [e.get("outcome") for e in esperas if e.get("fase") == "resolvido"] == ["timed_out"], str(esperas))

# 3. fora de um trabalho do Ergon, os cartões não funcionam
limpar()
policy["known"] = False
roteiro[:] = [ferramenta("perguntar", {"questions": [{"question": "Oi?"}]}), fala("Certo.")]
rodar("sessao-fora", "pergunte algo")
check("sessão que não é do Ergon: barrada, e nada chega ao Ergon", not pedidos and "só funciona dentro de um trabalho" in json.dumps(chamadas[1].get("messages", [])[-1], ensure_ascii=False), str(pedidos)[:200])
policy["known"] = True
bridge._policy_cache.clear()

# 4. pedido seguro de chave: o valor vai do Ergon direto ao cofre do motor; o modelo só recebe o nome
limpar()


def pessoa_digita_a_chave(cartao):
    st = ponte("PUT", "/ergon/v1/chaves", {"nome": cartao["nome"], "valor": SEGREDO, "motivo": cartao["motivo"], "agente": "Aspásia"})
    assert st[0] == 200, st
    return {"estado": "respondida"}


plano.update({"depois_de": 2, "resposta": pessoa_digita_a_chave})
comando = f'test -n "${CHAVE}" && echo presente; echo "tam=${{#{CHAVE}}}"; echo "valor=${CHAVE}"; env | grep {CHAVE}'
roteiro[:] = [ferramenta("pedir_chave", {"nome": CHAVE, "motivo": "consultar a previsão do tempo no serviço de clima"}),
              ferramenta("terminal", {"command": comando}), fala("Consultei com a chave guardada.")]
r = rodar("sessao-c", "veja a previsão do tempo")
cart = [p for p in pedidos if p["path"].endswith("/cartao")]
check("o pedido de chave chegou como cartão, com o nome e o motivo", len(cart) == 1 and cart[0]["body"].get("tipo") == "chave" and cart[0]["body"].get("nome") == CHAVE
      and "previsão do tempo" in cart[0]["body"].get("motivo", ""), str(cart)[:300])
res = resultado(1)
check("o modelo recebe só o nome (guardada como NOME) e como usar", res.get("ok") is True and res.get("guardada_como") == CHAVE and CHAVE in str(res.get("uso")), str(res))
with open(os.path.join(HOME, ".env"), encoding="utf-8") as f:
    env_txt = f.read()
check("o valor foi para o .env do motor (a fonte de segredos do Hermes)", f"{CHAVE}=" in env_txt and SEGREDO in env_txt, env_txt.replace(SEGREDO, "***")[:200])
saida = json.dumps(chamadas[2].get("messages", [])[-1], ensure_ascii=False) if len(chamadas) > 2 else ""
check("o Terminal usa a chave pela variável de ambiente, no mesmo pedido", "presente" in saida and f"tam={len(SEGREDO)}" in saida, saida[:400])
check("e o que o comando imprimiu volta mascarado ao modelo", SEGREDO not in saida and "valor=" in saida, saida.replace(SEGREDO, "!!!VAZOU!!!")[:400])
check("o trabalho terminou", r.get("final_response") == "Consultei com a chave guardada.", str(r.get("final_response")))
aguardar_esperas(2)
check("ganchos: a espera pela chave foi avisada, sem o valor", [(e.get("fase"), e.get("kind")) for e in esperas][:2] == [("pedido", "secret"), ("resolvido", "secret")]
      and esperas[1].get("outcome") == "provided", str(esperas))

# pedir de novo a mesma chave: já está guardada, sem cartão
limpar()
roteiro[:] = [ferramenta("pedir_chave", {"nome": CHAVE.lower(), "motivo": "consultar o clima"}), fala("Já tinha.")]
rodar("sessao-c2", "de novo")
check("chave já guardada: responde sem abrir outro cartão", resultado(1).get("ja_estava") is True and not pedidos, str(resultado(1)))

# nomes que não entram por um cartão
limpar()
recusas = {}
for nome in ("OPENAI_API_KEY", "HERMES_HOME", "PATH", "LD_PRELOAD", "ERGON_BRIDGE_TOKEN", "ab", "SUDO_PASSWORD"):
    recusas[nome] = json.loads(bridge.tool_pedir_chave({"nome": nome, "motivo": "teste"}, session_id="sessao-c"))
check("chave de provedor e nomes do sistema: recusados, sem cartão", all(r.get("ok") is False and r.get("erro") for r in recusas.values()) and not pedidos, str(recusas)[:500])
st = [ponte("PUT", "/ergon/v1/chaves", {"nome": n, "valor": "valor-qualquer-123"})[0] for n in ("OPENAI_API_KEY", "HERMES_HOME", "PATH", "SUDO_PASSWORD")]
check("a ponte de controle recusa os mesmos nomes", st == [400, 400, 400, 400], str(st))
check("a ponte de controle recusa valor vazio ou com quebra escondida", ponte("PUT", "/ergon/v1/chaves", {"nome": "OUTRA_CHAVE", "valor": ""})[0] == 400
      and ponte("PUT", "/ergon/v1/chaves", {"nome": "OUTRA_CHAVE", "valor": "a\tb\x01c"})[0] == 400)
check("sem o token da ponte, nada", ponte("GET", "/ergon/v1/chaves", token="")[0] == 401 and ponte("PUT", "/ergon/v1/chaves", {"nome": "X_CHAVE", "valor": "12345678"}, token="errado" * 6)[0] == 401)
st = ponte("GET", "/ergon/v1/chaves")
check("listar: só nomes, para quê e quando — nunca o valor", st[0] == 200 and [c.get("nome") for c in st[1].get("chaves", [])] == [CHAVE]
      and "previsão" in st[1]["chaves"][0].get("motivo", "") and SEGREDO not in json.dumps(st[1]) and st[1].get("sudo") is False, str(st).replace(SEGREDO, "!!!VAZOU!!!"))
with open(os.path.join(HOME, "ergon_bridge", "chaves.json"), encoding="utf-8") as f:
    check("o registro das chaves guarda só o nome", SEGREDO not in f.read())


def onde_esta(valor):
    achados = []
    for raiz, _dirs, arquivos in os.walk(HOME):
        for nome in arquivos:
            caminho = os.path.join(raiz, nome)
            try:
                with open(caminho, "rb") as f:
                    if valor.encode() in f.read():
                        achados.append(os.path.relpath(caminho, HOME))
            except OSError:
                continue
    return sorted(achados)


# enquanto a chave está guardada, o valor fica só onde o Hermes precisa dele para o Terminal usar: o .env e o arquivo de
# trabalho da sessão do Terminal (o ambiente da sessão aberta), os dois dentro do cofre do motor. Em nenhum outro arquivo:
# nem nas sessões gravadas, nem nos registros, nem no registro das chaves.
onde = onde_esta(SEGREDO)
check("chave guardada: no .env e no ambiente da sessão do Terminal, e em nenhum outro arquivo",
      ".env" in onde and all(x == ".env" or x.startswith(os.path.join("cache", "scratch", "hermes-snap-")) for x in onde), str(onde))

# 5. senha de administrador só para este trabalho: cache do sudo do Hermes, no escopo da execução; sai no fim do pedido
limpar()
plano.update({"depois_de": 1, "resposta": {"estado": "respondida", "valor": SENHA_ADMIN}})
visto = {}


def olhar_o_cache(_b):
    if len(chamadas) == 2:
        with sudo._sudo_password_cache_lock:
            visto.update(sudo._sudo_password_cache)


ao_chamar.append(olhar_o_cache)
roteiro[:] = [ferramenta("pedir_senha_admin", {"motivo": "instalar o pacote de fontes com apt"}), ferramenta("terminal", {"command": f"echo 'tentando: {SENHA_ADMIN}'"}), fala("Instalado.")]
r = rodar("sessao-d", "instale as fontes", execucao="run_execucao_d")
cart = [p for p in pedidos if p["path"].endswith("/cartao")]
check("o pedido da senha de administrador chegou como cartão", len(cart) == 1 and cart[0]["body"].get("tipo") == "sudo" and "apt" in cart[0]["body"].get("motivo", ""), str(cart)[:300])
res = resultado(1)
check("o modelo recebe só a confirmação", res.get("ok") is True and "só para este trabalho" in str(res.get("texto")) and SENHA_ADMIN not in json.dumps(res), str(res).replace(SENHA_ADMIN, "!!!VAZOU!!!"))
check("durante o pedido: a senha está no cache do sudo do Hermes, no escopo desta execução", visto == {"session:run_execucao_d": SENHA_ADMIN},
      str({k: "***" for k in visto}))
with sudo._sudo_password_cache_lock:
    depois = dict(sudo._sudo_password_cache)
check("no fim do pedido: a senha saiu do cache", depois == {}, str(list(depois)))
saida = json.dumps(chamadas[2].get("messages", [])[-1], ensure_ascii=False) if len(chamadas) > 2 else ""
check("se um comando imprimir a senha, o que volta ao modelo vem mascarado", "tentando:" in saida and SENHA_ADMIN not in saida, saida.replace(SENHA_ADMIN, "!!!VAZOU!!!")[:300])
check("a senha de um trabalho só não vai para o .env", SENHA_ADMIN not in open(os.path.join(HOME, ".env"), encoding="utf-8").read())
aguardar_esperas(2)
check("ganchos: a espera do sudo foi avisada", [(e.get("fase"), e.get("kind")) for e in esperas][:2] == [("pedido", "sudo"), ("resolvido", "sudo")], str(esperas))

# o mecanismo do Hermes usa a senha do cache: sudo vira "sudo -S" com a senha na entrada do comando
set_session_vars(platform="api_server", chat_id="sessao-e", session_key="run_execucao_e", session_id="sessao-e")
sudo._set_cached_sudo_password(SENHA_ADMIN)
cmd, entrada = sudo._transform_sudo_command("sudo apt-get install -y fonts-dejavu")
check("Hermes: com a senha no cache da sessão, o comando vira sudo -S e a senha vai pela entrada", "sudo -S" in str(cmd) and entrada == SENHA_ADMIN + "\n" and SENHA_ADMIN not in str(cmd), str(cmd))
sudo._set_cached_sudo_password("")

# guardada (a pessoa marcou): vira SUDO_PASSWORD no .env do motor


def pessoa_guarda_a_senha(_cartao):
    st = ponte("PUT", "/ergon/v1/chaves", {"sudo": True, "valor": SENHA_GUARDADA})
    assert st[0] == 200, st
    return {"estado": "respondida", "guardada": True}


limpar()
plano.update({"depois_de": 1, "resposta": pessoa_guarda_a_senha})
roteiro[:] = [ferramenta("pedir_senha_admin", {"motivo": "atualizar os pacotes toda semana"}), fala("Guardada.")]
rodar("sessao-f", "atualize os pacotes")
res = resultado(1)
check("senha guardada: o modelo recebe só a confirmação", res.get("ok") is True and "ficou guardada" in str(res.get("texto")), str(res))
check("senha guardada: está no .env como SUDO_PASSWORD e a lista diz que há uma", f"SUDO_PASSWORD=" in open(os.path.join(HOME, ".env"), encoding="utf-8").read()
      and ponte("GET", "/ergon/v1/chaves")[1].get("sudo") is True)
check("senha guardada: o Hermes passa a usá-la (configurada)", sudo._transform_sudo_command("sudo true")[1] == SENHA_GUARDADA + "\n")
limpar()
roteiro[:] = [ferramenta("pedir_senha_admin", {"motivo": "de novo"}), fala("Já tinha.")]
rodar("sessao-f2", "de novo")
check("senha já guardada: sem outro cartão", resultado(1).get("ja_estava") is True and not pedidos, str(resultado(1)))

# 6. o juiz da meta e o pedido de revisão do Hermes, pela ponte de controle
limpar()
roteiro[:] = [fala('{"verdict": "done", "reason": "o relatório foi entregue com as três seções"}')]
st = ponte("POST", "/ergon/v1/meta/julgar", {"meta": "entregar o relatório com três seções", "resposta": "Segue o relatório, com introdução, análise e conclusão."})
check("juiz da meta: responde com veredito, motivo e o texto de continuação do Hermes", st[0] == 200 and st[1].get("veredito") in ("done", "continue", "blocked", "wait", "skipped")
      and "entregar o relatório com três seções" in str(st[1].get("continuar")) and "Continuing toward your standing goal" in str(st[1].get("continuar")), str(st)[:400])
print(f"      juiz da meta neste teste: veredito={st[1].get('veredito')} sem_juiz={st[1].get('sem_juiz')} chamadas ao modelo={len(chamadas)} motivo={str(st[1].get('motivo'))[:120]}")
if len(chamadas) >= 1:
    check("juiz da meta: o modelo auxiliar do Hermes foi chamado e o veredito dele valeu", st[1].get("veredito") == "done" and "três seções" in str(st[1].get("motivo")), str(st[1]))
st = ponte("POST", "/ergon/v1/revisao/pedido", {"mensagens": [{"role": "user", "text": "faça a proposta comercial"}, {"role": "assistant", "text": "Segue a proposta: preço de 10 mil."}], "foco": "confira os números"})
check("pedido de revisão: o texto do Hermes, com o trecho da conversa e o foco", st[0] == 200 and "independent senior reviewer" in str(st[1].get("pedido"))
      and "Segue a proposta: preço de 10 mil." in st[1]["pedido"] and "confira os números" in st[1]["pedido"] and st[1].get("titulo", "").startswith("Review"), str(st)[:300])
check("sem o token, nada", ponte("POST", "/ergon/v1/meta/julgar", {"meta": "x", "resposta": "y"}, token="")[0] == 401)

# 7. apagar
st = ponte("DELETE", f"/ergon/v1/chaves/{CHAVE}")
env_txt = open(os.path.join(HOME, ".env"), encoding="utf-8").read()
check("apagar: a chave sai do .env e da lista", st == (200, {"ok": True, "apagada": True}) and CHAVE not in env_txt and SEGREDO not in env_txt
      and ponte("GET", "/ergon/v1/chaves")[1].get("chaves") == [], str(st))
check("apagar: sai também do ambiente das sessões do Terminal ainda abertas (não sobra em arquivo nenhum)", onde_esta(SEGREDO) == [], str(onde_esta(SEGREDO)))
check("apagar: o que não entrou por um cartão não sai por aqui", ponte("DELETE", "/ergon/v1/chaves/OPENAI_API_KEY") == (200, {"ok": True, "apagada": False}))
st = ponte("DELETE", "/ergon/v1/chaves/SUDO_PASSWORD")
check("apagar a senha de administrador guardada", st[1].get("apagada") is True and "SUDO_PASSWORD" not in open(os.path.join(HOME, ".env"), encoding="utf-8").read()
      and ponte("GET", "/ergon/v1/chaves")[1].get("sudo") is False, str(st))

# 8. o valor não está em lugar nenhum: arquivos do motor, o que foi ao modelo, o que foi ao Ergon, os registros
logging.shutdown()
vazou = []
for raiz, _dirs, arquivos in os.walk(HOME):
    for nome in arquivos:
        caminho = os.path.join(raiz, nome)
        try:
            with open(caminho, "rb") as f:
                dados = f.read()
        except OSError:
            continue
        for rotulo, valor in (("chave", SEGREDO), ("senha de um trabalho", SENHA_ADMIN), ("senha guardada", SENHA_GUARDADA)):
            if valor.encode() in dados:
                vazou.append(f"{rotulo} em {os.path.relpath(caminho, HOME)}")
n_arquivos = sum(len(a) for _r, _d, a in os.walk(HOME))
check(f"nenhum arquivo do motor traz os valores de teste (apagados do .env; {n_arquivos} arquivos conferidos, com sessões e registros)", not vazou and n_arquivos > 3, str(vazou))
reg = registros.getvalue()
check("nenhum registro do motor traz os valores", all(v not in reg for v in (SEGREDO, SENHA_ADMIN, SENHA_GUARDADA)), f"{len(reg)} caracteres de registro")
print(f"      registros conferidos: {len(reg)} caracteres")

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

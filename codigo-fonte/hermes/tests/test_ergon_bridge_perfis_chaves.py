"""Chave guardada por cartão no Terminal do agente, no perfil dele (ensaio da rc.27), no motor de verdade.

O gateway do Hermes de pé com vários perfis (gateway.multiplex_profiles), um modelo falso e um Ergon simulado (sem rede).
Antes da correção, a chave entregue pelo cartão (pedir_chave → ponte /ergon/v1/chaves → .env do motor, copiada ao .env
de cada perfil) chegava ao Terminal no perfil padrão e NÃO no perfil do agente: lá o Hermes só passa ao filho, do escopo
de segredos do perfil, os nomes da lista de passagem (tools/env_passthrough.py), e o escopo é montado no começo do pedido.
Confere:
- no perfil do agente, a chave entregue NO MEIO do trabalho (o cartão do pedir_chave) vale no comando seguinte do mesmo
  trabalho, com o valor certo (o resumo sha256 confere), e no pedido seguinte também;
- o valor nunca volta ao modelo: a saída do Terminal chega mascarada;
- apagada a chave (ponte DELETE), ela sai na hora: no comando seguinte do mesmo trabalho e nos pedidos seguintes;
- o perfil padrão continua igual (vê a chave, mascarada, e deixa de ver quando apagada);
- um perfil não recebe uma chave que não está no .env dele (nada de vazar do ambiente do processo).

  podman run --rm --network none --user 10000:10000 --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_perfis_chaves.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"))
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"))
TOKEN = "token-da-ponte-de-teste-" + "0123456789"
CHAVE = "chave-da-api-de-teste-" + "0123456789abcdef"
NOME = "JARDIM_API_KEY"
SEGREDO = "-".join(["jd8", "Qm4Xv7", "Tz2Lp9", "Rb5Wc3"])   # montado por partes
RESUMO = hashlib.sha256(SEGREDO.encode()).hexdigest()
API, PONTE = 18652, 18653
VER = f'test -n "${NOME}" && echo VISIVEL || echo AUSENTE; echo "valor=${NOME}"'
SHA = f'printf %s "${NOME}" | sha256sum'

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""), flush=True)
    ok = ok and bool(cond)


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


def servir(Handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


def http(method, url, body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        return e.code, (json.loads(t) if t.startswith(("{", "[")) else t)
    except Exception as e:  # noqa: BLE001
        return 0, repr(e)


def ponte(method, path, body=None):
    return http(method, f"http://127.0.0.1:{PONTE}{path}", body, {"X-Ergon-Bridge-Token": TOKEN})


# ---------- Ergon simulado: a política (com o Terminal) e o cartão da chave (a pessoa digita; o Ergon manda à ponte)
pedidos = []
policy = {"known": True, "agent": "Hipátia", "toolsets": ["todo", "terminal", "ergon_cartoes"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}
trava = threading.Lock()


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        with trava:
            pedidos.append({"path": self.path, "body": b})
        if self.path.endswith("/tool-policy"):
            return self.responder(policy if str(b.get("session_id", "")).startswith("run_") else {"known": False})
        if self.path.endswith("/cartao") and b.get("tipo") == "chave":
            st, _r = ponte("PUT", "/ergon/v1/chaves", {"nome": b.get("nome"), "valor": SEGREDO, "motivo": b.get("motivo"), "agente": "Hipátia"})
            return self.responder({"estado": "respondida" if st == 200 else "falhou"})
        return self.responder({"ok": True})


# ---------- modelo falso: um roteiro; um passo pode ter "antes" (o que acontece fora do motor antes da resposta)
chamadas = []
roteiro = []


def fala(texto):
    return {"role": "assistant", "content": texto}


def ferramenta(nome, args, antes=None):
    return {"role": "assistant", "content": None, "antes": antes, "tool_calls": [{"id": f"call_{time.time_ns()}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        msgs = b.get("messages", [])
        with trava:
            if b.get("tools"):
                chamadas.append({"tools": sorted(t.get("function", {}).get("name", "") for t in b.get("tools") or []), "msgs": msgs})
            m = dict(roteiro.pop(0)) if b.get("tools") and roteiro else {"role": "assistant", "content": "Pronto."}
        antes = m.pop("antes", None)
        if callable(antes):
            antes()

        def pedaco(delta, fim=None):
            return "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "created": 1, "model": b.get("model", "t"), "choices": [{"index": 0, "delta": delta, "finish_reason": fim}]}) + "\n\n"
        if b.get("stream"):
            partes = [pedaco({"role": "assistant"})]
            if m.get("content"):
                partes.append(pedaco({"content": m["content"]}))
            for i, t in enumerate(m.get("tool_calls") or []):
                partes.append(pedaco({"tool_calls": [{"index": i, "id": t["id"], "type": "function", "function": t["function"]}]}))
            partes += [pedaco({}, "tool_calls" if m.get("tool_calls") else "stop"), "data: [DONE]\n\n"]
            data = "".join(partes).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self.responder({"id": "x", "object": "chat.completion", "created": 1, "model": b.get("model", "t"),
                               "choices": [{"index": 0, "finish_reason": "tool_calls" if m.get("tool_calls") else "stop", "message": m}],
                               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    def do_GET(self):
        return self.responder({"object": "list", "data": [{"id": "modelo-falso", "object": "model", "context_length": 200000}]})


PORTA_ERGON, PORTA_MODELO = servir(Ergon), servir(Modelo)

# ---------- a configuração que as migrações do cofre deixam, com o modelo falso e o Terminal ligado para a equipe
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(f"""model:
  provider: custom
  default: modelo-falso
  base_url: http://127.0.0.1:{PORTA_MODELO}/v1
  api_key: chave-falsa
plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, terminal, ergon_cartoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
gateway:
  multiplex_profiles: true
""")
with open(os.path.join(HOME, ".env"), "w", encoding="utf-8") as f:
    f.write(f"API_SERVER_KEY={CHAVE}\n")

env = {**os.environ, "HERMES_HOME": HOME, "HOME": HOME, "API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1", "API_SERVER_PORT": str(API), "API_SERVER_KEY": CHAVE,
       "ERGON_CONTROL_PORT": str(PONTE), "ERGON_BRIDGE_URL": f"http://127.0.0.1:{PORTA_ERGON}/internal/bridge/v1/events", "ERGON_BRIDGE_TOKEN": TOKEN,
       "HERMES_GATEWAY_NO_SUPERVISE": "1", "ERGON_CARTAO_PASSO_S": "0.3"}
log = open("/tmp/gateway-teste-chaves.log", "w")
if os.geteuid() == 0:  # a CI roda os testes como root; o motor de verdade roda como usuário comum
    env["HERMES_ALLOW_ROOT_GATEWAY"] = "1"
gw = subprocess.Popen(["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"], env=env, stdout=log, stderr=subprocess.STDOUT, cwd=HOME)


def rodar(perfil, script, sessao, espera=120):
    """Uma execução em /p/<perfil>/v1/runs até o fim; devolve (estado, saídas das ferramentas na ordem)."""
    with trava:
        chamadas.clear()
        roteiro[:] = script
    base = f"http://127.0.0.1:{API}" + (f"/p/{perfil}" if perfil else "")
    h = {"Authorization": f"Bearer {CHAVE}", "Idempotency-Key": f"{sessao}-{time.time_ns()}", "X-Hermes-Session-Key": sessao}
    st, j = http("POST", base + "/v1/runs", {"input": "use a chave", "instructions": "teste"}, h)
    if st != 202:
        return f"http {st}: {j}", []
    fim, estado = time.time() + espera, "sem fim"
    while time.time() < fim:
        st, r = http("GET", base + f"/v1/runs/{j['run_id']}", None, {"Authorization": f"Bearer {CHAVE}"})
        if isinstance(r, dict) and r.get("status") in ("completed", "failed", "cancelled", "interrupted"):
            estado = r.get("status")
            break
        time.sleep(0.3)
    with trava:
        ultima = chamadas[-1]["msgs"] if chamadas else []
    return estado, [str(m.get("content")) for m in ultima if m.get("role") == "tool"]


def visivel(saida):
    return "VISIVEL" in saida and "AUSENTE" not in saida


def ausente(saida):
    return "AUSENTE" in saida and "VISIVEL" not in saida


try:
    de_pe = False
    for _ in range(120):
        if gw.poll() is not None:
            break
        if http("GET", f"http://127.0.0.1:{API}/health", timeout=2)[0] == 200 and ponte("GET", "/ergon/v1/health")[0] == 200:
            de_pe = True
            break
        time.sleep(1)
    check("o gateway do Hermes subiu com vários perfis, a API e a ponte de controle", de_pe, open("/tmp/gateway-teste-chaves.log").read()[-1500:])
    if not de_pe:
        raise SystemExit(1)

    HIP = "erg-" + "e" * 20
    pedido = {"alma": "Você é Hipátia, no Ergon.", "ferramentas": ["todo", "terminal"], "memoria": False, "busca": False, "ajudantes": {"ligado": False}, "competencias": []}
    st, r = ponte("PUT", f"/ergon/v1/perfis/{HIP}", pedido)
    check("perfil do agente criado com o gateway de pé", st == 200 and r.get("criado") is True, str((st, r)))

    # 1. no perfil do agente: a chave entregue pelo cartão no meio do trabalho vale no comando seguinte (o escopo de
    #    segredos do pedido foi montado antes dela)
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}),
                              ferramenta("pedir_chave", {"nome": NOME, "motivo": "ler o sensor do jardim"}),
                              ferramenta("terminal", {"command": VER}),
                              ferramenta("terminal", {"command": SHA}),
                              fala("Feito.")], "sess-hip-1")
    check("execução no perfil termina", est == "completed" and len(saidas) == 4, str((est, saidas))[:600])
    saidas += [""] * (4 - len(saidas))
    check("antes do cartão: a chave não existe no perfil", ausente(saidas[0]), saidas[0][:300])
    check("o cartão guardou a chave (o agente recebe só o nome)", '"guardada_como": "JARDIM_API_KEY"' in saidas[1] and SEGREDO not in saidas[1], saidas[1][:300])
    check("no perfil do agente, a chave entregue no meio do trabalho chega ao Terminal no comando seguinte", visivel(saidas[2]), saidas[2][:300])
    check("com o valor certo (o resumo confere)", RESUMO in saidas[3], saidas[3][:300])
    check("o valor não volta ao modelo: a saída do Terminal chega mascarada", SEGREDO not in saidas[2] and "valor=" in saidas[2] and "valor=\n" not in saidas[2] + "\n" and SEGREDO not in json.dumps(chamadas, ensure_ascii=False), saidas[2][:300])
    envp = open(os.path.join(HOME, "profiles", HIP, ".env"), encoding="utf-8").read()
    check("a chave está no .env do perfil", f"{NOME}={SEGREDO}" in envp)

    # 2. no pedido seguinte, também
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-hip-2")
    check("pedido seguinte no perfil: a chave chega ao Terminal", est == "completed" and saidas and visivel(saidas[0]) and SEGREDO not in saidas[0], str(saidas)[:300])

    # 3. o perfil padrão continua igual
    est, saidas = rodar("", [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-padrao-1")
    check("perfil padrão: a chave chega ao Terminal, mascarada", est == "completed" and saidas and visivel(saidas[0]) and SEGREDO not in saidas[0], str((est, saidas))[:300])

    # 4. outro perfil sem a chave no .env dele: nada vaza do ambiente do processo
    EUC = "erg-" + "f" * 20
    ponte("PUT", f"/ergon/v1/perfis/{EUC}", {**pedido, "alma": "Você é Euclides."})
    pe = os.path.join(HOME, "profiles", EUC, ".env")
    texto = open(pe, encoding="utf-8").read()
    check("o .env do segundo perfil também recebeu a chave da equipe", f"{NOME}=" in texto)
    with open(pe, "w", encoding="utf-8") as f:
        f.write("".join(ln + "\n" for ln in texto.splitlines() if not ln.startswith(f"{NOME}=")))
    est, saidas = rodar(EUC, [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-euc-1")
    check("perfil sem a chave no .env dele: o Terminal não a recebe (nem do ambiente do processo)", est == "completed" and saidas and ausente(saidas[0]), str((est, saidas))[:300])

    # 5. apagada no meio de um trabalho: sai na hora (o comando seguinte já não a tem)
    def apagar():
        st, r = ponte("DELETE", f"/ergon/v1/chaves/{NOME}")
        check("a ponte apaga a chave", st == 200 and r.get("apagada") is True, str((st, r)))
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}), ferramenta("terminal", {"command": VER}, antes=apagar), fala("ok")], "sess-hip-3")
    saidas += [""] * (2 - len(saidas))
    check("antes de apagar: a chave chega", est == "completed" and visivel(saidas[0]), str((est, saidas))[:300])
    check("apagada no meio do trabalho: o comando seguinte já não a tem", ausente(saidas[1]), saidas[1][:300])
    check("fora do .env do perfil", f"{NOME}=" not in open(os.path.join(HOME, "profiles", HIP, ".env"), encoding="utf-8").read())
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-hip-4")
    check("pedido seguinte no perfil depois de apagar: AUSENTE", est == "completed" and saidas and ausente(saidas[0]), str((est, saidas))[:300])
    est, saidas = rodar("", [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-padrao-2")
    check("perfil padrão depois de apagar: AUSENTE", est == "completed" and saidas and ausente(saidas[0]), str((est, saidas))[:300])
    check("o valor nunca apareceu no registro do motor", SEGREDO not in open("/tmp/gateway-teste-chaves.log", encoding="utf-8", errors="replace").read())

    # 6. chave guardada antes de o motor reiniciar (na partida, o .env do perfil padrão entra no ambiente do processo):
    #    continua chegando aos dois, e apagada sai dos dois na hora
    st, _r = ponte("PUT", "/ergon/v1/chaves", {"nome": NOME, "valor": SEGREDO, "motivo": "de novo", "agente": "Hipátia"})
    check("guardada de novo pela ponte", st == 200)
    gw.terminate()
    gw.wait(30)
    if os.geteuid() == 0:  # a CI roda os testes como root; o motor de verdade roda como usuário comum
        env["HERMES_ALLOW_ROOT_GATEWAY"] = "1"
    gw = subprocess.Popen(["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"], env=env, stdout=log, stderr=subprocess.STDOUT, cwd=HOME)
    de_pe = False
    for _ in range(120):
        if http("GET", f"http://127.0.0.1:{API}/health", timeout=2)[0] == 200 and ponte("GET", "/ergon/v1/health")[0] == 200:
            de_pe = True
            break
        time.sleep(1)
    check("o motor reiniciou", de_pe)
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-hip-5")
    check("depois de reiniciar: a chave chega ao Terminal do perfil", est == "completed" and saidas and visivel(saidas[0]) and SEGREDO not in saidas[0], str((est, saidas))[:300])
    est, saidas = rodar("", [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-padrao-3")
    check("depois de reiniciar: e ao do perfil padrão", est == "completed" and saidas and visivel(saidas[0]) and SEGREDO not in saidas[0], str((est, saidas))[:300])
    st, r = ponte("DELETE", f"/ergon/v1/chaves/{NOME}")
    est, saidas = rodar("", [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-padrao-4")
    check("apagada depois de reiniciar: sai do perfil padrão na hora", st == 200 and est == "completed" and saidas and ausente(saidas[0]), str((st, est, saidas))[:300])
    est, saidas = rodar(HIP, [ferramenta("terminal", {"command": VER}), fala("ok")], "sess-hip-6")
    check("e do perfil do agente", est == "completed" and saidas and ausente(saidas[0]), str((est, saidas))[:300])
finally:
    gw.terminate()
    try:
        gw.wait(20)
    except subprocess.TimeoutExpired:
        gw.kill()

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

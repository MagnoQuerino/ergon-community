"""Equipe nativa (rc.27) no motor de verdade: o gateway do Hermes de pé, um modelo falso e um Ergon simulado (sem rede).

Confere, com o plugin desta cópia do código: a ponte de controle cria o perfil do agente com o gateway ligado e a execução
em /p/<perfil>/v1/runs funciona sem reiniciar; o SOUL do perfil abre as instruções; a trava de ferramentas do Ergon vale
dentro do perfil (o plugin vai junto, por atalho); a configuração do perfil sai da configuração da equipe com as
ferramentas do agente; criar de novo não muda nada (idempotente) e uma mudança na configuração da equipe chega ao perfil; a
competência aprendida no perfil padrão (onde o Treinar gravava até a rc.26) passa a morar no perfil; a memória longa fica
em espera até a aprovação e só então entra nas instruções; a busca em conversas antigas não lê o perfil de outro agente;
o ajudante temporário trabalha com a política de quem o chamou e o Ergon é avisado do começo e do fim (com o resultado).

  podman run --rm --network none --user 10000:10000 --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_perfis.py
"""
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
API, PONTE = 18642, 18643

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""), flush=True)
    ok = ok and cond


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


# ---------- Ergon simulado: a política de ferramentas e os avisos do plugin
pedidos = []
policy = {"known": True, "agent": "Hipátia", "toolsets": ["todo", "memory", "session_search", "delegation", "skills"], "holders": {}, "guarded": {}, "skills": ["ergon-relatorio-mensal"], "bloqueadas": []}
sessoes_conhecidas = set()   # o Ergon só conhece a sessão das execuções que ele começou (run_…)
trava = threading.Lock()


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        with trava:
            pedidos.append({"path": self.path, "body": b})
        if self.path.endswith("/tool-policy"):
            return self.responder(policy if str(b.get("session_id", "")).startswith("run_") else {"known": False})
        return self.responder({"ok": True})


# ---------- modelo falso: o roteiro tem falas do agente e do ajudante (o pedido do ajudante traz MARCA-FILHO)
chamadas = []
roteiro = []


def fala(texto, para="pai"):
    return {"para": para, "role": "assistant", "content": texto}


def ferramenta(nome, args, para="pai"):
    return {"para": para, "role": "assistant", "content": None, "tool_calls": [{"id": f"call_{time.time_ns()}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        msgs = b.get("messages", [])
        sistema = next((m.get("content") for m in msgs if m.get("role") == "system"), "")
        if isinstance(sistema, list):
            sistema = " ".join(str(p.get("text", "")) for p in sistema if isinstance(p, dict))
        quem = "filho" if any(m.get("role") == "user" and "MARCA-FILHO" in str(m.get("content")) for m in msgs[:2]) else "pai"
        with trava:
            chamadas.append({"quem": quem, "tools": sorted(t.get("function", {}).get("name", "") for t in b.get("tools") or []), "sistema": str(sistema), "msgs": msgs})
            # chamadas auxiliares (título da conversa): sem ferramentas, não consomem o roteiro
            i = next((i for i, r in enumerate(roteiro) if r["para"] == quem), None) if b.get("tools") else None
            m = dict(roteiro.pop(i)) if i is not None else {"role": "assistant", "content": "Pronto."}
        m.pop("para", None)

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

# ---------- a configuração que as migrações 1 a 4 do cofre deixam, com o modelo falso; e uma competência do Treinar gravada
# no perfil padrão, como até a rc.26
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(f"""model:
  provider: custom
  default: modelo-falso
  base_url: http://127.0.0.1:{PORTA_MODELO}/v1
  api_key: chave-falsa
plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, web, vision, image_gen, skills, ergon_conexoes]
  teams: [todo]
known_plugin_toolsets:
  api_server: [ergon_conexoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
skills:
  write_approval: true
compression:
  threshold_tokens: 150000
gateway:
  multiplex_profiles: true
""")
with open(os.path.join(HOME, ".env"), "w", encoding="utf-8") as f:
    f.write(f"API_SERVER_KEY={CHAVE}\nOPENROUTER_API_KEY=chave-de-provedor-de-teste\nTELEGRAM_BOT_TOKEN=token-de-canal-de-teste\n")
os.makedirs(os.path.join(HOME, "skills", "ergon", "ergon-relatorio-mensal"))
with open(os.path.join(HOME, "skills", "ergon", "ergon-relatorio-mensal", "SKILL.md"), "w", encoding="utf-8") as f:
    f.write("---\nname: ergon-relatorio-mensal\ndescription: Como fazer o relatório mensal\n---\nPasso 1 MARCA-COMPETENCIA\n")

env = {**os.environ, "HERMES_HOME": HOME, "HOME": HOME, "API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1", "API_SERVER_PORT": str(API), "API_SERVER_KEY": CHAVE,
       "ERGON_CONTROL_PORT": str(PONTE), "ERGON_BRIDGE_URL": f"http://127.0.0.1:{PORTA_ERGON}/internal/bridge/v1/events", "ERGON_BRIDGE_TOKEN": TOKEN,
       "HERMES_GATEWAY_NO_SUPERVISE": "1"}
log = open("/tmp/gateway-teste.log", "w")
gw = subprocess.Popen(["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"], env=env, stdout=log, stderr=subprocess.STDOUT, cwd=HOME)


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


def rodar(perfil, texto, script, sessao, espera=60):
    """Uma execução em /p/<perfil>/v1/runs até o fim; devolve (estado, saída, id) e deixa em `chamadas` o que o modelo viu."""
    with trava:
        chamadas.clear()
        roteiro[:] = script
    base = f"http://127.0.0.1:{API}" + (f"/p/{perfil}" if perfil else "")
    h = {"Authorization": f"Bearer {CHAVE}", "Idempotency-Key": f"{sessao}-{time.time_ns()}", "X-Hermes-Session-Key": sessao}
    st, j = http("POST", base + "/v1/runs", {"input": texto, "instructions": "INSTRUCAO-DO-PEDIDO"}, h)
    if st != 202:
        return f"http {st}", str(j), ""
    fim = time.time() + espera
    while time.time() < fim:
        st, r = http("GET", base + f"/v1/runs/{j['run_id']}", None, {"Authorization": f"Bearer {CHAVE}"})
        if isinstance(r, dict) and r.get("status") in ("completed", "failed", "cancelled", "interrupted"):
            return r.get("status"), r.get("output"), j["run_id"]
        time.sleep(0.3)
    return "sem fim", None, j["run_id"]


def ultima_de_ferramenta(quem="pai"):
    for c in reversed(chamadas):
        if c["quem"] == quem and c["msgs"] and c["msgs"][-1].get("role") == "tool":
            return str(c["msgs"][-1].get("content"))
    return ""


try:
    de_pe = False
    for _ in range(120):
        if gw.poll() is not None:
            break
        if http("GET", f"http://127.0.0.1:{API}/health", timeout=2)[0] == 200 and ponte("GET", "/ergon/v1/health")[0] == 200:
            de_pe = True
            break
        time.sleep(1)
    check("o gateway do Hermes subiu com a API e a ponte de controle", de_pe, open("/tmp/gateway-teste.log").read()[-1500:])
    if not de_pe:
        raise SystemExit(1)
    st, saude = ponte("GET", "/ergon/v1/health")
    check("a ponte diz que sabe perfis, memória e ajudantes", {"perfis", "memoria", "ajudantes"} <= set(saude.get("capacidades") or []), str(saude))

    HIP, EUC = "erg-" + "a" * 20, "erg-" + "b" * 20
    pedido = {"alma": "Você é Hipátia, analista, no Ergon — setor Análise.\nMARCA-ALMA-HIPATIA", "ferramentas": ["todo", "web", "skills", "ergon_conexoes", "terminal"],
              "memoria": True, "busca": True, "ajudantes": {"ligado": True, "max": 2}, "competencias": ["ergon-relatorio-mensal", "nao-existe"]}

    # 1. criar com o gateway de pé e usar sem reiniciar
    A = {"Authorization": f"Bearer {CHAVE}"}
    check("antes de criar, o perfil não existe para a API", http("GET", f"http://127.0.0.1:{API}/p/{HIP}/v1/capabilities", None, A)[0] == 404)
    st, r = ponte("PUT", f"/ergon/v1/perfis/{HIP}", pedido)
    check("a ponte cria o perfil", st == 200 and r.get("criado") is True, str((st, r)))
    check("logo depois, a API atende o perfil (sem reiniciar)", http("GET", f"http://127.0.0.1:{API}/p/{HIP}/v1/capabilities", None, A)[0] == 200)
    check("a chave errada não entra no perfil", http("GET", f"http://127.0.0.1:{API}/p/{HIP}/v1/capabilities", None, {"Authorization": "Bearer errada-errada-errada-errada"})[0] == 401)
    D = os.path.join(HOME, "profiles", HIP)
    import hermes_yaml as yaml
    cfg = yaml.safe_load(open(os.path.join(D, "config.yaml"), encoding="utf-8").read())
    check("ferramentas do perfil: as ligadas para a equipe que o agente tem, mais memória, busca, ajudantes e os cartões (Terminal não foi ligado: fica fora)",
          cfg["platform_toolsets"]["api_server"] == ["delegation", "ergon_cartoes", "ergon_conexoes", "memory", "session_search", "skills", "todo", "web"], str(cfg["platform_toolsets"]))
    check("linha de comando e agendador do perfil: a mesma lista, nunca a larga", cfg["platform_toolsets"]["cli"] == cfg["platform_toolsets"]["api_server"] == cfg["platform_toolsets"]["cron"])
    check("memória com aprovação de escrita; competências também", cfg["memory"] == {"memory_enabled": True, "user_profile_enabled": True, "write_approval": True} and cfg["skills"]["write_approval"] is True, str(cfg.get("memory")))
    check("ajudantes: poucos ao mesmo tempo e sem ajudante de ajudante", cfg["delegation"] == {"max_concurrent_children": 2, "max_spawn_depth": 1}, str(cfg.get("delegation")))
    check("o que é da equipe vem junto (modelo, passos, resumo)", cfg["model"]["default"] == "modelo-falso" and cfg["agent"]["max_turns"] == 20 and cfg["compression"]["threshold_tokens"] == 150000)
    check("a chave de multiplexação fica só no perfil padrão", "gateway" not in cfg, str(cfg.get("gateway")))
    envp = open(os.path.join(D, ".env"), encoding="utf-8").read()
    check(".env do perfil: a chave da API e a do provedor, sem o token do canal", f"API_SERVER_KEY={CHAVE}" in envp and "OPENROUTER_API_KEY=" in envp and "TELEGRAM_BOT_TOKEN" not in envp, envp.replace(CHAVE, "…"))
    atalho = os.path.join(D, "plugins", "ergon_bridge")
    check("o plugin vai junto, por atalho para a cópia da equipe", os.path.islink(atalho) and os.path.isfile(os.path.join(atalho, "__init__.py")))
    check("a competência aprendida (gravada no perfil padrão até a rc.26) agora mora no perfil; a original fica onde estava",
          os.path.isfile(os.path.join(D, "skills", "ergon", "ergon-relatorio-mensal", "SKILL.md")) and os.path.isfile(os.path.join(HOME, "skills", "ergon", "ergon-relatorio-mensal", "SKILL.md")))
    check("sem as competências de fábrica no perfil", sum(1 for _r, _d, fs in os.walk(os.path.join(D, "skills")) if "SKILL.md" in fs) == 1)
    st, r = ponte("PUT", f"/ergon/v1/perfis/{HIP}", pedido)
    check("garantir de novo não muda nada (idempotente)", st == 200 and r.get("criado") is False and r.get("mudou") == [], str(r))
    check("nome fora do formato: recusado", ponte("PUT", "/ergon/v1/perfis/default", pedido)[0] == 404 and ponte("PUT", "/ergon/v1/perfis/erg-..%2f..%2fx", pedido)[0] == 404)
    check("sem o token da ponte: nada", http("PUT", f"http://127.0.0.1:{PONTE}/ergon/v1/perfis/{HIP}", pedido)[0] == 401)

    # 2. a execução no perfil: o SOUL abre as instruções, a trava do Ergon vale ali, a competência carrega
    est, saida, rid = rodar(HIP, "olá", [ferramenta("skill_view", {"name": "ergon-relatorio-mensal"}), ferramenta("terminal", {"command": "id"}), fala("Feito.")], "sess-hip-1")
    check("execução no perfil termina", est == "completed" and saida == "Feito.", str((est, saida)))
    c0 = chamadas[0] if chamadas else {"sistema": "", "tools": []}
    check("o SOUL do perfil abre as instruções; as do pedido vão no fim", c0["sistema"].startswith("Você é Hipátia, analista, no Ergon") and "MARCA-ALMA-HIPATIA" in c0["sistema"]
          and c0["sistema"].rstrip().endswith("INSTRUCAO-DO-PEDIDO"), c0["sistema"][:200])
    check("o modelo recebe as ferramentas do perfil (com memória, busca e ajudantes; sem Terminal)",
          {"memory", "session_search", "delegate_task", "skill_view", "conexoes_executar"} <= set(c0["tools"]) and "terminal" not in c0["tools"], str(c0["tools"]))
    check("o índice de competências só tem as do agente", "arxiv" not in c0["sistema"], "")
    pol = [p for p in pedidos if p["path"].endswith("/tool-policy")]
    check("a trava de ferramentas do Ergon é consultada de dentro do perfil, com a sessão da execução", bool(pol) and pol[-1]["body"].get("session_id") == rid, str(pol[-1:] if pol else pedidos))
    vistas = [str(c["msgs"][-1].get("content")) for c in chamadas if c["msgs"] and c["msgs"][-1].get("role") == "tool"]
    check("a competência do agente carrega do perfil dele", any("MARCA-COMPETENCIA" in v for v in vistas), str(vistas)[:400])

    # 3. memória longa: em espera até a aprovação; aprovada, entra nas instruções; recusada, some
    est, saida, rid = rodar(HIP, "lembre que prefiro relatórios curtos PALAVRA-RARA-ZEBRA", [ferramenta("memory", {"action": "add", "target": "user", "content": "Prefere relatórios curtos. MARCA-MEMORIA"}), fala("Anotei PALAVRA-RARA-ZEBRA.")], "sess-hip-2")
    check("a anotação fica em espera (nada gravado ainda)", '"staged": true' in ultima_de_ferramenta() and not os.path.exists(os.path.join(D, "memories", "USER.md")), ultima_de_ferramenta()[:300])
    aviso = [p for p in pedidos if p["path"].endswith("/memoria-pendente")]
    check("o Ergon é avisado da anotação em espera, com a sessão da execução", bool(aviso) and aviso[-1]["body"].get("session_id") == rid and bool(aviso[-1]["body"].get("pending_id")), str(aviso))
    st, mem = ponte("GET", f"/ergon/v1/perfis/{HIP}/memoria")
    pend = (mem.get("pendentes") or [{}])[0] if st == 200 else {}
    check("a ponte mostra a anotação em espera", st == 200 and len(mem["pendentes"]) == 1 and pend.get("alvo") == "pessoa" and "MARCA-MEMORIA" in pend["itens"][0]["texto"] and mem["pessoa"] == "", str(mem))
    st, r = ponte("POST", f"/ergon/v1/perfis/{HIP}/memoria/pendentes", {"id": pend.get("id"), "aprovar": True})
    st2, mem = ponte("GET", f"/ergon/v1/perfis/{HIP}/memoria")
    check("aprovada: gravada na memória do perfil e fora da espera", st == 200 and "MARCA-MEMORIA" in mem.get("pessoa", "") and mem.get("pendentes") == [], str((st, r, mem)))
    check("aprovar de novo a mesma: recusado, sem gravar duas vezes", ponte("POST", f"/ergon/v1/perfis/{HIP}/memoria/pendentes", {"id": pend.get("id"), "aprovar": True})[0] == 400)
    rodar(HIP, "oi", [fala("Oi.")], "sess-hip-3")
    check("no pedido seguinte, a memória aprovada está nas instruções", "MARCA-MEMORIA" in chamadas[0]["sistema"])
    rodar(HIP, "anote", [ferramenta("memory", {"action": "add", "target": "memory", "content": "MARCA-RECUSADA"}), fala("ok")], "sess-hip-4")
    st, mem = ponte("GET", f"/ergon/v1/perfis/{HIP}/memoria")
    ponte("POST", f"/ergon/v1/perfis/{HIP}/memoria/pendentes", {"id": mem["pendentes"][0]["id"], "aprovar": False})
    st, mem = ponte("GET", f"/ergon/v1/perfis/{HIP}/memoria")
    check("recusada: sai da espera e nada é gravado", mem.get("pendentes") == [] and "MARCA-RECUSADA" not in mem.get("notas", "") + mem.get("pessoa", ""), str(mem))

    # 4. outro agente, outro perfil: memória e conversas separadas; a busca não atravessa
    st, r = ponte("PUT", f"/ergon/v1/perfis/{EUC}", {**pedido, "alma": "Você é Euclides. MARCA-ALMA-EUCLIDES", "competencias": [], "ajudantes": {"ligado": False}})
    check("segundo perfil criado", st == 200 and r.get("criado") is True, str(r))
    cfg2 = yaml.safe_load(open(os.path.join(HOME, "profiles", EUC, "config.yaml"), encoding="utf-8").read())
    check("ajudantes desligados: sem a ferramenta no perfil", "delegation" not in cfg2["platform_toolsets"]["api_server"], str(cfg2["platform_toolsets"]))
    est, _s, _r = rodar(EUC, "procure", [ferramenta("session_search", {"query": "PALAVRA-RARA-ZEBRA"}), fala("ok")], "sess-euc-1")
    check("o outro agente não tem a memória da Hipátia nem a alma dela", "MARCA-MEMORIA" not in chamadas[0]["sistema"] and "MARCA-ALMA-EUCLIDES" in chamadas[0]["sistema"])
    check("a busca dele não acha a conversa da Hipátia", '"results": []' in ultima_de_ferramenta(), ultima_de_ferramenta()[:300])
    rodar(EUC, "procure", [ferramenta("session_search", {"query": "PALAVRA-RARA-ZEBRA", "profile": HIP}), fala("ok")], "sess-euc-2")
    check("pedir o perfil de outro agente na busca: barrado pelo plugin", "só para as suas próprias conversas" in ultima_de_ferramenta() and "Anotei" not in ultima_de_ferramenta(), ultima_de_ferramenta()[:300])
    rodar(HIP, "procure", [ferramenta("session_search", {"query": "PALAVRA-RARA-ZEBRA"}), fala("ok")], "sess-hip-5")
    check("a Hipátia acha a própria conversa antiga", "PALAVRA-RARA-ZEBRA" in ultima_de_ferramenta() and '"results": []' not in ultima_de_ferramenta(), ultima_de_ferramenta()[:300])

    # 5. ajudante temporário: política de quem chamou; o Ergon sabe do começo e do fim; o resultado entra no pedido seguinte
    pedidos.clear()
    est, saida, rid = rodar(HIP, "divida o trabalho", [ferramenta("delegate_task", {"goal": "MARCA-FILHO faça a lista", "context": "teste"}), fala("Aguardando o ajudante."),
                                                     ferramenta("todo_list", {"todos": [{"id": "1", "content": "do ajudante", "status": "pending"}]}, "filho"), fala("Ajudante terminou MARCA-RESULTADO.", "filho")], "sess-hip-6")
    fim = time.time() + 30
    while time.time() < fim and not [p for p in pedidos if p["path"].endswith("/ajudante") and p["body"].get("evento") == "fim"]:
        time.sleep(0.3)
    aj = [p["body"] for p in pedidos if p["path"].endswith("/ajudante")]
    check("o Ergon é avisado do começo e do fim do ajudante, com a sessão de quem chamou", [a.get("evento") for a in aj] == ["inicio", "fim"] and all(a.get("session_id") == rid for a in aj), str(aj))
    pol = [p["body"].get("session_id") for p in pedidos if p["path"].endswith("/tool-policy")]
    check("a ferramenta do ajudante é conferida com a sessão de quem chamou (a dele o Ergon não conhece)", bool(pol) and all(s == rid for s in pol), str(pol))
    filho = [c for c in chamadas if c["quem"] == "filho"]
    check("o ajudante trabalhou (a ferramenta dele passou pela trava)", any(c["msgs"][-1].get("role") == "tool" and "do ajudante" in str(c["msgs"][-1].get("content")) for c in filho), str([c["msgs"][-1] for c in filho])[:400])
    check("o ajudante não chama outro ajudante nem mexe na memória", bool(filho) and "delegate_task" not in filho[0]["tools"] and "memory" not in filho[0]["tools"], str(filho[0]["tools"] if filho else None))
    check("em /v1/runs a execução termina antes do ajudante (o Ergon faz a continuação)", est == "completed" and saida == "Aguardando o ajudante.", str((est, saida)))
    check("o aviso do fim traz o resultado do ajudante (o Ergon o entrega ao agente na continuação)", bool(aj) and "MARCA-RESULTADO" in str(aj[-1].get("resumo")), str(aj[-1:]))
    est, saida, _r = rodar(HIP, "Os ajudantes terminaram. Resultado: Ajudante terminou MARCA-RESULTADO. Entregue.", [fala("Entrega final.")], "sess-hip-6")
    visto = json.dumps(chamadas[0]["msgs"], ensure_ascii=False) if chamadas else ""
    check("a continuação roda na mesma conversa (o agente vê o que disse antes e o resultado)", est == "completed" and saida == "Entrega final." and "Aguardando o ajudante." in visto and "MARCA-RESULTADO" in visto, visto[-600:])

    # 5b. modelos por tarefa DESTE agente (junção rc.27: janela do agente › Modelos por tarefa, gravados pelo painel do
    # Hermes no config.yaml do perfil, por /p/<perfil>/api/model/set e /p/<perfil>/ergon/v1/delegacao). A ponte lembra a
    # escolha; quando a configuração da equipe muda e o perfil é refeito, a escolha do agente fica por cima.
    sys.path.insert(0, "/p")
    import ergon_bridge as plug  # noqa: E402
    plug._lembrar_modelo_do_perfil(HIP, "auxiliary", {"scope": "auxiliary", "task": "vision", "provider": "custom", "model": "modelo-de-visao"})
    plug._lembrar_modelo_do_perfil(HIP, "auxiliary", {"scope": "auxiliary", "task": "title_generation", "provider": "custom", "model": "modelo-de-titulo"})
    plug._lembrar_modelo_do_perfil(HIP, "auxiliary", {"scope": "auxiliary", "task": "title_generation", "provider": "auto", "model": ""})   # voltou a usar o principal
    plug._lembrar_modelo_do_perfil(HIP, "delegation", {"provider": "custom", "model": "modelo-dos-ajudantes"})
    lembrado = json.load(open(os.path.join(D, ".ergon-perfil-modelos.json"), encoding="utf-8"))
    check("modelos do agente: a ponte lembra a escolha (e esquece a que voltou ao principal)",
          lembrado == {"auxiliary": {"vision": {"provider": "custom", "model": "modelo-de-visao"}}, "delegation": {"provider": "custom", "model": "modelo-dos-ajudantes"}}, str(lembrado))
    plug._lembrar_modelo_do_perfil("erg-" + "d" * 20, "auxiliary", {"task": "vision", "provider": "custom", "model": "x"})
    check("modelos do agente: perfil que não existe não ganha arquivo", not os.path.exists(os.path.join(HOME, "profiles", "erg-" + "d" * 20)))

    # 6. a configuração da equipe mudou (a pessoa ligou o Terminal): o perfil acompanha no próximo garantir
    r0 = subprocess.run(["/opt/hermes/.venv/bin/hermes", "config", "set", "platform_toolsets.api_server", '["todo","web","skills","ergon_conexoes","terminal"]'], env=env, capture_output=True, timeout=120)
    st, r = ponte("PUT", f"/ergon/v1/perfis/{HIP}", pedido)
    cfg = yaml.safe_load(open(os.path.join(D, "config.yaml"), encoding="utf-8").read())
    check("mudança na configuração da equipe chega ao perfil", r0.returncode == 0 and r.get("mudou") == ["config"] and "terminal" in cfg["platform_toolsets"]["api_server"], str((r, cfg["platform_toolsets"])))
    check("o perfil refeito mantém os modelos por tarefa do agente (ver imagens e ajudantes)",
          (cfg.get("auxiliary") or {}).get("vision", {}).get("model") == "modelo-de-visao" and (cfg.get("auxiliary") or {}).get("vision", {}).get("provider") == "custom"
          and (cfg.get("delegation") or {}).get("model") == "modelo-dos-ajudantes" and (cfg.get("delegation") or {}).get("max_spawn_depth") == 1, str((cfg.get("auxiliary"), cfg.get("delegation"))))
    check("o que o agente não escolheu segue a equipe (dar nome à conversa)", (cfg.get("auxiliary") or {}).get("title_generation", {}).get("model") in (None, ""), str(cfg.get("auxiliary")))
    st, r = ponte("PUT", f"/ergon/v1/perfis/{HIP}", {**pedido, "alma": "Você é Hipátia, agora coordenadora. MARCA-ALMA-NOVA"})
    rodar(HIP, "oi", [fala("Oi.")], "sess-hip-7")
    check("mudou a função do agente: o SOUL novo vale no pedido seguinte, e a memória continua", r.get("mudou") == ["alma"] and "MARCA-ALMA-NOVA" in chamadas[0]["sistema"] and "MARCA-MEMORIA" in chamadas[0]["sistema"], str(r))

    # 7. Treinar dentro do perfil: as rotas de competência valem na pasta do agente
    st, r = ponte("POST", "/ergon/v1/skills/files", {"name": "ergon-relatorio-mensal", "perfil": HIP})
    check("Treinar: lê a competência do perfil do agente", st == 200 and "MARCA-COMPETENCIA" in (r.get("files") or {}).get("SKILL.md", ""), str(r)[:300])
    st, r = ponte("POST", "/ergon/v1/skills/files", {"name": "ergon-relatorio-mensal", "perfil": EUC})
    check("Treinar: no perfil de outro agente ela não existe", st == 200 and r.get("files") == {}, str(r)[:300])
    st, r = ponte("POST", "/ergon/v1/skills/restore", {"name": "ergon-nova-do-perfil", "perfil": EUC, "files": {"SKILL.md": "---\nname: x\ndescription: Nova\n---\nCorpo MARCA-NOVA\n"}})
    check("Treinar: gravar uma competência grava no perfil do agente, não no padrão", st == 200 and os.path.isfile(os.path.join(HOME, "profiles", EUC, "skills", "ergon", "ergon-nova-do-perfil", "SKILL.md"))
          and not os.path.exists(os.path.join(HOME, "skills", "ergon", "ergon-nova-do-perfil")), str((st, r))[:300])
    check("Treinar: perfil que não existe: recusado", ponte("POST", "/ergon/v1/skills/files", {"name": "ergon-relatorio-mensal", "perfil": "erg-" + "c" * 20})[0] == 409)

    # 8. o perfil padrão continua como antes (quem ainda não migrou roda nele)
    est, saida, _r = rodar("", "oi", [fala("Oi do padrão.")], "sess-padrao-1")
    check("o perfil padrão continua atendendo em /v1/runs", est == "completed" and saida == "Oi do padrão." and "MARCA-ALMA" not in chamadas[0]["sistema"], str((est, saida)))
    st, lst = ponte("GET", "/ergon/v1/perfis")
    check("a ponte lista os perfis da equipe", st == 200 and lst.get("perfis") == [HIP, EUC], str(lst))
finally:
    gw.terminate()
    try:
        gw.wait(20)
    except subprocess.TimeoutExpired:
        gw.kill()

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

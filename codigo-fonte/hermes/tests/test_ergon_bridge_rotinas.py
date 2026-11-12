"""Rotinas no agendador e aprovações nativas (rc.27) no motor de verdade: o gateway do Hermes de pé, um modelo falso e um
Ergon simulado (sem rede).

Confere, com o plugin desta cópia do código:
- Rotinas: a ponte de controle cria o job da rotina no PERFIL do agente (nunca no padrão), sem agente (no_agent + script),
  com o horário da pessoa convertido para o fuso do motor; de novo não cria outro (idempotente); pausar e retomar ficam no
  agendador; "rodar agora" dispara pelo agendador e o aviso chega ao Ergon pelo plugin (rotina, perfil, hora), sem chamar o
  modelo; o agente mudou: o job vai para o perfil novo e sai do antigo; tirar a rotina tira o job e o script.
- Aprovações: um comando perigoso do Terminal para o turno e aparece no fluxo de eventos (approval.request); respondido pela
  API (POST /v1/runs/{id}/approval) com "once", o comando roda; com "deny", não roda. Uma ação numa conta que espera a
  confirmação da pessoa segura o turno no portão de aprovação do motor (approval.request com o cartão do Ergon); a pessoa
  decide, o Ergon responde e a ferramenta devolve ao modelo o resultado que está no Ergon, no mesmo turno; sem resposta no
  prazo do motor, a ferramenta devolve que o cartão continua com a pessoa (nada se perde). A aprovação depois de ler as
  contas também segura o turno e, aprovada, a ferramenta segue.

  podman run --rm --network none --user 10000:10000 --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_rotinas.py
"""
import http.client as httpc
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"))
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"))
TOKEN = "token-da-ponte-de-teste-" + "0123456789"
CHAVE = "chave-da-api-de-teste-" + "0123456789abcdef"
API, PONTE = 18652, 18653

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


# ---------- Ergon simulado: a política, os avisos das rotinas, as conexões e a aprovação depois de ler
pedidos = []
trava = threading.Lock()
CARTAO_CONTA = "apr_" + "1" * 32
CARTAO_LER = "apr_" + "2" * 32
CARTAO_PRAZO = "apr_" + "3" * 32
decididos = {}   # cartão → "feita" | "recusada" (o que a pessoa decidiu no Ergon)
policy = {"known": True, "agent": "Hipátia", "toolsets": ["todo", "terminal", "ergon_conexoes", "web"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}


class Ergon(Base):
    def do_POST(self):
        b = self.corpo()
        with trava:
            pedidos.append({"path": self.path, "body": b, "em": time.time()})
        if self.path.endswith("/tool-policy"):
            return self.responder(policy if str(b.get("session_id", "")).startswith("run_") else {"known": False})
        if self.path.endswith("/conexoes"):
            cartao = CARTAO_PRAZO if "PRAZO" in json.dumps(b) else CARTAO_CONTA
            if b.get("op") == "cartao":
                cartao = b.get("cartao")
                if decididos.get(cartao) == "feita":
                    return self.responder({"ok": True, "status": "feita", "texto": "A pessoa confirmou e foi feito. Resultado: MARCA-RESULTADO-DO-ERGON"})
                return self.responder({"ok": True, "status": "aguardando_confirmacao", "texto": "A pessoa ainda não decidiu: o cartão continua com ela. MARCA-CONTINUA-COM-ELA"})
            return self.responder({"ok": True, "status": "aguardando_confirmacao", "texto": "A ação espera o clique da pessoa.", "cartao": cartao, "resumo": "Microsoft: enviar e-mail para x"})
        if self.path.endswith("/depois-de-ler"):
            if decididos.get(CARTAO_LER) == "feita":
                return self.responder({"liberada": True, "texto": ""})
            return self.responder({"liberada": False, "texto": "A ferramenta espera a aprovação da pessoa. MARCA-ESPERA-LER", "cartao": CARTAO_LER})
        return self.responder({"ok": True})


# ---------- modelo falso
chamadas = []
roteiro = []


def fala(texto):
    return {"role": "assistant", "content": texto}


def ferramenta(nome, args):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{time.time_ns()}", "type": "function", "function": {"name": nome, "arguments": json.dumps(args)}}]}


class Modelo(Base):
    def do_POST(self):
        b = self.corpo()
        if not self.path.endswith("/chat/completions"):
            return self.responder({}, 404)
        msgs = b.get("messages", [])
        with trava:
            chamadas.append({"tools": sorted(t.get("function", {}).get("name", "") for t in b.get("tools") or []), "msgs": msgs})
            m = dict(roteiro.pop(0)) if (roteiro and b.get("tools")) else {"role": "assistant", "content": "Pronto."}

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

# a configuração que as migrações do cofre deixam (a 9: aprovações pela pessoa, 5 min), com o Terminal ligado para a equipe
CONFIG = f"""model:
  provider: custom
  default: modelo-falso
  base_url: http://127.0.0.1:{PORTA_MODELO}/v1
  api_key: chave-falsa
plugins:
  enabled: [ergon_bridge]
platform_toolsets:
  api_server: [todo, web, terminal, skills, ergon_conexoes, ergon_cartoes]
  teams: [todo]
known_plugin_toolsets:
  api_server: [ergon_conexoes, ergon_cartoes]
tools:
  tool_search:
    enabled: "off"
agent:
  max_turns: 20
skills:
  write_approval: true
gateway:
  multiplex_profiles: true
approvals:
  mode: manual
  timeout: {{prazo}}
"""
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write(CONFIG.replace("{prazo}", "300"))
with open(os.path.join(HOME, ".env"), "w", encoding="utf-8") as f:
    f.write(f"API_SERVER_KEY={CHAVE}\n")

env = {**os.environ, "HERMES_HOME": HOME, "HOME": HOME, "API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1", "API_SERVER_PORT": str(API), "API_SERVER_KEY": CHAVE,
       "ERGON_CONTROL_PORT": str(PONTE), "ERGON_BRIDGE_URL": f"http://127.0.0.1:{PORTA_ERGON}/internal/bridge/v1/events", "ERGON_BRIDGE_TOKEN": TOKEN,
       "HERMES_GATEWAY_NO_SUPERVISE": "1", "ERGON_DISPAROS_PASSO_S": "1"}
log = open("/tmp/gateway-teste-rotinas.log", "w")
if os.geteuid() == 0:  # a CI roda os testes como root; o motor de verdade roda como usuário comum
    env["HERMES_ALLOW_ROOT_GATEWAY"] = "1"
gw = subprocess.Popen(["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"], env=env, stdout=log, stderr=subprocess.STDOUT, cwd=HOME)
A = {"Authorization": f"Bearer {CHAVE}"}


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


def iniciar(perfil, texto, script, sessao):
    with trava:
        chamadas.clear()
        roteiro[:] = script
    h = {**A, "Idempotency-Key": f"{sessao}-{time.time_ns()}", "X-Hermes-Session-Key": sessao}
    st, j = http("POST", f"http://127.0.0.1:{API}/p/{perfil}/v1/runs", {"input": texto, "instructions": "INSTRUCAO"}, h)
    return j.get("run_id") if st == 202 and isinstance(j, dict) else None


def fim_de(perfil, run_id, espera=90):
    limite = time.time() + espera
    while time.time() < limite:
        st, r = http("GET", f"http://127.0.0.1:{API}/p/{perfil}/v1/runs/{run_id}", None, A)
        if isinstance(r, dict) and r.get("status") in ("completed", "failed", "cancelled", "interrupted"):
            return r.get("status"), r.get("output")
        time.sleep(0.3)
    return "sem fim", None


def evento(perfil, run_id, nome, espera=60):
    """Lê o fluxo de eventos da execução (como o servidor do Ergon) até o primeiro `nome`; None se a execução acabar antes."""
    c = httpc.HTTPConnection("127.0.0.1", API, timeout=espera)
    try:
        c.request("GET", f"/p/{perfil}/v1/runs/{run_id}/events", headers={**A, "Accept": "text/event-stream"})
        r = c.getresponse()
        limite = time.time() + espera
        while time.time() < limite:
            linha = r.fp.readline()
            if not linha:
                return None
            if not linha.startswith(b"data:"):
                continue
            try:
                e = json.loads(linha[5:].strip())
            except Exception:  # noqa: BLE001
                continue
            if e.get("event") == nome:
                return e
            if e.get("event") in ("run.completed", "run.failed", "run.cancelled"):
                return None
    except Exception:  # noqa: BLE001
        return None
    finally:
        c.close()
    return None


def resultado_da_ferramenta():
    """O que a última ferramenta devolveu ao modelo (a mensagem 'tool' da chamada seguinte)."""
    for c in reversed(chamadas):
        if c["msgs"] and c["msgs"][-1].get("role") == "tool":
            return str(c["msgs"][-1].get("content"))
    return ""


def jobs_da_api(perfil=""):
    st, j = http("GET", f"http://127.0.0.1:{API}{'/p/' + perfil if perfil else ''}/api/jobs?include_disabled=true", None, A)
    return j.get("jobs", []) if isinstance(j, dict) else []


try:
    de_pe = False
    for _ in range(120):
        if gw.poll() is not None:
            break
        if http("GET", f"http://127.0.0.1:{API}/health", timeout=2)[0] == 200 and ponte("GET", "/ergon/v1/health")[0] == 200:
            de_pe = True
            break
        time.sleep(1)
    check("o gateway do Hermes subiu com a API e a ponte de controle", de_pe, open("/tmp/gateway-teste-rotinas.log").read()[-1500:])
    if not de_pe:
        raise SystemExit(1)
    st, saude = ponte("GET", "/ergon/v1/health")
    check("a ponte diz que sabe rotinas e aprovações nativas", {"rotinas", "aprovacoes", "perfis"} <= set(saude.get("capacidades") or []), str(saude))

    HIP, EUC = "erg-" + "a" * 20, "erg-" + "b" * 20
    pedido = {"alma": "Você é Hipátia, no Ergon.", "ferramentas": ["todo", "web", "terminal", "ergon_conexoes"], "memoria": True, "busca": True,
              "ajudantes": {"ligado": False, "max": 1}, "competencias": []}
    for p in (HIP, EUC):
        st, r = ponte("PUT", f"/ergon/v1/perfis/{p}", pedido)
        check(f"o perfil {p[-4:]} existe no motor", st == 200, str((st, r)))

    # ---------------------------------------------------------------- 1. rotinas no agendador do perfil
    RID = "rtn_" + "c" * 32
    fuso = "America/Sao_Paulo"
    daqui = datetime.now(ZoneInfo(fuso)) + timedelta(hours=3)
    hora = f"{daqui.hour:02d}:{daqui.minute:02d}"
    st, j = ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": HIP, "nome": "Briefing da manhã", "dias": [0, 1, 2, 3, 4, 5, 6], "hora": hora, "fuso": fuso, "ligada": True})
    check("a ponte cria o job da rotina", st == 200 and j.get("criado") is True and len(j.get("job_id") or "") == 12, str((st, j)))
    JOB = j.get("job_id")
    prox = datetime.fromisoformat(j["proxima"]).astimezone(ZoneInfo(fuso)) if j.get("proxima") else None
    check("a próxima execução é a hora da pessoa, no fuso dela (convertida para o fuso do motor)", prox is not None and f"{prox.hour:02d}:{prox.minute:02d}" == hora
          and abs((prox - daqui).total_seconds()) < 120, str((j.get("proxima"), hora)))
    no_perfil = [x for x in jobs_da_api(HIP) if x.get("id") == JOB]
    check("o job está no agendador do perfil do agente (pela API do motor)", len(no_perfil) == 1 and no_perfil[0].get("no_agent") is True
          and no_perfil[0].get("script") == f"ergon_rotina_{RID}.py", str(no_perfil)[:400])
    check("o perfil padrão não tem o job (ele herdaria a identidade e as ferramentas erradas)", not any(x.get("id") == JOB for x in jobs_da_api("")))
    script = os.path.join(HOME, "profiles", HIP, "scripts", f"ergon_rotina_{RID}.py")
    texto_script = open(script, encoding="utf-8").read() if os.path.isfile(script) else ""
    check("o script do job fica na pasta do perfil e não leva rede nem segredo", "urllib" not in texto_script and "http" not in texto_script and TOKEN not in texto_script and RID in texto_script, texto_script[:300])
    st, j2 = ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": HIP, "nome": "Briefing da manhã", "dias": [0, 1, 2, 3, 4, 5, 6], "hora": hora, "fuso": fuso, "ligada": True})
    check("de novo: o mesmo job, nada novo (idempotente)", st == 200 and j2.get("job_id") == JOB and j2.get("criado") is False and len(jobs_da_api(HIP)) == 1, str(j2))
    st, j3 = ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": HIP, "nome": "Briefing da manhã", "dias": [1, 2, 3, 4, 5], "hora": hora, "fuso": fuso, "ligada": False})
    pausado = [x for x in jobs_da_api(HIP) if x.get("id") == JOB]
    check("pausar no Ergon pausa no agendador (e a agenda muda para cinco dias)", st == 200 and j3.get("pausada") is True and bool(pausado) and pausado[0].get("state") == "paused"
          and (j3.get("agenda") or "x").split()[-1].count(",") == 4, str(j3))
    st, j4 = ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": HIP, "nome": "Briefing da manhã", "dias": [0, 1, 2, 3, 4, 5, 6], "hora": hora, "fuso": fuso, "ligada": True})
    check("retomar no Ergon retoma no agendador", st == 200 and j4.get("pausada") is False and j4.get("proxima"), str(j4))

    # rodar agora: o agendador dispara no próximo tique; o script avisa e o plugin entrega ao Ergon, sem chamar o modelo
    with trava:
        chamadas.clear()
    desde = time.time()
    st, r = ponte("POST", f"/ergon/v1/rotinas/{RID}/rodar", {"perfil": HIP})
    check("rodar agora pelo agendador: aceito", st == 200 and r.get("job_id") == JOB, str((st, r)))
    aviso = None
    for _ in range(150):
        with trava:
            aviso = next((p for p in pedidos if p["path"].endswith("/rotina/disparo") and p["em"] >= desde), None)
        if aviso:
            break
        time.sleep(1)
    check("o aviso do horário chega ao Ergon pelo plugin (rotina, perfil e hora)", aviso is not None and aviso["body"].get("rotina") == RID and aviso["body"].get("perfil") == HIP
          and abs(float(aviso["body"].get("em") or 0) - time.time()) < 200, str(aviso))
    check("o job não chamou o modelo (sem agente: o trabalho é pedido pelo Ergon em /v1/runs)", not chamadas, str(len(chamadas)))
    time.sleep(2)
    st, lst = ponte("GET", f"/ergon/v1/rotinas?perfil={HIP}")
    meu = next((x for x in (lst.get("rotinas") or []) if x.get("rotina") == RID), {})
    check("o agendador registrou a rodada (sem falha) e a próxima execução", meu.get("ultima") and meu.get("ultimo_estado") in ("ok", "silent", None) and meu.get("proxima"), str(meu))
    check("o aviso entregue sai da pasta (não chega duas vezes)", not [f for f in os.listdir(os.path.join(HOME, "ergon_bridge", "disparos")) if f.endswith(".json")])

    # o agente mudou: o job vai para o perfil novo e sai do antigo
    st, j5 = ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": EUC, "antes": HIP, "nome": "Briefing da manhã", "dias": [0, 1, 2, 3, 4, 5, 6], "hora": hora, "fuso": fuso, "ligada": True})
    check("o agente mudou: o job vai para o perfil novo e sai do antigo", st == 200 and j5.get("criado") is True and not jobs_da_api(HIP) and len(jobs_da_api(EUC)) == 1
          and not os.path.exists(script), str((j5, jobs_da_api(HIP))))
    st, r = ponte("DELETE", f"/ergon/v1/rotinas/{RID}?perfil={EUC}")
    check("tirar a rotina tira o job e o script", st == 200 and r.get("removida") is True and not jobs_da_api(EUC)
          and not os.path.exists(os.path.join(HOME, "profiles", EUC, "scripts", f"ergon_rotina_{RID}.py")), str(r))
    check("rotina com id inválido: recusada", ponte("PUT", "/ergon/v1/rotinas/rtn_x", {"perfil": HIP})[0] in (400, 404))
    check("perfil inválido: recusado", ponte("PUT", f"/ergon/v1/rotinas/{RID}", {"perfil": "default", "dias": [1], "hora": "08:00", "fuso": fuso})[0] == 400)

    # ---------------------------------------------------------------- 2. aprovações nativas
    # 2a. comando perigoso do Terminal: approval.request no fluxo; "once" roda, "deny" não
    alvo = "/tmp/prova-apagar-rotinas"
    os.makedirs(alvo, exist_ok=True)
    rid = iniciar(HIP, "apague a pasta", [ferramenta("terminal", {"command": f"rm -rf {alvo}"}), fala("Feito.")], "sess-aprov-1")
    ev = evento(HIP, rid, "approval.request") if rid else None
    check("o motor para o turno e pede aprovação no fluxo de eventos (approval.request)", ev is not None and alvo in str(ev.get("command")) and ev.get("request_id")
          and "once" in (ev.get("choices") or []), str(ev)[:400])
    st, r = http("POST", f"http://127.0.0.1:{API}/p/{HIP}/v1/runs/{rid}/approval", {"choice": "once", "request_id": (ev or {}).get("request_id")}, A)
    check("o Ergon responde pela API (once)", st == 200 and int(r.get("resolved") or 0) >= 1, str((st, r)))
    est, _s = fim_de(HIP, rid)
    check("aprovado: o comando rodou e a execução terminou", est == "completed" and not os.path.exists(alvo), str(est))
    os.makedirs(alvo, exist_ok=True)
    rid = iniciar(HIP, "apague a pasta", [ferramenta("terminal", {"command": f"rm -rf {alvo}"}), fala("Não apaguei.")], "sess-aprov-2")
    ev = evento(HIP, rid, "approval.request") if rid else None
    st, r = http("POST", f"http://127.0.0.1:{API}/p/{HIP}/v1/runs/{rid}/approval", {"choice": "deny", "request_id": (ev or {}).get("request_id")}, A)
    est, _s = fim_de(HIP, rid)
    check("recusado: o comando não rodou e o agente soube", st == 200 and est == "completed" and os.path.exists(alvo) and "BLOCKED" in resultado_da_ferramenta(), resultado_da_ferramenta()[:300])

    # 2b. uma ação numa conta que espera a confirmação: o turno fica no portão do motor; a pessoa decide e o resultado é o do Ergon
    rid = iniciar(HIP, "mande o e-mail", [ferramenta("conexoes_executar", {"conexao": "microsoft", "acao": "email.enviar", "parametros": {"para": "x"}}), fala("Mandei.")], "sess-aprov-3")
    ev = evento(HIP, rid, "approval.request") if rid else None
    check("a confirmação de conta segura o turno no portão do motor, com o cartão do Ergon", ev is not None and ev.get("pattern_key") == f"plugin_rule:ergon_{CARTAO_CONTA}", str(ev)[:400])
    decididos[CARTAO_CONTA] = "feita"   # a pessoa confirmou no Ergon (que executou o que o cartão mostrou)
    st, r = http("POST", f"http://127.0.0.1:{API}/p/{HIP}/v1/runs/{rid}/approval", {"choice": "once", "request_id": (ev or {}).get("request_id")}, A)
    est, _s = fim_de(HIP, rid)
    res = resultado_da_ferramenta()
    check("decidido: a ferramenta devolve ao modelo o resultado que está no Ergon, no mesmo turno", st == 200 and est == "completed" and "MARCA-RESULTADO-DO-ERGON" in res, res[:300])
    check("o modelo não vê o cartão nem o resumo (campos só do plugin)", '"cartao"' not in res and '"resumo"' not in res, res[:300])
    with trava:
        op_cartao = [p for p in pedidos if p["path"].endswith("/conexoes") and p["body"].get("op") == "cartao"]
    check("depois do portão, o plugin pergunta ao Ergon (a decisão que vale é a de lá)", op_cartao and op_cartao[-1]["body"].get("cartao") == CARTAO_CONTA, str(op_cartao[-1:]))

    # 2c. aprovação depois de ler as contas: o turno fica no portão; aprovada, a ferramenta segue
    policy["bloqueadas"] = ["web_extract"]
    rid = iniciar(HIP, "leia o site", [ferramenta("web_extract", {"urls": ["https://site.exemplo/pagina"]}), fala("Li.")], "sess-aprov-4")
    ev = evento(HIP, rid, "approval.request") if rid else None
    check("depois de ler as contas: abrir um site segura o turno no portão do motor", ev is not None and ev.get("pattern_key") == f"plugin_rule:ergon_{CARTAO_LER}", str(ev)[:400])
    decididos[CARTAO_LER] = "feita"
    st, r = http("POST", f"http://127.0.0.1:{API}/p/{HIP}/v1/runs/{rid}/approval", {"choice": "once", "request_id": (ev or {}).get("request_id")}, A)
    est, _s = fim_de(HIP, rid)
    res = resultado_da_ferramenta()
    with trava:
        ler = [p for p in pedidos if p["path"].endswith("/depois-de-ler")]
    check("aprovada: a ferramenta seguiu (não voltou barrada) e o Ergon foi consultado de novo", est == "completed" and "MARCA-ESPERA-LER" not in res and len(ler) >= 2, f"{res[:200]} · {len(ler)}")
    policy["bloqueadas"] = []

    # 2d. sem resposta no prazo do motor: a ferramenta devolve que o cartão continua com a pessoa (nada se perde)
    with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
        f.write(CONFIG.replace("{prazo}", "4"))
    ponte("PUT", f"/ergon/v1/perfis/{EUC}", {**pedido, "alma": "Você é Euclides, no Ergon."})
    rid = iniciar(EUC, "mande o e-mail PRAZO", [ferramenta("conexoes_executar", {"conexao": "microsoft", "acao": "email.enviar", "parametros": {"para": "PRAZO"}}), fala("Fica com você.")], "sess-aprov-5")
    ev = evento(EUC, rid, "approval.request") if rid else None
    est, _s = fim_de(EUC, rid, 60)
    res = resultado_da_ferramenta()
    check("sem resposta no prazo do motor: o cartão continua com a pessoa e o turno termina", ev is not None and est == "completed" and "MARCA-CONTINUA-COM-ELA" in res, f"{ev} · {res[:200]}")
    st, r = http("POST", f"http://127.0.0.1:{API}/p/{EUC}/v1/runs/{rid}/approval", {"choice": "once", "request_id": (ev or {}).get("request_id")}, A)
    check("depois do prazo, o motor não espera mais (resolved 0 ou recusado): o Ergon segue pela continuação", st != 200 or int((r or {}).get("resolved") or 0) == 0, str((st, r)))
finally:
    gw.terminate()
    try:
        gw.wait(20)
    except subprocess.TimeoutExpired:
        gw.kill()

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

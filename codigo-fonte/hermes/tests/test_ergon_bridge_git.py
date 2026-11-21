"""Acesso de código (rc.42): a senha de uso curto que o Ergon dá a codigo.preparar vai só ao git, nunca ao modelo.

Plugin do Ergon + Hermes de verdade (sem rede, HERMES_HOME descartável, Ergon simulado). Confere: o campo git sai da
resposta e o endereço entra no texto; a senha fica no arquivo do helper (0600) e é mascarada; o credential helper
responde só ao repositório concedido e no prazo; encerrar esquece; o pedido diz ao Ergon que este plugin sabe o git.

  docker run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_git.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"), dirs_exist_ok=True)
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("plugins:\n  enabled: [ergon_bridge]\nplatform_toolsets:\n  api_server: [ergon_conexoes]\ntools:\n  tool_search:\n    enabled: \"off\"\n")
os.environ["HERMES_PLATFORM"] = "api_server"
os.environ["ERGON_BRIDGE_TOKEN"] = "token-da-ponte-de-teste-0123456789"
sys.path.insert(0, "/opt/hermes")
ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


SENHA = "ergit_" + "a" * 64
RESPOSTA = {"q1": "Não permitir"}
seen = []


class Ergon(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.endswith("/tool-policy"):
            out = {"known": True, "agent": "Aspásia", "toolsets": ["ergon_conexoes"], "holders": {}, "guarded": {}, "skills": [], "bloqueadas": []}
        else:
            seen.append(body)
        if self.path.endswith("/tool-policy"):
            pass
        elif self.path.endswith("/cartao"):
            out = {"estado": "respondida", "respostas": {"q1": RESPOSTA["q1"]}}
        elif body.get("acao") == "codigo.preparar":
            out = {"ok": True, "status": "feita", "texto": "Acesso pronto.\nEndereço para o git: {{git_url}} (sem senha)",
                   "git": {"caminho": "/internal/git/v1/github/acme/app.git", "usuario": "ergon", "senha": SENHA, "expira": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 600))}}
        elif body.get("acao") == "codigo.encerrar":
            out = {"ok": True, "status": "feita", "texto": "Acesso encerrado.", "gitFim": True}
        else:
            out = {"ok": True, "status": "feita", "texto": "ok"}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Ergon)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
os.environ["ERGON_BRIDGE_URL"] = f"{BASE}/internal/bridge/v1/events"

from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
import model_tools  # noqa: E402

bridge = next(m for m in list(sys.modules.values()) if hasattr(m, "_git_da_resposta"))
check("o plugin diz que sabe o git", "git" in bridge.CAPACIDADES)
raw = model_tools.handle_function_call("conexoes_executar", {"conexao": "github", "acao": "codigo.preparar", "parametros": {"repositorio": "acme/app"}}, task_id="t1", session_id="s1")
r = json.loads(raw)
check("o pedido diz ao Ergon que este plugin sabe o git", seen and seen[-1].get("git") is True, str(seen[-1:]))
check("o modelo não recebe a senha nem o campo git", SENHA not in raw and "git" not in r, raw)
check("o endereço completo entra no texto", f"{BASE}/internal/git/v1/github/acme/app.git" in r.get("texto", ""), r.get("texto", ""))
arq = os.path.join(HOME, "ergon_bridge", "git", "credenciais.json")
check("a senha fica só no arquivo do helper, 0600", os.path.exists(arq) and stat.S_IMODE(os.stat(arq).st_mode) == 0o600 and SENHA in open(arq).read())
check("a saída de ferramentas mascara a senha", SENHA not in (bridge.on_transform_tool_result(result=f"cat: {SENHA}", tool_name="terminal") or ""))
helper = os.path.join(HOME, "plugins", "ergon_bridge", "git_credencial.py")
pasta = os.path.join(HOME, "ergon_bridge", "git")
porta = srv.server_address[1]


def pede(caminho):
    p = subprocess.run([sys.executable, helper, pasta, "get"], input=f"protocol=http\nhost=127.0.0.1:{porta}\npath={caminho}\n", capture_output=True, text=True, timeout=10)
    return p.stdout


check("o helper responde ao repositório concedido", f"password={SENHA}" in pede("internal/git/v1/github/acme/app.git"))
check("e a nada mais (outro repositório)", pede("internal/git/v1/github/acme/outro.git") == "")
check("nem a um prefixo parecido", pede("internal/git/v1/github/acme/app.git-falso") == "")
cfg = subprocess.run(["git", "config", "--show-origin", "--get-regexp", "credential\\..*"], capture_output=True, text=True).stdout
check("o git acha o helper só para o endereço do Ergon", f"credential.{BASE}/internal/git/.helper" in cfg and "useHttpPath" in cfg.replace("usehttppath", "useHttpPath"), cfg)
check("nada de senha na configuração do git", SENHA not in cfg)
model_tools.handle_function_call("conexoes_executar", {"conexao": "github", "acao": "codigo.encerrar", "parametros": {}}, task_id="t1", session_id="s1")
check("encerrar esquece a senha", SENHA not in open(arq).read() and pede("internal/git/v1/github/acme/app.git") == "")
# ---------- protegidas no Terminal: o que apaga de vez pede a pessoa toda vez (mesmo com o acesso total)
check("rm -rf, push --force, reset --hard, rmtree contam como apagar de vez", all(bridge.apaga_de_vez(c) for c in ("rm -rf /pastas/app", "git push --force origin x", "git reset --hard HEAD~1", "python -c 'import shutil; shutil.rmtree(\"x\")'")))
check("o dia a dia não pergunta", not any(bridge.apaga_de_vez(c) for c in ("git commit -am x", "git push -u origin ergon/x", "pytest -q", "rm arquivo.txt", "ls -la /pastas")))
cartoes = lambda: [b for b in seen if "perguntas" in b]
r = bridge._protegida_no_terminal("terminal", {"command": "rm -rf /pastas/app/build"}, "t1", "s1")
check("a pessoa não permitiu: barrado", isinstance(r, dict) and r.get("action") == "block" and len(cartoes()) == 1, str(r))
check("o cartão mostra o comando", "rm -rf /pastas/app/build" in cartoes()[-1]["perguntas"][0]["pergunta"])
RESPOSTA["q1"] = "Permitir desta vez"
check("permitiu: passa (só esta vez)", bridge._protegida_no_terminal("terminal", {"command": "rm -rf /pastas/app/build"}, "t1", "s1") is None and len(cartoes()) == 2)
check("comando comum: nem pergunta", bridge._protegida_no_terminal("terminal", {"command": "git status"}, "t1", "s1") is None and len(cartoes()) == 2)
print("TUDO OK" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

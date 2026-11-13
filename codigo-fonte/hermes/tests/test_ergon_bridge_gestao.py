"""Gestão pelo coordenador (rc.29): o plugin do Ergon com o Hermes de verdade, dentro da imagem do motor, sem rede e com um
Ergon de mentira.

Confere: o Hermes carrega o plugin com gestao_listar e gestao_executar no conjunto ergon_gestao (declarados = registrados);
as duas ferramentas só repassam ao Ergon (/internal/bridge/v1/gestao), com a sessão do pedido; a mudança que espera o
cartão segura o turno no portão de aprovação do motor e, decidida, a ferramenta devolve o resultado do Ergon (nunca o que
o modelo disser); o Ergon fora do ar vira "não sei se foi feito"; a trava barra a gestão de quem não é o coordenador (o
Ergon só manda o conjunto na política dele) e deixa passar o coordenador; o perfil do coordenador recebe o conjunto e o
dos colegas não (conhecido e fora da lista = desligado); e a capacidade "gestao" é anunciada ao Ergon.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_gestao.py
"""
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME
PONTE = "ponte-" + "de-teste-" + "0123456789abcdef"
os.environ["ERGON_BRIDGE_TOKEN"] = PONTE
os.environ["ERGON_CONTROL_PORT"] = "0"

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


# ---------------------------------------------------------------- o Ergon de mentira
pedidos = []
politica = {"known": True, "agent": "Aristóteles", "toolsets": ["todo", "ergon_gestao"], "holders": {}, "guarded": {}, "skills": [], "training": None}
cartao_estado = {"status": "aguardando_confirmacao"}
CARTAO = "apr_" + "0123456789abcdef" * 2


class Ergon(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.headers.get("X-Ergon-Bridge-Token") != PONTE:
            self.send_response(401); self.end_headers(); return
        out = {}
        if self.path == "/internal/bridge/v1/tool-policy":
            out = politica
        elif self.path == "/internal/bridge/v1/gestao":
            pedidos.append(body)
            if body.get("op") == "listar":
                out = {"ok": True, "status": "feita", "texto": "- equipe: equipe.ver, agente.criar"}
            elif body.get("op") == "cartao":
                out = ({"ok": True, "status": "feita", "texto": "A pessoa aplicou e foi feito."} if cartao_estado["status"] == "feita"
                       else {"ok": True, "status": "aguardando_confirmacao", "texto": "A pessoa ainda não decidiu."})
            elif body.get("acao") == "agente.criar":
                out = {"ok": True, "status": "aguardando_confirmacao", "texto": "A mudança espera a decisão da pessoa.", "cartao": CARTAO, "resumo": "Aristóteles quer: Criar um agente."}
            else:
                out = {"ok": True, "status": "feita", "texto": "[]"}
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)


ergon = ThreadingHTTPServer(("127.0.0.1", 0), Ergon)
threading.Thread(target=ergon.serve_forever, daemon=True).start()
os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{ergon.server_address[1]}/internal/bridge/v1/events"

# ---------------------------------------------------------------- 1. o Hermes carrega o plugin com as ferramentas
sys.path.insert(0, "/opt/hermes")
copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "enable", "ergon_bridge"], capture_output=True, text=True, timeout=180)
check("hermes plugins enable ergon_bridge", r.returncode == 0, (r.stdout + r.stderr)[-600:])
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "validate", copia], capture_output=True, text=True, timeout=180)
check("o Hermes valida o plugin (gestao_listar e gestao_executar declarados = registrados)", r.returncode == 0, (r.stdout + r.stderr)[-1500:])

from hermes_cli.plugins import discover_plugins  # noqa: E402

discover_plugins()
import toolsets as T  # noqa: E402

check("o conjunto ergon_gestao traz as duas ferramentas", set(T.resolve_toolset("ergon_gestao")) >= {"gestao_listar", "gestao_executar"}, str(T.resolve_toolset("ergon_gestao")))
b = next((m for n, m in sys.modules.items() if n.endswith("ergon_bridge") and hasattr(m, "tool_gestao_executar")), None)
check("o módulo do plugin carregado", b is not None)
check("capacidade 'gestao' anunciada ao Ergon", "gestao" in b.CAPACIDADES, str(b.CAPACIDADES))
check("ergon_gestao entre os conjuntos do plugin (conhecido nas plataformas)", "ergon_gestao" in b._ERGON_PLUGIN_TOOLSETS)
check("ergon_gestao fora do que o Ergon pode ligar para a equipe toda", "ergon_gestao" not in b._SAFE_TOOLSETS)

# ---------------------------------------------------------------- 2. as ferramentas só repassam
saida = json.loads(b.tool_gestao_listar({"area": "equipe"}, task_id="", session_id="sessao-1"))
check("listar: repassa a área e a sessão", pedidos[-1] == {"op": "listar", "area": "equipe", "session_id": "sessao-1", "task_id": ""}, str(pedidos[-1:]))
check("listar: devolve o texto do Ergon", saida.get("texto", "").startswith("- equipe"), str(saida))
saida = json.loads(b.tool_gestao_executar({"acao": "equipe.ver", "parametros": {"x": 1}}, task_id="", session_id="sessao-1"))
check("executar: repassa ação e parâmetros", pedidos[-1].get("acao") == "equipe.ver" and pedidos[-1].get("parametros") == {"x": 1}, str(pedidos[-1:]))
saida = json.loads(b.tool_gestao_executar({"acao": "equipe.ver", "parametros": "não é objeto"}, session_id="sessao-1"))
check("executar: parâmetros que não são objeto viram vazio", pedidos[-1].get("parametros") == {}, str(pedidos[-1:]))

# ---------------------------------------------------------------- 3. o cartão segura o turno e o resultado vem do Ergon
segurados = []


def portao_falso(tool, texto, rule_key=""):
    segurados.append((tool, texto, rule_key))
    cartao_estado["status"] = "feita"   # a pessoa aplicou enquanto o turno esperava
    return "once"


b._portao_nativo = lambda: portao_falso
saida = json.loads(b.tool_gestao_executar({"acao": "agente.criar", "parametros": {"name": "Temístocles"}}, session_id="sessao-1"))
check("o turno esperou no portão com o resumo e a chave do cartão", segurados and segurados[-1][0] == "gestao_executar" and segurados[-1][2] == f"ergon_{CARTAO}"
      and "Criar um agente" in segurados[-1][1], str(segurados))
check("depois da decisão, a ferramenta busca o resultado do cartão", pedidos[-1].get("op") == "cartao" and pedidos[-1].get("cartao") == CARTAO, str(pedidos[-1:]))
check("o modelo recebe o que o Ergon disse, sem cartão nem resumo", saida.get("status") == "feita" and "cartao" not in saida and "resumo" not in saida, str(saida))
b._portao_nativo = lambda: None
cartao_estado["status"] = "aguardando_confirmacao"
saida = json.loads(b.tool_gestao_executar({"acao": "agente.criar", "parametros": {"name": "Temístocles"}}, session_id="sessao-1"))
check("sem o portão: fica o 'espera a decisão' (nada de inventar resultado)", saida.get("status") == "aguardando_confirmacao" and "cartao" not in saida, str(saida))

# ---------------------------------------------------------------- 4. Ergon fora do ar
os.environ["ERGON_BRIDGE_URL"] = "http://127.0.0.1:9/internal/bridge/v1/events"
saida = json.loads(b.tool_gestao_executar({"acao": "agente.criar"}, session_id="sessao-1"))
check("Ergon fora: 'não sei se foi feito'", saida.get("ok") is False and "Não sei se foi feito" in saida.get("texto", ""), str(saida))
os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{ergon.server_address[1]}/internal/bridge/v1/events"

# ---------------------------------------------------------------- 5. a trava: só o coordenador
b._policy_cache.clear()
check("coordenador (o Ergon manda ergon_gestao na política): passa", b.on_pre_tool_call("gestao_executar", {"acao": "equipe.ver"}, session_id="sessao-c") is None)
politica.update({"agent": "Hipátia", "toolsets": ["todo", "web"]})
b._policy_cache.clear()
barrado = b.on_pre_tool_call("gestao_executar", {"acao": "equipe.ver"}, session_id="sessao-h")
check("colega: barrado, com o recado de pedir ao coordenador", isinstance(barrado, dict) and barrado.get("action") == "block" and "coordenador" in barrado.get("message", ""), str(barrado))
politica.update({"known": False})
b._policy_cache.clear()
barrado = b.on_pre_tool_call("gestao_listar", {}, session_id="sessao-desconhecida")
check("sessão desconhecida (fora de um trabalho do Ergon): barrado", isinstance(barrado, dict) and barrado.get("action") == "block", str(barrado))

# ---------------------------------------------------------------- 6. o perfil: só o do coordenador recebe o conjunto
base = {"platform_toolsets": {"api_server": ["todo", "web", "ergon_cartoes"]}, "known_plugin_toolsets": {"api_server": ["ergon_cartoes"]}}
e_coord = b._limpar_perfil({"alma": "Você é Aristóteles.", "ferramentas": ["web"], "gestao": True})
e_col = b._limpar_perfil({"alma": "Você é Hipátia.", "ferramentas": ["web"]})
check("o pedido do perfil guarda a gestão só quando é True", e_coord["gestao"] is True and e_col["gestao"] is False and b._limpar_perfil({"alma": "x", "gestao": "sim"})["gestao"] is False)
c_coord = b._config_do_perfil(base, e_coord)
c_col = b._config_do_perfil(base, e_col)
check("perfil do coordenador: ergon_gestao na lista da API, da linha de comando e do agendador",
      all("ergon_gestao" in c_coord["platform_toolsets"][p] for p in ("api_server", "cli", "cron")), str(c_coord["platform_toolsets"]))
check("perfil de um colega: sem ergon_gestao", all("ergon_gestao" not in c_col["platform_toolsets"][p] for p in ("api_server", "cli", "cron")), str(c_col["platform_toolsets"]))
check("nos dois, ergon_gestao conhecido (fora da lista = desligado)", all("ergon_gestao" in c["known_plugin_toolsets"]["api_server"] for c in (c_coord, c_col)))

ergon.shutdown()
print("TUDO OK" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

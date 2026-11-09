"""Custo (rc.25): a marca do pedido (turno) nas medições do plugin, sem o motor (só a biblioteca padrão do Python).

Confere:
  - toda chamada de um pedido leva a mesma marca (um resumo do turn_id do Hermes, nunca o id), e o número da chamada;
  - o motor resumiu a conversa no meio do pedido e trocou de sessão: a sessão nova recebe as chamadas que o pedido já
    tinha feito, e as seguintes vão para as duas (o Ergon lê a execução inteira por qualquer uma);
  - pedidos diferentes da mesma sessão têm marcas diferentes (o Ergon separa as execuções sem depender do relógio);
  - rc.26: o tamanho do resumo da conversa (quando o motor a compactou) em cada chamada, sem o texto dele.

  python3 -I hermes/tests/test_ergon_bridge_medicao_turno.py
  (ERGON_PLUGINS = pasta hermes/plugins; HERMES_HOME = pasta descartável, apagada no começo)
"""
import importlib.util
import os
import shutil
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
PLUGINS = os.environ.get("ERGON_PLUGINS") or ("/p" if os.path.isdir("/p") else os.path.join(AQUI, "..", "plugins"))
HOME = os.environ.get("HERMES_HOME") or os.path.join(tempfile.gettempdir(), "ergon-teste-medicao-turno")
if os.path.exists(os.path.join(HOME, ".ergon-vault")):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME

spec = importlib.util.spec_from_file_location("ergon_bridge_teste", os.path.join(PLUGINS, "ergon_bridge", "__init__.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


def chamada(sessao, req, turno, n, conversa="oi"):
    bridge.on_pre_api_request(session_id=sessao, api_request_id=req, system_prompt="sistema", request_messages=[{"role": "user", "content": conversa}],
                              tool_count=0, api_call_count=n, turn_id=turno)
    bridge.on_post_api_request(session_id=sessao, api_request_id=req, usage={"prompt_tokens": 100 * n})


TURNO_A = "ws_x:agt_y:conv_z:ergon-ws_x:abc:1a2b3c4d"
chamada("s1", "r1", TURNO_A, 1)
chamada("s1", "r2", TURNO_A, 2)
m = bridge.medicao("s1")
check("as chamadas do pedido levam a mesma marca", len(m) == 2 and m[0]["turno"] == m[1]["turno"] != "", str(m))
check("a marca é um resumo, não o id (que traz a conversa e o workspace)", len(m[0]["turno"]) == 16 and "ws_x" not in m[0]["turno"], m[0]["turno"])
check("e o número da chamada no pedido", [x["n"] for x in m] == [1, 2])

# o motor resumiu a conversa no meio do pedido: sessão nova (s2) para as chamadas seguintes do mesmo pedido
chamada("s2", "r3", TURNO_A, 3)
m2 = bridge.medicao("s2")
check("a sessão nova recebe as chamadas que o pedido já tinha feito, e a nova", [x["n"] for x in m2] == [1, 2, 3], str([x["n"] for x in m2]))
check("a sessão de antes também fica com o pedido inteiro", [x["n"] for x in bridge.medicao("s1")] == [1, 2, 3], str([x["n"] for x in bridge.medicao("s1")]))
chamada("s2", "r4", TURNO_A, 4)
check("as seguintes vão para as duas, sem repetir", [x["n"] for x in bridge.medicao("s2")] == [1, 2, 3, 4] and [x["n"] for x in bridge.medicao("s1")] == [1, 2, 3, 4])

# o pedido seguinte da mesma conversa: outra marca, só na sessão em que está
chamada("s2", "r5", "ws_x:agt_y:conv_z:ergon-ws_x:abc:99999999", 1)
m3 = bridge.medicao("s2")
check("outro pedido, outra marca", m3[-1]["turno"] != m3[0]["turno"] and m3[-1]["n"] == 1)
check("e não vai para a sessão de antes", len(bridge.medicao("s1")) == 4)

# sem turn_id (outra entrada do motor): grava sem marca, só na sessão dela
chamada("s3", "r6", "", 1)
check("sem marca: só na sessão dela", bridge.medicao("s3")[0]["turno"] == "" and len(bridge.medicao("s3")) == 1)

# rc.26: a conversa resumida (compactação). Só o tamanho do resumo, nunca o texto; sem resumo, 0
# o prefixo antigo do Hermes (LEGACY_SUMMARY_PREFIX), que ele ainda reconhece: vale com e sem o código do motor por perto
RESUMO = "[CONTEXT SUMMARY]: ## Resumo: a pessoa quer o relatório de vendas"


def chamada_msgs(sessao, req, msgs):
    bridge.on_pre_api_request(session_id=sessao, api_request_id=req, system_prompt="sistema", request_messages=msgs, tool_count=0, api_call_count=1, turn_id="t-resumo")
    bridge.on_post_api_request(session_id=sessao, api_request_id=req, usage={"prompt_tokens": 100})


chamada_msgs("s4", "r7", [{"role": "user", "content": "oi"}, {"role": "assistant", "content": "olá"}])
chamada_msgs("s4", "r8", [{"role": "user", "content": RESUMO}, {"role": "user", "content": "e agora?"}])
chamada_msgs("s4", "r9", [{"role": "assistant", "content": [{"type": "text", "text": RESUMO}]}, {"role": "user", "content": "segue"}])
chamada_msgs("s4", "r10", [{"role": "user", "content": "x", "_compressed_summary": True}])
m4 = bridge.medicao("s4")
check("conversa sem resumo: 0", m4[0]["resumo"] == 0, str(m4[0]))
check("conversa resumida: o tamanho do resumo", m4[1]["resumo"] == len(RESUMO), str(m4[1]))
check("resumo em partes (blocos de texto): também conta", m4[2]["resumo"] == len(RESUMO), str(m4[2]))
check("resumo marcado pelo motor: também conta", m4[3]["resumo"] == 1, str(m4[3]))
check("nada do texto do resumo vai para o registro", "relatório" not in open(bridge._medicao_path("s4"), encoding="utf-8").read())

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO OK" if ok else "HÁ FALHAS")
sys.exit(0 if ok else 1)

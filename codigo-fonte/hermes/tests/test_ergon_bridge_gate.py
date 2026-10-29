"""Trava de ferramentas do plugin do Ergon, dentro da imagem do motor (resolve_toolset real do Hermes).

Roda num contêiner descartável, sem rede (ver o CI):
  docker run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_gate.py
"""
import sys

sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/p")
import ergon_bridge as b  # noqa: E402

# política de uma sessão da Hipátia: web + lista de passos; Fídias tem imagens
def fake_policy(session_id, task_id):
    return {"allowed": b._tools_of(["web", "todo"]), "who": "Hipátia", "holders": {"image_gen": ["Fídias"], "web": ["Hipátia"]},
            "guarded": {"code_execution": "calculo"}, "skills": frozenset(), "training": None}

b._policy = fake_policy
ok = True

def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond

r = b.on_pre_tool_call("tool_search", {"query": "todo"}, "t", "s")
check("tool_search liberada (só lê o catálogo)", r is None, str(r))
r = b.on_pre_tool_call("tool_describe", {"name": "todo_list"}, "t", "s")
check("tool_describe liberada", r is None, str(r))
r = b.on_pre_tool_call("todo_list", {}, "t", "s")
check("todo_list (lista de passos) liberada para quem tem 'todo'", r is None, str(r))
r = b.on_pre_tool_call("web_extract", {"urls": ["https://example.com"]}, "t", "s")
check("web_extract liberada para a Hipátia", r is None, str(r))
r = b.on_pre_tool_call("image_generate", {"prompt": "x"}, "t", "s")
check("image_generate barrada para a Hipátia, dizendo que Fídias tem", isinstance(r, dict) and r.get("action") == "block" and "Fídias" in r.get("message", ""), str(r))
r = b.on_pre_tool_call("execute_code", {"code": "1"}, "t", "s")
check("execute_code pede a autorização (senha)", isinstance(r, dict) and "pedir-permissao" in r.get("message", ""), str(r))
r = b.on_pre_tool_call("tool_call", {"name": "?"}, "t", "s")
check("tool_call não desembrulhada continua barrada", isinstance(r, dict) and r.get("action") == "block", str(r))
r = b.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")
check("terminal barrada", isinstance(r, dict) and r.get("action") == "block", str(r))
# imagens geradas: só da pasta das geradas, só imagem, nem por link simbólico
import os  # noqa: E402

gen = os.path.join(os.environ.get("HERMES_HOME", "/tmp/h"), "cache", "generated", "images")
os.makedirs(gen, exist_ok=True)
png = os.path.join(gen, "krea_teste.png")
open(png, "wb").write(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
open(os.path.join(gen, "nota.txt"), "w").write("texto")
open(os.path.join(gen, "vazia.png"), "wb").close()
fora = os.path.join(os.environ.get("HERMES_HOME", "/tmp/h"), "auth.png")
open(fora, "wb").write(b"segredo")
link = os.path.join(gen, "link.png")
if not os.path.lexists(link):
    os.symlink(fora, link)
hit = b._media_file(png)
check("imagem gerada é servida, com o tipo", hit is not None and hit[1] == "image/png", str(hit))
check("fora da pasta das geradas: não", b._media_file(fora) is None)
check("subindo com ..: não", b._media_file(os.path.join(gen, "..", "..", "..", "auth.png")) is None)
check("link simbólico para fora: não", b._media_file(link) is None)
check("outro tipo de arquivo: não", b._media_file(os.path.join(gen, "nota.txt")) is None)
check("imagem vazia: não", b._media_file(os.path.join(gen, "vazia.png")) is None)
check("caminho vazio ou com byte nulo: não", b._media_file("") is None and b._media_file(png + "\x00") is None)

# Chave própria (BYOK): só os três provedores, chave no formato deles, validada antes de gravar; o valor nunca volta
import json  # noqa: E402

chamadas = []
painel = {"valida": {"ok": True, "reachable": True}}
def fake_dash(method, path, query, body):
    chamadas.append((method, path, body))
    if path == "/api/env" and method == "GET":
        return 200, json.dumps({"OPENROUTER_API_KEY": {"is_set": True, "redacted_value": "sk-or-…abcd"}, "OPENAI_API_KEY": {"is_set": True}}).encode()
    if path == "/api/providers/validate":
        return 200, json.dumps(painel["valida"]).encode()
    return 200, b"{}"
b._dash_call = fake_dash
class Resp:
    def __init__(self): self.out = None
    def _json(self, status, obj): self.out = (status, obj)
    def _send(self, status, data): self.out = (status, json.loads(data or b"{}"))
def byok(method, path, body=None):
    r = Resp(); b._ControlHandler._byok(r, method, path, body or {}); return r.out
st = byok("GET", "/ergon/v1/byok")
check("consulta: só os três provedores, sem o valor da chave", st[0] == 200 and st[1]["providers"] == {"openrouter": True, "anthropic": False, "gemini": False} and "sk-or" not in json.dumps(st[1]), str(st))
chamadas.clear()
st = byok("PUT", "/ergon/v1/byok", {"provider": "anthropic", "key": "sk-ant-api03-" + "x" * 40})
check("gravar: confere no provedor e grava só a variável dele", st == (200, {"ok": True, "verified": True})
      and [c[1] for c in chamadas] == ["/api/providers/validate", "/api/env"] and chamadas[1][2]["key"] == "ANTHROPIC_API_KEY", str((st, chamadas)))
painel["valida"] = {"ok": False, "reachable": True}
chamadas.clear()
st = byok("PUT", "/ergon/v1/byok", {"provider": "openrouter", "key": "sk-or-v1-" + "y" * 40})
check("chave recusada pelo provedor: nada é gravado", st[0] == 400 and all(c[1] != "/api/env" for c in chamadas), str((st, chamadas)))
painel["valida"] = {"ok": True, "reachable": True}
check("provedor fora da lista: recusado", byok("PUT", "/ergon/v1/byok", {"provider": "openai", "key": "sk-" + "z" * 40})[0] == 400)
check("chave no formato errado: recusada", byok("PUT", "/ergon/v1/byok", {"provider": "anthropic", "key": "sk-or-v1-" + "y" * 40})[0] == 400)
check("quebra de linha na chave (outra variável): recusada", byok("PUT", "/ergon/v1/byok", {"provider": "gemini", "key": "A" * 40 + "\nOPENAI_API_KEY=x"})[0] == 400)
chamadas.clear()
st = byok("DELETE", "/ergon/v1/byok/gemini")
check("apagar: só a variável do provedor", st[0] == 200 and chamadas == [("DELETE", "/api/env", {"key": "GEMINI_API_KEY"})], str((st, chamadas)))
check("apagar outra variável: não", byok("DELETE", "/ergon/v1/byok/OPENAI_API_KEY")[0] == 404)

print("TUDO OK" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

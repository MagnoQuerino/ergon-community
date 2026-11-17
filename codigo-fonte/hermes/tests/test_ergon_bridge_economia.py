"""rc.35: menos custo por chamada.
- As instruções marcadas do Ergon saem do prompt de sistema e vão para o fim do pedido (cache do DeepSeek/Ergon AI pega o
  começo fixo: base, ferramentas e histórico), só nos fornecedores com esse cache; o resto do pedido não muda.
- O comando do terminal passa pelo RTK (`rtk rewrite`); sem equivalente, sem rtk, em erro ou desligado: roda como veio.

  python3 -I hermes/tests/test_ergon_bridge_economia.py
"""
import importlib.util
import os
import stat
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
PLUGINS = os.environ.get("ERGON_PLUGINS") or ("/p" if os.path.isdir("/p") else os.path.join(AQUI, "..", "plugins"))
spec = importlib.util.spec_from_file_location("ergon_bridge_teste_economia", os.path.join(PLUGINS, "ergon_bridge", "__init__.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
falhas = []


def confere(cond, nome):
    print(("ok  " if cond else "FALHA ") + nome)
    if not cond:
        falhas.append(nome)


INI, FIM = b.ERGON_INSTR_INI, b.ERGON_INSTR_FIM
base = "Você é o Hermes."
msgs = [{"role": "system", "content": f"{base}\n\n{INI}\nCards abertos: 3\n{FIM}"},
        {"role": "user", "content": "oi"}, {"role": "assistant", "content": "olá"}, {"role": "user", "content": "opa"}]
req = {"model": "ergon-ai", "messages": msgs}
r = b.on_llm_request(request=req, base_url="https://api.ergonworld.com/v1/ai")
novas = r["request"]["messages"] if r else []
confere(bool(r) and novas[0]["content"] == base + "\n\n" + b.ECONOMIA, "o prompt de sistema fica com a base e as regras de economia (começo fixo)")
confere(bool(r) and "resumo estruturado" in novas[0]["content"] and "chamadas de ferramenta" in novas[0]["content"], "token-efficiency e research-summarizer embutidos")
confere(bool(r) and novas[1:4] == msgs[1:4], "o histórico vem na mesma ordem, intacto")
confere(bool(r) and novas[-1]["role"] == "system" and "Cards abertos: 3" in novas[-1]["content"] and INI not in novas[-1]["content"], "as instruções vão no fim, sem as marcas")
confere(msgs[0]["content"].startswith(base) and INI in msgs[0]["content"], "o pedido original (o histórico guardado) não é alterado")
confere(b.on_llm_request(request=req, base_url="https://api.anthropic.com") is None, "outros fornecedores: nada muda")
confere(b.on_llm_request(request={"messages": [{"role": "system", "content": base}, {"role": "user", "content": "x"}]}, base_url="https://api.deepseek.com") is None, "sem marcas: nada muda")
partes = [{"role": "system", "content": [{"type": "text", "text": base}, {"type": "text", "text": f"{INI}\nX\n{FIM}"}]}, {"role": "user", "content": "y"}]
rp = b.on_llm_request(request={"messages": partes}, base_url="https://api.deepseek.com")
confere(bool(rp) and rp["request"]["messages"][0]["content"] == [{"type": "text", "text": base}, {"type": "text", "text": b.ECONOMIA}] and rp["request"]["messages"][-1]["content"].endswith("X"), "conteúdo em partes também")

for nome in ("token-efficiency", "research-summarizer"):
    pasta = os.path.join(PLUGINS, "ergon_bridge", "competencias", nome)
    confere(os.path.isfile(os.path.join(pasta, "SKILL.md")) and "MIT" in open(os.path.join(pasta, "LICENSE"), encoding="utf-8").read(), f"{nome}: original e licença MIT no plugin")

# RTK: um rtk falso no PATH
d = tempfile.mkdtemp()
falso = os.path.join(d, "rtk")
with open(falso, "w") as f:
    f.write('#!/bin/sh\n[ "$1" = rewrite ] || exit 9\ncase "$2" in\n  "git status") echo "rtk git status"; exit 3;;\n  "boom") exit 7;;\n  *) exit 1;;\nesac\n')
os.chmod(falso, os.stat(falso).st_mode | stat.S_IEXEC)
os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
b._rtk_bin.clear()
a = {"command": "git status"}
b._rtk_reescrever(a)
confere(a["command"] == "rtk git status", "git status vira rtk git status")
for c in ("echo oi", "boom", "rtk ls"):
    a = {"command": c}
    b._rtk_reescrever(a)
    confere(a["command"] == c, f"sem reescrita: {c}")
os.environ["ERGON_RTK"] = "0"
a = {"command": "git status"}
b._rtk_reescrever(a)
confere(a["command"] == "git status", "ERGON_RTK=0 desliga")
del os.environ["ERGON_RTK"]
b._rtk_bin.clear(); b._rtk_bin.append(None)
a = {"command": "git status"}
b._rtk_reescrever(a)
confere(a["command"] == "git status", "sem rtk instalado: roda como veio")

print("TUDO CERTO" if not falhas else f"HOUVE FALHA: {len(falhas)}")
sys.exit(1 if falhas else 0)

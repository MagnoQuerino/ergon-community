"""Treinar no motor (plugin do Ergon + Hermes de verdade, sem rede, HERMES_HOME descartável).

Confere: a trava de competências (cada agente só as suas; criar/alterar só no treinamento autorizado; no
treinamento, só os links dados), o fluxo nativo (o /learn monta o turno; com skills.write_approval a escrita fica
em espera; o Ergon aplica com o nome e a marca de privada), o isolamento (fora do índice comum, carregável só por
nome), restaurar e remover, e os avisos ao Ergon (escrita em espera, links lidos).

  docker run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_treinar.py
"""
import json
import os
import sys

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
os.makedirs(HOME, exist_ok=True)
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("skills:\n  write_approval: true\n")
os.environ["HERMES_PLATFORM"] = "api_server"
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/p")
import ergon_bridge as b  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


NAME = "ergon-abc123-fidias-diagnostico-gc"
OTHER = "ergon-abc123-hipatia-outra-coisa"
URL = "https://exemplo.com/manual"

# ---------- trava: agente comum (Fídias, com a competência dele)
agent = {"allowed": b._tools_of(["skills", "web", "todo"]), "who": "Fídias", "holders": {}, "guarded": {}, "skills": frozenset({NAME}), "training": None}
training = {"allowed": b._tools_of(["skills", "web"]), "who": "Fídias", "holders": {}, "guarded": {}, "skills": frozenset(), "training": {"skill": NAME, "urls": [URL]}}
cur = {"pol": agent}
b._policy = lambda s, t: cur["pol"]
call = lambda tool, args: b.on_pre_tool_call(tool, args, "t", "s")

check("skill_view da própria competência: liberada", call("skill_view", {"name": NAME}) is None)
check("skill_view com categoria (ergon/nome): liberada", call("skill_view", {"name": f"ergon/{NAME}"}) is None)
r = call("skill_view", {"name": OTHER})
check("skill_view da competência de outro agente: barrada", isinstance(r, dict) and r.get("action") == "block" and "não é de Fídias" in r.get("message", ""), str(r))
r = call("skills_list", {})
check("lista geral de skills: barrada, dizendo as dele", isinstance(r, dict) and NAME in r.get("message", ""), str(r))
r = call("skill_manage", {"action": "create", "name": NAME, "content": "x"})
check("fora do treinamento, criar competência: barrado", isinstance(r, dict) and "treinamento autorizado" in r.get("message", ""), str(r))

# ---------- trava: sessão de treinamento
cur["pol"] = training
check("treino: criar a competência do treinamento", call("skill_manage", {"action": "create", "name": NAME, "content": "x"}) is None)
check("treino: write_file na competência", call("skill_manage", {"action": "write_file", "name": NAME, "file_path": "references/a.md", "file_content": "x"}) is None)
r = call("skill_manage", {"action": "create", "name": OTHER, "content": "x"})
check("treino: outra competência: barrado", isinstance(r, dict) and NAME in r.get("message", ""), str(r))
check("a trava nativa está ligada (config deste teste)", b._approval_on())
# formato em lote — o único que o motor anuncia ao modelo (o teste H com o modelo real usou este)
check("treino: lote só com a competência do treino", call("skill_manage", {"operations": [
    {"action": "create", "name": NAME, "category": "ergon", "content": "x"},
    {"action": "write_file", "name": NAME, "file_path": "references/a.md", "file_content": "y"}]}) is None)
check("treino: lote com o nome no topo", call("skill_manage", {"name": NAME, "operations": [{"action": "patch", "old_string": "a", "new_string": "b"}]}) is None)
r = call("skill_manage", {"operations": [{"action": "create", "name": NAME, "content": "x"}, {"action": "write_file", "name": OTHER, "file_path": "references/a.md", "file_content": "y"}]})
check("treino: lote que toca outra competência: barrado", isinstance(r, dict) and f'name="{NAME}"' in r.get("message", ""), str(r))
r = call("skill_manage", {"operations": [{"action": "delete", "name": NAME}]})
check("treino: lote com delete: barrado", isinstance(r, dict), str(r))
r = call("skill_manage", {"operations": ["create"]})
check("treino: lote malformado: barrado", isinstance(r, dict), str(r))
r = call("skill_manage", {"operations": []})
check("treino: lote vazio: barrado", isinstance(r, dict), str(r))
_on = b._approval_on
b._approval_on = lambda: False
r = call("skill_manage", {"action": "create", "name": NAME, "content": "x"})
check("treino com a trava nativa desligada: escrita barrada (iria direto, sem aprovação)", isinstance(r, dict) and "trava de aprovação" in r.get("message", ""), str(r))
b._approval_on = _on
r = call("skill_manage", {"action": "delete", "name": NAME})
check("treino: apagar: barrado", isinstance(r, dict), str(r))
r = call("skill_manage", {"action": "create", "name": NAME, "operations": [{"action": "create", "name": OTHER}]})
check("treino: lote de operações: barrado", isinstance(r, dict), str(r))
check("treino: ler o link dado", call("web_extract", {"urls": [URL]}) is None)
check("treino: ler o link dado (barra no fim)", call("web_extract", {"urls": [URL + "/"]}) is None)
r = call("web_extract", {"urls": [URL, "https://outro.com/x"]})
check("treino: link que a pessoa não deu: barrado", isinstance(r, dict) and URL in r.get("message", ""), str(r))
r = call("web_search", {"query": "x"})
check("treino: busca na web: barrada", isinstance(r, dict), str(r))
r = call("terminal", {"command": "ls"})
check("treino: terminal: barrado", isinstance(r, dict) and r.get("action") == "block", str(r))
r = call("read_file", {"path": "/etc/passwd"})
check("treino: ler arquivo do computador: barrado", isinstance(r, dict) and r.get("action") == "block", str(r))

# ---------- avisos ao Ergon (pós-ferramenta)
sent = []
b._post_to = lambda url, payload, timeout=4: sent.append((url, payload)) or {}
b.on_post_tool_call("skill_manage", {"name": NAME}, json.dumps({"success": True, "staged": True, "pending_id": "abc12345"}), "t", "s")
b.on_post_tool_call("web_extract", {"urls": [URL]}, json.dumps({"results": [{"url": URL, "title": "M", "content": "Manual do GC " * 20}]}), "t", "s")
b.on_post_tool_call("terminal", {}, "{}", "t", "s")
check("aviso: escrita em espera vai ao Ergon", any(p.get("pending_id") == "abc12345" and p.get("staged") for _, p in sent), str(sent))
check("aviso: link lido vai com os caracteres", any((p.get("reads") or [{}])[0].get("ok") and p["reads"][0]["chars"] > 100 for _, p in sent), str(sent))
check("aviso: outras ferramentas não geram aviso", len(sent) == 2, str(len(sent)))
cur["pol"] = agent
sent.clear()
b.on_post_tool_call("skill_manage", {"name": NAME}, json.dumps({"staged": True, "pending_id": "zzz"}), "t", "s")
check("aviso: fora do treinamento, nada", not sent)
# prova de uso: numa conversa, carregar a própria competência aprendida avisa o Ergon (contador no perfil)
b.on_post_tool_call("skill_view", {"name": NAME}, json.dumps({"success": True, "content": "x"}), "t", "s")
check("uso: carregar a própria competência avisa o Ergon", len(sent) == 1 and sent[0][1].get("tool") == "skill_view" and sent[0][1].get("skill") == NAME, str(sent))
sent.clear()
b.on_post_tool_call("skill_view", {"name": OTHER}, json.dumps({"success": True}), "t", "s")
b.on_post_tool_call("skill_view", {"name": NAME}, json.dumps({"success": False, "error": "não achou"}), "t", "s")
b.on_post_tool_call("skill_view", {"name": "pesquisa-academica"}, json.dumps({"success": True}), "t", "s")
check("uso: de outro agente, que falhou ou da biblioteca comum: nada", not sent, str(sent))

# ---------- fluxo nativo: /learn, escrita em espera, aplicar com nome e marca, índice, skill_view
from agent.learn_prompt import build_learn_prompt  # noqa: E402
p = build_learn_prompt("Aprenda a diagnosticar GC")
check("/learn nativo monta o turno", "[/learn]" in p and "skill_manage" in p and "Aprenda a diagnosticar GC" in p)
from tools.skill_manager_tool import skill_manage  # noqa: E402
from tools import write_approval as wa  # noqa: E402
r1 = json.loads(skill_manage(action="create", name=NAME, category="qualquer", content="---\nname: outro-nome\ndescription: Diagnostico de GC.\nversion: 0.1.0\nauthor: Hermes\nmetadata:\n  hermes:\n    tags: [GC]\n---\n# Diagnostico de GC\n\nCodigo de erro E42: coluna entupida.\n"))
r2 = json.loads(skill_manage(action="write_file", name=NAME, file_path="references/erros.md", file_content="# Erros\nE42: coluna entupida."))
check("com a trava nativa ligada, nada é gravado (fica em espera)", r1.get("staged") and r2.get("staged") and b._skill_dir(NAME) is None, f"{r1} {r2}")
ids = [r["id"] for r in wa.list_pending(wa.SKILLS) if b._skill_base(r["payload"].get("name")) == NAME]
check("as duas escritas em espera, na ordem", len(ids) == 2)
files = b.skills_apply(ids, NAME)
main = files.get("SKILL.md", "")
check("aplicada: SKILL.md e a referência", "SKILL.md" in files and "references/erros.md" in files, str(list(files)))
check("nome do Ergon forçado no cabeçalho", f'name: "{NAME}"' in main, main[:200])
check("marcada como privada", "ergon-privado" in main, main[:300])
check("categoria ergon", str(b._skill_dir(NAME)).endswith(f"/ergon/{NAME}"), str(b._skill_dir(NAME)))
check("escritas em espera consumidas", not [r for r in wa.list_pending(wa.SKILLS) if b._skill_base(r["payload"].get("name")) == NAME])
from agent.prompt_builder import build_skills_system_prompt  # noqa: E402
idx = build_skills_system_prompt(available_tools={"skill_view"}, available_toolsets={"skills"})
check("fora do índice comum de skills (outros agentes não veem)", NAME not in idx)
from tools.skills_tool import skill_view  # noqa: E402
v = json.loads(skill_view(NAME))
check("carrega por nome (o dono, pela trava)", v.get("success") and "E42" in json.dumps(v, ensure_ascii=False), str(v)[:200])

# ---------- atualização sem duplicar: "create" de novo vira reescrita
skill_manage(action="create", name=NAME, category="x", content="---\nname: x\ndescription: Diagnostico de GC v2.\n---\n# Diagnostico de GC\n\nE42 e E43.\n")
ids2 = [r["id"] for r in wa.list_pending(wa.SKILLS) if b._skill_base(r["payload"].get("name")) == NAME]
files2 = b.skills_apply(ids2, NAME)
check("atualização: mesma competência, conteúdo novo, referência mantida", "E43" in files2.get("SKILL.md", "") and "references/erros.md" in files2)
import glob  # noqa: E402
check("sem duplicata na biblioteca", len(glob.glob(f"{HOME}/skills/**/{NAME}", recursive=True)) == 1)

# ---------- lote de verdade: o motor guarda UMA escrita em espera; o Ergon vê as operações; aplicar grava tudo
LOTE = "ergon-abc123-fidias-cartao-de-amostra"
r3 = json.loads(skill_manage(action="", name="", operations=[
    {"action": "create", "name": LOTE, "category": "qualquer", "content": "---\nname: outro\ndescription: Cartao de amostra.\nversion: 0.1.0\nauthor: Hermes\n---\n# Cartao de amostra\n\nRodape TREINAR-H-7731.\n"},
    {"action": "write_file", "name": LOTE, "file_path": "references/campos.md", "file_content": "# Campos\nCodigo; Cliente."}]))
lote_ids = [r["id"] for r in wa.list_pending(wa.SKILLS) if r["payload"].get("action") == "batch"]
check("lote: fica em espera como uma escrita só", r3.get("staged") and len(lote_ids) == 1 and b._skill_dir(LOTE) is None, f"{r3} {lote_ids}")
linhas = b.skills_pending(set(), LOTE)
check("lote: o Ergon vê as duas operações, com o mesmo id, na ordem",
      [x["action"] for x in linhas] == ["create", "write_file"] and {x["id"] for x in linhas} == set(lote_ids), str(linhas)[:300])
check("lote: listar pelo nome de outra competência não traz o lote", not b.skills_pending(set(), NAME))
files4 = b.skills_apply(lote_ids + lote_ids, LOTE)
check("lote: aplicado (principal + referência), nome forçado, privado",
      "references/campos.md" in files4 and f'name: "{LOTE}"' in files4.get("SKILL.md", "") and "ergon-privado" in files4.get("SKILL.md", "")
      and str(b._skill_dir(LOTE)).endswith(f"/ergon/{LOTE}"), str(files4)[:300])
check("lote: escrita em espera consumida", not b.skills_pending(set(), LOTE))
b._apply_write({"action": "delete", "name": LOTE})

# ---------- restaurar a versão 1 e remover
files3 = b.skills_restore(NAME, files)
check("restaurar: volta o conteúdo da versão 1, marcado", "E43" not in files3.get("SKILL.md", "") and "E42" in files3.get("SKILL.md", "") and "ergon-privado" in files3.get("SKILL.md", ""))
try:
    b.skills_apply(["naoexiste"], NAME)
    check("aplicar escrita de outra competência/inexistente: recusado", False)
except ValueError:
    check("aplicar escrita de outra competência/inexistente: recusado", True)
r = b._apply_write({"action": "delete", "name": NAME})
check("remover: some da biblioteca", r.get("success") and b._skill_dir(NAME) is None, str(r))

print("TUDO OK" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

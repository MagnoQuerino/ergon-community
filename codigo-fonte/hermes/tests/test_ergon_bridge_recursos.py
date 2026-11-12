"""Capacidades da equipe (rc.27) pelo plugin do Ergon, dentro da imagem do motor e sem rede.

O painel do Hermes é o de verdade (hermes_cli.web_server.app), chamado no mesmo processo: as rotas da ponte passam pelo
código real de configuração, conselho de modelos, loja de competências (a fonte oficial lê a pasta optional-skills da
imagem), varredura de segurança, catálogo de conectores (optional-mcps), plugins e conquistas. Também: a trava de
escrita de arquivos e dos conectores no pre_tool_call, os checkpoints (guardar e voltar atrás) e o que a imagem traz
para voz e navegador.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_recursos.py
"""
import json
import os
import sys

HOME = os.environ.setdefault("HERMES_HOME", "/tmp/h")
os.makedirs(HOME, exist_ok=True)
TOKEN = "t" * 40
os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = TOKEN
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/p")
import ergon_bridge as b  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and bool(cond)


# ---------------------------------------------------------------- 1. travas no pre_tool_call
check("capacidade 'recursos' no contrato", "recursos" in b.CAPACIDADES)
so_ler = b._tools_of(["file"])
check("leitura de arquivos sem Terminal: lê e procura, não grava", {"read_file", "search_files"} <= so_ler and not {"write_file", "patch"} & so_ler, str(sorted(so_ler)))
check("leitura de arquivos com Terminal: grava também", {"read_file", "write_file", "patch"} <= b._tools_of(["file", "terminal"]))
check("leitura de arquivos com Executar código: grava também", {"write_file", "patch"} <= b._tools_of(["file", "code_execution"]))
for ts, nome in (("browser", "browser_navigate"), ("video", "video_analyze"), ("video_gen", "video_generate"), ("x_search", "x_search"), ("tts", "text_to_speech")):
    check(f"conjunto {ts} existe no Hermes e está na lista do que a pessoa pode ligar", nome in b._tools_of([ts]) and ts in b._SAFE_TOOLSETS)

politica = {"allowed": b._tools_of(["web", "file"]), "who": "Hipátia", "holders": {}, "guarded": {"terminal": "terminal"}, "skills": frozenset(),
            "training": None, "denied": frozenset(), "mcp": None}
b._policy = lambda s, t: politica
r = b.on_pre_tool_call("read_file", {"path": "/tmp/x"}, "t", "s")
check("read_file liberada para quem tem a leitura de arquivos", r is None, str(r))
r = b.on_pre_tool_call("write_file", {"path": "/tmp/x", "content": "y"}, "t", "s")
check("write_file barrada sem Terminal", isinstance(r, dict) and r.get("action") == "block", str(r))
r = b.on_pre_tool_call("mcp__notion__search", {"query": "x"}, "t", "s")
check("conector barrado para quem não tem os conectores", isinstance(r, dict) and "conectores prontos" in r.get("message", ""), str(r))
politica["mcp"] = {"ligado": True, "escrita": []}
check("conector: consulta liberada", b.on_pre_tool_call("mcp__notion__search", {"query": "x"}, "t", "s") is None)
check("conector: consulta em camelCase liberada", b.on_pre_tool_call("mcp__linear__listIssues", {}, "t", "s") is None)
r = b.on_pre_tool_call("mcp__notion__create_page", {"title": "x"}, "t", "s")
check("conector: escrita barrada sem a liberação da pessoa", isinstance(r, dict) and "só para consulta" in r.get("message", ""), str(r))
r = b.on_pre_tool_call("mcp__notion__gettysburg_delete", {}, "t", "s")
check("conector: nome que só parece consulta conta como escrita", isinstance(r, dict) and r.get("action") == "block", str(r))
# começa como consulta mas muda dados (revisão da rc.27): nada disso passa sem a liberação da escrita
for nome in ("status_update", "get_or_create_user", "read_and_delete_message", "check_item", "resolve_issue", "info_set",
             "fetchAndArchive", "list_and_remove_members", "getShareLink", "help_submit_ticket"):
    r = b.on_pre_tool_call(f"mcp__app__{nome}", {}, "t", "s")
    check(f"conector: '{nome}' conta como escrita", isinstance(r, dict) and r.get("action") == "block", str(r))
for nome in ("resolve_library_id", "get_commit", "list_workflow_runs", "get_comment", "search_posts", "getNewMessages", "status", "whoami"):
    check(f"conector: '{nome}' continua consulta", b.on_pre_tool_call(f"mcp__app__{nome}", {}, "t", "s") is None)
politica["mcp"] = {"ligado": True, "escrita": ["notion"]}
check("conector: escrita liberada onde a pessoa liberou", b.on_pre_tool_call("mcp__notion__create_page", {"title": "x"}, "t", "s") is None)
r = b.on_pre_tool_call("mcp__stripe__create_refund", {}, "t", "s")
check("conector: a liberação de um não vale para outro", isinstance(r, dict) and r.get("action") == "block", str(r))
politica["mcp"] = {"ligado": True, "escrita": ["hugging-face"]}
check("conector com hífen: o nome do Hermes troca por sublinhado", b.on_pre_tool_call("mcp__hugging_face__create_repo", {}, "t", "s") is None)
politica["denied"] = frozenset({"mcp__"})
b._pedir_aprovacao = lambda *a, **k: "espera a aprovação"
r = b.on_pre_tool_call("mcp__notion__search", {"query": "x"}, "t", "s")
check("conector: depois de ler conteúdo privado, pede a aprovação (prefixo na lista)", isinstance(r, dict) and r.get("message") == "espera a aprovação", str(r))
politica["denied"] = frozenset()

# ---------------------------------------------------------------- 2. o painel de verdade, no mesmo processo
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import config as hc  # noqa: E402
from hermes_cli import web_server  # noqa: E402

cliente = TestClient(web_server.app)
chamadas = []


def painel(method, path, query, body):
    chamadas.append((method, path))
    resp = cliente.request(method, path + (f"?{query}" if query else ""), json=body if method in ("POST", "PUT") else None,
                           headers={"X-Hermes-Session-Token": web_server._SESSION_TOKEN})
    hc._LOAD_CONFIG_CACHE.clear()
    return resp.status_code, resp.content


b._dash_call = painel


class Resp(b._ControlHandler):
    def __init__(self):  # sem socket: só as rotas
        self.out = None

    def _json(self, status, obj):
        self.out = (status, obj)

    def _send(self, status, data):
        try:
            self.out = (status, json.loads(data or b"{}"))
        except ValueError:
            self.out = (status, {"bruto": data[:200].decode("utf-8", "replace")})


def ponte(metodo, caminho, corpo=None, q=None):
    resp = Resp()
    resp._recursos(metodo, "/ergon/v1/" + caminho, q or {}, corpo or {})
    return resp.out


def disco():
    hc._LOAD_CONFIG_CACHE.clear()
    return hc.load_config()


st = ponte("GET", "recursos")
check("estado inicial: tudo desligado, sem conectores", st[0] == 200 and st[1]["checkpoints"] is False and st[1]["codigo_inseguro"] is False
      and st[1]["limpeza"] is False and st[1]["conectores"] == [], str(st))
check("imagem: traz o Chromium", st[1]["navegador"]["chromium"] is True, str(st[1]["navegador"]))
print("      navegador:", st[1]["navegador"], "| voz:", st[1]["voz"])
st = ponte("PUT", "recursos", {"checkpoints": True, "codigo_inseguro": True, "limpeza": True})
check("ligar checkpoints, aviso de código inseguro e limpeza", st[0] == 200 and st[1]["checkpoints"] and st[1]["codigo_inseguro"] and st[1]["limpeza"], str(st))
cfg = disco()
check("no config do Hermes: checkpoints.enabled e os dois plugins", cfg["checkpoints"]["enabled"] is True
      and {"security-guidance", "disk-cleanup"} <= set(cfg.get("plugins", {}).get("enabled") or []), str(cfg.get("plugins")))
st = ponte("PUT", "recursos", {"limpeza": False})
check("desligar a limpeza: sai da lista do Hermes, o resto fica", st[0] == 200 and st[1]["limpeza"] is False and st[1]["codigo_inseguro"] is True, str(st))
check("recursos: chave desconhecida recusada", ponte("PUT", "recursos", {"terminal": True})[0] == 400)
check("recursos: valor que não é sim/não recusado", ponte("PUT", "recursos", {"checkpoints": "sim"})[0] == 400)

# conselho de modelos
st = ponte("GET", "conselho")
check("conselho: o padrão do Hermes vem resumido", st[0] == 200 and st[1]["preset"] == "default" and len(st[1]["opinam"]) >= 2 and st[1]["agrega"]["model"], str(st))
novo = {"opinam": [{"provider": "nous", "model": "anthropic/claude-sonnet-5.5"}, {"provider": "nous", "model": "openai/gpt-6"}], "agrega": {"provider": "nous", "model": "anthropic/claude-opus-5"}}
st = ponte("PUT", "conselho", novo)
check("conselho: gravado como a tela montou", st[0] == 200 and st[1]["opinam"] == novo["opinam"] and st[1]["agrega"] == novo["agrega"], str(st))
moa = disco().get("moa", {})
check("conselho: no config do Hermes (moa.presets.default)", [x["model"] for x in moa["presets"]["default"]["reference_models"]] == ["anthropic/claude-sonnet-5.5", "openai/gpt-6"]
      and moa["presets"]["default"]["aggregator"]["model"] == "anthropic/claude-opus-5", str(moa))
check("conselho: um modelo só não é conselho", ponte("PUT", "conselho", {"opinam": novo["opinam"][:1], "agrega": novo["agrega"]})[0] == 400)
check("conselho: o conselho não opina no conselho", ponte("PUT", "conselho", {"opinam": [{"provider": "moa", "model": "default"}, novo["opinam"][0]], "agrega": novo["agrega"]})[0] == 400)
from hermes_cli.runtime_provider import resolve_runtime_provider  # noqa: E402

try:
    rt = resolve_runtime_provider(requested="moa", target_model="default")
    check("conselho: o Hermes resolve o provedor 'moa' (o que a execução do Ergon pede)", str(rt.get("base_url") if isinstance(rt, dict) else getattr(rt, "base_url", "")).startswith("moa://"), str(rt)[:200])
except Exception as exc:  # noqa: BLE001
    check("conselho: o Hermes resolve o provedor 'moa'", False, f"{type(exc).__name__}: {exc}")

# loja de competências: a fonte oficial é a pasta optional-skills da imagem (sem rede)
st = ponte("GET", "loja")
lista = st[1].get("competencias", []) if st[0] == 200 else []
check("loja: as competências oficiais da imagem", st[0] == 200 and len(lista) > 50, f"{st[0]} {len(lista)}")
excel = next((c for c in lista if c["nome"] == "excel-author"), None)
check("loja: excel-author está lá, não instalada", bool(excel) and excel["instalada"] is False and excel["id"].startswith("official/"), str(excel))
check("loja: identificador inválido recusado", ponte("GET", "loja/varredura", q={"id": "../../etc"})[0] == 400)
if excel:
    st = ponte("GET", "loja/previa", q={"id": excel["id"]})
    check("loja: prévia com o texto da competência", st[0] == 200 and len(st[1].get("texto", "")) > 200, str(st)[:300])
    st = ponte("GET", "loja/varredura", q={"id": excel["id"]})
    check("loja: varredura de segurança do Hermes", st[0] == 200 and st[1].get("veredito") in ("safe", "caution", "dangerous") and st[1].get("politica") in ("allow", "ask", "block"), str(st)[:400])
    print("      varredura:", st[1].get("veredito"), st[1].get("politica"), "| achados:", len(st[1].get("achados", [])))
    st = ponte("POST", "loja/instalar", {"id": excel["id"]})
    check("loja: instalar passa pela varredura e pede a instalação ao Hermes", st[0] == 200 and st[1].get("ok") is True and ("GET", "/api/skills/hub/scan") in chamadas, str(st)[:300])
    destino = os.path.join(HOME, "skills")
    achou = any("excel-author" in d and "SKILL.md" in fs for d, _dirs, fs in os.walk(destino))
    check("loja: a competência oficial ficou instalada no motor, sem rede", achou, destino)
    st = ponte("GET", "loja")
    check("loja: agora aparece como instalada", any(c["nome"] == "excel-author" and c["instalada"] for c in st[1].get("competencias", [])), str(st)[:200])
    b._dash_call = lambda m, p, q, body: (200, json.dumps({"identifier": "x/y", "policy": "block", "verdict": "dangerous", "findings": []}).encode()) if p.endswith("/scan") else painel(m, p, q, body)
    instalou = []
    b.loja_instalar = lambda ident: (instalou.append(ident), (True, ""))[1]
    st = ponte("POST", "loja/instalar", {"id": "comunidade/perigosa"})
    check("loja: o que a varredura barra não instala", st[0] == 409 and not instalou, str(st)[:200])
    b._dash_call = painel

# conectores prontos (MCP): o catálogo é a pasta optional-mcps da imagem
st = ponte("GET", "conectores")
cat = st[1].get("catalogo", []) if st[0] == 200 else []
check("conectores: o catálogo da imagem", st[0] == 200 and len(cat) >= 60 and st[1]["servidores"] == [], f"{st[0]} {len(cat)}")
c7 = next((c for c in cat if c["nome"] == "context7"), None)
check("conectores: context7 sem entrada (não precisa de conta)", bool(c7) and c7["entrada"] == "none" and c7["instalado"] is False, str(c7))
cfg0 = disco()
cfg0.setdefault("platform_toolsets", {}).update({"teams": ["todo"], "whatsapp": ["todo"]})
cfg0.setdefault("tools", {})["tool_search"] = {"enabled": "off"}
hc.save_config(cfg0)
st = ponte("POST", "conectores/instalar", {"nome": "context7"})
cfg = disco()
check("conectores: instalado e ligado no config do Hermes", st[0] == 200 and cfg.get("mcp_servers", {}).get("context7", {}).get("url", "").startswith("https://mcp.context7.com"), str(st)[:300])
check("conectores: com o primeiro ligado, a busca de ferramentas liga", st[0] == 200 and st[1]["busca_ferramentas"] is True and str(cfg["tools"]["tool_search"]["enabled"]).lower() in ("on", "true"), str(cfg.get("tools")))
check("conectores: Teams e WhatsApp diretos ficam sem eles (no_mcp)", "no_mcp" in cfg["platform_toolsets"]["teams"] and "no_mcp" in cfg["platform_toolsets"]["whatsapp"], str(cfg["platform_toolsets"]))
from hermes_cli.tools_config import _get_platform_tools  # noqa: E402

check("conectores: valem na plataforma dos agentes do Ergon e não no Teams direto", "context7" in _get_platform_tools(cfg, "api_server") and "context7" not in _get_platform_tools(cfg, "teams"),
      f"{sorted(_get_platform_tools(cfg, 'api_server'))} × {sorted(_get_platform_tools(cfg, 'teams'))}")
st = ponte("POST", "conectores/instalar", {"nome": "notion", "retorno": "http://localhost:8787/api/conectores/retorno/notion"})
cfg = disco()
check("conectores: com entrada (OAuth), a volta passa pelo Ergon", st[0] == 200 and cfg["mcp_servers"]["notion"].get("oauth", {}).get("redirect_uri") == "http://localhost:8787/api/conectores/retorno/notion", str(cfg["mcp_servers"].get("notion")))
check("conectores: endereço de retorno estranho recusado", ponte("POST", "conectores/instalar", {"nome": "linear", "retorno": "javascript:alert(1)"})[0] == 400)
check("conectores: campo que o catálogo não pede é recusado pelo Hermes", ponte("POST", "conectores/instalar", {"nome": "context7", "campos": {"OUTRA_COISA": "x"}})[0] == 400)
st = ponte("GET", "conectores")
check("conectores: a lista mostra os dois instalados (o recusado não entrou)", st[0] == 200 and {s["nome"] for s in st[1]["servidores"]} == {"context7", "notion"}, str(st[1].get("servidores")))
ponte("PUT", "conectores/notion", {"ligado": False})
st = ponte("PUT", "conectores/context7", {"ligado": False})
cfg = disco()
check("conectores: desligados; sem nenhum ligado, a busca de ferramentas desliga", st[0] == 200 and cfg["mcp_servers"]["context7"]["enabled"] is False and st[1]["busca_ferramentas"] is False, str(st))
st = ponte("DELETE", "conectores/notion")
check("conectores: removido do config", st[0] == 200 and "notion" not in disco().get("mcp_servers", {}), str(st))
st = ponte("POST", "conectores-retorno/notion", {"code": "x", "state": "y"})
check("conectores: volta de entrada sem pedido aberto não vale", st[0] == 200 and st[1]["ok"] is False, str(st))

# conquistas: o plugin do Hermes lê o histórico do próprio motor
st = ponte("GET", "conquistas")
check("conquistas: a lista do plugin do Hermes", st[0] == 200 and isinstance(st[1].get("conquistas"), list), str(st)[:300])
print("      conquistas:", len(st[1].get("conquistas", [])) if st[0] == 200 else st)

# ---------------------------------------------------------------- 3. voltar atrás (checkpoints)
pasta = "/tmp/ergon-recursos-trabalho"
os.makedirs(pasta, exist_ok=True)
open(os.path.join(pasta, "relatorio.txt"), "w").write("versão boa")
from tools.checkpoint_manager import CheckpointManager  # noqa: E402

CheckpointManager(enabled=True).ensure_checkpoint(pasta, "antes de gravar relatorio.txt")
open(os.path.join(pasta, "relatorio.txt"), "w").write("estragado")
st = ponte("GET", "checkpoints")
pontos = [p for p in st[1].get("pontos", []) if p["pasta"] == pasta]
check("checkpoints: o ponto guardado aparece", st[0] == 200 and len(pontos) == 1 and pontos[0]["motivo"].startswith("antes de gravar"), str(st)[:300])
check("checkpoints: ponto que não existe não volta", ponte("POST", "checkpoints/voltar", {"pasta": pasta, "id": "0" * 40})[1].get("ok") is False)
check("checkpoints: pasta relativa recusada", ponte("POST", "checkpoints/voltar", {"pasta": "tmp", "id": "0" * 40})[0] == 400)
st = ponte("POST", "checkpoints/voltar", {"pasta": pasta, "id": pontos[0]["id"]}) if pontos else (0, {})
check("checkpoints: voltar atrás devolve o arquivo", st[0] == 200 and st[1].get("ok") is True and open(os.path.join(pasta, "relatorio.txt")).read() == "versão boa", str(st))
st = ponte("GET", "checkpoints")
check("checkpoints: o estado de antes da volta também ficou guardado", len([p for p in st[1].get("pontos", []) if p["pasta"] == pasta]) == 2, str(st)[:300])

# ---------------------------------------------------------------- 4. voz: só o que a imagem consegue (sem rede)
voz = b._voz_estado()
st = ponte("POST", "voz/transcrever", {"audio": "AAAA", "nome": "nota.txt"})
check("voz: arquivo que não é áudio recusado", st[0] == 200 and st[1] == {"ok": False, "motivo": "formato"}, str(st))
check("voz: áudio que não é base64 recusado", ponte("POST", "voz/transcrever", {"audio": "@@", "nome": "a.ogg"})[0] == 400)
st = ponte("POST", "voz/transcrever", {"audio": "AAAA", "nome": "a.ogg"})
if voz["transcrever"] is None:
    check("voz: sem transcritor na imagem, a ponte diz que falta o componente", st[1] == {"ok": False, "motivo": "componente"}, str(st))
else:
    check("voz: transcritor presente responde (áudio inválido: falha limpa)", st[0] == 200 and st[1].get("ok") is False, str(st))
st = ponte("POST", "voz/falar", {"texto": "Bom dia."})
check("voz: falar sem rede ou sem componente falha limpo", st[0] == 200 and st[1].get("ok") is False and st[1].get("motivo") in ("componente", "falhou"), str(st))
check("voz: texto vazio recusado", ponte("POST", "voz/falar", {"texto": " "})[0] == 400)
check("rota desconhecida: 404", ponte("GET", "recursos/outra")[0] == 404)

print("\nRESULTADO:", "OK" if ok else "FALHOU")
sys.exit(0 if ok else 1)

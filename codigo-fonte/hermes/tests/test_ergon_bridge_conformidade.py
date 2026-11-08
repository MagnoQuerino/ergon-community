"""Conformidade com o Hermes instalado na imagem do motor (rede de proteção para trocar a versão do motor).

Confere que o fixture com os nomes das ferramentas por conjunto (server/test/fixtures/hermes-v0.22.2-ferramentas.json,
que o servidor usa para conferir a trava "depois de ler conteúdo privado") é o que o toolsets.resolve_toolset do Hermes
instalado devolve; que nenhum conjunto novo apareceu sem entrar no fixture; que o registro de ferramentas não acrescenta
nada aos grupos que a trava cobre; que a entrada com prefixo ("browser_") barra o navegador inteiro no plugin; e que a
versão do plugin é uma só (plugin.yaml e o código) e o próprio Hermes valida o plugin.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" -v "$PWD/server/test/fixtures:/f:ro" ergon-hermes:dev \
    /t/test_ergon_bridge_conformidade.py
"""
import json
import os
import shutil
import subprocess
import sys

import hermes_yaml as yaml  # o leitor de YAML do próprio Hermes (em /opt/hermes)

# o arquivo (ERGON_FIXTURE) ou a pasta dos fixtures do servidor (ERGON_FIXTURES, o que a CI passa; padrão /f)
FIXTURE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ERGON_FIXTURE") or os.path.join(os.environ.get("ERGON_FIXTURES", "/f"), "hermes-v0.22.2-ferramentas.json")
HOME = os.environ.get("HERMES_HOME", "/tmp/h")
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/p")

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


fx = json.load(open(FIXTURE, encoding="utf-8"))
esperado = fx["toolsets"]

# ---------------------------------------------------------------- a versão do Hermes
# (o pyproject do Hermes diz 0.0.0; a versão de verdade vem do carimbo da instalação, o mesmo de "hermes --version")
versao = ""
try:
    from hermes_cli.version_info import get_version_info  # noqa: E402
    info = get_version_info()
    versao = str(getattr(info, "base_version", "") or "")
except Exception:  # noqa: BLE001
    pass
if not versao or versao.startswith("0.0.0"):
    try:
        versao = str(json.load(open("/opt/hermes/install-stamp.json", encoding="utf-8")).get("baseVersion") or "")
    except Exception:  # noqa: BLE001
        versao = ""
check(f"fixture da mesma versão do Hermes instalado ({versao or '?'})", versao.lstrip("v") == fx["hermes"],
      f"o fixture é do Hermes {fx['hermes']}: gere um novo (nomes por conjunto) e confira a trava (server/test/conexoes-regra-nomes.test.ts)")

# ---------------------------------------------------------------- os nomes
import toolsets as T  # noqa: E402

for nome, lista in sorted(esperado.items()):
    real = sorted(T.resolve_toolset(nome, include_registry=False))
    check(f"conjunto {nome}: igual ao Hermes instalado", real == sorted(lista),
          f"a mais no Hermes: {sorted(set(real) - set(lista))}; a menos: {sorted(set(lista) - set(real))}")
novos = sorted(k for k in T.TOOLSETS if not k.startswith("hermes-") and k not in esperado)
check("nenhum conjunto novo fora do fixture", novos == [], f"conjuntos novos: {novos} (acrescente ao fixture e confira a trava)")

import model_tools  # noqa: E402,F401  registra as ferramentas nativas

for nome in ("web", "terminal", "code_execution", "browser", "vision"):
    com_registro = sorted(T.resolve_toolset(nome))
    check(f"conjunto {nome}: o registro não acrescenta ferramenta", com_registro == sorted(esperado[nome]),
          f"só no registro: {sorted(set(com_registro) - set(esperado[nome]))}")

import ergon_bridge as b  # noqa: E402

check("os conjuntos que o Ergon liga existem no Hermes",
      (b._SAFE_TOOLSETS | b._GUARDED_TOOLSETS) - set(getattr(b, "_ERGON_PLUGIN_TOOLSETS", ("ergon_conexoes",))) <= set(esperado),
      str(sorted((b._SAFE_TOOLSETS | b._GUARDED_TOOLSETS) - set(esperado))))

# ---------------------------------------------------------------- a trava por prefixo no plugin
politica = {"allowed": frozenset(), "who": "Aspásia", "holders": {}, "guarded": {}, "skills": frozenset(), "training": None,
            "denied": frozenset({"browser_", "process_manage", "web_extract"})}
b._policy = lambda session_id, task_id: politica
barrada = lambda t: (lambda r: isinstance(r, dict) and "conteúdo privado" in r.get("message", ""))(b.on_pre_tool_call(t, {}, "t", "s"))  # noqa: E731
fora = [t for t in esperado["browser"] if not barrada(t)]
check("prefixo 'browser_': o navegador inteiro do fixture barrado", fora == [], str(fora))
check("prefixo vale para ferramenta nova do navegador", barrada("browser_uma_ferramenta_nova"))
check("nome exato continua valendo (process_manage, web_extract)", barrada("process_manage") and barrada("web_extract"))
check("a busca na web não cai pela trava", not barrada("web_search"))
negada = getattr(b, "_negada", lambda t, d: False)  # plugin de antes: sem a regra do prefixo
check("'browser' sem o '_' não é prefixo de nada", not negada("browser_navigate", ["browser"]) and negada("browser", ["browser"]))
check("entrada '_' sozinha não barra tudo", not negada("web_search", ["_"]))

# ---------------------------------------------------------------- a versão do plugin
manifest = yaml.safe_load(open("/p/ergon_bridge/plugin.yaml", encoding="utf-8"))
check("plugin.yaml e PLUGIN_VERSION iguais", str(manifest.get("version")) == getattr(b, "PLUGIN_VERSION", None), f"{manifest.get('version')} × {getattr(b, 'PLUGIN_VERSION', None)}")
check("capacidades do contrato", set(getattr(b, "CAPACIDADES", ())) >= {"conexoes", "bloqueio_prefixo", "known_plugin_toolsets"}, str(getattr(b, "CAPACIDADES", None)))
os.makedirs(os.path.join(HOME, "plugins"), exist_ok=True)
copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "validate", copia], capture_output=True, text=True, timeout=180)
saida = (r.stdout + r.stderr)[-1500:]
check("o Hermes valida o plugin (ferramentas e ganchos declarados = registrados)", r.returncode == 0, saida)

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

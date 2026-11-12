"""Os perfis dos agentes acompanham a configuração da equipe e as chaves guardadas por cartão (revisão da rc.27).

No gateway com vários perfis, cada perfil lê os segredos SÓ do .env dele (agent/secret_scope.py,
build_profile_secret_scope) e a configuração SÓ do config.yaml dele. Confere, com o código de verdade do Hermes e sem rede:
- a chave guardada por um cartão (que vai ao .env do perfil padrão) chega ao .env de cada perfil na hora, e o escopo de
  segredos do perfil (o que o Terminal do agente recebe) passa a tê-la; apagada, sai de todos;
- a troca da configuração da equipe (modelo padrão, ferramentas ligadas) chega ao perfil sem o Ergon mandar o perfil de
  novo, com o que é do agente por cima; sem mudança, nada é regravado;
- um valor com acentos é recusado antes de gravar, sem nada no .env e sem o caractere no registro do motor.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_perfis_sincronia.py
"""
import contextlib
import io
import json
import os
import shutil
import sys

HOME = os.environ.setdefault("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(os.path.join(HOME, "plugins"))
shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"))
CHAVE_API = "chave-da-api-de-teste-" + "0123456789abcdef"
SEGREDO = "-".join(["zq7", "Kp2mXv9", "Lw4Rt8", "Yb3Nc6"])
NOME = "CLIMA_TESTE_TOKEN"
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    f.write("model:\n  provider: custom\n  default: modelo-um\n  base_url: http://127.0.0.1:9/v1\n"
            "platform_toolsets:\n  api_server: [todo, web, memory, session_search, ergon_conexoes, ergon_cartoes]\n"
            "plugins:\n  enabled: [ergon_bridge]\n")
with open(os.path.join(HOME, ".env"), "w", encoding="utf-8") as f:
    f.write(f"API_SERVER_KEY={CHAVE_API}\nOPENROUTER_API_KEY=sk-or-teste\n")
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/p")
import hermes_yaml as yaml  # noqa: E402  (o leitor de YAML do próprio Hermes)
import ergon_bridge as b  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""), flush=True)
    ok = ok and bool(cond)


def ler(*partes):
    try:
        return open(os.path.join(HOME, *partes), encoding="utf-8").read()
    except OSError:
        return ""


PERFIL = "erg-" + "0123456789abcdef0123"
pedido = {"alma": "Você é a Hipátia.", "ferramentas": ["todo", "web", "terminal"], "memoria": True, "busca": True,
          "ajudantes": {"ligado": False, "max": 2}, "modelo": None, "competencias": []}
r = b.perfil_garantir(PERFIL, pedido)
check("perfil criado", r.get("criado") is True, str(r))
estado = json.loads(ler("profiles", PERFIL, ".ergon-perfil.json"))
check("o pedido fica guardado no estado do perfil", isinstance(estado.get("pedido"), dict) and estado["pedido"].get("ferramentas") == ["terminal", "todo", "web"], str(estado))
cfg = yaml.safe_load(ler("profiles", PERFIL, "config.yaml"))
check("o perfil começa com o modelo da equipe", cfg["model"]["default"] == "modelo-um", str(cfg.get("model")))
check("Terminal fora do perfil enquanto a equipe não o liga", "terminal" not in cfg["platform_toolsets"]["api_server"], str(cfg["platform_toolsets"]))

check("sem mudança na equipe: nada é refeito", b._perfis_acompanhar(forcar=True) == 0)

# 1. a chave guardada por um cartão chega ao perfil na hora (sem o Ergon mandar o perfil de novo)
b.chave_guardar(NOME, SEGREDO, "ver a previsão", "Hipátia")
check("a chave está no .env do perfil padrão", f"{NOME}={SEGREDO}" in ler(".env"))
check("e no .env do perfil do agente", f"{NOME}={SEGREDO}" in ler("profiles", PERFIL, ".env"))
from agent.secret_scope import build_profile_secret_scope  # noqa: E402
from pathlib import Path  # noqa: E402
escopo = build_profile_secret_scope(Path(HOME) / "profiles" / PERFIL)
check("o escopo de segredos do perfil (o que o Terminal do agente recebe) tem a chave", escopo.get(NOME) == SEGREDO, str(sorted(escopo)))
check("o perfil continua com a chave da API", f"API_SERVER_KEY={CHAVE_API}" in ler("profiles", PERFIL, ".env"))

# instantâneo do Terminal aberto dentro do perfil: a chave apagada sai dele também
snap = os.path.join(HOME, "profiles", PERFIL, "cache", "scratch")
os.makedirs(snap, exist_ok=True)
with open(os.path.join(snap, "hermes-snap-teste.sh"), "w", encoding="utf-8") as f:
    f.write(f"declare -x OUTRA=1\ndeclare -x {NOME}={SEGREDO}\n")

# 2. apagada: sai de todos
check("apagar a chave", b.chave_apagar(NOME) is True)
check("fora do .env do perfil padrão", NOME not in ler(".env"))
check("fora do .env do perfil do agente", NOME not in ler("profiles", PERFIL, ".env"))
check("fora do escopo de segredos do perfil", NOME not in build_profile_secret_scope(Path(HOME) / "profiles" / PERFIL))
check("fora do instantâneo do Terminal aberto no perfil", SEGREDO not in ler("profiles", PERFIL, "cache", "scratch", "hermes-snap-teste.sh")
      and "OUTRA=1" in ler("profiles", PERFIL, "cache", "scratch", "hermes-snap-teste.sh"))

# 3. a configuração da equipe mudou (modelo padrão e o Terminal ligado): o acompanhamento refaz o perfil
base = yaml.safe_load(ler("config.yaml"))
base["model"]["default"] = "modelo-dois"
base["platform_toolsets"]["api_server"].append("terminal")
with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
    yaml.safe_dump(base, f, sort_keys=False)
os.utime(os.path.join(HOME, "config.yaml"), ns=(1_900_000_000_000_000_000, 1_900_000_000_000_000_000))
check("um perfil refeito", b._perfis_acompanhar() == 1)
cfg = yaml.safe_load(ler("profiles", PERFIL, "config.yaml"))
check("o perfil passa a usar o modelo novo da equipe", cfg["model"]["default"] == "modelo-dois", str(cfg.get("model")))
check("e tem o Terminal (ligado na equipe e liberado ao agente)", "terminal" in cfg["platform_toolsets"]["api_server"], str(cfg["platform_toolsets"]))
check("o que é do perfil continua (memória com aprovação, sem multiplexação)", cfg["memory"]["write_approval"] is True and "gateway" not in cfg)
check("de novo, sem mudança: nada", b._perfis_acompanhar() == 0)
r = b.perfil_garantir(PERFIL, pedido)
check("o próximo garantir do Ergon não vê nada a refazer", r.get("mudou") == [], str(r))

# 4. perfil gravado antes do acompanhamento (sem o pedido no estado): fica como está, sem erro
VELHO = "erg-" + "fedcba9876543210fedc"
b.perfil_garantir(VELHO, pedido)
p = os.path.join(HOME, "profiles", VELHO, ".ergon-perfil.json")
e = json.loads(open(p, encoding="utf-8").read())
e.pop("pedido", None)
open(p, "w", encoding="utf-8").write(json.dumps(e))
os.utime(os.path.join(HOME, "config.yaml"), ns=(1_900_000_100_000_000_000, 1_900_000_100_000_000_000))
check("perfil de antes: pulado, sem erro", b._perfis_acompanhar() == 1)

# 5. valor com acentos: recusado antes de gravar (o gravador do Hermes tiraria o acento e escreveria qual era no registro)
saida = io.StringIO()
with contextlib.redirect_stderr(saida), contextlib.redirect_stdout(saida):
    try:
        b.chave_guardar("SENHA_TESTE", "abc" + "ção" + "123", "x", "y")
        recusou = False
    except ValueError:
        recusou = True
check("valor com acentos recusado", recusou)
check("nada gravado", "SENHA_TESTE" not in ler(".env") and "SENHA_TESTE" not in ler("profiles", PERFIL, ".env"))
check("nenhum caractere do valor no registro", "ç" not in saida.getvalue() and "ã" not in saida.getvalue(), saida.getvalue()[:200])
try:
    b.chave_guardar("SUDO_PASSWORD", "s3nh" + "á", sudo=True)
    recusou = False
except ValueError:
    recusou = True
check("senha de administrador com acentos também não vai ao cofre", recusou and "SUDO_PASSWORD" not in ler(".env"))

print("TUDO CERTO" if ok else "HOUVE FALHAS")
sys.exit(0 if ok else 1)

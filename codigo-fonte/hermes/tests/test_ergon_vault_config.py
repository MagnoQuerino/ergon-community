"""Migrações de configuração do motor (hermes/vault/ergon-vault.py), dentro da imagem do motor.

Confere: a marca antiga ("1") vale 1 (e o texto puro, no máximo 1); a marca das migrações fica em .ergon-migracoes, e a
antiga (.ergon-config) fica sempre "1", o que o cofre das imagens até a rc.22 entende (numa volta para a imagem anterior,
ele não reaplica nada por cima das escolhas da pessoa); só as migrações que faltam rodam, em ordem, gravando a marca a cada uma; a migração 2
leva as Conexões a um cofre de antes sem desfazer o que a pessoa ligou (Terminal, Executar código) e marca os conjuntos
do plugin como conhecidos (o "desligar" vale e Teams/WhatsApp diretos não ganham as Conexões); known_plugin_toolsets é
sempre unido, nunca trocado; a segunda abertura não chama nada; e nenhuma migração já publicada muda de conteúdo.
Parte com um "config set" simulado (rápido) e parte com o Hermes de verdade ("hermes config set" como o usuário do motor).

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" -v "$PWD/hermes/vault:/v:ro" ergon-hermes:dev \
    /t/test_ergon_vault_config.py

O teste trabalha só numa pasta própria em /tmp, nunca em HERMES_HOME (dentro de um motor ligado, ela é a vista aberta do
cofre da pessoa). A volta para a imagem anterior é conferida com o código antigo de verdade: as cópias congeladas do
ergon-vault.py da rc.22 e da imagem de 30/10 em hermes/tests/fixtures (ERGON_VAULT_ANTIGO troca a lista: caminhos
separados por ":"). Também confere as marcas ilegíveis (vazia, cortada, bytes estranhos: vale a outra marca, e a abertura
do motor não cai) e a falha ao gravar a marca (o motor abre e tenta de novo na próxima vez).
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import types

import hermes_yaml as yaml  # o leitor de YAML do próprio Hermes (em /opt/hermes)

# nunca HERMES_HOME: num motor ligado, ela é a vista aberta do cofre (logins, memória, sessões e skills da pessoa)
HOME = "/tmp/ergon-teste-cofre"
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
os.environ["HERMES_HOME"] = HOME  # o plugin e o Hermes (nos subprocessos) leem daqui
SRC = os.environ.get("ERGON_VAULT_SRC", "/v/ergon-vault.py")
sys.path.insert(0, "/opt/hermes")

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


spec = importlib.util.spec_from_file_location("ergon_vault", SRC)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
v.PLAIN = HOME
logs = []
v.log = lambda msg: (logs.append(msg), print(f"      [ergon-vault] {msg}"))
REAL_AS_HERMES = v.as_hermes

# ---------------------------------------------------------------- 1. migração publicada não muda
# Resumo do conteúdo de cada migração já publicada. Mudou o resumo? NÃO edite a migração: desfaça a mudança e crie a
# migração N+1 (cofres que já receberam a N nunca recebem a mudança). Migração nova: registre o resumo dela aqui.
PUBLICADAS = {
    1: "36853fe35c03de6f9c6d9112316708f2baf9410270b78cb46dd9dece430ec735",  # até a rc.22 (CONFIG_VERSION "1")
    2: "fe37a7964c0e3d1ad2dd7122e5893325e727dd568cc590671078ce9e308649e9",  # rc.24: Conexões e conjuntos conhecidos
}


def resumo(conteudo):
    return hashlib.sha256(json.dumps(conteudo, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


numeros = [n for n, _, _ in v.MIGRACOES]
check("migrações numeradas 1, 2, ... em ordem, sem buraco", numeros == list(range(1, len(numeros) + 1)), str(numeros))
check("CONFIG_VERSION é a última migração", v.CONFIG_VERSION == numeros[-1], str(v.CONFIG_VERSION))
for n, nome, conteudo in v.MIGRACOES:
    if n not in PUBLICADAS:
        check(f"migração {n} ({nome}) registrada no teste", False, f"migração nova: registre PUBLICADAS[{n}] = \"{resumo(conteudo)}\"")
    else:
        check(f"migração {n} ({nome}) igual à publicada", resumo(conteudo) == PUBLICADAS[n],
              f"a migração {n} já foi publicada e mudou: desfaça a mudança e crie a migração {numeros[-1] + 1} (resumo agora: {resumo(conteudo)})")
# A 1 é a configuração que todo cofre com a marca "1" já recebeu (CONFIG_STEPS até a rc.22)
PUBLICADA_ATE_RC22 = [
    ["plugins", "enable", "ergon_bridge"],
    ["config", "set", "platform_toolsets.api_server", '["todo","web","vision","image_gen","skills","ergon_conexoes"]'],
    ["config", "set", "platform_toolsets.teams", '["todo"]'],
    ["config", "set", "platform_toolsets.whatsapp", '["todo"]'],
    ["config", "set", "agent.max_turns", "20"],
    ["config", "set", "agent.reasoning_effort", "low"],
    ["config", "set", "unauthorized_dm_behavior", "ignore"],
]
check("migração 1 = a configuração de antes (marca \"1\")", v.MIGRACOES[0][2] == {"passos": PUBLICADA_ATE_RC22}, str(v.MIGRACOES[0][2]))

# o mesmo conjunto de plugin no cofre e no plugin
sys.path.insert(0, "/p")
import ergon_bridge as plugin  # noqa: E402

# o ponto de entrada do motor roda o cofre com o Python do Hermes, sem /opt/hermes no caminho: o leitor de YAML do Hermes
# tem de vir pelo ambiente dele (a imagem não traz o PyYAML, e o cofre não tem outro leitor)
r = subprocess.run([sys.executable, "-I", "-c", "import hermes_yaml; print(hermes_yaml.__file__)"], capture_output=True, text=True, timeout=60)
check("o leitor de YAML do Hermes carrega como no ponto de entrada (python -I)", r.returncode == 0, (r.stderr or r.stdout)[-300:])

check("conjuntos do plugin iguais no cofre e no plugin", tuple(v.ERGON_PLUGIN_TOOLSETS) == tuple(plugin._ERGON_PLUGIN_TOOLSETS),
      f"{v.ERGON_PLUGIN_TOOLSETS} × {plugin._ERGON_PLUGIN_TOOLSETS}")

# ---------------------------------------------------------------- 2. a marca
check("marca antiga '1' vale 1", v.versao_da_marca("1") == 1 and v.versao_da_marca("1\n") == 1)
check("texto puro vale no máximo 1 ('2' era a configuração inteira, não a migração 2)", v.versao_da_marca("2") == 1 and v.versao_da_marca("0") == 0)
check("marca nova {\"versao\": 2}", v.versao_da_marca('{"versao": 2}') == 2)
check("marca vazia, estranha ou inválida vale 0",
      all(v.versao_da_marca(x) == 0 for x in ("", "lixo", '{"versao": true}', '{"versao": -1}', '{"versao": "2"}', "[2]", "{")))
os.makedirs(HOME, exist_ok=True)
lidas = []
for raw in ("1", "2", '{"versao": 2}', "lixo"):
    with open(os.path.join(HOME, ".ergon-config"), "w", encoding="utf-8") as f:
        f.write(raw)
    lidas.append(plugin._vault_config())
with open(os.path.join(HOME, ".ergon-config"), "w", encoding="utf-8") as f:
    f.write("1")
with open(os.path.join(HOME, ".ergon-migracoes"), "w", encoding="utf-8") as f:
    f.write('{"versao": 2}')
lidas.append(plugin._vault_config())
os.remove(os.path.join(HOME, ".ergon-config"))
os.remove(os.path.join(HOME, ".ergon-migracoes"))
lidas.append(plugin._vault_config())
check("o plugin lê as marcas do mesmo jeito (a das migrações primeiro; sem marca: 0)", lidas == [1, 1, 2, 0, 2, 0], str(lidas))


# ---------------------------------------------------------------- 3. com "config set" simulado
def reset(cfg=None, marca=None, migracoes=None):
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME)
    if cfg is not None:
        with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
            f.write(cfg if isinstance(cfg, str) else yaml.safe_dump(cfg))
    if marca is not None:
        with open(os.path.join(HOME, ".ergon-config"), "w", encoding="utf-8") as f:
            f.write(marca)
    if migracoes is not None:
        with open(os.path.join(HOME, ".ergon-migracoes"), "w", encoding="utf-8") as f:
            f.write(migracoes)
    logs.clear()


def cfg_now():
    p = os.path.join(HOME, "config.yaml")
    return (yaml.safe_load(open(p, encoding="utf-8")) or {}) if os.path.exists(p) else {}


def marca_now():
    """A marca das migrações (.ergon-migracoes)."""
    p = os.path.join(HOME, ".ergon-migracoes")
    return open(p, encoding="utf-8", errors="replace").read() if os.path.exists(p) else None


def marca_json():
    """A marca das migrações já lida como JSON; ilegível ou ausente: None (o teste não cai por ela)."""
    try:
        return json.loads(marca_now())
    except (TypeError, ValueError):
        return None


def marca_antiga():
    p = os.path.join(HOME, ".ergon-config")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else None


# Cópias congeladas do cofre das imagens para onde a volta automática leva (nunca editar: são o código publicado).
# 3010: a imagem de 30/10, em que ficaram os motores nunca renovados (commit 6e0dd7f); rc22: a da rc.22 (1591056).
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
ANTIGOS_CONGELADOS = {
    "ergon-vault-3010.py": "b55cbb9ab6229a9d8551e9246e50679365141622838b47de3ba1d1a5811a817b",
    "ergon-vault-rc22.py": "c80d3e74044c3bb7e7b185d41fdc76a5b7b615824a148507d61fdf018c8da9ee",
}
for nome_antigo, sha_antigo in ANTIGOS_CONGELADOS.items():
    p_antigo = os.path.join(FIXTURES, nome_antigo)
    lido = hashlib.sha256(open(p_antigo, "rb").read()).hexdigest() if os.path.exists(p_antigo) else None
    check(f"cofre antigo congelado {nome_antigo} presente e intacto", lido == sha_antigo, f"resumo {lido}")
ANTIGOS = [x for x in os.environ.get("ERGON_VAULT_ANTIGO", "").split(":") if x] or \
    [os.path.join(FIXTURES, n) for n in ANTIGOS_CONGELADOS]


def rc22_pularia() -> bool:
    """O cofre das imagens antigas (configure_once) não reaplicaria nada? Roda o código antigo de verdade, de cada uma."""
    for antigo in ANTIGOS:
        sp = importlib.util.spec_from_file_location("ergon_vault_antigo", antigo)
        velho = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(velho)
        velho.PLAIN = HOME
        chamadas = []
        velho.as_hermes = lambda args, c=chamadas: (c.append(args), types.SimpleNamespace(returncode=0, stdout=b"", stderr=b""))[1]
        velho.log = lambda msg: None
        velho.configure_once()
        if chamadas:
            print(f"      {os.path.basename(antigo)} reaplicaria: {chamadas}")
            return False
    return True


calls = []
falhar = set()


def fake_as_hermes(args):
    calls.append(list(args))
    rc = 1 if any(a in falhar for a in args) else 0
    if rc == 0 and args[:2] == ["config", "set"]:
        cfg = cfg_now()
        cur = cfg
        partes = args[2].split(".")
        for p in partes[:-1]:
            if not isinstance(cur.get(p), dict):
                cur[p] = {}
            cur = cur[p]
        val = args[3]
        try:
            val = json.loads(val)
        except ValueError:
            pass
        cur[partes[-1]] = val
        with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f)
    return types.SimpleNamespace(returncode=rc, stdout=b"", stderr=b"")


v.as_hermes = fake_as_hermes

DELE = ["code_execution", "image_gen", "skills", "terminal", "todo", "vision", "web"]

# o caso de quem tinha o cofre de antes: marca "1", Terminal e Executar código ligados, sem as Conexões
reset({"platform_toolsets": {"api_server": DELE, "teams": ["todo"], "whatsapp": ["todo"]},
       "known_plugin_toolsets": {"api_server": ["homeassistant"], "telegram": ["spotify"]}, "agent": {"max_turns": 20}}, marca="1")
calls.clear()
check("cofre de antes: configura sem erro", v.configure() is True, str(logs))
c = cfg_now()
check("vai para a versão 2", json.loads(marca_now()) == {"versao": 2}, str(marca_now()))
check("a marca antiga continua '1'", marca_antiga() == "1", str(marca_antiga()))
check("volta para a imagem de antes: o cofre da rc.22 não reaplica nada (Terminal e Executar código ficam)", rc22_pularia())
check("as 7 de antes mais ergon_conexoes", c["platform_toolsets"]["api_server"] == sorted(DELE + ["ergon_conexoes"]), str(c["platform_toolsets"]))
check("known_plugin_toolsets: unido, com o que o Hermes já tinha", c["known_plugin_toolsets"] == {
    "api_server": ["ergon_conexoes", "homeassistant"], "teams": ["ergon_conexoes"], "whatsapp": ["ergon_conexoes"], "telegram": ["spotify"]},
    str(c.get("known_plugin_toolsets")))
check("a migração 1 não roda de novo (nada de plugins enable, max_turns...)",
      not any(x[:2] == ["plugins", "enable"] or "agent.max_turns" in x for x in calls), str(calls))
chaves = [x[2] for x in calls]
check("a lista da plataforma é gravada antes da marca de conhecido",
      chaves == ["platform_toolsets.api_server", "known_plugin_toolsets.api_server", "known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp"], str(chaves))
check("o log diz o que foi aplicado", any("migração 2 aplicada" in m for m in logs), str(logs))
calls.clear()
check("segunda abertura: nada a fazer", v.configure() is True)
check("segunda abertura: nenhum passo chamado", calls == [], str(calls))

# cofre novo: as duas migrações, em ordem; a 2 já encontra as Conexões na lista e só marca os conhecidos
reset()
calls.clear()
check("cofre novo: configura", v.configure() is True, str(logs))
check("cofre novo: versão 2", json.loads(marca_now()) == {"versao": 2})
check("cofre novo: a marca antiga '1' (a imagem de antes não reaplica nada)", marca_antiga() == "1" and rc22_pularia(), str(marca_antiga()))
check("cofre novo: a migração 1 inteira, depois só as marcas de conhecido",
      calls[:7] == PUBLICADA_ATE_RC22 and [x[2] for x in calls[7:]] == ["known_plugin_toolsets.api_server", "known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp"],
      str(calls))

# progresso parcial: a 2 falha no meio; a marca fica na 1 e a próxima abertura recomeça da 2 (sem repetir a 1)
reset()
falhar.add("known_plugin_toolsets.teams")
calls.clear()
check("falha no meio: configure avisa", v.configure() is False)
check("falha no meio: a marca fica na 1", json.loads(marca_now()) == {"versao": 1}, str(marca_now()))
check("falha no meio: o log diz onde parou", any("parou na migração 2" in m for m in logs), str(logs))
falhar.clear()
calls.clear()
check("próxima abertura: termina", v.configure() is True and json.loads(marca_now()) == {"versao": 2})
check("próxima abertura: só o que faltou da 2", [x[2] for x in calls] == ["known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp"], str(calls))

# a falha da lista da plataforma para tudo: a marca de conhecido sozinha desligaria as Conexões
reset({"platform_toolsets": {"api_server": DELE}}, marca="1")
falhar.add("platform_toolsets.api_server")
calls.clear()
check("lista da plataforma falhou: nada de marca de conhecido", v.configure() is False and "known_plugin_toolsets" not in cfg_now(), str(cfg_now()))
falhar.clear()

# lista gravada como texto por versões antigas do "config set"; lista ausente; config.yaml ilegível; marca mais nova
reset({"platform_toolsets": {"api_server": '["todo", "web", "terminal"]'}}, marca="1")
v.configure()
check("lista em texto: lida e unida", cfg_now()["platform_toolsets"]["api_server"] == ["ergon_conexoes", "terminal", "todo", "web"], str(cfg_now()))
reset({"agent": {"max_turns": 20}}, marca="1")
v.configure()
check("lista ausente: o conjunto padrão do Ergon", cfg_now()["platform_toolsets"]["api_server"] == sorted(v.API_TOOLSETS_PADRAO), str(cfg_now()))
reset("platform_toolsets: [nao fechado\n", marca="1")
calls.clear()
check("config.yaml ilegível: não grava nada e tenta de novo depois", v.configure() is False and calls == [] and marca_now() is None and marca_antiga() == "1",
      str((calls, marca_now(), marca_antiga())))
reset({}, marca="1", migracoes='{"versao": 99}')
calls.clear()
check("marca mais nova que a imagem: nada a aplicar", v.configure() is True and calls == [], str(calls))

# marca das migrações ilegível (arquivo novo da rc.24: uma queda logo depois de criá-lo pode deixá-lo vazio ou cortado):
# vale a marca antiga "1" ao lado; só a migração 2 roda, e Terminal e Executar código continuam ligados
for rotulo, migr in (("vazia", b""), ("JSON cortado", b'{"vers'), ("versão em texto", b'{"versao": "2"}'), ("bytes estranhos", b"\xff\xfe\x00{")):
    reset({"platform_toolsets": {"api_server": DELE}}, marca="1")
    with open(os.path.join(HOME, ".ergon-migracoes"), "wb") as f:
        f.write(migr)
    check(f"o plugin lê igual: marca das migrações {rotulo} e a antiga '1' vale 1", plugin._vault_config() == 1, str(plugin._vault_config()))
    calls.clear()
    try:
        lida, res = v.ler_marca(), v.configure()
    except Exception as exc:  # noqa: BLE001
        lida, res = f"{type(exc).__name__}: {exc}", None
    check(f"marca das migrações {rotulo} e a antiga '1': vale 1", lida == 1, str(lida))
    check(f"marca das migrações {rotulo}: só a migração 2 (Terminal e Executar código ficam)",
          res is True and not any(x[:2] == ["plugins", "enable"] or "agent.max_turns" in x for x in calls)
          and cfg_now()["platform_toolsets"]["api_server"] == sorted(DELE + ["ergon_conexoes"])
          and marca_json() == {"versao": 2},
          str((res, calls, cfg_now(), marca_now())))
# só a marca antiga, com bytes estranhos: o configure não cai (aplica desde a primeira, como sem marca)
reset({}, marca="1")
with open(os.path.join(HOME, ".ergon-config"), "wb") as f:
    f.write(b"\xff\xfe1")
check("o plugin não cai com a marca antiga de bytes estranhos (vale 0)", plugin._vault_config() == 0, str(plugin._vault_config()))
calls.clear()
try:
    res = v.configure()
except Exception as exc:  # noqa: BLE001
    res = f"{type(exc).__name__}: {exc}"
check("marca antiga com bytes estranhos: configura sem cair", res is True and marca_json() == {"versao": 2}, str(res))

# a marca é gravada até o disco (fsync) antes de trocar o nome
reset({}, marca="1")
sincronizados, os_fsync = [], os.fsync
os.fsync = lambda fd: (sincronizados.append(fd), os_fsync(fd))[1]
try:
    v._gravar(".ergon-migracoes", '{"versao": 1}')
finally:
    os.fsync = os_fsync
check("a marca vai até o disco (fsync) antes de trocar o nome", len(sincronizados) >= 1 and marca_json() == {"versao": 1}, str(sincronizados))

# gravar a marca falha (disco cheio): o configure avisa, não cai, e não deixa o temporário; a próxima abertura recomeça
reset({"platform_toolsets": {"api_server": DELE}}, marca="1")
os_replace = os.replace


def disco_cheio(_a, _b):
    raise OSError(28, "No space left on device")


os.replace = disco_cheio
calls.clear()
try:
    res = v.configure()
except Exception as exc:  # noqa: BLE001
    res = f"{type(exc).__name__}: {exc}"
finally:
    os.replace = os_replace
check("gravar a marca falhou: configure avisa sem cair", res is False, str(res))
check("gravar a marca falhou: nada de temporário largado", not any(n.endswith(".tmp") for n in os.listdir(HOME)), str(os.listdir(HOME)))
check("gravar a marca falhou: o log diz que tenta de novo", any("próxima abertura" in m for m in logs), str(logs))
calls.clear()
check("depois do disco cheio: a próxima abertura termina", v.configure() is True and marca_json() == {"versao": 2}, str(marca_now()))

# a abertura do cofre não cai por causa da configuração: só um erro de montagem impede o motor de abrir
cofre_teste = HOME + "-lado-cifrado"
shutil.rmtree(cofre_teste, ignore_errors=True)
os.makedirs(cofre_teste)
open(os.path.join(cofre_teste, "gocryptfs.conf"), "w").close()
reset({}, marca="1")
guardados = {k: getattr(v, k) for k in ("VAULT", "LEGACY", "PLUGIN_SRC", "gocryptfs", "own_vault", "ensure_api_key", "configure", "enforce_safety")}


def explode(*_a, **_k):
    raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


v.VAULT, v.LEGACY, v.PLUGIN_SRC = cofre_teste, HOME + "-sem-legado", HOME + "-sem-plugin"
v.gocryptfs = lambda *_a, **_k: (0, "")
v.own_vault = lambda: 0
v.ensure_api_key = lambda: None
v.configure = explode
v.enforce_safety = explode
try:
    v.open_vault("a" * 64)
    res = True
except Exception as exc:  # noqa: BLE001
    res = f"{type(exc).__name__}: {exc}"
check("configuração e travas com erro: o cofre abre mesmo assim (o motor sobe)", res is True, str(res))
check("configuração e travas com erro: o log diz que tenta de novo", sum("próxima abertura" in m for m in logs) >= 2, str(logs))
v.gocryptfs = lambda *_a, **_k: (12, "")
try:
    v.open_vault("a" * 64)
    res = "abriu"
except RuntimeError as exc:
    res = str(exc)
check("chave errada continua impedindo a abertura", res == "chave do cofre não confere", str(res))
for k, val in guardados.items():
    setattr(v, k, val)
shutil.rmtree(cofre_teste, ignore_errors=True)
reset()  # a abertura gravou a marca de cofre (.ergon-vault) na pasta do teste: some aqui

# ---------------------------------------------------------------- 4. com o Hermes de verdade
real_calls = []


def contar(args):
    real_calls.append(list(args))
    r = REAL_AS_HERMES(args)
    if r.returncode != 0:
        print(f"      hermes {' '.join(args[:3])} → {r.returncode}: {(r.stderr or r.stdout).decode(errors='replace')[-300:]}")
    return r


v.as_hermes = contar


def preparar(cfg=None, marca=None):
    reset(cfg, marca)
    shutil.copytree("/p/ergon_bridge", os.path.join(HOME, "plugins", "ergon_bridge"))
    subprocess.run(["chown", "-R", f"{v.HERMES_UID}:{v.HERMES_UID}", HOME], check=True)


def ferramentas(plataforma):
    """O que o Hermes liga na plataforma, lido num processo novo (sem cache), com o plugin carregado."""
    codigo = ("import sys, json; sys.path.insert(0, '/opt/hermes'); from hermes_cli.plugins import discover_plugins; discover_plugins(); "
              "from hermes_cli.config import load_config; from hermes_cli.tools_config import _get_platform_tools; "
              f"print(json.dumps(sorted(_get_platform_tools(load_config(), {plataforma!r}, include_default_mcp_servers=False))))")
    r = subprocess.run([sys.executable, "-c", codigo], capture_output=True, text=True, timeout=120,
                       user=v.HERMES_UID, group=v.HERMES_UID, extra_groups=[], env={**os.environ, "HOME": HOME})
    try:
        return set(json.loads(r.stdout.strip().splitlines()[-1]))
    except Exception:  # noqa: BLE001
        print(f"      falhou ao ler as ferramentas: {r.stderr[-500:]}")
        return set()


preparar()
check("Hermes de verdade, cofre novo: configura", v.configure() is True, str(logs))
check("Hermes de verdade, cofre novo: versão 2", json.loads(marca_now()) == {"versao": 2}, str(marca_now()))
check("Hermes de verdade: as travas de sempre também", v.enforce_safety() is True)
api, teams, wa = ferramentas("api_server"), ferramentas("teams"), ferramentas("whatsapp")
check("API: as Conexões ligadas", "ergon_conexoes" in api, str(api))
check("Teams direto: sem as Conexões", "ergon_conexoes" not in teams and "todo" in teams, str(teams))
check("WhatsApp direto: sem as Conexões", "ergon_conexoes" not in wa and "todo" in wa, str(wa))

preparar({"plugins": {"enabled": ["ergon_bridge"]},
          "platform_toolsets": {"api_server": DELE, "teams": ["todo"], "whatsapp": ["todo"]},
          "known_plugin_toolsets": {"api_server": ["homeassistant"]},
          "agent": {"max_turns": 20}, "tools": {"tool_search": {"enabled": "off"}}}, marca="1")
real_calls.clear()
check("Hermes de verdade, cofre de antes: configura", v.configure() is True, str(logs))
c = cfg_now()
check("Hermes de verdade: as 7 de antes mais ergon_conexoes, como lista", c["platform_toolsets"]["api_server"] == sorted(DELE + ["ergon_conexoes"]), str(c["platform_toolsets"]))
check("Hermes de verdade: known unido", c["known_plugin_toolsets"]["api_server"] == ["ergon_conexoes", "homeassistant"]
      and c["known_plugin_toolsets"]["teams"] == ["ergon_conexoes"], str(c.get("known_plugin_toolsets")))
api = ferramentas("api_server")
check("Hermes de verdade: Conexões, Terminal e Executar código ligados na API", {"ergon_conexoes", "terminal", "code_execution"} <= api, str(api))
check("Hermes de verdade: Teams sem as Conexões", "ergon_conexoes" not in ferramentas("teams"))
real_calls.clear()
check("Hermes de verdade, segunda abertura: nenhum passo chamado", v.configure() is True and real_calls == [], str(real_calls))

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

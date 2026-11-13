"""Migrações de configuração do motor (hermes/vault/ergon-vault.py), dentro da imagem do motor.

Confere: a marca antiga ("1") vale 1 (e o texto puro, no máximo 1); a marca das migrações fica em .ergon-migracoes, e a
antiga (.ergon-config) fica sempre "1", o que o cofre das imagens até a rc.22 entende (numa volta para a imagem anterior,
ele não reaplica nada por cima das escolhas da pessoa); só as migrações que faltam rodam, em ordem, gravando a marca a cada uma; a migração 2
leva as Conexões a um cofre de antes sem desfazer o que a pessoa ligou (Terminal, Executar código) e marca os conjuntos
do plugin como conhecidos (o "desligar" vale e Teams/WhatsApp diretos não ganham as Conexões); known_plugin_toolsets é
sempre unido, nunca trocado; a migração 3 liga a compactação da conversa mais cedo (compression.threshold_tokens) só onde
ninguém escolheu nada (um valor gravado, inclusive null, fica); a segunda abertura não chama nada; e nenhuma migração já
publicada muda de conteúdo.
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
    3: "edba80be061bbfe9864ec3b095bc8ee738df11e6fb7a409e8769d68e8ace69a3",  # rc.25: compactação da conversa (teto de 150 mil)
    # rc.27 (as frentes nasceram em paralelo com números provisórios; a junção renumerou em sequência: o resumo não muda)
    4: "4d8ead14e024e8d365653aeb31e6a4c913e1ec8a762335c35a2ee0895ebb1f62",  # equipe nativa (gateway.multiplex_profiles)
    5: "e6a856115783f26115a5f2b6428a57ce7f83a7a354fc5ebcc562de375030a78d",  # Curator desligado, anotação de memória ligada (sem a revisão de competências), não treinar com os dados, segredos mascarados
    6: "bcd3196bec23954362c16cd06596e8fc644c4a587031267af93a1cb6c1379568",  # cartões: conjunto ergon_cartoes
    7: "a7b1ab326b05314ae2433706b7c352098d25d6b1dc4f104ca78060af68080732",  # proteções do terminal (checkpoints e aviso de código inseguro) e a limpeza dos arquivos temporários
    8: "dcb04c1aa49dd525e46103165390edbce357f589f6525b2e901713a3b24d9ce0",  # canais: Telegram entrega o que chegou com o Ergon fechado
    9: "9d03eb25994ce91d2c287bf9efa1c11775c881317a4910e6736b3e130d36af0b",  # aprovações nativas: o modo manual (sem a chamada a mais ao modelo) e o prazo de 5 min
    10: "58919bde6cadbd978b1d7fc84ae6bca03c1991262a9e343cae91a8fb90740083",  # experiência completa: passos 20→90, raciocínio low→high, aviso antes do teto, leitura de páginas, navegador/vídeo/arquivos/voz
}


def resumo(conteudo):
    return hashlib.sha256(json.dumps(conteudo, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


numeros = [n for n, _, _ in v.MIGRACOES]
check("migrações numeradas 1, 2, ... em ordem, sem buraco", numeros == list(range(1, len(numeros) + 1)), str(numeros))
ULTIMA = numeros[-1]


def chaves_da(conteudo, troca=True):
    """O que uma migração chama num cofre onde nada dela existe ainda, na ordem de aplicar(): se_ausente, trocar_se (só num
    cofre com o valor antigo: troca=True), passos, unir (a chave do "config set", ou o nome do plugin do "plugins enable")."""
    return ([c for c, _ in conteudo.get("se_ausente", [])] + ([c for c, _a, _n in conteudo.get("trocar_se", [])] if troca else [])
            + [p[2] for p in conteudo.get("passos", [])] + [c for c, _a, _b in conteudo.get("unir", [])])


MIG = {n: conteudo for n, _, conteudo in v.MIGRACOES}
# o que as migrações depois da 3 chamam num cofre que acabou de receber a 1, a 2 e a 3
DEPOIS_DA_3 = [chave for n, _, conteudo in v.MIGRACOES if n > 3 for chave in chaves_da(conteudo)]
# o mesmo, num cofre sem os valores da migração 1 (nada a trocar)
DEPOIS_DA_3_SEM_TROCA = [chave for n, _, conteudo in v.MIGRACOES if n > 3 for chave in chaves_da(conteudo, troca=False)]
# trocar_se só troca o que uma migração publicada gravou, com o valor exato dela (o que alguém mudou fica)
_gravado_pela_1 = {p[2]: p[3] for p in MIG[1]["passos"] if p[:2] == ["config", "set"]}
check("trocar_se: só chaves soltas da migração 1, com o valor que ela gravou",
      all(_gravado_pela_1.get(c) == antigo and novo != antigo for n in MIG for c, antigo, novo in MIG[n].get("trocar_se", [])),
      str({n: MIG[n].get("trocar_se") for n in MIG if MIG[n].get("trocar_se")}))
check("CONFIG_VERSION é a última migração", v.CONFIG_VERSION == numeros[-1], str(v.CONFIG_VERSION))
# Cada migração mexe nas próprias chaves: nenhuma regrava o que outra grava (a 6 e a 2 unem na mesma lista da API, por
# união, sem trocar o que a outra pôs; e nenhuma depois da 3 regrava as chaves soltas da 1 ou da 3)
_soltas = {n: set(c for c, _ in MIG[n].get("se_ausente", [])) | set(p[2] for p in MIG[n].get("passos", []) if p[:2] == ["config", "set"]) for n in MIG}
_pisadas = [(a, b, _soltas[a] & _soltas[b]) for a in MIG for b in MIG if a < b and _soltas[a] & _soltas[b]]
check("nenhuma migração regrava a chave solta de outra", _pisadas == [], str(_pisadas))
check("as migrações da rc.27 (4 em diante) só acrescentam: se_ausente, troca do valor que ninguém mudou, união, ou chave nova",
      all(set(MIG[n]) <= {"se_ausente", "trocar_se", "passos", "unir"} for n in MIG if n > 3)
      and all(p[:2] in (["config", "set"], ["plugins", "enable"]) for n in MIG if n > 3 for p in MIG[n].get("passos", [])), str({n: MIG[n] for n in MIG if n > 3}))
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
# rc.25: os passos por pedido são escolha da pessoa (ponte de controle, /ergon/v1/passos); a trava de toda abertura não os
# regrava mais (antes: 20 a cada abertura, por cima da escolha). A busca de ferramentas continua desligada a cada abertura.
check("travas de toda abertura: não regravam os passos por pedido", not any("agent.max_turns" in passo for passo in v.ENFORCED_STEPS), str(v.ENFORCED_STEPS))
# rc.27: a busca de ferramentas continua desligada a cada abertura, a menos que haja um conector pronto (MCP) ligado
check("travas de toda abertura: aprovação do Treinar; a busca de ferramentas desligada é condicional",
      ["config", "set", "skills.write_approval", "true"] in v.ENFORCED_STEPS and v.BUSCA_DESLIGADA == ["config", "set", "tools.tool_search.enabled", "off"]
      and v.BUSCA_DESLIGADA not in v.ENFORCED_STEPS, str(v.ENFORCED_STEPS))

# o mesmo conjunto de plugin no cofre e no plugin
sys.path.insert(0, "/p")
import ergon_bridge as plugin  # noqa: E402

# o ponto de entrada do motor roda o cofre com o Python do Hermes, sem /opt/hermes no caminho: o leitor de YAML do Hermes
# tem de vir pelo ambiente dele (a imagem não traz o PyYAML, e o cofre não tem outro leitor)
r = subprocess.run([sys.executable, "-I", "-c", "import hermes_yaml; print(hermes_yaml.__file__)"], capture_output=True, text=True, timeout=60)
check("o leitor de YAML do Hermes carrega como no ponto de entrada (python -I)", r.returncode == 0, (r.stderr or r.stdout)[-300:])

LIMITE = int(dict(v.MIGRACOES[2][2]["se_ausente"])["compression.threshold_tokens"])
check("migração 3: o limite da compactação é o mesmo do plugin (COMPACTAR_LIMITE)", LIMITE == getattr(plugin, "COMPACTAR_LIMITE", None) == 150000,
      f"{LIMITE} × {getattr(plugin, 'COMPACTAR_LIMITE', None)}")

_troca10 = {c: (a, n) for c, a, n in MIG[10]["trocar_se"]}
check("migração 10: os passos por pedido vão ao padrão do plugin (PASSOS_PADRAO), dentro do teto (PASSOS_MAX)",
      int(_troca10["agent.max_turns"][1]) == getattr(plugin, "PASSOS_PADRAO", None) <= getattr(plugin, "PASSOS_MAX", 0), str(_troca10))
check("migração 10: o raciocínio vai ao padrão do plugin (RACIOCINIO_PADRAO), um dos níveis que a tela oferece",
      _troca10["agent.reasoning_effort"][1] == getattr(plugin, "RACIOCINIO_PADRAO", None) and _troca10["agent.reasoning_effort"][1] in plugin.RACIOCINIO_NIVEIS, str(_troca10))
check("conjuntos do plugin iguais no cofre e no plugin", tuple(v.ERGON_PLUGIN_TOOLSETS) == tuple(plugin._ERGON_PLUGIN_TOOLSETS),
      f"{v.ERGON_PLUGIN_TOOLSETS} × {plugin._ERGON_PLUGIN_TOOLSETS}")

# As seções 2 a 4 conferem as migrações 1 a 3, com as contas exatas de cada uma (o que cada abertura grava e o que não
# grava). As migrações da rc.27 (4 a 10) têm seções próprias, com todas ligadas de novo: 3b (simulado) e 5 (Hermes de verdade).
TODAS_AS_MIGRACOES = v.MIGRACOES
v.MIGRACOES = tuple(m for m in TODAS_AS_MIGRACOES if m[0] <= 3)
v.CONFIG_VERSION = 3

# ---------------------------------------------------------------- 2. a marca
check("marca antiga '1' vale 1", v._versao_legivel("1") == 1 and v._versao_legivel("1\n") == 1)
check("texto puro vale no máximo 1 ('2' era a configuração inteira, não a migração 2)", v._versao_legivel("2") == 1 and v._versao_legivel("0") == 0)
check("marca nova {\"versao\": 2}", v._versao_legivel('{"versao": 2}') == 2)
check("marca vazia, estranha ou inválida não é legível (None)",
      all(v._versao_legivel(x) is None for x in ("", "lixo", '{"versao": true}', '{"versao": -1}', '{"versao": "2"}', "[2]", "{")))
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
check("vai para a versão 3", json.loads(marca_now()) == {"versao": 3}, str(marca_now()))
check("a marca antiga continua '1'", marca_antiga() == "1", str(marca_antiga()))
check("volta para a imagem de antes: o cofre da rc.22 não reaplica nada (Terminal e Executar código ficam)", rc22_pularia())
check("as 7 de antes mais ergon_conexoes", c["platform_toolsets"]["api_server"] == sorted(DELE + ["ergon_conexoes"]), str(c["platform_toolsets"]))
check("known_plugin_toolsets: unido, com o que o Hermes já tinha", c["known_plugin_toolsets"] == {
    "api_server": ["ergon_conexoes", "homeassistant"], "teams": ["ergon_conexoes"], "whatsapp": ["ergon_conexoes"], "telegram": ["spotify"]},
    str(c.get("known_plugin_toolsets")))
check("a migração 1 não roda de novo (nada de plugins enable, max_turns...)",
      not any(x[:3] == ["plugins", "enable", "ergon_bridge"] or "agent.max_turns" in x for x in calls), str(calls))
chaves = [x[2] for x in calls]
check("a lista da plataforma é gravada antes da marca de conhecido",
      chaves == ["platform_toolsets.api_server", "known_plugin_toolsets.api_server", "known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp",
                "compression.threshold_tokens"], str(chaves))
check("migração 3: compactação mais cedo no cofre de antes", c.get("compression", {}).get("threshold_tokens") == 150000, str(c.get("compression")))
check("o log diz o que foi aplicado", any("migração 2 aplicada" in m for m in logs) and any("migração 3 aplicada" in m for m in logs), str(logs))
calls.clear()
check("segunda abertura: nada a fazer", v.configure() is True)
check("segunda abertura: nenhum passo chamado", calls == [], str(calls))

# cofre novo: as duas migrações, em ordem; a 2 já encontra as Conexões na lista e só marca os conhecidos
reset()
calls.clear()
check("cofre novo: configura", v.configure() is True, str(logs))
check("cofre novo: versão 3", json.loads(marca_now()) == {"versao": 3})
check("cofre novo: a marca antiga '1' (a imagem de antes não reaplica nada)", marca_antiga() == "1" and rc22_pularia(), str(marca_antiga()))
check("cofre novo: a migração 1 inteira, depois só as marcas de conhecido e a compactação",
      calls[:7] == PUBLICADA_ATE_RC22 and [x[2] for x in calls[7:]] == ["known_plugin_toolsets.api_server", "known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp",
                                                                       "compression.threshold_tokens"],
      str(calls))
check("cofre novo: compactação com o limite de 150 mil", cfg_now()["compression"]["threshold_tokens"] == 150000, str(cfg_now().get("compression")))

# progresso parcial: a 2 falha no meio; a marca fica na 1 e a próxima abertura recomeça da 2 (sem repetir a 1)
reset()
falhar.add("known_plugin_toolsets.teams")
calls.clear()
check("falha no meio: configure avisa", v.configure() is False)
check("falha no meio: a marca fica na 1", json.loads(marca_now()) == {"versao": 1}, str(marca_now()))
check("falha no meio: o log diz onde parou", any("parou na migração 2" in m for m in logs), str(logs))
falhar.clear()
calls.clear()
check("próxima abertura: termina", v.configure() is True and json.loads(marca_now()) == {"versao": 3})
check("próxima abertura: só o que faltou da 2, e a 3", [x[2] for x in calls] == ["known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp", "compression.threshold_tokens"], str(calls))

# migração 3: só onde ninguém escolheu. Um limite gravado (por alguém ou pela tela) e o null (o "desligado" da tela: só o
# limite do próprio Hermes, perto do fim da janela) ficam; o resto da seção também
for rotulo, comp, depois in (("limite de 80 mil gravado", {"threshold_tokens": 80000}, 80000),
                             ("desligado (null)", {"threshold_tokens": None}, None),
                             ("seção sem o limite", {"enabled": False, "threshold": 0.6}, 150000)):
    reset({"platform_toolsets": {"api_server": DELE}, "compression": comp}, migracoes='{"versao": 2}')
    calls.clear()
    res = v.configure()
    c3 = cfg_now().get("compression") or {}
    check(f"migração 3, {rotulo}: o limite fica {depois}", res is True and "threshold_tokens" in c3 and c3["threshold_tokens"] == depois
          and json.loads(marca_now()) == {"versao": 3}, str((res, c3, calls)))
    check(f"migração 3, {rotulo}: o resto da seção não muda", {k: c3.get(k) for k in comp if k != "threshold_tokens"} == {k: x for k, x in comp.items() if k != "threshold_tokens"}, str(c3))
    check(f"migração 3, {rotulo}: só ela roda", [x[2] for x in calls] == ([] if "threshold_tokens" in comp else ["compression.threshold_tokens"]), str(calls))
reset({}, migracoes='{"versao": 2}')
falhar.add("compression.threshold_tokens")
check("migração 3 falhou: a marca fica na 2 e tenta de novo depois", v.configure() is False and json.loads(marca_now()) == {"versao": 2}, str(marca_now()))
falhar.clear()

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
try:
    v.aplicar({"se_ausente": [], "apagar": ["x"]})
    res13 = "aplicou"
except ValueError:
    res13 = "recusou"
check("migração com parte desconhecida é recusada", res13 == "recusou", res13)
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
    check(f"marca das migrações {rotulo}: só as migrações 2 e 3 (Terminal e Executar código ficam)",
          res is True and not any(x[:3] == ["plugins", "enable", "ergon_bridge"] or "agent.max_turns" in x for x in calls)
          and cfg_now()["platform_toolsets"]["api_server"] == sorted(DELE + ["ergon_conexoes"])
          and marca_json() == {"versao": 3},
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
check("marca antiga com bytes estranhos: configura sem cair", res is True and marca_json() == {"versao": 3}, str(res))

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
check("depois do disco cheio: a próxima abertura termina", v.configure() is True and marca_json() == {"versao": 3}, str(marca_now()))

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

# ---------------------------------------------------------------- 3b. as migrações da rc.27 (4 a 10), "config set" simulado
v.MIGRACOES, v.CONFIG_VERSION = TODAS_AS_MIGRACOES, ULTIMA
reset()
calls.clear()
check("rc.27, cofre novo: configura até a última", v.configure() is True and json.loads(marca_now()) == {"versao": ULTIMA}, str(logs[-3:]))
check("rc.27, cofre novo: a 1, a 2 e a 3 como antes, depois cada migração nova uma vez, em ordem",
      calls[:7] == PUBLICADA_ATE_RC22 and [x[2] for x in calls[7:]] == ["known_plugin_toolsets.api_server", "known_plugin_toolsets.teams", "known_plugin_toolsets.whatsapp",
                                                                       "compression.threshold_tokens"] + DEPOIS_DA_3, str(calls))
_c = cfg_now()
check("rc.27, cofre novo: a equipe nativa ligada (migração 4)", (_c.get("gateway") or {}).get("multiplex_profiles") is True, str(_c.get("gateway")))
check("rc.27, cofre novo: os cartões na API e conhecidos nas três plataformas, fora de Teams e WhatsApp diretos (migração 6)",
      "ergon_cartoes" in _c["platform_toolsets"]["api_server"] and "ergon_conexoes" in _c["platform_toolsets"]["api_server"]
      and all("ergon_cartoes" in _c["known_plugin_toolsets"][p] for p in ("api_server", "teams", "whatsapp"))
      and "ergon_cartoes" not in _c["platform_toolsets"]["teams"] + _c["platform_toolsets"]["whatsapp"], str(_c))
check("rc.27, cofre novo: Telegram entrega o que chegou com o Ergon fechado (migração 8)",
      _c.get("platforms", {}).get("telegram", {}).get("extra", {}).get("drop_pending_on_cold_boot") is False, str(_c.get("platforms")))
check("rc.27, cofre novo: aprovações pela pessoa, sem a chamada a mais ao modelo, com o turno esperando 5 min (migração 9)",
      (_c.get("approvals") or {}).get("mode") == "manual" and str((_c.get("approvals") or {}).get("timeout")) == "300", str(_c.get("approvals")))
NOVAS_DA_10 = {"browser", "file", "tts", "video"}
check("rc.27, cofre novo: a experiência completa (migração 10): 90 passos, raciocínio alto, aviso perto do teto, leitura de páginas",
      _c["agent"]["max_turns"] == 90 and _c["agent"]["reasoning_effort"] == "high" and _c["agent"]["budget_warning_ratio"] == 0.75
      and _c["web"]["extract_backend"] == "exa", str((_c.get("agent"), _c.get("web"))))
check("rc.27, cofre novo: navegador, vídeo, arquivos e voz ligados na API; busca no X e criar vídeos ficam (precisam de chave)",
      NOVAS_DA_10 <= set(_c["platform_toolsets"]["api_server"]) and not {"x_search", "video_gen"} & set(_c["platform_toolsets"]["api_server"])
      and not NOVAS_DA_10 & set(_c["platform_toolsets"]["teams"] + _c["platform_toolsets"]["whatsapp"]), str(_c["platform_toolsets"]))
check("rc.27, cofre novo: a anotação de memória ligada e a revisão de competências de fora (migração 5)",
      _c["auxiliary"]["background_review"]["enabled"] is True and _c["skills"]["creation_nudge_interval"] == 0 and _c["curator"]["enabled"] is False,
      str((_c.get("auxiliary"), _c.get("skills"))))
check("rc.27, cofre novo: a limpeza dos arquivos temporários ligada (migração 7)", ["plugins", "enable", "disk-cleanup"] in calls, str(calls))
calls.clear()
check("rc.27, segunda abertura: nada", v.configure() is True and calls == [], str(calls))

# padrões seguros, cartões, proteções e canais: só onde ninguém escolheu — o que a pessoa ligou ou desligou fica como está
ESCOLHIDO = {"platform_toolsets": {"api_server": DELE + ["ergon_cartoes"]},
             "known_plugin_toolsets": {"api_server": ["ergon_cartoes"], "teams": ["ergon_cartoes"], "whatsapp": ["ergon_cartoes"]},
             "curator": {"enabled": True, "interval_hours": 24}, "auxiliary": {"background_review": {"enabled": True}},
             "provider_routing": {"data_collection": "allow", "sort": "price"}, "security": {"redact_secrets": True},
             "checkpoints": {"enabled": False}, "platforms": {"telegram": {"extra": {"drop_pending_on_cold_boot": True}}},
             "approvals": {"mode": "smart", "timeout": 120},
             "skills": {"creation_nudge_interval": 5},
             "agent": {"max_turns": 33, "reasoning_effort": "medium", "budget_warning_ratio": 0.5}, "web": {"extract_backend": "firecrawl"}}
reset(ESCOLHIDO, migracoes='{"versao": 3}')
calls.clear()
check("rc.27, tudo já escolhido: só a chave da equipe nativa, os plugins das proteções e a união das ferramentas novas",
      v.configure() is True and calls[:3] == [["config", "set", "gateway.multiplex_profiles", "true"], ["plugins", "enable", "security-guidance"], ["plugins", "enable", "disk-cleanup"]]
      and [x[2] for x in calls[3:]] == ["platform_toolsets.api_server"] and json.loads(marca_now()) == {"versao": ULTIMA}, str(calls))
_c = cfg_now()
check("rc.27, tudo já escolhido: as escolhas ficam (arrumar competências, treino permitido, revisão de fundo, voltar atrás, fila do Telegram, passos, raciocínio, leitura de páginas)",
      all(_c[k] == ESCOLHIDO[k] for k in ("curator", "auxiliary", "provider_routing", "security", "checkpoints", "platforms", "known_plugin_toolsets", "approvals", "skills", "agent", "web"))
      and _c["platform_toolsets"]["api_server"] == sorted(set(ESCOLHIDO["platform_toolsets"]["api_server"]) | NOVAS_DA_10), str(_c))
reset({"platform_toolsets": {"api_server": DELE}}, migracoes='{"versao": 3}')
calls.clear()
check("rc.27, cofre na 3 sem escolha: cada migração nova uma vez, em ordem (nada a trocar: o cofre não tem os valores da 1)",
      v.configure() is True and [x[2] for x in calls] == DEPOIS_DA_3_SEM_TROCA, str(calls))
check("padrões da rc.27 (migração 5): Curator desligado, anotação de memória ligada sem a revisão de competências, não treinar, segredos mascarados",
      [x[3] for x in calls if x[2] in chaves_da(MIG[5])] == ["false", "true", "0", "deny", "true"], str(calls))
check("cartões (migração 6) e ferramentas novas (migração 10): unidos ao que a pessoa ligou (Terminal e Executar código ficam)",
      cfg_now()["platform_toolsets"]["api_server"] == sorted(set(DELE + ["ergon_cartoes"]) | NOVAS_DA_10), str(cfg_now()))
calls.clear()
check("rc.27, cofre na 3, segunda abertura: nada", v.configure() is True and calls == [], str(calls))
reset({}, migracoes='{"versao": 3}')
falhar.add("security-guidance")
check("migração 7 falhou no plugin: a marca fica na 6 e tenta de novo depois", v.configure() is False and json.loads(marca_now()) == {"versao": 6}, str(marca_now()))
falhar.clear()
calls.clear()
# a parte "se_ausente" da 7 já ficou gravada na primeira tentativa: de novo, só o plugin (idempotente), depois a 8
check("migração 7 falhou: a próxima abertura recomeça dela (o que faltou da 7 e as seguintes, nada antes)",
      v.configure() is True and [x[2] for x in calls] == ["security-guidance", "disk-cleanup"] + [c for n in sorted(MIG) if n > 7 for c in chaves_da(MIG[n], troca=False)] and json.loads(marca_now()) == {"versao": ULTIMA}
      and cfg_now()["checkpoints"]["enabled"] is True, str(calls))
# migração 10, trocar_se: só o valor que a migração 1 gravou e ninguém mudou é trocado (também o "20" em texto)
for rotulo, agente, depois in (("os valores da migração 1", {"max_turns": 20, "reasoning_effort": "low"}, {"max_turns": 90, "reasoning_effort": "high"}),
                               ("20 gravado como texto", {"max_turns": "20", "reasoning_effort": "low"}, {"max_turns": 90, "reasoning_effort": "high"}),
                               ("escolhidos pela pessoa", {"max_turns": 33, "reasoning_effort": "medium"}, {"max_turns": 33, "reasoning_effort": "medium"}),
                               ("sem limite (null) e o padrão do modelo", {"max_turns": None, "reasoning_effort": ""}, {"max_turns": None, "reasoning_effort": ""}),
                               ("ausentes", {}, {})):
    reset({"platform_toolsets": {"api_server": ["todo", "terminal"]}, "agent": dict(agente)}, migracoes='{"versao": 9}')
    calls.clear()
    res = v.configure()
    _a = cfg_now().get("agent") or {}
    check(f"migração 10, {rotulo}: passos e raciocínio ficam {depois}", res is True and {k: _a.get(k) for k in ("max_turns", "reasoning_effort") if k in _a} == depois
          and json.loads(marca_now()) == {"versao": 10}, str((res, _a, calls)))
    check(f"migração 10, {rotulo}: o aviso perto do teto e a leitura de páginas onde faltavam; a união mantém o que a pessoa tinha",
          _a.get("budget_warning_ratio") == 0.75 and cfg_now()["web"]["extract_backend"] == "exa"
          and cfg_now()["platform_toolsets"]["api_server"] == sorted({"todo", "terminal"} | NOVAS_DA_10), str(cfg_now()))
    calls.clear()
    check(f"migração 10, {rotulo}: segunda abertura não chama nada", v.configure() is True and calls == [], str(calls))
reset({"agent": {"max_turns": 20}}, migracoes='{"versao": 9}')
falhar.add("agent.max_turns")
check("migração 10 falhou na troca: a marca fica na 9 e tenta de novo depois", v.configure() is False and json.loads(marca_now()) == {"versao": 9}, str(marca_now()))
falhar.clear()
check("migração 10, de novo: termina", v.configure() is True and cfg_now()["agent"]["max_turns"] == 90 and json.loads(marca_now()) == {"versao": 10}, str(cfg_now()))
v.MIGRACOES = tuple(m for m in TODAS_AS_MIGRACOES if m[0] <= 3)
v.CONFIG_VERSION = 3
reset()

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
check("Hermes de verdade, cofre novo: versão 3", json.loads(marca_now()) == {"versao": 3}, str(marca_now()))
check("Hermes de verdade: o limite da compactação gravado como número", cfg_now().get("compression", {}).get("threshold_tokens") == 150000, str(cfg_now().get("compression")))


def compactacao_no_motor():
    """O que o motor usa ao criar um agente (agent/agent_init.py, _parse_compression_config) e onde a conversa é resumida
    numa janela de 128 mil e numa de 200 mil, lido num processo novo como o usuário do motor."""
    codigo = ("import sys, json, types; sys.path.insert(0, '/opt/hermes'); from hermes_cli.config import load_config; "
              "from agent.agent_init import _parse_compression_config; from agent.context_compressor import ContextCompressor; "
              "cs = _parse_compression_config(types.SimpleNamespace(model='modelo-falso', provider='custom', api_mode='chat_completions'), load_config()); "
              "cc = ContextCompressor('modelo-falso', threshold_percent=cs.threshold, threshold_tokens_cap=cs.threshold_tokens, quiet_mode=True); "
              "print(json.dumps([cs.enabled, cs.threshold_tokens, cc.preview_threshold_tokens('modelo-falso', 128000), cc.preview_threshold_tokens('modelo-falso', 200000)]))")
    r = subprocess.run([sys.executable, "-c", codigo], capture_output=True, text=True, timeout=120,
                       user=v.HERMES_UID, group=v.HERMES_UID, extra_groups=[], env={**os.environ, "HOME": HOME})
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        print(f"      falhou ao ler a compactação: {r.stderr[-500:]}")
        return None


comp = compactacao_no_motor()
# 150 mil é o teto: numa janela de 128 mil vale a fração do próprio Hermes (0,75 × 128 mil = 96 mil); numa de 200 mil, 150 mil
check("Hermes de verdade: a conversa é resumida a partir de 150 mil (96 mil numa janela de 128 mil)",
      comp == [True, 150000, 96000, 150000], str(comp))


def documento_grande_no_motor():
    """Pedido com documento grande (a mensagem do pedido, que fica inteira no trecho recente, já passa do limite): o
    provedor informa, depois de cada resumo, um total ainda acima do limite. O Hermes tenta duas vezes e para (trava contra
    repetição) — não resume de novo a cada chamada do pedido. Lido num processo novo como o usuário do motor."""
    codigo = ("import sys, json, types; sys.path.insert(0, '/opt/hermes'); from hermes_cli.config import load_config; "
              "from agent.agent_init import _parse_compression_config; from agent.context_compressor import ContextCompressor; "
              "cs = _parse_compression_config(types.SimpleNamespace(model='modelo-falso', provider='custom', api_mode='chat_completions'), load_config()); "
              "cc = ContextCompressor('modelo-falso', threshold_percent=cs.threshold, threshold_tokens_cap=cs.threshold_tokens, quiet_mode=True); "
              "cc.context_length = 200000; out = [cc.threshold_tokens, cc.should_compress(162000)]; "
              "cc.record_completed_compaction(); cc.update_from_response({'prompt_tokens': 158000, 'completion_tokens': 10}); out.append(cc.should_compress(158000)); "
              "cc.record_completed_compaction(); cc.update_from_response({'prompt_tokens': 157000, 'completion_tokens': 10}); out.append(cc.should_compress(157000)); "
              "out.append(cc.should_compress_info(157000)[1]); print(json.dumps(out))")
    r = subprocess.run([sys.executable, "-c", codigo], capture_output=True, text=True, timeout=120,
                       user=v.HERMES_UID, group=v.HERMES_UID, extra_groups=[], env={**os.environ, "HOME": HOME})
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        print(f"      falhou ao simular o documento grande: {r.stderr[-500:]}")
        return None


doc = documento_grande_no_motor()
check("Hermes de verdade: documento grande no pedido — resume, tenta mais uma vez e para (no máximo duas chamadas a mais)",
      doc == [150000, True, True, False, "ineffective"], str(doc))
check("Hermes de verdade: as travas de sempre também", v.enforce_safety() is True)
busca = lambda: str(cfg_now().get("tools", {}).get("tool_search", {}).get("enabled")).lower()  # noqa: E731
check("travas: sem conector pronto ligado, a busca de ferramentas fica desligada", busca() in ("off", "false"), busca())


def com_conector(ligado, busca_agora):
    c = cfg_now()
    c["mcp_servers"] = {"context7": {"url": "https://mcp.context7.com/mcp", "enabled": ligado}}
    c.setdefault("tools", {})["tool_search"] = {"enabled": busca_agora}
    with open(os.path.join(HOME, "config.yaml"), "w", encoding="utf-8") as fh:
        yaml.safe_dump(c, fh)
    subprocess.run(["chown", "-R", f"{v.HERMES_UID}:{v.HERMES_UID}", HOME], check=True)


com_conector(True, "on")
check("travas: com um conector pronto ligado, a busca fica como a pessoa deixou (ligada)", v.enforce_safety() is True and busca() in ("on", "true"), busca())
com_conector(False, "on")
check("travas: conector desligado, a busca volta a desligar na abertura", v.enforce_safety() is True and busca() in ("off", "false"), busca())
api, teams, wa = ferramentas("api_server"), ferramentas("teams"), ferramentas("whatsapp")
check("API: as Conexões ligadas", "ergon_conexoes" in api, str(api))
# o resumo manda buscar o resto com session_search, mas ela leria as conversas de todos os workspaces do motor: fica fora
# (as instruções do Ergon dizem para consultar de novo pela ferramenta de origem: RESUMO_HOW em server/src/services/runs.ts)
check("API: sem a busca nas conversas (session_search)", "session_search" not in api, str(api))
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
check("Hermes de verdade, cofre de antes: compactação mais cedo", c.get("compression", {}).get("threshold_tokens") == 150000, str(c.get("compression")))
real_calls.clear()
check("Hermes de verdade, segunda abertura: nenhum passo chamado", v.configure() is True and real_calls == [], str(real_calls))

# ---------------------------------------------------------------- 5. as migrações da rc.27, com o Hermes de verdade
# Cartões (ergon_cartoes): entra num cofre que já estava na migração 3, com o que a pessoa ligou (Terminal, Executar
# código) e com o que ela desligou (as Conexões) do jeito que estavam; Teams e WhatsApp diretos não ganham o conjunto.
v.MIGRACOES = TODAS_AS_MIGRACOES
v.CONFIG_VERSION = TODAS_AS_MIGRACOES[-1][0]
# Cofre novo com todas: o que cada migração da rc.27 grava, com o tipo certo, lido pelo próprio Hermes
preparar()
check("Hermes de verdade, cofre novo com todas: configura até a última", v.configure() is True and json.loads(marca_now()) == {"versao": ULTIMA}, str(logs[-3:]))
check("Hermes de verdade: a equipe nativa ligada (gateway.multiplex_profiles: true, como booleano)", (cfg_now().get("gateway") or {}).get("multiplex_profiles") is True, str(cfg_now().get("gateway")))
# rc.27: os padrões seguros gravados com o tipo certo (falso e verdadeiro de verdade, não texto)
_c = cfg_now()
check("Hermes de verdade: a arrumação automática das competências (Curator) desligada", _c.get("curator", {}).get("enabled") is False, str(_c.get("curator")))
check("Hermes de verdade: a revisão de fundo ligada (como booleano) e a revisão de competências com intervalo 0 (como número)",
      _c.get("auxiliary", {}).get("background_review", {}).get("enabled") is True and _c.get("skills", {}).get("creation_nudge_interval") == 0, str((_c.get("auxiliary"), _c.get("skills"))))
check("Hermes de verdade: 90 passos, raciocínio alto e o aviso perto do teto (0.75, como número)",
      _c.get("agent", {}).get("max_turns") == 90 and _c.get("agent", {}).get("reasoning_effort") == "high" and _c.get("agent", {}).get("budget_warning_ratio") == 0.75, str(_c.get("agent")))
check("Hermes de verdade: não treinar com os dados (provider_routing.data_collection: deny)", _c.get("provider_routing", {}).get("data_collection") == "deny", str(_c.get("provider_routing")))
check("Hermes de verdade: segredos mascarados (security.redact_secrets) ligado", _c.get("security", {}).get("redact_secrets") is True, str(_c.get("security")))


def no_motor(codigo):
    """Roda um trecho num processo novo do Hermes, como o usuário do motor, e devolve o JSON da última linha."""
    r = subprocess.run([sys.executable, "-c", "import sys, json; sys.path.insert(0, '/opt/hermes'); " + codigo], capture_output=True, text=True, timeout=120,
                       user=v.HERMES_UID, group=v.HERMES_UID, extra_groups=[], env={**os.environ, "HOME": HOME})
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        print(f"      falhou: {r.stderr[-500:]}")
        return None


check("Hermes de verdade: a revisão de fundo se diz ligada (a anotação de memória depois do pedido)",
      no_motor("from agent.background_review import load_background_review_settings; print(json.dumps(load_background_review_settings()[0]))") is True)
# o agente do motor lê o intervalo 0 (a revisão de competências nunca dispara), o aviso perto do teto e o raciocínio alto
_ag = no_motor("from agent.agent_init import _apply_agent_section; from hermes_cli.config import load_config; from hermes_constants import parse_reasoning_effort; import types; "
               "a = types.SimpleNamespace(run_budget_seconds=1); c = load_config(); _apply_agent_section(a, c); "
               "print(json.dumps([a._skill_nudge_interval, a.budget_warning_ratio, parse_reasoning_effort(c['agent']['reasoning_effort'])]))")
check("Hermes de verdade: o agente lê o intervalo 0 das competências, o aviso a 75% e o raciocínio alto", _ag == [0, 0.75, {"enabled": True, "effort": "high"}], str(_ag))
# com o pacote da busca direta na imagem (rc.27) e sem chave nenhuma: a leitura de páginas continua (Exa, sem chave)
_web = no_motor("import tools.web_tools as w; w._ddgs_package_importable = lambda: True; w._ensure_web_plugins_loaded(); "
                "from tools.web_tools_extract import _resolve_extract_provider; p, erro = _resolve_extract_provider(w._get_extract_backend()); "
                "print(json.dumps([w._get_search_backend(), w._get_extract_backend(), getattr(p, 'name', None), erro]))")
check("Hermes de verdade: com o DuckDuckGo instalado, a busca vai a ele e ler a página inteira vai à Exa (sem o erro de 'só busca')",
      _web is not None and _web[1:] == ["exa", "exa", None] and _web[0] == "ddgs", str(_web))
check("Hermes de verdade: o Curator se diz desligado (não marca nem arquiva nada sozinho)",
      no_motor("from agent import curator; print(json.dumps([curator.is_enabled(), curator.should_run_now() if hasattr(curator, 'should_run_now') else False]))") == [False, False])
# o segredo de exemplo é montado por partes (nenhum arquivo do projeto traz um texto com cara de chave)
_seg = "sk-" + "proj-" + "A1b2C3d4E5f6G7h8" + "I9j0K1l2M3n4O5p6"
_red = no_motor(f"from agent.redact import redact_sensitive_text; s = {_seg!r}; o = redact_sensitive_text('chave ' + s + ' fim'); print(json.dumps([s in o, o.startswith('chave '), o.endswith(' fim')]))")
check("Hermes de verdade: uma chave no texto sai mascarada", _red == [False, True, True], str(_red))
# migração 7 (rc.27): proteções do Terminal ligadas, pelo Hermes de verdade
c13 = cfg_now()
check("migração 7: checkpoints ligados (voltar atrás)", c13.get("checkpoints", {}).get("enabled") is True, str(c13.get("checkpoints")))
check("migração 7: aviso de código inseguro ligado (plugin security-guidance do Hermes)", "security-guidance" in (c13.get("plugins", {}).get("enabled") or []), str(c13.get("plugins")))
check("migração 7: a limpeza dos arquivos temporários ligada (plugin disk-cleanup do Hermes)", "disk-cleanup" in (c13.get("plugins", {}).get("enabled") or []), str(c13.get("plugins")))
check("migração 10: o Hermes liga navegador, vídeo, arquivos e voz na API; busca no X e criar vídeos ficam de fora (precisam de chave)",
      {"browser", "video", "file", "tts"} <= ferramentas("api_server") and not {"video_gen", "x_search"} & ferramentas("api_server"), str(ferramentas("api_server")))
check("migração 10: Teams e WhatsApp diretos sem as ferramentas novas", not {"browser", "video", "file", "tts"} & (ferramentas("teams") | ferramentas("whatsapp")))
check("Hermes de verdade: o Telegram entrega o que chegou com o Ergon fechado (drop_pending_on_cold_boot: false, como booleano)",
      cfg_now().get("platforms", {}).get("telegram", {}).get("extra", {}).get("drop_pending_on_cold_boot") is False, str(cfg_now().get("platforms")))
# migração 9 (rc.27, rotinas): aprovações nativas, lidas pelo próprio Hermes (o modo e o prazo do portão de aprovação)
check("Hermes de verdade: aprovações pela pessoa (approvals.mode manual) e o turno esperando 300 s (como número)",
      (cfg_now().get("approvals") or {}).get("mode") == "manual" and (cfg_now().get("approvals") or {}).get("timeout") == 300, str(cfg_now().get("approvals")))
check("Hermes de verdade: o portão de aprovação lê o modo manual e o prazo de 300 s",
      no_motor("from tools import approval_context as a; print(json.dumps([a._get_approval_mode(), a._get_approval_timeout()]))") == ["manual", 300])
_api = ferramentas("api_server")
check("Hermes de verdade, cofre novo com todas: Conexões e cartões ligados na API, sem Terminal", {"ergon_conexoes", "ergon_cartoes", "todo", "web"} <= _api and "terminal" not in _api, str(_api))
real_calls.clear()
check("Hermes de verdade, cofre novo com todas, segunda abertura: nenhum passo chamado", v.configure() is True and real_calls == [], str(real_calls))

SEM_CONEXOES = ["todo", "web", "terminal", "code_execution"]
preparar({"plugins": {"enabled": ["ergon_bridge"]},
          "platform_toolsets": {"api_server": SEM_CONEXOES, "teams": ["todo"], "whatsapp": ["todo"]},
          "known_plugin_toolsets": {"api_server": ["ergon_conexoes", "homeassistant"], "teams": ["ergon_conexoes"], "whatsapp": ["ergon_conexoes"]},
          "compression": {"threshold_tokens": None}, "agent": {"max_turns": 33}, "tools": {"tool_search": {"enabled": "off"}}}, marca="1")
with open(os.path.join(HOME, ".ergon-migracoes"), "w", encoding="utf-8") as f:
    f.write('{"versao": 3}')
subprocess.run(["chown", f"{v.HERMES_UID}:{v.HERMES_UID}", os.path.join(HOME, ".ergon-migracoes")], check=True)
real_calls.clear()
check("cartões, cofre na migração 3: configura", v.configure() is True, str(logs))
c = cfg_now()
check("cartões: a marca vai para a última migração", json.loads(marca_now()) == {"versao": v.CONFIG_VERSION} and v.CONFIG_VERSION > 3, str(marca_now()))
# as listas de ferramentas só mudam pela união dos cartões (a 6); nada da 1, da 2 nem da 3 roda de novo
_soltas_de_antes = {"agent.max_turns", "agent.reasoning_effort", "unauthorized_dm_behavior", "platform_toolsets.teams", "platform_toolsets.whatsapp", "compression.threshold_tokens"}
check("cartões: só as migrações que faltavam rodam (nada da 1, da 2 nem da 3)",
      real_calls and not any(x[:3] == ["plugins", "enable", "ergon_bridge"] or x[2] in _soltas_de_antes for x in real_calls)
      and all("ergon_cartoes" in x[3] for x in real_calls if "toolsets" in x[2]), str(real_calls))
check("cartões: entram na API com o que a pessoa ligou; as Conexões que ela desligou continuam desligadas",
      c["platform_toolsets"]["api_server"] == sorted(set(SEM_CONEXOES + ["ergon_cartoes"]) | {"browser", "file", "tts", "video"}), str(c["platform_toolsets"]))
check("cartões: conhecidos nas três plataformas, unidos ao que já estava",
      c["known_plugin_toolsets"] == {"api_server": ["ergon_cartoes", "ergon_conexoes", "homeassistant"], "teams": ["ergon_cartoes", "ergon_conexoes"],
                                     "whatsapp": ["ergon_cartoes", "ergon_conexoes"]}, str(c.get("known_plugin_toolsets")))
check("cartões: as escolhas da pessoa ficam (passos por pedido, resumo desligado; o raciocínio ausente fica ausente)",
      c["agent"]["max_turns"] == 33 and c["compression"]["threshold_tokens"] is None and "reasoning_effort" not in c["agent"], str(c))
api, teams, wa = ferramentas("api_server"), ferramentas("teams"), ferramentas("whatsapp")
check("cartões: o Hermes liga o conjunto na API", "ergon_cartoes" in api and "ergon_conexoes" not in api and {"terminal", "code_execution"} <= api, str(api))
check("cartões: Teams e WhatsApp diretos sem o conjunto", "ergon_cartoes" not in teams and "ergon_cartoes" not in wa, f"{teams} {wa}")
real_calls.clear()
check("cartões, segunda abertura: nenhum passo chamado", v.configure() is True and real_calls == [], str(real_calls))
preparar()
check("cartões, cofre novo: configura até a última", v.configure() is True and json.loads(marca_now()) == {"versao": v.CONFIG_VERSION}, str(logs[-3:]))
api = ferramentas("api_server")
check("cartões, cofre novo: Conexões e cartões ligados na API", {"ergon_conexoes", "ergon_cartoes", "todo", "web"} <= api and "terminal" not in api, str(api))

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)

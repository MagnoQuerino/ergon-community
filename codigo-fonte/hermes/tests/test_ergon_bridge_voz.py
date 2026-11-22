"""rc.33: a voz pelo plugin do Ergon, sem o motor (só a biblioteca padrão do Python; os módulos do Hermes entram simulados,
com as mesmas funções que o plugin chama).

Confere:
  - os ajustes da voz gravam o config.yaml do Hermes: o Piper como voz do "Ouvir", pelo provedor de comando do Ergon
    (tts.providers.ergon-piper, processo próprio, nunca o "piper" do Hermes, que importa o pacote GPL no motor), o modelo
    da transcrição (stt.local.model) e o idioma da pessoa na transcrição (stt.local.language) e nas vozes (cadu e ljspeech,
    de bases livres; tts.edge.voice);
  - piper_processo.py: baixa a voz e fala pela linha de comando do Piper em processos filhos (um Python falso aqui), com o
    texto pela entrada padrão; voz com nome estranho, recusada;
  - nada do pacote piper é importado no processo do plugin;
    valor fora da lista: recusado; a leitura dos ajustes diz como está (motor sem nada gravado: edge, base, sem idioma);
  - o estado da voz: o Piper sem o pacote cai para a voz online; a voz do Piper e o modelo do Whisper ainda não baixados
    aparecem em "preparar" (a tela avisa "primeira vez");
  - falar: pelo Piper; se ele falhar, pela voz online, com a resposta marcando a reserva;
  - transcrever em segundo plano: a tarefa volta na hora, o resultado sai na consulta (uma vez só); formato errado volta
    direto; a rota da ponte (POST e GET voz/transcrever).

  python3 -I hermes/tests/test_ergon_bridge_voz.py
  (ERGON_PLUGINS = pasta hermes/plugins; HERMES_HOME = pasta descartável, apagada no começo)
"""
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import time
import types

AQUI = os.path.dirname(os.path.abspath(__file__))
PLUGINS = os.environ.get("ERGON_PLUGINS") or ("/p" if os.path.isdir("/p") else os.path.join(AQUI, "..", "plugins"))
HOME = os.environ.get("HERMES_HOME") or os.path.join(tempfile.gettempdir(), "ergon-teste-voz")
if os.path.exists(os.path.join(HOME, ".ergon-vault")):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
HOME = os.path.realpath(HOME)
os.environ["HERMES_HOME"] = HOME
VOZES = os.path.join(HOME, "cache", "piper-voices")

# ---------------------------------------------------------------- os módulos do Hermes, simulados
CFG = {"tts": {}, "stt": {}}
ST = {"falhar_piper": False, "whisper_baixado": False, "transcrever_espera": 0.0, "transcricao": {"success": True, "transcript": "oi, tudo bem?", "provider": "local"}}


def mod(nome, **attrs):
    m = types.ModuleType(nome)
    m.__dict__.update(attrs)
    sys.modules[nome] = m
    return m


mod("tools")
mod("faster_whisper")


def download_model(modelo, local_files_only=False):
    if not ST["whisper_baixado"]:
        raise OSError("não está no cache")
    return f"/cache/{modelo}"


mod("faster_whisper.utils", download_model=download_model)


def _transcribe(caminho):
    time.sleep(ST["transcrever_espera"])
    return dict(ST["transcricao"])


mod("tools.transcription_tools", _get_provider=lambda cfg: "local", _load_stt_config=lambda: CFG["stt"], transcribe_audio=_transcribe)


def tts_provider(cfg):
    return (cfg.get("provider") or "edge").lower()


def text_to_speech_tool(texto, output_path=None):
    ST["hermes_falou"] = ST.get("hermes_falou", 0) + 1
    with open(output_path, "wb") as f:
        f.write(b"ID3-piper")
    return json.dumps({"success": True, "file_path": output_path, "provider": tts_provider(CFG["tts"])})


def run_edge(texto, saida, cfg):
    with open(saida, "wb") as f:
        f.write(b"ID3-edge")


mod("tools.tts_tool", _get_provider=tts_provider, _load_tts_config=lambda: CFG["tts"], check_tts_requirements=lambda: True,
    text_to_speech_tool=text_to_speech_tool, _run_edge_tts=run_edge)
mod("tools.tts_tool_local", DEFAULT_PIPER_VOICE="en_US-lessac-medium", _get_piper_voices_dir=lambda: __import__("pathlib").Path(VOZES))

spec = importlib.util.spec_from_file_location("ergon_bridge_teste_voz", os.path.join(PLUGINS, "ergon_bridge", "__init__.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PACOTES = {"piper": True, "edge": True}
CHAMADAS_PIPER = []


def falar_piper_falso(texto, saida, cfg, perfil=None):
    CHAMADAS_PIPER.append((texto, bridge._piper_voz(cfg)))
    if ST["falhar_piper"]:
        return False, "não consegui baixar a voz"
    with open(saida, "wb") as f:
        f.write(b"RIFF\x00\x00\x00\x00WAVEfmt piper")
    return True, ""


bridge._falar_piper = falar_piper_falso
bridge._piper_instalado = lambda: PACOTES["piper"]
bridge._edge_instalado = lambda: PACOTES["edge"]

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and bool(cond)


def recusa(body):
    try:
        bridge.ajustes_config(body)
        return False
    except ValueError:
        return True


# 1. os ajustes da voz no config.yaml
c = bridge.ajustes_config({"voz_falar": "piper"})
pc = c["tts"]["providers"]["ergon-piper"]
check("voz do Ouvir: o Piper pelo provedor de comando do Ergon (nunca o \"piper\" do Hermes, no processo)",
      c["tts"]["provider"] == "ergon-piper" and pc["type"] == "command" and pc["output_format"] == "mp3", str(c))
check("o comando roda piper_processo.py com o Python do motor e a pasta das vozes",
      "piper_processo.py" in pc["command"] and sys.executable in pc["command"] and VOZES in pc["command"]
      and "{voice}" in pc["command"] and "{input_path}" in pc["command"] and "{output_path}" in pc["command"], pc["command"])
check("voz do Ouvir: a online também é escolha", bridge.ajustes_config({"voz_falar": "edge"}) == {"tts": {"provider": "edge"}})
check("voz desconhecida: recusada", recusa({"voz_falar": "kokoro"}))
c = bridge.ajustes_config({"voz_modelo": "small"})
check("modelo da transcrição: small, no transcritor local", c == {"stt": {"provider": "local", "local": {"model": "small"}}}, str(c))
check("modelo fora da lista: recusado", recusa({"voz_modelo": "large-v3"}))
c = bridge.ajustes_config({"voz_idioma": "pt"})
check("idioma da transcrição: o da pessoa (stt.local.language)", c["stt"] == {"local": {"language": "pt"}}, str(c))
check("idioma: a voz do Piper em português do Brasil (cadu: base CC0)", c["tts"]["providers"]["ergon-piper"] == {"voice": "pt_BR-cadu-medium"}, str(c))
check("idioma: a voz online em português do Brasil", c["tts"]["edge"] == {"voice": "pt-BR-FranciscaNeural"}, str(c))
c = bridge.ajustes_config({"voz_idioma": "en", "voz_falar": "piper", "voz_modelo": "base"})
check("juntos: inglês (ljspeech, domínio público), Piper e base, sem um apagar o outro",
      c["tts"]["provider"] == "ergon-piper" and c["tts"]["providers"]["ergon-piper"]["voice"] == "en_US-ljspeech-medium"
      and "command" in c["tts"]["providers"]["ergon-piper"] and c["tts"]["edge"] == {"voice": "en-US-AriaNeural"}
      and c["stt"] == {"provider": "local", "local": {"model": "base", "language": "en"}}, json.dumps(c))
check("nenhuma voz de base com restrição (lessac) nem o provedor piper do Hermes", "lessac" not in json.dumps(c) and '"piper": {' not in json.dumps(c))
check("idioma fora da lista: recusado", recusa({"voz_idioma": "es"}))
# rc.45: chinês e hindi na transcrição e nas vozes (Piper e a reserva online)
c = bridge.ajustes_config({"voz_idioma": "zh"})
check("chinês: transcrição em zh, Piper huayan e a voz online Xiaoxiao", c["stt"] == {"local": {"language": "zh"}}
      and c["tts"]["providers"]["ergon-piper"] == {"voice": "zh_CN-huayan-medium"} and c["tts"]["edge"] == {"voice": "zh-CN-XiaoxiaoNeural"}, json.dumps(c))
c = bridge.ajustes_config({"voz_idioma": "hi"})
check("hindi: transcrição em hi, Piper pratham e a voz online Swara", c["stt"] == {"local": {"language": "hi"}}
      and c["tts"]["providers"]["ergon-piper"] == {"voice": "hi_IN-pratham-medium"} and c["tts"]["edge"] == {"voice": "hi-IN-SwaraNeural"}, json.dumps(c))
lido = bridge.ajustes_ler({})
check("motor sem nada gravado: edge, base, sem idioma (o Ergon manda o Piper e o idioma)",
      (lido["voz_falar"], lido["voz_modelo"], lido["voz_idioma"]) == ("edge", "base", ""), str(lido))
lido = bridge.ajustes_ler({"tts": bridge.ajustes_config({"voz_falar": "piper"})["tts"], "stt": {"local": {"model": "small", "language": "pt"}}})
check("leitura dos ajustes: como está gravado", (lido["voz_falar"], lido["voz_modelo"], lido["voz_idioma"]) == ("piper", "small", "pt"), str(lido))
lido = bridge.ajustes_ler({"tts": {"provider": "piper"}})
check("o \"piper\" do Hermes (no processo do motor) não conta como a escolha: o Ergon manda trocar", lido["voz_falar"] == "piper-no-processo", str(lido))
check("a capacidade dos ajustes continua no contrato", "ajustes" in bridge.CAPACIDADES and "recursos" in bridge.CAPACIDADES)

# 2. o estado da voz
CFG["tts"] = {"provider": "ergon-piper", "providers": {"ergon-piper": {**bridge._piper_comando(), "voice": "pt_BR-cadu-medium"}}}
CFG["stt"] = {"local": {"model": "base", "language": "pt"}}
e = bridge._voz_estado()
check("Piper configurado e instalado: fala pelo Piper", e["falar"] == "piper", str(e))
check("voz do Piper ainda não baixada: preparar.falar", e["preparar"]["falar"] is True, str(e))
check("modelo do Whisper ainda não baixado: preparar.transcrever", e["transcrever"] == "local" and e["modelo"] == "base" and e["preparar"]["transcrever"] is True, str(e))
os.makedirs(VOZES, exist_ok=True)
for ext in (".onnx", ".onnx.json"):
    open(os.path.join(VOZES, "pt_BR-cadu-medium" + ext), "wb").close()
ST["whisper_baixado"] = True
e = bridge._voz_estado()
check("voz e modelo já baixados: nada a preparar", e["preparar"] == {"transcrever": False, "falar": False}, str(e))
PACOTES["piper"] = False
check("sem o pacote do Piper na imagem: a voz online", bridge._voz_estado()["falar"] == "edge")
PACOTES["edge"] = False
check("sem Piper e sem a voz online: falar indisponível", bridge._voz_estado()["falar"] is None)
PACOTES.update(piper=True, edge=True)

# 3. falar, com a reserva
r = bridge.voz_falar("Bom dia.")
check("falar pelo Piper, num processo próprio (não pelo provedor do Hermes)", r.get("ok") is True and r.get("reserva") is False and r.get("provedor") == "piper"
      and CHAMADAS_PIPER[-1] == ("Bom dia.", "pt_BR-cadu-medium") and not ST.get("hermes_falou"), str({k: v for k, v in r.items() if k != "audio"}))
check("o WAV do Piper vai como audio/wav (pelos bytes, não pelo nome)", r.get("tipo") == "audio/wav", str(r.get("tipo")))
CFG["tts"] = {"provider": "piper"}
r = bridge.voz_falar("Bom dia.")
check("config antiga com o \"piper\" do Hermes: o Ouvir também vai pelo processo próprio", r.get("ok") is True and len(CHAMADAS_PIPER) == 2 and not ST.get("hermes_falou"))
CFG["tts"] = {"provider": "ergon-piper", "providers": {"ergon-piper": {**bridge._piper_comando(), "voice": "pt_BR-cadu-medium"}}}
ST["falhar_piper"] = True
r = bridge.voz_falar("Bom dia.")
import base64  # noqa: E402
check("Piper falhou: a voz online responde, marcada como reserva", r.get("ok") is True and r.get("reserva") is True and r.get("provedor") == "edge"
      and base64.b64decode(r["audio"]) == b"ID3-edge", str({k: v for k, v in r.items() if k != "audio"}))
PACOTES["edge"] = False
r = bridge.voz_falar("Bom dia.")
check("Piper falhou e sem a voz online: falha limpa", r.get("ok") is False and r.get("motivo") == "falhou", str(r))
PACOTES.update(edge=True)
ST["falhar_piper"] = False
PACOTES["piper"] = False
r = bridge.voz_falar("Bom dia.")
check("sem o pacote do Piper: direto para a voz online", r.get("ok") is True and r.get("reserva") is True, str({k: v for k, v in r.items() if k != "audio"}))
PACOTES["piper"] = True
check("nenhum áudio fica na pasta da voz", not [n for n in os.listdir(bridge._voz_pasta()) if n.startswith("f-")], str(os.listdir(bridge._voz_pasta())))

# 4. transcrever em segundo plano
check("formato errado: volta direto, sem tarefa", bridge.voz_transcrever_tarefa(b"x", "nota.txt") == {"ok": False, "motivo": "formato"})
check("vazio: volta direto", bridge.voz_transcrever_tarefa(b"", "a.webm") == {"ok": False, "motivo": "tamanho"})
ST["transcrever_espera"] = 0.3
t = bridge.voz_transcrever_tarefa(b"OggS-falso", "a.ogg")
check("a tarefa volta na hora", t.get("ok") is True and len(t.get("tarefa", "")) == 32, str(t))
check("enquanto transcreve: andando", bridge.voz_transcrever_resultado(t["tarefa"]) == {"andando": True})
fim = None
for _ in range(100):
    fim = bridge.voz_transcrever_resultado(t["tarefa"])
    if not fim.get("andando"):
        break
    time.sleep(0.02)
check("o resultado sai na consulta", fim == {"ok": True, "texto": "oi, tudo bem?", "provedor": "local"}, str(fim))
check("entregue uma vez só (depois some)", bridge.voz_transcrever_resultado(t["tarefa"]).get("motivo") == "falhou")
check("nenhum áudio fica na pasta da voz depois da transcrição", not [n for n in os.listdir(bridge._voz_pasta()) if n.startswith("t-")])
ST["transcrever_espera"] = 0.0
ST["transcricao"] = {"success": False, "error": "RuntimeError"}
t = bridge.voz_transcrever_tarefa(b"OggS-falso", "a.ogg")
for _ in range(100):
    fim = bridge.voz_transcrever_resultado(t["tarefa"])
    if not fim.get("andando"):
        break
    time.sleep(0.02)
check("falha do transcritor: motivo falhou", fim.get("ok") is False and fim.get("motivo") == "falhou", str(fim))


# 5. a rota da ponte
class Resp:
    status = None
    json = None


def rota(method, body=None, q=None):
    h = object.__new__(bridge._ControlHandler)
    r = Resp()

    def _json(code, b):
        r.status = code
        r.json = b
    h._json = _json
    h._recursos(method, "/ergon/v1/voz/transcrever", q or {}, body or {})
    return r


ST["transcricao"] = {"success": True, "transcript": "pela rota", "provider": "local"}
r = rota("POST", {"audio": base64.b64encode(b"OggS").decode(), "nome": "a.ogg", "segundo_plano": True})
check("rota POST em segundo plano: a tarefa", r.status == 200 and "tarefa" in r.json, str(r.json))
for _ in range(100):
    g = rota("GET", q={"tarefa": r.json["tarefa"]})
    if not g.json.get("andando"):
        break
    time.sleep(0.02)
check("rota GET: o resultado", g.status == 200 and g.json.get("texto") == "pela rota", str(g.json))
check("rota GET: tarefa malformada recusada", rota("GET", q={"tarefa": "../x"}).status == 400)
r = rota("POST", {"audio": base64.b64encode(b"OggS").decode(), "nome": "a.ogg"})
check("rota POST sem segundo plano: como antes (o resultado direto)", r.status == 200 and r.json.get("texto") == "pela rota", str(r.json))

# 6. piper_processo.py: a linha de comando do Piper em processos filhos (um "python" falso faz o papel do pacote)
import subprocess  # noqa: E402
FALSO = os.path.join(HOME, "python-falso")
LOG = os.path.join(HOME, "python-falso.log")
with open(FALSO, "w") as f:
    f.write(f"""#!/bin/sh
echo "$@" >> {LOG}
if [ "$2" = "piper.download_voices" ]; then : > "$5/$3.onnx"; : > "$5/$3.onnx.json"; exit 0; fi
if [ "$2" = "piper" ]; then cat > {LOG}.texto; printf 'RIFF0000WAVEfmt dados-do-piper-com-mais-de-44-bytes-de-cabecalho-e-som' > "$8"; exit 0; fi
exit 9
""")
os.chmod(FALSO, 0o755)
HELPER = os.path.join(PLUGINS, "ergon_bridge", "piper_processo.py")
entrada = os.path.join(HOME, "entrada.txt")
with open(entrada, "w", encoding="utf-8") as f:
    f.write("Olá, tudo bem?\nSegunda linha.")
saida = os.path.join(HOME, "saida", "fala.wav")
pasta = os.path.join(HOME, "vozes-novas")
r = subprocess.run([sys.executable, "-I", HELPER, "--voz", "pt_BR-cadu-medium", "--pasta", pasta, "--texto", entrada, "--saida", saida, "--python", FALSO],
                   capture_output=True, timeout=60)
log = open(LOG).read()
check("processo próprio: baixa a voz no 1º uso pela linha de comando do Piper", r.returncode == 0 and "-m piper.download_voices pt_BR-cadu-medium --download-dir" in log, r.stderr.decode()[-300:] + log)
check("processo próprio: fala pela linha de comando, com o texto pela entrada padrão", "-m piper -m pt_BR-cadu-medium --data-dir" in log
      and open(LOG + ".texto", encoding="utf-8").read() == "Olá, tudo bem?\nSegunda linha.", log)
check("processo próprio: o WAV chega na saída", open(saida, "rb").read().startswith(b"RIFF"))
open(LOG, "w").close()
r = subprocess.run([sys.executable, "-I", HELPER, "--voz", "pt_BR-cadu-medium", "--pasta", pasta, "--texto", entrada, "--saida", saida, "--python", FALSO], capture_output=True, timeout=60)
check("processo próprio: voz já baixada não baixa de novo", r.returncode == 0 and "download_voices" not in open(LOG).read())
r = subprocess.run([sys.executable, "-I", HELPER, "--voz", "../../etc/passwd", "--pasta", pasta, "--texto", entrada, "--saida", saida, "--python", FALSO], capture_output=True, timeout=60)
check("processo próprio: voz com nome estranho, recusada", r.returncode == 2)
src = open(os.path.join(PLUGINS, "ergon_bridge", "__init__.py"), encoding="utf-8").read() + open(HELPER, encoding="utf-8").read()
check("nada do pacote piper é importado no processo do plugin", "piper" not in sys.modules and not re.search(r"^\s*(from piper|import piper)", src, re.M))

# rc.49: uma voz para cada agente — o mesmo perfil dá sempre a mesma voz; perfis vizinhos soam diferentes
check("perfil do agente: voz e ritmo fixos por perfil", bridge._perfil_piper("pt_BR-cadu-medium", 3) == bridge._perfil_piper("pt_BR-cadu-medium", 3))
check("perfis vizinhos: vozes ou ritmos diferentes", len({bridge._perfil_piper("pt_BR-cadu-medium", i) for i in range(6)}) == 6)
check("sem perfil: a voz escolhida, ritmo normal", bridge._perfil_piper("pt_BR-cadu-medium", None) == ("pt_BR-cadu-medium", 1.0))
check("edge-tts: voz do idioma com tom", bridge._perfil_edge(1, "pt")[0].startswith("pt-BR-"))
r = subprocess.run([sys.executable, "-I", HELPER, "--voz", "pt_BR-cadu-medium", "--pasta", pasta, "--texto", entrada, "--saida", saida, "--python", FALSO, "--ritmo", "9"], capture_output=True, timeout=60)
check("processo próprio: ritmo fora da faixa, recusado", r.returncode == 2)

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO OK" if ok else "HÁ FALHAS")
sys.exit(0 if ok else 1)

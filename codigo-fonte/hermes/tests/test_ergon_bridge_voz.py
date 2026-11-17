"""rc.33: a voz pelo plugin do Ergon, sem o motor (só a biblioteca padrão do Python; os módulos do Hermes entram simulados,
com as mesmas funções que o plugin chama).

Confere:
  - os ajustes da voz gravam o config.yaml do Hermes: o Piper como voz do "Ouvir" (tts.provider), o modelo da transcrição
    (stt.local.model) e o idioma da pessoa na transcrição (stt.local.language) e nas vozes (tts.piper.voice, tts.edge.voice);
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
    if tts_provider(CFG["tts"]) == "piper" and ST["falhar_piper"]:
        return json.dumps({"success": False, "error": "Piper voice download failed for 'pt_BR-faber-medium'"})
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
check("voz do Ouvir: o Piper em tts.provider", c == {"tts": {"provider": "piper"}}, str(c))
check("voz do Ouvir: a online também é escolha", bridge.ajustes_config({"voz_falar": "edge"}) == {"tts": {"provider": "edge"}})
check("voz desconhecida: recusada", recusa({"voz_falar": "kokoro"}))
c = bridge.ajustes_config({"voz_modelo": "small"})
check("modelo da transcrição: small, no transcritor local", c == {"stt": {"provider": "local", "local": {"model": "small"}}}, str(c))
check("modelo fora da lista: recusado", recusa({"voz_modelo": "large-v3"}))
c = bridge.ajustes_config({"voz_idioma": "pt"})
check("idioma da transcrição: o da pessoa (stt.local.language)", c["stt"] == {"local": {"language": "pt"}}, str(c))
check("idioma: a voz do Piper em português do Brasil", c["tts"]["piper"] == {"voice": "pt_BR-faber-medium"}, str(c))
check("idioma: a voz online em português do Brasil", c["tts"]["edge"] == {"voice": "pt-BR-FranciscaNeural"}, str(c))
c = bridge.ajustes_config({"voz_idioma": "en", "voz_falar": "piper", "voz_modelo": "base"})
check("juntos: inglês, Piper e base, sem um apagar o outro",
      c == {"tts": {"provider": "piper", "piper": {"voice": "en_US-lessac-medium"}, "edge": {"voice": "en-US-AriaNeural"}},
            "stt": {"provider": "local", "local": {"model": "base", "language": "en"}}}, json.dumps(c))
check("idioma fora da lista: recusado", recusa({"voz_idioma": "es"}))
lido = bridge.ajustes_ler({})
check("motor sem nada gravado: edge, base, sem idioma (o Ergon manda o Piper e o idioma)",
      (lido["voz_falar"], lido["voz_modelo"], lido["voz_idioma"]) == ("edge", "base", ""), str(lido))
lido = bridge.ajustes_ler({"tts": {"provider": "piper"}, "stt": {"local": {"model": "small", "language": "pt"}}})
check("leitura dos ajustes: como está gravado", (lido["voz_falar"], lido["voz_modelo"], lido["voz_idioma"]) == ("piper", "small", "pt"), str(lido))
check("a capacidade dos ajustes continua no contrato", "ajustes" in bridge.CAPACIDADES and "recursos" in bridge.CAPACIDADES)

# 2. o estado da voz
CFG["tts"] = {"provider": "piper", "piper": {"voice": "pt_BR-faber-medium"}}
CFG["stt"] = {"local": {"model": "base", "language": "pt"}}
e = bridge._voz_estado()
check("Piper configurado e instalado: fala pelo Piper", e["falar"] == "piper", str(e))
check("voz do Piper ainda não baixada: preparar.falar", e["preparar"]["falar"] is True, str(e))
check("modelo do Whisper ainda não baixado: preparar.transcrever", e["transcrever"] == "local" and e["modelo"] == "base" and e["preparar"]["transcrever"] is True, str(e))
os.makedirs(VOZES, exist_ok=True)
for ext in (".onnx", ".onnx.json"):
    open(os.path.join(VOZES, "pt_BR-faber-medium" + ext), "wb").close()
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
check("falar pelo Piper", r.get("ok") is True and r.get("reserva") is False and r.get("provedor") == "piper", str({k: v for k, v in r.items() if k != "audio"}))
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

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO OK" if ok else "HÁ FALHAS")
sys.exit(0 if ok else 1)

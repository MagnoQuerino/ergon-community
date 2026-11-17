"""rc.33: a imagem que o agente mostra ("MEDIA:<caminho>") chega à conversa, também a captura de tela do navegador, que
fica dentro do perfil do agente (profiles/<perfil>/home/.config/browser-harness/tmp/shot.png). Sem o motor (só a
biblioteca padrão do Python).

Confere:
  - a imagem das geradas continua servida (a do motor e a de cada perfil), sem pedir perfil;
  - a captura de tela dentro do perfil: servida só com o perfil dela, e copiada para as geradas do perfil (a próxima
    captura sobrescreve a original);
  - recusas: o perfil de outro agente, um link que aponta para fora do perfil, outro tipo de arquivo, vazio, grande
    demais, nome de perfil malformado, "..";
  - a rota da ponte (/ergon/v1/media) devolve os bytes da cópia, com o tipo certo; 404 para o recusado.

  python3 -I hermes/tests/test_ergon_bridge_midia.py
  (ERGON_PLUGINS = pasta hermes/plugins; HERMES_HOME = pasta descartável, apagada no começo)
"""
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
PLUGINS = os.environ.get("ERGON_PLUGINS") or ("/p" if os.path.isdir("/p") else os.path.join(AQUI, "..", "plugins"))
HOME = os.environ.get("HERMES_HOME") or os.path.join(tempfile.gettempdir(), "ergon-teste-midia")
if os.path.exists(os.path.join(HOME, ".ergon-vault")):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
HOME = os.path.realpath(HOME)
os.environ["HERMES_HOME"] = HOME

spec = importlib.util.spec_from_file_location("ergon_bridge_teste", os.path.join(PLUGINS, "ergon_bridge", "__init__.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


def grava(caminho, data):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "wb") as f:
        f.write(data)
    return caminho


PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 64
HIP = "erg-cc4d086464da8211f507"
OUTRO = "erg-0123456789abcdef0123"
P_HIP = os.path.join(HOME, "profiles", HIP)
P_OUTRO = os.path.join(HOME, "profiles", OUTRO)

gerada = grava(os.path.join(HOME, "cache", "generated", "images", "logo.png"), PNG)
gerada_perfil = grava(os.path.join(P_HIP, "cache", "generated", "images", "arte.webp"), PNG)
shot = grava(os.path.join(P_HIP, "home", ".config", "browser-harness", "tmp", "shot.png"), PNG)
do_outro = grava(os.path.join(P_OUTRO, "home", ".config", "browser-harness", "tmp", "shot.png"), PNG)
segredo = grava(os.path.join(HOME, "auth.png"), PNG)  # fora de qualquer perfil
os.symlink(segredo, os.path.join(P_HIP, "home", "atalho.png"))
grava(os.path.join(P_HIP, "home", ".env"), b"CHAVE=x")
grava(os.path.join(P_HIP, "home", "vazia.png"), b"")
grava(os.path.join(P_HIP, "home", "grande.png"), b"\x00" * (bridge._MEDIA_MAX + 1))
grava(os.path.join(P_HIP, "home", "doc.pdf"), b"%PDF-1.4")

# 1. as geradas, como antes
check("gerada do motor, sem perfil", bridge._media_file(gerada) == (gerada, "image/png"))
check("gerada do perfil, sem perfil", bridge._media_file(gerada_perfil) == (gerada_perfil, "image/webp"))

# 2. a captura de tela do navegador, dentro do perfil do agente
check("captura sem o perfil: recusada", bridge._media_file(shot) is None)
check("captura com o perfil dela: servida", bridge._media_file(shot, HIP) == (shot, "image/png"))
check("captura de outro agente: recusada", bridge._media_file(do_outro, HIP) is None)
check("caminho com '..' saindo do perfil: recusado", bridge._media_file(os.path.join(P_HIP, "home", "..", "..", OUTRO, "home", ".config", "browser-harness", "tmp", "shot.png"), HIP) is None)
check("link para fora do perfil: recusado", bridge._media_file(os.path.join(P_HIP, "home", "atalho.png"), HIP) is None)
check("outro tipo (.env, .pdf): recusado", bridge._media_file(os.path.join(P_HIP, "home", ".env"), HIP) is None and bridge._media_file(os.path.join(P_HIP, "home", "doc.pdf"), HIP) is None)
check("vazia: recusada", bridge._media_file(os.path.join(P_HIP, "home", "vazia.png"), HIP) is None)
check("grande demais: recusada", bridge._media_file(os.path.join(P_HIP, "home", "grande.png"), HIP) is None)
check("nome de perfil malformado: só as geradas", bridge._media_file(shot, "../erg-x") is None and bridge._media_file(shot, "erg-cc4d/..") is None)
check("perfil que não existe: recusado", bridge._media_file(shot, "erg-ffffffffffffffffffff") is None)

# 3. a cópia para as geradas do perfil (a próxima captura sobrescreve a original)
copia = bridge._media_guardar(shot, HIP)
check("captura copiada para as geradas do perfil", copia.startswith(os.path.join(P_HIP, "cache", "generated") + os.sep) and copia != shot, copia)
check("a cópia tem os mesmos bytes", open(copia, "rb").read() == PNG)
check("de novo: a mesma cópia (pelo conteúdo)", bridge._media_guardar(shot, HIP) == copia)
check("gerada não é copiada", bridge._media_guardar(gerada_perfil, HIP) == gerada_perfil)
grava(shot, PNG + b"nova")
check("a próxima captura não apaga a cópia de antes", open(copia, "rb").read() == PNG)


# 4. a rota da ponte
class Resp:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()
        self.json = None


def rota(raw, perfil=""):
    h = object.__new__(bridge._ControlHandler)
    r = Resp()
    h.wfile = r.wfile
    h.send_response = lambda code: setattr(r, "status", code)
    h.send_header = lambda k, v: r.headers.__setitem__(k, v)
    h.end_headers = lambda: None

    def _json(code, body):
        r.status = code
        r.json = body
    h._json = _json
    h._media_get(raw, perfil)
    return r


r = rota(shot, HIP)
check("rota: captura do perfil servida como PNG", r.status == 200 and r.headers.get("Content-Type") == "image/png" and r.wfile.getvalue() == PNG + b"nova", str(r.status))
check("rota: a cópia ficou nas geradas", any(n.startswith("tela-") for n in os.listdir(os.path.join(P_HIP, "cache", "generated", "capturas"))))
r = rota(shot)
check("rota: captura sem perfil, 404", r.status == 404, json.dumps(r.json))
r = rota(do_outro, HIP)
check("rota: captura de outro agente, 404", r.status == 404)
r = rota(gerada)
check("rota: gerada do motor, como antes", r.status == 200 and r.wfile.getvalue() == PNG)

shutil.rmtree(HOME, ignore_errors=True)
print("TUDO OK" if ok else "HÁ FALHAS")
sys.exit(0 if ok else 1)

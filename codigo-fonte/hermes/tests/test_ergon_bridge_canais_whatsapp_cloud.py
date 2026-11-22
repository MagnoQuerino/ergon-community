"""rc.47: conversar com a equipe pelo WhatsApp oficial (Cloud API da Meta): o plugin do Ergon com o Hermes de verdade,
dentro da imagem do motor, sem rede e com credenciais de mentira.

A "Meta" é um servidor falso no lugar de graph.facebook.com (o adaptador do Hermes manda /v20.0/<phone_number_id>/messages
e /media; o módulo aponta para ele por GRAPH_API_BASE). As notificações do webhook NÃO chegam pela porta do adaptador:
o "Ergon" falso as entrega pela espera longa da saída (tipo "webhook", com o corpo cru e o X-Hub-Signature-256, como o
relé de canais guardou), e o plugin confere a assinatura com o App Secret antes de o adaptador ler a mensagem.

Confere: a fábrica e a capacidade; a ponte grava as credenciais no .env do motor (o servidor do adaptador só em
127.0.0.1) e nunca devolve o token nem o App Secret; o gateway liga o whatsapp_cloud; assinatura errada é recusada
(nada chega ao Ergon nem à Meta); quem não está ligado recebe o código (também em hindi); depois de ligar, a mensagem
em hindi chega ao Ergon sem turno do Hermes; a saída (texto, cartão como texto, imagem pelo /media) vai à Meta falsa com o
token; fora da janela de 24 h (erro 131047) o aviso não fica tentando; desligar apaga tudo.

  docker run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_canais_whatsapp_cloud.py
"""
import asyncio
import base64
import faulthandler
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME
for var in [v for v in os.environ if v.startswith("WHATSAPP")] + ["GATEWAY_ALLOW_ALL_USERS", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY"]:
    os.environ.pop(var, None)
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
# credenciais de exemplo, montadas por partes
PONTE = "ponte-" + "de-teste-" + "0123456789abcdef"
NUMERO = "1098765" + "43210987"
WABA = "2000000" + "00000001"
TOKEN = "EAAG" + "teste" * 12 + "Zx9"
SEGREDO = "0123456789abcdef" + "fedcba9876543210"
VERIFY = "verifica" + "-cao-de-teste-" + "abcdef012345"
DONA = "919812" + "345678"
ESTRANHO = "919900" + "011122"
os.environ["ERGON_BRIDGE_TOKEN"] = PONTE
os.environ["ERGON_CONTROL_PORT"] = "0"

ok = True
faulthandler.dump_traceback_later(400, exit=True)
_excepthook = sys.excepthook
sys.excepthook = lambda *a: (_excepthook(*a), sys.stdout.flush(), os._exit(1))


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    sys.stdout.flush()
    ok = ok and cond


def ate(pred, segundos=20.0):
    fim = time.time() + segundos
    while time.time() < fim:
        if pred():
            return True
        time.sleep(0.05)
    return False


def servir(handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def responder(h, obj, status=200):
    data = json.dumps(obj, ensure_ascii=False).encode()
    h.send_response(status); h.send_header("Content-Type", "application/json"); h.send_header("Content-Length", str(len(data))); h.end_headers()
    h.wfile.write(data)


# ---------------------------------------------------------------- o Ergon de mentira (entrada e saída dos canais)
recebidos, saida, acks = [], [], []


class Ergon(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.headers.get("X-Ergon-Bridge-Token") != PONTE:
            return responder(self, {}, 401)
        out = {}
        if self.path == "/internal/bridge/v1/canais/entrada":
            recebidos.append(body)
            out = {"ok": True, "digitando": True}
        elif self.path == "/internal/bridge/v1/canais/saida":
            acks.extend(body.get("acks") or [])
            out = {"itens": [i for i in saida if i["canal"] in (body.get("canais") or [])]}
            for i in out["itens"]:
                saida.remove(i)
            if not out["itens"]:
                time.sleep(0.3)
        responder(self, out)


ergon = servir(Ergon)
os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{ergon.server_address[1]}/internal/bridge/v1/events"

# ---------------------------------------------------------------- a Meta de mentira (Graph API)
meta = []  # (método, caminho, autorização, corpo)
fora_da_janela = set()


class Meta(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_POST(self):  # noqa: N802
        bruto = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        tipo = self.headers.get("Content-Type", "")
        corpo = json.loads(bruto or b"{}") if "json" in tipo else {"_multipart": len(bruto)}
        meta.append(("POST", self.path, self.headers.get("Authorization"), corpo))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return responder(self, {"error": {"code": 190, "message": "Invalid OAuth access token"}}, 401)
        if self.path.endswith("/media"):
            return responder(self, {"id": "media-falsa-1"})
        if self.path.endswith("/messages"):
            if corpo.get("status") == "read" or corpo.get("typing_indicator"):
                return responder(self, {"success": True})
            if corpo.get("to") in fora_da_janela:
                return responder(self, {"error": {"code": 131047, "message": "Re-engagement message", "error_subcode": 2494010}}, 400)
            return responder(self, {"messaging_product": "whatsapp", "contacts": [{"wa_id": corpo.get("to")}], "messages": [{"id": f"wamid.saida{len(meta)}"}]})
        responder(self, {"error": {"message": "rota falsa desconhecida"}}, 404)


meta_srv = servir(Meta)
META_BASE = f"http://127.0.0.1:{meta_srv.server_address[1]}"

# ---------------------------------------------------------------- 1. o plugin no Hermes
sys.path.insert(0, "/opt/hermes")
import gateway.platforms.whatsapp_cloud as wcmod  # noqa: E402

check("imagem: o WhatsApp oficial tem o que precisa (aiohttp e httpx, sem PyPI no primeiro uso)", wcmod.check_whatsapp_cloud_requirements())
wcmod.GRAPH_API_BASE = META_BASE  # o adaptador fala com a Meta falsa

copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "enable", "ergon_bridge"], capture_output=True, text=True, timeout=180)
check("hermes plugins enable ergon_bridge", r.returncode == 0, (r.stdout + r.stderr)[-600:])

from hermes_cli.plugins import discover_plugins, get_plugin_manager  # noqa: E402

discover_plugins()
pm = get_plugin_manager()
fab = pm.get_platform_handler_factories("whatsapp_cloud")
check("fábrica do WhatsApp oficial registrada", len(fab) == 1 and fab[0][0].__name__ == "_fabrica_whatsapp_cloud", str(fab))
b = sys.modules[fab[0][0].__module__]
check("capacidade 'canais_whatsapp_cloud' anunciada ao Ergon (e as de antes)", "canais_whatsapp_cloud" in b.CAPACIDADES and "canais_wecom_weixin" in b.CAPACIDADES)
check("versão do plugin 0.13.0", b.PLUGIN_VERSION == "0.13.0")
check("trava: o WhatsApp oficial segue o caminho do Ergon (pre_gateway_dispatch), não é consumido na admissão", asyncio.run(b.on_admission(platform="whatsapp_cloud")) is None)
laco_de_verdade = b._canal_laco
b._canal_laco = lambda: None  # a busca da saída começa na parte 4

# ---------------------------------------------------------------- 2. ponte de controle: as credenciais
reinicios = []
b._canal_reiniciar = lambda: (reinicios.append("reinício"), True)[1]
ctrl = servir(b._ControlHandler)
BASE = f"http://127.0.0.1:{ctrl.server_address[1]}"


def ponte(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-Ergon-Bridge-Token": PONTE})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


env_path = os.path.join(HOME, ".env")
lido = lambda: open(env_path).read().replace('"', "").replace("'", "") if os.path.exists(env_path) else ""  # noqa: E731
certo = {"phone_number_id": NUMERO, "access_token": TOKEN, "app_secret": SEGREDO, "waba_id": WABA, "verify_token": VERIFY}
st, j = ponte("PUT", "/ergon/v1/canais/whatsapp_cloud", {**certo, "app_secret": "curto"})
check("ponte: App Secret com formato errado é recusado, nada gravado", st == 400 and j.get("code") == "formato" and "WHATSAPP_CLOUD" not in lido(), str((st, j)))
st, j = ponte("PUT", "/ergon/v1/canais/whatsapp_cloud", certo)
env = lido()
check("ponte: WhatsApp oficial aceito, no .env do motor, com o servidor do adaptador só em 127.0.0.1, e o gateway reinicia",
      st == 200 and j.get("reiniciando") is True and f"WHATSAPP_CLOUD_PHONE_NUMBER_ID={NUMERO}" in env and f"WHATSAPP_CLOUD_ACCESS_TOKEN={TOKEN}" in env
      and f"WHATSAPP_CLOUD_APP_SECRET={SEGREDO}" in env and f"WHATSAPP_CLOUD_WABA_ID={WABA}" in env and f"WHATSAPP_CLOUD_VERIFY_TOKEN={VERIFY}" in env
      and "WHATSAPP_CLOUD_WEBHOOK_HOST=127.0.0.1" in env and "WHATSAPP_CLOUD_DM_POLICY=pairing" in env and "WHATSAPP_CLOUD_GROUP_POLICY=disabled" in env and reinicios[-1:] == ["reinício"], str((st, j)))
st, j = ponte("GET", "/ergon/v1/canais")
bruto = json.dumps(j)
check("ponte: a situação diz que está configurado e NUNCA devolve o token nem o App Secret",
      st == 200 and j["canais"]["whatsapp_cloud"]["configurado"] is True and TOKEN not in bruto and SEGREDO not in bruto, bruto[:400])
prog = ("import sys; sys.path.insert(0, '/opt/hermes')\nfrom gateway.config import load_gateway_config, Platform\nc = load_gateway_config()\n"
        "pc = c.platforms.get(Platform.WHATSAPP_CLOUD)\nprint(bool(pc and pc.enabled), (pc.extra or {}).get('webhook_host') if pc else None)")
r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=120, env={**os.environ})
check("gateway do Hermes: com o .env, o whatsapp_cloud fica ligado e escuta só em 127.0.0.1", "True 127.0.0.1" in r.stdout, (r.stdout + r.stderr)[-800:])

# ---------------------------------------------------------------- 3. o adaptador do Hermes, ligado à Meta falsa
from gateway.config import PlatformConfig  # noqa: E402
from gateway.pairing import PairingStore  # noqa: E402
from gateway.run import GatewayRunner  # noqa: E402

runner = object.__new__(GatewayRunner)
runner.pairing_store = PairingStore()


async def ao_gateway(event):
    await runner._hm_pre_gateway_dispatch_hook(event, event.source)
    return None


with socket.socket() as _s:
    _s.bind(("127.0.0.1", 0))
    PORTA = _s.getsockname()[1]
wa_loop = asyncio.new_event_loop()
threading.Thread(target=wa_loop.run_forever, daemon=True).start()
wa = wcmod.WhatsAppCloudAdapter(PlatformConfig(enabled=True, extra={
    "phone_number_id": NUMERO, "access_token": TOKEN, "app_secret": SEGREDO, "waba_id": WABA, "verify_token": VERIFY,
    "webhook_host": "127.0.0.1", "webhook_port": PORTA, "dm_policy": "pairing", "group_policy": "disabled"}))
wa.set_message_handler(ao_gateway)
ligou = asyncio.run_coroutine_threadsafe(wa.connect(), wa_loop).result(60)
check("WhatsApp: o adaptador do Hermes liga (saída pela Graph API; o servidor dele só em 127.0.0.1)", ligou is True and wa._webhook_host == "127.0.0.1", str(ligou))
check("WhatsApp: o adaptador vivo guardado para a saída (fábrica do plugin)", b._canal_vivos.get("whatsapp_cloud", {}).get("adapter") is wa)

n_msg = [0]


def notificacao(texto, de=DONA, nome="Priya", phone=NUMERO):
    n_msg[0] += 1
    return json.dumps({"object": "whatsapp_business_account", "entry": [{"id": WABA, "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "15550001234", "phone_number_id": phone},
        "contacts": [{"profile": {"name": nome}, "wa_id": de}],
        "messages": [{"from": de, "id": f"wamid.entrada{n_msg[0]:04d}", "timestamp": str(int(time.time())), "type": "text", "text": {"body": texto}}]}}]}]},
        ensure_ascii=False).encode()


def assinar(raw, segredo=SEGREDO):
    return "sha256=" + hmac.new(segredo.encode(), raw, hashlib.sha256).hexdigest()


n_item = [0]


def webhook(raw, assinatura=None):
    """O que o Ergon entrega pela saída: o corpo cru (base64) e a assinatura que a Meta mandou ao relé."""
    n_item[0] += 1
    ident = f"whk_teste{n_item[0]:04d}"
    saida.append({"id": ident, "canal": "whatsapp_cloud", "tipo": "webhook", "chat_id": "", "user_id": "",
                  "corpo": base64.b64encode(raw).decode(), "assinatura": assinatura or assinar(raw)})
    return ident


def ack(ident):
    return next((a for a in acks if a.get("id") == ident), None)


def textos_meta(para=None):
    return [c.get("text", {}).get("body", "") for m_, p, _a, c in meta if p.endswith("/messages") and c.get("type") == "text" and (para is None or c.get("to") == para)]


threading.Thread(target=laco_de_verdade, daemon=True).start()

# assinatura que não confere (não veio da Meta, ou o App Secret é outro): recusada, nada chega a ninguém
raw = notificacao("mensagem forjada", de=ESTRANHO)
falsa = webhook(raw, assinar(raw, segredo="f" * 32))
check("WhatsApp: assinatura errada é recusada pelo plugin (ack 'assinatura', definitivo), nada ao Ergon nem à Meta",
      ate(lambda: ack(falsa) is not None, 30) and ack(falsa).get("ok") is False and ack(falsa).get("erro") == "assinatura"
      and not ack(falsa).get("passageiro") and not recebidos and not textos_meta(), str((ack(falsa), recebidos, textos_meta())))
alterada = webhook(notificacao("outra", de=ESTRANHO), assinar(b"corpo diferente"))
check("WhatsApp: o corpo mudado depois de assinado também é recusado", ate(lambda: ack(alterada) is not None, 20) and ack(alterada).get("erro") == "assinatura")

# quem não está ligado: o código, também em hindi
primeira = webhook(notificacao("नमस्ते"))
check("WhatsApp: a notificação assinada é aceita", ate(lambda: ack(primeira) is not None, 20) and ack(primeira).get("ok") is True, str(ack(primeira)))
check("WhatsApp: quem não está ligado recebe o código pela Graph API, com o token, também em hindi (टीम से बात करें)",
      ate(lambda: any("टीम से बात करें" in t for t in textos_meta(DONA)), 20) and not recebidos
      and all(a == f"Bearer {TOKEN}" for _m, p, a, _c in meta if p.endswith("/messages")), json.dumps(textos_meta(), ensure_ascii=False)[:600])
m = re.search(r"Ergon: ([A-Z0-9]{8})", "".join(textos_meta(DONA)))
pend = runner.pairing_store.list_pending("whatsapp_cloud")
check("WhatsApp: é o pareamento nativo do gateway (pedido pendente com o wa_id)", len(pend) == 1 and pend[0]["user_id"] == DONA and m is not None, str(pend))
st, j = ponte("POST", "/ergon/v1/canais/whatsapp_cloud/parear", {"codigo": m.group(1) if m else "x"})
check("ponte: o código liga o número (a conversa é o próprio wa_id)", st == 200 and j.get("user_id") == DONA and j.get("chat_id") == DONA, str((st, j)))
runner.pairing_store = PairingStore()

hindi = webhook(notificacao("कल की बिक्री रिपोर्ट भेजो"))
check("WhatsApp: a mensagem em hindi chega ao Ergon com quem, onde e o quê (sem turno do Hermes)",
      ate(lambda: any(r_.get("canal") == "whatsapp_cloud" for r_ in recebidos), 20) and recebidos[-1].get("user_id") == DONA
      and recebidos[-1].get("chat_id") == DONA and recebidos[-1].get("text") == "कल की बिक्री रिपोर्ट भेजो" and recebidos[-1].get("user_name") == "Priya", str(recebidos))
# o relé entrega pelo menos uma vez: a mesma notificação (o mesmo wamid) de novo não vira um segundo pedido
raw_dup = notificacao("उसी संदेश की दूसरी प्रति")
d1 = webhook(raw_dup)
check("WhatsApp: a primeira cópia chega", ate(lambda: any(r_.get("text") == "उसी संदेश की दूसरी प्रति" for r_ in recebidos), 20))
n_antes = len(recebidos)
d2 = webhook(raw_dup)
check("WhatsApp: a segunda cópia (mesmo wamid) é aceita e descartada pelo adaptador, sem pedido repetido",
      ate(lambda: ack(d2) is not None, 20) and (time.sleep(0.8) or len(recebidos) == n_antes), str(recebidos[n_antes:]))
outro_numero = webhook(notificacao("de outro número da conta", phone="5555555" + "5555555"))
time.sleep(1.0)
check("WhatsApp: notificação de outro Phone Number ID (o mesmo app com dois números) é ignorada",
      ate(lambda: ack(outro_numero) is not None, 20) and not [r_ for r_ in recebidos[n_antes:] if r_.get("text") == "de outro número da conta"])

# ---------------------------------------------------------------- 4. a saída: buscada no Ergon, mandada à Meta
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
fora_da_janela.add(ESTRANHO)
antes = len(meta)
saida.extend([
    {"id": "w1", "canal": "whatsapp_cloud", "tipo": "texto", "chat_id": DONA, "user_id": DONA, "texto": "**Aristóteles:** कल की बिक्री ₹12,34,567 रही।"},
    {"id": "w2", "canal": "whatsapp_cloud", "tipo": "cartao", "chat_id": DONA, "user_id": DONA, "texto": "आपकी प्रतीक्षा में\nरूटीन बनाएँ?\n\nमंज़ूरी के लिए Ergon खोलें।", "botoes": [["Aprovar", "a:apr_" + "3" * 32]]},
    {"id": "w3", "canal": "whatsapp_cloud", "tipo": "editar", "chat_id": DONA, "user_id": DONA, "message_id": "x", "texto": "रूटीन बनाएँ?\nErgon में मंज़ूर।"},
    {"id": "w4", "canal": "whatsapp_cloud", "tipo": "imagem", "chat_id": DONA, "user_id": DONA, "texto": "बिक्री", "png": PNG},
    {"id": "w5", "canal": "whatsapp_cloud", "tipo": "texto", "chat_id": ESTRANHO, "user_id": ESTRANHO, "texto": "aviso fora da janela"},
])
check("saída: os itens foram confirmados ao Ergon", ate(lambda: {"w1", "w2", "w3", "w4", "w5"} <= {a.get("id") for a in acks}, 40), str(acks[-6:]))
por_id = {a.get("id"): a for a in acks}
novos = meta[antes:]
texto = json.dumps([c for *_x, c in novos], ensure_ascii=False)
check("saída: o texto sai pela Graph API, para o wa_id certo", "12,34,567" in texto and por_id.get("w1", {}).get("ok") is True
      and any(c.get("to") == DONA and c.get("type") == "text" for *_x, c in novos), texto[:500])
check("saída: o cartão vai como texto, sem botões (a decisão é no app)", "रूटीन बनाएँ" in texto and "apr_" not in texto and por_id.get("w2", {}).get("ok") is True)
check("saída: a linha final do cartão vai como mensagem nova (a Cloud API não edita)", "Ergon में मंज़ूर" in texto and por_id.get("w3", {}).get("ok") is True)
check("saída: a imagem do visual sobe pelo /media e vai como imagem", any(p.endswith("/media") for _m, p, _a, _c in novos)
      and any(c.get("type") == "image" for *_x, c in novos) and por_id.get("w4", {}).get("ok") is True, str(por_id.get("w4")))
check("saída: fora da janela de 24 h da Meta (131047), o aviso não fica tentando (sem_sessao, não passageiro)",
      por_id.get("w5", {}).get("ok") is False and por_id.get("w5", {}).get("erro") == "sem_sessao" and not por_id.get("w5", {}).get("passageiro"), str(por_id.get("w5")))

# ---------------------------------------------------------------- 5. desligar
try:
    asyncio.run_coroutine_threadsafe(wa.disconnect(), wa_loop).result(30)
except Exception:  # noqa: BLE001
    pass
st, j = ponte("DELETE", "/ergon/v1/canais/whatsapp_cloud")
check("desligar: nada do WhatsApp oficial no .env (token, App Secret, verify token) e a ligação some",
      st == 200 and "WHATSAPP_CLOUD" not in lido() and PairingStore().list_approved("whatsapp_cloud") == [], lido())

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.stdout.flush()
os._exit(0 if ok else 1)

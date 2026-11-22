"""rc.46: conversar com a equipe pelo WeCom (企业微信, o robô inteligente) e pelo WeChat pessoal (微信, iLink, experimental):
o plugin do Ergon com o Hermes de verdade, dentro da imagem do motor, sem rede e com credenciais de mentira.

Servidores falsos no lugar de cada plataforma: o "WeCom" é um WebSocket que faz o papel de openws.work.weixin.qq.com
(aibot_subscribe com o Bot ID e o Secret, o aibot_msg_callback empurrado, as respostas aibot_respond_msg/aibot_send_msg
e o envio de imagem em partes); o "iLink" responde ao QR do login (get_bot_qrcode, get_qrcode_status: wait, scaned,
confirmed; e expired), à espera longa das mensagens (getupdates) e ao envio (sendmessage). O "Ergon" falso recebe a
entrada e entrega a saída, como no teste do Feishu e do DingTalk (test_ergon_bridge_canais_china.py).

Confere: as fábricas e a capacidade; a ponte guarda o Bot ID e o Secret do WeCom no .env do motor (nunca devolve o
Secret) e o gateway liga o WeCom pelo WebSocket de saída; o adaptador do Hermes conecta ao WeCom falso, quem não está
ligado recebe o código (também em chinês), e, depois de ligar, a mensagem em chinês chega ao Ergon sem turno do Hermes;
o login do WeChat pelo QR (o endereço do QR vai ao Ergon, o token nunca), confirmado, grava a conta no .env e reinicia o
gateway; o QR vencido 4 vezes termina como "expirado"; a mensagem pelo iLink chega ao Ergon depois do pareamento; a
saída (texto, cartão como texto, a linha final do cartão como mensagem nova, a imagem só no WeCom) sai pela plataforma
falsa; desligar apaga tudo (inclusive o arquivo da conta do WeChat, com o token).

  docker run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_canais_wecom_weixin.py
"""
import asyncio
import base64
import faulthandler
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME
for var in ("WECOM_BOT_ID", "WECOM_SECRET", "WECOM_WEBSOCKET_URL", "WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID", "WEIXIN_BASE_URL",
            "GATEWAY_ALLOW_ALL_USERS", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY"):
    os.environ.pop(var, None)
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["HERMES_WECOM_TEXT_BATCH_DELAY_SECONDS"] = "0.1"
# credenciais de exemplo, montadas por partes
PONTE = "ponte-" + "de-teste-" + "0123456789abcdef"
WC_ID = "aib" + "Qx7Lm2Np9Rs4Tv"
WC_SEGREDO = "Sc" + "rT8w" * 8
WX_CONTA = "e1f2a3b4c5d6" + "@im.bot"
WX_TOKEN = "tok" + "en-de-mentira-" + "9f8e7d6c5b4a"
DONA_WC = "ZhangWei"
DONA_WX = "o9cq80" + "0kum_x7Y2bQ" + "@im.wechat"
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

# ---------------------------------------------------------------- 1. o plugin no Hermes
sys.path.insert(0, "/opt/hermes")
from pm.extras import available  # noqa: E402

check("imagem: o WeCom tem o que precisa (sem PyPI no primeiro uso)", available("wecom"))
import websockets  # noqa: E402

copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "enable", "ergon_bridge"], capture_output=True, text=True, timeout=180)
check("hermes plugins enable ergon_bridge", r.returncode == 0, (r.stdout + r.stderr)[-600:])

from hermes_cli.plugins import discover_plugins, get_plugin_manager  # noqa: E402

discover_plugins()
pm = get_plugin_manager()
fab_wc = pm.get_platform_handler_factories("wecom")
fab_wx = pm.get_platform_handler_factories("weixin")
check("fábrica do WeCom registrada", len(fab_wc) == 1 and fab_wc[0][0].__name__ == "_fabrica_wecom", str(fab_wc))
check("fábrica do WeChat registrada", len(fab_wx) == 1 and fab_wx[0][0].__name__ == "_fabrica_weixin", str(fab_wx))
b = sys.modules[fab_wc[0][0].__module__]
check("capacidade 'canais_wecom_weixin' anunciada ao Ergon", "canais_wecom_weixin" in b.CAPACIDADES and "canais_feishu_dingtalk" in b.CAPACIDADES)
check("trava: o WeCom e o WeChat seguem o caminho do Ergon (pre_gateway_dispatch), não são consumidos na admissão",
      all(asyncio.run(b.on_admission(platform=p)) is None for p in ("wecom", "weixin")))
check("trava: o modo app próprio do WeCom (wecom_callback, que pede URL pública) continua fora", asyncio.run(b.on_admission(platform="wecom_callback")) == {"action": "handled"})
laco_de_verdade = b._canal_laco
b._canal_laco = lambda: None  # a busca da saída começa na parte 6

# ---------------------------------------------------------------- 2. ponte de controle: o Bot ID e o Secret do WeCom
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
st, j = ponte("PUT", "/ergon/v1/canais/wecom", {"app_id": "curto", "app_secret": WC_SEGREDO})
check("ponte: Bot ID com formato errado é recusado, nada gravado", st == 400 and j.get("code") == "formato" and "WECOM_BOT_ID" not in lido(), str((st, j)))
st, j = ponte("PUT", "/ergon/v1/canais/wecom", {"app_id": WC_ID, "app_secret": WC_SEGREDO})
check("ponte: WeCom aceito, no .env do motor, e o gateway reinicia",
      st == 200 and j.get("reiniciando") is True and f"WECOM_BOT_ID={WC_ID}" in lido() and f"WECOM_SECRET={WC_SEGREDO}" in lido() and reinicios[-1:] == ["reinício"], str((st, j)))
st, j = ponte("PUT", "/ergon/v1/canais/weixin", {"app_id": WC_ID, "app_secret": WC_SEGREDO})
check("ponte: o WeChat pessoal não aceita credencial colada (só o login por QR)", st == 400 and j.get("code") == "qr", str((st, j)))
st, j = ponte("GET", "/ergon/v1/canais")
bruto = json.dumps(j)
check("ponte: a situação diz que o WeCom está configurado, o WeChat não, e NUNCA devolve o Secret",
      st == 200 and j["canais"]["wecom"]["configurado"] is True and j["canais"]["weixin"]["configurado"] is False and WC_SEGREDO not in bruto, bruto)
prog = ("import sys; sys.path.insert(0, '/opt/hermes')\nfrom gateway.config import load_gateway_config, Platform\nc = load_gateway_config()\n"
        "ps = sorted(p.value for p, pc in c.platforms.items() if pc.enabled and p in (Platform.WECOM, Platform.WECOM_CALLBACK, Platform.WEIXIN))\nprint(ps)")
r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=120, env={**os.environ})
check("gateway do Hermes: com o .env, só o WeCom (robô) fica ligado; o modo app próprio não", "['wecom']" in r.stdout, (r.stdout + r.stderr)[-800:])

# ---------------------------------------------------------------- 3. o WeCom falso (WebSocket do robô)
from gateway.config import Platform, PlatformConfig  # noqa: E402
from gateway.pairing import PairingStore  # noqa: E402
from gateway.run import GatewayRunner  # noqa: E402

ws_loop = asyncio.new_event_loop()
threading.Thread(target=ws_loop.run_forever, daemon=True).start()
wc_conexoes, wc_quadros = [], []  # o que o adaptador mandou ao "WeCom"


async def _ws_wecom(conn):
    wc_conexoes.append(conn)
    try:
        async for bruto_q in conn:
            q = json.loads(bruto_q)
            wc_quadros.append(q)
            req_id = (q.get("headers") or {}).get("req_id", "")
            cmd = q.get("cmd")
            corpo = {}
            if cmd == "aibot_subscribe":
                b_ = q.get("body") or {}
                if b_.get("bot_id") != WC_ID or b_.get("secret") != WC_SEGREDO:
                    await conn.send(json.dumps({"headers": {"req_id": req_id}, "errcode": 40001, "errmsg": "invalid credential"}))
                    continue
            elif cmd == "aibot_upload_media_init":
                corpo = {"upload_id": "up_1"}
            elif cmd == "aibot_upload_media_finish":
                corpo = {"media_id": "media_falsa_1", "type": "image"}
            await conn.send(json.dumps({"headers": {"req_id": req_id}, "errcode": 0, "errmsg": "ok", "body": corpo}))
    except Exception:  # noqa: BLE001
        pass


async def _subir_ws(tratador):
    return await websockets.serve(tratador, "127.0.0.1", 0)


ws_wc = asyncio.run_coroutine_threadsafe(_subir_ws(_ws_wecom), ws_loop).result(10)
WS_WC = list(ws_wc.sockets)[0].getsockname()[1]
n_cb = [0]


def empurrar_wecom(texto, user=DONA_WC):
    n_cb[0] += 1
    quadro = {"cmd": "aibot_msg_callback", "headers": {"req_id": f"cb_req_{n_cb[0]}"},
              "body": {"msgid": f"wc_msg_{n_cb[0]}", "aibotid": WC_ID, "chattype": "single", "from": {"userid": user},
                       "msgtype": "text", "text": {"content": texto}}}
    asyncio.run_coroutine_threadsafe(wc_conexoes[-1].send(json.dumps(quadro, ensure_ascii=False)), ws_loop).result(10)
    return f"cb_req_{n_cb[0]}"


def textos_wecom(cmd=None):
    out = []
    for q in wc_quadros:
        if cmd and q.get("cmd") != cmd:
            continue
        corpo = q.get("body") or {}
        md = (corpo.get("markdown") or {}).get("content") or (corpo.get("text") or {}).get("content") or (corpo.get("stream") or {}).get("content") or ""
        if md:
            out.append((q.get("cmd"), (q.get("headers") or {}).get("req_id"), corpo.get("chatid"), md))
    return out


runner = object.__new__(GatewayRunner)
runner.pairing_store = PairingStore()


async def ao_gateway(event):
    await runner._hm_pre_gateway_dispatch_hook(event, event.source)
    return None


from plugins.platforms.wecom.adapter import WeComAdapter  # noqa: E402

wc_loop = asyncio.new_event_loop()
threading.Thread(target=wc_loop.run_forever, daemon=True).start()
wc = WeComAdapter(PlatformConfig(enabled=True, extra={"bot_id": WC_ID, "secret": WC_SEGREDO, "websocket_url": f"ws://127.0.0.1:{WS_WC}"}))
wc.set_message_handler(ao_gateway)
ligou = asyncio.run_coroutine_threadsafe(wc.connect(), wc_loop).result(60)
assinatura = next((q for q in wc_quadros if q.get("cmd") == "aibot_subscribe"), {})
check("WeCom: o adaptador do Hermes conecta ao WeCom falso pelo WebSocket de saída, com o Bot ID e o Secret (sem endereço público)",
      ligou is True and len(wc_conexoes) == 1 and (assinatura.get("body") or {}).get("bot_id") == WC_ID, str((ligou, assinatura)))
check("WeCom: o adaptador vivo guardado para a saída (fábrica do plugin)", b._canal_vivos.get("wecom", {}).get("adapter") is wc)

req1 = empurrar_wecom("你好")
check("WeCom: quem não está ligado recebe o código como resposta à mensagem (aibot_respond_msg), também em chinês (通过企业微信与团队对话)",
      ate(lambda: any(t[0] == "aibot_respond_msg" and "通过企业微信与团队对话" in t[3] for t in textos_wecom()), 20) and not recebidos,
      json.dumps(textos_wecom(), ensure_ascii=False)[:600])
txt_codigo = next((t[3] for t in textos_wecom() if "Ergon: " in t[3]), "")
m = re.search(r"Ergon: ([A-Z0-9]{8})", txt_codigo)
pend = runner.pairing_store.list_pending("wecom")
check("WeCom: é o pareamento nativo do gateway (pedido pendente com o userid)", len(pend) == 1 and pend[0]["user_id"] == DONA_WC and m is not None, str(pend))
st, j = ponte("POST", "/ergon/v1/canais/wecom/parear", {"codigo": m.group(1) if m else "x"})
check("ponte: o código liga a conta do WeCom e devolve a conversa (o próprio userid, na conversa direta)", st == 200 and j.get("user_id") == DONA_WC and j.get("chat_id") == DONA_WC, str((st, j)))
runner.pairing_store = PairingStore()
empurrar_wecom("请帮我整理本周的客户跟进")
check("WeCom: a mensagem em chinês chega ao Ergon com quem, onde e o quê", ate(lambda: any(r.get("canal") == "wecom" for r in recebidos), 20)
      and recebidos[-1].get("user_id") == DONA_WC and recebidos[-1].get("chat_id") == DONA_WC and recebidos[-1].get("text") == "请帮我整理本周的客户跟进", str(recebidos))
n_antes, q_antes = len(recebidos), len(wc_quadros)
n_cb[0] += 1
grupo = {"cmd": "aibot_msg_callback", "headers": {"req_id": f"cb_req_{n_cb[0]}"},
         "body": {"msgid": f"wc_msg_{n_cb[0]}", "aibotid": WC_ID, "chattype": "group", "chatid": "wrGrupo" + "Abc123", "from": {"userid": DONA_WC},
                  "msgtype": "text", "text": {"content": "@Ergon 群里的消息"}}}
asyncio.run_coroutine_threadsafe(wc_conexoes[-1].send(json.dumps(grupo, ensure_ascii=False)), ws_loop).result(10)
time.sleep(1.5)
check("WeCom: a mensagem num grupo não passa (só a conversa direta), nem de quem está ligado", len(recebidos) == n_antes
      and not [q for q in wc_quadros[q_antes:] if q.get("cmd") in ("aibot_respond_msg", "aibot_send_msg")], str(recebidos[n_antes:]))

# ---------------------------------------------------------------- 4. o iLink falso (QR do login, espera longa, envio)
il_pedidos, il_enviados, il_pendentes = [], [], []
il_status = {"fila": []}


class ILink(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_GET(self):  # noqa: N802
        u = urlsplit(self.path)
        il_pedidos.append(("GET", u.path, parse_qs(u.query)))
        if u.path == "/ilink/bot/get_bot_qrcode":
            n = sum(1 for p in il_pedidos if p[1] == u.path)
            return responder(self, {"qrcode": f"qr{n:04d}", "qrcode_img_content": f"https://liteapp.weixin.qq.com/q/falso{n:04d}?qrcode=qr{n:04d}&bot_type=3"})
        if u.path == "/ilink/bot/get_qrcode_status":
            time.sleep(0.2)
            st_ = il_status["fila"].pop(0) if il_status["fila"] else {"status": "wait"}
            return responder(self, st_)
        responder(self, {"ret": 0})

    def do_POST(self):  # noqa: N802
        u = urlsplit(self.path)
        corpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        il_pedidos.append(("POST", u.path, corpo, self.headers.get("Authorization")))
        if u.path == "/ilink/bot/getupdates":
            fim = time.time() + 1.0
            while not il_pendentes and time.time() < fim:
                time.sleep(0.05)
            msgs = [il_pendentes.pop(0)] if il_pendentes else []
            return responder(self, {"ret": 0, "msgs": msgs, "get_updates_buf": f"buf{len(il_pedidos)}", "longpolling_timeout_ms": 2000})
        if u.path == "/ilink/bot/sendmessage":
            il_enviados.append(corpo.get("msg") or {})
            return responder(self, {"ret": 0})
        if u.path == "/ilink/bot/getconfig":
            return responder(self, {"ret": 0, "typing_ticket": "ticket-falso"})
        responder(self, {"ret": 0})


ilink = servir(ILink)
IL_BASE = f"http://127.0.0.1:{ilink.server_address[1]}"
import gateway.platforms.weixin as wxmod  # noqa: E402

wxmod.ILINK_BASE_URL = IL_BASE  # o login por QR fala com o iLink falso

# o login pelo QR: o endereço vai ao Ergon (que desenha o QR); escaneado e confirmado, a conta vai ao .env
reinicios.clear()
il_status["fila"] = [{"status": "wait"}, {"status": "scaned"}, {"status": "scaned"}, {"status": "scaned"}, {"status": "scaned"},
                     {"status": "confirmed", "ilink_bot_id": WX_CONTA, "bot_token": WX_TOKEN, "baseurl": IL_BASE, "ilink_user_id": DONA_WX}]
st, j = ponte("POST", "/ergon/v1/canais/weixin/qr", {})
check("WeChat: o QR do login vem do iLink, com o endereço para desenhar na tela (liteapp) e o prazo",
      st == 200 and j.get("estado") == "aguardando" and j.get("qr", "").startswith("https://liteapp.weixin.qq.com/q/falso0001") and 400 < j.get("expira_em", 0) <= 480, str((st, j)))
check("WeChat: o escaneado aparece antes de confirmar", ate(lambda: ponte("GET", "/ergon/v1/canais/weixin/qr")[1].get("estado") == "escaneado", 15))
check("WeChat: confirmado no celular, o estado vira 'confirmado' e o gateway reinicia",
      ate(lambda: ponte("GET", "/ergon/v1/canais/weixin/qr")[1].get("estado") == "confirmado", 20) and reinicios == ["reinício"], str((ponte("GET", "/ergon/v1/canais/weixin/qr"), reinicios)))
env = lido()
st, j = ponte("GET", "/ergon/v1/canais/weixin/qr")
st2, j2 = ponte("GET", "/ergon/v1/canais")
check("WeChat: a conta e o token no .env do motor, só conversa direta com pareamento, e o token NUNCA volta pela ponte",
      f"WEIXIN_ACCOUNT_ID={WX_CONTA}" in env and f"WEIXIN_TOKEN={WX_TOKEN}" in env and "WEIXIN_DM_POLICY=pairing" in env and "WEIXIN_GROUP_POLICY=disabled" in env
      and WX_TOKEN not in json.dumps(j) and WX_TOKEN not in json.dumps(j2) and j.get("qr") == "" and j2["canais"]["weixin"]["configurado"] is True, env)
check("WeChat: o arquivo da conta do Hermes também foi gravado (o adaptador acha o token depois de reiniciar)",
      os.path.exists(os.path.join(HOME, "weixin", "accounts", f"{WX_CONTA}.json")))

# QR vencido mais de 3 vezes: termina como "expirado", sem gravar nada novo
reinicios.clear()
il_status["fila"] = [{"status": "expired"}] * 4
st, j = ponte("POST", "/ergon/v1/canais/weixin/qr", {})
check("WeChat: um QR novo a cada pedido", j.get("qr", "").startswith("https://liteapp.weixin.qq.com/q/falso0002"), str(j))
check("WeChat: vencido 4 vezes (renovado 3), o login termina como 'expirado', sem reiniciar",
      ate(lambda: ponte("GET", "/ergon/v1/canais/weixin/qr")[1].get("estado") == "expirado", 20) and reinicios == []
      and sum(1 for p in il_pedidos if p[1] == "/ilink/bot/get_bot_qrcode") == 5, str(ponte("GET", "/ergon/v1/canais/weixin/qr")))
st, j = ponte("POST", "/ergon/v1/canais/weixin/qr", {})
st, j = ponte("DELETE", "/ergon/v1/canais/weixin/qr")
check("WeChat: cancelar o QR na tela para o acompanhamento", j.get("estado") == "parado" and j.get("qr") == "", str(j))

# o adaptador do Hermes com a conta confirmada: a espera longa no iLink falso
from gateway.platforms.weixin import WeixinAdapter  # noqa: E402

wx_loop = asyncio.new_event_loop()
threading.Thread(target=wx_loop.run_forever, daemon=True).start()
wx = WeixinAdapter(PlatformConfig(enabled=True, token=WX_TOKEN, extra={"account_id": WX_CONTA, "base_url": IL_BASE, "dm_policy": "pairing",
                                                                    "text_batch_delay_seconds": 0.1, "send_chunk_delay_seconds": 0}))
wx.set_message_handler(ao_gateway)
ligou = asyncio.run_coroutine_threadsafe(wx.connect(), wx_loop).result(60)
check("WeChat: o adaptador do Hermes conecta ao iLink falso (espera longa, com o token da conta)",
      ligou is True and ate(lambda: any(p[1] == "/ilink/bot/getupdates" and p[3] == f"Bearer {WX_TOKEN}" for p in il_pedidos if p[0] == "POST"), 15))
check("WeChat: o adaptador vivo guardado para a saída (fábrica do plugin)", b._canal_vivos.get("weixin", {}).get("adapter") is wx)
n_wx = [0]


def empurrar_weixin(texto, user=DONA_WX):
    n_wx[0] += 1
    il_pendentes.append({"message_id": 7000 + n_wx[0], "from_user_id": user, "to_user_id": WX_CONTA, "message_type": 1,
                         "context_token": f"ctx-{n_wx[0]}", "item_list": [{"type": 1, "text_item": {"text": texto}}]})


def textos_wx():
    return [json.dumps(m, ensure_ascii=False) for m in il_enviados]


empurrar_weixin("你好")
check("WeChat: quem não está ligado recebe o código (sendmessage, com o context_token), também em chinês (通过微信与团队对话)",
      ate(lambda: any("通过微信与团队对话" in t for t in textos_wx()), 20) and not [r for r in recebidos if r.get("canal") == "weixin"]
      and il_enviados and il_enviados[0].get("to_user_id") == DONA_WX and il_enviados[0].get("context_token") == "ctx-1", "\n".join(textos_wx())[:600])
m = re.search(r"Ergon: ([A-Z0-9]{8})", "".join(textos_wx()))
st, j = ponte("POST", "/ergon/v1/canais/weixin/parear", {"codigo": m.group(1) if m else "x"})
check("ponte: o código liga a conta do WeChat (…@im.wechat)", st == 200 and j.get("user_id") == DONA_WX and j.get("chat_id") == DONA_WX, str((st, j)))
runner.pairing_store = PairingStore()
empurrar_weixin("明天上午十点提醒我开会")
check("WeChat: a mensagem em chinês chega ao Ergon", ate(lambda: any(r.get("canal") == "weixin" and r.get("text") == "明天上午十点提醒我开会" for r in recebidos), 20),
      str(recebidos[-2:]))

# ---------------------------------------------------------------- 5. a saída: buscada no Ergon, mandada pela plataforma
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
il_enviados.clear()
antes_wc = len(wc_quadros)
saida.extend([
    {"id": "c1", "canal": "wecom", "tipo": "texto", "chat_id": DONA_WC, "user_id": DONA_WC, "texto": "**Aristóteles:** 本周共有 12 位客户待跟进。"},
    {"id": "c2", "canal": "wecom", "tipo": "cartao", "chat_id": DONA_WC, "user_id": DONA_WC, "texto": "需要你\n创建“客户跟进”例程？\n\n如需批准或拒绝，请打开 Ergon。", "botoes": [["Aprovar", "a:apr_" + "3" * 32]]},
    {"id": "c3", "canal": "wecom", "tipo": "editar", "chat_id": DONA_WC, "user_id": DONA_WC, "message_id": "x", "texto": "创建“客户跟进”例程？\n已在 Ergon 中批准。"},
    {"id": "c4", "canal": "wecom", "tipo": "imagem", "chat_id": DONA_WC, "user_id": DONA_WC, "texto": "客户", "png": PNG},
    {"id": "x1", "canal": "weixin", "tipo": "texto", "chat_id": DONA_WX, "user_id": DONA_WX, "texto": "**Aristóteles:** 好的，明天 10:00 提醒你。"},
    {"id": "x2", "canal": "weixin", "tipo": "cartao", "chat_id": DONA_WX, "user_id": DONA_WX, "texto": "需要你\n创建提醒？", "botoes": []},
    {"id": "x3", "canal": "weixin", "tipo": "imagem", "chat_id": DONA_WX, "user_id": DONA_WX, "texto": "图", "png": PNG},
])
threading.Thread(target=laco_de_verdade, daemon=True).start()
check("saída: os itens foram confirmados ao Ergon", ate(lambda: {"c1", "c2", "c3", "c4", "x1", "x2", "x3"} <= {a.get("id") for a in acks}, 40), str(acks))
por_id = {a.get("id"): a for a in acks}
novos_wc = [(q.get("cmd"), q) for q in wc_quadros[antes_wc:]]
texto_wc = json.dumps([q for _, q in novos_wc], ensure_ascii=False)
check("saída WeCom: o texto sai pelo WebSocket do robô, na conversa certa", "12 位客户" in texto_wc and por_id.get("c1", {}).get("ok") is True, texto_wc[:600])
check("saída WeCom: o cartão vai como texto, sem botões (a decisão é no app)", "客户跟进" in texto_wc and por_id.get("c2", {}).get("ok") is True
      and "apr_" not in texto_wc and "template_card" not in texto_wc)
check("saída WeCom: a linha final do cartão vai como mensagem nova (o WeCom não edita)", "已在 Ergon 中批准" in texto_wc and por_id.get("c3", {}).get("ok") is True)
check("saída WeCom: a imagem do visual sobe em partes e vai como imagem", any(c == "aibot_upload_media_finish" for c, _ in novos_wc)
      and "media_falsa_1" in texto_wc and por_id.get("c4", {}).get("ok") is True, str((por_id.get("c4"), [c for c, _ in novos_wc])))
texto_wx = "\n".join(textos_wx())
check("saída WeChat: o texto sai pelo iLink, com o context_token da última mensagem", "10:00" in texto_wx and por_id.get("x1", {}).get("ok") is True
      and all(m.get("context_token") == "ctx-2" for m in il_enviados), texto_wx[:600])
check("saída WeChat: o cartão vai como texto", "创建提醒" in texto_wx and por_id.get("x2", {}).get("ok") is True)
check("saída WeChat: a imagem não vai (menos envio, menos risco), sem falha", por_id.get("x3", {}).get("ok") is True
      and "image_item" not in texto_wx and not any(p[1] == "/ilink/bot/getuploadurl" for p in il_pedidos), str((por_id.get("x3"), texto_wx[:300])))

# ---------------------------------------------------------------- 6. desligar
for _ad, _lp in ((wc, wc_loop), (wx, wx_loop)):
    try:
        asyncio.run_coroutine_threadsafe(_ad.disconnect(), _lp).result(30)
    except Exception:  # noqa: BLE001
        pass
st, j = ponte("DELETE", "/ergon/v1/canais/wecom")
env = lido()
check("desligar o WeCom: Bot ID e Secret saem do .env, a ligação some, o WeChat fica",
      st == 200 and "WECOM_" not in env and "WEIXIN_TOKEN" in env and PairingStore().list_approved("wecom") == [] and len(PairingStore().list_approved("weixin")) == 1, env)
st, j = ponte("DELETE", "/ergon/v1/canais/weixin")
check("desligar o WeChat: o .env sem nada dele e o arquivo da conta (com o token) apagado",
      st == 200 and "WEIXIN_" not in lido() and PairingStore().list_approved("weixin") == []
      and not os.path.exists(os.path.join(HOME, "weixin", "accounts", f"{WX_CONTA}.json")), lido())

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.stdout.flush()
os._exit(0 if ok else 1)

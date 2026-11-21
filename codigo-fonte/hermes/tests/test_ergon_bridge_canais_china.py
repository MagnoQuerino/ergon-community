"""rc.45: conversar com a equipe pelo Feishu (ou Lark) e pelo DingTalk: o plugin do Ergon com o Hermes de verdade e os SDKs
que a imagem traz (lark-oapi e dingtalk-stream), dentro da imagem do motor, sem rede e com credenciais de mentira.

Servidores falsos no lugar de cada plataforma: o "Lark" responde à API aberta (token, dados do robô, conversa, envio,
edição e upload de imagem) e ao endereço da conexão persistente, e um WebSocket falso empurra o evento de mensagem
(im.message.receive_v1) no formato de quadro do SDK; o "DingTalk" abre a conexão do Stream Mode, empurra o CALLBACK do
robô e recebe as respostas pela sessionWebhook. O "Ergon" falso recebe a entrada e entrega a saída, como no teste do
Telegram e do Discord (test_ergon_bridge_canais.py).

Confere: os SDKs na imagem (instalados na construção: o primeiro uso, pelo PyPI, falha na China); o Hermes carrega as
fábricas do Feishu e do DingTalk; a ponte de controle guarda o App ID e o App Secret no .env do motor (o Lark com
FEISHU_DOMAIN=lark, por conexão persistente), nunca os devolve e apaga tudo ao desligar, e o gateway liga os dois canais;
o adaptador do Feishu conecta de verdade ao servidor falso (endereço da conexão persistente e WebSocket), a mensagem que
chega pelo WebSocket passa pelo adaptador e pelo gancho do gateway: quem não está ligado recebe o código de pareamento
(em chinês também), e, depois de ligar, a mensagem em chinês chega ao Ergon sem turno do Hermes; a saída (texto, cartão
como texto, edição, imagem) sai pela API do Feishu falso; o mesmo caminho no DingTalk pelo Stream Mode, com a resposta
pela sessionWebhook, o cartão sem botões e a sessão vencida dita como falha definitiva.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" ergon-hermes:dev /t/test_ergon_bridge_canais_china.py
"""
import asyncio
import base64
import faulthandler
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME
for var in ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_DOMAIN", "FEISHU_CONNECTION_MODE", "DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET",
            "GATEWAY_ALLOW_ALL_USERS", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY"):
    os.environ.pop(var, None)
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
# credenciais de exemplo, montadas por partes
PONTE = "ponte-" + "de-teste-" + "0123456789abcdef"
FS_ID = "cli_" + "a1b2c3d4e5f6a7b8"
FS_SEGREDO = "Xy" + "z9" * 15
DT_ID = "ding" + "abcdefgh12345678"
DT_SEGREDO = "Sg" + "-a1B2" * 10
DONA_FS, CHAT_FS = "ou_" + "7d8a6e6df7621556ce0d21922b676706", "oc_" + "5ad11d72b830411d72b836c20"
DONA_DT, CHAT_DT = "$:LWCP_v1:$" + "h8Nq+2Zp/9kWbBVc0ZqYhw==", "cid" + "Xp4Mz+0bJk1sWQ2Hq9N7lg=="
os.environ["ERGON_BRIDGE_TOKEN"] = PONTE
os.environ["ERGON_CONTROL_PORT"] = "0"

ok = True
faulthandler.dump_traceback_later(400, exit=True)  # nada de ficar preso: o teste inteiro leva menos de um minuto
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
    data = json.dumps(obj).encode()
    h.send_response(status); h.send_header("Content-Type", "application/json"); h.send_header("Content-Length", str(len(data))); h.end_headers()
    h.wfile.write(data)


# ---------------------------------------------------------------- o Ergon de mentira (entrada e saída dos canais)
recebidos, saida, acks = [], [], []
resposta_entrada = {"ok": True, "digitando": True}


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
            out = dict(resposta_entrada)
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

# ---------------------------------------------------------------- 1. os SDKs na imagem e o plugin no Hermes
sys.path.insert(0, "/opt/hermes")
from pm.extras import available  # noqa: E402

check("imagem: o lark-oapi (Feishu/Lark) já instalado, sem esperar o PyPI no primeiro uso", available("feishu"))
check("imagem: o dingtalk-stream (DingTalk) já instalado, sem esperar o PyPI no primeiro uso", available("dingtalk"))
import lark_oapi  # noqa: E402,F401
import dingtalk_stream  # noqa: E402
import websockets  # noqa: E402

copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "enable", "ergon_bridge"], capture_output=True, text=True, timeout=180)
check("hermes plugins enable ergon_bridge", r.returncode == 0, (r.stdout + r.stderr)[-600:])

from hermes_cli.plugins import discover_plugins, get_plugin_manager  # noqa: E402

discover_plugins()
pm = get_plugin_manager()
fab_fs = pm.get_platform_handler_factories("feishu")
fab_dt = pm.get_platform_handler_factories("dingtalk")
check("fábrica do Feishu registrada", len(fab_fs) == 1 and fab_fs[0][0].__name__ == "_fabrica_feishu", str(fab_fs))
check("fábrica do DingTalk registrada", len(fab_dt) == 1 and fab_dt[0][0].__name__ == "_fabrica_dingtalk", str(fab_dt))
b = sys.modules[fab_fs[0][0].__module__]
check("capacidade 'canais_feishu_dingtalk' anunciada ao Ergon", "canais_feishu_dingtalk" in b.CAPACIDADES and "canais" in b.CAPACIDADES, str(b.CAPACIDADES))
check("trava: o Feishu e o DingTalk seguem o caminho do Ergon (pre_gateway_dispatch), não são consumidos na admissão",
      all(asyncio.run(b.on_admission(platform=p)) is None for p in ("feishu", "dingtalk")))
laco_de_verdade = b._canal_laco
b._canal_laco = lambda: None  # a busca da saída começa na parte 5

# ---------------------------------------------------------------- 2. ponte de controle: App ID e App Secret no .env do motor
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
st, j = ponte("PUT", "/ergon/v1/canais/feishu", {"app_id": "app-errado", "app_secret": FS_SEGREDO})
check("ponte: App ID com formato errado é recusado", st == 400 and j.get("code") == "formato" and "formato" in j.get("error", ""), str((st, j)))
check("ponte: nada gravado depois da recusa", "FEISHU_APP_ID" not in lido())
st, j = ponte("PUT", "/ergon/v1/canais/feishu", {"app_id": FS_ID, "app_secret": FS_SEGREDO, "dominio": "lark"})
env = lido()
check("ponte: Lark aceito, no .env do motor, por conexão persistente, e o gateway reinicia",
      st == 200 and j.get("reiniciando") is True and f"FEISHU_APP_ID={FS_ID}" in env and f"FEISHU_APP_SECRET={FS_SEGREDO}" in env
      and "FEISHU_DOMAIN=lark" in env and "FEISHU_CONNECTION_MODE=websocket" in env and reinicios[-1:] == ["reinício"], str((st, j)))
st, j = ponte("PUT", "/ergon/v1/canais/dingtalk", {"app_id": DT_ID, "app_secret": DT_SEGREDO})
check("ponte: DingTalk aceito", st == 200 and f"DINGTALK_CLIENT_ID={DT_ID}" in lido() and f"DINGTALK_CLIENT_SECRET={DT_SEGREDO}" in lido(), str((st, j)))
st, j = ponte("GET", "/ergon/v1/canais")
bruto = json.dumps(j)
check("ponte: a situação diz que os dois estão configurados e NUNCA devolve o App Secret",
      st == 200 and j["canais"]["feishu"]["configurado"] is True and j["canais"]["dingtalk"]["configurado"] is True and j["canais"]["telegram"]["configurado"] is False
      and FS_SEGREDO not in bruto and DT_SEGREDO not in bruto, bruto)
prog = ("import sys; sys.path.insert(0, '/opt/hermes')\nfrom gateway.config import load_gateway_config, Platform\nc = load_gateway_config()\n"
        "ps = {p.value: pc for p, pc in c.platforms.items() if pc.enabled and p in (Platform.FEISHU, Platform.DINGTALK)}\n"
        "print(sorted(ps), (ps.get('feishu').extra or {}).get('domain') if 'feishu' in ps else None, (ps.get('feishu').extra or {}).get('connection_mode') if 'feishu' in ps else None)")
r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=120, env={**os.environ})
check("gateway do Hermes: com o .env, o Feishu (no Lark, por conexão persistente) e o DingTalk ficam ligados", "['dingtalk', 'feishu'] lark websocket" in r.stdout, (r.stdout + r.stderr)[-800:])

# ---------------------------------------------------------------- 3. o Lark falso (API aberta + conexão persistente)
from gateway.config import Platform, PlatformConfig  # noqa: E402
from gateway.pairing import PairingStore  # noqa: E402
from gateway.run import GatewayRunner  # noqa: E402
from lark_oapi.ws.pb.pbbp2_pb2 import Frame  # noqa: E402

lark_pedidos = []   # (método, caminho, corpo)
lark_enviados = []  # mensagens criadas pelo robô


class Lark(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def _corpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        bruto = self.rfile.read(n) if n else b""
        try:
            return json.loads(bruto or b"{}")
        except Exception:  # noqa: BLE001 - upload de imagem (multipart)
            return {"_bytes": len(bruto)}

    def _tratar(self, metodo):
        corpo = self._corpo()
        caminho = urlsplit(self.path).path
        lark_pedidos.append((metodo, self.path, corpo))
        if caminho.endswith("/tenant_access_token/internal") or caminho.endswith("/app_access_token/internal"):
            return responder(self, {"code": 0, "msg": "ok", "tenant_access_token": "t-falso", "app_access_token": "a-falso", "expire": 7200})
        if caminho == "/callback/ws/endpoint":
            return responder(self, {"code": 0, "msg": "ok", "data": {"URL": f"ws://127.0.0.1:{WS_LARK}/ws?device_id=disp1&service_id=7",
                                                                     "ClientConfig": {"ReconnectCount": -1, "ReconnectInterval": 5, "ReconnectNonce": 1, "PingInterval": 120}}})
        if caminho == "/open-apis/bot/v3/info":
            return responder(self, {"code": 0, "msg": "ok", "bot": {"open_id": "ou_" + "b" * 32, "app_name": "Ergon"}})
        if caminho.startswith("/open-apis/im/v1/chats/"):
            return responder(self, {"code": 0, "msg": "ok", "data": {"name": "李娜", "chat_mode": "p2p", "chat_type": "p2p"}})
        if caminho.startswith("/open-apis/contact/"):
            return responder(self, {"code": 0, "msg": "ok", "data": {"user": {"name": "李娜"}, "items": [{"name": "李娜"}]}})
        if caminho == "/open-apis/im/v1/images":
            return responder(self, {"code": 0, "msg": "ok", "data": {"image_key": "img_v3_falsa"}})
        if caminho == "/open-apis/im/v1/messages" and metodo == "POST":
            mid = f"om_saida_{len(lark_enviados) + 1}"
            lark_enviados.append({"id": mid, "receive_id": corpo.get("receive_id"), "tipo": corpo.get("msg_type"), "conteudo": corpo.get("content", "")})
            return responder(self, {"code": 0, "msg": "ok", "data": {"message_id": mid, "chat_id": corpo.get("receive_id")}})
        if caminho.startswith("/open-apis/im/v1/messages/") and caminho.endswith("/reactions"):
            return responder(self, {"code": 0, "msg": "ok", "data": {"reaction_id": "reac_1"}})
        return responder(self, {"code": 0, "msg": "ok", "data": {}})

    def do_GET(self):  # noqa: N802
        self._tratar("GET")

    def do_POST(self):  # noqa: N802
        self._tratar("POST")

    def do_PUT(self):  # noqa: N802
        self._tratar("PUT")

    def do_PATCH(self):  # noqa: N802
        self._tratar("PATCH")

    def do_DELETE(self):  # noqa: N802
        self._tratar("DELETE")


lark = servir(Lark)
WS_LARK = 0
ws_lark_conexoes = []
ws_lark_respostas = []
ws_loop = asyncio.new_event_loop()
threading.Thread(target=ws_loop.run_forever, daemon=True).start()


async def _ws_lark(conn):
    ws_lark_conexoes.append(conn)
    try:
        async for quadro in conn:
            f = Frame()
            f.ParseFromString(quadro)
            tipo = next((h.value for h in f.headers if h.key == "type"), "")
            if tipo == "event":
                ws_lark_respostas.append(json.loads(f.payload or b"{}"))
    except Exception:  # noqa: BLE001
        pass


async def _subir_ws(tratador):
    return await websockets.serve(tratador, "127.0.0.1", 0)


ws_lark = asyncio.run_coroutine_threadsafe(_subir_ws(_ws_lark), ws_loop).result(10)
WS_LARK = list(ws_lark.sockets)[0].getsockname()[1]


def evento_lark(texto, mid, user=DONA_FS, chat=CHAT_FS):
    """O quadro do SDK com o evento im.message.receive_v1, como a conexão persistente do Feishu/Lark entrega."""
    ev = {"schema": "2.0", "header": {"event_id": f"ev_{mid}", "event_type": "im.message.receive_v1", "create_time": str(int(time.time() * 1000)),
                                      "token": "", "app_id": FS_ID, "tenant_key": "tk1"},
          "event": {"sender": {"sender_id": {"open_id": user, "union_id": "on_" + "c" * 32}, "sender_type": "user", "tenant_key": "tk1"},
                    "message": {"message_id": mid, "create_time": str(int(time.time() * 1000)), "chat_id": chat, "chat_type": "p2p",
                                "message_type": "text", "content": json.dumps({"text": texto}, ensure_ascii=False)}}}
    f = Frame()
    f.SeqID, f.LogID, f.service, f.method = 1, 1, 7, 1
    for k, v in (("type", "event"), ("message_id", mid), ("sum", "1"), ("seq", "0"), ("trace_id", "tr1")):
        h = f.headers.add(); h.key, h.value = k, v
    f.payload = json.dumps(ev, ensure_ascii=False).encode()
    return f.SerializeToString()


def empurrar_lark(texto, mid, **kw):
    asyncio.run_coroutine_threadsafe(ws_lark_conexoes[-1].send(evento_lark(texto, mid, **kw)), ws_loop).result(10)


# o gateway de verdade: o gancho que o adaptador chama para cada mensagem (como nos testes do próprio Hermes)
runner = object.__new__(GatewayRunner)
runner.pairing_store = PairingStore()


async def ao_gateway(event):
    await runner._hm_pre_gateway_dispatch_hook(event, event.source)
    return None


import plugins.platforms.feishu.adapter as fsmod  # noqa: E402

check("Feishu: o SDK carrega sem instalar nada", fsmod._load_lark_oapi() is True)
fsmod.LARK_DOMAIN = f"http://127.0.0.1:{lark.server_address[1]}"  # o Lark (FEISHU_DOMAIN=lark) é o servidor falso
_carregar = fsmod._load_lark_oapi
fsmod._load_lark_oapi = lambda: (_carregar(), setattr(fsmod, "LARK_DOMAIN", f"http://127.0.0.1:{lark.server_address[1]}"))[0]
from plugins.platforms.feishu.adapter import FeishuAdapter  # noqa: E402

os.environ["HERMES_FEISHU_TEXT_BATCH_DELAY_SECONDS"] = "0.1"
fs_loop = asyncio.new_event_loop()
threading.Thread(target=fs_loop.run_forever, daemon=True).start()
fs = FeishuAdapter(PlatformConfig(enabled=True, extra={"app_id": FS_ID, "app_secret": FS_SEGREDO, "domain": "lark", "connection_mode": "websocket"}))
fs.set_message_handler(ao_gateway)
ligou = asyncio.run_coroutine_threadsafe(fs.connect(), fs_loop).result(60)
check("Feishu: o adaptador do Hermes conecta ao Lark falso pela conexão persistente (sem endereço público)", ligou is True and ate(lambda: len(ws_lark_conexoes) == 1, 20),
      str((ligou, [p[1] for p in lark_pedidos][:6])))
check("Feishu: pediu o endereço da conexão com o App ID e o App Secret", any(p[1] == "/callback/ws/endpoint" and p[2].get("AppID") == FS_ID for p in lark_pedidos))
check("Feishu: o adaptador vivo guardado para a saída (fábrica do plugin no cliente nativo)", b._canal_vivos.get("feishu", {}).get("adapter") is fs)

# quem ainda não está ligado: o código do pareamento, em português, inglês e chinês, pela API do Lark falso
empurrar_lark("你好", "om_in_1")
check("Feishu: a mensagem de quem não está ligado não chega ao Ergon", ate(lambda: len(lark_enviados) >= 1, 20) and not recebidos, str((lark_enviados, recebidos)))
codigo_msg = json.loads(lark_enviados[0]["conteudo"]) if lark_enviados else {}
texto_codigo = json.dumps(codigo_msg, ensure_ascii=False)
check("Feishu: recebe o código na conversa direta, com o caminho em chinês (通过飞书/Lark与团队对话)",
      lark_enviados and lark_enviados[0]["receive_id"] == CHAT_FS and "Ergon: " in texto_codigo and "通过飞书/Lark与团队对话" in texto_codigo
      and "hermes" not in texto_codigo.lower(), texto_codigo)
pend = runner.pairing_store.list_pending("feishu")
codigo = pend[0]["code"] if pend and "code" in pend[0] else ""
if not codigo:
    import re as _re
    m = _re.search(r"Ergon: ([A-Z0-9]{8})", texto_codigo)
    codigo = m.group(1) if m else ""
check("Feishu: é o pareamento nativo do gateway (pedido pendente com o id ou_…)", len(pend) == 1 and pend[0]["user_id"] == DONA_FS and len(codigo) == 8, str(pend))
st, j = ponte("POST", "/ergon/v1/canais/feishu/parear", {"codigo": codigo})
check("ponte: o código liga a conta e devolve a conversa (oc_…) para responder", st == 200 and j.get("user_id") == DONA_FS and j.get("chat_id") == CHAT_FS, str((st, j)))
runner.pairing_store = PairingStore()

# ligada: a mensagem em chinês vai ao Ergon, sem turno do Hermes
empurrar_lark("请整理第四季度的销售报告", "om_in_2")
check("Feishu: a mensagem em chinês chega ao Ergon com quem, onde e o quê", ate(lambda: len(recebidos) >= 1, 20)
      and recebidos[-1].get("canal") == "feishu" and recebidos[-1].get("user_id") == DONA_FS and recebidos[-1].get("chat_id") == CHAT_FS
      and recebidos[-1].get("text") == "请整理第四季度的销售报告" and recebidos[-1].get("message_id") == "om_in_2", str(recebidos))
check("Feishu: o SDK confirmou o evento ao servidor (código 200)", ate(lambda: any(r.get("code") == 200 for r in ws_lark_respostas), 10), str(ws_lark_respostas))

# ---------------------------------------------------------------- 4. o DingTalk falso (Stream Mode + sessionWebhook)
dt_http_pedidos = []
dt_enviados = []
WS_DT = 0


class DingTalk(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_POST(self):  # noqa: N802
        corpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        dt_http_pedidos.append((self.path, corpo))
        if self.path.startswith("/v1.0/gateway/connections/open"):
            return responder(self, {"endpoint": f"ws://127.0.0.1:{WS_DT}/connect", "ticket": "bilhete-falso"})
        if self.path.startswith("/robot/sendBySession"):
            dt_enviados.append(corpo)
            return responder(self, {"errcode": 0, "errmsg": "ok"})
        responder(self, {"errcode": 0})

    def do_GET(self):  # noqa: N802
        dt_http_pedidos.append((self.path, {}))
        responder(self, {"errcode": 0, "access_token": "x", "expires_in": 7200})


dt_http = servir(DingTalk)
ws_dt_conexoes, ws_dt_acks = [], []


async def _ws_dt(conn):
    ws_dt_conexoes.append(conn)
    try:
        async for m in conn:
            ws_dt_acks.append(json.loads(m))
    except Exception:  # noqa: BLE001
        pass


ws_dt = asyncio.run_coroutine_threadsafe(_subir_ws(_ws_dt), ws_loop).result(10)
WS_DT = list(ws_dt.sockets)[0].getsockname()[1]
dingtalk_stream.DingTalkStreamClient.OPEN_CONNECTION_API = f"http://127.0.0.1:{dt_http.server_address[1]}/v1.0/gateway/connections/open"
SESSAO = "https://oapi.dingtalk.com/robot/sendBySession?session=sessao-falsa"


def callback_dt(texto, mid, user=DONA_DT, chat=CHAT_DT, sessao=SESSAO):
    """O CALLBACK do robô (tópico /v1.0/im/bot/messages/get), como o Stream Mode do DingTalk entrega."""
    data = {"conversationId": chat, "conversationType": "1", "senderId": user, "senderNick": "王伟", "senderStaffId": "manager0001",
            "chatbotUserId": "$:LWCP_v1:$robo", "msgId": mid, "msgtype": "text", "text": {"content": texto}, "createAt": int(time.time() * 1000),
            "sessionWebhook": sessao, "sessionWebhookExpiredTime": int(time.time() * 1000) + 3600_000, "robotCode": DT_ID, "isInAtList": True}
    return json.dumps({"specVersion": "1.0", "type": "CALLBACK", "headers": {"topic": "/v1.0/im/bot/messages/get", "messageId": f"cb_{mid}",
                       "contentType": "application/json", "time": str(int(time.time() * 1000)), "appId": "app1"}, "data": json.dumps(data, ensure_ascii=False)})


def empurrar_dt(texto, mid, **kw):
    asyncio.run_coroutine_threadsafe(ws_dt_conexoes[-1].send(callback_dt(texto, mid, **kw)), ws_loop).result(10)


import httpx  # noqa: E402
from plugins.platforms.dingtalk.adapter import DingTalkAdapter  # noqa: E402


class ParaOFalso(httpx.AsyncBaseTransport):
    """A sessionWebhook é sempre https://oapi.dingtalk.com/…: o pedido vai ao DingTalk falso (sem rede neste teste)."""
    def __init__(self):
        self.t = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request):
        url = request.url.copy_with(scheme="http", host="127.0.0.1", port=dt_http.server_address[1])
        novo = httpx.Request(request.method, url, headers=[(k, v) for k, v in request.headers.items() if k.lower() != "host"], content=request.content)
        return await self.t.handle_async_request(novo)


dt_loop = asyncio.new_event_loop()
threading.Thread(target=dt_loop.run_forever, daemon=True).start()
dt = DingTalkAdapter(PlatformConfig(enabled=True, extra={"client_id": DT_ID, "client_secret": DT_SEGREDO}))
dt.set_message_handler(ao_gateway)
ligou = asyncio.run_coroutine_threadsafe(dt.connect(), dt_loop).result(60)
dt._http_client = httpx.AsyncClient(transport=ParaOFalso(), timeout=15.0)
check("DingTalk: o adaptador do Hermes abre o Stream Mode no DingTalk falso (conexão de saída, websockets da imagem)",
      ligou is True and ate(lambda: len(ws_dt_conexoes) == 1, 20) and any(p[1].get("clientId") == DT_ID for p in dt_http_pedidos), str((ligou, dt_http_pedidos[:2])))
check("DingTalk: o adaptador vivo guardado para a saída (fábrica do plugin no cliente do Stream)", b._canal_vivos.get("dingtalk", {}).get("adapter") is dt)
empurrar_dt("你好", "dt_in_1")
check("DingTalk: quem não está ligado recebe o código pela sessionWebhook, também em chinês (通过钉钉与团队对话)",
      ate(lambda: len(dt_enviados) >= 1, 20) and "通过钉钉与团队对话" in json.dumps(dt_enviados[0], ensure_ascii=False) and not [r for r in recebidos if r.get("canal") == "dingtalk"],
      json.dumps(dt_enviados, ensure_ascii=False)[:400])
check("DingTalk: o SDK confirmou o CALLBACK ao servidor", ate(lambda: any(a.get("code") == 200 for a in ws_dt_acks), 10), str(ws_dt_acks))
pend = runner.pairing_store.list_pending("dingtalk")
import re  # noqa: E402

m = re.search(r"Ergon: ([A-Z0-9]{8})", json.dumps(dt_enviados[0], ensure_ascii=False)) if dt_enviados else None
st, j = ponte("POST", "/ergon/v1/canais/dingtalk/parear", {"codigo": m.group(1) if m else "x"})
check("ponte: o DingTalk liga a conta ($:LWCP…) e devolve a conversa (cid…)", st == 200 and j.get("user_id") == DONA_DT and j.get("chat_id") == CHAT_DT, str((st, j, pend)))
runner.pairing_store = PairingStore()
empurrar_dt("帮我创建商务部门", "dt_in_2")
check("DingTalk: a mensagem em chinês chega ao Ergon", ate(lambda: any(r.get("canal") == "dingtalk" and r.get("text") == "帮我创建商务部门" for r in recebidos), 20),
      str(recebidos[-2:]))

# ---------------------------------------------------------------- 5. a saída: buscada no Ergon, mandada pela API de cada um
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
lark_enviados.clear(); dt_enviados.clear()
saida.extend([
    {"id": "s1", "canal": "feishu", "tipo": "texto", "chat_id": CHAT_FS, "user_id": DONA_FS, "texto": "**Aristóteles:** 第四季度销售额同比增长 18.5%。"},
    {"id": "s2", "canal": "feishu", "tipo": "cartao", "chat_id": CHAT_FS, "user_id": DONA_FS, "texto": "需要你\n创建“商务”部门？\n\n如需批准或拒绝，请打开 Ergon：在此渠道中需在应用内做决定。", "botoes": []},
    {"id": "s4", "canal": "feishu", "tipo": "imagem", "chat_id": CHAT_FS, "user_id": DONA_FS, "texto": "销售", "png": PNG},
    {"id": "s5", "canal": "dingtalk", "tipo": "texto", "chat_id": CHAT_DT, "user_id": DONA_DT, "texto": "**Aristóteles:** 好的。"},
    {"id": "s6", "canal": "dingtalk", "tipo": "cartao", "chat_id": CHAT_DT, "user_id": DONA_DT, "texto": "需要你\n创建部门？", "botoes": [["Aprovar", "a:apr_" + "2" * 32]]},
    {"id": "s7", "canal": "dingtalk", "tipo": "imagem", "chat_id": CHAT_DT, "user_id": DONA_DT, "texto": "销售", "png": PNG},
    {"id": "s8", "canal": "dingtalk", "tipo": "texto", "chat_id": "cid" + "VencidaSemSessao==", "user_id": DONA_DT, "texto": "aviso tardio"},
])
threading.Thread(target=laco_de_verdade, daemon=True).start()
check("saída: os itens foram confirmados ao Ergon", ate(lambda: len({a.get("id") for a in acks}) >= 7, 30), str(acks))
por_id = {a.get("id"): a for a in acks}
check("saída Feishu: o texto sai pela API do Lark falso, na conversa certa", any(e["receive_id"] == CHAT_FS and "18.5%" in e["conteudo"] for e in lark_enviados)
      and por_id.get("s1", {}).get("ok") is True and str(por_id["s1"].get("message_id", "")).startswith("om_saida_"), str((lark_enviados, por_id.get("s1"))))
check("saída Feishu: o cartão vai como texto (a decisão é no app)", any("请打开 Ergon" in e["conteudo"] for e in lark_enviados) and por_id.get("s2", {}).get("ok") is True)
mid_cartao = por_id.get("s2", {}).get("message_id", "")
saida.append({"id": "s3", "canal": "feishu", "tipo": "editar", "chat_id": CHAT_FS, "user_id": DONA_FS, "message_id": mid_cartao, "texto": "创建“商务”部门？\n已在 Ergon 中批准。"})
check("saída Feishu: a decisão edita a mensagem do cartão (PUT na API)", ate(lambda: "s3" in {a.get("id") for a in acks}, 15)
      and any(p[0] in ("PUT", "PATCH") and mid_cartao in p[1] for p in lark_pedidos), str([p[:2] for p in lark_pedidos if p[0] in ("PUT", "PATCH")]))
check("saída Feishu: a imagem do visual sobe e vai na mensagem (com a legenda)", any(p[1].startswith("/open-apis/im/v1/images") for p in lark_pedidos)
      and any("img_v3_falsa" in e["conteudo"] for e in lark_enviados) and por_id.get("s4", {}).get("ok") is True, str((por_id.get("s4"), [p[:2] for p in lark_pedidos][-8:], [e["tipo"] for e in lark_enviados])))
check("saída DingTalk: o texto sai pela sessionWebhook", any("好的" in json.dumps(e, ensure_ascii=False) for e in dt_enviados) and por_id.get("s5", {}).get("ok") is True, str(dt_enviados))
check("saída DingTalk: o cartão vai como texto, sem botões", any("创建部门" in json.dumps(e, ensure_ascii=False) for e in dt_enviados) and por_id.get("s6", {}).get("ok") is True)
check("saída DingTalk: a imagem não vai (a sessionWebhook não sobe arquivo), sem falha", por_id.get("s7", {}).get("ok") is True and len(dt_enviados) == 2, str((por_id.get("s7"), dt_enviados)))
check("saída DingTalk: sem sessão (a pessoa não escreveu há tempo), falha definitiva dita ao Ergon",
      por_id.get("s8", {}).get("ok") is False and por_id["s8"].get("erro") == "sem_sessao" and por_id["s8"].get("passageiro") is False, str(por_id.get("s8")))

# ---------------------------------------------------------------- 6. desligar
for _ad, _lp in ((fs, fs_loop), (dt, dt_loop)):
    try:  # o encerramento do adaptador é do Hermes (e pode reclamar do laço do WebSocket já fechado): aqui só desliga
        asyncio.run_coroutine_threadsafe(_ad.disconnect(), _lp).result(30)
    except Exception:  # noqa: BLE001
        pass
st, j = ponte("DELETE", "/ergon/v1/canais/feishu")
env = lido()
check("desligar o Feishu: App ID, App Secret e domínio saem do .env, a ligação some, o DingTalk fica",
      st == 200 and "FEISHU_APP_ID" not in env and "FEISHU_APP_SECRET" not in env and "FEISHU_DOMAIN" not in env and "DINGTALK_CLIENT_ID" in env
      and PairingStore().list_approved("feishu") == [] and len(PairingStore().list_approved("dingtalk")) == 1, env)
st, j = ponte("DELETE", "/ergon/v1/canais/dingtalk")
check("desligar o DingTalk: o .env sem nada dele", st == 200 and "DINGTALK_CLIENT" not in lido() and PairingStore().list_approved("dingtalk") == [])

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.stdout.flush()
os._exit(0 if ok else 1)

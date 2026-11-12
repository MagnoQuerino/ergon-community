"""Conversar com a equipe pelo Telegram e pelo Discord: o plugin do Ergon com o Hermes de verdade, dentro da imagem do
motor, sem rede e com códigos de bot de mentira.

Confere: o Hermes carrega o plugin com o gancho pre_gateway_dispatch e as fábricas de botões (register_platform_handler);
os adaptadores do Telegram e do Discord (os do Hermes) aceitam as fábricas no cliente nativo de verdade (python-telegram-bot
e discord.py); pelo caminho de entrada do gateway de verdade (GatewayRunner._hm_pre_gateway_dispatch_hook), quem não está
ligado recebe o código do pareamento NATIVO com o texto do Ergon (sem comando, sem o nome do motor), grupo e bot não
passam, e quem está ligado tem a mensagem entregue ao Ergon sem turno do Hermes (skip); a autorização nativa do gateway
aceita a conta pareada e recusa as outras; a ponte de controle guarda o código do bot no .env do motor, nunca o devolve,
confirma o pareamento, fica com uma conta por canal e apaga tudo ao desligar; a saída é buscada no Ergon e mandada pelo
adaptador vivo (texto, cartão com botões, edição); o clique nos botões chega ao Ergon só de quem está ligado; e a
migração do cofre faz o Telegram entregar o que chegou com o motor desligado, sem ligar canal nenhum sozinha.

  podman run --rm --network none --entrypoint /opt/hermes/.venv/bin/python -e HERMES_HOME=/tmp/h \
    -v "$PWD/hermes/plugins:/p:ro" -v "$PWD/hermes/tests:/t:ro" -v "$PWD/hermes/vault:/v:ro" ergon-hermes:dev \
    /t/test_ergon_bridge_canais.py
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import types
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERMES_HOME", "/tmp/h")
if os.path.exists(os.path.join(HOME, ".ergon-vault")) or not os.path.realpath(HOME).startswith("/tmp/"):
    sys.exit(f"{HOME} parece um cofre de verdade: o teste não roda aqui")
shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
os.environ["HERMES_HOME"] = HOME
for var in ("TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "DISCORD_ALLOWED_USERS", "GATEWAY_ALLOW_ALL_USERS"):
    os.environ.pop(var, None)
# segredos de exemplo, montados por partes
PONTE = "ponte-" + "de-teste-" + "0123456789abcdef"
TG = "1234567890" + ":" + "AA" + "b" * 33
DC = "M" * 24 + "." + "AbCdEf" + "." + "x" * 38
os.environ["ERGON_BRIDGE_TOKEN"] = PONTE
os.environ["ERGON_CONTROL_PORT"] = "0"  # a ponte de controle sobe aqui embaixo, numa porta do teste

ok = True


def check(name, cond, detail=""):
    global ok
    print(("ok  " if cond else "FALHA ") + name + (f" — {detail}" if detail and not cond else ""))
    ok = ok and cond


# ---------------------------------------------------------------- o Ergon de mentira (entrada e saída dos canais)
recebidos = []
saida = []          # itens que o "Ergon" tem para mandar
acks = []
resposta_entrada = {"ok": True, "digitando": True}


class Ergon(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        return

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.headers.get("X-Ergon-Bridge-Token") != PONTE:
            self.send_response(401); self.end_headers(); return
        out = {}
        if self.path == "/internal/bridge/v1/canais/entrada":
            recebidos.append(body)
            out = dict(resposta_entrada)
        elif self.path == "/internal/bridge/v1/canais/saida":
            acks.extend(body.get("acks") or [])
            out = {"itens": saida[:]}
            saida.clear()
            if not out["itens"]:
                time.sleep(0.3)
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)


ergon = ThreadingHTTPServer(("127.0.0.1", 0), Ergon)
threading.Thread(target=ergon.serve_forever, daemon=True).start()
os.environ["ERGON_BRIDGE_URL"] = f"http://127.0.0.1:{ergon.server_address[1]}/internal/bridge/v1/events"

# ---------------------------------------------------------------- 1. o Hermes carrega o plugin
sys.path.insert(0, "/opt/hermes")
copia = os.path.join(HOME, "plugins", "ergon_bridge")
shutil.copytree("/p/ergon_bridge", copia, dirs_exist_ok=True)
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "enable", "ergon_bridge"], capture_output=True, text=True, timeout=180)
check("hermes plugins enable ergon_bridge", r.returncode == 0, (r.stdout + r.stderr)[-600:])
r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "plugins", "validate", copia], capture_output=True, text=True, timeout=180)
check("o Hermes valida o plugin (pre_gateway_dispatch declarado = registrado)", r.returncode == 0, (r.stdout + r.stderr)[-1500:])

from hermes_cli.plugins import discover_plugins, get_plugin_manager  # noqa: E402
from hermes_cli.lifecycle import has_hook  # noqa: E402

discover_plugins()
pm = get_plugin_manager()
check("gancho pre_gateway_dispatch registrado no Hermes", has_hook("pre_gateway_dispatch"))
check("gancho post_gateway_admission continua registrado (Teams e WhatsApp)", has_hook("post_gateway_admission"))
fab_tg = pm.get_platform_handler_factories("telegram")
fab_dc = pm.get_platform_handler_factories("discord")
check("fábrica de botões do Telegram registrada", len(fab_tg) == 1 and fab_tg[0][0].__name__ == "_fabrica_telegram", str(fab_tg))
check("fábrica de botões do Discord registrada", len(fab_dc) == 1 and fab_dc[0][0].__name__ == "_fabrica_discord", str(fab_dc))
b = sys.modules[fab_tg[0][0].__module__]  # o módulo do plugin como o Hermes carregou
check("capacidade 'canais' anunciada ao Ergon", "canais" in b.CAPACIDADES, str(b.CAPACIDADES))
# a busca da saída não começa sozinha neste teste: fica para a parte 6
laco_de_verdade = b._canal_laco
b._canal_laco = lambda: None

# ---------------------------------------------------------------- 2. adaptadores do Hermes com códigos de mentira
from gateway.config import Platform, PlatformConfig  # noqa: E402
from plugins.platforms.telegram.adapter import TelegramAdapter  # noqa: E402
from plugins.platforms.discord.adapter import DiscordAdapter  # noqa: E402

tg = TelegramAdapter(PlatformConfig(enabled=True, token=TG))
check("Telegram, padrão do Hermes: descarta a fila ao iniciar", tg._drop_pending_on_cold_boot is True)
tg = TelegramAdapter(PlatformConfig(enabled=True, token=TG, extra={"drop_pending_on_cold_boot": False}))
check("Telegram com a migração do cofre: entrega a fila ao iniciar", tg._drop_pending_on_cold_boot is False and tg._cold_boot_drop_pending(is_reconnect=False) is False)
from telegram.ext import Application, CallbackQueryHandler  # noqa: E402

app = Application.builder().token(TG).build()  # sem rede: só monta
tg._wire_plugin_handlers(app)
nossos = [h for hs in app.handlers.values() for h in hs if isinstance(h, CallbackQueryHandler)]
check("Telegram: o adaptador liga o nosso tratador de cliques no cliente nativo", len(nossos) == 1 and nossos[0].callback.__name__ == "_tg_clique", str(app.handlers))
check("Telegram: só os botões do Ergon (padrão ^erg:)", getattr(nossos[0].pattern, "pattern", "") == "^erg:", str(nossos[0].pattern))
check("Telegram: adaptador vivo guardado para a saída", b._canal_vivos.get("telegram", {}).get("adapter") is tg and b._canal_vivos["telegram"]["native"] is app)

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

dc = DiscordAdapter(PlatformConfig(enabled=True, token=DC))
intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)
dc._wire_plugin_handlers(bot)
ouvintes = bot.extra_events.get("on_interaction") or []
check("Discord: o adaptador liga o nosso ouvinte de cliques no cliente nativo", len(ouvintes) == 1 and ouvintes[0].__name__ == "_dc_interacao", str(bot.extra_events))
check("Discord: adaptador vivo guardado para a saída", b._canal_vivos.get("discord", {}).get("adapter") is dc)

# ---------------------------------------------------------------- 3. a entrada pelo gateway de verdade
from gateway.pairing import PairingStore  # noqa: E402
from gateway.platforms.base import MessageEvent, SendResult  # noqa: E402
from gateway.run import GatewayRunner  # noqa: E402
from gateway.session import SessionSource  # noqa: E402


class Falso:
    """Adaptador de mentira no lugar do vivo: anota o que sairia para o canal."""
    def __init__(self):
        self.enviados, self.digitando = [], []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.enviados.append((str(chat_id), content))
        return SendResult(success=True, message_id=f"m{len(self.enviados)}")

    async def send_typing(self, chat_id, metadata=None):
        self.digitando.append(str(chat_id))


runner = object.__new__(GatewayRunner)  # como os testes do próprio Hermes: sem __init__
runner.pairing_store = PairingStore()
falso = {"telegram": Falso(), "discord": Falso()}
runner._delivery_adapter_for = lambda source: falso[source.platform.value]


def evento(platform, user_id, chat_id, text, chat_type="dm", mid="1", is_bot=False, nome="Fulana"):
    src = SessionSource(platform=Platform(platform), chat_id=str(chat_id), chat_type=chat_type, user_id=str(user_id), user_name=nome)
    if is_bot:
        src.is_bot = True
    return MessageEvent(text=text, source=src, message_id=mid)


def entrar(ev):
    return asyncio.run(runner._hm_pre_gateway_dispatch_hook(ev, ev.source))


DONA, ESTRANHO = "111222333", "999888777"
for canal, chat_dona in (("telegram", DONA), ("discord", "555000111")):
    f = falso[canal]
    recebidos.clear()
    r = entrar(evento(canal, DONA, "-100123", "oi equipe", chat_type="group"))
    check(f"{canal}: mensagem em grupo não passa nem responde", r is None and not f.enviados and not recebidos, str((r, f.enviados)))
    r = entrar(evento(canal, DONA, chat_dona, "oi", is_bot=True))
    check(f"{canal}: bot não passa", r is None and not f.enviados and not recebidos)
    r = entrar(evento(canal, DONA, chat_dona, "/start"))
    check(f"{canal}: quem não está ligado não chega ao Hermes nem ao Ergon", r is None and not recebidos, str(r))
    check(f"{canal}: recebe um código de pareamento", len(f.enviados) == 1 and f.enviados[0][0] == chat_dona, str(f.enviados))
    texto = f.enviados[0][1] if f.enviados else ""
    codigo = texto.split("Ergon: ")[1].split("\n")[0].strip() if "Ergon: " in texto else ""
    check(f"{canal}: código de 8 caracteres, com o caminho na tela do Ergon", len(codigo) == 8 and "Conexões" in texto and "Connections" in texto, texto)
    check(f"{canal}: o texto não manda rodar comando nem cita o motor", "hermes" not in texto.lower() and "pairing approve" not in texto, texto)
    pend = runner.pairing_store.list_pending(canal)
    check(f"{canal}: é o pareamento nativo do gateway (pedido pendente no PairingStore)", len(pend) == 1 and pend[0]["user_id"] == DONA, str(pend))
    r = entrar(evento(canal, DONA, chat_dona, "oi de novo"))
    check(f"{canal}: segundo pedido em seguida não gera outro código (limite do Hermes)", r is None and len(f.enviados) == 1, str(f.enviados))
    check(f"{canal}: antes de ligar, a autorização nativa recusa", runner._is_user_authorized(evento(canal, DONA, chat_dona, "x").source) is False)

    # a ponte de controle confirma o código (parte 4 confere as rotas; aqui, o efeito no gateway)
    aprov = PairingStore().approve_code(canal, codigo)
    check(f"{canal}: código confirmado pelo PairingStore do disco (outro processo)", aprov is not None and aprov["user_id"] == DONA, str(aprov))
    check(f"{canal}: depois de ligar, a autorização nativa do gateway aceita a conta", runner._is_user_authorized(evento(canal, DONA, chat_dona, "x").source) is True)
    check(f"{canal}: e continua recusando as outras", runner._is_user_authorized(evento(canal, ESTRANHO, ESTRANHO, "x").source) is False)

    f.enviados.clear()
    r = entrar(evento(canal, ESTRANHO, ESTRANHO, "me deixa entrar"))
    check(f"{canal}: canal com dona: estranho não recebe código nem resposta", r is None and not f.enviados and not recebidos and not runner.pairing_store.list_pending(canal), str(f.enviados))

    resposta_entrada.clear(); resposta_entrada.update({"ok": True, "digitando": True})
    r = entrar(evento(canal, DONA, chat_dona, "Prepare o relatório de vendas", mid="42"))
    check(f"{canal}: mensagem da dona: o Hermes não roda turno (skip)", r is None)
    m = recebidos[-1] if recebidos else {}
    check(f"{canal}: a mensagem chega ao Ergon com quem, onde e o quê",
          m.get("tipo") == "mensagem" and m.get("canal") == canal and m.get("user_id") == DONA and m.get("chat_id") == chat_dona
          and m.get("text") == "Prepare o relatório de vendas" and m.get("message_id") == "42" and bool(m.get("sent_at")), str(m))
    check(f"{canal}: 'digitando' no canal enquanto a equipe trabalha, sem resposta do plugin", f.digitando == [chat_dona] and not f.enviados, str((f.digitando, f.enviados)))
    r = entrar(evento(canal, DONA, chat_dona, "/new", mid="43"))
    check(f"{canal}: comando do Hermes (/new) também vai ao Ergon, não ao Hermes", r is None and recebidos[-1].get("text") == "/new")
    resposta_entrada.clear(); resposta_entrada.update({"ok": True, "reply": "Só texto por enquanto."})
    entrar(evento(canal, DONA, chat_dona, "", mid="44"))
    check(f"{canal}: resposta imediata do Ergon volta ao canal", f.enviados[-1:] == [(chat_dona, "Só texto por enquanto.")], str(f.enviados))
    lemb = b._canal_lembrados().get(canal, {}).get(DONA, {})
    check(f"{canal}: a conversa direta fica lembrada para o pareamento", lemb.get("chat_id") == chat_dona, str(lemb))

# Ergon fora do ar: a pessoa fica sabendo, e nada vai ao Hermes
guardado = os.environ["ERGON_BRIDGE_URL"]
os.environ["ERGON_BRIDGE_URL"] = "http://127.0.0.1:9/internal/bridge/v1/events"
falso["telegram"].enviados.clear()
r = entrar(evento("telegram", DONA, DONA, "tem alguém aí?", mid="50"))
check("Ergon fora do ar: skip e aviso honesto no canal", r is None and len(falso["telegram"].enviados) == 1 and "Mande de novo" in falso["telegram"].enviados[0][1], str(falso["telegram"].enviados))
os.environ["ERGON_BRIDGE_URL"] = guardado
# outras plataformas: o gancho não se mete
ev = evento("telegram", DONA, DONA, "x")
ev.source.platform = Platform("api_server")
check("outras plataformas seguem o caminho normal do Hermes", asyncio.run(runner._hm_pre_gateway_dispatch_hook(ev, ev.source)) is ev)
# falha dentro do gancho: fecha (skip), nunca abre
quebrado = evento("telegram", DONA, DONA, "x")
runner.pairing_store = types.SimpleNamespace(is_approved=lambda *_a: (_ for _ in ()).throw(RuntimeError("quebrou")))
check("falha na conferência: a mensagem não passa", asyncio.run(runner._hm_pre_gateway_dispatch_hook(quebrado, quebrado.source)) is None)
runner.pairing_store = PairingStore()

# ---------------------------------------------------------------- 4. ponte de controle (código do bot e pareamento)
reinicios = []
b._canal_reiniciar = lambda: (reinicios.append("reinício"), True)[1]  # o de verdade roda "hermes gateway restart" (conferido no motor inteiro)
ctrl = ThreadingHTTPServer(("127.0.0.1", 0), b._ControlHandler)
threading.Thread(target=ctrl.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{ctrl.server_address[1]}"


def ponte(method, path, body=None, token=PONTE):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-Ergon-Bridge-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}"), resp
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), e


st, j, _ = ponte("GET", "/ergon/v1/canais", token="x" * 30)
check("ponte: sem o token da ponte, nada", st == 401)
st, j, _ = ponte("PUT", "/ergon/v1/canais/telegram", {"token": "isto não é um código de bot"})
check("ponte: código de bot com formato errado é recusado", st == 400 and j.get("code") == "formato", str((st, j)))
env_path = os.path.join(HOME, ".env")
check("ponte: nada gravado no .env depois da recusa", not os.path.exists(env_path) or "TELEGRAM_BOT_TOKEN" not in open(env_path).read())
# a conta ligada na parte 3 é de um bot de antes: código novo desfaz as ligações
st, j, _ = ponte("PUT", "/ergon/v1/canais/telegram", {"token": TG})
check("ponte: código do bot do Telegram aceito, gateway reiniciado", st == 200 and j == {"ok": True, "reiniciando": True} and reinicios[-1:] == ["reinício"], str((st, j, reinicios)))
check("ponte: o código do bot fica no .env do motor (dentro do cofre)", f"TELEGRAM_BOT_TOKEN={TG}" in open(env_path).read().replace('"', "").replace("'", ""))
check("ponte: bot novo desfaz as ligações de antes", PairingStore().list_approved("telegram") == [])
st, j, resp = ponte("GET", "/ergon/v1/canais")
bruto = json.dumps(j)
check("ponte: a situação diz que está configurado e NUNCA devolve o código do bot", st == 200 and j["canais"]["telegram"]["configurado"] is True and j["canais"]["discord"]["configurado"] is False and TG not in bruto and TG.split(":")[1] not in bruto, bruto)
st, j, _ = ponte("PUT", "/ergon/v1/canais/discord", {"token": DC})
check("ponte: código do bot do Discord aceito", st == 200 and f"DISCORD_BOT_TOKEN={DC}" in open(env_path).read().replace('"', "").replace("'", ""), str((st, j)))

from gateway.config import load_gateway_config  # noqa: E402

r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, '/opt/hermes')\nfrom gateway.config import load_gateway_config, Platform\nc = load_gateway_config()\nprint(sorted(p.value for p, pc in c.platforms.items() if pc.enabled and p in (Platform.TELEGRAM, Platform.DISCORD)))"],
                   capture_output=True, text=True, timeout=120, env={**os.environ})
check("gateway do Hermes: com os códigos no .env, Telegram e Discord ficam ligados", "['discord', 'telegram']" in r.stdout, (r.stdout + r.stderr)[-600:])

# pareamento pela ponte: o estranho pede primeiro, a dona depois; vale o código que a pessoa digitar no Ergon
falso["telegram"].enviados.clear()
entrar(evento("telegram", DONA, DONA, "oi"))
cod = falso["telegram"].enviados[0][1].split("Ergon: ")[1].split("\n")[0].strip()
st, j, _ = ponte("POST", "/ergon/v1/canais/telegram/parear", {"codigo": "ZZZZ9999"})
check("ponte: código errado não liga", st == 404 and j.get("code") == "codigo", str((st, j)))
st, j, _ = ponte("POST", "/ergon/v1/canais/telegram/parear", {"codigo": f" {cod[:4].lower()} {cod[4:]} "})
check("ponte: código certo (com espaços e minúsculas) liga e diz a conta e a conversa", st == 200 and j.get("user_id") == DONA and j.get("chat_id") == DONA and j.get("user_name") == "Fulana", str((st, j)))
st, j, _ = ponte("POST", "/ergon/v1/canais/telegram/parear", {"codigo": cod})
check("ponte: o mesmo código não vale duas vezes", st == 404, str((st, j)))
st, j, _ = ponte("GET", "/ergon/v1/canais")
check("ponte: a situação mostra a conta ligada", [x["user_id"] for x in j["canais"]["telegram"]["ligados"]] == [DONA], str(j))
# Discord: a conversa direta tem número próprio, e ele volta no pareamento
falso["discord"].enviados.clear()
entrar(evento("discord", DONA, "555000111", "oi"))
cod_dc = falso["discord"].enviados[0][1].split("Ergon: ")[1].split("\n")[0].strip()
st, j, _ = ponte("POST", "/ergon/v1/canais/discord/parear", {"codigo": cod_dc})
check("ponte: Discord devolve a conversa direta de quem pediu o código", st == 200 and j.get("chat_id") == "555000111", str((st, j)))

# ---------------------------------------------------------------- 5. cliques nos botões
recebidos.clear()
resposta_entrada.clear(); resposta_entrada.update({"ok": True})
respondidas = []


def clique_tg(user_id, data, tipo="private"):
    enviados = []
    bot_falso = types.SimpleNamespace(send_message=lambda **kw: _async(enviados.append(kw)))
    msg = types.SimpleNamespace(chat=types.SimpleNamespace(type=tipo), chat_id=int(user_id), message_id=77, get_bot=lambda: bot_falso)
    q = types.SimpleNamespace(data=data, id="cb1", from_user=types.SimpleNamespace(id=int(user_id)), message=msg, answer=lambda **_kw: _async(respondidas.append(data)))
    asyncio.run(b._tg_clique(types.SimpleNamespace(callback_query=q), None))
    return enviados


async def _async(_v=None):
    return None


clique_tg(DONA, "erg:a:apr_" + "0" * 32)
m = recebidos[-1] if recebidos else {}
check("Telegram: clique da dona chega ao Ergon com o dado do botão", m.get("tipo") == "clique" and m.get("dado") == "a:apr_" + "0" * 32 and m.get("message_id") == "77" and m.get("user_id") == DONA, str(m))
check("Telegram: o clique é respondido na hora (o botão para de girar)", len(respondidas) == 1)
n = len(recebidos)
clique_tg(ESTRANHO, "erg:a:apr_" + "0" * 32)
check("Telegram: clique de quem não está ligado não chega ao Ergon", len(recebidos) == n)
clique_tg(DONA, "erg:a:apr_" + "0" * 32, tipo="group")
check("Telegram: clique em grupo não chega ao Ergon", len(recebidos) == n)


def clique_dc(user_id, custom_id, guild=None):
    feitos = []
    resp = types.SimpleNamespace(is_done=lambda: False, defer=lambda: _async(feitos.append("defer")))
    it = types.SimpleNamespace(data={"custom_id": custom_id}, response=resp, guild=guild, channel_id=555000111, id=9, user=types.SimpleNamespace(id=int(user_id)),
                               message=types.SimpleNamespace(id=88), followup=types.SimpleNamespace(send=lambda t: _async(feitos.append(t))))
    asyncio.run(b._dc_interacao(it))
    return feitos


feitos = clique_dc(DONA, "erg:r:apr_" + "1" * 32)
m = recebidos[-1]
check("Discord: clique da dona chega ao Ergon", m.get("canal") == "discord" and m.get("dado") == "r:apr_" + "1" * 32 and m.get("message_id") == "88" and feitos == ["defer"], str((m, feitos)))
n = len(recebidos)
clique_dc(DONA, "clarify:1:2")
clique_dc(ESTRANHO, "erg:a:apr_" + "1" * 32)
clique_dc(DONA, "erg:a:apr_" + "1" * 32, guild=object())
check("Discord: botões do Hermes, estranhos e servidores não chegam ao Ergon", len(recebidos) == n)

# ---------------------------------------------------------------- 6. a saída: buscada no Ergon, mandada pelo adaptador vivo
tg_enviados = []


class BotTg:
    async def send_message(self, **kw):
        tg_enviados.append(("send", kw))
        return types.SimpleNamespace(message_id=901)

    async def edit_message_text(self, **kw):
        tg_enviados.append(("edit", kw))


dc_enviados = []


class CanalDc:
    async def send(self, content, view=None):
        dc_enviados.append(("send", content, view))
        return types.SimpleNamespace(id=902)

    def get_partial_message(self, mid):
        async def edit(**kw):
            dc_enviados.append(("edit", mid, kw))
        return types.SimpleNamespace(edit=edit)


canal_dc = CanalDc()


async def _criar_dm():
    return canal_dc


loop = asyncio.new_event_loop()
threading.Thread(target=loop.run_forever, daemon=True).start()
b._canal_vivos["telegram"] = {"native": types.SimpleNamespace(bot=BotTg()), "adapter": falso["telegram"], "loop": loop}
b._canal_vivos["discord"] = {"native": types.SimpleNamespace(get_user=lambda uid: types.SimpleNamespace(dm_channel=None, create_dm=_criar_dm)), "adapter": falso["discord"], "loop": loop}
falso["telegram"].enviados.clear(); falso["discord"].enviados.clear()
BOTOES = [["Aprovar", "a:apr_" + "2" * 32], ["Recusar", "r:apr_" + "2" * 32]]
saida.extend([
    {"id": "out_1", "canal": "telegram", "tipo": "texto", "chat_id": DONA, "user_id": DONA, "texto": "**Aristóteles:** pronto."},
    {"id": "out_2", "canal": "telegram", "tipo": "cartao", "chat_id": DONA, "user_id": DONA, "texto": "Precisa de você\nEnviar o e-mail?", "botoes": BOTOES},
    {"id": "out_3", "canal": "telegram", "tipo": "editar", "chat_id": DONA, "user_id": DONA, "message_id": "901", "texto": "Enviar o e-mail?\nAprovado por você às 10h02."},
    {"id": "out_4", "canal": "discord", "tipo": "texto", "chat_id": "555000111", "user_id": DONA, "texto": "**Aristóteles:** pronto."},
    {"id": "out_5", "canal": "discord", "tipo": "cartao", "chat_id": "555000111", "user_id": DONA, "texto": "Precisa de você\nEnviar o e-mail?", "botoes": BOTOES},
    {"id": "out_6", "canal": "discord", "tipo": "editar", "chat_id": "555000111", "user_id": DONA, "message_id": "902", "texto": "Recusado por você às 10h03."},
    {"id": "out_7", "canal": "whatsapp", "tipo": "texto", "chat_id": "1", "user_id": "1", "texto": "não é canal daqui"},
])
threading.Thread(target=laco_de_verdade, daemon=True).start()
fim = time.time() + 20
while time.time() < fim and len(acks) < 7:
    time.sleep(0.1)
por_id = {a.get("id"): a for a in acks}
check("saída: os sete itens foram confirmados ao Ergon", sorted(por_id) == [f"out_{i}" for i in range(1, 8)], str(acks))
check("saída Telegram: o texto vai pelo adaptador do Hermes (que formata e divide)", falso["telegram"].enviados == [(DONA, "**Aristóteles:** pronto.")] and por_id["out_1"].get("ok") is True, str(falso["telegram"].enviados))
kb = tg_enviados[0][1].get("reply_markup") if tg_enviados else None
dados = [btn.callback_data for row in kb.inline_keyboard for btn in row] if kb is not None else []
check("saída Telegram: cartão com botões inline de verdade (erg:…) e o número da mensagem volta", tg_enviados and tg_enviados[0][0] == "send" and dados == ["erg:a:apr_" + "2" * 32, "erg:r:apr_" + "2" * 32]
      and all(len(d.encode()) <= 64 for d in dados) and por_id["out_2"].get("message_id") == "901", str((tg_enviados[:1], por_id.get("out_2"))))
check("saída Telegram: a decisão edita o cartão e tira os botões", tg_enviados[1][0] == "edit" and tg_enviados[1][1]["message_id"] == 901 and tg_enviados[1][1]["reply_markup"] is None and por_id["out_3"].get("ok") is True, str(tg_enviados[1:]))
check("saída Discord: texto pelo adaptador do Hermes", falso["discord"].enviados == [("555000111", "**Aristóteles:** pronto.")], str(falso["discord"].enviados))
view = dc_enviados[0][2] if dc_enviados else None
ids = [c.custom_id for c in view.children] if view is not None else []
check("saída Discord: cartão com botões de verdade (discord.ui) na conversa direta", ids == ["erg:a:apr_" + "2" * 32, "erg:r:apr_" + "2" * 32] and por_id["out_5"].get("message_id") == "902", str((dc_enviados[:1], por_id.get("out_5"))))
check("saída Discord: a decisão edita o cartão e tira os botões", dc_enviados[1][0] == "edit" and dc_enviados[1][1] == 902 and dc_enviados[1][2].get("view") is None, str(dc_enviados[1:]))
check("saída: canal que não é daqui volta como falha, sem derrubar nada", por_id["out_7"].get("ok") is False, str(por_id.get("out_7")))

# ---------------------------------------------------------------- 7. desligar
st, j, _ = ponte("DELETE", "/ergon/v1/canais/telegram")
env = open(env_path).read()
check("desligar: o código do bot sai do .env, as ligações somem e o gateway reinicia",
      st == 200 and "TELEGRAM_BOT_TOKEN" not in env and "DISCORD_BOT_TOKEN" in env and PairingStore().list_approved("telegram") == [] and len(PairingStore().list_approved("discord")) == 1
      and reinicios[-1:] == ["reinício"], str((st, j, env)))
runner.pairing_store = PairingStore()
check("desligar: a conta de antes deixa de ser aceita pelo gateway", runner._is_user_authorized(evento("telegram", DONA, DONA, "x").source) is False)

# ---------------------------------------------------------------- 8. a migração do cofre não liga canal nenhum
if os.path.exists("/v/ergon-vault.py"):
    import importlib.util

    spec = importlib.util.spec_from_file_location("ergon_vault", "/v/ergon-vault.py")
    v = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(v)
    mig = [c for _n, nome, c in v.MIGRACOES if "Telegram" in nome]
    check("cofre: a migração dos canais existe e só grava o que está ausente", len(mig) == 1 and list(mig[0]) == ["se_ausente"], str(mig))
    home2 = "/tmp/ergon-teste-canais-cfg"
    shutil.rmtree(home2, ignore_errors=True)
    os.makedirs(home2)
    env2 = {k: x for k, x in os.environ.items() if k not in ("TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN")}
    env2["HERMES_HOME"] = home2
    for chave, valor in mig[0]["se_ausente"]:
        r = subprocess.run(["/opt/hermes/.venv/bin/hermes", "config", "set", chave, valor], capture_output=True, text=True, timeout=120, env=env2)
        check(f"cofre: o Hermes grava {chave}", r.returncode == 0, (r.stdout + r.stderr)[-400:])
    prog = ("import sys; sys.path.insert(0, '/opt/hermes')\nfrom gateway.config import load_gateway_config, Platform\nc = load_gateway_config()\n"
            "pc = c.platforms.get(Platform.TELEGRAM)\nprint('LIGADO' if pc is not None and pc.enabled else 'DESLIGADO', (pc.extra if pc is not None else {}).get('drop_pending_on_cold_boot'))")
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=120, env=env2)
    check("cofre: sem código de bot, o Telegram continua desligado depois da migração", "DESLIGADO" in r.stdout, (r.stdout + r.stderr)[-600:])
    env2["TELEGRAM_BOT_TOKEN"] = TG
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=120, env=env2)
    check("cofre: com o código do bot, o gateway liga o Telegram entregando a fila (drop_pending_on_cold_boot false)", "LIGADO False" in r.stdout, (r.stdout + r.stderr)[-600:])
else:
    print("pulado: /v/ergon-vault.py não está montado")

print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.stdout.flush()
os._exit(0 if ok else 1)

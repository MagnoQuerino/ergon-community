"""Cofre do motor de IA (gocryptfs) — roda ANTES do Hermes, como processo 1 do contêiner.

O Hermes grava em /opt/data (login das contas, histórico, memória dos agentes) em texto aberto. Aqui esse
diretório passa a ser a vista decifrada de um cofre gocryptfs no volume /vault: em disco só existe o lado
cifrado. A chave vem do Ergon (derivada da chave mestra, que só existe depois que a pessoa destranca o Ergon)
pela rede interna, com o token da ponte. Sem chave, o Hermes não sobe.

Primeira vez: cria o cofre e copia para dentro os dados de antes (volume antigo montado em /legacy, só
leitura — ele não é apagado; a pessoa decide quando remover). Depois monta, copia o plugin do Ergon, aplica a
configuração do Ergon (uma vez por versão dela) e passa a vez ao ponto de entrada original do Hermes (s6),
mantendo o processo 1. Assim a instalação não precisa de nenhum passo manual no motor.

Sem ERGON_VAULT=1, só passa a vez (comportamento original).
"""

from __future__ import annotations

import ctypes
import hmac
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

VAULT = "/vault"
PLAIN = "/opt/data"
LEGACY = "/legacy"
PLUGIN_SRC = "/opt/ergon/plugins/ergon_bridge"
MARKER = ".ergon-vault"
HERMES_UID = 10000
HERMES_CLI = "/opt/hermes/.venv/bin/hermes"

# Configuração do motor pelo Ergon (o mesmo que scripts/hermes-init.mjs): plugin ligado; na API (agentes do
# Ergon) só o conjunto seguro de ferramentas — o plugin barra, a cada chamada, o que o agente não tem; Teams e
# WhatsApp diretos só com "todo"; limites econômicos; mensagens de desconhecidos ignoradas.
# Mudou a lista? Suba CONFIG_VERSION: aplica de novo na próxima abertura do cofre.
CONFIG_VERSION = "1"
CONFIG_MARKER = ".ergon-config"
CONFIG_STEPS = [
    ["plugins", "enable", "ergon_bridge"],
    ["config", "set", "platform_toolsets.api_server", '["todo","web","vision","image_gen","skills"]'],
    ["config", "set", "platform_toolsets.teams", '["todo"]'],
    ["config", "set", "platform_toolsets.whatsapp", '["todo"]'],
    ["config", "set", "agent.max_turns", "10"],
    ["config", "set", "agent.reasoning_effort", "low"],
    ["config", "set", "unauthorized_dm_behavior", "ignore"],
]
# Travas de segurança: valem em TODA abertura, sem reaplicar o resto (subir CONFIG_VERSION desfaria escolhas da
# pessoa, como as ferramentas ligadas). Treinar: toda escrita de skill fica em espera até a aprovação no Ergon.
ENFORCED_STEPS = [
    ["config", "set", "skills.write_approval", "true"],
]
ENTRY = ["/opt/hermes/docker/entrypoint-dispatch.sh", *sys.argv[1:]]
PR_CAPBSET_DROP = 24  # prctl(2)
CAP_SYS_ADMIN = 21    # capability(7)


def log(msg: str) -> None:
    print(f"[ergon-vault] {msg}", flush=True)


def gocryptfs(args: list[str], key: str, as_motor: bool = False) -> tuple[int, str]:
    # a chave entra pela entrada padrão: nunca vai para disco nem para a linha de comando.
    # Ao montar, o gocryptfs fica em segundo plano: a saída de erro vai para um arquivo temporário (um canal
    # ficaria aberto pelo processo de fundo e travaria a espera).
    cmd = ["gocryptfs", "-q", "-nosyslog", "-passfile", "/dev/stdin", *args]
    if as_motor:
        # Montado como root com -allow_other, o gocryptfs cria cada arquivo trocando de usuário na thread, e com
        # gravações em paralelo a troca falha: metade das criações voltava "Operation not permitted" (medido no
        # cofre real: 1.206 de 2.400 com 16 threads; 0 com uma). Instalar uma dependência do motor falhava e o
        # estado do gateway não era salvo. Como o usuário do motor, só com o privilégio de montar, não há troca:
        # 0 de 2.400. O "cat", já como esse usuário, repassa a chave por um canal dele (o gocryptfs reabre
        # /dev/stdin, e o canal de root não abre para outro usuário): a chave só passa pela memória.
        cmd = ["setpriv", f"--reuid={HERMES_UID}", f"--regid={HERMES_UID}", "--clear-groups",
               "--inh-caps=+sys_admin", "--ambient-caps=+sys_admin", "sh", "-c", 'cat | gocryptfs "$@"', "sh", *cmd[1:]]
    with open("/tmp/gocryptfs.err", "w+", encoding="utf-8") as err:
        r = subprocess.run(cmd, input=key.encode(), stdout=subprocess.DEVNULL, stderr=err, timeout=120)
        err.seek(0)
        return r.returncode, err.read()[-300:]


def change_password(old: str, new: str) -> tuple[int, str]:
    """Troca a senha do cofre (o motor de antes passa a ser de uma pessoa: da chave da instalação para a dela). A chave
    mestra do gocryptfs fica a mesma — o conteúdo não é recifrado; só o embrulho dela no gocryptfs.conf muda. As duas
    senhas entram pela entrada padrão, uma por linha (nunca em disco nem na linha de comando), como o usuário do motor
    (dono do gocryptfs.conf)."""
    cmd = ["setpriv", f"--reuid={HERMES_UID}", f"--regid={HERMES_UID}", "--clear-groups",
           "gocryptfs", "-q", "-nosyslog", "-passwd", VAULT]
    with open("/tmp/gocryptfs.err", "w+", encoding="utf-8") as err:
        r = subprocess.run(cmd, input=f"{old}\n{new}\n".encode(), stdout=subprocess.DEVNULL, stderr=err, timeout=120)
        err.seek(0)
        return r.returncode, err.read()[-300:]


def own_vault() -> int:
    """O lado cifrado é do usuário do motor (o gocryptfs roda como ele). Cofres de antes — montados como root —
    têm a configuração e arquivos criados por processos de root com dono root: acerta uma vez, só o dono
    (o conteúdo cifrado não muda). Devolve quantos itens mudaram."""
    n = 0
    for root, dirs, files in os.walk(VAULT):
        for p in [root, *[os.path.join(root, x) for x in dirs + files]]:
            st = os.lstat(p)
            if st.st_uid != HERMES_UID or st.st_gid != HERMES_UID:
                os.lchown(p, HERMES_UID, HERMES_UID)
                n += 1
    return n


def open_vault(key: str, previous: str | None = None) -> None:
    first = not os.path.exists(os.path.join(VAULT, "gocryptfs.conf"))
    if first:
        os.makedirs(VAULT, exist_ok=True)
        code, msg = gocryptfs(["-init", VAULT], key)
        if code != 0:
            raise RuntimeError(f"não consegui criar o cofre: {msg}")
        log("cofre criado")
    changed = own_vault()
    if changed:
        log(f"cofre passa a ser do usuário do motor ({changed} itens; só o dono, o conteúdo cifrado não muda)")
    if previous and not first:
        code, msg = change_password(previous, key)
        if code == 0:
            log("senha do cofre trocada para a chave da pessoa (o conteúdo cifrado não muda)")
        elif code != 12:  # 12: a senha antiga não confere — já trocada antes; a nova vale (confere ao montar)
            raise RuntimeError(f"não consegui trocar a senha do cofre: {msg}")
    os.makedirs(PLAIN, exist_ok=True)
    os.chown(PLAIN, HERMES_UID, HERMES_UID)
    code, msg = gocryptfs(["-allow_other", "-nonempty", VAULT, PLAIN], key, as_motor=True)
    if code != 0:
        raise RuntimeError("chave do cofre não confere" if code == 12 else f"falha ao montar: {msg}")
    os.chown(PLAIN, HERMES_UID, HERMES_UID)
    os.chmod(PLAIN, 0o700)
    marker = os.path.join(PLAIN, MARKER)
    if not os.path.exists(marker):
        legacy = [n for n in os.listdir(LEGACY)] if os.path.isdir(LEGACY) else []
        if legacy:
            log(f"migrando {len(legacy)} itens do volume antigo para o cofre")
            # o gocryptfs (usuário do motor) grava tudo como ele: preservar outro dono seria recusado
            r = subprocess.run(["cp", "-a", "--no-preserve=ownership", f"{LEGACY}/.", f"{PLAIN}/"], capture_output=True, timeout=1800)
            if r.returncode != 0:
                raise RuntimeError(f"falha ao migrar os dados antigos: {r.stderr.decode()[-300:]}")
        with open(marker, "w", encoding="utf-8") as f:
            json.dump({"migrated_from_legacy": bool(legacy)}, f)
        os.chown(marker, HERMES_UID, HERMES_UID)
    # plugin do Ergon: o código vem da imagem/projeto (só leitura); a cópia fica dentro do cofre
    if os.path.isdir(PLUGIN_SRC):
        dst = os.path.join(PLAIN, "plugins", "ergon_bridge")
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(PLUGIN_SRC, dst)
        for root, dirs, files in os.walk(os.path.join(PLAIN, "plugins")):
            for n in [root, *[os.path.join(root, x) for x in dirs + files]]:
                os.chown(n, HERMES_UID, HERMES_UID)
    ensure_api_key()
    configure_once()
    enforce_safety()


def as_hermes(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HERMES_CLI, *args], user=HERMES_UID, group=HERMES_UID, extra_groups=[],
                          env={**os.environ, "HOME": PLAIN}, capture_output=True, timeout=120)


def ensure_api_key() -> None:
    """Com perfis multiplexados o gateway lê API_SERVER_KEY do .env do perfil, não do ambiente: copia (sem exibir)."""
    key = os.environ.get("API_SERVER_KEY", "")
    if not key:
        return
    path = os.path.join(PLAIN, ".env")
    lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
    if f"API_SERVER_KEY={key}" in lines:
        return
    lines = [ln for ln in lines if not ln.startswith("API_SERVER_KEY=")] + [f"API_SERVER_KEY={key}"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chown(path, HERMES_UID, HERMES_UID)
    os.chmod(path, 0o600)


def enforce_safety() -> None:
    failed = [" ".join(step[:3]) for step in ENFORCED_STEPS if as_hermes(step).returncode != 0]
    if failed:
        # sem a trava, o Treinar não grava nada (o Ergon só aplica escrita em espera); avisa e segue
        log(f"trava de segurança não aplicada ({', '.join(failed)}); nova tentativa na próxima abertura")
    else:
        log("travas de segurança conferidas")


def configure_once() -> None:
    marker = os.path.join(PLAIN, CONFIG_MARKER)
    if os.path.exists(marker) and open(marker, encoding="utf-8").read().strip() == CONFIG_VERSION:
        return
    failed = []
    for step in CONFIG_STEPS:
        r = as_hermes(step)
        if r.returncode != 0:
            failed.append(" ".join(step[:3]))
    if failed:
        # o motor sobe mesmo assim; tenta de novo na próxima abertura
        log(f"configuração do motor incompleta ({', '.join(failed)}); nova tentativa na próxima abertura")
        return
    with open(marker, "w", encoding="utf-8") as f:
        f.write(CONFIG_VERSION)
    os.chown(marker, HERMES_UID, HERMES_UID)
    log("motor configurado pelo Ergon")


class Receiver(BaseHTTPRequestHandler):
    server_version = "ergon-vault/1"
    opened = threading.Event()

    def log_message(self, *_a) -> None:
        return

    def _json(self, status: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        token = os.environ.get("ERGON_BRIDGE_TOKEN", "")
        got = self.headers.get("X-Ergon-Bridge-Token", "")
        return len(token) >= 24 and hmac.compare_digest(got.encode(), token.encode())

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._json(401, {"error": "token inválido"})
        if self.path == "/status":
            return self._json(200, {"sealed": not Receiver.opened.is_set()})
        return self._json(404, {"error": "rota desconhecida"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._json(401, {"error": "token inválido"})
        if self.path != "/unlock":
            return self._json(404, {"error": "rota desconhecida"})
        if Receiver.opened.is_set():
            return self._json(200, {"ok": True})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
            key = str(body.get("key", ""))
            # previous: a chave de antes (motor herdado por uma pessoa); a senha do cofre troca para "key", uma vez
            previous = body.get("previous")
            hexkey = lambda k: len(k) == 64 and all(c in "0123456789abcdef" for c in k)  # noqa: E731
            if not hexkey(key) or (previous is not None and not hexkey(str(previous))):
                return self._json(400, {"error": "chave em formato inválido"})
            open_vault(key, str(previous) if previous else None)
        except Exception as exc:  # noqa: BLE001
            log(f"erro: {exc}")
            return self._json(400, {"error": str(exc)})
        Receiver.opened.set()
        self._json(200, {"ok": True})


def drop_mount_privilege() -> None:
    """Depois de montar, ninguém mais precisa montar nada: tira CAP_SYS_ADMIN do conjunto-limite do processo 1.

    O conjunto-limite passa a todos os descendentes (s6, o motor e qualquer programa que um agente execute com
    Terminal ou Executar código) e não pode ser reampliado. O gocryptfs, já em segundo plano, continua servindo o
    cofre (não precisa do privilégio depois de montado). Ele roda com o usuário do motor, mas guarda o privilégio
    de montar: o kernel não deixa um processo sem esse privilégio inspecionar a memória dele (onde está a chave).
    """
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_CAPBSET_DROP, CAP_SYS_ADMIN, 0, 0, 0) != 0:
        log(f"aviso: não consegui soltar o privilégio de montagem (errno {ctypes.get_errno()})")
        return
    log("privilégio de montagem solto: o motor e o que ele executar não montam nada")


def main() -> None:
    if os.environ.get("ERGON_VAULT") != "1":
        os.execv(ENTRY[0], ENTRY)
    port = int(os.environ.get("ERGON_VAULT_PORT", "8644"))
    srv = HTTPServer(("0.0.0.0", port), Receiver)
    srv.timeout = 1
    log(f"motor de IA trancado: aguardando a chave do Ergon (porta {port}, rede interna)")
    while not Receiver.opened.is_set():
        srv.handle_request()
    srv.server_close()
    drop_mount_privilege()
    log("cofre aberto; iniciando o motor de IA")
    os.execv(ENTRY[0], ENTRY)


if __name__ == "__main__":
    main()

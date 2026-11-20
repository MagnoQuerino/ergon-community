"""Nuvem do Ergon World, o par num contêiner só: o supervisor inicia o Ergon (app) e o motor de IA dele.

Cada um com o próprio usuário, o próprio disco e o próprio ambiente:
- app: usuário 1000, /data (o cofre, o banco e a conta do World), as variáveis ERGON_* do contêiner;
- motor: usuário 10000, /opt/data (o Hermes e o que os agentes instalam), só as variáveis que chegam com o prefixo
  MOTOR__ (sem ele) e as da imagem do motor. O motor nunca recebe o token de partida, a senha de instalação nem nada
  do app; o terminal dos agentes não lê o disco do app (dono 1000, modo 700).
O supervisor começa como root só com SETUID, SETGID e KILL (a guarda não aceita outras): troca de usuário ao iniciar
cada um (que perde tudo ao trocar) e encerra os dois. Um dos dois saiu: o outro é encerrado e o contêiner sai com o
código dele (quem liga de novo é o orquestrador, com espera crescente). SIGTERM (dormir): encerra os dois e espera.
"""
import os
import signal
import subprocess
import sys
import time

PYTHON = "/opt/hermes/.venv/bin/python"
PREFIXO = "MOTOR__"
APP_UID, MOTOR_UID = 1000, 10000
PRAZO = 25


def log(msg: str) -> None:
    print(f"[ergon-nuvem] {msg}", flush=True)


def ambientes(env: dict) -> tuple[dict, dict]:
    """O ambiente do app (sem nada do motor) e o do motor (só o dele e o da imagem, sem nada do app)."""
    app = {k: v for k, v in env.items() if not k.startswith(PREFIXO)}
    app["HOME"] = "/data"
    motor = {k: v for k, v in env.items() if not k.startswith(PREFIXO) and not k.startswith("ERGON_") and not k.startswith("NODE_")}
    motor.update({k[len(PREFIXO):]: v for k, v in env.items() if k.startswith(PREFIXO)})
    motor.setdefault("HOME", "/opt/data")
    return app, motor


def iniciar(cmd: list, uid: int, cwd: str, env: dict, disco: str) -> subprocess.Popen:
    """Inicia como `uid`; antes, o próprio dono fecha o disco dele (700): o disco nasce 755 e o banco 644, e no mesmo
    contêiner o outro usuário conseguiria listar e ler. Sem fechar, não inicia."""
    # o "cd" vem depois de trocar de usuário: o subprocess entra na pasta ainda como root (sem privilégios, root não
    # entra numa pasta 700 de outro dono)
    fechar = f'chmod 700 "{disco}" && [ "$(stat -c %a "{disco}")" = 700 ] && cd "{cwd}" && exec "$@"'
    return subprocess.Popen(["/bin/sh", "-c", fechar, "ergon-nuvem", *cmd], cwd="/", env=env, user=uid, group=uid, extra_groups=[], start_new_session=False)


def main() -> None:
    if os.getuid() != 0:
        sys.exit("ergon-nuvem: o supervisor precisa começar como root (só com SETUID, SETGID e KILL)")
    app_env, motor_env = ambientes(dict(os.environ))
    procs = {
        "motor": iniciar([PYTHON, "/usr/local/lib/ergon/ergon-vault.py", "gateway", "run"], MOTOR_UID, "/opt/data", motor_env, "/opt/data"),
        "app": iniciar(["/usr/local/bin/node", "server/src/index.ts"], APP_UID, "/app", app_env, "/data"),
    }
    log("app e motor de IA iniciados")
    parando = {"sim": False}

    def encerrar(*_a) -> None:
        parando["sim"] = True
        for p in procs.values():
            if p.poll() is None:
                p.terminate()

    signal.signal(signal.SIGTERM, encerrar)
    signal.signal(signal.SIGINT, encerrar)
    code = 0
    while True:
        saiu = [(n, p) for n, p in procs.items() if p.poll() is not None]
        if saiu:
            nome, p = saiu[0]
            code = p.returncode or 0
            if not parando["sim"]:
                log(f"o {nome} saiu (código {code}); encerrando o outro")
            encerrar()
            break
        time.sleep(0.5)
    fim = time.monotonic() + PRAZO
    for p in procs.values():
        try:
            p.wait(timeout=max(0.1, fim - time.monotonic()))
        except subprocess.TimeoutExpired:
            p.kill()
    sys.exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()

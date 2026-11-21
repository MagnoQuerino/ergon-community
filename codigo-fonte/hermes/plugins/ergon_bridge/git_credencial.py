"""Credential helper do git para o acesso de código do Ergon (rc.42, "mãos na massa").

O git do Terminal do motor chama este programa (gitcredentials: `get`, `store`, `erase`) quando fala com o Ergon em
/internal/git/v1/... . A senha de uso curto que o Ergon deu para UM repositório e UM trabalho fica num arquivo do motor
(0600), gravado pelo plugin (ergon_bridge, _git_guardar) e apagado quando o acesso acaba. Nada vai para o .git/config do
repositório, nem para variável de ambiente do agente; o token da conexão da pessoa nunca chega aqui (é o Ergon que fala
com o GitHub/GitLab). `store` e `erase` não fazem nada: só o plugin grava e apaga.

Uso (configurado pelo plugin em credential.<endereço do Ergon>/internal/git/.helper, com useHttpPath):
    python git_credencial.py <pasta> get
"""
from __future__ import annotations

import json
import os
import sys
import time


def _ler(pasta: str) -> dict:
    try:
        with open(os.path.join(pasta, "credenciais.json"), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001 - sem arquivo ou ilegível: o git segue para o próximo helper (e o Ergon pede de novo)
        return {}


def responder(pasta: str, pedido: dict[str, str]) -> str:
    """O que o git recebe: usuário e senha da concessão cujo endereço é o começo do pedido, se ainda vale."""
    host = pedido.get("host", "")
    caminho = pedido.get("path", "").lstrip("/")
    alvo = f"{pedido.get('protocol', '')}://{host}/{caminho}"
    agora = time.time()
    melhor = None
    for prefixo, c in _ler(pasta).items():
        if not isinstance(c, dict) or float(c.get("expira", 0)) <= agora:
            continue
        # o repositório inteiro e só ele: o prefixo termina em ".git"
        if alvo == prefixo or alvo.startswith(prefixo + "/"):
            if melhor is None or len(prefixo) > len(melhor[0]):
                melhor = (prefixo, c)
    if not melhor:
        return ""
    return f"username={melhor[1].get('usuario', 'ergon')}\npassword={melhor[1].get('senha', '')}\n"


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[2] != "get":
        return 0
    pedido: dict[str, str] = {}
    for linha in sys.stdin.read().splitlines():
        if "=" in linha:
            k, v = linha.split("=", 1)
            pedido[k.strip()] = v.strip()
    sys.stdout.write(responder(argv[1], pedido))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

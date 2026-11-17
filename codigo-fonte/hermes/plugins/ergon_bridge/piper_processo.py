"""A voz local do Ergon (Piper) num processo próprio (rc.33).

O Piper (piper-tts 1.8.0, projeto piper1-gpl) é GPL-3.0-or-later e traz o espeak-ng (GPL-3.0) compilado dentro. Para
que nada dele rode dentro do processo do motor (onde também roda o plugin do Ergon, Apache-2.0), o motor não usa o
provedor "piper" do Hermes, que importa o pacote no próprio processo: usa um provedor de comando (tts.providers.ergon-piper,
type: command) que chama este arquivo. Ele também não importa o Piper: só chama a linha de comando dele
(`python -m piper.download_voices` e `python -m piper`) em processos filhos, manda o texto pela entrada padrão e recebe
o WAV. Só a biblioteca padrão do Python.

  python piper_processo.py --voz pt_BR-cadu-medium --pasta <vozes> --texto <entrada.txt> --saida <saida.mp3>

Saída: o WAV do Piper convertido pelo ffmpeg para o formato do nome da saída (sem ffmpeg, o WAV vai com o nome pedido,
como o Hermes faz). Código de saída diferente de 0 com uma linha no stderr quando falha.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

# a voz é um nome do catálogo do Piper (pt_BR-cadu-medium): nada de caminho, opção ou espaço
VOZ = re.compile(r"[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]{1,40}-(x_low|low|medium|high)")
BAIXAR_S = 300
FALAR_S = 300


def baixada(pasta: str, voz: str) -> bool:
    return os.path.isfile(os.path.join(pasta, f"{voz}.onnx")) and os.path.isfile(os.path.join(pasta, f"{voz}.onnx.json"))


def rodar(cmd: list[str], entrada: bytes | None, prazo: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, input=entrada, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=prazo, check=False)


def principal(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Piper em processo próprio (Ergon)")
    p.add_argument("--voz", required=True)
    p.add_argument("--pasta", required=True)
    p.add_argument("--texto", required=True, help="arquivo com o texto (UTF-8)")
    p.add_argument("--saida", required=True)
    p.add_argument("--python", default=sys.executable, help="o Python que tem o pacote piper-tts")
    a = p.parse_args(argv)
    if not VOZ.fullmatch(a.voz):
        print(f"voz inválida: {a.voz[:60]}", file=sys.stderr)
        return 2
    os.makedirs(a.pasta, exist_ok=True)
    # 1º uso: a voz é baixada (uns 60 MB), também num processo do próprio Piper
    if not baixada(a.pasta, a.voz):
        r = rodar([a.python, "-m", "piper.download_voices", a.voz, "--download-dir", a.pasta], None, BAIXAR_S)
        if r.returncode != 0 or not baixada(a.pasta, a.voz):
            print(f"não consegui baixar a voz {a.voz}: {r.stderr.decode('utf-8', 'replace')[-300:]}", file=sys.stderr)
            return 3
    with open(a.texto, encoding="utf-8") as f:
        texto = f.read().strip()
    if not texto:
        print("texto vazio", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="ergon-piper-") as tmp:
        wav = os.path.join(tmp, "fala.wav")
        # o texto vai pela entrada padrão; cada linha vira um trecho do mesmo WAV
        r = rodar([a.python, "-m", "piper", "-m", a.voz, "--data-dir", a.pasta, "-f", wav], texto.encode("utf-8"), FALAR_S)
        if r.returncode != 0 or not os.path.isfile(wav) or os.path.getsize(wav) <= 44:
            print(f"o Piper não gerou o áudio: {r.stderr.decode('utf-8', 'replace')[-300:]}", file=sys.stderr)
            return 4
        saida = os.path.abspath(a.saida)
        os.makedirs(os.path.dirname(saida), exist_ok=True)
        ffmpeg = shutil.which("ffmpeg")
        if saida.lower().endswith(".wav") or not ffmpeg:
            shutil.move(wav, saida)
        else:
            c = rodar([ffmpeg, "-y", "-loglevel", "error", "-i", wav, saida], None, 120)
            if c.returncode != 0 or not os.path.isfile(saida):
                print(f"ffmpeg falhou: {c.stderr.decode('utf-8', 'replace')[-300:]}", file=sys.stderr)
                return 5
    return 0


if __name__ == "__main__":
    sys.exit(principal())

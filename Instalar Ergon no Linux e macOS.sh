#!/usr/bin/env bash
# Instala o Ergon neste computador pelo lançador (macOS, ou Linux para quem prefere o terminal). Precisa do Podman e do
# podman-compose instalados (no macOS, com a máquina do Podman ligada). No Linux, o caminho principal é o .deb da raiz.
# Num terminal, nesta pasta:  bash "Instalar Ergon no Linux e macOS.sh"
# No fim o navegador abre o Ergon e o comando "ergon" passa a valer em qualquer terminal novo.
exec bash "$(cd "$(dirname "$0")" && pwd)/codigo-fonte/instalador/ergon.sh" instalar

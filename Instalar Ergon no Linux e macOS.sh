#!/usr/bin/env bash
# Instala o Ergon neste computador. Precisa do Docker (Docker Desktop no macOS, Docker Engine no Linux) ligado.
# Num terminal, nesta pasta:  bash "Instalar Ergon no Linux e macOS.sh"
# No fim o navegador abre o Ergon e o comando "ergon" passa a valer em qualquer terminal novo.
exec bash "$(cd "$(dirname "$0")" && pwd)/codigo-fonte/instalador/ergon.sh" instalar

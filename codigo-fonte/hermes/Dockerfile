# Motor de IA do Ergon: a imagem oficial do Hermes (versão fixada por digest) + o cofre gocryptfs.
# Os dados do motor (login das contas, histórico, memória) ficam cifrados no volume; a chave vem do Ergon
# depois que a pessoa destranca. Nada do código do Hermes muda: só um passo antes do ponto de entrada.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.2@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919
FROM ${HERMES_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends gocryptfs fuse3 \
 && rm -rf /var/lib/apt/lists/*

COPY vault/ergon-vault.py /usr/local/lib/ergon/ergon-vault.py
# plugin do Ergon dentro da imagem (a instalação não depende de arquivos do projeto); em desenvolvimento o
# docker-compose.yml monta a pasta do projeto por cima
COPY plugins/ergon_bridge /opt/ergon/plugins/ergon_bridge

ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/usr/local/lib/ergon/ergon-vault.py"]

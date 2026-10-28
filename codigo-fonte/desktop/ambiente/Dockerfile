# Ambiente do Ergon no Windows: uma distribuição Linux mínima, importada no WSL2 com nome e pasta próprios
# ("Ergon"), com o Docker Engine dentro. Componente do manifesto da versão, baixado uma vez por instalação —
# nada é baixado de repositório de pacotes no computador da pessoa. Gerado na esteira:
#   docker build -t ergon-ambiente desktop/ambiente && docker export $(docker create ergon-ambiente) | gzip -n > ...
FROM alpine:3.20.3@sha256:1e42bbe2508154c9126d48c2b8a75420c3544343bf86fd041fb7527e017a4b4a
# docker + compose; bash, curl, jq, unzip e coreutils: o lançador do pacote (ergon.sh) roda aqui dentro
RUN apk add --no-cache docker docker-cli-compose bash curl jq unzip coreutils findutils ca-certificates \
 && rm -rf /var/cache/apk/* /tmp/*
COPY wsl.conf /etc/wsl.conf
COPY daemon.json /etc/docker/daemon.json
COPY ergon-ambiente /usr/local/bin/ergon-ambiente
ARG VERSAO=dev
RUN echo "$VERSAO" > /etc/ergon-ambiente
RUN chmod 0755 /usr/local/bin/ergon-ambiente && chmod 0644 /etc/wsl.conf /etc/docker/daemon.json

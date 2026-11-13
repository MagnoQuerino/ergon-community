# Motor de IA do Ergon: a imagem oficial do Hermes (versão fixada por digest) + o cofre gocryptfs.
# Os dados do motor (login das contas, histórico, memória) ficam cifrados no volume; a chave vem do Ergon
# depois que a pessoa destranca. Nada do código do Hermes muda: só um passo antes do ponto de entrada.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.2@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919
FROM ${HERMES_IMAGE}

# versão do plugin do Ergon nesta imagem: a mesma do plugin.yaml e de PLUGIN_VERSION (um teste confere); o gerente e o
# diagnóstico leem sem abrir o motor
LABEL ergon.plugin.version="0.7.0"

RUN apt-get update \
 && apt-get install -y --no-install-recommends gocryptfs fuse3 \
 && rm -rf /var/lib/apt/lists/*

# rc.27: pacotes que o Hermes já sabe usar mas a imagem oficial não traz (o Hermes instalaria no primeiro uso, pela
# rede, num ambiente que o Ergon não guarda). Todos nas versões que o próprio Hermes fixa (pyproject.toml):
#  - ddgs ("Busca privada, sem fornecedores intermediários": plugins/web/ddgs), extra "ddgs";
#  - edge-tts (voz: ler a resposta em voz alta, sem chave), extra "edge-tts";
#  - faster-whisper (voz: transcrever o áudio da pessoa no próprio computador), extra "stt-whisper". O modelo de fala
#    é baixado no primeiro uso (precisa de rede uma vez).
# O ambiente do Hermes não traz o pip: entra só para esta instalação e sai em seguida. A última linha confere que os
# pacotes ficaram importáveis pela mesma conferência do Hermes (pm/extras.py, available): se não, a imagem não é
# construída. Sem eles, cada opção aparece no Ergon e diz que chega com a próxima atualização da equipe.
RUN /opt/hermes/.venv/bin/python -m ensurepip \
 && /opt/hermes/.venv/bin/python -m pip install --no-cache-dir "ddgs==9.16.0" "edge-tts==7.2.7" "faster-whisper==1.2.1" \
 && /opt/hermes/.venv/bin/python -m pip uninstall -y pip \
 && cd /opt/hermes && /opt/hermes/.venv/bin/python -c "import ddgs, edge_tts, faster_whisper; from pm.extras import available; assert all(available(x) for x in ('ddgs', 'edge-tts', 'stt-whisper'))"

# rc.27: o navegador dos agentes (ferramentas browser_*). O Hermes acha o agent-browser no depósito do pm ou no PATH
# (tools/browser_tool_install.py, _find_agent_browser), e a imagem oficial traz só o Chromium (pm ensure de uv, chromium,
# npm, ffmpeg, ripgrep). Baixado pelo próprio pm do Hermes, na versão e com a conferência do lock dele. O depósito da
# imagem está selado: o pm grava o pacote novo no depósito de HERMES_HOME (~/.hermes/tools aqui na construção;
# /opt/data/tools seria o volume da pessoa e sumiria debaixo dele). Por isso o pacote vai para /opt/ergon/tools e entra
# no PATH por /usr/local/bin/agent-browser, legível pelo usuário do motor. A conferência final é a do próprio Hermes, com
# um HERMES_HOME vazio, como o motor ligado o vê.
RUN set -eu; cd /opt/hermes; \
    env -u HERMES_HOME python3 -c 'from pm import ensure; ensure("agent-browser", explicit=True)'; \
    ab="$(env -u HERMES_HOME python3 -c 'from pm import installed_package; print(installed_package("agent-browser").binary)')"; \
    test -x "$ab"; pasta="$(dirname "$(dirname "$ab")")"; \
    mkdir -p /opt/ergon/tools; cp -a "$pasta" /opt/ergon/tools/agent-browser; rm -rf "$pasta" /root/.hermes/cache/partials; \
    chmod -R a+rX /opt/ergon/tools; ln -s "/opt/ergon/tools/agent-browser/bin/$(basename "$ab")" /usr/local/bin/agent-browser; \
    agent-browser --version; \
    HERMES_HOME=/tmp/ergon-confere /opt/hermes/.venv/bin/python -c "from tools.browser_tool_install import _find_agent_browser; p = _find_agent_browser(validate=False); assert p == '/usr/local/bin/agent-browser', p; print('o Hermes acha', p)"; \
    rm -rf /tmp/ergon-confere

COPY vault/ergon-vault.py /usr/local/lib/ergon/ergon-vault.py
# plugin do Ergon dentro da imagem (a instalação não depende de arquivos do projeto)
COPY plugins/ergon_bridge /opt/ergon/plugins/ergon_bridge

ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/usr/local/lib/ergon/ergon-vault.py"]

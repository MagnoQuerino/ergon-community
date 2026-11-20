# Motor de IA do Ergon: a imagem oficial do Hermes (versão fixada por digest) + o cofre gocryptfs.
# Os dados do motor (login das contas, histórico, memória) ficam cifrados no volume; a chave vem do Ergon
# depois que a pessoa destranca. Nada do código do Hermes muda: só um passo antes do ponto de entrada.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.2@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919
FROM ${HERMES_IMAGE}

# versão do plugin do Ergon nesta imagem: a mesma do plugin.yaml e de PLUGIN_VERSION (um teste confere); o gerente e o
# diagnóstico leem sem abrir o motor
LABEL ergon.plugin.version="0.8.0"

RUN apt-get update \
 && apt-get install -y --no-install-recommends gocryptfs fuse3 \
 && rm -rf /var/lib/apt/lists/*

# rc.27: pacotes que o Hermes já sabe usar mas a imagem oficial não traz (o Hermes instalaria no primeiro uso, pela
# rede, num ambiente que o Ergon não guarda). Todos nas versões que o próprio Hermes fixa (pyproject.toml):
#  - ddgs ("Busca privada, sem fornecedores intermediários": plugins/web/ddgs), extra "ddgs";
#  - edge-tts (voz: ler a resposta em voz alta, sem chave), extra "edge-tts";
#  - faster-whisper (voz: transcrever o áudio da pessoa no próprio computador), extra "stt-whisper". O modelo de fala
#    é baixado no primeiro uso (precisa de rede uma vez);
#  - piper-tts (rc.33: a voz padrão do "Ouvir", no próprio computador e sem internet), extra "piper". LICENÇA: o
#    piper-tts 1.3+ vem do projeto piper1-gpl (OHF-Voice) e é GPL-3.0-or-later (o wheel embute o espeak-ng, também
#    GPL-3.0); o antigo rhasspy/piper (piper-tts 1.2.0) era MIT. Vai sem alterações, só nesta imagem, e roda sempre num
#    processo próprio: o motor usa o provedor de comando do Ergon (plugins/ergon_bridge/piper_processo.py chama
#    `python -m piper`, com o texto pela entrada padrão e o WAV de volta), nunca o provedor "piper" do Hermes, que
#    importaria o pacote no processo do motor. Ver o NOTICE ("Componentes GPL e onde obter o código"). As vozes
#    (pt_BR-cadu-medium, en_US-ljspeech-medium) são baixadas no primeiro uso, como o modelo do Whisper.
# O ambiente do Hermes não traz o pip: entra só para esta instalação e sai em seguida. A última linha confere que os
# pacotes ficaram importáveis pela mesma conferência do Hermes (pm/extras.py, available): se não, a imagem não é
# construída. Sem eles, cada opção aparece no Ergon e diz que chega com a próxima atualização da equipe.
RUN /opt/hermes/.venv/bin/python -m ensurepip \
 && /opt/hermes/.venv/bin/python -m pip install --no-cache-dir "ddgs==9.16.0" "edge-tts==7.2.7" "faster-whisper==1.2.1" "piper-tts==1.8.0" \
 && /opt/hermes/.venv/bin/python -m pip uninstall -y pip \
 && cd /opt/hermes && /opt/hermes/.venv/bin/python -c "import ddgs, edge_tts, faster_whisper; from pm.extras import available; assert all(available(x) for x in ('ddgs', 'edge-tts', 'stt-whisper', 'piper'))" \
 && /opt/hermes/.venv/bin/python -m piper --help > /dev/null

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

# rc.36: RTK (Rust Token Killer, github.com/rtk-ai/rtk), edição OSS (só Apache-2.0; a edição padrão traz o rtk-engine sob
# BUSL-1.1, que não redistribuímos). Comprime a saída de comandos do terminal (git, ls, grep, testes, docker…) antes de
# ela ir ao modelo: o plugin do Ergon passa cada comando do terminal por `rtk rewrite` (a mesma lógica do adaptador
# oficial do RTK para o Hermes) e, sem equivalente ou em qualquer falha, o comando roda como veio. Versão e SHA-256
# fixados (checksums.txt da versão); a imagem não é construída se o arquivo não conferir.
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) alvo=x86_64; soma=a28407dc13038bdc9c2a1f5a047b0c636e0c1d495b15523576e2adb992a06a17 ;; \
      arm64) alvo=aarch64; soma=9786c61dbbea704e1468ee7060930d3b45b67f79ba2babfb73463e85340628d9 ;; \
      *) echo "arquitetura sem RTK: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    /opt/hermes/.venv/bin/python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], '/tmp/rtk.tgz')" \
      "https://github.com/rtk-ai/rtk/releases/download/v1.2.0/rtk-oss-${alvo}-unknown-linux-musl.tar.gz"; \
    echo "${soma}  /tmp/rtk.tgz" | sha256sum -c -; \
    mkdir -p /opt/ergon/tools/rtk; tar xzf /tmp/rtk.tgz -C /opt/ergon/tools/rtk rtk LICENSE; rm /tmp/rtk.tgz; \
    chmod -R a+rX /opt/ergon/tools/rtk; ln -s /opt/ergon/tools/rtk/rtk /usr/local/bin/rtk; \
    rtk --version; test "$(rtk rewrite 'git status')" = "rtk git status"

# rc.39: competências de terceiros na biblioteca (competencias/ORIGEM.md: origem, commit e licença de cada uma). Entram
# ao lado das que o Hermes traz e chegam à biblioteca de cada instalação pela sincronia do próprio motor; nenhum agente
# as carrega até a pessoa ligar no Ergon. A imagem não é construída com nome repetido na biblioteca (o Ergon acha a
# competência pelo nome), com cabeçalho sem nome/descrição, ou se a varredura de segurança do próprio motor (a mesma de
# uma competência enviada pela pessoa) der "dangerous" em alguma das que vieram de fora.
COPY competencias/software-development /opt/hermes/skills/software-development
COPY competencias/productivity /opt/hermes/skills/productivity
COPY competencias/licencas competencias/ORIGEM.md /opt/ergon/competencias/
RUN chmod -R a+rX /opt/hermes/skills /opt/ergon/competencias \
 && /opt/hermes/.venv/bin/python - <<'PY'
import collections, pathlib, re, sys
nomes = collections.Counter(); ruins = []
for f in pathlib.Path('/opt/hermes/skills').rglob('SKILL.md'):
    cab = re.match(r'---\n(.*?)\n---', f.read_text(encoding='utf-8'), re.S)
    nome = re.search(r'^name:\s*["\']?([^"\'\n]+)', cab.group(1), re.M) if cab else None
    if not nome or not re.search(r'^description:', cab.group(1), re.M) or nome.group(1).strip() != f.parent.name:
        ruins.append(str(f))
    nomes[f.parent.name] += 1
rep = [n for n, c in nomes.items() if c > 1]
if ruins or rep:
    sys.exit(f'competências com cabeçalho ruim: {ruins}; nomes repetidos: {rep}')
sys.path.insert(0, '/opt/hermes')
from tools.skills_guard import scan_skill
fora = [d for d in pathlib.Path('/opt/hermes/skills').glob('*/*') if (d / 'SKILL.md').is_file() and (d / '.ergon-de-fora').exists()]
perigo = [d.name for d in fora if str(getattr(scan_skill(d, source='community'), 'verdict', '')) == 'dangerous']
if perigo or not fora:
    sys.exit(f'varredura de segurança recusou: {perigo} (de fora: {len(fora)})')
print(f'biblioteca: {len(nomes)} competências, {len(fora)} de fora conferidas')
PY

COPY vault/ergon-vault.py /usr/local/lib/ergon/ergon-vault.py
# plugin do Ergon dentro da imagem (a instalação não depende de arquivos do projeto)
COPY plugins/ergon_bridge /opt/ergon/plugins/ergon_bridge

# rc.39: o código do Hermes vem sem os .pyc (só as bibliotecas trazem) e com PYTHONDONTWRITEBYTECODE=1: cada partida do
# motor, e cada "hermes config set", recompilava tudo o que importava. Compilado aqui uma vez (conferência por conteúdo,
# sem depender da data do arquivo): a partida fica segundos mais curta em qualquer computador, e bem mais na nuvem.
RUN /opt/hermes/.venv/bin/python -m compileall -q -j 0 --invalidation-mode unchecked-hash -x "(/\\.venv/|/node_modules/|/tests?/)" \
      /opt/hermes /opt/ergon/plugins /usr/local/lib/ergon > /dev/null || true; \
    test "$(find /opt/hermes/gateway /opt/hermes/agent -name '*.pyc' | wc -l)" -gt 50

ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/usr/local/lib/ergon/ergon-vault.py"]

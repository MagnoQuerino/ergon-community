"""Cofre do motor de IA (gocryptfs) — roda ANTES do Hermes, como processo 1 do contêiner.

O Hermes grava em /opt/data (login das contas, histórico, memória dos agentes) em texto aberto. Aqui esse
diretório passa a ser a vista decifrada de um cofre gocryptfs no volume /vault: em disco só existe o lado
cifrado. A chave vem do Ergon (derivada da chave mestra, que só existe depois que a pessoa destranca o Ergon)
pela rede interna, com o token da ponte. Sem chave, o Hermes não sobe.

Primeira vez: cria o cofre e copia para dentro os dados de antes (volume antigo montado em /legacy, só
leitura — ele não é apagado; a pessoa decide quando remover). Depois monta, copia o plugin do Ergon, aplica as
migrações de configuração do Ergon que ainda faltam (MIGRACOES) e passa a vez ao ponto de entrada original do Hermes
(s6), mantendo o processo 1. Assim a instalação não precisa de nenhum passo manual no motor.

Sem ERGON_VAULT=1, só passa a vez (comportamento original). Com o argumento --ergon-configurar (motor único, sem
cofre: scripts/hermes-init.mjs), só aplica a configuração, com as mesmas migrações, e sai.
"""

from __future__ import annotations

import ast
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

# Configuração do motor pelo Ergon, em migrações numeradas (o modo de motor único, scripts/hermes-init.mjs, usa
# estas mesmas). Cada cofre guarda em MIGRACOES_MARKER a última que recebeu ({"versao": N}) e, a cada abertura, recebe
# em ordem só as que faltam, gravando a marca a cada uma. CONFIG_MARKER fica sempre com o texto "1", o único que as
# imagens até a rc.22 entendem: numa volta automática para a imagem anterior, o cofre dela vê "1" e não reaplica a
# configuração inteira por cima das escolhas da pessoa (Terminal e Executar código ligados). Vale a maior versão
# legível das duas: sem MIGRACOES_MARKER (cofre de antes) ou com ela ilegível, o CONFIG_MARKER "1" = migração 1.
# REGRA: migração publicada não muda nunca (o teste hermes/tests/test_ergon_vault_config.py prende o conteúdo). Mudou
# a configuração do motor? Crie a migração N+1, aditiva e idempotente: ela vale para cofres novos e antigos sem
# desfazer o que a pessoa escolheu depois (ferramentas ligadas, modelo, logins).
# Só chaves do config.yaml, pelo próprio Hermes ("hermes config set", como o usuário do motor). Nunca logins, .env de
# provedores, memória, sessões ou skills.
CONFIG_MARKER = ".ergon-config"
MIGRACOES_MARKER = ".ergon-migracoes"
# Conjuntos de ferramentas que o plugin do Ergon registra (o mesmo de _ERGON_PLUGIN_TOOLSETS no plugin)
ERGON_PLUGIN_TOOLSETS = ("ergon_conexoes", "ergon_cartoes")
API_TOOLSETS_PADRAO = ["todo", "web", "vision", "image_gen", "skills", "ergon_conexoes"]
MIGRACOES: tuple[tuple[int, str, dict], ...] = (
    # 1: plugin ligado; na API (agentes do Ergon) só o conjunto seguro de ferramentas — o plugin barra, a cada chamada,
    # o que o agente não tem; Teams e WhatsApp diretos só com "todo"; limites econômicos; desconhecidos ignorados.
    (1, "primeira configuração", {"passos": [
        ["plugins", "enable", "ergon_bridge"],
        ["config", "set", "platform_toolsets.api_server", '["todo","web","vision","image_gen","skills","ergon_conexoes"]'],
        ["config", "set", "platform_toolsets.teams", '["todo"]'],
        ["config", "set", "platform_toolsets.whatsapp", '["todo"]'],
        ["config", "set", "agent.max_turns", "20"],
        ["config", "set", "agent.reasoning_effort", "low"],
        ["config", "set", "unauthorized_dm_behavior", "ignore"],
    ]}),
    # 2: Conexões nos cofres de antes. Acrescenta ergon_conexoes ao que a plataforma da API já tem (Terminal e Executar
    # código que a pessoa ligou continuam) e marca os conjuntos do plugin como conhecidos nas três plataformas: no
    # Hermes, conjunto de plugin conhecido e fora da lista quer dizer desligado (hermes_cli/tools_config.py,
    # _enabled_plugin_toolsets). Assim o "desligar" da tela vale e Teams/WhatsApp diretos não ganham as Conexões sem
    # pedido. known_plugin_toolsets também é do Hermes (hermes_cli/left_core_migration.py): sempre a UNIÃO com o que já
    # está lá. A lista da plataforma vai antes da marca de conhecido: se só a marca entrasse, as Conexões desligariam.
    (2, "conexões", {"unir": [
        ["platform_toolsets.api_server", ["ergon_conexoes"], API_TOOLSETS_PADRAO],
        ["known_plugin_toolsets.api_server", ["ergon_conexoes"], []],
        ["known_plugin_toolsets.teams", ["ergon_conexoes"], []],
        ["known_plugin_toolsets.whatsapp", ["ergon_conexoes"], []],
    ]}),
    # 3 (rc.26): a conversa de cada agente é resumida mais cedo (docs/CUSTO_DAS_CHAMADAS.md, "Conversa resumida"). O
    # Hermes já resume sozinho, mas só perto do limite do modelo: compression.threshold é 0,50 e, em modelos com janela
    # abaixo de 512 mil, sobe para 0,75 (agent/context_compressor.py, _effective_threshold_percent) — 96 mil numa janela
    # de 128 mil, 150 mil numa de 200 mil. O coordenador gastava 55–65 mil por chamada sem nunca chegar lá.
    # compression.threshold_tokens é o teto absoluto do Hermes (vale o menor entre ele e a fração da janela). Decisão de
    # 09/11: 150 mil (mais contexto antes de resumir). Na prática: em janelas de 200 mil ou mais, resume a partir de 150 mil;
    # em janelas menores (ex.: 128 mil), vale a fração do próprio Hermes (96 mil). O resumo deixa partes fixas ~15 mil +
    # resumo até 10 mil + o trecho recente, que fica inteiro (o último pedido da pessoa nunca sai).
    # O fio: o resumo do Hermes ("lean", o padrão) guarda as mensagens da pessoa, as mais novas primeiro, até 4 mil
    # caracteres cada e 24 mil no total (o que passa disso sai encurtado: anexos e documentos juntados ao pedido também), e o
    # pedido atual nunca é resumido. O resumo manda buscar o resto com session_search, que os agentes do Ergon não têm (ela
    # leria as conversas de todos os workspaces do motor): as instruções do Ergon dizem para consultar de novo pela
    # ferramenta de origem (RESUMO_HOW, server/src/services/runs.ts).
    # (Antes da publicação o número era 50 mil: mais economia, menos contexto. A escolha de 150 mil foi do dono do produto.)
    # Pedido com documento grande (o Ergon junta até 200 mil caracteres, ~50 mil tokens, à mensagem do pedido, que fica
    # inteira no trecho recente): a chamada pode passar do limite mesmo depois do resumo. O Hermes resume a parte antiga (o que
    # ainda reduz a conversa), vê pelo total informado que não ficou abaixo do limite e, na segunda vez sem efeito, para de
    # tentar por 300 s (trava contra repetição, agent/context_compressor.py), com uma tentativa por janela depois disso.
    # o teste do cofre confere essa trava no Hermes de verdade.
    # Só se a chave não existe: um valor que a pessoa (Configurações › Andamento da equipe, "Resumir conversas longas",
    # pela ponte de controle) ou alguém gravou — inclusive null, o "desligado" — fica como está. O mesmo número está em
    # COMPACTAR_LIMITE no plugin (um teste confere).
    (3, "compactação da conversa", {"se_ausente": [
        ["compression.threshold_tokens", "150000"],
    ]}),
    # 4 (rc.27): a equipe nativa. Cada agente do Ergon passa a ser um perfil do Hermes (profiles/<nome>: SOUL, memória,
    # competências e histórico próprios), atendido pelo MESMO gateway em /p/<perfil>/v1/runs. Com um perfil só no disco, o
    # gateway decide no boot que não há o que multiplexar (hermes_cli/gateway_multiplex_mode.py) e passa a responder 404 a
    # todo /p/<outro>/ até reiniciar; com a chave explícita ele multiplexa desde o primeiro boot e acha cada perfil novo pela
    # pasta, sem reiniciar (provado no motor de verdade em 10/11). Os perfis em si são criados pelo plugin, a pedido do
    # servidor (ponte de controle, /ergon/v1/perfis/<nome>): aqui só a chave. O perfil padrão continua igual (contas de IA,
    # configuração da equipe, conversas de antes).
    (4, "equipe nativa (perfis)", {"passos": [
        ["config", "set", "gateway.multiplex_profiles", "true"],
    ]}),
    # 5 (rc.27, frente "rápidos"): padrões do que o Hermes faz sozinho, só onde ninguém escolheu nada (a chave não existe).
    #  - curator.enabled false: o Curator do Hermes marca como paradas (14 dias) e arquiva (30 dias) as competências
    #    criadas por agente que ninguém usa, sozinho, a cada 7 dias (agent/curator.py; padrão do Hermes: ligado). No Ergon
    #    a pessoa aprova cada competência (Treinar): nada some sem ela pedir. Arquivar não dá mais poder à equipe (só tira
    #    competências da lista, sem a pessoa pedir), e o Curator só administra as criadas por agente, que no Ergon quase não
    #    existem: é uma economia, não um benefício, e fica desligado. A opção fica à vista em Configurações ("Arrumar
    #    competências sem uso"), e as competências treinadas ficam fixadas no motor e em cada perfil (o Curator pula as
    #    fixadas), pela ponte de controle.
    #  - provider_routing.data_collection deny: "Não treinar com os meus dados", ligado por padrão (vale no OpenRouter, que
    #    é quem aceita o pedido; a pessoa desliga em Configurações › Segurança). Na rota de execuções quem põe o pedido em
    #    cada chamada é o plugin (on_llm_request), lendo esta mesma chave.
    #  - auxiliary.background_review.enabled true + skills.creation_nudge_interval 0 (regra do dono de 12/11: benefício vem
    #    ligado). A revisão de fundo do Hermes faz duas coisas separadas, depois que a resposta já foi entregue: revisar as
    #    competências (dispara a cada skills.creation_nudge_interval passos, só com skill_manage à vista: agent/agent_init.py,
    #    _apply_agent_section; agent/turn_finalizer.py) e anotar na memória longa (dispara a cada memory.nudge_interval = 10
    #    mensagens da pessoa, só onde há a ferramenta memory: agent/turn_context.py, _tick_memory_nudge). No Ergon a trava do
    #    Treinar barra toda escrita de competência fora de um treinamento autorizado: a revisão de competências só gastava
    #    chamadas (medido em hermes/tests/test_ergon_bridge_rapidos.py: 3 chamadas para não gravar nada), e com o intervalo 0
    #    ela nunca dispara. Fica a anotação de memória, a parte que traz benefício: só nos perfis dos agentes (a ferramenta
    #    memory vem no perfil, migração 4), cerca de uma chamada a mais a cada 10 mensagens, no mesmo modelo e aproveitando o
    #    cache da conversa. A gravação fica em espera (memory.write_approval, que o plugin liga em cada perfil) e a pessoa
    #    aprova na aba Memória; ela desliga em Configurações › Andamento da equipe ("Anotar na memória depois da conversa").
    #    A política de ferramentas do Ergon reconhece a sessão também depois do fim da execução (a revisão roda depois da
    #    entrega). O perfil de cada agente herda as duas chaves da configuração da equipe.
    #  - security.redact_secrets true: o Hermes já mascara segredos no que mostra e registra (padrão dele); fica gravado.
    # Os modelos reserva (fallback_providers), a busca privada e o idioma são escolhas da pessoa: vão pela ponte de controle.
    (5, "padrões da rc.27", {"se_ausente": [
        ["curator.enabled", "false"],
        ["auxiliary.background_review.enabled", "true"],
        ["skills.creation_nudge_interval", "0"],
        ["provider_routing.data_collection", "deny"],
        ["security.redact_secrets", "true"],
    ]}),
    # 6 (rc.27, frente dos cartões): o conjunto ergon_cartoes do plugin
    # (perguntar de volta, pedido seguro de chave, senha de administrador) ligado na API e conhecido nas três plataformas,
    # do mesmo jeito da migração 2: união com o que já está lá (o que a pessoa ligou continua), a lista da API antes da
    # marca de conhecido, e Teams/WhatsApp diretos sem o conjunto (conhecido e fora da lista = desligado). A base, para um
    # cofre sem a lista, é escrita aqui (e não por uma constante) para o conteúdo publicado nunca mudar por tabela.
    (6, "cartões", {"unir": [
        ["platform_toolsets.api_server", ["ergon_cartoes"], ["todo", "web", "vision", "image_gen", "skills", "ergon_conexoes"]],
        ["known_plugin_toolsets.api_server", ["ergon_cartoes"], []],
        ["known_plugin_toolsets.teams", ["ergon_cartoes"], []],
        ["known_plugin_toolsets.whatsapp", ["ergon_cartoes"], []],
    ]}),
    # 7 (rc.27, frente "recursos"): proteções para quem liga Terminal ou Executar
    # código, que não custam nada enquanto essas ferramentas estão desligadas, e a limpeza dos arquivos temporários.
    # (a) checkpoints.enabled: o Hermes guarda o
    # estado da pasta de trabalho antes da primeira gravação de arquivo de cada pedido (tools/checkpoint_manager.py), e o
    # Ergon oferece "voltar atrás" (ponte: /ergon/v1/checkpoints). Só se a chave não existe: quem escolheu fica. (b) o
    # plugin security-guidance, que vem com o Hermes: acrescenta um aviso ao resultado da gravação de um arquivo com
    # padrão perigoso (eval, pickle.load, verify=False...), sem barrar nada e sem chamada de modelo. O que a pessoa
    # desligar depois em Configurações › Capacidades da equipe fica desligado (a migração roda uma vez). (c) o plugin
    # disk-cleanup, que vem com o Hermes: apaga os arquivos temporários de teste e de saída que os agentes criam dentro do
    # motor (test_*, tmp_*), sem nunca tocar em workspace, projetos, perfis, memória, sessões ou competências (README do
    # plugin). Não chama o modelo e poupa disco; a pessoa desliga em Capacidades da equipe. Os plugins são lidos quando o
    # Hermes sobe, e a migração roda antes dele: vale desde a primeira abertura.
    # As ferramentas novas da rc.27 (navegador, vídeo, leitura de arquivos, voz) ligam na migração 10.
    (7, "proteções do terminal e limpeza", {
        "se_ausente": [["checkpoints.enabled", "true"]],
        "passos": [["plugins", "enable", "security-guidance"], ["plugins", "enable", "disk-cleanup"]],
    }),
    # 8 (rc.27, frente "canais"): conversar com a equipe pelo Telegram e pelo
    # Discord (o plugin entrega cada mensagem ao Ergon antes de qualquer turno do Hermes: pre_gateway_dispatch).
    # - Telegram guarda por até 24 horas o que chega com o bot desligado, mas o adaptador do Hermes descarta essa fila ao
    #   iniciar (platforms.telegram.extra.drop_pending_on_cold_boot, padrão true: bom para servidor sempre ligado). O
    #   Ergon fecha junto com o computador da pessoa: com false, o que ela mandou com o Ergon fechado chega, em ordem,
    #   quando ele abre (plugins/platforms/telegram/adapter.py, _cold_boot_drop_pending; docs do Hermes, "Cold-boot
    #   pending queue"). O Discord não guarda conversa direta para o bot desligado, e a recuperação do adaptador
    #   (missed_message_backfill) só olha canais de servidor: nada a ligar aqui, e a tela diz isso.
    # Só o que está ausente: um valor que alguém gravou fica como está.
    (8, "canais Telegram e Discord", {"se_ausente": [
        ["platforms.telegram.extra.drop_pending_on_cold_boot", "false"],
    ]}),
    # 9 (rc.27, frente "rotinas"): aprovações nativas. O que pede o sim da pessoa (comandos perigosos do Terminal, e o que o
    # Ergon segura no portão de aprovação do Hermes: ações nas contas que pedem confirmação, abrir sites ou rodar programas
    # depois de ler as contas) para o turno até ela decidir no cartão do Ergon, que responde pela API
    # (POST /v1/runs/{id}/approval). (a) approvals.mode manual: o padrão do Hermes é "smart", que antes de perguntar à pessoa
    # faz uma chamada a mais ao modelo e pode aprovar sozinho um comando de risco; no Ergon quem aprova é a pessoa (e sai
    # mais barato). (b) approvals.timeout 300: o turno espera até 5 minutos (o mesmo número de PRAZO_DO_MOTOR_MS no
    # servidor); sem resposta, o cartão continua com a pessoa e a resposta segue depois. Só o que está ausente: quem
    # escolheu outro valor fica com ele.
    (9, "aprovações nativas", {"se_ausente": [
        ["approvals.mode", "manual"],
        ["approvals.timeout", "300"],
    ]}),
    # 10 (rc.27, regra do dono de 12/11: todos os benefícios, mesmo os que custam, ligados por padrão; a pessoa reduz para
    # economizar). Só onde ninguém escolheu: o que a pessoa ligou, desligou ou mudou fica como está.
    #  - trocar_se (tipo novo, aditivo): troca o valor SÓ onde ainda está o que a migração 1 gravou. A migração 1 é publicada
    #    e não muda; quem tem outro valor (escolhido na tela ou por alguém) fica com ele.
    #    · agent.max_turns 20 → 90: o padrão do Hermes é sem limite (o teto cortava trabalhos no meio sem avisar:
    #      hermes_cli/config_defaults.py), e 90 é o número que o próprio Hermes grava na instalação enxuta
    #      (hermes_cli/setup_quick.py). O servidor guarda a escolha da pessoa (Configurações › Andamento da equipe, "Passos
    #      por pedido") e manda de novo quando o motor abre: quem escolheu 20 de propósito continua com 20. O mesmo número
    #      está em PASSOS_PADRAO no servidor (server/src/services/custo.ts); o teto, em PASSOS_MAX no plugin (um teste confere).
    #    · agent.reasoning_effort low → high: o "low" só veio da migração 1 (não havia tela para isso). "high" é o máximo
    #      útil sem chegar aos níveis extremos (xhigh, max, ultra); o Hermes ajusta ao que cada provedor aceita e não manda
    #      nada a um modelo que não raciocina (hermes_constants.py, parse_reasoning_effort). A pessoa reduz em Configurações ›
    #      Andamento da equipe ("Profundidade do raciocínio", pela ponte: /ergon/v1/raciocinio). Os perfis copiam o valor.
    #  - se_ausente:
    #    · agent.budget_warning_ratio 0.75: com um teto de passos, o Hermes avisa o agente uma vez, perto do fim, para fechar
    #      o trabalho (sem isso o corte acontece calado). Custa uma frase curta, só nos pedidos longos.
    #    · web.extract_backend exa: com o pacote da busca direta (ddgs) na imagem e sem chave de busca, o Hermes escolhe sozinho
    #      o DuckDuckGo, que SÓ busca, e ler a página inteira (web_extract) passaria a falhar ("search-only backend":
    #      tools/web_tools.py, _autodetect_backend; tools/web_tools_extract.py). A Exa lê páginas sem chave pelo plano
    #      gratuito (plugins/web/exa/provider.py, use_keyless) e, com a chave da pessoa, pelo plano dela. A busca em si fica
    #      com a escolha do Hermes. Com a busca privada ligada (sem os serviços gratuitos de terceiros), a leitura de páginas
    #      fica cortada, como a tela avisa.
    #  - unir: as ferramentas que a imagem da rc.27 traz (o navegador, com o Chromium e o programa que o dirige; ver vídeos;
    #    ler e procurar arquivos; falar em áudio, com a voz grátis) entram na lista da API. É união: o que a pessoa desligou
    #    continua desligado, e esses conjuntos não existiam antes (ninguém os escolheu). Ficam fora as que precisam de algo
    #    que só a pessoa fornece (busca no X e criar vídeos: a chave de outro serviço). As travas continuam: o plugin barra,
    #    a cada chamada, o que o agente não tem; gravar arquivo só com Terminal ou Executar código; com a proteção de Conexões
    #    ligada pela pessoa (opcional, desligada por padrão: decisão de 08/11), abrir sites depois de ler as contas pede
    #    aprovação. A base, para um cofre sem a lista, é escrita aqui (o conteúdo publicado nunca muda por
    #    tabela). Quem dá as ferramentas aos agentes é o servidor (server/src/services/characters.ts, BENEFICIOS).
    (10, "experiência completa", {
        "se_ausente": [
            ["agent.budget_warning_ratio", "0.75"],
            ["web.extract_backend", "exa"],
        ],
        "trocar_se": [
            ["agent.max_turns", "20", "90"],
            ["agent.reasoning_effort", "low", "high"],
        ],
        "unir": [
            ["platform_toolsets.api_server", ["browser", "file", "tts", "video"], ["todo", "web", "vision", "image_gen", "skills", "ergon_conexoes"]],
        ],
    }),
)
CONFIG_VERSION = MIGRACOES[-1][0]
# Travas de segurança: valem em TODA abertura, além das migrações (reaplicar uma migração desfaria escolhas da
# pessoa, como as ferramentas ligadas). Treinar: toda escrita de skill fica em espera até a aprovação no Ergon.
ENFORCED_STEPS = [
    ["config", "set", "skills.write_approval", "true"],
    # Conexões: a ferramenta precisa estar à vista do modelo, sem passar pela busca de ferramentas (modelo mais simples não
    # a chama). Com a busca ligada, o Hermes esconde atrás dela TODA ferramenta de plugin (tools/tool_search.py,
    # is_deferrable_tool_name), e as do plugin são as Conexões; o que ela pouparia nos agentes do Ergon é pouco
    # (docs/CUSTO_DAS_CHAMADAS.md; o teste hermes/tests/test_ergon_bridge_custo.py mede). Fica desligada.
    # rc.27: com um conector pronto (MCP) ligado, a busca fica como a pessoa deixou (enforce_safety, _conectores_ligados):
    # as ferramentas de dezenas de conectores não cabem todas em cada chamada. Sem conector ligado, desligada como antes.
    # agent.max_turns saiu daqui na rc.25: a pessoa escolhe no Ergon (Configurações › Andamento da equipe, "Passos por
    # pedido"; o servidor grava pela ponte de controle, /ergon/v1/passos), e uma trava a cada abertura desfaria a escolha.
    # O padrão era 20 (migração 1; os cofres de antes têm 20, gravado por esta trava até a rc.24); a migração 10 leva o 20
    # que ninguém escolheu a 90.
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
    # Montado, o motor abre: um erro na configuração ou nas travas só fica no log e a próxima abertura tenta de novo
    # (se a abertura caísse aqui, o servidor voltaria à imagem anterior a cada renovação, e o motor ficaria nela).
    for etapa in (configure, enforce_safety):
        try:
            etapa()
        except Exception as exc:  # noqa: BLE001
            log(f"{etapa.__name__} com erro ({type(exc).__name__}: {str(exc)[:200]}); nova tentativa na próxima abertura")


def as_hermes(args: list[str]) -> subprocess.CompletedProcess:
    # já como o usuário do motor (motor único: docker compose exec -u 10000), não há troca a fazer
    who = {} if os.getuid() == HERMES_UID else {"user": HERMES_UID, "group": HERMES_UID, "extra_groups": []}
    return subprocess.run([HERMES_CLI, *args], **who, env={**os.environ, "HOME": PLAIN}, capture_output=True, timeout=120)


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


BUSCA_DESLIGADA = ["config", "set", "tools.tool_search.enabled", "off"]


def _conectores_ligados() -> bool:
    """Há algum conector pronto (MCP) ligado no config.yaml? (mcp_servers.<nome>, sem enabled: false). Config ilegível:
    não (a busca de ferramentas fica desligada, o comportamento de antes)."""
    try:
        servidores = ler_config().get("mcp_servers")
    except Exception:  # noqa: BLE001
        return False
    if not isinstance(servidores, dict):
        return False
    return any(isinstance(c, dict) and c.get("enabled", True) not in (False, "false", "off", "no", 0) for c in servidores.values())


def enforce_safety() -> bool:
    passos = list(ENFORCED_STEPS) + ([] if _conectores_ligados() else [BUSCA_DESLIGADA])
    failed = [" ".join(step[:3]) for step in passos if as_hermes(step).returncode != 0]
    if failed:
        # sem a trava, o Treinar não grava nada (o Ergon só aplica escrita em espera); avisa e segue
        log(f"trava de segurança não aplicada ({', '.join(failed)}); nova tentativa na próxima abertura")
        return False
    log("travas de segurança conferidas")
    return True


def _versao_legivel(raw: str) -> int | None:
    """A versão gravada na marca, ou None se a marca não é legível (vazia, cortada, outra coisa)."""
    raw = raw.strip()
    if raw.isdigit():
        return min(int(raw), 1)
    try:
        v = json.loads(raw).get("versao") if raw.startswith("{") else None
    except (ValueError, AttributeError):
        v = None
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def versao_da_marca(raw: str) -> int:
    """A versão gravada na marca: {"versao": N} (MIGRACOES_MARKER) ou o texto puro das versões antigas (CONFIG_MARKER).
    O texto puro vale no máximo 1: quando a marca era texto, "2" queria dizer "configuração inteira, versão 2" (um
    teste de 26/10, nunca publicado), e não "migração 2" — contar como 2 pularia a migração das Conexões.
    Qualquer outra coisa vale 0: aplica desde a primeira, como antes (as migrações são idempotentes)."""
    v = _versao_legivel(raw)
    return 0 if v is None else v


def ler_marca() -> int:
    """A maior versão legível entre MIGRACOES_MARKER e a marca das versões antigas (CONFIG_MARKER: "1" = migração 1).
    As duas só crescem (CONFIG_MARKER só recebe "1" depois da migração 1), então a maior é a certa. Uma marca ilegível
    (vazia ou cortada por uma queda logo depois de criada, bytes estranhos) não conta: vale a outra. Sem nenhuma: 0.
    Erro de leitura que não seja "não existe" sobe (configure não aplica nada e tenta de novo na próxima abertura)."""
    versoes = []
    for nome in (MIGRACOES_MARKER, CONFIG_MARKER):
        try:
            with open(os.path.join(PLAIN, nome), "rb") as f:
                v = _versao_legivel(f.read(200).decode("utf-8", errors="replace"))
        except FileNotFoundError:
            continue
        if v is None:
            log(f"marca {nome} ilegível: não conta (vale a outra, se houver)")
        else:
            versoes.append(v)
    return max(versoes, default=0)


def _gravar(nome: str, texto: str) -> None:
    """Grava até o disco antes de trocar o nome (uma queda logo depois não deixa a marca vazia); falhou: some o
    temporário e o erro sobe."""
    caminho = os.path.join(PLAIN, nome)
    tmp = caminho + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(texto)
            f.flush()
            os.fsync(f.fileno())
        os.chown(tmp, HERMES_UID, HERMES_UID)
        os.replace(tmp, caminho)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def gravar_marca(n: int) -> None:
    """Grava a migração N em MIGRACOES_MARKER e deixa CONFIG_MARKER = "1" (o que as imagens antigas entendem)."""
    _gravar(MIGRACOES_MARKER, json.dumps({"versao": n}))
    try:
        with open(os.path.join(PLAIN, CONFIG_MARKER), "rb") as f:
            antiga = f.read(200).strip()
    except FileNotFoundError:
        antiga = None
    if antiga != b"1":
        _gravar(CONFIG_MARKER, "1")


def ler_config() -> dict:
    """O config.yaml do motor como está no disco (sem os padrões do Hermes). Ilegível: erro (nada é gravado)."""
    try:
        import hermes_yaml as yaml  # o mesmo leitor do Hermes (YAML 1.1): vem pelo ambiente do próprio Hermes
    except ImportError as exc:  # a imagem não traz o PyYAML: sem o leitor do Hermes, nada é gravado
        raise RuntimeError("não achei o leitor de YAML do Hermes (hermes_yaml) neste Python") from exc
    path = os.path.join(PLAIN, "config.yaml")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError("config.yaml não é um mapa")
    return data


def _pegar(cfg: dict, chave: str):
    cur = cfg
    for parte in chave.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(parte)
    return cur


def _lista(valor) -> list[str] | None:
    """Uma lista salva no config.yaml. Versões antigas do "config set" gravavam '["a", "b"]' como texto: o Hermes lê
    as duas formas (hermes_cli/toolset_validation.py), e aqui também. Outra coisa: None (ausente)."""
    if isinstance(valor, list):
        return [str(x) for x in valor]
    if isinstance(valor, str) and valor.strip().startswith("["):
        try:
            v = ast.literal_eval(valor.strip())
        except (ValueError, SyntaxError):
            return None
        return [str(x) for x in v] if isinstance(v, list) else None
    return None


def _unir(entradas: list) -> bool:
    """Cada [chave, acrescentar, base]: grava a união do que está na chave (ou da base, se ausente) com "acrescentar".
    Já tem tudo: não chama nada. Para na primeira falha (a ordem importa: ver a migração 2)."""
    cfg = ler_config()
    for chave, acrescentar, base in entradas:
        bruto = _pegar(cfg, chave)
        atual = _lista(bruto)
        if isinstance(bruto, list) and set(acrescentar) <= set(atual or []):
            continue
        novo = sorted(set(atual if atual is not None else base) | set(acrescentar))
        if as_hermes(["config", "set", chave, json.dumps(novo)]).returncode != 0:
            log(f"não consegui gravar {chave}")
            return False
    return True


def _existe(cfg: dict, chave: str) -> bool:
    """A chave está no config.yaml, com qualquer valor (inclusive null, que no Hermes é uma escolha: ver a migração 3)."""
    cur = cfg
    partes = chave.split(".")
    for parte in partes[:-1]:
        cur = cur.get(parte) if isinstance(cur, dict) else None
    return isinstance(cur, dict) and partes[-1] in cur


def _se_ausente(entradas: list) -> bool:
    """Cada [chave, valor]: grava só se a chave não está no config.yaml (o que já está lá foi escolha de alguém). Já tem
    tudo: não chama nada. Para na primeira falha."""
    cfg = ler_config()
    for chave, valor in entradas:
        if _existe(cfg, chave):
            continue
        if as_hermes(["config", "set", chave, valor]).returncode != 0:
            log(f"não consegui gravar {chave}")
            return False
    return True


def _texto(valor) -> str:
    """Um valor do config.yaml como o "config set" o escreveria (20 e "20" são o mesmo; true e "true" também)."""
    if isinstance(valor, bool):
        return "true" if valor else "false"
    return "" if valor is None else str(valor).strip()


def _trocar_se(entradas: list) -> bool:
    """Cada [chave, antigo, novo]: grava "novo" só se a chave existe e ainda vale "antigo" (o que uma migração publicada
    gravou e ninguém mudou). Ausente ou com outro valor: fica como está (foi escolha de alguém). Já trocado: não chama
    nada. Para na primeira falha."""
    cfg = ler_config()
    for chave, antigo, novo in entradas:
        if not _existe(cfg, chave) or _texto(_pegar(cfg, chave)) != antigo:
            continue
        if as_hermes(["config", "set", chave, novo]).returncode != 0:
            log(f"não consegui gravar {chave}")
            return False
    return True


def aplicar(conteudo: dict) -> bool:
    """Uma migração pode ter mais de uma parte (rc.27): se_ausente, depois trocar_se, depois passos, depois unir. Para na
    primeira que falha."""
    conhecidas = [k for k in ("se_ausente", "trocar_se", "passos", "unir") if k in conteudo]
    if not conhecidas or set(conteudo) - set(conhecidas):
        raise ValueError("migração sem passos conhecidos")
    if "se_ausente" in conteudo and not _se_ausente(conteudo["se_ausente"]):
        return False
    if "trocar_se" in conteudo and not _trocar_se(conteudo["trocar_se"]):
        return False
    if "passos" in conteudo:
        failed = [" ".join(step[:3]) for step in conteudo["passos"] if as_hermes(step).returncode != 0]
        if failed:
            log(f"passos que falharam: {', '.join(failed)}")
            return False
    if "unir" in conteudo and not _unir(conteudo["unir"]):
        return False
    return True


def configure() -> bool:
    """Aplica, em ordem, as migrações acima da marca do cofre, gravando a marca a cada uma. Uma que falha para tudo: o
    motor sobe mesmo assim e a próxima abertura tenta de novo a partir dela."""
    try:
        atual = ler_marca()
    except Exception as exc:  # noqa: BLE001 - o motor sobe mesmo assim
        log(f"não consegui ler a marca da configuração ({type(exc).__name__}); nova tentativa na próxima abertura")
        return False
    if atual > CONFIG_VERSION:
        log(f"configuração do motor na versão {atual}, mais nova que a desta imagem ({CONFIG_VERSION}): nada a aplicar")
        return True
    aplicadas = []
    for n, nome, conteudo in MIGRACOES:
        if n <= atual:
            continue
        try:
            ok = aplicar(conteudo)
        except Exception as exc:  # noqa: BLE001 - o motor sobe mesmo assim
            log(f"migração {n} ({nome}) com erro: {type(exc).__name__}: {str(exc)[:200]}")
            ok = False
        if not ok:
            log(f"configuração do motor parou na migração {n} ({nome}); nova tentativa na próxima abertura")
            return False
        try:
            gravar_marca(n)
        except Exception as exc:  # noqa: BLE001 - o motor sobe mesmo assim; a migração é idempotente e roda de novo
            log(f"migração {n} ({nome}) aplicada, mas a marca não foi gravada ({type(exc).__name__}: {str(exc)[:120]}); "
                "nova tentativa na próxima abertura")
            return False
        aplicadas.append(f"{n} ({nome})")
        log(f"configuração do motor: migração {n} aplicada ({nome})")
    if aplicadas:
        log(f"motor configurado pelo Ergon: versão {atual} → {CONFIG_VERSION}")
    return True


def configurar_agora() -> int:
    """Motor único, sem cofre (scripts/hermes-init.mjs): chave da API no .env do perfil, migrações e travas."""
    ensure_api_key()
    ok = configure()
    ok = enforce_safety() and ok
    return 0 if ok else 1


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
    if sys.argv[1:2] == ["--ergon-configurar"]:
        sys.exit(configurar_agora())
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

# Novidades

## 1.1.0-rc.15 (pré-versão de teste)

- **A equipe trabalha até entregar.** Quando algo trava — um texto que chegou incompleto, uma entrega reprovada na
  conferência, uma falha —, a equipe resolve sozinha: a coordenação decide como seguir e, se for preciso, chama o
  agente com o modelo mais forte para uma nova estratégia. Você só é chamado para decidir o que você quer; dado que
  falta fica marcado como [PREENCHER] na entrega.
- **Uma entrega, um card.** Pedir ajuda a um colega não cria mais outro card: o colega entra como uma etapa do mesmo
  card, e tudo fica no histórico dele.
- **Sem textos cortados.** Cada etapa recebe por inteiro o que as anteriores entregaram, e a entrega final traz o
  documento completo. Entregas longas ficam também como arquivo no card.
- **Competências pela conversa.** Peça ao coordenador que a equipe aprenda algo: ele põe um agente para estudar, e você
  aprova a competência no perfil dele (aba Treinar). O Treinar não tem mais limite de arquivos nem de links.
- A dica da tela não fecha mais o card aberto ao clicar em "Entendi".

## 1.1.0-rc.14 (pré-versão de teste)

- **Sem Docker em lugar nenhum:** o Ergon passa a rodar no Podman, motor de contêineres de código aberto.
  - **Windows:** o ambiente próprio do Ergon traz o Podman. Uma instalação feita com uma versão anterior passa para o
    ambiente novo na primeira atualização pelo aplicativo, com uma cópia dos dados antes; se algo der errado, a de antes
    volta como estava.
  - **Linux (Ubuntu 24.04 ou mais novo, Debian 12):** o `Ergon Desktop para Linux.deb` traz o Podman e instala o Ergon
    na sua conta, sem pedir administrador.
- O instalador do Linux na raiz do repositório também acompanha a versão mais recente.

## 1.1.0-rc.13 (pré-versão de teste)

- **Rotinas:** ativar uma rotina deixava a tela em branco; agora a tela de preparo abre e mostra o andamento e o
  primeiro resultado.
- **Cidade:** o posto da nuvem coberto com lona não fica mais na frente da escada lateral da Stoa.

## 1.1.0-rc.12 (pré-versão de teste)

- **Windows sem Docker:** o `Ergon Desktop para Windows.exe` é o instalador principal e monta tudo num ambiente
  próprio do Ergon. Não precisa instalar o Docker Desktop; uma instalação antiga por ele fica como está, sem uso.
- O instalador do Windows na raiz do repositório acompanha a versão mais recente.

## 1.1.0-rc.11 (pré-versão de teste)

- **Atualizações no app:** Configurações › "Verificar atualizações" mostra se há versão nova e atualiza com um clique,
  com cópia dos seus dados antes; se algo der errado, a versão de antes volta sozinha. Nada se atualiza sem você pedir,
  exceto quando a versão traz revisões de segurança: aí o Ergon avisa e fica bloqueado até atualizar.
- **Central de Trabalho na cidade:** placas na Stoa (vagas, espera, entregas) e na ágora (decisões que esperam você);
  a Central mostra o que está em andamento, o que espera e por quê, o que precisa de você e o que ficou pronto, e
  cada linha abre o card de sempre (priorizar, responder, parar, cancelar).
- **Posto da nuvem coberto:** o lugar reservado para trabalhos na nuvem aparece coberto com lona, sem uso nesta versão.

## 1.1.0-rc.10 (pré-versão de teste)

- **Telas prontas:** trocar de menu e abrir janelas mostra o que já está montado, sem itens aparecendo e mudando de
  lugar; o app desktop abre direto, sem uma tela com botão que some em seguida.
- **Desinstalar:** não trava mais quando o Windows demora a responder; o que faltar é apagado no próximo login.
- **Ferramentas pela conversa:** peça a qualquer agente para ligar Executar código ou Terminal; a coordenação pede a
  sua senha na conversa com ela. Lembretes com data liberados (viram tarefas suas com prazo).
- **Andamento:** 5 trabalhos ao mesmo tempo por padrão.
- **Segurança:** as opções aparecem por trás do pedido de senha ("Desbloquear opções de segurança").
- **Conexões:** o modelo padrão aparece assim que a conta de IA conecta.
- **Rotinas:** o detalhe das rotinas longas não fica mais em branco ao rolar.
- **Skins:** os retratos dos agentes vestem os personagens da skin; a janela de construção mostra os prédios e os
  nomes da skin.
- **Loja:** prévias com a cidade (skins e temas) e com os setores (equipes); explicação de cada categoria; guia técnico
  e SKILL.md para criar pacotes (à mão ou com uma IA).

## 1.1.0-rc.9 (pré-versão de teste)

- **Loja em galeria:** busca, categorias, paginação, cartões com prévia e página de detalhe para cada pacote.
- **Chave própria:** todos os provedores que o motor de IA suporta, com busca; "Outro (compatível com OpenAI)" e
  modelos locais (LM Studio, Ollama).
- **Conexões:** o modelo padrão é o primeiro item das Contas de IA; Configurações abre em Ferramentas da equipe.
- **Workspaces:** excluir um workspace (digitando o nome para confirmar).
- **Segurança:** a aba pede a sua senha atual.
- **Conversas:** atalho no canto desde o início; sem provedor de IA conectado, um aviso leva direto a Conexões.

## 1.1.0-rc.8 (pré-versão de teste)

- **Boas-vindas:** "Conectar depois" e "Pular as perguntas" de volta; a tela da conta de IA continua aparecendo só
  com os botões prontos.

## 1.1.0-rc.7 (pré-versão de teste)

- **Boas-vindas:** depois das palavras de recuperação, um carregamento curto (só se preciso); então as perguntas e
  a conexão da conta de IA, com os botões prontos. A interface abre com a conta já conectada.

## 1.1.0-rc.6 (pré-versão de teste)

- **Conta de IA:** a tela de conectar só aparece com os botões prontos. Se a IA da sua conta ainda estiver
  acordando, um carregamento curto vem antes.
- **Instalação:** uma frase nova a cada etapa, sem repetir em roda.
- **Criar conta:** o cursor começa no nome de exibição.

## 1.1.0-rc.5 (pré-versão de teste)

- **Conta de IA na conta nova:** a tela espera a IA da sua conta ficar pronta e libera os botões sozinha, sem
  precisar fechar e abrir o app.
- **Conectar:** o código de login aparece dentro do cartão da opção que você escolheu.
- **Chave própria (BYOK):** em Configurações › IA da equipe, conecte a sua chave de API da OpenRouter, da
  Anthropic (Claude) ou do Google Gemini. A chave é conferida no provedor e não aparece de novo.
- **Boas-vindas:** a instalação conta a sua própria história, da Grécia antiga, enquanto prepara tudo.

## 1.1.0-rc.4 (pré-versão de teste)

- **Conta de IA:** numa conta nova, a tela avisa que o motor de IA está ligando (até 1 minuto) e libera os botões
  sozinha; se o motor falhar, mostra o motivo e "Tentar de novo".
- **Minha conta:** foto de perfil e nome de exibição em Configurações. O avatar no canto abre Minha conta,
  Alternar conta e Sair.
- **Workspaces:** clicar no item da lista já entra nele; renomear fica em Configurações › Workspace, com
  confirmação; o nome dado ao criar já vem nas boas-vindas.
- **Barra de cima** mais limpa: busca no centro, ícones do mesmo tamanho à direita, avisos no Estado.
- **Desinstalar:** "Apagar também a conta e os dados do Ergon" remove tudo (inclusive o ambiente no WSL);
  desinstalar não volta mais para a instalação. Nenhuma janela de outro programa abre durante a instalação.

## 1.1.0-rc.3 (pré-versão de teste)

- **Workspaces:** o botão com o nome do workspace, na barra de cima, abre a visão geral de todos os seus (agentes,
  tarefas abertas, quem está trabalhando e o que aguarda você). Dali você entra em outro, renomeia ou cria um novo
  (uma empresa, um projeto, a vida pessoal), que nasce com a equipe e a cidade. A conta de IA vale para todos.

## 1.1.0-rc.2 (pré-versão de teste)

- Ao conectar a conta de IA, a equipe já ganha um modelo para começar (no plano gratuito, um modelo grátis; nunca
  um modelo "de ponta", que pede confirmação de custo). A tela diz qual foi e onde trocar.
- Textos da interface: quem faz é o agente, a equipe ou "o sistema", não "o Ergon".

## 1.1.0-rc.1 (pré-versão de teste)

- **Windows sem Docker:** o Ergon Desktop instala o Ergon inteiro sozinho. Ele cria um ambiente próprio no WSL do
  Windows (com o Docker dentro, sem Docker Desktop), baixa os componentes conferindo a assinatura de cada um,
  retoma downloads interrompidos e continua sozinho depois de um reinício. O Ergon só aparece para este computador.
- Pré-versão: não aparece para quem usa `ergon atualizar` nem como "versão mais recente". Para testar, baixe o
  instalador `.exe` desta página.
- Repositório organizado: na raiz ficam os instaladores e os guias; o código foi para `codigo-fonte/`.

## 1.0.1

- `ergon instalar` instala o Ergon numa pasta sua e põe o comando `ergon` no PATH: depois disso, `ergon` funciona
  de qualquer terminal e a pasta do zip pode ser apagada.
- `ergon remover` tira o Ergon do computador e guarda os dados (instalar de novo volta de onde parou);
  `ergon remover --tudo` apaga tudo, com confirmação.

## 1.0.0

Primeira versão pública do Ergon Community.

- Equipe de doze agentes com coordenação, conversa, quadro de tarefas e conclusão só com evidência.
- Cidade em pixel art com os agentes trabalhando, prédios, andares e personalização.
- Rotinas prontas (briefing, prazos, compromissos, contratos, conferência financeira e outras), com o que foi lido e
  conferido sempre à vista.
- Treinar: competências ensinadas a um agente, com revisão e aprovação antes do uso.
- Conexões com apps de tarefas, Microsoft 365 e Google (leitura) e WhatsApp experimental (somente leitura, com
  informações e riscos antes de conectar).
- Seis skins da cidade: Distrito Platina, Reino de Brumaverde, Base Siroco, Enseada Coral, Vila Ronrom e Cromo-9, com
  prédios, roupas, paisagem e personagens próprios.
- Loja de pacotes: oficiais assinados que vêm junto e funcionam sem internet; modelos da comunidade sob demanda.
- Dados cifrados com a sua senha, frase de recuperação, 2º fator opcional, backup conferido e restauração com desfazer.
- Instalação em Docker (Windows, macOS e Linux) e aplicativo desktop (Windows e Linux) na mesma versão.

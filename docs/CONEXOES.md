# Conexões: o que os agentes fazem nas suas contas

Em 05/11/2026 o Ergon deixou de ser só leitura. Os agentes usam de verdade as contas e os aplicativos conectados, e os quadros
ficam ligados nos dois sentidos.

## Como funciona

- **O agente chama, o Ergon executa.** O motor de IA tem duas ferramentas, `conexoes_listar` e `conexoes_executar`
  (`hermes/plugins/ergon_bridge`). O plugin só repassa à rota `/internal/bridge/v1/conexoes`. Credenciais, regra de confirmação
  e registro ficam no servidor (`server/src/services/conexoes/servico.ts`). O motor nunca vê token de conta.
- **O agente já sabe o que pode.** As conexões ligadas e os nomes das ações entram nas instruções dele (`promptConexoes`).
- **Correlação direta nos quadros.** Dar check, mover de coluna, editar ou criar num quadro ligado entra numa fila
  (`mirror_outbox`, `conexoes/espelho.ts`) e vai ao aplicativo logo em seguida. A tela responde na hora; se o serviço estiver
  fora, tenta de novo; se falhar de vez, o card mostra o motivo e oferece "Tentar de novo". A leitura periódica não mexe numa
  tarefa com escrita a caminho. Só o que a própria pessoa faz entra nessa fila.

## A regra de confirmação

Código: `conexoes/regra.ts`. Origem e leitura são marcadas pelo sistema; nada que o modelo diga, ou que venha num e-mail, muda o resultado.

| Situação | Decisão |
|---|---|
| A pessoa clica numa tela | Direto |
| Ler ou consultar | Direto |
| Ela pede no chat para organizar as ferramentas dela (tarefa, rascunho) | Direto, mesmo tendo lido e-mails antes (confirma se ela ligou "Sempre pedir minha confirmação antes de organizar") |
| Ela pede no chat para enviar a alguém, sem ler nada de fora antes | Direto |
| Envio depois de a sessão ler conteúdo de fora | Confirma |
| O pedido não partiu dela (rotina, mensagem recebida, iniciativa do agente, colega) | Confirma |
| Apagar | Sempre confirma |
| Pedido pouco objetivo | O agente pergunta |

**Quem conta como pessoa:** mensagem dela numa conversa, ou card que ela criou (direto ou por um pedido dela). `origin='chat'`
sozinho não prova nada, porque agente também abre card assim. O que não se sabe de onde veio é de fora.

**Conteúdo de fora** (`conteudo_externo`) marca a sessão, a conversa e o card, e segue pela cadeia de quem pediu ajuda. Vêm de fora:
leitura de conta, anexo, documento do card, página da internet.

**Depois de ler conteúdo privado: proteção opcional, desligada por padrão** (decisão de 08/11: o agente já trata o que lê como
dado, nunca como instrução). Com ela ligada (Conexões › "Depois de ler conteúdo das minhas contas, pedir minha aprovação antes de
abrir sites ou rodar programas", `conexoes.aprovar_depois_de_ler`; ausente = desligada), o que alcança endereços arbitrários ou
roda programas (`BLOQUEADAS_DEPOIS_DE_LER`: `web_extract`, navegador, visão por endereço, terminal, execução de código) pede a
aprovação dela:
- o plugin do motor barra a ferramenta e chama `/internal/bridge/v1/depois-de-ler` com a ferramenta e o alvo (endereço ou
  programa); o servidor confere de novo e abre um cartão (`agent_proposals.kind = 'depois_de_ler'`) na conversa, no card e em
  "Aguardando você", um por grupo (abrir sites, rodar programas) enquanto espera;
- aprovado, vale **só para o alvo que o cartão mostrou** (`chavesDeAprovacao` em `conexoes/regra.ts`), por uma hora naquela
  conversa ou card (`APROVACAO_VALE_MS`): o site (a origem de cada endereço: aprovar `https://empresa.exemplo/contrato` vale
  para outras páginas de `empresa.exemplo`, nunca para outro site); mexer na página já aberta no navegador (clicar, digitar,
  rolar), depois de um site aprovado ali; o programa exatamente como está (terminal, execução de código e código no
  navegador: `browser_console`, `browser_cdp`, `browser_exec`). A lista de nomes que vai ao plugin não muda com a aprovação;
  é o pedido de aprovação que responde `liberada` chamada a chamada. O plugin manda todos os endereços da chamada e, num alvo
  longo, o começo com a conferência (sha256) do texto inteiro, para um pedido diferente nunca valer pela mesma aprovação;
- o agente continua sozinho (na conversa, uma continuação `aprovado-<id>` que herda a origem do pedido; no card, a decisão
  vai ao histórico e o card volta a andar). O card espera em "aguardando aprovação" enquanto houver cartão sem decisão, sem
  dar por entregue, e um card com etapas não passa à etapa seguinte (`Results.cartaoEsperando`);
- recusado, o agente termina sem a ferramenta (na conversa, uma continuação `recusado-<id>`; no card, o card volta a andar), e
  por 15 minutos (`RECUSA_VALE_MS`) o mesmo grupo não abre outro cartão naquela conversa ou card;
- sem conversa nem card (o Treinar, por exemplo) não há cartão: a ferramenta fica de fora; imagem já na conversa (`data:`)
  não pede aprovação.
O motor ainda sem o plugin 0.4.0 (sem a capacidade `aprovar_depois_de_ler`) só barra, como antes, até ser renovado; a tela
de Conexões avisa (`aprovarDepoisDeLerBarra` em `GET /api/conexoes`, de `Motors.barraSemAprovar`).
A busca na web segue valendo. À parte disso, o `[[treinar links=...]]` é ignorado quando a conversa leu conteúdo de fora ou o
pedido não partiu da pessoa.

**Terminal ou execução de código ligados no motor:** toda ação nas contas confirma, inclusive leitura, porque quem roda comandos ali
alcança a ponte com o token dela.

**Ajustes da pessoa:**
- Por conexão e por ação: seguir a regra, sempre pedir confirmação, ou desligado (Conexões › a conexão › "O que os agentes podem
  fazer aqui"). Vale acima de tudo.
- **Só leitura**, um clique por conexão (Conexões › a conexão, acima da lista de ações): desliga tudo o que escreve ali (criar,
  mudar, enviar, apagar), inclusive as exceções ligadas uma a uma; as leituras ficam como estavam. Marcar guarda o ajuste de
  escrita de antes (`settings.soLeituraAntes`), e desmarcar o devolve: o "sempre confirmar" e o "desligado" que a pessoa tinha
  posto voltam como estavam. Ligar uma escrita à mão já é sair do só leitura (o retrato guardado sai); sem retrato, desmarcar volta
  a escrita para a regra. A caixa aparece marcada quando nenhuma ação que escreve está ligada, contando só os tipos que a conexão
  tem. Vale também para a ação cujo risco depende dos parâmetros (criar com responsável vira envio). Rota: `PUT
  /api/conexoes/:kind/so-leitura` (`Conexoes.setSoLeitura`, `soLeituraDe` em `catalogo.ts`).
- Escrita sem cópia na repetição: na escrita, número acima do teto é recusado antes do cartão (o cartão mostra o que vai). No
  Asaas, a cobrança sempre leva uma referência e a criação confere antes se ela já existe (o cliente, pelo CPF ou CNPJ); na Omie,
  o código de integração do cliente usa o dia do workspace, e a recusa por código repetido chega ao agente como "já foi incluído
  antes". A conta a receber da Omie leva um código novo a cada inclusão (09/11: lançamento idêntico no mesmo dia fica liberado);
  quem segura a repetição do mesmo envio numa nova tentativa é a conferência por trabalho (o mesmo pedido já feito não sai de novo;
  o que ficou sem a confirmação do serviço, a resposta perdida, também não sai de novo sozinho: no card, até a pessoa responder
  pedindo de novo; na conversa, por 15 minutos, a menos que a mensagem nova da pessoa peça de novo). Na conversa, uma mensagem
  nova da pessoa que peça de novo ("de novo", "outra vez") ou, ao organizar, outro igual ("outra venda igual", "mais um
  lançamento") é pedido novo, como a resposta dela no card: sai, uma vez por mensagem. Sem isso, o agente fica sabendo que já
  foi feito e como lançar outra de propósito.
- Nos quadros ligados, desligar uma ação também impede que o que você faz no quadro (dar check, mudar de coluna, editar) chegue
  ao aplicativo. "Sempre pedir confirmação" vale só para os agentes: o seu clique no quadro já é a confirmação.
- "Sempre pedir minha confirmação antes de organizar, em todas as contas" (`conexoes.confirmar_organizar`): o que o agente
  organiza (criar, mudar, deixar rascunhos) passa a pedir confirmação, mesmo quando ela pediu no chat. Vale como o ajuste por
  conexão, acima de "Liberar tudo". Desligado por padrão.
- "Liberar tudo, por minha conta": tira as confirmações da regra e a aprovação depois de ler conteúdo privado (descrita acima). O
  ajuste por conexão e por ação continua valendo: o que você desligou continua desligado, e "sempre pedir confirmação" (por
  conexão ou antes de organizar) continua pedindo. Desligado por padrão.
- A rede de segurança do Terminal ("Terminal ou execução de código ligados no motor", acima) não depende da proteção depois de ler:
  continua valendo com ela desligada.

**O cartão mostra o que vai acontecer.** Toda ação que muda ou responde ao que já existe tem `Acao.preparar`: lê o alvo real
(tarefa, chamado, negócio, conversa, página) para o cartão mostrar o nome dele, e fixa o alvo já resolvido. Criar algo novo ou
escrever para endereços informados mostra no cartão tudo o que vai ser gravado ou enviado. O clique executa o que ficou guardado,
nunca o que o agente disser depois.

## Quando não saiu: a equipe tenta de novo (decisão 19, rc.25)

A conferência de entrega (`server/src/services/results.ts`) compara o que o pedido quer fazer numa conta com o registro do serviço
(`conexao_acoes`: feita, recusada por você, falhou, faltou). Até a rc.24, a falha numa conta ia direto para a pessoa. Agora as falhas
pequenas voltam para a equipe, pelo mesmo ciclo de rodadas de sempre (`teamwork.ts`, `persist`: rodadas 1 e 2 com a coordenação,
3 e 4 com o reforço, o modelo mais forte):

| A conferência mostra | Quem resolve |
|---|---|
| O agente não chegou a usar a conexão | A equipe, com a instrução "faça agora com conexoes_executar (conexao, acao) e confira" |
| Chamou, mas o pedido não chegou ao serviço (parâmetro errado, ação que não existe) | A equipe, com "veja os parâmetros em conexoes_listar" |
| O serviço recusou por um parâmetro (400, 422), ou uma leitura não teve resposta | A equipe, com o erro do serviço |
| Fez só uma parte | A equipe, só o que falta, com a lista do que já saiu ("não repita") |
| Quem pegou o card não tem as Conexões, e um colega tem | A equipe põe o colega numa etapa do card |
| A conta pediu para autorizar de novo, ou a empresa precisa aprovar | A pessoa |
| A ação está desligada por ela | A pessoa |
| O serviço não confirmou se fez ("pode ter feito ou não"), inclusive uma escrita que recebeu 5xx (500, 502, 503, 504) | A pessoa confere lá: repetir poderia mandar duas vezes |
| Ela recusou no cartão | A pessoa (o card pergunta o que mudar) |
| As Conexões estão sendo atualizadas neste computador ou desligadas para a equipe | A pessoa |
| As 4 rodadas do dia acabaram | A pessoa, com "A equipe tentou resolver em 4 rodadas e não conseguiu. Último motivo: …" (só quando acabaram de fato; a equipe desligada, o limite do dia ou ninguém para decidir dão só o motivo da conferência) |

**Como o sistema sabe o que é da pessoa.** O serviço das Conexões marca no card (`conexao.pessoa`, `episodio.ts`) quando uma ação
para em autorizar, desligada ou sem confirmação. A marca vale enquanto está à vista: conectar de novo, ligar a ação ou a mesma ação
dar certo depois deixam a marca para trás. A marca guarda o risco da chamada (um evento com convidados é "enviar") e, no envio sem
confirmação, o hash dele: só o mesmo envio feito depois a deixa para trás, e um envio a outra pessoa não. A marca de ação desligada
e a de envio sem confirmação valem para o card inteiro (uma nova tentativa do que falta poderia contornar ou repetir). Nada disso lê
o texto do agente.

**Nada sai duas vezes.** Uma nova tentativa vale dentro do mesmo trabalho do card (`episodioDoCard`: a criação, a última conclusão ou
o último pedido novo da pessoa). Quem tenta de novo recebe a lista do que já saiu pela conta, e o serviço não executa de novo uma
ação idêntica já feita neste trabalho, mesmo depois da janela de 15 minutos. Envio que pede confirmação continua pedindo: a nova
tentativa gera o cartão, e o card espera o clique. Numa rodada da equipe, um envio (risco "enviar") por uma ação que já saiu numa
tentativa anterior do mesmo trabalho, com outro texto, pede o clique da pessoa (o cartão diz por quê): pode ser o mesmo envio
reescrito. Quando a pessoa, na resposta a uma pergunta, pede para repetir um envio ("mande de novo", "reenvie"), o que saiu antes da
resposta dela deixa de segurar esse envio; "mande também para a Carla" não libera repetir o do João.

**Sem laço nem gasto descontrolado.** No máximo 4 rodadas por card em 24 horas (`PERSIST_ROUNDS`), cada uma com uma decisão da
equipe e uma nova tentativa. Desligar o ciclo: `team.persist = 0` (ligado por padrão). No modo simulado não há ciclo.

## Conexão por workspace

Cada workspace tem as próprias conexões. Na tela de cada uma: conectar uma conta nova aqui, ou usar a que já está em outro workspace
da mesma pessoa (`integrations.origem_workspace_id`).

- A credencial mora num só lugar; a renovação do acesso vale para todos os que usam.
- Para trocar a credencial de todos (colar um token novo, ou autorizar de novo), faça isso no workspace onde ela mora. Feito no
  workspace que usa a conta emprestada, ele passa a ter a credencial própria, separada da dos outros.
- Permissões, quadros e registro continuam de cada workspace.
- Conectar outra conta nunca sobrescreve a de origem (`SecretStore.writeOwn`).
- Desconectar, trocar de conta ou apagar o workspace onde a credencial mora: quem usava fica com ela (`Integrations.promover`).
- WhatsApp fica de fora: é um aparelho conectado só.

## O que existe

| Grupo | Aplicativos | Como conecta |
|---|---|---|
| Contas | Microsoft 365 (tarefas, e-mail, agenda, arquivos, pessoas, Teams), Google (tarefas, Gmail, Agenda, Drive, pessoas) | Login com a conta |
| Tarefas | Asana, Trello, Notion, monday.com, ClickUp, Jira, Pipefy, Todoist, Airtable, GitHub Projects, Smartsheet, Linear | Token (Pipefy: conta de serviço) |
| Conversas | WhatsApp (QR), Slack, Discord, Telegram, Mattermost, Rocket.Chat | Token |
| Vendas | HubSpot, RD Station CRM, Pipedrive, Kommo | Token |
| Atendimento | Zendesk, Freshdesk, Intercom | Token ou credencial de aplicativo |
| Documentos, código, agenda | Confluence, GitLab, Calendly; ações extras em GitHub e Notion | Token |
| Financeiro | Asaas (cadastrar cliente, criar cobrança, criar link de pagamento), Omie (incluir cliente, incluir conta a receber): **nada move dinheiro**, nenhuma ação paga, transfere, estorna, cancela ou dá baixa | Token |
| Em preparo | Zoom, Google Chat, Salesforce, Dropbox, Bitrix24 | Pedem registro de aplicativo no fornecedor |

**Financeiro, o que escreve e o risco de cada um.** Asaas: cadastrar cliente e criar link de pagamento organizam (o link só chega a
alguém se a pessoa compartilhar); criar cobrança é **envio**, porque o Asaas avisa o cliente pelos canais ligados nas notificações
da conta; por isso criar cobrança **sempre pede a confirmação** da pessoa, mesmo pedida por ela na conversa (`sempreConfirma` na
ação; nem "Liberar tudo" passa por cima, diferente de apagar; só o ajuste "Desligado" vale acima). Omie: incluir cliente e incluir conta a receber organizam (não gera boleto
nem avisa ninguém); o código de integração do cliente sai dos dados e do dia (o mesmo cadastro repetido no mesmo dia é recusado pela
Omie); o da conta a receber é novo a cada inclusão, então duas vendas iguais no mesmo dia entram. Os campos que movem
dinheiro para outra conta (split do Asaas) e as chamadas de baixa, recebimento, cancelamento e exclusão ficam fora, e
`test/conexoes-escrita-financeiro.test.ts` confere. RD Station CRM: além de contatos, negociações, tarefas e anotações, cria
empresa.

**Pipefy: conta de serviço.** O Pipefy marcou o token de acesso pessoal como obsoleto e recomenda conta de serviço (OAuth2 client
credentials). Conectar pede Client ID e Client Secret (e, só se o Pipefy mostrar outro, o endereço do "Token endpoint"; o padrão é
`https://app.pipefy.com/oauth/token`, e só endereço https de `pipefy.com` é aceito). O acesso que o Pipefy devolve fica guardado até
perto de vencer e é renovado sozinho; recusado antes da hora (401), é pedido de novo uma vez. Quem conectou com o token pessoal
continua funcionando enquanto o Pipefy aceitar, e a tela mostra o aviso com o botão "Reconectar do novo jeito". A tela de conectar
diz logo no início, à vista (`help.antes`), que a conta de serviço só pode ser criada pelo administrador principal da empresa no
Pipefy (o Super Admin).

**Para acrescentar um aplicativo:** escreva a definição por dados em `conexoes/conectores/` (exemplo: `discord.ts`) e ponha em
`conectores/index.ts`. Ele aparece em Conexões, os agentes passam a usá-lo e o ajuste de cada ação vale sem mais nada.

## Microsoft 365: etapas e administrador

Detalhes em [MICROSOFT.md](MICROSOFT.md). Em resumo:

- **A autorização vem em etapas** (`sso.ts`, `ESCOPOS_MICROSOFT`). Primeiro o que a política padrão da Microsoft deixa o próprio
  usuário autorizar (enviar e-mail, criar arquivos e, em conta de trabalho, ver e mandar mensagens no Teams). Depois a leitura
  (e-mail, agenda, arquivos, tarefas, contatos e o conteúdo das conversas), que numa empresa costuma precisar do administrador.
  Por último, opcional, os canais do Teams, que sempre precisam dele. O login passa por todas de uma vez, sem a pessoa voltar
  para clicar de novo; a que a empresa só libera com o administrador não trava as outras (o que já foi dado vale, e a tela mostra
  o pedido pronto). Ler pode precisar do administrador da empresa: a tela diz isso antes, não depois.
- **Falta de uma etapa só tira as ações dela.** A ação que precisa da leitura responde "precisa da aprovação do administrador da
  empresa", com o link pronto do pedido, nunca "Autorizar de novo" (que não resolveria). Conta pessoal autoriza a leitura sozinha
  e nunca vê o Teams.
- **Pedir ao administrador:** a pessoa copia o link (escopos explícitos, o app, o endereço de volta registrado) e envia ela mesma.
  A página final pode dar erro no computador de quem aprova: é esperado. Depois, "Já aprovaram? Conectar de novo".
- **Conexão × conversar pelo Teams:** a conexão é o login da pessoa (a equipe age na conta dela, sob demanda, nunca vigiando o
  Teams em laço). Conversar com o Aristóteles de dentro do Teams é outra coisa, que exige um bot no tenant da empresa, e ainda não
  está disponível.
- **Testar conexão** termina dizendo se a equipe consegue usar a conexão: o teste roda no servidor, e a equipe usa pelo motor
  dela, que pode estar desligado para as Conexões ou sendo atualizado.

## Validar com uma conta real

Nada disto rodou contra um serviço de verdade: as chamadas foram conferidas na documentação oficial e testadas com serviços
simulados, e o motor real foi testado com um modelo falso. O botão **Testar conexão** (Conexões › a conexão) faz as leituras com a sua
conta e diz o motivo de cada falha. **Testar escrita** existe nos aplicativos de tarefas e quadros: cria uma tarefa de teste e a
conclui; em Microsoft e Google, deixa também um rascunho (em Microsoft sem lista nem plano, só o rascunho). Nos outros aplicativos o
teste só lê, e a escrita aparece no primeiro uso. O resultado fica no relatório de Atividade.

Atividade › Exportar relatório gera um `.md` do período com execuções, ferramentas usadas, erros agrupados, conexões e ações nas contas;
o texto das conversas e dos cards dela só entra se a pessoa marcar a caixa, que vem desmarcada (sem ela, das ações nas contas ficam só
conexão, ação e estado). É o que se entrega para investigar um problema.

Pontos que só uma conta real confirma estão anotados nos comentários de cada escritor e neste resumo: prazo do To Do e do Planner em
fuso do Brasil, tirar prazo com `null`, resposta de cada serviço a texto longo, entrega no WhatsApp, política de consentimento da empresa.

## Testes

- `server/test/conexoes-*.test.ts`: núcleo, regra, workspaces, cada conexão (`fetch` simulado conferindo método, endereço e corpo).
- `server/test/equipe-tenta-de-novo.test.ts`: a equipe tenta de novo o que faltou na conta, o que só a pessoa resolve, rodadas esgotadas e nada sai duas vezes.
- `hermes/tests/test_ergon_bridge_conexoes.py`: plugin no Hermes de verdade.
- `hermes/tests/test_ergon_bridge_conexoes_modelo.py`: laço do motor com modelo falso: o modelo recebe as ferramentas, chama, recebe o resultado, e é barrado quando deve.

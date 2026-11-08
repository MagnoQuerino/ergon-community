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
| Ela pede no chat para organizar as ferramentas dela (tarefa, rascunho) | Direto, mesmo tendo lido e-mails antes |
| Ela pede no chat para enviar a alguém, sem ler nada de fora antes | Direto |
| Envio depois de a sessão ler conteúdo de fora | Confirma |
| O pedido não partiu dela (rotina, mensagem recebida, iniciativa do agente, colega) | Confirma |
| Apagar | Sempre confirma |
| Pedido pouco objetivo | O agente pergunta |

**Quem conta como pessoa:** mensagem dela numa conversa, ou card que ela criou (direto ou por um pedido dela). `origin='chat'`
sozinho não prova nada, porque agente também abre card assim. O que não se sabe de onde veio é de fora.

**Conteúdo de fora** (`conteudo_externo`) marca a sessão, a conversa e o card, e segue pela cadeia de quem pediu ajuda. Vêm de fora:
leitura de conta, anexo, documento do card, página da internet.

**Depois de ler conteúdo privado**, a sessão não usa o que alcança endereços arbitrários (`web_extract`, navegador, visão por
endereço, terminal, execução de código), e o `[[treinar links=...]]` é ignorado. A busca na web segue valendo.

**Terminal ou execução de código ligados no motor:** toda ação nas contas confirma, inclusive leitura, porque quem roda comandos ali
alcança a ponte com o token dela.

**Ajustes da pessoa:**
- Por conexão e por ação: seguir a regra, sempre pedir confirmação, ou desligado (Conexões › a conexão › "O que os agentes podem
  fazer aqui"). Vale acima de tudo.
- Nos quadros ligados, desligar uma ação também impede que o que você faz no quadro (dar check, mudar de coluna, editar) chegue
  ao aplicativo. "Sempre pedir confirmação" vale só para os agentes: o seu clique no quadro já é a confirmação.
- "Liberar tudo, por minha conta": tira as confirmações da regra e o bloqueio que vem depois de ler conteúdo privado (descrito
  acima). O ajuste por conexão e por ação continua valendo: o que você desligou continua desligado, e "sempre pedir confirmação"
  continua pedindo. Desligado por padrão.

**O cartão mostra o que vai acontecer.** Toda ação que muda ou responde ao que já existe tem `Acao.preparar`: lê o alvo real
(tarefa, chamado, negócio, conversa, página) para o cartão mostrar o nome dele, e fixa o alvo já resolvido. Criar algo novo ou
escrever para endereços informados mostra no cartão tudo o que vai ser gravado ou enviado. O clique executa o que ficou guardado,
nunca o que o agente disser depois.

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
| Tarefas | Asana, Trello, Notion, monday.com, ClickUp, Jira, Pipefy, Todoist, Airtable, GitHub Projects, Smartsheet, Linear | Token |
| Conversas | WhatsApp (QR), Slack, Discord, Telegram, Mattermost, Rocket.Chat | Token |
| Vendas | HubSpot, RD Station CRM, Pipedrive, Kommo | Token |
| Atendimento | Zendesk, Freshdesk, Intercom | Token ou credencial de aplicativo |
| Documentos, código, agenda | Confluence, GitLab, Calendly; ações extras em GitHub e Notion | Token |
| Financeiro | Omie, Asaas: **só leitura**, nenhuma ação paga, cobra ou altera valores | Token |
| Em preparo | Zoom, Google Chat, Salesforce, Dropbox, Bitrix24 | Pedem registro de aplicativo no fornecedor |

**Para acrescentar um aplicativo:** escreva a definição por dados em `conexoes/conectores/` (exemplo: `discord.ts`) e ponha em
`conectores/index.ts`. Ele aparece em Conexões, os agentes passam a usá-lo e o ajuste de cada ação vale sem mais nada.

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
- `hermes/tests/test_ergon_bridge_conexoes.py`: plugin no Hermes de verdade.
- `hermes/tests/test_ergon_bridge_conexoes_modelo.py`: laço do motor com modelo falso: o modelo recebe as ferramentas, chama, recebe o resultado, e é barrado quando deve.

# Conta Microsoft no Ergon (login Entra)

O usuário clica em **Conexões › Microsoft 365 › Entrar com a Microsoft**, entra na página da Microsoft e
autoriza. Para esse botão funcionar, o aplicativo Ergon precisa existir uma vez no Microsoft Entra (é o que
dá ao Ergon um "identificador de aplicativo"). Isso é feito por quem instala o Ergon — numa versão em nuvem,
pelo fornecedor, uma vez para todos os clientes.

**O Ergon já vem com o app público registrado** (ID `a5c42f25-1caa-45db-9220-79708764914e`, qualquer conta Microsoft —
pessoal, de empresa ou de escola): ninguém precisa registrar nada. Os passos do fim desta página só valem para quem quiser usar
um app próprio (`ERGON_MS_CLIENT_ID=<id>`) ou desligar o botão (`ERGON_MS_CLIENT_ID=off`).

## A autorização vem em etapas

"Não exige administrador" na tabela oficial de permissões não quer dizer que o usuário comum consiga autorizar. Nos tenants
novos, a política padrão é **"Let Microsoft manage your consent settings"**: o usuário autoriza quase tudo, **menos** uma lista
de permissões que inclui ler e-mail, agenda, arquivos compartilhados, tarefas, contatos e o conteúdo das conversas do Teams
([manage-app-consent-policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies),
"Microsoft recommended user consent policy"; a Microsoft atualiza essa lista sozinha). Pedir tudo de uma vez fazia a conexão
de uma empresa típica nem completar. Por isso o login pede em etapas
([consentimento incremental](https://learn.microsoft.com/en-us/entra/identity-platform/permissions-consent-overview)):

| Etapa | O que libera | Permissões delegadas | Quem autoriza |
|---|---|---|---|
| A, base | enviar e-mail em seu nome, criar arquivos no OneDrive | `User.Read`, `Mail.Send`, `Files.ReadWrite` | a própria pessoa |
| A, Teams (só conta de trabalho ou escola) | ver as conversas e os times, mandar mensagens no Teams | `Chat.ReadBasic`, `Chat.Create`, `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Send` | a própria pessoa |
| B, leitura | ler e organizar e-mail, agenda, arquivos (inclusive os compartilhados), tarefas (Planner e To Do), contatos e, em conta de trabalho, o conteúdo das conversas do Teams | `Mail.Read`, `Mail.ReadWrite`, `Calendars.Read`, `Calendars.ReadWrite`, `Files.Read.All`, `Tasks.ReadWrite`, `People.Read` e `Chat.Read` | numa empresa, costuma ser o administrador; conta pessoal autoriza sozinha |
| C, canais (opcional) | ler as mensagens dos canais dos times | `ChannelMessage.Read.All` | sempre o administrador |

Mais `openid`, `profile` e `offline_access` em toda etapa. A lista de cada etapa está no código
(`ESCOPOS_MICROSOFT`, em `server/src/services/conexoes/acoes/microsoft.ts`) e um teste confere que a etapa A não pede nada da
lista de exceções da política padrão.

- **O login segue sozinho:** depois da base, a mesma conta (sem escolher de novo) passa pela etapa do Teams e pela leitura. A
  etapa que a conta já deu é pulada. Recusar uma etapa, ou não poder autorizá-la, não desfaz as anteriores.
- **Conta pessoal** (Outlook, Hotmail, Live): não tem Teams pelo Graph. Para ela, as etapas do Teams e dos canais nem aparecem, e
  a tela nunca oferece "Autorizar de novo" para algo que a conta não pode ter.
- **O que foi dado fica somado** na credencial. A renovação do acesso pede só isso, porque ela não aceita permissão nova
  ([auth code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow): "equivalent to or a
  subset of"). A Microsoft escreve a mesma permissão de três jeitos (`Mail.Read`, `https://graph.microsoft.com/Mail.Read` e com o
  id do Graph na frente): contam igual.
- **Quem conectou antes das etapas** (tudo pedido de uma vez) continua conectado, sem novo login: o que a conta deu vale como
  antes, e só os canais, que são novos e opcionais, aparecem como "falta".
- **"Conectando…"** vence em 10 minutos, o mesmo prazo do login: sem volta da Microsoft, a conexão sai desse estado e a tela diz
  por quê.

Em **Conexões › Microsoft 365**, a tela mostra cada etapa: liberada, falta liberar, esperando a Microsoft, aprovada pelo
administrador ou precisando dele. E o botão **Testar conexão** diz, por último, se a equipe consegue usar a conexão (o teste roda
no servidor; a equipe usa pelo motor dela).

## Pedir ao administrador

Quando a leitura volta sem ser dada (ou a página da Microsoft não volta em 10 minutos), a etapa mostra **Pedir ao
administrador**, com o link pronto e uma mensagem pronta para copiar. A pessoa envia ela mesma, pelo canal que quiser: nada sai
do Ergon sozinho.

O link é o do [consentimento do administrador v2](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent):
`https://login.microsoftonline.com/<locatário da pessoa>/v2.0/adminconsent`, com o `client_id` do app, os escopos **explícitos**
da etapa e das anteriores (nunca `/.default`: o administrador vê exatamente o que aprova), o endereço de volta igual ao registrado
e um `state`. O locatário vem do login da pessoa; sem ele, `organizations`.

- Quem administra abre o link noutro computador e aprova. No fim, a página tenta voltar para o computador da pessoa e **pode
  mostrar um erro: isso é esperado**, e o texto que acompanha o link avisa.
- Nada depende dessa volta. No Ergon da pessoa, **Já aprovaram? Conectar de novo** faz o login só daquela etapa, que passa sem
  pergunta quando a aprovação já existe.
- Se quem aprova é a própria pessoa, neste computador, a volta funciona e a etapa aparece como "aprovada pelo administrador",
  com o botão **Autorizar agora**.
- Se a empresa usa o fluxo de pedido de aprovação da própria Microsoft (a página dela oferece "Solicitar aprovação"), dá no
  mesmo: quando o administrador aprovar por lá, é só clicar em "Já aprovaram? Conectar de novo".

## Conexão Microsoft × conversar pelo Teams

São duas coisas diferentes:

- **Microsoft 365: a equipe age na sua conta.** É esta conexão: o login da própria pessoa no Microsoft Graph (permissões
  delegadas). Os agentes leem e enviam como ela, quando ela pede ou numa rotina. Tudo é sob demanda: nada consulta o
  Teams em laço, que a Microsoft não permite
  ([teams-api-overview, "Polling requirements"](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0)).
- **Conversar com o Aristóteles pelo Teams: em breve.** Mandar pedidos ao coordenador de dentro do Teams exige uma entrada de
  mensagens: um bot registrado no tenant da empresa (com endereço HTTPS público e o app instalado no Teams) ou notificações de
  mudança do Graph. Não é a mesma coisa que a conexão, e ainda não está disponível.

Pessoa de outra organização não recebe conversa nova pelo e-mail: o Graph só aceita gente de fora pelo id e pelo locatário dela
([chat-post](https://learn.microsoft.com/en-us/graph/api/chat-post?view=graph-rest-1.0)). O agente diz isso e sugere e-mail, ou
a conversa que já existe.

## O que a equipe faz com a conta

Os agentes consultam e agem na conta, com a regra de confirmação de [CONEXOES.md](CONEXOES.md):

- **Tarefas:** planos do Planner (buckets viram colunas) e listas do To Do ficam ligados nos dois sentidos quando você escolhe a
  lista em Tarefas (precisa da leitura). Planner não existe em conta pessoal; To Do existe.
- **E-mail:** enviar (etapa A); buscar em qualquer pasta e período, ler, deixar rascunho, responder, mover, apagar (leitura).
- **Agenda:** listar, criar, editar, cancelar (leitura). **Arquivos:** criar no OneDrive (etapa A); procurar e ler, inclusive o
  que foi compartilhado com você (leitura). A busca tenta de novo quando o OneDrive responde com erro passageiro.
- **Teams (conta de trabalho):** listar as conversas (sem a prévia da última mensagem, até a leitura ser liberada), mandar
  mensagem numa conversa ou num canal e abrir conversa com alguém da empresa (etapa A); ler o conteúdo das conversas (leitura);
  ler os canais (etapa opcional).
- Os tokens ficam em `/data/secrets` (volume de dados do Ergon, legível só pelo servidor, cifrados); nunca no navegador, no banco, no
  motor de IA ou no Git. **Desconectar** apaga os tokens deste workspace.

## Registrar um aplicativo próprio (opcional, ~5 minutos)

1. Entre em <https://entra.microsoft.com> › **Aplicativos** › **Registros de aplicativo** › **Novo registro**.
2. Nome: `Ergon`. Tipos de conta: **Contas em qualquer diretório organizacional e contas Microsoft pessoais**.
3. URI de redirecionamento: plataforma **Aplicativos móveis e da área de trabalho** (no registro novo aparece
   como "Cliente público/nativo (celular e desktop)"; **não** use "Web") →
   `http://localhost/api/integrations/microsoft/callback`, sem porta.
   `localhost` vale: quem volta para esse endereço depois do login é o seu navegador, no seu computador (a
   Microsoft nunca o acessa); em `localhost` a Microsoft também ignora a porta
   ([reply-url](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), "Localhost exceptions"). É o mesmo endereço
   do pedido ao administrador. Na nuvem, acrescente o endereço HTTPS do servidor ao mesmo app.
4. Não crie segredo: o Ergon usa PKCE, sem senha de aplicativo.
5. Em **Permissões de API › Microsoft Graph › Permissões delegadas** (nunca "de aplicativo"), adicione as da tabela acima,
   inclusive `ChannelMessage.Read.All` se quiser a leitura de canais. **Não** clique em "Conceder consentimento do
   administrador" no registro: ele vale só para o seu tenant e só para o que está nessa lista. (A lista no portal documenta o
   app; o que vale no login é o que se pede em cada etapa.)
6. Copie o **ID do aplicativo (cliente)** e coloque no arquivo `.env` do Ergon:

   ```
   ERGON_MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
   ```

7. Feche e abra o Ergon de novo: o identificador novo passa a valer.

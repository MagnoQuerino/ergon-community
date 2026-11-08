# Conta Microsoft no Ergon (login Entra)

O usuário clica em **Conexões › Microsoft 365 › Entrar com a Microsoft**, entra na página da Microsoft e
autoriza. Para esse botão funcionar, o aplicativo Ergon precisa existir uma vez no Microsoft Entra (é o que
dá ao Ergon um "identificador de aplicativo"). Isso é feito por quem instala o Ergon — numa versão em nuvem,
pelo fornecedor, uma vez para todos os clientes.

**O Ergon já vem com o app público registrado** (ID `a5c42f25-1caa-45db-9220-79708764914e`, qualquer conta Microsoft —
pessoal, de empresa ou de escola): ninguém precisa registrar nada. Os passos abaixo só valem para quem quiser usar um
app próprio (`ERGON_MS_CLIENT_ID=<id>`) ou desligar o botão (`ERGON_MS_CLIENT_ID=off`).

## Registrar o aplicativo (uma vez, ~5 minutos)

1. Entre em <https://entra.microsoft.com> › **Aplicativos** › **Registros de aplicativo** › **Novo registro**.
2. Nome: `Ergon`. Tipos de conta: **Contas em qualquer diretório organizacional e contas Microsoft pessoais**.
3. URI de redirecionamento: plataforma **Aplicativos móveis e da área de trabalho** (no registro novo aparece
   como "Cliente público/nativo (celular e desktop)"; **não** use "Web") →
   `http://localhost/api/integrations/microsoft/callback`, sem porta.
   `localhost` vale: quem volta para esse endereço depois do login é o seu navegador, no seu computador (a
   Microsoft nunca o acessa); para apps nativos a Microsoft também ignora a porta. Na nuvem, acrescente o
   endereço HTTPS do servidor ao mesmo app.
4. Não crie segredo: o Ergon usa PKCE, sem senha de aplicativo.
5. Em **Permissões de API › Microsoft Graph › Permissões delegadas** (nunca "de aplicativo"), adicione:
   `offline_access`, `User.Read`, `Tasks.ReadWrite`, `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`,
   `Calendars.ReadWrite`, `Files.ReadWrite`, `Files.Read.All`, `People.Read` e, para conta de trabalho ou escola,
   `Chat.Read`, `Chat.Create`, `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All` e
   `ChannelMessage.Send`. Pela tabela da Microsoft nenhuma exige administrador, mas a política da empresa pode exigir:
   nesse caso, o administrador aprova o aplicativo. **Não** clique em "Conceder consentimento do administrador" no registro.
   (A lista no portal documenta o app; o que vale no login é o que o Ergon pede — `server/src/services/sso.ts`.)
   O login tem duas etapas: primeiro o que existe para qualquer conta; se a conta for de empresa ou escola, logo em
   seguida as do Teams (a Microsoft não tem Teams para conta pessoal, e pedir esses escopos a uma conta pessoal dá
   erro). Recusar a segunda etapa mantém a conexão. Quem conectou antes das ações de escrita vê "Autorizar de novo" em Conexões.
6. Copie o **ID do aplicativo (cliente)** e coloque no arquivo `.env` do projeto:

   ```
   ERGON_MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
   ```

7. Reinicie o Ergon: `docker compose up -d ergon`.

## O que o Ergon faz com a conta

Os agentes consultam e agem na conta, com a regra de confirmação de [CONEXOES.md](CONEXOES.md):

- **Tarefas:** planos do Planner (buckets viram colunas) e listas do To Do ficam ligados nos dois sentidos quando você escolhe a
  lista em Tarefas. Planner não existe em conta pessoal; To Do existe.
- **E-mail:** buscar em qualquer pasta e período, ler, deixar rascunho, enviar, responder, mover, apagar.
- **Agenda:** listar, criar, editar, cancelar. **Arquivos:** procurar, ler e criar no OneDrive e no que foi compartilhado com você.
- **Teams (conta de trabalho):** ler conversas, responder, escrever em canais. A entrada automática das mensagens no Ergon depende
  do app do Ergon instalado no Teams (pacote em `connectors/teams/`), que é um passo separado.
- Os tokens ficam em `/data/secrets` (volume de dados do Ergon, legível só pelo servidor, cifrados); nunca no navegador, no banco, no
  motor de IA ou no Git. **Desconectar** apaga os tokens deste workspace.

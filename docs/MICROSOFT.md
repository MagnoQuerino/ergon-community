# Conta Microsoft no Ergon (login Entra)

O usuário clica em **Conexões › Microsoft 365 › Entrar com a Microsoft**, entra na página da Microsoft e
autoriza. Para esse botão funcionar, o aplicativo Ergon precisa existir uma vez no Microsoft Entra (é o que
dá ao Ergon um "identificador de aplicativo"). Isso é feito por quem instala o Ergon — numa versão em nuvem,
pelo fornecedor, uma vez para todos os clientes.

## Registrar o aplicativo (uma vez, ~5 minutos)

1. Entre em <https://entra.microsoft.com> › **Aplicativos** › **Registros de aplicativo** › **Novo registro**.
2. Nome: `Ergon`. Tipos de conta: **Contas em qualquer diretório organizacional e contas Microsoft pessoais**.
3. URI de redirecionamento: plataforma **Cliente público/nativo (celular e desktop)** →
   `http://localhost:8787/api/integrations/microsoft/callback`
   (se o Ergon usar outra porta, troque `8787`).
   `localhost` vale: quem volta para esse endereço depois do login é o seu navegador, no seu computador (a
   Microsoft nunca o acessa); para apps nativos a Microsoft também ignora a porta. Na nuvem, acrescente o
   endereço HTTPS do servidor ao mesmo app.
4. Não crie segredo: o Ergon usa PKCE, sem senha de aplicativo.
5. Em **Permissões de API › Microsoft Graph › Permissões delegadas** (nunca "de aplicativo"), adicione só
   leitura: `offline_access`, `User.Read`, `Tasks.Read`, `Tasks.Read.Shared`, `Chat.Read`, `Mail.Read`,
   `Mail.Read.Shared`, `Calendars.Read` e `Files.Read.All`. Nenhuma exige consentimento de administrador; cada
   pessoa autoriza a própria conta ao entrar. **Não** clique em "Conceder consentimento do administrador".
   (A lista no portal documenta o app; o que vale no login é o que o Ergon pede — `server/src/services/sso.ts`.)
6. Copie o **ID do aplicativo (cliente)** e coloque no arquivo `.env` do projeto:

   ```
   ERGON_MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
   ```

7. Reinicie o Ergon: `docker compose up -d ergon`.

## O que o Ergon faz com a conta

- **Tarefas:** lê planos do Planner (buckets viram colunas) e listas do To Do, quando você escolhe a lista em
  Tarefas. Só leitura: título, descrição, situação (concluída ou não) e responsável.
- **Teams:** com `Chat.Read`, a conta autoriza a leitura das conversas. A entrada automática das mensagens
  do Teams no Ergon depende do app do Ergon instalado no Teams (pacote em `connectors/teams/`, publicação na
  loja de apps do Teams), que é um passo separado do fornecedor.
- **E-mail, agenda e arquivos:** só leitura, para as rotinas (briefing, supervisão) usarem o que chega e o que
  está marcado. Nada é apagado, movido ou respondido.
- **Nada é enviado em seu nome.** Os tokens ficam em `/data/secrets` (volume de dados do Ergon, legível só pelo
  servidor); nunca no navegador, no banco ou no Git. **Desconectar** apaga esses tokens.

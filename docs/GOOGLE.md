# Conta Google no Ergon (login com a conta)

O usuário clica em **Conexões › Google › Entrar com o Google**, escolhe a conta e autoriza. Para esse botão
funcionar, o aplicativo Ergon precisa existir uma vez no Google Cloud (é o que dá ao Ergon um identificador e
um segredo de cliente). Isso é feito por quem instala o Ergon — numa versão em nuvem, pelo fornecedor, uma vez
para todos os clientes. O mecanismo é o mesmo da Microsoft (SSO parametrizado, `server/src/services/sso.ts`).

## Registrar o aplicativo (uma vez, ~10 minutos)

1. Em <https://console.cloud.google.com>, crie um projeto (ex.: `Ergon`).
2. **APIs e serviços › Biblioteca**: ative a **Google Tasks API**.
3. **Google Auth Platform** (tela de consentimento OAuth):
   - **Branding:** nome `Ergon`, seu e-mail de suporte.
   - **Público:** *Interno* se for uma conta Google Workspace da sua empresa (só gente da empresa entra, sem
     revisão do Google); senão *Externo*. Em *Externo* com o app **Em teste**, adicione seu e-mail em
     **Usuários de teste** (até 100 pessoas).
   - **Acesso a dados (escopos), só leitura:** `openid`, `email`, `profile`, `tasks.readonly` e `calendar.readonly`
     (sensíveis) e, para as rotinas, `gmail.readonly` e `drive.readonly` (restritos). Ative também as APIs de
     Agenda, Gmail e Drive em **Biblioteca**. Escopos restritos com o app **Em teste** valem só para os usuários de
     teste e o acesso vence a cada 7 dias; para outras pessoas o Google exige uma auditoria de segurança paga.
4. **Clientes › Criar cliente** (credenciais OAuth): tipo **Aplicativo da Web**.
   **URI de redirecionamento autorizado:** `http://localhost:8787/api/integrations/google/callback`
   (se o Ergon usar outra porta, troque `8787`; se for aberto por outro endereço, use esse endereço e defina
   `ERGON_OAUTH_REDIRECT_BASE` no `.env`).
5. Copie o **ID do cliente** para o `.env` do projeto:

   ```
   ERGON_GOOGLE_CLIENT_ID=123456789012-xxxxxxxx.apps.googleusercontent.com
   ```

   e o **segredo do cliente** para o arquivo de segredos (fora do Git e do OneDrive), `~/.ergon/secrets/ergon.env`:

   ```
   ERGON_GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

6. Reinicie o Ergon: `docker compose up -d ergon`.

## Bom saber

- **Aviso "o Google não verificou este app":** aparece enquanto o app não passa pela verificação do Google
  (o escopo de tarefas é "sensível"). Para os usuários de teste, basta clicar em *Avançado › Continuar*.
- **Login que vence em 7 dias:** com o público *Externo* e o app *Em teste*, o Google invalida a renovação do
  acesso depois de 7 dias e é preciso entrar de novo em Conexões. Para não vencer: público *Interno* (conta
  Workspace) ou publicar o app (*Em produção*), o que para escopos sensíveis exige a verificação do Google.
- **O que o Ergon faz com a conta:** lê as listas do Google Tasks quando você escolhe uma em Tarefas (título,
  descrição, situação; o Google Tasks não tem responsável). Agenda, Gmail e Drive: só leitura, para as rotinas.
  Nada é enviado, apagado ou alterado em seu nome. Google Chat não está incluído.
- **Segredo do cliente:** o Google mostra a chave só na criação. Baixe o JSON e guarde fora do Git e do OneDrive
  (`~/.ergon/secrets/`); a chave vai para `ergon.env` e o ID (público) para o `.env` do projeto.
- **Onde ficam os tokens:** em `/data/secrets` (volume de dados do Ergon, legível só pelo servidor); nunca no
  navegador, no banco ou no Git. **Desconectar** apaga esses tokens.

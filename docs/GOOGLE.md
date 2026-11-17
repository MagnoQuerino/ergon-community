# Conta Google no Ergon (login com a conta)

O usuário clica em **Conexões › Google › Entrar com o Google**, escolhe a conta e autoriza. Nada a registrar: as
versões publicadas já trazem o **app público do Ergon** no Google Cloud (cliente "App para computador",
`ERGON_GOOGLE_APP` em `server/src/config.ts`), publicado e com a política em <https://ergonworld.com/privacidade>.
O identificador fica no código; o segredo do cliente (que o Google trata como não confidencial em app instalado)
entra na imagem pela esteira de lançamento, porque a proteção de push do GitHub não o aceita no repositório.
O mecanismo é o mesmo da Microsoft (SSO parametrizado, `server/src/services/sso.ts`).

Enquanto a verificação do Google não termina, quem entra vê o aviso "o Google não verificou este app"
(*Avançado › Acessar Ergon*) e o app aceita até 100 pessoas no total. Depois da verificação, o aviso some.

Para usar **o seu próprio** cliente (builds locais, que não têm o segredo, ou quem prefere o próprio projeto), siga
os passos abaixo; o cliente do `.env` vence o embutido. `ERGON_GOOGLE_CLIENT_ID=off` desliga o Google.

## Registrar o seu próprio aplicativo (opcional, ~10 minutos)

1. Em <https://console.cloud.google.com>, crie um projeto (ex.: `Ergon`).
2. **APIs e serviços › Biblioteca**: ative a **Google Tasks API**.
3. **Google Auth Platform** (tela de consentimento OAuth):
   - **Branding:** nome `Ergon`, seu e-mail de suporte.
   - **Público:** *Interno* se for uma conta Google Workspace da sua empresa (só gente da empresa entra, sem
     revisão do Google); senão *Externo*. Em *Externo* com o app **Em teste**, adicione seu e-mail em
     **Usuários de teste** (até 100 pessoas).
   - **Acesso a dados (escopos):** `openid`, `email`, `profile`, `tasks`, `calendar.readonly`, `calendar.events`,
     `drive.file`, `contacts.readonly`, `contacts.other.readonly`, `directory.readonly` e os restritos `gmail.readonly`,
     `gmail.modify` e `drive.readonly` (a lista exata está em `server/src/services/conexoes/acoes/google.ts`). Ative também as
     APIs de Agenda, Gmail, Drive e People em **Biblioteca**. Escopos restritos com o app **Em teste** valem só para os usuários de
     teste e o acesso vence a cada 7 dias; para outras pessoas o Google exige uma auditoria de segurança paga.
4. **Clientes › Criar cliente** (credenciais OAuth): tipo **App para computador** (aceita qualquer porta em
   `localhost`, sem cadastrar endereço). Se o Ergon for aberto por outro endereço que não `localhost`, use o tipo
   **Aplicativo da Web** com o URI `<endereço>/api/integrations/google/callback` e defina `ERGON_OAUTH_REDIRECT_BASE` no `.env`.
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
- **O que o Ergon faz com a conta:** os agentes consultam e agem, com a regra de confirmação de [CONEXOES.md](CONEXOES.md). Listas do
  Google Tasks ficam ligadas nos dois sentidos quando você escolhe uma em Tarefas. Gmail: buscar, ler, deixar rascunho, enviar,
  responder, mover e mandar para a lixeira. Agenda: listar, criar, editar, cancelar. Drive: procurar, ler e criar. Google Chat não está incluído.
- **Segredo do cliente:** o Google mostra a chave só na criação. Baixe o JSON e guarde fora do Git e do OneDrive
  (`~/.ergon/secrets/`); a chave vai para `ergon.env` e o ID (público) para o `.env` do projeto.
- **Onde ficam os tokens:** em `/data/secrets` (volume de dados do Ergon, legível só pelo servidor); nunca no
  navegador, no banco ou no Git. **Desconectar** apaga esses tokens.

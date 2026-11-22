# WhatsApp (experimental)

O Ergon pode ler conversas do WhatsApp para transformar pedidos em tarefas para a equipe. O recurso é
**experimental** e fica desligado até você ler as informações e os riscos e confirmar, em **Conexões**.

## Como funciona

- Você lê um QR code com o celular (WhatsApp › Aparelhos conectados › Conectar um aparelho) e este computador vira
  um aparelho conectado da sua conta, como o WhatsApp Web.
- A conexão usa o [Baileys](https://github.com/WhiskeySockets/Baileys), uma biblioteca de código aberto que **não é
  oficial** nem aprovada pelo WhatsApp ou pela Meta.
- **Envio só quando pedido:** os agentes enviam da sua conta quando você pede ou confirma num cartão. Se você ligar
  "Liberar tudo" em Conexões, o que não partiu de você (uma rotina, uma mensagem recebida) também pode sair sem cartão.
  Ler não marca como lido e você não aparece "online".
- Filtros: conversas individuais, grupos (desligados no começo), etiquetas do WhatsApp Business e exceções por nome
  ou número ("Família", por exemplo).

## Riscos

- **Enviar aumenta o risco:** mensagens automáticas e denúncias de quem recebe podem levar a restrição ou banimento. Evite escrever a quem nunca falou com você.
- **O número pode ser restringido ou banido.** Os termos do WhatsApp não permitem clientes não oficiais. Use um
  número de trabalho ou secundário.
- **Pode parar de funcionar sem aviso** quando o WhatsApp muda a forma de conectar.
- **A sessão fica neste computador**, cifrada com os seus dados. Quem tiver acesso a ela lê as suas conversas como
  aparelho conectado. Os backups do Ergon levam a sessão junto (cifrada).
- **As mensagens lidas vão para o modelo de IA** que você configurou, para identificar pedidos. Respeite a
  privacidade de quem fala com você (LGPD).
- **Licença diferente:** a biblioteca depende da libsignal-node, sob GPL-3.0, distribuída junto com este recurso
  (veja o [NOTICE](../NOTICE)).

## Parar

Em Conexões, "Desconectar (sai do aparelho)" encerra a sessão e apaga a cópia local. Você também pode remover o
aparelho no celular, em Aparelhos conectados.

## WhatsApp Business oficial (Cloud API), desde a 1.1.0-rc.47

Além do número pareado por QR, a equipe pode atender pela plataforma oficial da Meta (WhatsApp Business Platform,
Cloud API). Fica em **Conexões › Conversar com a equipe › WhatsApp Business**. Não depende de um celular ligado e não
tem risco de banimento por cliente não oficial; a Meta cobra pelas conversas na conta dela, à parte do Ergon.

### O que o dono do serviço precisa ter

1. **Uma conta Meta Business** (business.facebook.com), de preferência verificada.
2. **Um número de telefone** para o WhatsApp Business Platform, que **não** esteja em uso no app do WhatsApp nem no
   WhatsApp Business do celular (ou a Meta pede para migrar o número).
3. **Um app do tipo Business** no painel de desenvolvedores da Meta (developers.facebook.com), com o produto WhatsApp.
   Dele saem o **Phone Number ID**, o **WABA ID** (opcional) e a **Chave secreta do app (App Secret)**.
4. **Uma chave de acesso permanente**, de um usuário do sistema do Meta Business com a permissão
   `whatsapp_business_messaging` para o app e a conta do WhatsApp.
5. **O verify token**: não é preciso inventar; o Ergon gera um (aleatório, 32 caracteres) e mostra junto com a URL de
   retorno, para colar em WhatsApp › Configuração › Webhook na Meta, assinando o campo `messages`.

A chave de acesso e o App Secret entram pelo cartão seguro e ficam com a equipe (o motor), cifrados; não voltam à tela
e não passam pelo serviço de canais.

### Como a mensagem chega: relay em vez de túnel

A Meta só entrega webhooks a um endereço HTTPS público. Avaliamos duas saídas:

- **Túnel local** (cloudflared, ngrok e afins): exigiria instalar e manter mais um programa, abrir uma porta deste
  computador para a internet e trocar a URL na Meta toda vez que o túnel mudasse. Mais peças e mais superfície exposta.
- **Relay do serviço de canais do Ergon** (o mesmo que já liga o Teams): **escolhido**. O computador continua sem porta
  aberta; a conexão sai daqui, como nos outros canais.

Como funciona, ponta a ponta:

1. Ao ligar o canal, o Ergon pede ao relay uma rota (`/whatsapp/wac_…`) e registra nela só um **HMAC do verify token**,
   nunca o token. O GET de verificação da Meta (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) é respondido
   pelo relay, com comparação em tempo constante.
2. Cada POST da Meta é aceito pelo relay só se tiver o cabeçalho `X-Hub-Signature-256` no formato certo, até 64 KB e
   `object = whatsapp_business_account`, com limite por rota e por IP. O relay **não confere a assinatura** (não tem o
   App Secret): guarda o corpo bruto e a assinatura **selados para esta instalação** (X25519), por até 7 dias, e entrega
   pela conexão da instalação (`whatsapp.webhook`).
3. O Ergon guarda a entrega cifrada e passa ao motor. O plugin do motor **confere `X-Hub-Signature-256` com o App
   Secret** sobre o corpo exato e só então entrega ao adaptador `whatsapp_cloud` do Hermes. Assinatura inválida: a
   mensagem é descartada e registrada.
4. A resposta sai do motor direto para a Graph API da Meta, com a chave de acesso. O webhook local do adaptador escuta
   só em 127.0.0.1.

Quem fala com o número entra por **código de pareamento** (como no Telegram e no WhatsApp por QR); grupos ficam
desligados. Fora da janela de 24 horas da Meta (erro 131047), a equipe não consegue responder com texto livre: a
resposta não sai nem é tentada de novo até a pessoa escrever outra vez (modelos aprovados ficam para outra versão).

### Parar

Em Conexões, **Desligar** apaga a rota no relay, as credenciais e as entregas pendentes. Na Meta, remova a URL de
retorno do webhook ou o usuário do sistema.

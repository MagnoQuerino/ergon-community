# Ergon na Índia

O que a 1.1.0-rc.47 traz para quem usa o Ergon na Índia, e o que o dono do serviço precisa fazer.

## Idiomas

- **हिन्दी** cobre as mesmas telas que o chinês: cidade, equipe, perfil do agente, rotinas, documentos, Conexões,
  Configurações, Ajuda, as equipes de nicho do primeiro acesso e a biblioteca de rotinas. As traduções ainda passam
  por revisão de falante nativo.
- **English (India)**: o texto é o do inglês, com o que muda na Índia: datas dd/mm/aaaa, números em lakh e crore
  (12,34,567), valores de exemplo em ₹, telefone +91 e o GST nos textos de cobrança onde se aplica. **Preços e vendas
  não mudaram.**

## Lei DPDP (Digital Personal Data Protection Act, 2023, e as DPDP Rules, 2025)

O Ergon já trata a LGPD e o GDPR (exportar e apagar os próprios dados, registro de auditoria, termos versionados). Para
a DPDP, o dono do serviço liga, em **Segurança › Privacidade (DPDP)**:

| Campo | Para quê |
|:--|:--|
| Quem responde pelos dados (Data Fiduciary) | O nome da empresa ou pessoa responsável, mostrado no aviso. |
| Grievance Officer | Nome e pelo menos um contato (e-mail, telefone ou endereço) para reclamações. |
| Prazo de resposta | Em dias, de 1 a 90 (o teto das Regras). O aviso mostra o prazo escolhido. |
| Consent Manager (opcional) | Nome, registro e endereço HTTPS, se a empresa usar um Consent Manager registrado no Data Protection Board. |

Com isso ligado:

- **Aviso em linguagem simples**, em português, inglês, hindi e chinês (en-IN usa o inglês): que dados o Ergon guarda,
  para quê, como retirar o consentimento, como reclamar ao Grievance Officer e, se não houver resposta no prazo, ao
  Data Protection Board of India. Cada pessoa vê o aviso uma vez por versão e consente com um clique.
- **Consentimento registrado** (versão do aviso, idioma e data) e **retirada com o mesmo esforço**, em Minha conta;
  tudo vai ao registro de auditoria.
- **Representante (seção 14)**: cada pessoa pode nomear quem exerce os direitos dela em caso de morte ou incapacidade
  (nome, contato e relação), guardado cifrado como os outros dados.
- **"Baixar meus dados"** passa a levar o histórico de consentimentos e o representante.

**Os termos de uso não mudaram (`TERMOS_VERSAO` continua o mesmo).** O aviso DPDP tem a sua própria versão
(`AVISO_DPDP_VERSAO = 2026-11-21`, em `server/src/services/dpdp.ts`): quando o texto do aviso mudar, essa versão sobe e
cada pessoa vê o aviso de novo, sem pedir novo aceite dos termos. Se um dia os termos precisarem citar a DPDP, aí sim
sobe `TERMOS_VERSAO`, com o texto novo dos termos.

O Ergon não inventa obrigações: não há bloqueio de idade, nem aviso de vazamento automático, nem transferência
internacional configurável nesta versão. Quem é Significant Data Fiduciary tem obrigações a mais (DPO, auditoria,
avaliação de impacto) que ficam com a empresa.

## WhatsApp Business oficial

O canal oficial da Meta (Cloud API), ao lado do número pareado por QR. O que o dono precisa ter e como a mensagem
chega estão em [WHATSAPP.md](WHATSAPP.md#whatsapp-business-oficial-cloud-api-desde-a-110-rc47): conta Meta Business,
um número só para a plataforma, um app Business com o produto WhatsApp, a chave de acesso permanente e o App Secret;
o verify token o Ergon gera.

## Conectores (desde a 1.1.0-rc.48)

Em Conexões: **Zoho** (CRM, Books e Mail), **Razorpay**, **Freshsales** e **Tally**. As credenciais ficam só no computador do
Ergon, cifradas; os agentes nunca as veem.

**Zoho, o que o dono providencia (uma vez, para a instalação).** Um app OAuth "Server-based Application" no
[API Console da Zoho](https://api-console.zoho.com), com:
- *Redirect URI:* `http://localhost:8787/api/integrations/zoho/callback` (ou o endereço de `ERGON_OAUTH_REDIRECT_BASE`, se o
  Ergon abre por outro endereço);
- *Multi-DC* ligado em Settings, com os data centers que as empresas usam (Índia, EUA, Europa, Austrália, Japão, Canadá,
  Arábia Saudita, Reino Unido; a China é separada). A Zoho dá um client id para todos e, se pedir, um segredo por data center;
- no `ergon.env`: `ERGON_ZOHO_CLIENT_ID` e `ERGON_ZOHO_CLIENT_SECRET` e, quando o console der um segredo diferente para um
  data center, `ERGON_ZOHO_CLIENT_SECRET_IN` (e `_EU`, `_AU`, `_JP`, `_CA`, `_SA`, `_UK`, `_CN`). `ERGON_ZOHO_DC` muda
  onde o login começa (padrão `COM`; o accounts.zoho.com leva cada conta ao data center dela).

O login volta dizendo o data center da conta (`accounts-server`); o Ergon só aceita os da lista e guarda qual é, e as chamadas e
a renovação vão aos endereços dele (`www.zohoapis.in`, `mail.zoho.in`, `crm.zoho.in`...). Escopos pedidos: perfil, CRM (leads,
contatos e negócios), Books (faturas, clientes, pagamentos, configurações) e Mail (contas, pastas, mensagens). Sem o app, o
botão "Entrar com Zoho" diz o que falta.

**Razorpay.** A pessoa gera a chave em Account & Settings › API Keys (Test Mode para experimentar) e cola Key Id e Key Secret.
Leitura livre (pagamentos com UPI, pedidos, links, reembolsos, liquidações com taxas, GST e UTR); criar link de pagamento sempre
pede confirmação; reembolsar e capturar pedem a aprovação toda vez, mesmo com "Liberar tudo".

**Freshsales.** Domínio (`suaempresa`, de `suaempresa.myfreshworks.com`, ou o endereço antigo `.freshsales.io`) e a chave de API
de um usuário: contatos, contas e negócios, ler, buscar, criar e atualizar.

**Tally (TallyPrime), só no Community local.** No TallyPrime: F1 › Settings › Connectivity, "TallyPrime acts as" Server (ou
Both), porta 9000 por padrão, com a empresa aberta. Em Conexões, o nome ou o IP do computador do Tally (127.0.0.1 no mesmo
computador; `host.docker.internal` com o Ergon no Docker e o Tally no mesmo computador). Por segurança do servidor do Ergon, todo
endereço do nome tem de ser desta máquina ou da rede local: IP público, de enlace (169.254, o metadado das nuvens) e as portas do
Ergon e do motor são recusados. Leitura: empresas, razões, balancete e vouchers; criar voucher pede a aprovação toda vez. Na nuvem
do Ergon o cartão aparece indisponível, com o motivo, e a conexão não vai à nuvem.

**Conferir na primeira conta de verdade.** Os formatos foram escritos a partir da documentação pública da Zoho (CRM API v8, Books
API v3, Mail API), do Razorpay (API v1), da Freshworks e do XML do Tally, sem uma conta real nesta versão: os testes usam APIs
falsas.

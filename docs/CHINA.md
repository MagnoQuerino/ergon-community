# Ergon na China

> Versão em chinês: [CHINA.zh-CN.md](CHINA.zh-CN.md).

Na China, o Ergon é o **Community instalado no seu computador**, com **IA chinesa**. A nuvem do Ergon e a cobrança
não são oferecidas lá: tudo roda na sua máquina, e as chaves e os dados ficam nela.

## 1. Instalar pelo espelho

O GitHub, o `ghcr.io`, o PyPI e o Docker Hub costumam falhar ou ficar muito lentos na China. As imagens do Ergon são
publicadas também num registro na China (o espelho), com o **mesmo digest** das do `ghcr.io`: o conteúdo é idêntico e
conferido.

1. Pegue o pacote do Ergon local (`ergon-local-<versão>.zip`) por um endereço que abra na China, ou de alguém que já o
   tenha baixado, e descompacte numa pasta.
2. Na pasta, crie (ou abra) o arquivo `.env` e acrescente a linha do espelho:

   ```
   ERGON_REGISTRY=registry.cn-hangzhou.aliyuncs.com/<espaço-do-ergon>
   ```

   O endereço exato é o que o Ergon publica nas notas da versão. Com essa linha, o lançador baixa as duas imagens do
   Ergon de lá e dá a elas o nome de sempre; o gerente de motores faz o mesmo com a imagem do motor de IA.
3. Instale como sempre: `bash ergon.sh install` (ou `ergon install`).

Sem a linha `ERGON_REGISTRY`, o Ergon tenta o `ghcr.io` e, se ele não responder, usa sozinho o espelho publicado com
a versão (quando a versão foi espelhada). Para **atualizar** sem o GitHub, a linha
`ERGON_MANIFESTO_URL=https://…/latest.json` aponta para uma cópia do arquivo da versão num endereço da China, com o
pacote ao lado; a soma `sha256` do pacote continua conferida.

## 2. Escolher a IA chinesa

Em **Conexões › Contas de IA**, abra **Modelos da China** e entre com a chave de API da sua conta no provedor:

| Provedor | Onde criar a chave |
|---|---|
| DeepSeek | platform.deepseek.com |
| Qwen (通义千问, DashScope) | dashscope.console.aliyun.com (a mesma chave serve à China e ao internacional) |
| Kimi (Moonshot, 月之暗面) | platform.moonshot.cn |
| GLM (智谱, Zhipu) | open.bigmodel.cn |
| MiniMax | platform.minimaxi.com |

Depois, escolha o modelo em **Modelo padrão**. A chave entra só por esse cartão: é conferida no provedor e guardada
cifrada no cofre da equipe. Nenhum agente pede chave pela conversa.

Os agentes respondem no idioma de quem escreve: com a tela em chinês (Configurações › Idioma), a equipe responde em
chinês.

## 3. Conversar pelo Feishu, pelo DingTalk e pelo WeCom

Em **Conexões › Conversar com a equipe**. Os três conectam de dentro para fora (conexão persistente), **sem endereço
público** e sem abrir porta no roteador. Só a conversa direta funciona (grupos não); as confirmações chegam como
texto e a decisão é no Ergon.

- **Feishu (飞书) ou Lark**: crie um aplicativo próprio da empresa no console de desenvolvedores, ligue o robô e cole o
  App ID e o App Secret. Escolha Feishu (open.feishu.cn) ou Lark (open.larksuite.com).
- **DingTalk (钉钉)**: crie um aplicativo interno com o robô em Stream Mode e cole o Client ID e o Client Secret.
- **WeCom (企业微信)**: no painel de administração, em Aplicativos › Robô inteligente (智能机器人), crie um robô no modo
  de conexão persistente (长连接) e cole o Bot ID e o Secret. O modo de aplicativo próprio com URL de retorno, que pede
  um endereço público, não é usado.

Depois de guardar, mande qualquer mensagem ao robô numa conversa direta: ele responde com um código de 8 letras e
números, que você digita no Ergon (com a sua senha). Daí em diante, o que você escreve ao robô vai para a equipe.

### WeChat pessoal (微信): experimental

O WeChat pessoal liga pela API iLink da Tencent, com um QR que aparece na tela do Ergon. **A Tencent pode limitar ou
bloquear a conta usada.** Por isso ele vem desligado, só liga com o seu consentimento explícito, e é melhor usar uma
conta que não seja a principal. O acesso da conta fica no cofre da equipe; desligar apaga.

## 4. O que não funciona na China

- **A nuvem do Ergon e a sincronia com o Ergon World**: ficam fora da China e não são oferecidas lá.
- **Anthropic, OpenAI e Google**: bloqueados ou instáveis. Além disso, um serviço de IA generativa aberto ao público
  na China precisa de um modelo registrado lá; nenhum modelo estrangeiro está registrado. Use os provedores chineses.
- **A cobrança local**: não há venda nem cobrança dentro da China.

## 5. Nota legal

Hospedar ou vender um serviço na China pede a licença ICP, e levar dados pessoais para fora do país segue a PIPL (Lei
de Proteção de Informações Pessoais). **Consulte um advogado local** antes de oferecer o Ergon a terceiros na China.

## Para quem publica o Ergon (o espelho)

O passo "Espelho na China" do lançamento (`.github/workflows/release.yml`) é opcional e só roda com estes três segredos
do repositório (Settings › Secrets and variables › Actions):

| Segredo | O que é |
|---|---|
| `CN_REGISTRY` | o registro com o espaço, sem `https://`: por exemplo `registry.cn-hangzhou.aliyuncs.com/<espaço>` |
| `CN_REGISTRY_USER` | o usuário de acesso ao registro |
| `CN_REGISTRY_TOKEN` | a senha (ou o token) de acesso ao registro |

Com eles, cada versão copia `ergon-community` e `ergon-community-hermes` para lá, com o mesmo digest, e o pacote local
sai com o endereço como reserva (`ERGON_REGISTRY_ESPELHO`). Sem eles, o passo só avisa e a versão sai como antes.

Para ter o registro: uma conta na Alibaba Cloud (阿里云) com o Container Registry (ACR, edição pessoal ou empresarial)
numa região da China continental, um espaço de nomes (namespace) com os repositórios `ergon-community` e
`ergon-community-hermes` como **públicos** (quem instala baixa sem login) e a senha de acesso do registro. A conta na
Alibaba Cloud pede verificação de identidade.

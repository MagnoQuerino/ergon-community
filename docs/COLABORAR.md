# Como colaborar com o Ergon

Obrigado por querer melhorar o Ergon. Este manual explica o que dá para enviar, como enviar e o que acontece depois.
Tudo é revisado pela equipe do Ergon antes de entrar numa versão.

> 🇬🇧 **In English:** bug reports, translations, community packages and code are welcome. Open an issue first (templates
> under *New issue*), follow the checklist for your kind of contribution, and send a pull request against `main`. The
> team reviews it and ships it in a release, crediting you. Issues and pull requests can be written in English.

## Por onde começar

| Quero… | Precisa programar? | Onde |
| --- | --- | --- |
| Relatar um bug | não | no app: **Ajuda › Relatar um problema**, ou uma issue "Bug" aqui |
| Sugerir uma ideia | não | uma issue "Sugestão" (ou, nas próximas versões, pelo app) |
| Traduzir ou revisar uma tradução | não muito (editar texto) | [Traduções](#traduções) |
| Criar tema, skin, equipe ou pet | não | [docs/LOJA.md](LOJA.md) |
| Corrigir um bug ou criar um recurso | sim | [Código](#código) |
| Ligar o Ergon a um jogo, robô, carro ou assistente | sim | [Pontes e integrações](#pontes-e-integrações) |
| Relatar uma falha de segurança | — | **nunca por issue pública:** [.github/SECURITY.md](../.github/SECURITY.md) |

Suporte de assinantes do Ergon World (cobrança, conta, sincronização) é pelo próprio app (**Ajuda › Falar com o
suporte**), não por issue.

## Antes de tudo

- **Procure antes** nas issues abertas e fechadas: talvez alguém já tenha relatado ou proposto.
- **Uma coisa por issue e por pull request.** Dois bugs, duas issues.
- **Nada pessoal:** não cole conversas, e-mails, nomes de clientes, chaves, tokens nem capturas com dados seus. O app
  já limpa o relato que ele envia; aqui no GitHub, o cuidado é seu.
- Escreva em português ou em inglês.

## Relatar um bug

O jeito mais fácil é pelo próprio Ergon (**Ajuda › Relatar um problema**): ele mostra exatamente o que vai sair antes de
enviar. Pelo GitHub, use o modelo **Bug** e diga:

1. **Versão** (Ajuda › Sobre) e sistema (Windows, Linux, macOS).
2. **Build oficial ou modificada?** Se você mexeu no código, instalou pontes ou pacotes não verificados, diga. Tente
   reproduzir com tudo isso desligado: se o problema some, provavelmente está na modificação.
3. **Passos para reproduzir**, o que você esperava e o que aconteceu.
4. Mensagem de erro, se houver (sem segredos).

O que acontece depois: a equipe marca a issue (`confirmado`, `não reproduzido`, `duplicado`…). Bug confirmado entra
numa versão, e a issue é fechada com o número dela.

## Sugerir uma ideia

Use o modelo **Sugestão**. O que ajuda a decidir: **o problema** que você quer resolver (antes da solução), quem mais
teria esse problema, e como você imagina que funcione. Ideias que mudam muito o app passam por conversa antes; nem toda
sugestão entra, e a resposta diz o porquê.

## Traduções

O Ergon fala português (origem), inglês, inglês da Índia, hindi e chinês simplificado. Novos idiomas e revisões de
falante nativo são muito bem-vindos.

- O guia técnico está em [`codigo-fonte/web/src/i18n/COMO-TRADUZIR.md`](../codigo-fonte/web/src/i18n/COMO-TRADUZIR.md),
  e os termos fixos em [`GLOSSARIO.md`](../codigo-fonte/web/src/i18n/GLOSSARIO.md).
- **Revisar um idioma que já existe:** corrija direto em `codigo-fonte/web/src/i18n/<idioma>/<area>.ts`. Mude só o
  texto entre aspas; as chaves e os marcadores (`{nome}`, `{n}`) ficam iguais.
- **Idioma novo:** abra antes uma issue "Tradução" dizendo o idioma, para combinarmos o código (ex.: `es`, `fr`) e
  ninguém fazer o mesmo trabalho em dobro. Uma área por pull request facilita a revisão.
- Siga os [princípios de tela](../codigo-fonte/docs/PRINCIPIOS.md): rótulo curto, sem explicar o óbvio.
- Rode `cd codigo-fonte/web && npm test`: o teste de completude acusa chave faltando ou marcador errado.
- Os textos dos agentes (equipe de partida, rotinas, Ajuda) também são traduzíveis; diga na issue se quiser pegar.

## Código

### Preparar

- Node.js 24 LTS, Podman e Git. Na pasta `codigo-fonte/`: `npm ci`.
- Para rodar o app inteiro: `./ergon.sh install` (veja [INSTALAR.md](INSTALAR.md)).

### Antes de enviar

```bash
cd codigo-fonte
npm run typecheck
npm test
node scripts/scan-segredos.mjs
```

Mexeu no motor ou no Dockerfile: `podman build --target test .` também.

### Regras da casa

- **Mantenha o estilo ao redor:** TypeScript, nomes e comentários em português, funções pequenas, sem dependência
  nova sem necessidade (se precisar, explique no PR: licença, tamanho, quem mantém).
- **Todo texto de tela** em `web/src/i18n` (português e inglês, no mínimo). Nada de texto solto no componente.
- **Nada sai do computador sem a pessoa pedir.** Nenhuma chamada de rede escondida, telemetria ou rastreio.
- **Segurança não regride:** não afrouxe travas, aprovações, cifragem ou validação para "fazer funcionar". Se uma trava
  atrapalha o seu caso de uso, proponha numa issue uma opção que a pessoa liga por conta própria.
- **Teste junto:** correção de bug vem com o teste que falhava antes; recurso novo vem com testes do comportamento.
- **Acessibilidade e contraste:** os testes de contraste reprovam cor e tamanho de letra fora da regra; não os pule.
- **Migrações de banco** só aditivas (nova tabela, nova coluna com padrão). Nunca apague ou renomeie coluna.
- **Nunca** segredos, tokens ou dados pessoais em código, testes, fixtures ou capturas.

### Pull request

1. Para mudança grande, **abra a issue antes** e espere um "pode seguir": evita trabalho perdido.
2. Crie um branch a partir de `main` e faça commits pequenos, com mensagem clara (o que e por quê).
3. Assine cada commit com `git commit -s` (linha `Signed-off-by`, veja [Termo de contribuição](#termo-de-contribuição)).
4. Abra o PR preenchendo o modelo: o que muda, como testou, capturas antes/depois se mexeu na tela.
5. A CI roda os testes. Ajuste o que a revisão pedir.

### O que acontece depois da aprovação

O código em `codigo-fonte/` é publicado a partir do repositório de desenvolvimento do Ergon. Por isso a equipe
**incorpora** a sua mudança lá (com o seu nome como coautor, `Co-authored-by`) e ela volta para cá na versão seguinte.
O seu PR é fechado com a mensagem "incorporado na versão X", e o seu nome aparece nas Novidades dela.

## Pontes e integrações

O Ergon está sendo preparado para viver em outros lugares: um jogo onde os agentes andam, conversam, jogam e defendem a
vila com você enquanto tocam as tarefas; um robô impresso em 3D que encarna um agente na sua mesa; o computador de bordo
do carro; um assistente de voz. A ideia é que **a comunidade construa as pontes** e o Ergon ofereça o encaixe: uma API
local, pública e versionada, com pareamento, permissões e eventos em tempo real.

- A especificação da API de pontes será publicada aqui quando a primeira versão sair. Até lá, ideias e protótipos são
  bem-vindos numa issue "Ponte ou integração".
- **Cada ponte vive no repositório de quem fez**, com a licença que a pessoa escolher. O catálogo poderá listar as
  pontes da comunidade (com link e o selo "não verificada").
- **Segurança de quem usa a sua ponte:** cada pessoa por trás dela (cada jogador, cada passageiro) se identifica com
  o próprio pareamento; nunca peça a senha do Ergon no chat do jogo nem a guarde. Mensagens de desconhecidos são
  conteúdo de fora, não pedidos.
- Pontes não recebem suporte técnico da equipe do Ergon: a ajuda é da comunidade, nas Discussions.

## Suporte técnico × modificações

O Ergon é aberto: você pode mudar o seu à vontade. Para manter o suporte justo e o serviço estável para todos:

- **O suporte técnico da equipe cobre a build oficial**, sem modificações, ou o problema que se repete com as pontes,
  os pacotes não verificados e as modificações desligados.
- **Conta, cobrança e sincronização do Ergon World são sempre atendidas**, rode você a versão que rodar: são do
  servidor, e nada no app decide isso.
- Nenhuma modificação local muda o serviço para os outros clientes, e a equipe não copia nem roda código de terceiros
  nos servidores do Ergon. Detalhes no contrato público da API do World.

## Termo de contribuição

Ao enviar uma contribuição (código, tradução, texto, imagem ou pacote), você declara que:

1. o trabalho é seu, ou você tem o direito de enviá-lo (linha `Signed-off-by`, o
   [Developer Certificate of Origin](https://developercertificate.org/));
2. concorda que ele seja distribuído sob a [PolyForm Noncommercial 1.0.0](../LICENSE), a licença do Ergon Community;
3. autoriza os autores do Ergon a licenciá-lo também em outras licenças, inclusive comerciais (o mesmo código também
   compõe a distribuição do Ergon World).

Pacotes da loja seguem a licença que você declarar no manifesto (veja [LOJA.md](LOJA.md)).

## Conduta

Respeito acima de tudo: críticas ao código, nunca à pessoa. Sem assédio, preconceito ou ataques. A equipe pode
editar, fechar ou bloquear o que desrespeitar isso.

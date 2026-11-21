# Como traduzir uma área da tela

A tela fala português e inglês por dicionários: `pt/<area>.ts` é a origem e `en/<area>.ts` é a tradução, tipada pelo
português. Cada arquivo de tela pertence a uma área (`particao.ts`); a equipe da área só mexe nos arquivos dela, no
`pt/<area>.ts` e no `en/<area>.ts`. Os índices (`pt/index.ts`, `en/index.ts`) já têm todas as áreas e não mudam.

Antes de escrever um texto novo, leia os [princípios de tela](../../../docs/PRINCIPIOS.md): texto só no que não é
intuitivo, rótulo curto, estado em uma palavra, o visual guiando antes da frase. O que explica o funcionamento vai
para a Ajuda (`pt/ajuda.ts`), não para a tela.

## O passo a passo

1. Abra o arquivo de tela da sua área e troque cada texto escrito por `t('area.chave')`:
   ```tsx
   import { useT } from '../i18n/index.ts';
   const t = useT();                 // dentro do componente: a troca de idioma redesenha na hora
   <button title={t('geral.barra.modoFocoDica')}>{t('geral.barra.modoFoco')}</button>
   ```
2. Escreva a chave em `pt/<area>.ts` com o texto de hoje, sem mudar nada, e a mesma chave em `en/<area>.ts` com o
   inglês (termos fixos em `GLOSSARIO.md`). Nomes de chave: o lugar e a ideia (`barra.modoFoco`,
   `estado.naFila`), nunca a frase.
3. Rode `cd web && npm test` e `npx tsc --noEmit -p .`. Testes antigos que procuravam o texto em português dentro do
   código (`assert.match(app, /Modo Foco/)`) passam a procurar a chave (`t('geral.barra.modoFoco')`).

## Formas de texto

- **Com valor:** `'barra.pedirA': 'Pedir a {nome}'` → `t('geral.barra.pedirA', { nome })`. O TypeScript exige
  exatamente os marcadores do texto. **Só o `{n}` sai formatado no idioma** (1.250 / 1,250); os outros números saem
  crus, como vieram, para que número do card, ano, porta e versão não ganhem separador (`#{numero}` → `#1234`, nunca
  `#1.234`). Uma quantidade num marcador que não é o `{n}`: formate antes, com `fmtNumero()`.
- **Plural:** `'estado.avisos': { one: '{n} aviso', other: '{n} avisos' }` → `t('geral.estado.avisos', { n })`. Acaba
  o `aviso(s)` e o `${n === 1 ? '' : 's'}`. O 0 sempre usa o `other` ("0 avisos", como a tela sempre mostrou), mesmo
  com o Intl dizendo que em português o 0 é singular; `zero` serve para uma frase própria do 0 exato:
  `{ zero: 'Nada aguardando você', other: '…' }`.
- **Frase com negrito, link ou ícone no meio:** a frase inteira é uma chave, com marcadores, e `tn()` encaixa os pedaços
  na ordem de cada idioma (o inglês pode mudar a ordem das palavras):
  `tn('ajuda.conversar', { nome: <b>{coord.name}</b> })` com `'conversar': 'Que tal conversar com {nome}?'`.
  Nunca monte a frase com pedaços traduzidos separados (`t('a') + nome + t('b')`).
- **Tabelas de rótulos** criadas ao abrir o arquivo (`const NAV = [{ label: 'Cidade' }]`): guarde a chave e traduza na
  hora de mostrar (`{ label: 'geral.nav.cidade' as const }` … `t(n.label)`), ou transforme a tabela em função. Texto
  traduzido guardado em constante de módulo não troca de idioma.
- **Datas, horas e números:** `fmtData`, `fmtHora`, `fmtDataHora`, `fmtRelativo`, `fmtNumero`, `fmtCompacto`,
  `fmtMoeda`, `fmtDracmas`, `fmtBytes` e `fmtLista`, de `i18n/index.ts`, no lugar de `toLocaleString('pt-BR')`
  (o teste-catraca acusa o `'pt-BR'` escrito à mão).
- **Fora do React** (a cidade desenhada no canvas): `t()` direto e `onIdioma(() => redesenhar())` para refazer os
  rótulos quando o idioma mudar.
- `useMemo` com texto traduzido: ponha o idioma (`useIdioma()`) nas dependências.

## O que não se traduz

O que a pessoa ou a equipe escreveu (nomes, títulos de card, conversas), os nomes dos personagens, nomes de marcas
(Microsoft, Google, WhatsApp…), as chaves internas (`'ambiente'`, `'#configuracao?conta'`, nomes de ícone) e os
textos que só reconhecem o português que o servidor manda. Esses últimos ficam com o comentário `// i18n-ok: <porquê>`
na linha (ou na de cima), e somem quando o servidor passar a mandar um código.

## O teste-catraca (catraca.test.ts)

Falha quando um arquivo de tela tem texto em português escrito direto no código. A heurística está no começo de `varredura.ts`: texto solto
no JSX, letras acentuadas do português, frases (duas palavras ou mais com maiúscula, ponto final ou palavra curta do
português; num template, `${n} agentes` e o plural montado à mão), texto em atributo ou propriedade visível (`title`,
`aria-label`, `placeholder`, `label`, `name`…) ou no argumento de quem mostra (`toast`, `alert`, `confirm`, `setHint`,
`setErr`…), a palavra solta com maiúscula ou pontuação (`'Fixadas'`, `'Desfeito.'`, `'Enviando…'`) em tabela, lista,
argumento, valor padrão, valor inicial ou retorno, e o `'pt-BR'` fixo. Ao falhar, o teste lista arquivo, linha, regra
e texto de cada achado.

A palavra solta com maiúscula também pega nomes internos (`'Files'` do arrastar arquivos, um valor que a API espera
assim). Esses ficam com `// i18n-ok: <porquê>` na linha (ou na de cima). Não marque texto de tela como i18n-ok: o
comentário é para o que não é tela.

## lib/textos-tela.ts (área servidor)

Fica como está por enquanto: são as frases que a tela monta a partir do que o servidor manda (erros de login,
motivos de falha). A equipe da área "servidor" migra junto com a frente que faz o servidor mandar códigos em vez de
frases; o teste dele (`textos-tela.test.ts`) continua conferindo o português.


## De onde vem o idioma (uma ordem só, em `index.ts`)

- **Antes de entrar** (tela de entrada): a última escolha feita neste navegador; sem ela, o idioma do sistema ou do
  navegador (`navigator.languages`, a primeira que a tela fala: pt → Português, zh → 简体中文, hi → हिन्दी, en-IN e as
  outras línguas da Índia → English (India); o resto em inglês). No aplicativo, o WebView segue o sistema.
- **Depois de entrar:** a escolha da pessoa, gravada no servidor (`users.lang`, a mesma em todos os workspaces dela) >
  a escolha dela guardada neste navegador (`ergon.idioma:<pessoa>`; a gravação no servidor tinha falhado: vai de novo)
  > o idioma do navegador. Na multiconta, a tela de entrada fica na língua de quem entrou por último; ao entrar, a tela
  da pessoa já abre na dela (o App espera o dicionário antes de desenhar).
- **Quem já usava o Ergon:** a migração `0040_idioma_da_pessoa.sql` gravou `pt-BR` nas contas que já existiam (o
  inglês ficou escondido até a rc.26): quem usava o Ergon em português não viu a tela mudar de língua por ter o
  navegador ou o Windows em inglês; só contas novas seguem o navegador.

## Cuidados com o inglês

- Nenhum arquivo de tela com texto em português fora do dicionário (o teste-catraca garante).
- Os ensaios de tela no navegador (`scripts/telas/*.mjs`, Edge headless costuma vir em en-US) procuram textos em
  português como "Modo Foco": fixe o idioma deles (`localStorage 'ergon.idioma' = 'pt-BR'` antes de abrir, ou
  `--lang=pt-BR`) ou faça-os procurar pelas duas línguas.
- A dica do seletor (`geral.idioma.dica`) só promete o que a tela faz. Desde a rc.45, as instruções do agente dizem o
  idioma de quem lê (`server/src/services/idioma-motor.ts`, `instrucaoDeIdioma`), e o motor recebe zh e hi.

## Chinês e hindi (rc.44)

- **Cinco idiomas**: `pt-BR` e `en` completos; `zh-CN`, `hi` e `en-IN` parciais (`idiomas.ts`). O que um parcial não
  tem cai na reserva dele (`RESERVA`: o inglês), baixada junto; nunca aparece a chave crua (`nucleo.test.ts` confere
  todas as chaves nos três). `en-IN` é o inglês inteiro com número, data e moeda da Índia (lakh e crore: 12,34,567; ₹).
- **Arquivos**: `zh-CN/<area>.ts` e `hi/<area>.ts`, tipados por `TraducaoParcial` (só chaves que existem no português,
  com o mesmo tipo e os mesmos marcadores). Áreas cobertas na rc.44: geral, quadro, tarefa, visuais e conversas (salas
  incluídas) quase inteiras; entrar, recuperar e Minha conta (conta), as boas-vindas e o tour (ajuda), as contas de IA e
  a chave própria (configurações) e os erros mais comuns (servidor). `completude.test.ts` exige esse mínimo.
  **rc.45**: o chinês ganha as áreas que faltavam inteiras: cidade, equipe, agente, rotinas, documentos, Conexões e
  Configurações (ficam parciais só conta, ajuda e servidor). O hindi continua na cobertura da rc.44.
- **Texto de fábrica** (rc.45, `sementes.ts`): as funções da equipe de partida, os setores e os quadros "Minhas tarefas"
  e "Quadro da equipe" ficam gravados em português no banco (a sincronia e o que a pessoa renomeia não mudam); a tela
  reconhece o texto EXATO de fábrica com `daSemente()` e mostra a tradução (`equipe.semente.*`). O que a pessoa escreveu
  aparece como está. `sementes.test.ts` confere que o português é o mesmo do servidor. As equipes de nicho
  (`server/src/services/team-presets.ts`) ainda ficam em português.
- **REVISÃO POR NATIVO PENDENTE**: as traduções foram geradas a partir do inglês, com o glossário abaixo, e cada
  arquivo traz `REVISAO_NATIVA_PENDENTE = true`. Ao revisar uma área, troque para `false` e anote quem revisou.
- **Glossário**: agente 智能体 / एजेंट · Equipe 团队 / टीम · Tarefas 任务 / कार्य · card 卡片 / कार्ड · quadro 看板 /
  बोर्ड · Rotinas 例行任务 / रूटीन · Conexões 连接 / कनेक्शन · Configurações 设置 / सेटिंग्स · Aguardando você 等你处理 /
  आपकी प्रतीक्षा में · Salas 协作室 / रूम · entrega 交付 / डिलीवरी · Modo Foco 专注模式 / फ़ोकस मोड. Nomes de produto e
  dos personagens não se traduzem (Ergon World, Ergon AI, Aristóteles…).
- **Catraca**: além do português, nenhum arquivo de tela pode ter chinês ou devanágari escrito direto (só aqui).
- **Fontes na tela** (`lib/fontes.ts`): a Noto Sans SC e a Noto Sans Devanagari (woff2, subconjuntos, em
  `public/fontes`) só entram em `document.fonts` quando o idioma é chinês ou hindi, e o navegador só as baixa se as do
  sistema (PingFang, YaHei, Nirmala…) não tiverem o caractere. O bundle não muda.
- **PDF e PNG** (servidor): o PDFKit embute as Noto de `server/assets/fontes` (subconjuntos TTF, OFL) e forma o
  devanágari pelo fontkit — conjuntos (क्ष, त्र, श्र), o ि pré-posto, o reph e os matras saem certos, conferidos por
  `server/test/idiomas-escritas.test.ts`. Por isso o PDF em hindi NÃO precisou do Chromium do contêiner do motor nem do
  harfbuzz em wasm (avaliados: o Chromium só existe na imagem do motor, que nem sempre está ligada; o harfbuzzjs daria
  o mesmo resultado com uma dependência a mais). Já o resvg dos PNG perde os espaços e desfaz os conjuntos do hindi:
  lá o texto em devanágari vira curvas já formadas pelo mesmo fontkit (`services/visuais/curvas.ts`). Limite: no PDF,
  o texto copiado do hindi sai na ordem visual (o ि antes da consoante), como na maioria dos geradores de PDF.
- **Servidor**: `server/src/lib/i18n.ts` tem o mínimo que chega à pessoa sem passar pela tela (avisos dos canais,
  numeração do PDF) nos quatro textos e o formatador por locale (`fmtNumero`, `fmtMoeda`, `fmtData`). O motor de IA
  recebe `en` para chinês e hindi nesta versão (a ponte só aceita pt e en).

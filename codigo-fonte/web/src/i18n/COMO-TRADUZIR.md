# Como traduzir uma área da tela

A tela fala português e inglês por dicionários: `pt/<area>.ts` é a origem e `en/<area>.ts` é a tradução, tipada pelo
português. Cada arquivo de tela pertence a uma área (`particao.ts`); a equipe da área só mexe nos arquivos dela, no
`pt/<area>.ts`, no `en/<area>.ts` e na lista dela em `pendentes.ts`. Os índices (`pt/index.ts`, `en/index.ts`) já têm
todas as áreas e não mudam.

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
3. Tire o arquivo da lista da sua área em `pendentes.ts`.
4. Rode `cd web && npm test` e `npx tsc --noEmit -p .`. Testes antigos que procuravam o texto em português dentro do
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

Falha quando um arquivo de tela fora de `pendentes.ts` tem texto em português escrito direto no código, e quando um
arquivo da lista já está limpo (para a lista só diminuir). A heurística está no começo de `varredura.ts`: texto solto
no JSX, letras acentuadas do português, frases (duas palavras ou mais com maiúscula, ponto final ou palavra curta do
português; num template, `${n} agentes` e o plural montado à mão), texto em atributo ou propriedade visível (`title`,
`aria-label`, `placeholder`, `label`, `name`…) ou no argumento de quem mostra (`toast`, `alert`, `confirm`, `setHint`,
`setErr`…), a palavra solta com maiúscula ou pontuação (`'Fixadas'`, `'Desfeito.'`, `'Enviando…'`) em tabela, lista,
argumento, valor padrão, valor inicial ou retorno, e o `'pt-BR'` fixo. Ao falhar, o teste lista arquivo, linha, regra
e texto de cada achado.

A palavra solta com maiúscula também pega nomes internos (`'Files'` do arrastar arquivos, um valor que a API espera
assim). Esses ficam com `// i18n-ok: <porquê>` na linha (ou na de cima). Não tire o arquivo dos pendentes com texto
de tela marcado como i18n-ok: o comentário é para o que não é tela.

## lib/textos-tela.ts (área servidor)

Fica como está por enquanto: são as frases que a tela monta a partir do que o servidor manda (erros de login,
motivos de falha). A equipe da área "servidor" migra junto com a frente que faz o servidor mandar códigos em vez de
frases; o teste dele (`textos-tela.test.ts`) continua conferindo o português.

## Conferir o inglês antes de ele ser liberado

Enquanto `IDIOMA_INGLES_LIBERADO` (em `idiomas.ts`) é `false`, o seletor fica escondido e a tela abre em português.
Para conferir: no console do navegador, `localStorage.setItem('ergon.idioma', 'en')` e recarregar (volta com `'pt-BR'`).

## De onde vem o idioma (uma ordem só, em `index.ts`)

- **Antes de entrar** (tela de entrada): a última escolha feita neste navegador; sem ela, o idioma do navegador
  (português se `navigator.language` começa com "pt"; inglês nos outros casos).
- **Depois de entrar:** a escolha da pessoa, gravada no servidor (`users.lang`, a mesma em todos os workspaces dela) >
  a escolha dela guardada neste navegador (`ergon.idioma:<pessoa>`; a gravação no servidor tinha falhado: vai de novo)
  > o idioma do navegador. Na multiconta, a tela de entrada fica na língua de quem entrou por último; ao entrar, a tela
  da pessoa já abre na dela (o App espera o dicionário antes de desenhar).
- **Quem já usava o Ergon:** a migração `0040_idioma_da_pessoa.sql` grava `pt-BR` em todas as contas que já existiam,
  e enquanto o inglês não é liberado a tela grava `pt-BR` em quem entra sem idioma. No dia de ligar o inglês, ninguém
  que usa o Ergon em português vê a tela mudar de língua por ter o navegador ou o Windows em inglês; só contas novas
  seguem o navegador.

## No dia de ligar o inglês (IDIOMA_INGLES_LIBERADO = true)

- `pendentes.ts` vazio em todas as áreas (o teste-catraca garante).
- Os ensaios de tela no navegador (`scripts/telas/*.mjs`, Edge headless costuma vir em en-US) procuram textos em
  português como "Modo Foco": fixe o idioma deles (`localStorage 'ergon.idioma' = 'pt-BR'` antes de abrir, ou
  `--lang=pt-BR`) ou faça-os procurar pelas duas línguas.
- A dica do seletor (`geral.idioma.dica`) só promete o que a tela faz. Se a equipe passar a responder no idioma da
  pessoa (os textos de instrução no servidor hoje pedem português), aí sim dá para dizer isso na dica.

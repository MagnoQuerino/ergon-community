# Blocos visuais (rc.42)

Os agentes mostram números como visual, não como parágrafo: métrica, gráfico, tabela, comparativo, prazos, metas,
enquete, relatório e prévias, embutidos no texto da mensagem. Formato e validação em `shared/visuais/`; tela em
`web/src/visuais/`; servidor em `server/src/routes/visuais.ts` e `server/src/services/visuais/`.

## O formato

Uma cerca por bloco, na convenção dos blocos do documento (Entregáveis, `web/src/lib/documento.ts`):

    ```ergon-kpi
    {"rotulo":"Gastos de novembro","valor":18420.5,"formato":"moeda","variacao":-8.2,"bom":"baixa",
     "fontes":[{"tipo":"conexao","titulo":"Nubank PJ","periodo":"1–20/11"}]}
    ```

- O tipo vem da linguagem (`ergon-<tipo>`, com hífen: `ergon-linha-do-tempo`). `ergon-visual` com `"tipo"` no JSON
  também é aceito na leitura; a normalização grava a do tipo.
- JSON declarativo, nunca HTML nem script. Números como número (a tela formata em pt-BR: `R$ 1.234,50`, `12,5%`,
  `21/11/2026`). Percentual de 0 a 100.
- **Fonte sempre**: todo bloco de dado leva `fontes[]` (`{tipo: conexao|documento|site|calculo|conversa, titulo,
  periodo, url ou id}`) ou `"estimativa": true`, que aparece marcado. Sem isso o servidor recusa.
- Comuns: `titulo`, `subtitulo`, `nota`, `lado` (o resumo ao lado do mini visual: número grande e até 3 linhas).

Os tipos: `kpi`, `kpis`, `nota` (cabeçalho de avaliação "8,5/10"), `barras` (horizontal, empilhado, destaque, meta),
`linhas`, `pizza` (rosca), `tabela` (ordenável, totais, destaques, moeda e data), `comparativo`, `versus` (dois valores
e a barra dividida), `placar` (veredito), `linha_do_tempo`, `progresso` (barra ou anel), `checklist`, `status`,
`semaforo`, `medidor` (arco ou termômetro, com faixas), `sparkline`, `icones` (pictogramas proporcionais: pessoa,
e-mail, moeda, ampulheta, relógio, estrela, carinha, caixa, calendário, prédio), `funil`, `calor`, `matriz` (esforço ×
impacto), `enquete`, `decisao`, `ficha` (ficha de produto), `pessoa`, `aviso`, `galeria`, `link`, `arquivo`, `mapa`,
`referencias` (o formato das referências dos modelos de entrega), `fontes` e `relatorio`. Os campos de cada um:
`CATALOGO_VISUAIS` em `shared/visuais/prompt.ts`; um exemplo de cada: `shared/visuais/exemplos.ts`.

## O agente

- A regra curta (quando usar, como escolher o mini visual pela pergunta, com exemplos) vai no prompt de sistema de todo
  agente (`VISUAIS_NO_PROMPT`, no SOUL).
- A ferramenta `visual` (plugin `ergon_bridge`, conjunto `ergon_cartoes`, sempre ligado) leva o bloco a
  `POST /internal/bridge/v1/visual`: volta a cerca pronta para colar, ou os erros com o caminho
  (`series[0].valores: 5 valores para 6 categorias`) para corrigir e chamar de novo. `catalogo=true` devolve os campos.
- Ao gravar a resposta (`RunExecutor.withMedia`), cada cerca é validada de novo e gravada normalizada; a que não passa
  vira um bloco de código JSON comum (a pessoa ainda vê os dados).

## Onde aparece

- Conversas, salas, o diálogo de detalhes das entregas e o documento: tudo que desenha Markdown com
  `components/Markdown.tsx` desenha os blocos. A sincronia das salas e do World leva a mensagem inteira: os blocos vão
  junto, sem tabela nova.
- Enquete: o voto é uma mensagem da pessoa só com a cerca ` ```ergon-voto {"enquete","opcao"} ` (vale o último de cada
  um). Na conversa direta, `POST /api/conversations/:id/votos` grava sem chamar o agente; nas salas, a tela manda a
  mesma cerca como mensagem da sala (sem menção) e passa os votos e `eleitores` pelo `ContextoVisuais`.
- Relatório: na conversa, o resumo e até dois mini visuais; "Abrir relatório" salva o `.md` com as cercas em
  Documentos (`POST /api/visuais/relatorio/documento`, sem duplicar) e abre no visualizador de documentos
  (`web/src/visuais/documento.tsx`), onde ficam a revisão ao vivo, as versões e o PDF.
- Canais (Telegram, Discord, Teams, WhatsApp) e prévias: `visuaisComoTexto` (o número, as linhas e a fonte). Telegram e
  Discord recebem também o PNG de cada bloco (até 4 por mensagem), item `imagem` da fila de saída.
- "Baixar PNG": o cartão (`shared/visuais/svg.ts`: título, visual, fontes e a marca) em 2x, no tema da tela; o mesmo
  gerador, rasterizado pelo resvg com a Inter de `server/assets/fontes`, faz o PNG dos canais.

## Gráficos

SVG próprio, sem biblioteca: a tela não usava nenhuma, e a mesma geometria (`shared/visuais/cena.ts`) serve à tela
(React, cores do tema por variável CSS, animação de entrada, `prefers-reduced-motion`) e ao PNG do servidor. Cada
gráfico traz o texto alternativo e a tabela de dados ("Ver dados" e leitor de tela).

## Segurança

- Prévia de link e imagens de fora passam pelo servidor (`services/visuais/rede.ts`): só http(s) nas portas 80/443, sem
  usuário:senha, todos os endereços resolvidos públicos (sem 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
  100.64/10, ::1, fc00::/7, fe80::/10, IPv4 em IPv6), conexão ao IP conferido (sem DNS rebinding), até 3
  redirecionamentos conferidos, 5 s e 512 KB (página) / 6 s e 3 MB (imagem, conferida pelos bytes, sem SVG).
- IDs internos (`art_`, `tsk_`, `cnv_`) conferidos no workspace; referências só com os domínios das Conexões.

## Ligação com os outros módulos (rc.43)

- Documento dos Entregáveis: `web/src/visuais/registro.ts` registra todos os tipos (e a cerca genérica
  `ergon-visual`) com `registrarBlocoVisual`; `components/Markdown.tsx` e `components/Documento.tsx` desenham pelo
  registro. "Abrir relatório" abre `<Documento fonte={{ artifactId }} modo="dialogo" revisar />` (revisão ao vivo,
  versões, PDF).
- PDF (`lib/pdf-documento.ts`): cada cerca vira o cartão em PNG (`pngsDasCercas`, em `services/visuais/png.ts`), no tema
  claro e sem a marca. O PDFKit embute na hora só PNG opaco; `lib/png-opaco.ts` tira o alfa (o cartão e o logo com
  fundo transparente, que antes sumia do PDF).
- Modelos de entrega: `EntregaDetalhes` mostra `detalhes` com `<Markdown>`; `TIPOS_REF`/`DOMINIOS_REF` moram só em
  `shared/visuais/esquema.ts` (`services/modelos-entrega.ts` reexporta).
- Salas: `ContextoVisuais` com os votos (`votosDe`, quem votou é o autor), `eu` e `eleitores` = as pessoas da sala;
  votar manda `cercaVoto(...)` como mensagem da sala, sem menção (nenhum agente é chamado); as mensagens só de voto
  ficam fora da lista e a prévia da sala mostra o voto em uma palavra.
- Recursos livres: `visual` vem com os cartões (conjunto `ergon_cartoes`, sempre ligado), de todo agente, qualquer
  que seja a lista dele; não é item por agente (recursos-livres.test, test_ergon_bridge_gate).

/**
 * O que o agente lê sobre os blocos visuais: a regra curta no prompt de sistema (vai no SOUL de todo agente) e o
 * catálogo completo, devolvido pela ferramenta `visual` (catalogo=true) e usado na descrição dela.
 */

/** A regra curta: quando usar, como escolher, a fonte sempre. Vai no prompt de sistema de todo agente. */
export const VISUAIS_NO_PROMPT = [
  `Visuais: números entram como visual, não como parágrafo. Na conversa, mande o bloco numa cerca \`\`\`ergon-<tipo> (ex.: \`\`\`ergon-kpi, \`\`\`ergon-linha-do-tempo) com o JSON (nunca HTML), validado antes pela ferramenta visual (ela devolve a cerca pronta ou os erros para corrigir).`,
  'Escolha pela pergunta: um percentual → pizza com rosca pequena e "lado" (número grande + 2 ou 3 destaques; o número do lado não repete o do centro); satisfação ou nota → medidor; "como está X" ao longo do tempo → sparkline; "quantos de N" → icones (7 de 10 pessoas); gastos por categoria → kpis + barras + tabela; comparar 2 opções → versus ou comparativo; prazos → linha_do_tempo; metas → progresso; etapas → funil; horários → calor; priorizar → matriz; avaliação → nota e placar; decidir em grupo → enquete e, fechada, decisao.',
  'Toda vez diga de onde veio o dado em "fontes" ({tipo: conexao|documento|site|calculo|conversa, titulo, periodo, url ou id}); sem fonte só com "estimativa": true. Em grupo, mostre a decisão. Coisa grande vira "relatorio" (resumo + destaques compactos + seções): a pessoa abre como documento, revisa e baixa em PDF. No mínimo 1 frase de texto junto; nada de repetir em texto o que o visual já mostra.',
  'Exemplos: "quantos % dos e-mails estão sem resposta?" → {"tipo":"pizza","titulo":"E-mails sem resposta","fatias":[{"rotulo":"Sem resposta","valor":37},{"rotulo":"Respondidos","valor":63}],"centro":{"valor":"37%","rotulo":"sem resposta"},"lado":{"numero":"152","rotulo":"de 412 e-mails sem resposta","linhas":["98 aguardam há mais de 2 dias","Pico na segunda de manhã"]},"fontes":[{"tipo":"conexao","titulo":"Outlook · suporte@","periodo":"1–20/11"}]}; "como está a satisfação no e-mail?" → {"tipo":"medidor","rotulo":"Satisfação (CSAT)","valor":78,"formato":"percentual","tendencia":4,"faixas":[{"ate":60,"tom":"ruim","rotulo":"ruim"},{"ate":75,"tom":"ok","rotulo":"ok"},{"ate":100,"tom":"bom","rotulo":"bom"}],"fontes":[{"tipo":"conexao","titulo":"Zendesk · pesquisas","periodo":"outubro"}]}.',
].join('\n');

/** O catálogo de campos (o agente pede quando precisa: ferramenta visual com catalogo=true). */
export const CATALOGO_VISUAIS = `Blocos visuais do Ergon: uma cerca \`\`\`ergon-<tipo> com o JSON do bloco (o tipo com hífen: ergon-linha-do-tempo). Comuns a todos: titulo (≤90), subtitulo, nota, fontes[] (obrigatória nos blocos de dado), estimativa (true dispensa fonte), lado {numero, rotulo, linhas[≤3]} (resumo ao lado do mini visual).
Formatos de número: formato = numero | inteiro | moeda (moeda: BRL|USD|EUR|CNY|INR) | percentual (0–100) | compacto | data (AAAA-MM-DD) | texto. Números sempre como número JSON.
- kpi: rotulo, valor, formato, unidade, variacao (% vs. antes), comparacao ("vs. out"), bom (alta|baixa: gasto é baixa), meta, serie[]
- kpis: itens[2..6] de kpi
- nota: rotulo (CAIXA ALTA curta), valor, escala (10), legenda — cabeçalho de avaliação "8,5/10"
- barras: categorias[], series[{nome, valores[]}], formato, horizontal, empilhado, destaque (índice), meta
- linhas: categorias[], series[], formato, area, meta
- pizza: fatias[{rotulo, valor}], rosca (padrão true), centro {valor, rotulo}
- tabela: colunas[{titulo, formato, moeda, alinhar}], linhas[[…]], totais (true ou a linha), destaques[{linha, coluna, tom: bom|ruim|atencao|neutro|marca}], negrito[índices]
- comparativo: opcoes[2..3]{nome, subtitulo, valor, pros[], contras[], recomendada}
- versus: a {rotulo, valor, legenda}, b {…}, formato, melhor (a|b), pontas ["Reparo básico","Reparo completo"]
- placar: itens[{rotulo, nota}], escala — veredito com barra fina por critério
- linha_do_tempo: marcos[{data, titulo, detalhe, estado: feito|em_dia|atrasado|risco|previsto}], hoje
- progresso: itens[{rotulo, atual, meta, formato, prazo}], estilo (barra|anel)
- checklist: itens[{texto, estado: feito|andamento|pendente|bloqueado}]
- status: itens[{rotulo, estado: ok|atencao|erro|parado, detalhe}]
- semaforo: itens[{rotulo, cor: verde|amarelo|vermelho, detalhe}]
- medidor: valor, min, max, faixas[{ate, tom: ruim|ok|bom, rotulo}], formato, rotulo, tendencia, estilo (arco|termometro)
- sparkline: rotulo, serie[], formato, bom
- icones: valor, total (≤20), icone (pessoa|email|moeda|ampulheta|relogio|estrela|carinha|caixa|calendario|predio), rotulo ("7 de 10 clientes…")
- funil: etapas[{rotulo, valor}]
- calor: linhas[] (ex. dias), colunas[] (ex. horas), valores[[…]]
- matriz: itens[{rotulo, x 0–10 (esforço), y 0–10 (impacto)}], eixos, quadrantes
- enquete: pergunta, opcoes[2..6], id, votos[{opcao, quem}], encerrada, decisao (índice), eleitores — cada pessoa vota com um clique
- decisao: escolha, votos, total, porque, proximos[]
- ficha: imagem {src, alt}, linhas[{parametro, valor, destaque}], cabecalho — ficha de produto
- pessoa: nome, cargo, empresa, email, telefone, site, local, foto, tags
- aviso: tom (info|dica|alerta|risco|sucesso), texto
- galeria: imagens[{src (art_… ou https), alt, legenda}]
- link: url, descricao (o Ergon busca título e imagem) · arquivo: id (art_…) — prévia do PDF, planilha, documento ou código
- mapa: endereco, lat, lng · referencias: itens[{tipo (email|documento|arquivo|evento|tarefa|pr|issue|mensagem|conversa|card|pagina), titulo, url ou id}]
- fontes: itens[] (rodapé avulso)
- relatorio: id, versao, resumo, destaques[≤2 blocos compactos], secoes[{titulo, texto, blocos[]}] — abre como documento (revisão e PDF ali).
Fonte: {tipo: conexao|documento|site|calculo|conversa, titulo ("Outlook · suporte@"), periodo ("1–20/11"), url ou id (art_/tsk_/cnv_)}.`;

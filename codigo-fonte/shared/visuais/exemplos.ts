/**
 * Um exemplo realista de cada bloco visual (rc.42): a galeria de desenvolvimento (web/visuais.html), os testes (cada
 * tipo valida, vira texto e vira PNG) e a documentação usam os mesmos. Não vai para o agente: o prompt tem os dele.
 */
import type { BlocoDe, Fonte, TipoBloco } from './esquema.ts';

const nubank: Fonte = { tipo: 'conexao', titulo: 'Nubank PJ · conta 0001', periodo: '1–20/11', url: 'https://app.nubank.com.br' };
const planilha: Fonte = { tipo: 'documento', titulo: 'Orçamento 2026.xlsx', periodo: 'nov/2026' };
const calculo: Fonte = { tipo: 'calculo', titulo: 'Cálculo da Hipátia', periodo: 'nov/2026' };
const outlook: Fonte = { tipo: 'conexao', titulo: 'Outlook · suporte@', periodo: '1–20/11', url: 'https://outlook.office.com/mail/' };
const zendesk: Fonte = { tipo: 'conexao', titulo: 'Zendesk · pesquisa CSAT', periodo: 'out–nov', url: 'https://ergon.zendesk.com/agent' };
const manual: Fonte = { tipo: 'site', titulo: 'Manual técnico JB Industries', url: 'https://www.jbind.com/manuals' };
const manualslib: Fonte = { tipo: 'site', titulo: 'ManualsLib', url: 'https://www.manualslib.com' };
const asana: Fonte = { tipo: 'conexao', titulo: 'Asana · Lançamento rc.42', periodo: 'hoje', url: 'https://app.asana.com/0/1' };
const sala: Fonte = { tipo: 'conversa', titulo: 'Sala Comercial', periodo: '18–21/11' };

export const EXEMPLOS: { [T in TipoBloco]: BlocoDe<T> } = {
  kpi: { tipo: 'kpi', rotulo: 'Gastos de novembro', valor: 18420.5, formato: 'moeda', variacao: -8.2, comparacao: 'vs. outubro', bom: 'baixa', meta: 20000, serie: [21300, 19850, 22100, 20040, 18420.5], fontes: [nubank] },
  kpis: { tipo: 'kpis', titulo: 'Resumo do mês', itens: [
    { rotulo: 'Gastos', valor: 18420.5, formato: 'moeda', variacao: -8.2, comparacao: 'vs. out', bom: 'baixa' },
    { rotulo: 'Receita', valor: 46900, formato: 'moeda', variacao: 12.4, comparacao: 'vs. out' },
    { rotulo: 'Margem', valor: 60.7, formato: 'percentual', variacao: 4.1, comparacao: 'p.p.' },
    { rotulo: 'Clientes ativos', valor: 128, formato: 'inteiro', variacao: 3 },
  ], fontes: [nubank, planilha] },
  nota: { tipo: 'nota', titulo: 'Avaliação do Ergon — Novembro de 2026', rotulo: 'Nota geral provisória · produto comercial', valor: 8.5, escala: 10, legenda: 'Muito promissor, ainda em pré-lançamento', fontes: [calculo] },
  barras: { tipo: 'barras', titulo: 'Gastos por categoria', subtitulo: 'Novembro, até o dia 20', categorias: ['Folha', 'Aluguel', 'Software', 'Marketing', 'Impostos', 'Outros'],
    series: [{ nome: 'Novembro', valores: [9800, 4500, 1240, 1180, 1320, 380.5] }], formato: 'moeda', destaque: 0, fontes: [nubank] },
  linhas: { tipo: 'linhas', titulo: 'Receita × gastos', categorias: ['jun', 'jul', 'ago', 'set', 'out', 'nov'],
    series: [{ nome: 'Receita', valores: [38200, 40100, 39800, 43100, 41700, 46900] }, { nome: 'Gastos', valores: [19800, 21300, 19850, 22100, 20040, 18420] }], formato: 'moeda', area: true, fontes: [nubank] },
  pizza: { tipo: 'pizza', titulo: 'E-mails sem resposta', fatias: [{ rotulo: 'Sem resposta', valor: 152 }, { rotulo: 'Respondidos', valor: 260 }], formato: 'inteiro',
    centro: { valor: '37%', rotulo: 'sem resposta' }, lado: { numero: '152', rotulo: 'de 412 e-mails', linhas: ['98 esperam há mais de 2 dias', 'Pico na segunda de manhã', 'Financeiro concentra 41%'] }, fontes: [outlook] },
  tabela: { tipo: 'tabela', titulo: 'Gastos por categoria', colunas: [{ titulo: 'Categoria' }, { titulo: 'Valor', formato: 'moeda' }, { titulo: '% do total', formato: 'percentual' }, { titulo: 'Vencimento', formato: 'data' }],
    linhas: [['Folha', 9800, 53.2, '2026-11-30'], ['Aluguel', 4500, 24.4, '2026-11-10'], ['Impostos', 1320, 7.2, '2026-11-20'], ['Software', 1240, 6.7, '2026-11-15'], ['Marketing', 1180, 6.4, '2026-11-25'], ['Outros', 380.5, 2.1, null]],
    totais: true, destaques: [{ linha: 2, coluna: 3, tom: 'atencao' }], negrito: [1], fontes: [nubank, planilha] },
  comparativo: { tipo: 'comparativo', titulo: 'Plano A × Plano B', opcoes: [
    { nome: 'Plano A · anual', subtitulo: 'Pagamento único', valor: 11880, pros: ['2 meses grátis', 'Preço travado até 2027'], contras: ['Sai R$ 11,9 mil de uma vez'] },
    { nome: 'Plano B · mensal', subtitulo: '12 × R$ 1.190', valor: 14280, pros: ['Cancela quando quiser'], contras: ['R$ 2,4 mil a mais no ano', 'Reajuste em março'], recomendada: false },
  ], formato: 'moeda', fontes: [{ tipo: 'site', titulo: 'Proposta do fornecedor', url: 'https://www.exemplo.com.br/proposta' }] },
  versus: { tipo: 'versus', titulo: 'Reparo ou troca?', a: { rotulo: 'Reparo sem cartucho', valor: 2650, legenda: '66% do preço da nova' }, b: { rotulo: 'Reparo com cartucho', valor: 4950, legenda: '124% do preço da nova' },
    formato: 'moeda', melhor: 'a', pontas: ['Reparo básico', 'Reparo completo'], fontes: [{ tipo: 'documento', titulo: 'Orçamento da assistência.pdf' }] },
  placar: { tipo: 'placar', titulo: 'Veredito', itens: [{ rotulo: 'Potencial competitivo', nota: 9.3 }, { rotulo: 'Produto atualmente demonstrado', nota: 8.5 }, { rotulo: 'Prontidão para lançamento amplo', nota: 7.5 }], escala: 10, fontes: [calculo] },
  linha_do_tempo: { tipo: 'linha_do_tempo', titulo: 'Lançamento da rc.42', hoje: '2026-11-21', marcos: [
    { data: '2026-11-10', titulo: 'Escopo fechado', estado: 'feito' },
    { data: '2026-11-18', titulo: 'Salas em teste', detalhe: '2 bugs abertos', estado: 'atrasado' },
    { data: '2026-11-24', titulo: 'Blocos visuais', detalhe: 'prints e revisão', estado: 'em_dia' },
    { data: '2026-11-28', titulo: 'Homologação', estado: 'risco' },
    { data: '2026-12-02', titulo: 'Publicação', estado: 'previsto' },
  ], fontes: [asana] },
  progresso: { tipo: 'progresso', titulo: 'Metas do trimestre', itens: [
    { rotulo: 'Receita', atual: 128400, meta: 150000, formato: 'moeda', prazo: '2026-12-31' },
    { rotulo: 'Novos clientes', atual: 34, meta: 30, formato: 'inteiro' },
    { rotulo: 'NPS', atual: 61, meta: 70, formato: 'inteiro', prazo: '2026-12-15' },
  ], fontes: [planilha] },
  checklist: { tipo: 'checklist', titulo: 'Fechamento do mês', itens: [
    { texto: 'Conciliar o extrato', estado: 'feito' }, { texto: 'Emitir as notas de serviço', estado: 'feito' },
    { texto: 'Pagar fornecedores', estado: 'andamento' }, { texto: 'Enviar o DAS', estado: 'pendente' }, { texto: 'Relatório para o contador', estado: 'bloqueado' },
  ] },
  status: { tipo: 'status', titulo: 'Serviços', itens: [
    { rotulo: 'Site', estado: 'ok', detalhe: '99,98% no mês' }, { rotulo: 'Loja', estado: 'atencao', detalhe: 'lenta desde 14h' }, { rotulo: 'E-mail marketing', estado: 'erro', detalhe: 'domínio sem SPF' }, { rotulo: 'Backup', estado: 'parado' },
  ], fontes: [{ tipo: 'site', titulo: 'Painel de status', url: 'https://status.exemplo.com.br' }] },
  semaforo: { tipo: 'semaforo', titulo: 'Saúde dos projetos', itens: [
    { rotulo: 'Portal do cliente', cor: 'verde', detalhe: 'no prazo e no orçamento' }, { rotulo: 'App de vendas', cor: 'amarelo', detalhe: 'prazo apertado' }, { rotulo: 'Migração do ERP', cor: 'vermelho', detalhe: '3 semanas atrasado' },
  ], fontes: [asana] },
  pessoa: { tipo: 'pessoa', nome: 'Marina Albuquerque', cargo: 'Gerente de compras', empresa: 'Acelen', email: 'marina.albuquerque@acelen.com.br', telefone: '+55 71 3333-0101', site: 'https://www.acelen.com.br', local: 'Salvador, BA', tags: ['fornecedor', 'NF 27'] },
  aviso: { tipo: 'aviso', tom: 'risco', titulo: 'Atenção ao caixa', texto: 'Se a NF 27 não for reemitida até sexta, o pagamento de R$ 12.400 fica para dezembro e o caixa de novembro fecha negativo.' },
  galeria: { tipo: 'galeria', titulo: 'Fotos da vistoria', imagens: [
    { src: 'https://images.exemplo.com/vistoria-1.jpg', alt: 'Fachada do galpão', legenda: 'Fachada' },
    { src: 'https://images.exemplo.com/vistoria-2.jpg', alt: 'Telhado com infiltração', legenda: 'Telhado' },
    { src: 'https://images.exemplo.com/vistoria-3.jpg', alt: 'Quadro elétrico', legenda: 'Quadro elétrico' },
  ] },
  link: { tipo: 'link', url: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias', descricao: 'As notícias da Receita Federal sobre o calendário de obrigações de dezembro.' },
  arquivo: { tipo: 'arquivo', id: 'art_0123456789abcdef0123456789abcdef', titulo: 'Contrato de prestação de serviços.pdf' },
  mapa: { tipo: 'mapa', titulo: 'Reunião presencial', endereco: 'Av. Tancredo Neves, 1632 — Caminho das Árvores, Salvador, BA', lat: -12.98022, lng: -38.45431 },
  referencias: { tipo: 'referencias', titulo: 'De onde veio', itens: [
    { tipo: 'email', titulo: 'NF 27 recusada', url: 'https://outlook.office.com/owa/?ItemID=AAMk', id: null },
    { tipo: 'documento', titulo: 'Contrato Acelen 2026', url: 'https://docs.google.com/document/d/1x', id: null },
    { tipo: 'pr', titulo: 'PR #412 — salas', url: 'https://github.com/ergon/ergon/pull/412', id: null },
  ] },
  ficha: { tipo: 'ficha', titulo: 'JB PLATINUM DV-200N-250', subtitulo: 'Bomba rotativa de palhetas · Dois estágios', imagem: { src: 'https://images.exemplo.com/jb-platinum.jpg', alt: 'Bomba de vácuo JB Platinum' },
    linhas: [{ parametro: 'Vazão a 50 Hz', valor: '5,8 CFM (167 L/min)', destaque: true }, { parametro: 'Vazão a 60 Hz', valor: '7 CFM (≈200 L/min)' }, { parametro: 'Motor', valor: '1/2 HP (≈373 W mecânicos)' },
      { parametro: 'Alimentação', valor: '230 V/50 Hz ou 115 V/60 Hz' }, { parametro: 'Vácuo final', valor: '25 microns ou melhor', destaque: true }, { parametro: 'Rotação nominal', valor: '1.425/1.725 RPM' }],
    fontes: [manual, manualslib, { tipo: 'site', titulo: 'Catálogo do distribuidor', url: 'https://www.exemplo.com.br/jb' }] },
  medidor: { tipo: 'medidor', titulo: 'Satisfação no e-mail', rotulo: 'CSAT', valor: 78, formato: 'percentual', tendencia: 4, faixas: [{ ate: 60, tom: 'ruim', rotulo: 'ruim' }, { ate: 75, tom: 'ok', rotulo: 'ok' }, { ate: 100, tom: 'bom', rotulo: 'bom' }],
    lado: { numero: '78%', rotulo: 'satisfeitos', linhas: ['+4 p.p. desde outubro', 'Reclamação mais comum: prazo de resposta', '214 respostas'] }, fontes: [zendesk] },
  sparkline: { tipo: 'sparkline', titulo: 'Tempo de primeira resposta', rotulo: 'Horas, média semanal', serie: [9.2, 8.7, 8.9, 7.4, 6.8, 6.1, 5.2, 4.9], formato: 'numero', bom: 'baixa', fontes: [outlook] },
  icones: { tipo: 'icones', titulo: 'Clientes que renovariam', valor: 7, total: 10, icone: 'pessoa', rotulo: '7 de 10 clientes renovariam hoje', fontes: [zendesk] },
  funil: { tipo: 'funil', titulo: 'Funil de vendas de novembro', etapas: [{ rotulo: 'Visitantes', valor: 4200 }, { rotulo: 'Leads', valor: 860 }, { rotulo: 'Propostas', valor: 142 }, { rotulo: 'Fechados', valor: 37 }], formato: 'inteiro',
    fontes: [{ tipo: 'conexao', titulo: 'RD Station · funil', periodo: 'nov', url: 'https://app.rdstation.com.br' }] },
  calor: { tipo: 'calor', titulo: 'Quando chegam os e-mails', linhas: ['seg', 'ter', 'qua', 'qui', 'sex'], colunas: ['8h', '10h', '12h', '14h', '16h', '18h'],
    valores: [[42, 31, 12, 18, 22, 9], [28, 24, 10, 15, 19, 7], [25, 21, 9, 16, 17, 8], [23, 20, 11, 14, 16, 6], [19, 15, 8, 10, 9, 3]], formato: 'inteiro', fontes: [outlook] },
  enquete: { tipo: 'enquete', id: 'enq-fornecedor', titulo: 'Fornecedor do novo CRM', pergunta: 'Qual CRM a gente contrata?', opcoes: ['HubSpot Starter', 'Pipedrive Advanced', 'RD Station CRM'],
    votos: [{ opcao: 1, quem: 'Ana' }, { opcao: 1, quem: 'Bruno' }, { opcao: 0, quem: 'Carla' }, { opcao: 1, quem: 'Davi' }], eleitores: 5 },
  decisao: { tipo: 'decisao', escolha: 'Pipedrive Advanced', votos: 4, total: 5, porque: 'Melhor custo por usuário e integração nativa com o Outlook.', proximos: ['Bruno pede a proposta final até sexta', 'Aspásia migra os 1.240 contatos'] },
  matriz: { tipo: 'matriz', titulo: 'O que fazer primeiro', itens: [{ rotulo: 'Resposta automática', x: 2, y: 8 }, { rotulo: 'Novo site', x: 8, y: 7.5 }, { rotulo: 'Trocar o ERP', x: 9, y: 4 }, { rotulo: 'FAQ no e-mail', x: 3, y: 6.5 }, { rotulo: 'Logo nova', x: 4, y: 2 }],
    fontes: [sala] },
  fontes: { tipo: 'fontes', itens: [outlook, zendesk, nubank, planilha] },
  relatorio: { tipo: 'relatorio', id: 'rel-gastos-nov', versao: 2, titulo: 'Gastos de novembro', subtitulo: 'Até o dia 20', resumo: 'Os gastos caíram 8,2% em relação a outubro, puxados por software e marketing. A folha segue sendo mais da metade.',
    destaques: [
      { tipo: 'kpi', rotulo: 'Gastos', valor: 18420.5, formato: 'moeda', variacao: -8.2, comparacao: 'vs. out', bom: 'baixa', fontes: [nubank] },
      { tipo: 'pizza', titulo: 'Folha no total', fatias: [{ rotulo: 'Folha', valor: 9800 }, { rotulo: 'Resto', valor: 8620.5 }], formato: 'moeda', fontes: [nubank] },
    ],
    secoes: [
      { titulo: 'Por categoria', texto: 'Software caiu R$ 640 com o cancelamento de duas licenças sem uso.', blocos: [{ tipo: 'barras', categorias: ['Folha', 'Aluguel', 'Software', 'Marketing', 'Impostos'], series: [{ nome: 'Nov', valores: [9800, 4500, 1240, 1180, 1320] }], formato: 'moeda', fontes: [nubank] }] },
      { titulo: 'Próximos vencimentos', blocos: [{ tipo: 'linha_do_tempo', marcos: [{ data: '2026-11-25', titulo: 'Marketing', estado: 'em_dia' }, { data: '2026-11-30', titulo: 'Folha', estado: 'previsto' }], fontes: [planilha] }] },
    ], fontes: [nubank, planilha] },
};

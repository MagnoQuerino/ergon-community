// Galeria dos cartões (só desenvolvimento): respostas de exemplo no lugar do servidor, para os cartões de verdade
// (a conversa, "Aguardando você" e o card) desenharem sem conta nem equipe. Nada daqui vai para a versão publicada.
import type { Decisions, Message, Proposal } from '../lib/types.ts';

const AGORA = Date.parse('2026-11-12T14:00:00Z');
const em = (min: number) => new Date(AGORA + min * 60_000).toISOString();
const carga = (o: unknown) => JSON.stringify(o);

export const AGENTE = { id: 'ag1', name: 'Aristóteles', role: 'Coordenação', color: '#1F5B6B', sector_name: 'Coordenação', char_key: null };

const LONGO = 'Enviar o e-mail "Proposta revisada" para compras@exemplo.com pela conta do Outlook, com o anexo proposta-v3.pdf e a tabela de prazos no corpo da mensagem.';

const proposta = (id: string, kind: Proposal['kind'], summary: string, min: number, extra: Partial<Proposal> = {}): Proposal =>
  ({ id, conversation_id: 'c1', run_id: null, kind, summary, status: 'proposed', result: null, created_at: em(min), payload: null, ...extra });
const pedido = (need: string, extra: object = {}) => carga({ taskId: 't-aprovacao', number: 92, title: 'Relatório de vendas', need, agent: 'Hipátia', question: null, excerpt: 'O relatório ficou com 12 páginas e 3 gráficos.', ...extra });

/** Todos os tipos de cartão da conversa, em todos os estados. */
export const PROPOSTAS: Proposal[] = [
  proposta('p-info', 'info_request', 'Hipátia precisa de uma informação', 10, { payload: pedido('info', { question: 'Qual é o período do relatório?' }) }),
  proposta('p-aprov', 'info_request', 'Hipátia pede a sua aprovação', 11, { payload: pedido('approval') }),
  proposta('p-rev', 'info_request', 'Entrega para revisar', 12, { payload: pedido('review', { review: true, round: 2 }) }),
  proposta('p-retry', 'info_request', 'Não deu certo', 13, { payload: pedido('retry') }),
  proposta('p-info-ok', 'info_request', 'Respondido', 14, { status: 'applied', result: 'respondido', payload: pedido('info') }),
  proposta('q-um', 'question', 'Em que formato você quer a entrega?', 20, { payload: carga({ options: ['Planilha', 'Documento de texto', 'Apresentação com os gráficos principais'], pedido: 'x' }) }),
  proposta('q-varias', 'question', 'Quais canais entram no levantamento?', 21, { payload: carga({ options: ['E-mail', 'WhatsApp', 'Telefone'], multi: true }) }),
  proposta('q-simples', 'question', 'Posso começar hoje?', 22, { payload: carga({ options: ['Sim', 'Amanhã'] }) }),
  proposta('q-ok', 'question', 'Em que formato você quer a entrega?', 23, { status: 'applied', result: 'Planilha' }),
  proposta('s-chave', 'segredo', 'Chave pedida', 30, { payload: carga({ tipo: 'chave', nome: 'CHAVE_DO_CRM', motivo: 'Para ler os contatos do CRM.', agente: 'Hipátia' }) }),
  proposta('s-sudo', 'segredo', 'Senha de administrador', 31, { payload: carga({ tipo: 'sudo', motivo: 'Para instalar o leitor de planilhas neste computador.', agente: 'Hipátia' }) }),
  proposta('s-ok', 'segredo', 'Chave entregue', 32, { status: 'applied', result: 'CHAVE_DO_CRM', payload: carga({ tipo: 'chave', nome: 'CHAVE_DO_CRM' }) }),
  proposta('s-nao', 'segredo', 'Senha recusada', 33, { status: 'rejected', payload: carga({ tipo: 'sudo' }) }),
  proposta('perm', 'permission', 'Hipátia pede para rodar programas neste computador.', 40),
  proposta('perm-ok', 'permission', 'Rodar programas neste computador.', 41, { status: 'applied', result: null }),
  proposta('repasse', 'handoff', 'Hipátia pediu uma ferramenta protegida; a coordenação decide.', 42, { payload: carga({ coordinatorId: 'ag1', coordinator: 'Aristóteles', conversationId: 'c1' }) }),
  proposta('conexao', 'conexao', LONGO, 50),
  proposta('aprovacao', 'aprovacao', 'Rodar o comando que apaga a pasta de rascunhos antigos.', 51),
  proposta('prazo', 'depois_de_ler', 'Depois de ler a sua caixa de entrada, abrir o site do fornecedor.', 52),
  proposta('regra', 'regra', 'Podem mandar os e-mails de cobrança sem me pedir aprovação.', 53, { payload: carga({ alcance: '24h' }) }),
  proposta('setor', 'sector_new', 'Criar o setor "Atendimento" com Hipátia e Euclides.', 54),
  proposta('rotina', 'routine', 'Rotina nova: resumo das vendas toda segunda às 9 h.', 55),
  proposta('lote', 'batch', 'Abrir 4 cards do plano de lançamento.', 56),
  proposta('apagar', 'purge', 'Apagar de vez o card #81 e os arquivos dele.', 57),
  proposta('agente', 'create_agent', 'Criar a agente Teano para o atendimento.', 57.2),
  proposta('excluir', 'delete_task', 'Excluir o card #80 (repetido).', 57.4),
  proposta('rotina-edit', 'routine_edit', 'Ajustar a rotina: resumo das vendas às 8 h.', 57.6),
  proposta('feita', 'conexao', 'Enviar o e-mail de confirmação.', 58, { status: 'applied', result: 'enviado às 10h02' }),
  proposta('recusada', 'tools', 'Ligar a ferramenta de planilhas para Euclides.', 59, { status: 'rejected' }),
  proposta('falhou', 'conexao', 'Criar o evento na agenda.', 60, { status: 'failed', result: 'a agenda não respondeu' }),
];

const NOTA = ['Rotina "Resumo das vendas" acionada:', '09:00 começou', '09:01 leu a planilha', '09:02 montou o resumo', '09:03 pediu revisão', '09:05 entregou'].join('\n');
export const MENSAGENS: Message[] = [
  { id: 'm1', role: 'user', content: 'Preciso do relatório de vendas do mês e do resumo para a reunião.', mode: 'real', run_id: null, created_at: em(1), run_status: null },
  { id: 'm2', role: 'agent', content: 'Combinado. Abri dois cards e já volto com as entregas.', mode: 'real', run_id: 'r1', created_at: em(2), run_status: 'done', marked: 1 },
  { id: 'm3', role: 'system', content: NOTA, mode: 'local', run_id: null, created_at: em(3), run_status: null },
  { id: 'm4', role: 'agent', content: 'Aqui estão as entregas dos dois cards.', mode: 'real', run_id: 'r2', created_at: em(5), run_status: 'done',
    cards: [
      { id: 't-aprovacao', number: 92, title: 'Relatório de vendas', completed: 1, work_state: 'concluida', review_round: 1 },
      { id: 't-info', number: 93, title: 'Resumo para a reunião', completed: 0, work_state: 'aguardando_aprovacao', review_round: 2 },
      { id: 't-retry', number: 94, title: 'Gráficos', completed: 0, work_state: 'processamento', review_round: 1 },
    ] },
  { id: 'm5', role: 'system', content: 'Documentos — 3 arquivos movidos para "Vendas". {{desfazer:aud_0123456789abcdef0123456789abcdef}}', mode: 'local', run_id: null, created_at: em(6), run_status: null },
  { id: 'm6', role: 'user', content: 'E inclua a comparação com o mês passado.', mode: 'real', run_id: null, created_at: em(70), run_status: null },
  { id: 'm7', role: 'agent', content: 'Incluí a comparação: as vendas subiram 8% e o item mais vendido continua o mesmo.', mode: 'real', run_id: 'r3', created_at: em(72), run_status: 'done' },
  { id: 'm8', role: 'user', content: 'Depois veja também os custos.', mode: 'real', run_id: null, created_at: em(73), run_status: null, queued: 1 },
  { id: 'm9', role: 'system', content: 'Não deu certo desta vez: a conta de IA não respondeu.', mode: 'local', run_id: null, created_at: em(74), run_status: null },
];

export const DECISOES: Decisions = {
  cards: [
    { id: 't-info', number: 93, title: 'Resumo para a reunião', work_state: 'aguardando_info', agent_id: 'ag2', agent_name: 'Hipátia', updated_at: em(0), need: 'info', question: 'Qual é o período do resumo?', external: false, justification: null },
    { id: 't-aprovacao', number: 92, title: 'Relatório de vendas', work_state: 'aguardando_aprovacao', agent_id: 'ag2', agent_name: 'Hipátia', updated_at: em(0), need: 'approval', question: null, external: false, justification: null },
    { id: 't-revisao', number: 95, title: 'Proposta comercial', work_state: 'revisao', agent_id: 'ag3', agent_name: 'Euclides', updated_at: em(0), need: 'review', question: null, external: false, justification: 'A revisão parou em 3 rodadas.' },
  ],
  proposals: [
    { id: 'd-rotina', kind: 'routine', summary: 'Vi que você pede o resumo toda segunda.\nRotina nova: resumo das vendas toda segunda às 9 h.', created_at: em(1), conversation_id: 'c1', agent_id: 'ag1', agent_name: 'Aristóteles', purpose: 'routine-recommend' },
    { id: 'd-conexao', kind: 'conexao', summary: LONGO, created_at: em(2), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null, task_id: 't-contas', task_number: 96 },
    { id: 'd-aprovacao', kind: 'aprovacao', summary: 'Rodar o comando que apaga a pasta de rascunhos antigos.', created_at: em(3), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null },
    { id: 'd-prazo', kind: 'depois_de_ler', summary: 'Depois de ler a sua caixa de entrada, abrir o site do fornecedor.', created_at: em(4), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null },
    { id: 'd-regra', kind: 'regra', summary: 'Podem mandar os e-mails de cobrança sem me pedir aprovação.', payload: carga({ alcance: 'sempre' }), created_at: em(5), conversation_id: null, agent_id: null, agent_name: 'Hipátia', purpose: null },
    { id: 'd-pergunta', kind: 'question', summary: 'Em que formato você quer a entrega?', created_at: em(6), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null },
    { id: 'd-segredo', kind: 'segredo', summary: 'Hipátia pede a chave CHAVE_DO_CRM.', created_at: em(7), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null },
    { id: 'd-perm', kind: 'permission', summary: 'Hipátia pede para rodar programas neste computador.', created_at: em(8), conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', purpose: null },
    { id: 'd-purge', kind: 'purge', summary: 'Apagar de vez o card #81 e os arquivos dele.', created_at: em(9.5), conversation_id: 'c1', agent_id: 'ag1', agent_name: 'Aristóteles', purpose: null },
    { id: 'd-rotina-edit', kind: 'routine_edit', summary: 'Ajustar a rotina: resumo das vendas às 8 h.', created_at: em(1.5), conversation_id: 'c1', agent_id: 'ag1', agent_name: 'Aristóteles', purpose: null },
    { id: 'd-setor', kind: 'sector_new', summary: 'Criar o setor "Atendimento" com Hipátia e Euclides.', created_at: em(9), conversation_id: 'c1', agent_id: 'ag1', agent_name: 'Aristóteles', purpose: null },
  ],
  waiting: [{ id: 'w1', conversation_id: 'c1', agent_id: 'ag2', agent_name: 'Hipátia', created_at: em(10) }],
  linkList: [{ id: 'l1', task_id: 't-aprovacao', number: 92, title: 'Relatório de vendas', related_number: 77, related_title: 'Relatório mensal', reason: 'mesmo assunto e mesma pessoa' }],
  ruleList: [{ id: 'rg1', text: 'Sempre responder os clientes em até um dia.', created_at: em(11) }],
  total: 15, links: 1, rules: 1,
  refusedRoutines: [{ id: 'rr1', summary: 'Rotina nova: lembrete de aniversários toda sexta.', decided_at: em(12) }],
};

type Ficha = Record<string, unknown>;
const trabalho = (state: string, extra: Ficha = {}) => ({ state, label: '', kind: 'documental', kindLabel: 'Documento', requiresApproval: true, result: { id: 'res1', state, kind: 'documental', justification: 'A conta de IA não respondeu a tempo.', criteria: [], decidedBy: 'sistema', decidedAt: null, deliverables: [], mode: 'real' }, ...extra });
const card = (id: string, number: number, title: string, extra: Ficha): Ficha => ({
  task: { id, number, title, title_source: 'equipe', description: 'Montar o relatório com os números do mês.', completed: 0, completed_by: null, completed_at: null, column_id: 'col1', agent_id: 'ag2', origin: 'chat', is_fixture: 0, revision: 1, board_id: 'b1', external_assignee: null, parent_task_id: null, due_on: null },
  log: [], link: null, proposals: [], source: null, runs: [], review: null, files: { inputs: [], deliverables: [] }, work: null, resumo: null, queue: null, column: 'Com você',
  board: { audience: 'team', origin: 'native', source: null }, steps: [], question: null, missing: null, origin: null, children: [],
  agents: { ag1: { name: 'Aristóteles', color: '#1F5B6B' }, ag2: { name: 'Hipátia', color: '#B88B5B' } }, reviewer: null, conexoes: [], cartoes: [], ...extra,
});
const faixa = (tom: string, texto: string, titulo: string, frase: string) => ({ situacao: { tom, texto }, faixa: { titulo, frase, itens: [], doAgente: null } });

/** O card aberto em cada situação que tem botões. */
export const CARDS: Record<string, Ficha> = {
  't-aprovacao': card('t-aprovacao', 92, 'Relatório de vendas', { work: trabalho('aguardando_aprovacao'), resumo: faixa('decidir', 'Com você', 'Para você decidir', 'Aprovar o relatório de vendas de outubro?') }),
  't-info': card('t-info', 93, 'Resumo para a reunião', { work: trabalho('aguardando_info'), question: 'Qual é o período do resumo?', resumo: faixa('precisa', 'Precisa de você', 'Hipátia pergunta', 'Qual é o período do resumo?') }),
  't-retry': card('t-retry', 94, 'Gráficos', { work: trabalho('falha'), resumo: faixa('falhou', 'Não deu certo', 'O que aconteceu', 'A conta de IA não respondeu a tempo.') }),
  't-revisao': card('t-revisao', 95, 'Proposta comercial', { work: trabalho('revisao'), resumo: faixa('decidir', 'Com você', 'Para você decidir', 'A revisão parou em 3 rodadas. Aprovar assim mesmo?') }),
  't-contas': card('t-contas', 96, 'Avisar os clientes', {
    work: trabalho('aguardando_aprovacao'), resumo: faixa('decidir', 'Com você', 'Para você decidir', 'Enviar 2 e-mails pela conta do Outlook?'),
    conexoes: [
      { id: 'cx1', kind: 'conexao', summary: LONGO, created_at: em(1) },
      { id: 'cx2', kind: 'conexao', summary: 'Enviar o e-mail "Novo prazo" para vendas@exemplo.com.', created_at: em(2) },
      { id: 'cx3', kind: 'depois_de_ler', summary: 'Depois de ler a sua caixa de entrada, abrir o site do fornecedor.', created_at: em(3) },
    ],
    cartoes: [PROPOSTAS.find((p) => p.id === 'q-um'), PROPOSTAS.find((p) => p.id === 's-chave')],
  }),
  't-prazo': card('t-prazo', 97, 'Conferir o fornecedor', {
    work: trabalho('aguardando_aprovacao'), resumo: faixa('decidir', 'Com você', 'Para você decidir', 'Depois de ler a sua caixa de entrada, abrir o site do fornecedor?'),
    conexoes: [{ id: 'cx4', kind: 'depois_de_ler', summary: 'Depois de ler a sua caixa de entrada, abrir o site do fornecedor.', created_at: em(1) }],
  }),
  't-comando': card('t-comando', 98, 'Limpar os rascunhos', {
    work: trabalho('aguardando_aprovacao'), resumo: faixa('decidir', 'Com você', 'Para você decidir', 'Rodar o comando que apaga a pasta de rascunhos antigos?'),
    conexoes: [{ id: 'cx5', kind: 'aprovacao', summary: 'Rodar o comando que apaga a pasta de rascunhos antigos.', created_at: em(1) }],
  }),
};

const ROTAS: Array<[RegExp, (m: RegExpMatchArray) => unknown]> = [
  [/^\/api\/conversations\?agentId=/, () => [{ id: 'c1', agent_id: 'ag1', title: 'Relatório de vendas', created_at: em(0), last_at: em(74) }]],
  [/^\/api\/conversations\/c1\/messages/, () => MENSAGENS],
  [/^\/api\/conversations\/c1\/cards/, () => []],
  [/^\/api\/proposals\?conversationId=/, () => PROPOSTAS],
  [/^\/api\/ai\/status/, () => ({ executor: 'simulated', available: true, accounts: [], default: { provider: null, model: null, label: '', billing: 'gratis' } })],
  [/^\/api\/recursos/, () => ({ checkpoints: false, codigoInseguro: false, limpeza: false, buscaFerramentas: false, conectores: [], voz: { transcrever: null, falar: 'local' }, navegador: { chromium: false, pronto: false }, escrita: [] })],
  [/^\/api\/decisions/, () => DECISOES],
  [/^\/api\/tasks\/([\w-]+)$/, (m) => CARDS[m[1]] ?? null],
  [/^\/api\/comandos/, () => ({ ativos: [], recentes: [] })],
];

export interface Registro { posts: Array<{ url: string; corpo: unknown }>; desconhecidas: string[] }

/**
 * Troca o fetch da página pelas respostas de exemplo. `pendentes`: os envios nunca terminam, para o estado "enviando"
 * ficar na tela; senão respondem em 150 ms. Cada envio fica anotado no registro (a medição confere que o segundo
 * clique não envia de novo).
 */
export function simularServidor(pendentes: boolean): Registro {
  const reg: Registro = { posts: [], desconhecidas: [] };
  const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (alvo: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(typeof alvo === 'string' || alvo instanceof URL ? alvo : alvo.url).replace(location.origin, '');
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo !== 'GET') {
      if (/\/read$/.test(url)) return json({});
      let corpo: unknown = null;
      try { corpo = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { /* corpo que não é JSON */ }
      reg.posts.push({ url, corpo });
      if (pendentes) return new Promise<Response>(() => { /* fica "enviando" */ });
      await new Promise((r) => setTimeout(r, 150));
      return json({ status: 'applied', result: '' });
    }
    for (const [re, resposta] of ROTAS) { const m = url.match(re); if (m) { const r = resposta(m); return r === null ? json({ error: 'not_found' }, 404) : json(r); } }
    reg.desconhecidas.push(url);
    return json({});
  };
  return reg;
}

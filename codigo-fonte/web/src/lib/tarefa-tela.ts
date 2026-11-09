// Textos e regras da tela "Detalhes da tarefa", fora do componente para o teste (tarefa-tela.test.ts) conferir: o
// histórico em linhas curtas (a resposta inteira só com "ver mais"), "Como foi conferido" em palavras de todo dia, e o
// que cada arquivo mostra no "Ver" (o resto só baixa). Nada de jargão: a pessoa bate o olho e decide.

/** Rótulo curto de cada linha do histórico. */
export const ACTION_LABEL: Record<string, string> = {
  'task.create': 'Card criado', 'task.update': 'Card alterado', 'task.delegate': 'Pedido a um agente', 'task.completion_reported': 'Conclusão informada (aguarda confirmação)',
  'source.edited': 'Mensagem de origem editada', 'mirror.task.import': 'Veio do aplicativo de origem', 'mirror.task.update': 'Atualizado pelo aplicativo de origem',
  'mirror.task.missing': 'Não apareceu na última leitura', 'mirror.push': 'Enviado ao aplicativo', 'mirror.push.error': 'Não foi ao aplicativo', 'link.confirmed': 'Vínculo confirmado', 'link.rejected': 'Vínculo rejeitado', 'link.revert': 'Vínculo revertido',
  'agent.result.succeeded': 'Entrega', 'agent.result.failed': 'Não conseguiu', 'agent.result.cancelled': 'Trabalho parado',
  'task.route': 'Encaminhado pela coordenação', 'task.reassign': 'Redistribuído pela coordenação', 'task.handoff': 'Pedido de ajuda',
  'task.help_result': 'Ajuda recebida', 'task.queue_start': 'Começou a trabalhar', 'review.start': 'Revisão pedida',
  'review.approved': 'Revisão: entrega razoável', 'review.limit': 'Revisão: limite de rodadas', 'review.stopped': 'Revisão interrompida',
  'task.result': 'Conferência', 'task.work_state': 'Situação', 'operation.run': 'Análise feita pelo sistema', 'operation.refused': 'Análise recusada',
  'task.waiting_help': 'Aguardando colegas', 'task.queue': 'Ordem da fila', 'task.requires_approval': 'Aprovação', 'agent.tools': 'Ferramentas do agente',
  'task.plan': 'Plano da coordenação', 'task.step_done': 'Etapa entregue', 'task.delivery': 'Entrega na conversa', 'task.deleted': 'Card apagado', 'task.cancelled': 'Card cancelado', 'task.help_not_done': 'Ajuda não veio',
  'task.conexao': 'Sua decisão num cartão', 'task.title': 'Título alterado', 'task.title_kept': 'Título mantido (o seu)', 'task.title_refused': 'Título sugerido não aplicado',
  'task.persist': 'A equipe tentou de novo', 'task.persist_decision': 'Decisão da equipe', 'task.persist_exhausted': 'A equipe não resolveu: com você',
  'task.help_step': 'Colega entrou numa etapa', 'task.review_round': 'Nova versão pedida', 'conexao.pessoa': 'Só você resolve',
  // a ação numa conta foi direto, sem cartão, pela regra que você aprovou (Conexões › Regras)
  'task.regra': 'Liberado pela sua regra',
};
/** ações cujo resultado (texto) explica o que aconteceu: entram no "ver mais" da linha */
const SHOW_RESULT = new Set(['task.queue', 'task.route', 'task.reassign', 'task.handoff', 'task.help_result', 'task.result', 'task.work_state', 'operation.run', 'operation.refused', 'task.waiting_help',
  'task.queue_start', 'task.requires_approval', 'task.plan', 'task.step_done', 'task.delivery', 'task.deleted', 'task.cancelled', 'task.help_not_done', 'mirror.push.error', 'task.conexao',
  'task.persist', 'task.persist_decision', 'task.persist_exhausted', 'task.help_step', 'task.review_round', 'conexao.pessoa', 'task.update', 'task.title', 'task.title_kept', 'task.title_refused', 'task.regra']);
/** a entrega do agente: a linha diz quem entregou; o texto inteiro, só com "ver mais" */
const ENTREGA = new Set(['agent.result.succeeded', 'task.help_result', 'task.step_done']);

export interface LogRow { id: string; actor_type: string; actor_id: string | null; action: string; evidence: string | null; result: string; created_at: string }
export interface LinhaHistorico { titulo: string; quem: string; resumo: string | null; detalhe: string | null; saida: string | null; erro: string | null }

/** linhas de controle ([[...]]) fora do texto que a pessoa lê */
const semControle = (s: string) => s.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]\s*/g, '').trim();
const primeira = (s: string, max = 90) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`; };

/**
 * Uma linha do histórico, curta: "Aspásia entregou", "Card criado", "Começou a trabalhar". O texto que explica e a
 * resposta inteira do agente ficam para o "ver mais" (detalhe, saída, erro).
 */
export function linhaDoHistorico(e: LogRow, nomeDe: (id: string | null) => string | null, revisor?: string | null): LinhaHistorico {
  let ev: Record<string, unknown> = {};
  try { ev = e.evidence ? (JSON.parse(e.evidence) as Record<string, unknown>) : {}; } catch { ev = {}; }
  const agente = e.actor_type === 'agent' ? nomeDe(e.actor_id) : null;
  const quem = agente ?? (e.actor_type === 'user' ? 'você' : e.actor_type === 'connector' ? 'aplicativo' : 'sistema');
  const saida = typeof ev.output === 'string' && ev.output.trim() ? semControle(ev.output) : null;
  const pedido = typeof ev.request === 'string' && ev.request.trim() ? ev.request.trim() : null;
  const erro = typeof ev.error === 'string' && ev.error ? ev.error : null;
  let titulo = ACTION_LABEL[e.action] ?? 'Registro';
  if (typeof ev.reviewStep === 'string' && ev.reviewStep) titulo = ev.reviewStep === 'questions' ? `${agente ?? revisor ?? 'A revisão'} perguntou` : `${agente ?? 'Quem fez'} respondeu`;
  else if (ENTREGA.has(e.action)) titulo = `${agente ?? (typeof ev.from === 'string' ? ev.from : 'O agente')} entregou`;
  else if (e.action === 'agent.result.failed') titulo = `${agente ?? 'O agente'} não conseguiu`;
  else if (e.action === 'task.queue_start') titulo = agente ? `${agente} começou a trabalhar` : 'Começou a trabalhar';
  else if (e.action === 'task.work_state' && e.result) titulo = `Situação: ${e.result.split(' — ')[0].toLowerCase()}`;
  const texto = SHOW_RESULT.has(e.action) && e.result && e.action !== 'task.work_state' ? e.result : null;
  const nota = e.action === 'task.work_state' && e.result.includes(' — ') ? e.result.split(' — ').slice(1).join(' — ') : null;
  const detalhe = [texto ?? nota, pedido].filter(Boolean).join('\n\n') || null;
  // a linha curta já diz o essencial; o resumo de uma linha ajuda quando não há a resposta inteira
  return { titulo, quem: agente ? '' : quem, resumo: !saida && detalhe ? primeira(detalhe) : null, detalhe, saida, erro };
}

// ------------------------------------------------------------------------------------------- Como foi conferido

/** cada ponto da conferência em palavras de todo dia (o servidor guarda o rótulo técnico) */
const CRITERIO: Record<string, string> = {
  execucao: 'O trabalho terminou sem erro', modelo: 'Escrito pelo agente com a conta de IA', conteudo: 'A entrega está completa (não é só um resumo)',
  alegacao: 'Não é só um “pronto”', pendencias: 'Nada ficou pendente', conexao: 'Feito na conta, com a confirmação do aplicativo',
  entregavel: 'Documento salvo no card', operacao: 'Números calculados pelo sistema a partir do arquivo', confirmacao: 'A sua confirmação de que foi feito',
  humano: 'Aprovado por você', declaracao: 'O agente não disse que deixou de fazer', entrada: 'O arquivo necessário está no card',
};
/** detalhe que só ajuda quando o ponto não passou (o nome do modelo, a contagem de palavras) */
const DETALHE_SO_SE_FALHOU = new Set(['modelo', 'conteudo', 'execucao']);

export function criterioSimples(c: { id: string; label: string; ok: boolean; detail?: string }): { texto: string; detalhe: string | null } {
  const detalhe = c.detail && (!c.ok || !DETALHE_SO_SE_FALHOU.has(c.id)) ? c.detail : null;
  return { texto: CRITERIO[c.id] ?? c.label, detalhe };
}

/** A justificativa da conferência sem o jargão ("Concluída com evidência: 5 critérios atendidos"). */
export function justificativaSimples(j: string | null | undefined): string {
  const t = (j ?? '').trim();
  if (/^Concluída com evidência: \d+ critérios atendidos/.test(t)) {
    const n = /(\d+) entregável\(is\)/.exec(t)?.[1];
    return `Tudo o que a conferência pede foi atendido${n ? `; ${n === '1' ? 'o arquivo entregue está' : `os ${n} arquivos entregues estão`} no card` : ''}.`;
  }
  return t.replace(/^Concluída com evidência:\s*/, 'Feito, com a confirmação: ').replace(/\bentregável\(is\)/g, 'arquivo(s)');
}

// ------------------------------------------------------------------------------------------- Ver um arquivo

export type Previa = 'markdown' | 'texto' | 'tabela' | 'imagem' | 'pdf' | 'baixar';
const IMAGEM = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/**
 * O que o "Ver" mostra, por cima da tarefa: texto formatado (.md), texto, tabela (.csv), imagem e PDF (o leitor do
 * próprio navegador). Word, Excel, apresentação e o resto: só baixar. O conteúdo vem da rota de arquivos (com o seu
 * acesso), e nada do arquivo vira HTML executado: o texto é texto, o .md passa pelo Markdown seguro.
 */
export function previaDe(filename: string, mime: string): Previa {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
  if (IMAGEM.has(mime)) return 'imagem';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (mime === 'text/csv' || ext === 'csv') return 'tabela';
  if (['text/plain', 'application/json', 'text/vtt'].includes(mime) || ['txt', 'json', 'log', 'vtt'].includes(ext)) return 'texto';
  return 'baixar';
}

/** Situação → cor da etiqueta e da faixa (o servidor manda o tom, resumo-tarefa.ts). */
export const TOM: Record<string, string> = { decidir: 'decidir', precisa: 'precisa', trabalhando: 'trabalhando', fila: 'fila', feito: 'feito', falhou: 'falhou' };
export const tomDe = (t: string | null | undefined): string => TOM[t ?? ''] ?? 'fila';

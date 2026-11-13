// Textos e regras da tela "Detalhes da tarefa", fora do componente para o teste (tarefa-tela.test.ts) conferir: o
// histórico em linhas curtas (a resposta inteira só com "ver mais"), "Como foi conferido" em palavras de todo dia, e o
// que cada arquivo mostra no "Ver" (o resto só baixa). Nada de jargão: a pessoa bate o olho e decide. Os textos vêm do
// dicionário da área "tarefa" (i18n/pt/tarefa.ts e i18n/en/tarefa.ts), no idioma da tela.
import { t, type Chave, type ValoresDe } from '../i18n/index.ts';

/** As chaves da área sem marcador ({nome}): as que uma tabela de rótulos guarda e t() mostra sem valores. */
export type ChaveSimples = { [K in Extract<Chave, `tarefa.${string}`>]: [keyof ValoresDe<K>] extends [never] ? K : never }[Extract<Chave, `tarefa.${string}`>];

/** Rótulo curto de cada linha do histórico: a chave do dicionário (o texto sai no idioma da tela). */
export const ACTION_LABEL: Record<string, ChaveSimples> = {
  'task.create': 'tarefa.acao.cardCriado', 'task.update': 'tarefa.acao.cardAlterado', 'task.delegate': 'tarefa.acao.pedidoAUmAgente', 'task.completion_reported': 'tarefa.acao.conclusaoInformada',
  'source.edited': 'tarefa.acao.origemEditada', 'mirror.task.import': 'tarefa.acao.veioDoAplicativo', 'mirror.task.update': 'tarefa.acao.atualizadoPeloAplicativo',
  'mirror.task.missing': 'tarefa.acao.naoApareceu', 'mirror.push': 'tarefa.acao.enviadoAoAplicativo', 'mirror.push.error': 'tarefa.acao.naoFoiAoAplicativo',
  'link.confirmed': 'tarefa.acao.vinculoConfirmado', 'link.rejected': 'tarefa.acao.vinculoRejeitado', 'link.revert': 'tarefa.acao.vinculoRevertido',
  'agent.result.succeeded': 'tarefa.acao.entrega', 'agent.result.failed': 'tarefa.acao.naoConseguiu', 'agent.result.cancelled': 'tarefa.acao.trabalhoParado',
  'task.route': 'tarefa.acao.encaminhado', 'task.reassign': 'tarefa.acao.redistribuido', 'task.handoff': 'tarefa.acao.pedidoDeAjuda',
  'task.help_result': 'tarefa.acao.ajudaRecebida', 'task.queue_start': 'tarefa.acao.comecouATrabalhar', 'review.start': 'tarefa.acao.revisaoPedida',
  'review.approved': 'tarefa.acao.revisaoRazoavel', 'review.limit': 'tarefa.acao.revisaoLimite', 'review.stopped': 'tarefa.acao.revisaoInterrompida',
  'task.result': 'tarefa.acao.conferencia', 'task.work_state': 'tarefa.acao.situacao', 'operation.run': 'tarefa.acao.analiseFeita', 'operation.refused': 'tarefa.acao.analiseRecusada',
  'task.waiting_help': 'tarefa.acao.aguardandoColegas', 'task.queue': 'tarefa.acao.ordemDaFila', 'task.requires_approval': 'tarefa.acao.aprovacao', 'agent.tools': 'tarefa.acao.ferramentas',
  'task.plan': 'tarefa.acao.plano', 'task.step_done': 'tarefa.acao.etapaEntregue', 'task.delivery': 'tarefa.acao.entregaNaConversa', 'task.deleted': 'tarefa.acao.cardApagado',
  'task.cancelled': 'tarefa.acao.cardCancelado', 'task.help_not_done': 'tarefa.acao.ajudaNaoVeio',
  'task.conexao': 'tarefa.acao.decisaoNumCartao', 'task.title': 'tarefa.acao.tituloAlterado', 'task.title_kept': 'tarefa.acao.tituloMantido', 'task.title_refused': 'tarefa.acao.tituloNaoAplicado',
  'task.persist': 'tarefa.acao.tentouDeNovo', 'task.persist_decision': 'tarefa.acao.decisaoDaEquipe', 'task.persist_exhausted': 'tarefa.acao.equipeNaoResolveu',
  'task.help_step': 'tarefa.acao.colegaNumaEtapa', 'task.review_round': 'tarefa.acao.novaVersao', 'conexao.pessoa': 'tarefa.acao.soVoceResolve',
  // a ação numa conta foi direto, sem cartão, pela regra que você aprovou (Conexões › Regras)
  'task.regra': 'tarefa.acao.liberadoPelaRegra',
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
const primeira = (s: string, max = 90) => { const x = s.replace(/\s+/g, ' ').trim(); return x.length <= max ? x : `${x.slice(0, max - 1).replace(/\s+\S*$/, '')}…`; };

/**
 * Uma linha do histórico, curta: "Aspásia entregou", "Card criado", "Começou a trabalhar". O texto que explica e a
 * resposta inteira do agente ficam para o "ver mais" (detalhe, saída, erro).
 */
export function linhaDoHistorico(e: LogRow, nomeDe: (id: string | null) => string | null, revisor?: string | null): LinhaHistorico {
  let ev: Record<string, unknown> = {};
  try { ev = e.evidence ? (JSON.parse(e.evidence) as Record<string, unknown>) : {}; } catch { ev = {}; }
  const agente = e.actor_type === 'agent' ? nomeDe(e.actor_id) : null;
  const quem = agente ?? t(e.actor_type === 'user' ? 'tarefa.nomes.voce' : e.actor_type === 'connector' ? 'tarefa.nomes.aplicativo' : 'tarefa.nomes.sistema');
  const saida = typeof ev.output === 'string' && ev.output.trim() ? semControle(ev.output) : null;
  const pedido = typeof ev.request === 'string' && ev.request.trim() ? ev.request.trim() : null;
  const erro = typeof ev.error === 'string' && ev.error ? ev.error : null;
  const rotulo = ACTION_LABEL[e.action];
  let titulo = t(rotulo ?? 'tarefa.historico.registro');
  if (typeof ev.reviewStep === 'string' && ev.reviewStep) {
    titulo = ev.reviewStep === 'questions'
      ? t('tarefa.historico.perguntou', { nome: agente ?? revisor ?? t('tarefa.nomes.aRevisao') })
      : t('tarefa.historico.respondeu', { nome: agente ?? t('tarefa.nomes.quemFezInicio') });
  } else if (ENTREGA.has(e.action)) titulo = t('tarefa.historico.entregou', { nome: agente ?? (typeof ev.from === 'string' ? ev.from : t('tarefa.nomes.oAgente')) });
  else if (e.action === 'agent.result.failed') titulo = t('tarefa.historico.naoConseguiu', { nome: agente ?? t('tarefa.nomes.oAgente') });
  else if (e.action === 'task.queue_start' && agente) titulo = t('tarefa.historico.comecouATrabalhar', { nome: agente });
  // a situação vem do servidor ("Em processamento — pegou da fila"): a parte antes do travessão, em minúscula
  else if (e.action === 'task.work_state' && e.result) titulo = t('tarefa.historico.situacao', { estado: e.result.split(' — ')[0].toLowerCase() });
  const texto = SHOW_RESULT.has(e.action) && e.result && e.action !== 'task.work_state' ? e.result : null;
  const nota = e.action === 'task.work_state' && e.result.includes(' — ') ? e.result.split(' — ').slice(1).join(' — ') : null;
  const detalhe = [texto ?? nota, pedido].filter(Boolean).join('\n\n') || null;
  // a linha curta já diz o essencial; o resumo de uma linha ajuda quando não há a resposta inteira
  return { titulo, quem: agente ? '' : quem, resumo: !saida && detalhe ? primeira(detalhe) : null, detalhe, saida, erro };
}

// ------------------------------------------------------------------------------------------- Como foi conferido

/** cada ponto da conferência em palavras de todo dia (o servidor guarda o rótulo técnico) */
const CRITERIO: Record<string, ChaveSimples> = {
  execucao: 'tarefa.criterio.execucao', modelo: 'tarefa.criterio.modelo', conteudo: 'tarefa.criterio.conteudo',
  alegacao: 'tarefa.criterio.alegacao', pendencias: 'tarefa.criterio.pendencias', conexao: 'tarefa.criterio.conexao',
  entregavel: 'tarefa.criterio.entregavel', operacao: 'tarefa.criterio.operacao', confirmacao: 'tarefa.criterio.confirmacao',
  humano: 'tarefa.criterio.humano', declaracao: 'tarefa.criterio.declaracao', entrada: 'tarefa.criterio.entrada',
};
/** detalhe que só ajuda quando o ponto não passou (o nome do modelo, a contagem de palavras) */
const DETALHE_SO_SE_FALHOU = new Set(['modelo', 'conteudo', 'execucao']);

export function criterioSimples(c: { id: string; label: string; ok: boolean; detail?: string }): { texto: string; detalhe: string | null } {
  const detalhe = c.detail && (!c.ok || !DETALHE_SO_SE_FALHOU.has(c.id)) ? c.detail : null;
  const chave = CRITERIO[c.id];
  return { texto: chave ? t(chave) : c.label, detalhe };
}

/** A situação da conferência (o estado que o servidor guarda), com a primeira letra maiúscula. */
const ESTADO_DA_CONFERENCIA: Record<string, ChaveSimples> = {
  validado: 'tarefa.conferido.estado.validado', reprovado: 'tarefa.conferido.estado.reprovado', aguardando_aprovacao: 'tarefa.conferido.estado.aguardando_aprovacao',
  aguardando_info: 'tarefa.conferido.estado.aguardando_info', sem_confirmacao: 'tarefa.conferido.estado.sem_confirmacao', falha: 'tarefa.conferido.estado.falha',
  confirmado_humano: 'tarefa.conferido.estado.confirmado_humano', devolvido: 'tarefa.conferido.estado.devolvido', descartado: 'tarefa.conferido.estado.descartado',
};
export const estadoDaConferencia = (estado: string): string => t(ESTADO_DA_CONFERENCIA[estado] ?? 'tarefa.conferido.estado.conferido');

/** A justificativa da conferência sem o jargão ("Concluída com evidência: 5 critérios atendidos"). */
export function justificativaSimples(j: string | null | undefined): string {
  const s = (j ?? '').trim();
  // o servidor escreve a justificativa em português: estes padrões só a reconhecem
  if (/^Concluída com evidência: \d+ critérios atendidos/.test(s)) {
    const n = /(\d+) entregável\(is\)/.exec(s)?.[1];
    return n ? t('tarefa.conferido.tudoAtendidoArquivos', { n: Number(n) }) : t('tarefa.conferido.tudoAtendido');
  }
  const resto = s.replace(/\bentregável\(is\)/g, 'arquivo(s)'); // i18n-ok: troca a palavra dentro do texto em português que o servidor manda
  const prefixo = /^Concluída com evidência:\s*/;
  return prefixo.test(resto) ? t('tarefa.conferido.feitoComConfirmacao', { resto: resto.replace(prefixo, '') }) : resto;
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
// i18n-ok: os tons são nomes de classe (tdet__sit--feito), não texto de tela
const TOM: Record<string, string> = { decidir: 'decidir', precisa: 'precisa', trabalhando: 'trabalhando', fila: 'fila', feito: 'feito', falhou: 'falhou' };
export const tomDe = (x: string | null | undefined): string => TOM[x ?? ''] ?? 'fila';

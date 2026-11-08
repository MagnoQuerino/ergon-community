/**
 * Ações de tarefas, iguais para todos os aplicativos: o agente diz "tarefa.criar" no Asana, no Planner ou no Trello com os
 * mesmos parâmetros. Quadro, coluna e tarefa podem vir pelo nome: acha aqui e, havendo dúvida, pergunta com as opções.
 */
import { fold } from '../../lib/util.ts';
import { neutral } from '../operations.ts';
import type { BoardSnapshot, TaskProvider } from '../mirror.ts';
import { ErroAcao, dia, num, precisa, txt, type Acao, type Args, type CtxAcao, type EscritorTarefas, type MudancaTarefa, type Resultado } from './tipos.ts';

/** O que as ações de tarefa precisam além da chamada autenticada. */
export interface CtxTarefas extends CtxAcao {
  provedor: TaskProvider; escritor: EscritorTarefas | null;
  /** o quadro escrito está espelhado no Ergon: atualiza sem esperar a próxima leitura */
  aoEscrever?(quadro: string): Promise<void>;
}
const ct = (c: CtxAcao): CtxTarefas => {
  const x = c as CtxTarefas;
  if (!x.provedor) throw new ErroAcao('esta conexão não tem tarefas');
  return x;
};
const escritor = (c: CtxTarefas): EscritorTarefas => {
  if (!c.escritor) throw new ErroAcao('este aplicativo ainda não aceita escrita pelo Ergon');
  return c.escritor;
};

async function quadroDe(c: CtxTarefas, a: Args): Promise<{ id: string; nome: string }> {
  const quero = txt(a, 'quadro', 300)?.trim();
  const todos = await c.provedor.listBoards();
  if (!todos.length) throw new ErroAcao('esta conta não tem nenhum quadro ou lista visível');
  const nomes = todos.map((b) => neutral(b.name, 80));
  if (!quero) {
    if (todos.length === 1) return { id: todos[0].externalId, nome: todos[0].name };
    throw new ErroAcao('em qual quadro ou lista? Pergunte à pessoa, se o pedido não disser', nomes);
  }
  // o id fixado pelo cartão vale antes de qualquer nome parecido
  const porId = todos.find((b) => b.externalId === quero);
  if (porId) return { id: porId.externalId, nome: porId.name };
  const f = fold(quero);
  const certo = todos.filter((b) => fold(b.name) === f);
  const parecido = certo.length ? certo : todos.filter((b) => fold(b.name).includes(f));
  if (parecido.length === 1) return { id: parecido[0].externalId, nome: parecido[0].name };
  throw new ErroAcao(parecido.length ? `mais de um quadro parecido com "${neutral(quero, 60)}"` : `não achei o quadro "${neutral(quero, 60)}"`, (parecido.length ? parecido : todos).map((b) => neutral(b.name, 80)));
}

function colunaDe(snap: BoardSnapshot, quero: string): { id: string; nome: string } {
  const porId = snap.columns.find((x) => x.externalId === quero);
  if (porId) return { id: porId.externalId, nome: porId.name };
  const f = fold(quero);
  const certo = snap.columns.filter((x) => fold(x.name) === f);
  const parecido = certo.length ? certo : snap.columns.filter((x) => fold(x.name).includes(f));
  if (parecido.length === 1) return { id: parecido[0].externalId, nome: parecido[0].name };
  throw new ErroAcao(`não achei uma única coluna "${neutral(quero, 60)}"`, snap.columns.map((x) => neutral(x.name, 60)));
}

function tarefaDe(snap: BoardSnapshot, quero: string): { id: string; titulo: string } {
  const porId = snap.tasks.find((t) => t.externalId === quero);
  if (porId) return { id: porId.externalId, titulo: porId.title };
  const f = fold(quero);
  const certo = snap.tasks.filter((t) => fold(t.title) === f);
  const parecido = certo.length ? certo : snap.tasks.filter((t) => fold(t.title).includes(f));
  if (parecido.length === 1) return { id: parecido[0].externalId, titulo: parecido[0].title };
  throw new ErroAcao(parecido.length ? `mais de uma tarefa parecida com "${neutral(quero, 60)}"` : `não achei a tarefa "${neutral(quero, 60)}" neste quadro`,
    (parecido.length ? parecido : snap.tasks).slice(0, 30).map((t) => neutral(t.title, 80)));
}

const P_QUADRO = { tipo: 'texto', descricao: 'nome ou id do quadro, projeto ou lista; sem ele, só funciona se houver um único' } as const;
const P_TAREFA = { tipo: 'texto', obrigatorio: true, descricao: 'título ou id da tarefa' } as const;
const feito = (texto: string, url?: string | null): Resultado => ({ texto, url: url ?? null });
const aoEscrever = async (c: CtxTarefas, quadro: string) => { try { await c.aoEscrever?.(quadro); } catch { /* a próxima leitura periódica acerta */ } };

/**
 * Como a resposta ao agente chama quadro, tarefa e coluna: pelo que ele mesmo passou e pelo id. O nome lido do serviço fica
 * de fora: em quadro compartilhado, outra pessoa escolhe esse texto, e ele chegaria ao agente sem a marca de conteúdo de fora.
 */
const termo = (v: unknown, id: string): string => { const t = String(v ?? '').trim(); return t === id ? '' : t; };
const emQuadro = (a: Args, id: string): string => { const t = termo(a.quadro, id); return t ? `em ${t} (id: ${id})` : `no quadro de id ${id}`; };
const pelo = (v: unknown, id: string): string => { const t = termo(v, id); return t ? `"${t}" (id: ${id})` : `de id ${id}`; };

/** O que muda numa edição ("nenhum" tira o prazo). Nada para mudar é recusado antes de ler o quadro. */
function mudancaDe(a: Args): MudancaTarefa {
  const titulo = txt(a, 'titulo', 200); const descricao = txt(a, 'descricao', 8000);
  const sem = typeof a.prazo === 'string' && /^(nenhum|sem prazo|null)$/i.test(a.prazo.trim());
  const prazo = sem ? null : dia(a, 'prazo');
  if (titulo === undefined && descricao === undefined && prazo === undefined) throw new ErroAcao('nada para mudar: diga titulo, descricao ou prazo');
  return { ...(titulo !== undefined ? { titulo } : {}), ...(descricao !== undefined ? { descricao } : {}), ...(prazo !== undefined ? { prazo } : {}) };
}

/**
 * Antes do cartão: acha o quadro e a tarefa de verdade e fixa os ids, para o clique mudar a tarefa que a pessoa viu, mesmo
 * que o quadro mude enquanto o cartão espera. Só lê. Sem escrita neste aplicativo, recusa já: o clique falharia.
 */
async function alvoDe(ctx: CtxAcao, a: Args): Promise<{ q: { id: string; nome: string }; snap: BoardSnapshot; t: { id: string; titulo: string }; w: EscritorTarefas }> {
  const c = ct(ctx); const w = escritor(c);
  const q = await quadroDe(c, a);
  const snap = await c.provedor.getBoard(q.id);
  return { q, snap, t: tarefaDe(snap, precisa(a, 'tarefa', 300)), w };
}
const noCartao = (q: { nome: string }, t: { titulo: string }): string => `Quadro: ${neutral(q.nome, 100)} · Tarefa: ${neutral(t.titulo, 120)}`;
/** quadro e tarefa vão ao clique pelo id; o cartão mostra o nome que o agente pediu, e o detalhe, o que foi lido */
const FIXA = ['quadro', 'tarefa'];

export const ACOES_TAREFAS: Acao[] = [
  { id: 'tarefa.quadros', descricao: 'lista os quadros, projetos ou listas da conta', risco: 'ler', params: {}, resumo: () => 'listar quadros',
    async run(ctx) {
      const b = await ct(ctx).provedor.listBoards();
      return { texto: b.length ? b.map((x) => `- ${neutral(x.name, 100)} (id: ${x.externalId})`).join('\n') : 'nenhum quadro visível nesta conta', deFora: true, privado: true };
    } },
  { id: 'tarefa.listar', descricao: 'lista as tarefas de um quadro, com coluna, situação, responsável e prazo', risco: 'ler',
    params: { quadro: P_QUADRO, abertas: { tipo: 'booleano', descricao: 'só as não concluídas (padrão: sim)' }, limite: { tipo: 'numero', descricao: 'até 200 (padrão 50)' } },
    resumo: (a) => `listar tarefas de ${String(a.quadro ?? 'um quadro')}`,
    async run(ctx, a) {
      const c = ct(ctx); const q = await quadroDe(c, a);
      const snap = await c.provedor.getBoard(q.id);
      const nomes = new Map(snap.columns.map((x) => [x.externalId, x.name]));
      const lista = snap.tasks.filter((t) => a.abertas === false || !t.completed);
      const teto = num(a, 'limite', 50, 200);
      const linhas = lista.slice(0, teto).map((t) => `- ${neutral(t.title, 120)} · ${neutral(nomes.get(t.columnExternalId) ?? '', 40)}${t.completed ? ' · concluída' : ''}${t.assignee ? ` · ${neutral(t.assignee, 40)}` : ''}${t.due ? ` · prazo ${t.due}` : ''}`);
      return { texto: `${neutral(q.nome, 100)}: ${lista.length} tarefa(s)${lista.length > teto ? `, mostrando ${teto}` : ''}${snap.complete ? '' : ' (o aplicativo não devolveu todas)'}. Colunas: ${snap.columns.map((x) => neutral(x.name, 40)).join(', ')}.\n${linhas.join('\n')}`, deFora: true, privado: true };
    } },
  { id: 'tarefa.criar', descricao: 'cria uma tarefa', risco: 'organizar',
    params: { quadro: P_QUADRO, titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título' }, descricao: { tipo: 'texto', descricao: 'descrição' }, coluna: { tipo: 'texto', descricao: 'nome da coluna; sem ela, a primeira' }, prazo: { tipo: 'texto', descricao: 'AAAA-MM-DD' } },
    resumo: (a) => `Criar a tarefa "${String(a.titulo ?? '')}"${a.quadro ? ` em ${String(a.quadro)}` : ''}${a.prazo ? `, prazo ${String(a.prazo)}` : ''}${a.descricao ? `\nDescrição: ${String(a.descricao)}` : ''}`,
    async run(ctx, a) {
      const c = ct(ctx); const q = await quadroDe(c, a);
      const coluna = txt(a, 'coluna', 200)?.trim();
      const titulo = precisa(a, 'titulo', 200); const prazo = dia(a, 'prazo');
      const r = await escritor(c).criar(q.id, { titulo, descricao: txt(a, 'descricao', 8000), prazo, coluna: coluna ? colunaDe(await c.provedor.getBoard(q.id), coluna).id : undefined });
      await aoEscrever(c, q.id);
      // o que foi gravado, para o agente não dizer à pessoa um prazo que não foi
      return feito(`Tarefa criada ${emQuadro(a, q.id)}: título "${titulo}", ${prazo ? `prazo ${prazo}` : 'sem prazo'}${coluna ? `, coluna "${coluna}"` : ''}.`, r.url);
    } },
  { id: 'tarefa.concluir', descricao: 'marca uma tarefa como concluída, ou reabre com feita=false', rotulo: 'marca uma tarefa como concluída, ou reabre', risco: 'organizar',
    params: { quadro: P_QUADRO, tarefa: P_TAREFA, feita: { tipo: 'booleano', descricao: 'false reabre (padrão: true)' } },
    resumo: (a) => `${a.feita === false ? 'Reabrir' : 'Concluir'} a tarefa "${String(a.tarefa ?? '')}"${a.quadro ? ` em ${String(a.quadro)}` : ''}`,
    async preparar(ctx, a) {
      const { q, t } = await alvoDe(ctx, a);
      return { detalhe: noCartao(q, t), args: { ...a, quadro: q.id, tarefa: t.id }, fixou: FIXA };
    },
    async run(ctx, a) {
      const c = ct(ctx); const q = await quadroDe(c, a);
      const t = tarefaDe(await c.provedor.getBoard(q.id), precisa(a, 'tarefa', 300));
      const r = await escritor(c).concluir(q.id, t.id, a.feita !== false);
      await aoEscrever(c, q.id);
      return feito(`Tarefa ${pelo(a.tarefa, t.id)} ${a.feita === false ? 'reaberta' : 'concluída'} ${emQuadro(a, q.id)}.`, r.url);
    } },
  { id: 'tarefa.mover', descricao: 'move uma tarefa para outra coluna (bucket, seção, lista, fase, situação)', risco: 'organizar',
    params: { quadro: P_QUADRO, tarefa: P_TAREFA, coluna: { tipo: 'texto', obrigatorio: true, descricao: 'nome da coluna de destino' } },
    resumo: (a) => `Mover a tarefa "${String(a.tarefa ?? '')}" para "${String(a.coluna ?? '')}"${a.quadro ? ` em ${String(a.quadro)}` : ''}`,
    async preparar(ctx, a) {
      const { q, snap, t } = await alvoDe(ctx, a);
      const col = colunaDe(snap, precisa(a, 'coluna', 200));
      return { detalhe: `${noCartao(q, t)}\nColuna de destino: ${neutral(col.nome, 80)}`, args: { ...a, quadro: q.id, tarefa: t.id, coluna: col.id }, fixou: [...FIXA, 'coluna'] };
    },
    async run(ctx, a) {
      const c = ct(ctx); const q = await quadroDe(c, a);
      const snap = await c.provedor.getBoard(q.id);
      const t = tarefaDe(snap, precisa(a, 'tarefa', 300)); const col = colunaDe(snap, precisa(a, 'coluna', 200));
      const r = await escritor(c).mover(q.id, t.id, col.id);
      await aoEscrever(c, q.id);
      return feito(`Tarefa ${pelo(a.tarefa, t.id)} movida para a coluna ${pelo(a.coluna, col.id)} ${emQuadro(a, q.id)}.`, r.url);
    } },
  { id: 'tarefa.editar', descricao: 'muda título, descrição ou prazo de uma tarefa', risco: 'organizar',
    params: { quadro: P_QUADRO, tarefa: P_TAREFA, titulo: { tipo: 'texto', descricao: 'novo título' }, descricao: { tipo: 'texto', descricao: 'nova descrição' }, prazo: { tipo: 'texto', descricao: 'AAAA-MM-DD; "nenhum" tira o prazo' } },
    resumo: (a) => `Editar a tarefa "${String(a.tarefa ?? '')}":${a.titulo ? ` título "${String(a.titulo)}"` : ''}${a.prazo ? ` prazo ${String(a.prazo)}` : ''}${a.descricao ? `\nDescrição: ${String(a.descricao)}` : ''}`,
    async preparar(ctx, a) {
      mudancaDe(a); // o que o clique recusaria não vira cartão
      const { q, t } = await alvoDe(ctx, a);
      return { detalhe: noCartao(q, t), args: { ...a, quadro: q.id, tarefa: t.id }, fixou: FIXA };
    },
    async run(ctx, a) {
      const m = mudancaDe(a);
      const c = ct(ctx); const q = await quadroDe(c, a);
      const t = tarefaDe(await c.provedor.getBoard(q.id), precisa(a, 'tarefa', 300));
      const r = await escritor(c).editar(q.id, t.id, m);
      await aoEscrever(c, q.id);
      const mudou = [m.titulo !== undefined ? `título "${m.titulo}"` : '', m.prazo === null ? 'prazo tirado' : m.prazo ? `prazo ${m.prazo}` : '', m.descricao !== undefined ? 'descrição trocada' : ''].filter(Boolean).join(', ');
      return feito(`Tarefa ${pelo(a.tarefa, t.id)} atualizada ${emQuadro(a, q.id)}: ${mudou}.`, r.url);
    } },
  // comentário notifica quem acompanha a tarefa, e em repositório público qualquer um lê: outra pessoa recebe
  { id: 'tarefa.comentar', descricao: 'comenta numa tarefa (nem todo aplicativo tem comentários)', risco: 'enviar',
    params: { quadro: P_QUADRO, tarefa: P_TAREFA, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o comentário' } },
    resumo: (a) => `Comentar na tarefa "${String(a.tarefa ?? '')}": ${String(a.texto ?? '')}`,
    async preparar(ctx, a) {
      const { q, t, w } = await alvoDe(ctx, a);
      if (!w.comentar) throw new ErroAcao('este aplicativo não tem comentários pela API');
      return { detalhe: noCartao(q, t), args: { ...a, quadro: q.id, tarefa: t.id }, fixou: FIXA };
    },
    async run(ctx, a) {
      const c = ct(ctx); const w = escritor(c);
      if (!w.comentar) throw new ErroAcao('este aplicativo não tem comentários pela API');
      const q = await quadroDe(c, a);
      const t = tarefaDe(await c.provedor.getBoard(q.id), precisa(a, 'tarefa', 300));
      await w.comentar(q.id, t.id, precisa(a, 'texto', 8000));
      return feito(`Comentário feito na tarefa ${pelo(a.tarefa, t.id)} ${emQuadro(a, q.id)}.`);
    } },
];

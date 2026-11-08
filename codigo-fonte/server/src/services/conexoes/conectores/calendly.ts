/**
 * Calendly, API v2, com o token de acesso pessoal da pessoa. Referências oficiais:
 * - developer.calendly.com/api-docs/calendly-api/: users/get-current-user, scheduled-events/list-scheduled-events,
 *   scheduled-events/get-scheduled-event, scheduled-events/list-event-invitees, event-types/list-event-types,
 *   scheduled-events/create-scheduled-event-cancellation
 * - developer.calendly.com/openapi/calendly-api.yaml (endereço base, tetos de count e de reason, formato dos erros, Event e Guest)
 * - developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens e .../authentication/scopes
 * - calendly.com/help/how-to-cancel-a-meeting (o convidado é avisado quando quem marcou cancela pela tela; a página da API não diz)
 */
import { clip } from '../../../lib/util.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Args, type CtxAcao } from '../tipos.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';

/** O id de um evento é o fim do seu endereço: aceita os dois, porque as respostas do serviço trazem o endereço inteiro. */
const idDe = (v: unknown): string => String(v ?? '').trim().replace(/\/+$/, '').split('/').pop() ?? '';

/** As listas pedem de quem são os dados, pelo endereço da pessoa: ele vem da própria conta, nunca do modelo. */
async function comAPessoa(ctx: CtxAcao, a: Args): Promise<Args> {
  const j = await ctx.http('/users/me');
  const usuario = j?.resource?.uri;
  if (!usuario) throw new ErroAcao('o Calendly não informou de quem é esta conta');
  return { ...a, usuario };
}
const comOEvento = async (_ctx: CtxAcao, a: Args): Promise<Args> => ({ ...a, evento: idDe(a.evento) });
/** O cartão de confirmação mostra até 6000 caracteres (proposals.ts): um motivo maior sairia sem a pessoa ler o fim. */
const MAX_MOTIVO = 5000;

// --------------------------------------------------------------------------------------------- o que o cartão precisa mostrar
/** Quantos convidados o cartão nomeia; o total vem do próprio evento. */
const CONVIDADOS_NO_CARTAO = 5;
const listaDe = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const DATA_E_HORA = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
/** No fuso da pessoa. Fuso que o sistema não conhece cai no horário universal, e o cartão diz qual foi usado. */
function periodo(inicio: unknown, fim: unknown, tz: string): string {
  let fuso = tz; let formato: Intl.DateTimeFormat;
  try { formato = new Intl.DateTimeFormat('pt-BR', { ...DATA_E_HORA, timeZone: tz }); } catch {
    fuso = 'UTC'; formato = new Intl.DateTimeFormat('pt-BR', { ...DATA_E_HORA, timeZone: fuso });
  }
  const em = (v: unknown): string => { const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? 'data desconhecida' : formato.format(d); };
  return `${em(inicio)} até ${em(fim)} (${fuso})`;
}
function linhaDosConvidados(evento: any, nomeados: any[]): string {
  const total = Math.max(Number(evento?.invitees_counter?.active) || 0, nomeados.length);
  if (!total) return 'Convidados: nenhum';
  if (!nomeados.length) return `Convidados: ${total}`;
  const nomes = clip(nomeados.map((c) => `${neutral(String(c?.name || 'sem nome'), 40)} <${neutral(String(c?.email ?? ''), 60)}>`).join(', '), 350);
  return `Convidados (${total}): ${nomes}${total > nomeados.length ? ` e mais ${total - nomeados.length}` : ''}`;
}

const P_EVENTO = { tipo: 'texto', obrigatorio: true, descricao: 'id do evento, como aparece na lista de eventos' } as const;
const P_LIMITE = { tipo: 'numero', descricao: 'até 100 (padrão 20)', padrao: 20, max: 100 } as const;
const paginaSeguinte = (j: any): string | null => j?.pagination?.next_page_token ?? null;

export const CALENDLY: ConectorDef = {
  kind: 'calendly', nome: 'Calendly', site: 'calendly.com', grupo: 'documentos',
  sobre: 'Sua agenda no Calendly: os agentes veem os eventos marcados, quem vai participar e os tipos de evento, e cancelam um evento quando você confirma.',
  campos: [{ name: 'token', label: 'Token de acesso pessoal', secret: true, placeholder: 'Cole o token aqui' }],
  ajuda: {
    url: 'https://calendly.com/app/developer?tab=personal_access_tokens',
    passos: 'Abra a página de tokens do Calendly (menu do perfil › Developer › Personal access tokens). Clique em Create personal access token, dê um nome e clique em Next. Marque as permissões users:read, event_types:read, scheduled_events:read e scheduled_events:write (esta última é a que permite cancelar eventos) e clique em Create. Digite o código que o Calendly manda para o seu e-mail e copie o token: ele só aparece uma vez. Cole aqui. Se você administra uma organização no Calendly, o token alcança os dados de todas as pessoas dela.',
  },
  base: 'https://api.calendly.com',
  auth: { tipo: 'bearer' },
  // os erros do serviço vêm com código HTTP e { title, message }; isto cobre um intermediário que devolva o mesmo erro com 200
  erroNoCorpo: (j) => (typeof j?.title === 'string' && typeof j?.message === 'string' && !j.resource && !j.collection ? { mensagem: `${j.title}: ${j.message}`, permissao: Array.isArray(j.required_scopes) || /permission|scope|unauthenticated/i.test(j.title) } : null),
  quemSou: { caminho: '/users/me', nome: (j) => String(j.resource?.name ?? j.resource?.email ?? 'conta do Calendly'), id: (j) => j.resource?.uri },
  acoes: [
    { id: 'calendly.eventos', descricao: 'lista os seus eventos marcados; use "desde" com a data de hoje para ver só os próximos', rotulo: 'lista os seus eventos marcados', risco: 'ler',
      params: {
        situacao: { tipo: 'texto', descricao: 'active (marcados) ou canceled (cancelados)', opcoes: ['active', 'canceled'] },
        desde: { tipo: 'texto', descricao: 'só eventos que começam depois desta data, em UTC, como 2026-11-05T13:00:00.000000Z' },
        ate: { tipo: 'texto', descricao: 'só eventos que começam antes desta data, em UTC, como 2026-11-05T13:00:00.000000Z' },
        convidado: { tipo: 'texto', descricao: 'só eventos com este e-mail de convidado' },
        ordem: { tipo: 'texto', descricao: 'start_time:asc (padrão, do mais antigo ao mais novo) ou start_time:desc', opcoes: ['start_time:asc', 'start_time:desc'], padrao: 'start_time:asc' },
        limite: P_LIMITE,
      },
      resumo: 'listar eventos do Calendly', metodo: 'GET', caminho: '/scheduled_events', antes: comAPessoa,
      consulta: { user: '{usuario}', status: '{situacao}', min_start_time: '{desde}', max_start_time: '{ate}', invitee_email: '{convidado}', sort: '{ordem}', count: '{limite}' },
      lista: 'collection',
      linha: (x) => linhaDe('{start_time} até {end_time}: {name} ({status}, convidados: {invitees_counter.active}, local: {local}) (id: {id})', { ...x, id: idDe(x.uri), local: x.location?.location ?? x.location?.join_url ?? x.location?.type }),
      proximo: paginaSeguinte, paramCursor: 'page_token' },
    { id: 'calendly.convidados', descricao: 'lista os convidados de um evento, com as respostas que deram ao marcar', risco: 'ler',
      params: {
        evento: P_EVENTO,
        situacao: { tipo: 'texto', descricao: 'active (confirmados) ou canceled (cancelados)', opcoes: ['active', 'canceled'] },
        email: { tipo: 'texto', descricao: 'só o convidado com este e-mail' },
        limite: P_LIMITE,
      },
      resumo: 'listar convidados do evento {evento}', metodo: 'GET', caminho: '/scheduled_events/{evento}/invitees', antes: comOEvento,
      consulta: { status: '{situacao}', email: '{email}', count: '{limite}' }, lista: 'collection',
      linha: (x) => linhaDe('{name} <{email}> ({status}, fuso: {timezone}) {respostas}', { ...x, respostas: (Array.isArray(x.questions_and_answers) ? x.questions_and_answers : []).map((q: any) => `${q.question}: ${q.answer}`).join(' | ') }, 2000),
      proximo: paginaSeguinte, paramCursor: 'page_token' },
    { id: 'calendly.tipos', descricao: 'lista os seus tipos de evento, com o link de cada um', risco: 'ler',
      params: { ativo: { tipo: 'booleano', descricao: 'sim: só os ativos; não: só os inativos; vazio: todos' }, limite: P_LIMITE },
      resumo: 'listar tipos de evento do Calendly', metodo: 'GET', caminho: '/event_types', antes: comAPessoa,
      consulta: { user: '{usuario}', active: '{ativo}', count: '{limite}' }, lista: 'collection',
      linha: (x) => linhaDe('{name} ({duration} min, {situacao}) {scheduling_url}', { ...x, situacao: x.active ? 'ativo' : 'inativo' }),
      proximo: paginaSeguinte, paramCursor: 'page_token' },
    { id: 'calendly.cancelar', descricao: 'cancela um evento marcado; os convidados podem receber um aviso por e-mail', risco: 'apagar',
      params: { evento: P_EVENTO, motivo: { tipo: 'texto', descricao: `por que está cancelando, até ${MAX_MOTIVO} caracteres`, max: MAX_MOTIVO } },
      resumo: (a) => `Cancelar o evento ${idDe(a.evento)} no Calendly. Os convidados podem receber um aviso por e-mail.${a.motivo ? `\nMotivo informado: ${String(a.motivo)}` : ''}`,
      // preparar recebe o pedido antes de o motor conferir os parâmetros: o que o clique recusaria não pode virar cartão
      preparar: async (ctx, a) => {
        const n = String(a.motivo ?? '').length;
        if (n > MAX_MOTIVO) throw new ErroAcao(`"motivo" tem ${n} caracteres, e o limite é ${MAX_MOTIVO}: encurte (nada foi feito)`);
        const id = idDe(a.evento);
        const j = await ctx.http(`/scheduled_events/${seg(id)}`);
        const e = j?.resource;
        if (e?.status === 'canceled') throw new ErroAcao('este evento já está cancelado (nada foi feito)');
        const { collection } = await ctx.http(`/scheduled_events/${seg(id)}/invitees?status=active&count=${CONVIDADOS_NO_CARTAO}`);
        const extras = listaDe(e?.event_guests).map((g) => neutral(String(g?.email ?? ''), 60)).filter(Boolean);
        const detalhe = [`Evento: ${neutral(String(e?.name || 'sem nome'), 80)}`, `Quando: ${periodo(e?.start_time, e?.end_time, ctx.tz)}`, linhaDosConvidados(e, listaDe(collection)), ...(extras.length ? [`Também no evento: ${clip(extras.join(', '), 200)}`] : [])];
        return { detalhe: detalhe.join('\n'), args: { ...a, evento: id } };
      },
      metodo: 'POST', caminho: '/scheduled_events/{evento}/cancellation', antes: comOEvento, corpo: { reason: '{motivo}' }, texto: 'Evento {evento} cancelado.' },
  ],
};

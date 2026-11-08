/**
 * Linear: escrita nas issues (GraphQL), com a mesma credencial da leitura (chave pessoal no Authorization, sem "Bearer").
 * Referências (conferidas em 05/11/2026):
 *   https://linear.app/developers/graphql (autenticação, issueCreate, issueUpdate; erro pode vir em `errors` com HTTP 200)
 *   https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql (assinaturas e tipos de estado)
 *   https://linear.app/developers/rate-limiting  https://linear.app/docs/api-and-webhooks (permissões da chave)
 *
 * Inverso da leitura em LinearProvider (task-providers.ts): quadro = time; coluna = estado; concluída = estado do tipo completed
 * ou canceled; prazo = dueDate; versão = updatedAt. A leitura põe o identificador no título ("ENG-12 · Revisar"): ele não é parte
 * do título no Linear e sai antes de gravar. Sem estado, a issue nasce no estado padrão do time, não no primeiro por posição:
 * a posição só ordena dentro de cada tipo de estado, e o primeiro poderia até ser um de concluído.
 */
import { recusado, request } from '../../task-providers.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, dia, type EscritorTarefas, type Escrita } from '../tipos.ts';

const API = 'https://api.linear.app/graphql';
/** coluna sintética de time sem estados (ver getBoard) */
const SEM_ESTADOS = '__tarefas__';
const TIME = /^[a-f0-9-]{36}$/i;
const PREFIXO_DA_LEITURA = /^[A-Za-z0-9]+-\d+ ·(\s|$)/;
const ISSUE = 'id url updatedAt';
const ESTADOS = 'states { nodes { id name type position } }';

type Classe = 'acesso' | 'inexistente' | 'interno' | 'passageiro' | 'pedido';
/** O que o próprio Linear diz em extensions.type (SDK oficial, error.ts) e extensions.code (RATELIMITED, INPUT_ERROR...). "unknown" e "other" não dizem nada: vale o texto. */
const POR_EXTENSAO: Record<string, Classe> = {
  'authentication error': 'acesso', authentication_error: 'acesso', forbidden: 'acesso', 'feature not accessible': 'acesso',
  'not found': 'inexistente', not_found: 'inexistente', entity_not_found: 'inexistente',
  'internal error': 'interno', internal_error: 'interno', internal_server_error: 'interno', 'bootstrap error': 'interno',
  ratelimited: 'passageiro', 'lock timeout': 'passageiro', 'network error': 'passageiro',
  'invalid input': 'pedido', input_error: 'pedido', 'user error': 'pedido', 'graphql error': 'pedido', graphql_validation_failed: 'pedido', 'usage limit exceeded': 'pedido',
};
/** Sem extensions que digam algo, o texto, só em palavras inteiras: "Author" não é credencial e "internalNote" não é erro interno. */
function classeDoTexto(t: string): Classe {
  if (/\b(auth|authentication|authentication[ _]error|not[ _]authenticated|unauthenticated|unauthori[sz]ed|forbidden|permissions?|credentials?|token)\b/i.test(t)) return 'acesso';
  if (/\bnot[ _]found\b/i.test(t)) return 'inexistente';
  if (/\binternal\b/i.test(t)) return 'interno';
  if (/\b(ratelimited|rate[ _]limit(ed)?|temporary|temporarily|try again)\b/i.test(t)) return 'passageiro';
  return 'pedido';
}

/** Erro no corpo da resposta: nunca é "feito". Credencial e inexistência têm tipo próprio; passageiro pode repetir; o resto a pessoa corrige. */
function erroDe(bruto: string, kind: 'read' | 'write', ext: { type?: unknown; code?: unknown } = {}, tecnico = ''): Error {
  const msg = `Linear: ${neutral(bruto, 200)}`;
  const classe = POR_EXTENSAO[String(ext.type ?? '').toLowerCase()] ?? POR_EXTENSAO[String(ext.code ?? '').toLowerCase()] ?? classeDoTexto(`${bruto} ${tecnico}`);
  if (classe === 'acesso') return new ProviderError('forbidden', msg);
  if (classe === 'inexistente') return new ProviderError('not_found', msg);
  // erro interno numa mutação vale como um 5xx: pode ter feito ou não, e o espelho só deixa de criar de novo se ouvir "não confirmou"
  if (classe === 'interno' && kind === 'write') return new ProviderError('unavailable', `o Linear não confirmou (pode ter feito ou não): confira lá antes de repetir. ${msg}`);
  if (classe === 'interno' || classe === 'passageiro') return new ProviderError('unavailable', msg);
  return new ErroAcao(msg);
}

export function escritorLinear(chave: string): EscritorTarefas {
  const chama = async (query: string, variables: Record<string, unknown>, kind: 'read' | 'write'): Promise<any> => {
    let j: any;
    try { j = await request(API, { headers: { Authorization: chave }, body: { query, variables }, kind }); }
    catch (e) { if (recusado(e)) throw erroDe(e.message, kind); throw e; }
    const erro = j?.errors?.[0];
    if (erro) throw erroDe(String(erro.extensions?.userPresentableMessage ?? erro.message ?? 'erro na chamada'), kind, erro.extensions ?? {}, String(erro.message ?? ''));
    return j?.data ?? {};
  };
  /** `success: false` não é feito; a própria mutação é quem confirma. */
  const confirma = (p: any) => {
    if (p?.success !== true) throw new ProviderError('unavailable', 'o Linear não confirmou (pode ter feito ou não): confira lá antes de repetir');
    return p;
  };
  const feito = (i: any, id: string): Escrita => ({ id: String(i?.id ?? id), versao: i?.updatedAt ? String(i.updatedAt) : null, url: i?.url ? String(i.url) : null });
  const atualiza = async (tarefa: string, input: Record<string, unknown>): Promise<Escrita> =>
    feito(confirma((await chama(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`, { id: tarefa, input }, 'write')).issueUpdate).issue, tarefa);
  const confereTime = (quadro: string) => { if (!TIME.test(quadro)) throw new ErroAcao('time inválido: o Linear usa um identificador de 36 caracteres'); };
  const ordem = (t: any): any[] => ((t?.states?.nodes ?? []) as any[]).sort((a, b) => Number(a.position) - Number(b.position));
  const estadosDe = async (quadro: string): Promise<any[]> => {
    const t = (await chama(`query ($t: String!) { team(id: $t) { ${ESTADOS} } }`, { t: quadro }, 'read')).team;
    if (!t) throw new ProviderError('not_found', 'time não encontrado (ou sem acesso)');
    return ordem(t);
  };
  const estadoOk = (estados: any[], coluna: string): string => {
    const e = estados.find((x) => String(x.id) === coluna);
    if (!e) throw new ErroAcao(`este time não tem a coluna "${neutral(coluna, 60)}"`, estados.map((x) => neutral(`${x.name} (${x.id})`)));
    return String(e.id);
  };
  const tituloOk = (s: string): string => {
    const v = String(s ?? '').trim().replace(PREFIXO_DA_LEITURA, '').trim();
    if (!v) throw new ErroAcao('o título não pode ficar vazio');
    return v;
  };

  return {
    async criar(quadro, t) {
      confereTime(quadro);
      const title = tituloOk(t.titulo);
      const coluna = t.coluna && t.coluna !== SEM_ESTADOS ? t.coluna : null;
      const stateId = coluna ? estadoOk(await estadosDe(quadro), coluna) : null;
      const input = { teamId: quadro, title, ...(t.descricao ? { description: t.descricao } : {}), ...(stateId ? { stateId } : {}), ...(t.prazo ? { dueDate: dia({ prazo: t.prazo }, 'prazo') } : {}) };
      const i = confirma((await chama(`mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input }, 'write')).issueCreate).issue;
      if (!i?.id) confirma(null); // sem o id não dá para ligar a tarefa: mesmo aviso de "confira lá"
      return feito(i, '');
    },
    async concluir(quadro, tarefa, feita) {
      confereTime(quadro);
      const d = await chama(`query ($t: String!, $i: String!) { team(id: $t) { ${ESTADOS} } issue(id: $i) { ${ISSUE} state { id type } } }`, { t: quadro, i: tarefa }, 'read');
      if (!d.team) throw new ProviderError('not_found', 'time não encontrado (ou sem acesso)');
      if (!d.issue) throw new ProviderError('not_found', 'tarefa não encontrada (ou sem acesso)');
      const tipo = d.issue.state?.type;
      if ((tipo === 'completed' || tipo === 'canceled') === feita) return feito(d.issue, tarefa); // já está assim: não mexe em "Em andamento" nem troca de estado final
      const estados = ordem(d.team);
      const alvo = feita ? estados.find((e) => e.type === 'completed') : estados.find((e) => e.type === 'unstarted') ?? estados.find((e) => e.type === 'backlog');
      if (!alvo) throw new ErroAcao(feita ? 'este time não tem como marcar concluído: nenhum estado do tipo concluído no fluxo' : 'este time não tem estado de "não iniciado" para reabrir', estados.map((e) => neutral(String(e.name))));
      return atualiza(tarefa, { stateId: String(alvo.id) });
    },
    async mover(quadro, tarefa, coluna) {
      confereTime(quadro);
      if (coluna === SEM_ESTADOS) return { id: tarefa };
      return atualiza(tarefa, { stateId: estadoOk(await estadosDe(quadro), coluna) });
    },
    async editar(_quadro, tarefa, m) {
      if (m.titulo === undefined && m.descricao === undefined && m.prazo === undefined) throw new ErroAcao('nada para mudar: diga título, descrição ou prazo');
      return atualiza(tarefa, {
        ...(m.titulo !== undefined ? { title: tituloOk(m.titulo) } : {}), ...(m.descricao !== undefined ? { description: m.descricao } : {}),
        ...(m.prazo !== undefined ? { dueDate: m.prazo ? dia({ prazo: m.prazo }, 'prazo') : null } : {}),
      });
    },
    async comentar(_quadro, tarefa, texto) {
      if (!String(texto ?? '').trim()) throw new ErroAcao('o comentário está vazio');
      confirma((await chama('mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }', { input: { issueId: tarefa, body: texto } }, 'write')).commentCreate);
    },
  };
}

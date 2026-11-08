/**
 * Pipefy: escrita nos pipes, por GraphQL. Referências oficiais (conferidas em 05/11/2026):
 *   https://api-docs.pipefy.com/reference/inputObjects/CreateCardInput/ · https://api-docs.pipefy.com/reference/mutations/createCard/
 *   https://api-docs.pipefy.com/reference/inputObjects/MoveCardToPhaseInput/ · https://api-docs.pipefy.com/reference/mutations/moveCardToPhase/
 *   https://api-docs.pipefy.com/reference/inputObjects/UpdateCardInput/ · https://api-docs.pipefy.com/reference/mutations/updateCard/
 *   https://api-docs.pipefy.com/reference/inputObjects/UpdateCardFieldInput/ · https://api-docs.pipefy.com/reference/mutations/updateCardField/
 *   https://api-docs.pipefy.com/reference/inputObjects/CreateCommentInput/ · https://api-docs.pipefy.com/reference/mutations/createComment/
 *   https://api-docs.pipefy.com/reference/objects/Phase/ · /objects/Card/ · /objects/Pipe/ · /objects/PhaseField/ · /scalars/DateTime/ · /queries/
 *   https://developers.pipefy.com/reference/cards · /move-card-to-a-different-phase · /fields · /get-resource-ids
 *   https://developers.pipefy.com/reference/status-and-error-handling (erro vem com 200; failed field = null; `success: false`)
 *   https://help.pipefy.com/en/articles/8650789-how-to-clear-fields-in-bulk-via-api (new_value "" limpa o campo)
 * Inverso da leitura em PipefyProvider (task-providers.ts): quadro = id do pipe; coluna = id da fase; concluída = card em fase
 * com `done: true`; prazo = due_date do card; versão = updated_at. O card não tem descrição própria: ela vai para um campo de
 * texto do pipe, se houver, o mesmo que a leitura lê (campoDescricaoPipefy).
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, campoDescricaoPipefy, recusado, request } from '../../task-providers.ts';
import { ErroAcao, type EscritorTarefas, type Escrita } from '../tipos.ts';

type Json = any; // respostas externas: lidas campo a campo
const API = 'https://api.pipefy.com/graphql';
/** coluna sintética de getBoard (pipe sem fases) */
const UMA_COLUNA = '__tarefas__';
const CARD = 'id url updated_at';
/** erro que a pessoa corrige (repetir não muda a resposta) */
const CORRIGIVEL = new Set(['PHASE_TRANSITION_ERROR', 'FIELD_EDITABLE_ONLY_ON_ITS_ORIGINAL_PHASE', 'INVALID_INPUT', 'RECORD_INVALID', 'RECORD_NOT_SAVED', 'FEATURE_BLOCKED', 'FEATURE_NOT_ALLOWED_BY_ORGANIZATION_PLAN']);

interface Fase { id: string; name: string; done: boolean }
interface Campo { id: string; label: string; type: string }
interface Pipe { fases: Fase[]; inicio: Set<string>; notas?: Campo }

const falha = (e: Json, kind: 'read' | 'write'): Error => {
  const msg = neutral(String(e?.message ?? 'erro na chamada'), 300); const code = String(e?.extensions?.code ?? '');
  if (code === 'PERMISSION_DENIED' || /unauthori|forbidden|permission|not authenticated|credential/i.test(msg)) return new ProviderError('forbidden', `o Pipefy recusou: ${msg}`);
  if (code === 'RESOURCE_NOT_FOUND') return new ProviderError('not_found', `não encontrado (ou sem acesso): ${msg}`);
  if (CORRIGIVEL.has(code)) return new ErroAcao(`o Pipefy recusou: ${msg}`);
  // erro desconhecido numa mutação vale como um 5xx: pode ter feito ou não, e o espelho só deixa de criar de novo se ouvir "não confirmou"
  if (kind === 'write' && !/too.?many|rate.?limit/i.test(`${code} ${msg}`)) return new ProviderError('unavailable', `o Pipefy não confirmou (pode ter feito ou não): ${msg}. Confira lá antes de repetir`);
  return new ProviderError('unavailable', `o Pipefy respondeu com erro: ${msg}`);
};
const naoConfirmou = (o: string) => new ProviderError('unavailable', `o Pipefy não confirmou ${o}`);
const idPipe = (quadro: string): string => {
  if (!/^\d{1,20}$/.test(quadro)) throw new ErroAcao('pipe inválido: o quadro do Pipefy é o id numérico do pipe');
  return quadro;
};
const nomesFases = (l: Fase[]) => l.map((f) => neutral(f.name, 60));
/** O campo é data e hora em UTC; meio-dia não muda o dia em nenhum fuso comum. */
const quando = (prazo: string) => `${prazo}T12:00:00Z`;
const feito = (c: Json): Escrita => ({ id: String(c.id), versao: c.updated_at ? String(c.updated_at) : null, url: c.url ? String(c.url) : null });

/** Fase em que o card conta como concluído: a única final, ou a única final com nome de "feito". */
function faseFinal(fases: Fase[]): Fase {
  const finais = fases.filter((f) => f.done);
  if (!finais.length) throw new ErroAcao('este pipe não tem fase final: não há como concluir o card. Marque uma fase como final no Pipefy', nomesFases(fases));
  if (finais.length === 1) return finais[0];
  const feitas = finais.filter((f) => DONE.test(f.name));
  if (feitas.length === 1) return feitas[0];
  throw new ErroAcao('este pipe tem mais de uma fase final: mova o card para a que vale neste caso', nomesFases(finais));
}

export function escritorPipefy(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}` };
  const chamar = async (query: string, variables: Record<string, unknown>, kind: 'read' | 'write'): Promise<Json> => {
    let j: Json;
    try { j = await request(API, { headers: auth, body: { query, variables }, kind }); }
    catch (e) { if (recusado(e)) throw new ErroAcao(`o Pipefy recusou o pedido: ${neutral(e.message, 240)}`); throw e; }
    if (j.errors?.length) throw falha(j.errors[0], kind); // erro com dados parciais também é erro: numa escrita, não houve sucesso
    return j.data ?? {};
  };
  const mut = (query: string, input: Record<string, unknown>) => chamar(query, { input }, 'write');

  const pipe = async (quadro: string): Promise<Pipe> => {
    const p = (await chamar(`query ($id: ID!) { pipe(id: $id) { phases { id name done fields { id label type } } start_form_fields { id label type } } }`, { id: idPipe(quadro) }, 'read')).pipe;
    if (!p) throw new ProviderError('not_found', 'pipe não encontrado (ou sem acesso)');
    const fases = (p.phases ?? []) as Json[]; const inicio = (p.start_form_fields ?? []) as Campo[];
    return {
      fases: fases.map((f) => ({ id: String(f.id), name: String(f.name), done: f.done === true })), inicio: new Set(inicio.map((c) => String(c.id))),
      notas: campoDescricaoPipefy(p),
    };
  };
  const faseDe = (p: Pipe, coluna: string): Fase => {
    const f = p.fases.find((x) => x.id === coluna);
    if (!f) throw new ErroAcao(`a fase "${neutral(coluna, 60)}" não existe neste pipe`, nomesFases(p.fases));
    return f;
  };
  const semCampoNotas = () => new ErroAcao('este pipe não tem campo de descrição: crie um campo de texto longo chamado "Descrição" no pipe ou mande sem descrição');

  const gravarNotas = async (c: Campo, card: string, valor: string): Promise<Json> => {
    const r = (await mut(`mutation ($input: UpdateCardFieldInput!) { updateCardField(input: $input) { success card { ${CARD} } } }`, { card_id: card, field_id: c.id, new_value: valor })).updateCardField;
    if (!r || r.success === false) throw naoConfirmou('a mudança no campo');
    return r.card;
  };
  const moverPara = async (card: string, fase: string): Promise<Escrita> => {
    const c = (await mut(`mutation ($input: MoveCardToPhaseInput!) { moveCardToPhase(input: $input) { card { ${CARD} current_phase { id } } } }`, { card_id: card, destination_phase_id: fase })).moveCardToPhase?.card;
    if (!c?.id || String(c.current_phase?.id) !== fase) throw naoConfirmou('a mudança de fase');
    return feito(c);
  };

  return {
    async criar(quadro, n) {
      if (!n.titulo?.trim()) throw new ErroAcao('falta o título');
      const p = await pipe(quadro);
      const fase = n.coluna && n.coluna !== UMA_COLUNA ? faseDe(p, n.coluna) : null;
      if (n.descricao && !p.notas) throw semCampoNotas();
      const naEntrada = !!n.descricao && p.inicio.has(String(p.notas!.id));
      const c = (await mut(`mutation ($input: CreateCardInput!) { createCard(input: $input) { card { ${CARD} } } }`, {
        pipe_id: idPipe(quadro), title: n.titulo, ...(fase ? { phase_id: fase.id } : {}), ...(n.prazo ? { due_date: quando(n.prazo) } : {}),
        ...(naEntrada ? { fields_attributes: [{ field_id: p.notas!.id, field_value: n.descricao }] } : {}),
      })).createCard?.card;
      if (!c?.id) throw naoConfirmou('a criação do card');
      if (n.descricao && !naEntrada) {
        // campo de outra fase só existe depois do card; aqui o erro é definitivo: repetir criaria outro card
        try { return feito((await gravarNotas(p.notas!, String(c.id), n.descricao)) ?? c); } catch (e) {
          throw new ErroAcao(`o card foi criado (id ${String(c.id)}), mas a descrição não foi gravada: ${e instanceof Error ? neutral(e.message, 300) : 'erro desconhecido'}. Não crie de novo: edite este card`, undefined, feito(c));
        }
      }
      return feito(c);
    },
    async concluir(quadro, tarefa, feita) {
      const p = await pipe(quadro);
      const c = (await chamar(`query ($id: ID!) { card(id: $id) { ${CARD} pipe { id } current_phase { id cards_can_be_moved_to_phases { id } } } }`, { id: tarefa }, 'read')).card;
      if (!c) throw new ProviderError('not_found', 'card não encontrado (ou sem acesso)');
      if (String(c.pipe?.id) !== quadro) throw new ErroAcao('este card não é deste pipe');
      const agora = String(c.current_phase?.id ?? ''); const jaFinal = p.fases.some((f) => f.id === agora && f.done);
      if (feita) return jaFinal ? feito(c) : moverPara(tarefa, faseFinal(p.fases).id);
      if (!jaFinal) return feito(c);
      // reabrir: a última fase aberta que esta fase final permite (a mais perto do fim, de onde o card normalmente veio)
      const lista = c.current_phase?.cards_can_be_moved_to_phases as Json[] | null | undefined;
      const abertas = p.fases.filter((f) => !f.done);
      const destino = (lista ? abertas.filter((f) => lista.some((x) => String(x.id) === f.id)) : abertas).at(-1);
      if (!destino) throw new ErroAcao('o Pipefy não permite tirar o card desta fase final: libere a saída em "Mover card" nas configurações da fase', nomesFases(abertas));
      return moverPara(tarefa, destino.id);
    },
    async mover(quadro, tarefa, coluna) {
      if (coluna === UMA_COLUNA) return { id: tarefa };
      return moverPara(tarefa, faseDe(await pipe(quadro), coluna).id);
    },
    async editar(quadro, tarefa, m) {
      idPipe(quadro);
      if (m.titulo !== undefined && !m.titulo.trim()) throw new ErroAcao('o título não pode ficar vazio');
      const notas = m.descricao !== undefined ? (await pipe(quadro)).notas : undefined;
      if (m.descricao !== undefined && !notas) throw semCampoNotas();
      let c: Json = null;
      if (m.titulo !== undefined || m.prazo !== undefined) {
        c = (await mut(`mutation ($input: UpdateCardInput!) { updateCard(input: $input) { card { ${CARD} due_date } } }`, {
          id: tarefa, ...(m.titulo !== undefined ? { title: m.titulo } : {}), ...(m.prazo !== undefined ? { due_date: m.prazo === null ? null : quando(m.prazo) } : {}),
        })).updateCard?.card;
        if (!c?.id) throw naoConfirmou('a mudança no card');
        // a documentação não diz que null tira o prazo: confere na resposta em vez de dizer que tirou
        if (m.prazo === null && c.due_date) throw new ErroAcao('o Pipefy não aceitou tirar o prazo pela API: tire direto no card');
      }
      if (m.descricao !== undefined) c = (await gravarNotas(notas!, tarefa, m.descricao)) ?? c;
      return c?.id ? feito(c) : { id: tarefa };
    },
    async comentar(_quadro, tarefa, texto) {
      const r = (await mut(`mutation ($input: CreateCommentInput!) { createComment(input: $input) { comment { id } } }`, { card_id: tarefa, text: texto })).createComment;
      if (!r?.comment?.id) throw naoConfirmou('o comentário');
    },
  };
}

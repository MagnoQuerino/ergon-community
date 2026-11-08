/**
 * Pipedrive: pessoas (contatos), organizações (empresas), negócios, atividades e notas. Nenhuma ação manda e-mail nem convite.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   developers.pipedrive.com/docs/api/v1/openapi-v2.yaml (servidor api.pipedrive.com/api/v2; x-api-token no cabeçalho; next_cursor)
 *   developers.pipedrive.com/docs/api/v1/openapi.yaml (servidor api.pipedrive.com/v1: /users/me, /users, /notes com start e limit)
 *   pipedrive.readme.io/docs/core-api-concepts-authentication (x-api-token; um token ativo por vez; dá o acesso do usuário)
 *   pipedrive.readme.io/docs/how-to-find-the-api-token (onde ver o token)
 *   developers.pipedrive.com/docs/api/v1/Persons, /Deals, /Organizations, /Activities, /Notes, /Pipelines, /Stages, /Users
 *
 * Ficou de fora de propósito:
 *   attendees em atividades: quem está na lista pode receber convite por e-mail, e aqui não se manda nada a ninguém.
 *   job_title em pessoas: a documentação diz que dá erro quando a sincronização de contatos não está ligada.
 *
 * Risco: atribuir a alguém (responsavel) pode avisar essa pessoa, então conta como envio; sem isso, só organiza.
 */
import { neutral } from '../../operations.ts';
import { linhaDe, type AcaoDecl, type ConectorDef } from './declarativo.ts';
import { ErroAcao, dia, seg, type Acao, type Args, type CtxAcao, type Param, type Risco } from '../tipos.ts';

const vazio = (v: unknown) => v === undefined || v === null || v === '';
/** Tira as etiquetas e desfaz o escape de paraHtml, por último o &amp;: o que foi escrito volta igual. O resultado passa por linhaDe antes de chegar ao agente. */
export const semHtml = (s: unknown) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** O conteúdo da nota é HTML: o texto vai como foi escrito, e cada quebra de linha fica. */
export const paraHtml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

/** Só o que veio preenchido, com o valor limpo por linhaDe: texto de terceiros nunca vira linha de controle. */
const ficha = (x: unknown, campos: Array<[string, string]>, max = 400): string =>
  campos.flatMap(([rotulo, campo]) => { const v = linhaDe(`{${campo}}`, x, max); return v ? [`${rotulo}: ${v}`] : []; }).join(', ');

/** O que a pessoa lê no cartão: cada campo preenchido, por extenso e sem cortar. */
const detalhes = (a: Args, rotulos: Record<string, string>): string =>
  Object.entries(rotulos).flatMap(([k, rotulo]) => (vazio(a[k]) ? [] : [`${rotulo}: ${String(a[k])}`])).join('\n');

const exigeAlgum = (...nomes: string[]) => async (_c: CtxAcao, a: Args): Promise<Args> => {
  if (!nomes.some((n) => !vazio(a[n]))) throw new ErroAcao(`diga pelo menos um destes: ${nomes.join(', ')}`);
  return a;
};
const riscoDeAtribuir = (a: Args): Risco => (vazio(a.responsavel) ? 'organizar' : 'enviar');

/** Na lista vêm objetos ({ value }); na busca, textos. */
const valores = (l: unknown): string => (Array.isArray(l) ? l.map((e) => (typeof e === 'string' ? e : e?.value)).filter(Boolean).join(' / ') : '');
const proximoCursor = (j: any) => j?.additional_data?.next_cursor;

const P_ID = (de: string): Param => ({ tipo: 'texto', obrigatorio: true, descricao: `id ${de}` });
const P_LIMITE: Param = { tipo: 'numero', descricao: 'quantos por página, até 500 (padrão 50)', padrao: 50, max: 500 };
const P_LIMITE_BUSCA: Param = { tipo: 'numero', descricao: 'quantos por página, até 100 (padrão 50)', padrao: 50, max: 100 };
const P_TERMO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'o que procurar, com pelo menos 2 letras' };
const P_RESPONSAVEL: Param = { tipo: 'numero', descricao: 'id do responsável (veja pipedrive.usuarios). A pessoa pode receber aviso, por isso conta como envio' };
const P_FILTRO_RESP: Param = { tipo: 'numero', descricao: 'só deste responsável (id, veja pipedrive.usuarios)' };
const P_PESSOA: Param = { tipo: 'numero', descricao: 'id da pessoa ligada' };
const P_ORG: Param = { tipo: 'numero', descricao: 'id da organização ligada' };
const P_NEG: Param = { tipo: 'numero', descricao: 'id do negócio ligado' };

const linhaPessoa = (x: any) => ficha({ ...x, mails: valores(x?.emails), fones: valores(x?.phones), org: x?.organization?.name }, [['nome', 'name'], ['id', 'id'], ['e-mail', 'mails'], ['telefone', 'fones'], ['organização', 'org'], ['id da organização', 'org_id']]);
const linhaOrg = (x: any) => ficha({ ...x, endereco: typeof x?.address === 'string' ? x.address : x?.address?.value }, [['nome', 'name'], ['id', 'id'], ['endereço', 'endereco'], ['site', 'website']]);
const linhaNegocio = (x: any) => ficha({ ...x, etapa: x?.stage?.name, id_etapa: x?.stage_id ?? x?.stage?.id, pessoa: x?.person?.name, id_pessoa: x?.person_id ?? x?.person?.id, org: x?.organization?.name, id_org: x?.org_id ?? x?.organization?.id }, [['título', 'title'], ['id', 'id'], ['valor', 'value'], ['moeda', 'currency'], ['situação', 'status'], ['etapa', 'etapa'], ['id da etapa', 'id_etapa'], ['funil', 'pipeline_id'], ['pessoa', 'pessoa'], ['id da pessoa', 'id_pessoa'], ['organização', 'org'], ['id da organização', 'id_org'], ['fechamento previsto', 'expected_close_date']]);
const linhaAtividade = (x: any) => ficha({ ...x, feita: x?.done === true ? 'sim' : x?.done === false ? 'não' : '', nota: semHtml(x?.note) }, [['assunto', 'subject'], ['id', 'id'], ['tipo', 'type'], ['data', 'due_date'], ['hora', 'due_time'], ['feita', 'feita'], ['negócio', 'deal_id'], ['pessoa', 'person_id'], ['organização', 'org_id'], ['responsável', 'owner_id'], ['nota', 'nota']]);
const linhaNota = (x: any) => ficha({ ...x, texto: semHtml(x?.content) }, [['id', 'id'], ['data', 'add_time'], ['negócio', 'deal_id'], ['pessoa', 'person_id'], ['organização', 'org_id'], ['texto', 'texto']], 2000);

const umItem = (linha: (x: any) => string) => (j: any) => (j?.data?.id !== undefined ? linha(j.data) : 'nada encontrado');
const ler = (id: string, caminho: string, nome: string, idDe: string, linha: (x: any) => string): AcaoDecl => ({
  id, descricao: `mostra ${nome} pelo id`, rotulo: `mostra ${nome}`, risco: 'ler', params: { id: P_ID(idDe) }, resumo: `Ler ${nome} {id} no Pipedrive`, metodo: 'GET', caminho, texto: umItem(linha),
});
/** A busca devolve data.items[].item. */
const buscar = (id: string, caminho: string, nome: string, linha: (x: any) => string, params: Record<string, Param>, consulta: Record<string, string>): AcaoDecl => ({
  id, descricao: `busca ${nome} por texto`, risco: 'ler', params: { termo: P_TERMO, ...params, limite: P_LIMITE_BUSCA }, resumo: `Buscar ${nome} no Pipedrive: {termo}`,
  metodo: 'GET', caminho, consulta: { term: '{termo}', limit: '{limite}', ...consulta }, lista: 'data.items', linha: (x: any) => linha(x?.item), proximo: proximoCursor,
});

const R_PESSOA = { id: 'pessoa', nome: 'nome', email: 'e-mail (troca os e-mails atuais por este)', telefone: 'telefone (troca os telefones atuais por este)', empresa: 'ligada à organização' };
const P_PESSOA_DADOS: Record<string, Param> = {
  email: { tipo: 'texto', descricao: 'e-mail. Ao atualizar, troca os e-mails atuais por este' }, telefone: { tipo: 'texto', descricao: 'telefone. Ao atualizar, troca os telefones atuais por este' }, empresa: P_ORG,
};
const corpoPessoa = (a: Args) => ({
  name: a.nome, org_id: a.empresa,
  ...(vazio(a.email) ? {} : { emails: [{ value: a.email, primary: true }] }), ...(vazio(a.telefone) ? {} : { phones: [{ value: a.telefone, primary: true }] }),
});

const R_NEGOCIO = { id: 'negócio', titulo: 'título', valor: 'valor', moeda: 'moeda', situacao: 'situação', motivo_perda: 'motivo da perda', funil: 'funil', etapa: 'etapa', fechamento: 'fechamento previsto', responsavel: 'responsável', pessoa: 'ligado à pessoa', empresa: 'ligado à organização' };
const P_NEGOCIO: Record<string, Param> = {
  valor: { tipo: 'numero', descricao: 'valor do negócio' }, moeda: { tipo: 'texto', descricao: 'moeda, como BRL' }, fechamento: { tipo: 'texto', descricao: 'fechamento previsto, como 2026-11-20' },
  responsavel: P_RESPONSAVEL, pessoa: P_PESSOA, empresa: P_ORG,
};
const corpoNegocio = (a: Args) => ({
  title: a.titulo, value: a.valor, currency: a.moeda, person_id: a.pessoa, org_id: a.empresa, owner_id: a.responsavel, pipeline_id: a.funil, stage_id: a.etapa,
  status: a.situacao, lost_reason: a.motivo_perda, expected_close_date: vazio(a.fechamento) ? undefined : dia(a, 'fechamento'),
});

const HORA = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** O cartão de confirmação diz o título do negócio e o nome da etapa: o agente só tem os ids. */
const CARTAO_MOVER: Acao['preparar'] = async (ctx, a) => {
  const caminhoDaEtapa = `/api/v2/stages/${seg(a.etapa)}`; // id errado é recusado antes de qualquer chamada
  const negocio = await ctx.http(`/api/v2/deals/${seg(a.id)}`, { method: 'GET', kind: 'read' });
  const etapa = await ctx.http(caminhoDaEtapa, { method: 'GET', kind: 'read' });
  return { detalhe: `Negócio: ${neutral(String(negocio?.data?.title ?? a.id), 200)}\nEtapa de destino: ${neutral(String(etapa?.data?.name ?? a.etapa), 120)}` };
};

/** O nome de cada registro, para o cartão: o agente só tem os ids. Só lê; id que não existe para aqui, antes do cartão. */
const NOMES: Record<string, { caminho: string; rotulo: string; nome: (d: any) => unknown }> = {
  pessoa: { caminho: '/api/v2/persons', rotulo: 'Pessoa', nome: (d) => d?.name },
  organizacao: { caminho: '/api/v2/organizations', rotulo: 'Organização', nome: (d) => d?.name },
  negocio: { caminho: '/api/v2/deals', rotulo: 'Negócio', nome: (d) => d?.title },
};
const cartaoDe = (campos: Record<string, keyof typeof NOMES>, antes?: (c: CtxAcao, a: Args) => Promise<Args>): Acao['preparar'] => async (ctx, a) => {
  if (antes) await antes(ctx, a); // o que o clique recusaria não vira cartão
  const linhas: string[] = [];
  for (const [k, tipo] of Object.entries(campos)) {
    if (vazio(a[k])) continue;
    const n = NOMES[tipo];
    const j = await ctx.http(`${n.caminho}/${seg(a[k])}`, { method: 'GET', kind: 'read' });
    linhas.push(`${n.rotulo}: ${neutral(String(n.nome(j?.data) || a[k]), 200)}`);
  }
  return { detalhe: linhas.join('\n') };
};

export const PIPEDRIVE: ConectorDef = {
  kind: 'pipedrive', nome: 'Pipedrive', site: 'pipedrive.com', grupo: 'vendas',
  sobre: 'Seu CRM no Pipedrive: os agentes buscam pessoas, organizações e negócios, veem atividades e notas, e criam ou atualizam pessoas, negócios, atividades e notas. As ações daqui não mandam mensagem; automações da sua conta continuam valendo.',
  campos: [{ name: 'token', label: 'Token de API pessoal', secret: true, placeholder: 'Cole o token de API aqui' }],
  ajuda: {
    url: 'https://app.pipedrive.com/settings/api',
    passos: 'No Pipedrive, clique no nome da sua conta, no canto superior direito, e abra "Company settings" › "Personal preferences" › "API" (o link "Abrir a página", no fim deste texto, vai direto para lá). Copie o token e cole aqui. Se "API" não aparecer, quem administra a conta precisa liberar o acesso à API para você. O token dá aos agentes o mesmo acesso do seu usuário, inclusive para escrever. Não gere outro token depois: o antigo para de funcionar e será preciso conectar de novo.',
  },
  base: 'https://api.pipedrive.com',
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ 'x-api-token': c.token }) },
  erroNoCorpo: (j) => (j?.success === false ? { mensagem: String(j.error ?? j.error_info ?? 'erro'), permissao: j.errorCode === 401 || j.errorCode === 403 } : null),
  quemSou: { caminho: '/v1/users/me', nome: (j) => { const n = j?.data?.name; const e = j?.data?.company_name; return String(n && e ? `${n} (${e})` : n ?? e ?? 'conta do Pipedrive'); },
    id: (j) => (j?.data?.id ? `${j.data.company_id ?? ''}:${j.data.id}` : null) },
  acoes: [
    { id: 'pipedrive.contatos', descricao: 'lista as pessoas (contatos), com filtros. Para procurar por nome, e-mail ou telefone, use pipedrive.buscar_contatos', rotulo: 'lista as pessoas (contatos), com filtros', risco: 'ler',
      params: { empresa: { tipo: 'numero', descricao: 'só desta organização (id)' }, negocio: { tipo: 'numero', descricao: 'só deste negócio (id)' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE },
      resumo: 'Listar as pessoas do Pipedrive', metodo: 'GET', caminho: '/api/v2/persons', consulta: { org_id: '{empresa}', deal_id: '{negocio}', owner_id: '{responsavel}', limit: '{limite}' },
      lista: 'data', linha: linhaPessoa, proximo: proximoCursor },
    buscar('pipedrive.buscar_contatos', '/api/v2/persons/search', 'pessoas', linhaPessoa, { empresa: { tipo: 'numero', descricao: 'só desta organização (id)' } }, { organization_id: '{empresa}' }),
    ler('pipedrive.contato', '/api/v2/persons/{id}', 'a pessoa', 'da pessoa', linhaPessoa),
    { id: 'pipedrive.empresas', descricao: 'lista as organizações (empresas). Para procurar por nome, use pipedrive.buscar_empresas', rotulo: 'lista as organizações (empresas)', risco: 'ler',
      params: { responsavel: P_FILTRO_RESP, limite: P_LIMITE }, resumo: 'Listar as organizações do Pipedrive', metodo: 'GET', caminho: '/api/v2/organizations', consulta: { owner_id: '{responsavel}', limit: '{limite}' },
      lista: 'data', linha: linhaOrg, proximo: proximoCursor },
    buscar('pipedrive.buscar_empresas', '/api/v2/organizations/search', 'organizações', linhaOrg, {}, {}),
    ler('pipedrive.empresa', '/api/v2/organizations/{id}', 'a organização', 'da organização', linhaOrg),
    { id: 'pipedrive.negocios', descricao: 'lista os negócios, com filtros. Para procurar por título, use pipedrive.buscar_negocios', rotulo: 'lista os negócios, com filtros', risco: 'ler',
      params: {
        situacao: { tipo: 'texto', descricao: 'só nesta situação', opcoes: ['open', 'won', 'lost'] }, funil: { tipo: 'numero', descricao: 'só deste funil (id)' }, etapa: { tipo: 'numero', descricao: 'só desta etapa (id)' },
        pessoa: { tipo: 'numero', descricao: 'só desta pessoa (id)' }, empresa: { tipo: 'numero', descricao: 'só desta organização (id)' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE,
      },
      resumo: 'Listar os negócios do Pipedrive', metodo: 'GET', caminho: '/api/v2/deals',
      consulta: { status: '{situacao}', pipeline_id: '{funil}', stage_id: '{etapa}', person_id: '{pessoa}', org_id: '{empresa}', owner_id: '{responsavel}', limit: '{limite}' }, lista: 'data', linha: linhaNegocio, proximo: proximoCursor },
    buscar('pipedrive.buscar_negocios', '/api/v2/deals/search', 'negócios', linhaNegocio,
      { situacao: { tipo: 'texto', descricao: 'só nesta situação', opcoes: ['open', 'won', 'lost'] }, pessoa: { tipo: 'numero', descricao: 'só desta pessoa (id)' }, empresa: { tipo: 'numero', descricao: 'só desta organização (id)' } },
      { status: '{situacao}', person_id: '{pessoa}', organization_id: '{empresa}' }),
    ler('pipedrive.negocio', '/api/v2/deals/{id}', 'o negócio', 'do negócio', linhaNegocio),
    { id: 'pipedrive.funis', descricao: 'lista os funis de vendas, com os ids', rotulo: 'lista os funis de vendas', risco: 'ler', params: { limite: P_LIMITE }, resumo: 'Listar os funis do Pipedrive',
      metodo: 'GET', caminho: '/api/v2/pipelines', consulta: { limit: '{limite}' }, lista: 'data', linha: '{name} (id: {id})', proximo: proximoCursor },
    { id: 'pipedrive.etapas', descricao: 'lista as etapas dos funis, com os ids que mover_negocio usa', rotulo: 'lista as etapas dos funis', risco: 'ler', params: { funil: { tipo: 'numero', descricao: 'só deste funil (id)' }, limite: P_LIMITE },
      resumo: 'Listar as etapas dos funis do Pipedrive', metodo: 'GET', caminho: '/api/v2/stages', consulta: { pipeline_id: '{funil}', limit: '{limite}' },
      lista: 'data', linha: '{name} (id: {id}, funil: {pipeline_id}, ordem: {order_nr})', proximo: proximoCursor },
    { id: 'pipedrive.atividades', descricao: 'lista as atividades, por data', risco: 'ler',
      params: {
        feita: { tipo: 'booleano', descricao: 'true: só as feitas; false: só as pendentes' }, negocio: { tipo: 'numero', descricao: 'só deste negócio (id)' }, pessoa: { tipo: 'numero', descricao: 'só desta pessoa (id)' },
        empresa: { tipo: 'numero', descricao: 'só desta organização (id)' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE,
      },
      resumo: 'Listar as atividades do Pipedrive', metodo: 'GET', caminho: '/api/v2/activities',
      consulta: { done: '{feita}', deal_id: '{negocio}', person_id: '{pessoa}', org_id: '{empresa}', owner_id: '{responsavel}', sort_by: 'due_date', limit: '{limite}' }, lista: 'data', linha: linhaAtividade, proximo: proximoCursor },
    { id: 'pipedrive.notas', descricao: 'lista as notas, de um negócio, pessoa ou organização', risco: 'ler',
      params: { negocio: { tipo: 'numero', descricao: 'só deste negócio (id)' }, pessoa: { tipo: 'numero', descricao: 'só desta pessoa (id)' }, empresa: { tipo: 'numero', descricao: 'só desta organização (id)' }, limite: { tipo: 'numero', descricao: 'quantas por página, até 100 (padrão 50)', padrao: 50, max: 100 } },
      resumo: 'Listar as notas do Pipedrive', metodo: 'GET', caminho: '/v1/notes', consulta: { deal_id: '{negocio}', person_id: '{pessoa}', org_id: '{empresa}', limit: '{limite}' },
      lista: 'data', linha: linhaNota, paramCursor: 'start',
      proximo: (j) => { const p = j?.additional_data?.pagination; return p?.more_items_in_collection ? String(p.next_start) : null; } },
    { id: 'pipedrive.usuarios', descricao: 'lista as pessoas da conta, com o id que serve de responsável', rotulo: 'lista as pessoas da conta', risco: 'ler', params: {}, resumo: 'Listar as pessoas da conta do Pipedrive',
      metodo: 'GET', caminho: '/v1/users', lista: 'data', linha: '{name} (id: {id}, e-mail: {email})' },

    { id: 'pipedrive.criar_contato', descricao: 'cria uma pessoa (contato). Não manda nada a ela', risco: 'organizar',
      params: { nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome da pessoa' }, ...P_PESSOA_DADOS }, resumo: (a) => `Criar uma pessoa no Pipedrive:\n${detalhes(a, R_PESSOA)}`,
      metodo: 'POST', caminho: '/api/v2/persons', corpo: corpoPessoa, texto: 'Pessoa criada (id: {data.id}).' },
    { id: 'pipedrive.atualizar_contato', descricao: 'muda dados de uma pessoa: só o que for informado', risco: 'organizar',
      params: { id: P_ID('da pessoa'), nome: { tipo: 'texto', descricao: 'novo nome' }, ...P_PESSOA_DADOS }, resumo: (a) => `Atualizar uma pessoa no Pipedrive:\n${detalhes(a, R_PESSOA)}`,
      preparar: cartaoDe({ id: 'pessoa' }, exigeAlgum('nome', ...Object.keys(P_PESSOA_DADOS))),
      metodo: 'PATCH', caminho: '/api/v2/persons/{id}', antes: exigeAlgum('nome', ...Object.keys(P_PESSOA_DADOS)), corpo: corpoPessoa, texto: 'Pessoa atualizada (id: {data.id}).' },
    { id: 'pipedrive.criar_negocio', descricao: 'cria um negócio. Veja os ids em pipedrive.funis e pipedrive.etapas', rotulo: 'cria um negócio', risco: riscoDeAtribuir,
      params: { titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título do negócio' }, funil: { tipo: 'numero', descricao: 'id do funil' }, etapa: { tipo: 'numero', descricao: 'id da etapa' }, ...P_NEGOCIO },
      resumo: (a) => `Criar um negócio no Pipedrive:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'POST', caminho: '/api/v2/deals', corpo: corpoNegocio, texto: 'Negócio criado (id: {data.id}).' },
    { id: 'pipedrive.atualizar_negocio', descricao: 'muda dados de um negócio, inclusive ganho ou perdido: só o que for informado. Para trocar de etapa, use pipedrive.mover_negocio', rotulo: 'muda dados de um negócio, inclusive ganho ou perdido: só o que for informado', risco: riscoDeAtribuir,
      params: {
        id: P_ID('do negócio'), titulo: { tipo: 'texto', descricao: 'novo título' }, ...P_NEGOCIO,
        situacao: { tipo: 'texto', descricao: 'situação do negócio', opcoes: ['open', 'won', 'lost'] }, motivo_perda: { tipo: 'texto', descricao: 'motivo, quando a situação for lost' },
      },
      resumo: (a) => `Atualizar um negócio no Pipedrive:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'PATCH', caminho: '/api/v2/deals/{id}',
      preparar: cartaoDe({ id: 'negocio' }, exigeAlgum('titulo', 'situacao', 'motivo_perda', ...Object.keys(P_NEGOCIO))),
      antes: exigeAlgum('titulo', 'situacao', 'motivo_perda', ...Object.keys(P_NEGOCIO)), corpo: corpoNegocio, texto: 'Negócio atualizado (id: {data.id}).' },
    { id: 'pipedrive.mover_negocio', descricao: 'leva um negócio para outra etapa. Veja os ids em pipedrive.etapas', rotulo: 'leva um negócio para outra etapa', risco: 'organizar',
      params: { id: P_ID('do negócio'), etapa: { tipo: 'numero', obrigatorio: true, descricao: 'id da etapa de destino' }, funil: { tipo: 'numero', descricao: 'id do funil, se a etapa for de outro funil' } },
      resumo: (a) => `Mover o negócio ${String(a.id)} do Pipedrive para a etapa ${String(a.etapa)}${vazio(a.funil) ? '' : ` do funil ${String(a.funil)}`}`, preparar: CARTAO_MOVER,
      metodo: 'PATCH', caminho: '/api/v2/deals/{id}', corpo: { stage_id: '{etapa}', pipeline_id: '{funil}' }, texto: 'Negócio movido (id: {data.id}).' },
    { id: 'pipedrive.criar_atividade', descricao: 'cria uma atividade, ligada ou não a um negócio, pessoa ou organização. Não manda convite a ninguém', risco: riscoDeAtribuir,
      params: {
        assunto: { tipo: 'texto', obrigatorio: true, descricao: 'assunto da atividade' }, tipo: { tipo: 'texto', descricao: 'tipo da atividade na sua conta, como call, meeting ou task' },
        data: { tipo: 'texto', descricao: 'data, como 2026-11-20' }, hora: { tipo: 'texto', descricao: 'hora em UTC, como 15:00 ou 15:00:00 (12h em Brasília)' }, nota: { tipo: 'texto', descricao: 'anotação' },
        responsavel: P_RESPONSAVEL, negocio: P_NEG, pessoa: P_PESSOA, empresa: P_ORG,
      },
      resumo: (a) => `Criar uma atividade no Pipedrive:\n${detalhes(a, { assunto: 'assunto', tipo: 'tipo', data: 'data', hora: 'hora (UTC)', nota: 'nota', responsavel: 'responsável', negocio: 'ligada ao negócio', pessoa: 'ligada à pessoa', empresa: 'ligada à organização' })}`,
      metodo: 'POST', caminho: '/api/v2/activities',
      corpo: (a: Args) => {
        if (!vazio(a.hora) && !HORA.test(String(a.hora))) throw new ErroAcao('"hora" precisa estar no formato 15:00 ou 15:00:00');
        return { subject: a.assunto, type: a.tipo, due_date: vazio(a.data) ? undefined : dia(a, 'data'), due_time: a.hora, note: vazio(a.nota) ? undefined : paraHtml(a.nota), owner_id: a.responsavel, deal_id: a.negocio, org_id: a.empresa, ...(vazio(a.pessoa) ? {} : { participants: [{ person_id: a.pessoa, primary: true }] }) };
      },
      texto: 'Atividade criada (id: {data.id}).' },
    { id: 'pipedrive.registrar_nota', descricao: 'registra uma nota interna num negócio, pessoa ou organização. Não manda nada ao cliente', risco: 'organizar',
      params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'o texto da nota' }, negocio: P_NEG, pessoa: P_PESSOA, empresa: P_ORG },
      resumo: (a) => `Registrar uma nota no Pipedrive:\n${detalhes(a, { negocio: 'no negócio', pessoa: 'na pessoa', empresa: 'na organização', texto: 'texto' })}`,
      preparar: cartaoDe({ negocio: 'negocio', pessoa: 'pessoa', empresa: 'organizacao' }, exigeAlgum('negocio', 'pessoa', 'empresa')),
      metodo: 'POST', caminho: '/v1/notes', antes: exigeAlgum('negocio', 'pessoa', 'empresa'),
      corpo: (a: Args) => ({ content: paraHtml(a.texto), deal_id: a.negocio, person_id: a.pessoa, org_id: a.empresa }), texto: 'Nota registrada (id: {data.id}).' },
  ],
};

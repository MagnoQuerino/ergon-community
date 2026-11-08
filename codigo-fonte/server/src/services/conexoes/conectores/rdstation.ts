/**
 * RD Station CRM: contatos, empresas, negociações, tarefas e anotações. Nenhuma ação manda e-mail nem mensagem a cliente.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   developers.rdstation.com/reference/crm-v1-introducao-e-requisitos (token do usuário; planos Basic, Pro e Advanced; 120 por minuto)
 *   developers.rdstation.com/reference/crm-v1-token e crm-v1-token-check (token único por usuário, na consulta; visibilidade do usuário)
 *   developers.rdstation.com/reference/crm-v1-mensagens-de-erro (formatos de erro)
 *   developers.rdstation.com/reference/crm-v1-{list,get,create,update}-{contact(s),deal(s),task(s)}, crm-v1-{list,get}-organization(s)
 *   developers.rdstation.com/reference/crm-v1-{list,create}-activit(y|ies), crm-v1-list-pipelines, crm-v1-list-users, crm-v1-get-current-user
 *   ajuda.rdstation.com/s/article/Gerar-e-visualizar-Token (onde ver o token)
 *   developers.rdstation.com/reference/crm-v2-authentication (a v2 só aceita OAuth2, com token de 2 horas: por isso a v1 aqui)
 *
 * Usa a API v1 porque só ela tem token fixo, que uma pessoa leiga consegue copiar. O token vai na consulta, em toda chamada, pelo
 * `auth` do motor: não há cabeçalho para ele. Nunca vem dos parâmetros, e não entra em resumo nem em texto de resultado.
 * Na v1, o valor da negociação vem dos produtos dela e a anotação só existe em negociação: por isso não há "valor" nem nota em contato.
 *
 * Risco: atribuir a alguém (responsavel) pode avisar essa pessoa, então conta como envio; sem isso, só organiza.
 */
import { neutral } from '../../operations.ts';
import { linhaDe, type AcaoDecl, type ConectorDef } from './declarativo.ts';
import { ErroAcao, dia, seg, type Acao, type Args, type CtxAcao, type Param, type Risco } from '../tipos.ts';

const vazio = (v: unknown) => v === undefined || v === null || v === '';

/** Só o que veio preenchido, com o valor limpo por linhaDe: texto de terceiros nunca vira linha de controle. */
const ficha = (x: unknown, campos: Array<[string, string]>, max = 400): string =>
  campos.flatMap(([rotulo, campo]) => { const v = linhaDe(`{${campo}}`, x, max); return v ? [`${rotulo}: ${v}`] : []; }).join(', ');

/** O que a pessoa lê no cartão: cada campo preenchido, por extenso e sem cortar. */
const detalhes = (a: Args, rotulos: Record<string, string>): string =>
  Object.entries(rotulos).flatMap(([k, rotulo]) => (vazio(a[k]) ? [] : [`${rotulo}: ${String(a[k])}`])).join('\n');

const riscoDeAtribuir = (a: Args): Risco => (vazio(a.responsavel) ? 'organizar' : 'enviar');

const exigeAlgum = (...nomes: string[]) => async (_c: CtxAcao, a: Args): Promise<Args> => {
  if (!nomes.some((n) => !vazio(a[n]))) throw new ErroAcao(`diga pelo menos um destes: ${nomes.join(', ')}`);
  return a;
};
/** Quem tem o token: autor da anotação e responsável padrão, já que os exemplos da documentação sempre informam um. */
const euMesmo = async (ctx: CtxAcao): Promise<string> => {
  const j = await ctx.http('/users/me');
  if (!j?.id) throw new ErroAcao('não consegui saber de quem é o token do RD Station CRM');
  return String(j.id);
};

const P_LIMITE: Param = { tipo: 'numero', descricao: 'quantos por página, até 200 (padrão 50)', padrao: 50, max: 200 };
const P_ID = (de: string): Param => ({ tipo: 'texto', obrigatorio: true, descricao: `id ${de}` });
const P_RESPONSAVEL: Param = { tipo: 'texto', descricao: 'id do responsável (veja rdstation.usuarios). A pessoa pode receber aviso, por isso conta como envio. Sem ele, fica com o dono do token' };
const P_FILTRO_RESP: Param = { tipo: 'texto', descricao: 'só deste responsável (id, veja rdstation.usuarios)' };

/** A resposta diz só se tem mais (has_more), sem o número da página: o cursor é a próxima página. */
const proximaPagina = (chave: string) => (j: any, a: Args): string | null => {
  const l: unknown[] = Array.isArray(j?.[chave]) ? j[chave] : [];
  const tem = typeof j?.has_more === 'boolean' ? j.has_more : l.length > 0 && l.length >= Number(a.limite ?? 20);
  return tem ? String(Number(a.cursor ?? 1) + 1) : null;
};
/** Nestas listas o cursor é o número da página: outra coisa viraria uma próxima página sem sentido. */
const paginaOk = async (_c: CtxAcao, a: Args): Promise<Args> => {
  if (!vazio(a.cursor) && !/^[1-9]\d*$/.test(String(a.cursor))) throw new ErroAcao('"cursor" precisa ser o número da página: use o que veio em "cursor" na resposta anterior');
  return a;
};
const varios = (l: unknown, campo: string): string => (Array.isArray(l) ? l.map((e) => e?.[campo]).filter(Boolean).join(' / ') : '');

const linhaContato = (x: any) => ficha({ ...x, mails: varios(x?.emails, 'email'), fones: varios(x?.phones, 'phone') }, [['nome', 'name'], ['id', 'id'], ['e-mail', 'mails'], ['telefone', 'fones'], ['cargo', 'title'], ['empresa', 'organization.name'], ['id da empresa', 'organization_id']]);
const linhaEmpresa = (x: any) => ficha(x, [['nome', 'name'], ['id', 'id'], ['site', 'url'], ['endereço', 'address'], ['resumo', 'resume'], ['responsável', 'user.name']]);
const linhaNegocio = (x: any) => ficha({ ...x, situacao: x?.win === true ? 'ganha' : x?.win === false ? 'perdida' : x?.hold ? 'pausada' : 'em aberto' }, [['nome', 'name'], ['id', 'id'], ['situação', 'situacao'], ['valor total', 'amount_total'], ['etapa', 'deal_stage.name'], ['id da etapa', 'deal_stage.id'], ['empresa', 'organization.name'], ['id da empresa', 'organization.id'], ['responsável', 'user.name'], ['previsão', 'prediction_date']]);
const linhaTarefa = (x: any) => ficha({ ...x, feita: x?.done === true ? 'sim' : 'não', negocio: x?.deal?.name, resp: varios(x?.users, 'name') }, [['assunto', 'subject'], ['id', 'id'], ['tipo', 'type'], ['data', 'date'], ['hora', 'hour'], ['feita', 'feita'], ['negociação', 'negocio'], ['id da negociação', 'deal_id'], ['responsável', 'resp'], ['anotações', 'notes']]);
const linhaNota = (x: any) => ficha(x, [['id', 'id'], ['data', 'date'], ['negociação', 'deal_id'], ['autor', 'user_id'], ['texto', 'text']], 2000);

const ler = (id: string, caminho: string, nome: string, idDe: string, linha: (x: any) => string): AcaoDecl => ({
  id, descricao: `mostra ${nome} pelo id`, rotulo: `mostra ${nome}`, risco: 'ler', params: { id: P_ID(idDe) }, resumo: `Ler ${nome} {id} no RD Station CRM`, metodo: 'GET', caminho,
  texto: (j) => (j?.id || j?._id ? linha(j) : 'nada encontrado'),
});

const P_CONTATO: Record<string, Param> = {
  email: { tipo: 'texto', descricao: 'e-mail. Ao atualizar, troca os e-mails atuais por este' }, telefone: { tipo: 'texto', descricao: 'telefone. Ao atualizar, troca os telefones atuais por este' },
  cargo: { tipo: 'texto', descricao: 'cargo' }, empresa: { tipo: 'texto', descricao: 'id da empresa' },
};
const R_CONTATO = { id: 'contato', nome: 'nome', email: 'e-mail (troca os e-mails atuais por este)', telefone: 'telefone (troca os telefones atuais por este)', cargo: 'cargo', empresa: 'ligado à empresa', negocio: 'ligado à negociação' };
const corpoContato = (a: Args) => ({
  contact: {
    name: a.nome, title: a.cargo, organization_id: a.empresa,
    ...(vazio(a.email) ? {} : { emails: [{ email: a.email }] }), ...(vazio(a.telefone) ? {} : { phones: [{ phone: a.telefone, type: 'work' }] }), ...(vazio(a.negocio) ? {} : { deal_ids: [a.negocio] }),
  },
});

const R_NEGOCIO = { id: 'negociação', nome: 'nome', etapa: 'etapa', previsao: 'previsão de fechamento', ganha: 'ganha', responsavel: 'responsável', empresa: 'ligada à empresa' };
const P_PREVISAO: Param = { tipo: 'texto', descricao: 'previsão de fechamento, como 2026-11-20' };
const HORA = /^\d{2}:\d{2}$/;

/** O cartão de confirmação diz o nome da negociação e o da etapa: o agente só tem os ids. */
const CARTAO_MOVER: Acao['preparar'] = async (ctx, a) => {
  const negocio = await ctx.http(`/deals/${seg(a.id)}`, { method: 'GET', kind: 'read' });
  const funis = await ctx.http('/deal_pipelines?limit=200', { method: 'GET', kind: 'read' });
  for (const f of Array.isArray(funis) ? funis : []) {
    const etapa = (f?.deal_stages ?? []).find((e: any) => String(e?.id ?? e?._id) === String(a.etapa));
    if (etapa) return { detalhe: `Negociação: ${neutral(String(negocio?.name ?? a.id), 200)}\nEtapa de destino: ${neutral(String(etapa.name ?? a.etapa), 120)} (funil ${neutral(String(f.name ?? f.id), 120)})` };
  }
  throw new ErroAcao(`não achei a etapa "${neutral(String(a.etapa), 60)}": veja os ids em rdstation.funis`);
};

/** O nome do registro, para o cartão: o agente só tem o id. Só lê; id que não existe para aqui, antes do cartão. */
const cartaoDe = (campo: string, caminho: '/contacts' | '/deals', rotulo: string, antes?: (c: CtxAcao, a: Args) => Promise<Args>): Acao['preparar'] => async (ctx, a) => {
  if (antes) await antes(ctx, a); // o que o clique recusaria não vira cartão
  const j = await ctx.http(`${caminho}/${seg(a[campo])}`, { method: 'GET', kind: 'read' });
  return { detalhe: `${rotulo}: ${neutral(String(j?.name || a[campo]), 200)}` };
};

export const RDSTATION: ConectorDef = {
  kind: 'rdstation', nome: 'RD Station CRM', site: 'rdstation.com', grupo: 'vendas',
  sobre: 'Seu RD Station CRM: os agentes buscam contatos, empresas e negociações, veem tarefas e anotações, e criam ou atualizam contatos, negociações, tarefas e anotações. As ações daqui não mandam mensagem; automações da sua conta continuam valendo.',
  campos: [{ name: 'token', label: 'Token de API', secret: true, placeholder: 'Cole o token do RD Station CRM aqui' }],
  ajuda: {
    url: 'https://crm.rdstation.com/',
    passos: 'Entre na sua conta do RD Station CRM (planos Basic, Pro ou Advanced). Nas preferências, abra a aba "Token de API". Se o código não aparecer, clique em "Gerar Token". Copie e cole aqui. O token serve para ler e para escrever, e os agentes veem o que o seu usuário vê: se a visibilidade dele for restrita, só veem o que está com você. Não use "Desativar token": isso desfaz as integrações feitas com ele.',
  },
  base: 'https://crm.rdstation.com/api/v1',
  auth: { tipo: 'consulta', parametro: 'token' },
  erroNoCorpo: (j) => {
    const e = j?.error ?? j?.errors;
    if (!e || (typeof e === 'object' && !Object.keys(e).length)) return null;
    const m = typeof e === 'string' ? e : JSON.stringify(e);
    return { mensagem: m, permissao: /permission denied|forbidden|access_denied|unauthorized/i.test(m) };
  },
  quemSou: { caminho: '/token/check', nome: (j) => String(j?.name && j?.organization ? `${j.name} (${j.organization})` : j?.name ?? j?.organization ?? 'conta do RD Station CRM') },
  acoes: [
    { id: 'rdstation.contatos', descricao: 'busca contatos por nome, e-mail ou telefone; sem filtro, lista', risco: 'ler',
      params: { busca: { tipo: 'texto', descricao: 'nome do contato' }, email: { tipo: 'texto', descricao: 'e-mail' }, telefone: { tipo: 'texto', descricao: 'telefone' }, limite: P_LIMITE },
      resumo: (a) => `Buscar contatos no RD Station CRM${[a.busca, a.email, a.telefone].some((v) => !vazio(v)) ? `: ${[a.busca, a.email, a.telefone].filter((v) => !vazio(v)).join(', ')}` : ''}`,
      metodo: 'GET', caminho: '/contacts', antes: paginaOk, consulta: { q: '{busca}', email: '{email}', phone: '{telefone}', limit: '{limite}' }, lista: 'contacts', linha: linhaContato, proximo: proximaPagina('contacts'), paramCursor: 'page' },
    ler('rdstation.contato', '/contacts/{id}', 'o contato', 'do contato', linhaContato),
    { id: 'rdstation.empresas', descricao: 'busca empresas por nome; sem filtro, lista', risco: 'ler',
      params: { busca: { tipo: 'texto', descricao: 'nome da empresa' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE },
      resumo: (a) => (vazio(a.busca) ? 'Listar as empresas do RD Station CRM' : `Buscar empresas no RD Station CRM: ${String(a.busca)}`),
      metodo: 'GET', caminho: '/organizations', antes: paginaOk, consulta: { q: '{busca}', user_id: '{responsavel}', limit: '{limite}' }, lista: 'organizations', linha: linhaEmpresa, proximo: proximaPagina('organizations'), paramCursor: 'page' },
    ler('rdstation.empresa', '/organizations/{id}', 'a empresa', 'da empresa', linhaEmpresa),
    { id: 'rdstation.negocios', descricao: 'busca negociações por nome, situação, etapa, funil ou empresa; sem filtro, lista', risco: 'ler',
      params: {
        busca: { tipo: 'texto', descricao: 'nome da negociação' }, situacao: { tipo: 'texto', descricao: 'só nesta situação', opcoes: ['aberta', 'ganha', 'perdida'] }, etapa: { tipo: 'texto', descricao: 'só desta etapa (id, veja rdstation.funis)' },
        funil: { tipo: 'texto', descricao: 'só deste funil (id, veja rdstation.funis)' }, empresa: { tipo: 'texto', descricao: 'só desta empresa (id)' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE,
      },
      resumo: (a) => (vazio(a.busca) ? 'Listar as negociações do RD Station CRM' : `Buscar negociações no RD Station CRM: ${String(a.busca)}`), metodo: 'GET', caminho: '/deals',
      antes: async (_c, a) => ({ ...a, win: a.situacao === 'ganha' ? 'true' : a.situacao === 'perdida' ? 'false' : a.situacao === 'aberta' ? 'null' : undefined }),
      consulta: { name: '{busca}', win: '{win}', deal_stage_id: '{etapa}', deal_pipeline_id: '{funil}', organization: '{empresa}', user_id: '{responsavel}', limit: '{limite}' },
      lista: 'deals', linha: linhaNegocio, proximo: (j) => (j?.has_more ? j.next_page : null), paramCursor: 'next_page' },
    ler('rdstation.negocio', '/deals/{id}', 'a negociação', 'da negociação', linhaNegocio),
    { id: 'rdstation.funis', descricao: 'lista os funis de vendas e as etapas de cada um, com os ids que mover_negocio usa', rotulo: 'lista os funis de vendas e as etapas de cada um', risco: 'ler', params: {}, resumo: 'Listar os funis do RD Station CRM',
      metodo: 'GET', caminho: '/deal_pipelines', consulta: { limit: 200 }, lista: '',
      linha: (x: any) => `${ficha(x, [['funil', 'name'], ['id', 'id']])}; etapas: ${(x?.deal_stages ?? []).map((e: any) => linhaDe('{name} (id: {id})', e)).join(', ')}` },
    { id: 'rdstation.tarefas', descricao: 'lista tarefas, com filtros', risco: 'ler',
      params: {
        negocio: { tipo: 'texto', descricao: 'só desta negociação (id)' }, feita: { tipo: 'booleano', descricao: 'true: só as feitas; false: só as pendentes' }, tipo: { tipo: 'texto', descricao: 'só deste tipo', opcoes: ['call', 'email', 'meeting', 'task', 'lunch', 'visit', 'whatsapp'] },
        responsavel: P_FILTRO_RESP, limite: P_LIMITE,
      },
      resumo: 'Listar as tarefas do RD Station CRM', metodo: 'GET', caminho: '/tasks', antes: paginaOk,
      consulta: { deal_id: '{negocio}', done: '{feita}', type: '{tipo}', user_id: '{responsavel}', limit: '{limite}' }, lista: 'tasks', linha: linhaTarefa, proximo: proximaPagina('tasks'), paramCursor: 'page' },
    { id: 'rdstation.notas', descricao: 'lista as anotações de uma negociação', risco: 'ler',
      params: { negocio: { tipo: 'texto', obrigatorio: true, descricao: 'id da negociação' }, limite: P_LIMITE },
      resumo: 'Listar as anotações da negociação {negocio} no RD Station CRM', metodo: 'GET', caminho: '/activities', antes: paginaOk,
      consulta: { deal_id: '{negocio}', type: 'note', limit: '{limite}' }, lista: 'activities', linha: linhaNota, proximo: proximaPagina('activities'), paramCursor: 'page' },
    { id: 'rdstation.usuarios', descricao: 'lista as pessoas da conta, com o id que serve de responsável', rotulo: 'lista as pessoas da conta', risco: 'ler', params: {}, resumo: 'Listar as pessoas da conta do RD Station CRM',
      metodo: 'GET', caminho: '/users', lista: 'users', linha: '{name} (id: {id}, e-mail: {email})' },

    { id: 'rdstation.criar_contato', descricao: 'cria um contato. Não manda nada a ele', risco: 'organizar',
      params: { nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome do contato' }, ...P_CONTATO, negocio: { tipo: 'texto', descricao: 'id da negociação a que o contato pertence' } },
      resumo: (a) => `Criar um contato no RD Station CRM:\n${detalhes(a, R_CONTATO)}`, metodo: 'POST', caminho: '/contacts', corpo: corpoContato, texto: 'Contato criado (id: {id}).' },
    { id: 'rdstation.atualizar_contato', descricao: 'muda dados de um contato: só o que for informado', risco: 'organizar',
      params: { id: P_ID('do contato'), nome: { tipo: 'texto', descricao: 'novo nome' }, ...P_CONTATO }, resumo: (a) => `Atualizar um contato no RD Station CRM:\n${detalhes(a, R_CONTATO)}`,
      preparar: cartaoDe('id', '/contacts', 'Contato', exigeAlgum('nome', ...Object.keys(P_CONTATO))),
      metodo: 'PUT', caminho: '/contacts/{id}', antes: exigeAlgum('nome', ...Object.keys(P_CONTATO)), corpo: corpoContato, texto: 'Contato atualizado (id: {id}).' },
    { id: 'rdstation.criar_negocio', descricao: 'cria uma negociação. Veja os ids das etapas em rdstation.funis', rotulo: 'cria uma negociação', risco: riscoDeAtribuir,
      params: { nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome da negociação' }, etapa: { tipo: 'texto', descricao: 'id da etapa' }, previsao: P_PREVISAO, responsavel: P_RESPONSAVEL, empresa: { tipo: 'texto', descricao: 'id da empresa' } },
      resumo: (a) => `Criar uma negociação no RD Station CRM:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'POST', caminho: '/deals',
      antes: async (ctx, a) => ({ ...a, dono: a.responsavel ?? await euMesmo(ctx) }),
      corpo: (a: Args) => ({ deal: { name: a.nome, deal_stage_id: a.etapa, prediction_date: vazio(a.previsao) ? undefined : dia(a, 'previsao'), user_id: a.dono }, ...(vazio(a.empresa) ? {} : { organization: { _id: a.empresa } }) }),
      texto: 'Negociação criada (id: {id}).' },
    { id: 'rdstation.atualizar_negocio', descricao: 'muda dados de uma negociação, inclusive ganha ou perdida: só o que for informado. Para trocar de etapa, use rdstation.mover_negocio', rotulo: 'muda dados de uma negociação, inclusive ganha ou perdida: só o que for informado', risco: riscoDeAtribuir,
      params: {
        id: P_ID('da negociação'), nome: { tipo: 'texto', descricao: 'novo nome' }, previsao: P_PREVISAO, ganha: { tipo: 'booleano', descricao: 'true: ganha; false: perdida' },
        responsavel: P_RESPONSAVEL, empresa: { tipo: 'texto', descricao: 'id da empresa' },
      },
      resumo: (a) => `Atualizar uma negociação no RD Station CRM:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'PUT', caminho: '/deals/{id}',
      preparar: cartaoDe('id', '/deals', 'Negociação', exigeAlgum('nome', 'previsao', 'ganha', 'responsavel', 'empresa')),
      antes: exigeAlgum('nome', 'previsao', 'ganha', 'responsavel', 'empresa'),
      corpo: (a: Args) => ({ deal: { name: a.nome, prediction_date: vazio(a.previsao) ? undefined : dia(a, 'previsao'), win: a.ganha, user_id: a.responsavel, organization_id: a.empresa } }),
      texto: 'Negociação atualizada (id: {id}).' },
    { id: 'rdstation.mover_negocio', descricao: 'leva uma negociação para outra etapa. Veja os ids em rdstation.funis', rotulo: 'leva uma negociação para outra etapa', risco: 'organizar',
      params: { id: P_ID('da negociação'), etapa: { tipo: 'texto', obrigatorio: true, descricao: 'id da etapa de destino' } },
      resumo: 'Mover a negociação {id} do RD Station CRM para a etapa {etapa}', preparar: CARTAO_MOVER, metodo: 'PUT', caminho: '/deals/{id}',
      corpo: { deal_stage_id: '{etapa}' }, texto: 'Negociação movida (id: {id}).' },
    { id: 'rdstation.criar_tarefa', descricao: 'cria uma tarefa numa negociação. Não manda nada ao cliente', risco: riscoDeAtribuir,
      params: {
        assunto: { tipo: 'texto', obrigatorio: true, descricao: 'assunto, com pelo menos 3 letras' }, negocio: { tipo: 'texto', obrigatorio: true, descricao: 'id da negociação' }, data: { tipo: 'texto', obrigatorio: true, descricao: 'data, como 2026-11-20' },
        hora: { tipo: 'texto', descricao: 'hora, como 15:00' }, tipo: { tipo: 'texto', descricao: 'tipo da tarefa', opcoes: ['call', 'email', 'meeting', 'task', 'lunch', 'visit', 'whatsapp'], padrao: 'task' },
        anotacoes: { tipo: 'texto', descricao: 'anotações da tarefa' }, responsavel: P_RESPONSAVEL,
      },
      resumo: (a) => `Criar uma tarefa no RD Station CRM:\n${detalhes(a, { assunto: 'assunto', negocio: 'na negociação', data: 'data', hora: 'hora', tipo: 'tipo', anotacoes: 'anotações', responsavel: 'responsável' })}`,
      metodo: 'POST', caminho: '/tasks',
      antes: async (ctx, a) => {
        if (!vazio(a.hora) && !HORA.test(String(a.hora))) throw new ErroAcao('"hora" precisa estar no formato 15:00');
        return { ...a, dono: a.responsavel ?? await euMesmo(ctx) };
      },
      corpo: (a: Args) => ({ task: { subject: a.assunto, deal_id: a.negocio, date: dia(a, 'data'), hour: a.hora, type: a.tipo, notes: a.anotacoes, user_ids: [a.dono] } }),
      texto: 'Tarefa criada (id: {id}).' },
    { id: 'rdstation.registrar_nota', descricao: 'registra uma anotação interna numa negociação. Não manda nada ao cliente', risco: 'organizar',
      params: { negocio: { tipo: 'texto', obrigatorio: true, descricao: 'id da negociação' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o texto da anotação' } },
      resumo: 'Registrar uma anotação na negociação {negocio} do RD Station CRM:\n{texto}', preparar: cartaoDe('negocio', '/deals', 'Negociação'), metodo: 'POST', caminho: '/activities',
      antes: async (ctx, a) => ({ ...a, autor: await euMesmo(ctx) }),
      // a resposta de POST /activities traz o identificador em _id
      corpo: (a: Args) => ({ activity: { deal_id: a.negocio, text: a.texto, user_id: a.autor } }), texto: (j) => `Anotação registrada (id: ${linhaDe('{_id}', j) || linhaDe('{id}', j)}).` },
  ],
};

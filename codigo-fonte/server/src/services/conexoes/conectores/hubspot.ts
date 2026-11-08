/**
 * HubSpot: contatos, empresas, negócios, tarefas e notas. Nenhuma ação manda e-mail nem mensagem a cliente.
 *
 * Referências oficiais, conferidas em 05/11/2026 (o endereço leva a versão por data; "2026-09" é a atual):
 *   developers.hubspot.com/docs/developer-tooling/platform/versioning (versões por data; v3 segue no ar)
 *   developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys (chave de serviço, Bearer, telas)
 *   developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview (aplicativo privado: não se cria novo desde 26/10/2026)
 *   developers.hubspot.com/docs/api-reference/search/guide (busca, filtros, associations.{tipo}, sorts, limit 200, paging.next.after)
 *   developers.hubspot.com/docs/api-reference/latest/crm/objects/{contacts,companies,deals}/guide (criar, ler e atualizar)
 *   developers.hubspot.com/docs/api-reference/latest/crm/activities/{tasks,notes}/guide (hs_timestamp obrigatório, propriedades)
 *   developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide (números das associações)
 *   developers.hubspot.com/docs/api-reference/latest/crm/pipelines/get-pipelines, .../crm/owners/guide
 *   developers.hubspot.com/docs/api-reference/latest/account/account-information/get-account-details (quem é a conta)
 *
 * Risco: atribuir a alguém (responsavel) pode avisar essa pessoa, então conta como envio; sem isso, só organiza.
 */
import { neutral } from '../../operations.ts';
import { linhaDe, type AcaoDecl, type ConectorDef } from './declarativo.ts';
import { paraHtml, semHtml } from './pipedrive.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param, type Risco } from '../tipos.ts';

const V = '2026-09';
const vazio = (v: unknown) => v === undefined || v === null || v === '';

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

/** Na busca o cursor vai no corpo, como "after": sai de a.cursor para o motor não repetir na consulta. */
const cursorNoCorpo = async (_c: CtxAcao, a: Args): Promise<Args> => { const { cursor, ...resto } = a; return { ...resto, after: cursor }; };

/** AAAA-MM-DD ou data e hora ISO. Só a data vale meio-dia UTC: continua no mesmo dia no Brasil. */
const instante = (v: unknown, nome: string): string => {
  const s = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new ErroAcao(`"${nome}" precisa ser uma data como 2026-11-20`);
  return d.toISOString();
};

/** Números das associações padrão: de cada objeto para contato, empresa e negócio. */
const LIGA_CONTATO = { empresa: 279 };
const LIGA_NEGOCIO = { contato: 3, empresa: 5 };
const LIGA_TAREFA = { contato: 204, empresa: 192, negocio: 216 };
const LIGA_NOTA = { contato: 202, empresa: 190, negocio: 214 };
const ligar = (a: Args, tipos: Record<string, number>) => {
  const l = Object.entries(tipos).filter(([k]) => !vazio(a[k])).map(([k, t]) => ({ to: { id: String(a[k]) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: t }] }));
  return l.length ? { associations: l } : {};
};
/** Filtro da busca por registro ligado: associations.contact, .company, .deal. */
const filtrosDeLigacao = (a: Args) => ([['contato', 'contact'], ['empresa', 'company'], ['negocio', 'deal']] as const)
  .filter(([k]) => !vazio(a[k])).map(([k, tipo]) => ({ propertyName: `associations.${tipo}`, operator: 'EQ', value: String(a[k]) }));

const P_BUSCA: Param = { tipo: 'texto', descricao: 'texto a procurar; sem ele, lista tudo' };
const P_LIMITE: Param = { tipo: 'numero', descricao: 'quantos por página, até 200 (padrão 20)', padrao: 20, max: 200 };
const P_ID = (de: string): Param => ({ tipo: 'texto', obrigatorio: true, descricao: `id ${de}` });
const LIGACOES: Record<string, Param> = {
  contato: { tipo: 'texto', descricao: 'id do contato ligado' },
  empresa: { tipo: 'texto', descricao: 'id da empresa ligada' },
  negocio: { tipo: 'texto', descricao: 'id do negócio ligado' },
};
const P_RESPONSAVEL: Param = { tipo: 'texto', descricao: 'id do responsável (veja hubspot.usuarios). A pessoa pode receber aviso, por isso conta como envio' };

const PROPS_CONTATO = ['firstname', 'lastname', 'email', 'phone', 'jobtitle', 'company'];
const PROPS_EMPRESA = ['name', 'domain', 'phone', 'city', 'industry'];
const PROPS_NEGOCIO = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hubspot_owner_id'];
const PROPS_TAREFA = ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_task_type', 'hs_timestamp', 'hubspot_owner_id'];
const PROPS_NOTA = ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'];

const plano = (x: any) => ({ id: x?.id, ...(x?.properties ?? {}) });
const linhaContato = (x: any) => { const p = plano(x); return ficha({ ...p, nome: [p.firstname, p.lastname].filter(Boolean).join(' ') }, [['nome', 'nome'], ['id', 'id'], ['e-mail', 'email'], ['telefone', 'phone'], ['cargo', 'jobtitle'], ['empresa', 'company']]); };
const linhaEmpresa = (x: any) => ficha(plano(x), [['nome', 'name'], ['id', 'id'], ['site', 'domain'], ['telefone', 'phone'], ['cidade', 'city'], ['setor', 'industry']]);
const linhaNegocio = (x: any) => ficha(plano(x), [['nome', 'dealname'], ['id', 'id'], ['valor', 'amount'], ['etapa', 'dealstage'], ['funil', 'pipeline'], ['fechamento', 'closedate'], ['responsável', 'hubspot_owner_id']]);
const linhaTarefa = (x: any) => { const p = plano(x); return ficha({ ...p, corpo: semHtml(p.hs_task_body) }, [['assunto', 'hs_task_subject'], ['id', 'id'], ['situação', 'hs_task_status'], ['prazo', 'hs_timestamp'], ['tipo', 'hs_task_type'], ['prioridade', 'hs_task_priority'], ['responsável', 'hubspot_owner_id'], ['detalhes', 'corpo']]); };
const linhaNota = (x: any) => { const p = plano(x); return ficha({ ...p, corpo: semHtml(p.hs_note_body) }, [['id', 'id'], ['data', 'hs_timestamp'], ['autor', 'hubspot_owner_id'], ['texto', 'corpo']], 2000); };

/** Registros ligados, como vieram: { companies: { results: [{ id }] } }. */
const ligados = (j: any): string => Object.entries(j?.associations ?? {})
  .map(([tipo, v]: [string, any]) => linhaDe('{l}', { l: `${tipo}: ${(v?.results ?? []).map((r: any) => r?.id).join(', ')}` })).join('; ');

const buscar = (d: { id: string; objeto: string; nome: string; descricao?: string; propriedades: string[]; linha: (x: any) => string; params?: Record<string, Param>; filtros?: (a: Args) => unknown[]; ordem?: { propertyName: string; direction: string } }): AcaoDecl => ({
  id: d.id, descricao: d.descricao ?? `busca ${d.nome} por texto; sem texto, lista`, risco: 'ler',
  params: { busca: P_BUSCA, ...d.params, limite: P_LIMITE },
  resumo: (a) => (vazio(a.busca) ? `Listar ${d.nome} do HubSpot` : `Buscar ${d.nome} no HubSpot: ${String(a.busca)}`),
  metodo: 'POST', caminho: `/crm/objects/${V}/${d.objeto}/search`, antes: cursorNoCorpo,
  corpo: (a: Args) => {
    const f = d.filtros?.(a) ?? [];
    return { query: a.busca, limit: a.limite, after: a.after, properties: d.propriedades, ...(f.length ? { filterGroups: [{ filters: f }] } : {}), ...(d.ordem ? { sorts: [d.ordem] } : {}) };
  },
  lista: 'results', linha: d.linha, proximo: (j) => j?.paging?.next?.after,
});

const ler = (d: { id: string; objeto: string; nome: string; idDe: string; propriedades: string[]; ligados: string; linha: (x: any) => string }): AcaoDecl => ({
  id: d.id, descricao: `mostra ${d.nome} pelo id, com os registros ligados`, rotulo: `mostra ${d.nome}, com os registros ligados`, risco: 'ler', params: { id: P_ID(d.idDe) },
  resumo: `Ler ${d.nome} {id} no HubSpot`, metodo: 'GET', caminho: `/crm/objects/${V}/${d.objeto}/{id}`,
  consulta: { properties: d.propriedades.join(','), associations: d.ligados },
  texto: (j) => { if (!j?.id) return 'nada encontrado'; const l = ligados(j); return l ? `${d.linha(j)}\nligados: ${l}` : d.linha(j); },
});

const P_CONTATO: Record<string, Param> = {
  email: { tipo: 'texto', descricao: 'e-mail' }, nome: { tipo: 'texto', descricao: 'primeiro nome' }, sobrenome: { tipo: 'texto', descricao: 'sobrenome' },
  telefone: { tipo: 'texto', descricao: 'telefone' }, cargo: { tipo: 'texto', descricao: 'cargo' },
};
const R_CONTATO = { id: 'contato', email: 'e-mail', nome: 'nome', sobrenome: 'sobrenome', telefone: 'telefone', cargo: 'cargo', empresa: 'ligado à empresa' };
const propsContato = (a: Args) => ({ email: a.email, firstname: a.nome, lastname: a.sobrenome, phone: a.telefone, jobtitle: a.cargo });

const P_NEGOCIO: Record<string, Param> = {
  valor: { tipo: 'numero', descricao: 'valor do negócio' }, fechamento: { tipo: 'texto', descricao: 'data de fechamento prevista, como 2026-11-20' }, responsavel: P_RESPONSAVEL,
};
const R_NEGOCIO = { id: 'negócio', nome: 'nome', valor: 'valor', etapa: 'etapa', funil: 'funil', fechamento: 'fechamento', responsavel: 'responsável', contato: 'ligado ao contato', empresa: 'ligado à empresa' };
const propsNegocio = (a: Args) => ({
  dealname: a.nome, amount: vazio(a.valor) ? undefined : String(a.valor), dealstage: a.etapa, pipeline: a.funil,
  closedate: vazio(a.fechamento) ? undefined : instante(a.fechamento, 'fechamento'), hubspot_owner_id: a.responsavel,
});

/** O cartão de confirmação diz o nome do negócio e o da etapa: o agente só tem os ids. */
const CARTAO_MOVER: Acao['preparar'] = async (ctx, a) => {
  const negocio = await ctx.http(`/crm/objects/${V}/deals/${seg(a.id)}?properties=dealname`, { method: 'GET', kind: 'read' });
  const funis = await ctx.http(`/crm/pipelines/${V}/deals`, { method: 'GET', kind: 'read' });
  for (const f of funis?.results ?? []) {
    if (!vazio(a.funil) && String(f?.id) !== String(a.funil)) continue;
    const etapa = (f?.stages ?? []).find((e: any) => String(e?.id) === String(a.etapa));
    if (etapa) return { detalhe: `Negócio: ${neutral(String(negocio?.properties?.dealname ?? a.id), 200)}\nEtapa de destino: ${neutral(String(etapa.label ?? a.etapa), 120)} (funil ${neutral(String(f.label ?? f.id), 120)})` };
  }
  throw new ErroAcao(`não achei a etapa "${neutral(String(a.etapa), 60)}"${vazio(a.funil) ? '' : ' neste funil'}: veja os ids em hubspot.funis`);
};

/** O nome de cada registro, para o cartão: o agente só tem os ids. Só lê; id que não existe para aqui, antes do cartão. */
const NOMES: Record<string, { objeto: string; rotulo: string; props: string; nome: (p: any) => unknown }> = {
  contato: { objeto: 'contacts', rotulo: 'Contato', props: 'firstname,lastname,email', nome: (p) => [p?.firstname, p?.lastname].filter(Boolean).join(' ') || p?.email },
  empresa: { objeto: 'companies', rotulo: 'Empresa', props: 'name', nome: (p) => p?.name },
  negocio: { objeto: 'deals', rotulo: 'Negócio', props: 'dealname', nome: (p) => p?.dealname },
};
const cartaoDe = (campos: Record<string, keyof typeof NOMES>, antes?: (c: CtxAcao, a: Args) => Promise<Args>): Acao['preparar'] => async (ctx, a) => {
  if (antes) await antes(ctx, a); // o que o clique recusaria não vira cartão
  const linhas: string[] = [];
  for (const [k, tipo] of Object.entries(campos)) {
    if (vazio(a[k])) continue;
    const n = NOMES[tipo];
    const j = await ctx.http(`/crm/objects/${V}/${n.objeto}/${seg(a[k])}?properties=${n.props}`, { method: 'GET', kind: 'read' });
    linhas.push(`${n.rotulo}: ${neutral(String(n.nome(j?.properties) || a[k]), 200)}`);
  }
  return { detalhe: linhas.join('\n') };
};

export const HUBSPOT: ConectorDef = {
  kind: 'hubspot', nome: 'HubSpot', site: 'hubspot.com', grupo: 'vendas',
  sobre: 'Seu CRM no HubSpot: os agentes buscam contatos, empresas e negócios, veem tarefas e notas, e criam ou atualizam contatos, negócios, tarefas e notas. As ações daqui não mandam mensagem; automações da sua conta continuam valendo.',
  campos: [{ name: 'token', label: 'Chave de serviço ou token de aplicativo privado', secret: true, placeholder: 'Cole aqui a chave, que começa com pat-' }],
  ajuda: {
    url: 'https://app.hubspot.com/',
    passos: 'Entre no HubSpot com um superadministrador, ou com a permissão "Developer tools access". Abra Development e, no menu da esquerda, Keys › Service keys. Clique em "Create service key" e dê um nome. Clique em "Add new scope" e marque estes: crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.companies.read, crm.objects.companies.write, crm.objects.deals.read, crm.objects.deals.write e crm.objects.owners.read. Clique em "Update", depois em "Create" e confirme. Na página da chave, clique em "Show", depois em "Copy", e cole aqui. Desde 26/10/2026 o HubSpot não deixa criar aplicativo privado novo; se você já tem um, com esses mesmos escopos, o token dele também serve (em Development › Legacy apps, aba Auth, "Show token").',
  },
  base: 'https://api.hubapi.com',
  auth: { tipo: 'bearer' },
  erroNoCorpo: (j) => (j?.status === 'error' ? { mensagem: String(j.message ?? j.category ?? 'erro'), permissao: j.category === 'MISSING_SCOPES' || j.category === 'FORBIDDEN' } : null),
  quemSou: { caminho: `/account-info/${V}/details`, nome: (j) => String(j.portalName || (j.portalId ? `conta ${j.portalId}` : 'conta do HubSpot')), id: (j) => j.portalId },
  acoes: [
    buscar({ id: 'hubspot.contatos', objeto: 'contacts', nome: 'contatos', propriedades: PROPS_CONTATO, linha: linhaContato }),
    ler({ id: 'hubspot.contato', objeto: 'contacts', nome: 'o contato', idDe: 'do contato', propriedades: PROPS_CONTATO, ligados: 'companies,deals', linha: linhaContato }),
    buscar({ id: 'hubspot.empresas', objeto: 'companies', nome: 'empresas', propriedades: PROPS_EMPRESA, linha: linhaEmpresa }),
    ler({ id: 'hubspot.empresa', objeto: 'companies', nome: 'a empresa', idDe: 'da empresa', propriedades: PROPS_EMPRESA, ligados: 'contacts,deals', linha: linhaEmpresa }),
    buscar({
      id: 'hubspot.negocios', objeto: 'deals', nome: 'negócios', propriedades: PROPS_NEGOCIO, linha: linhaNegocio,
      params: { etapa: { tipo: 'texto', descricao: 'só desta etapa (id, veja hubspot.funis)' }, funil: { tipo: 'texto', descricao: 'só deste funil (id, veja hubspot.funis)' }, contato: LIGACOES.contato, empresa: LIGACOES.empresa },
      filtros: (a) => [...(vazio(a.etapa) ? [] : [{ propertyName: 'dealstage', operator: 'EQ', value: String(a.etapa) }]), ...(vazio(a.funil) ? [] : [{ propertyName: 'pipeline', operator: 'EQ', value: String(a.funil) }]), ...filtrosDeLigacao(a)],
    }),
    ler({ id: 'hubspot.negocio', objeto: 'deals', nome: 'o negócio', idDe: 'do negócio', propriedades: PROPS_NEGOCIO, ligados: 'contacts,companies', linha: linhaNegocio }),
    { id: 'hubspot.funis', descricao: 'lista os funis de vendas e as etapas de cada um, com os ids que mover_negocio usa', rotulo: 'lista os funis de vendas e as etapas de cada um', risco: 'ler', params: {}, resumo: 'Listar os funis de vendas do HubSpot',
      metodo: 'GET', caminho: `/crm/pipelines/${V}/deals`, lista: 'results',
      linha: (x: any) => `${ficha(x, [['funil', 'label'], ['id', 'id']])}; etapas: ${(x?.stages ?? []).map((e: any) => linhaDe('{label} (id: {id})', e)).join(', ')}` },
    buscar({
      id: 'hubspot.tarefas', objeto: 'tasks', nome: 'tarefas', descricao: 'lista tarefas, as de prazo mais próximo primeiro', propriedades: PROPS_TAREFA, linha: linhaTarefa,
      params: { situacao: { tipo: 'texto', descricao: 'só as abertas ou só as concluídas', opcoes: ['aberta', 'concluida'] }, ...LIGACOES },
      filtros: (a) => [...(a.situacao === 'aberta' ? [{ propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' }] : a.situacao === 'concluida' ? [{ propertyName: 'hs_task_status', operator: 'EQ', value: 'COMPLETED' }] : []), ...filtrosDeLigacao(a)],
      ordem: { propertyName: 'hs_timestamp', direction: 'ASCENDING' },
    }),
    buscar({
      id: 'hubspot.notas', objeto: 'notes', nome: 'notas', descricao: 'lista as notas de um contato, empresa ou negócio, as mais novas primeiro', propriedades: PROPS_NOTA, linha: linhaNota,
      params: LIGACOES, filtros: filtrosDeLigacao, ordem: { propertyName: 'hs_timestamp', direction: 'DESCENDING' },
    }),
    { id: 'hubspot.usuarios', descricao: 'lista as pessoas da conta, com o id que serve de responsável', rotulo: 'lista as pessoas da conta', risco: 'ler', params: { limite: { tipo: 'numero', descricao: 'quantos por página, até 100 (padrão 100)', padrao: 100, max: 100 } },
      resumo: 'Listar as pessoas da conta do HubSpot', metodo: 'GET', caminho: `/crm/owners/${V}`, consulta: { limit: '{limite}' },
      lista: 'results', linha: '{firstName} {lastName} (id: {id}, e-mail: {email})', proximo: (j) => j?.paging?.next?.after, paramCursor: 'after' },

    { id: 'hubspot.criar_contato', descricao: 'cria um contato: diga pelo menos e-mail, nome ou sobrenome. Não manda nada ao contato', risco: 'organizar',
      params: { ...P_CONTATO, empresa: LIGACOES.empresa }, resumo: (a) => `Criar um contato no HubSpot:\n${detalhes(a, R_CONTATO)}`,
      metodo: 'POST', caminho: `/crm/objects/${V}/contacts`, antes: exigeAlgum('email', 'nome', 'sobrenome'),
      corpo: (a: Args) => ({ properties: propsContato(a), ...ligar(a, LIGA_CONTATO) }), texto: 'Contato criado (id: {id}).' },
    { id: 'hubspot.atualizar_contato', descricao: 'muda dados de um contato: só o que for informado', risco: 'organizar',
      params: { id: P_ID('do contato'), ...P_CONTATO }, resumo: (a) => `Atualizar um contato no HubSpot:\n${detalhes(a, R_CONTATO)}`,
      preparar: cartaoDe({ id: 'contato' }, exigeAlgum(...Object.keys(P_CONTATO))),
      metodo: 'PATCH', caminho: `/crm/objects/${V}/contacts/{id}`, antes: exigeAlgum(...Object.keys(P_CONTATO)),
      corpo: (a: Args) => ({ properties: propsContato(a) }), texto: 'Contato atualizado (id: {id}).' },
    { id: 'hubspot.criar_negocio', descricao: 'cria um negócio. Veja os ids de etapa e funil em hubspot.funis', rotulo: 'cria um negócio', risco: riscoDeAtribuir,
      params: {
        nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome do negócio' }, etapa: { tipo: 'texto', obrigatorio: true, descricao: 'id da etapa' },
        funil: { tipo: 'texto', descricao: 'id do funil; sem ele, o funil padrão' }, ...P_NEGOCIO, contato: LIGACOES.contato, empresa: LIGACOES.empresa,
      },
      resumo: (a) => `Criar um negócio no HubSpot:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'POST', caminho: `/crm/objects/${V}/deals`,
      corpo: (a: Args) => ({ properties: propsNegocio(a), ...ligar(a, LIGA_NEGOCIO) }), texto: 'Negócio criado (id: {id}).' },
    { id: 'hubspot.atualizar_negocio', descricao: 'muda dados de um negócio: só o que for informado. Para trocar de etapa, use hubspot.mover_negocio', rotulo: 'muda dados de um negócio: só o que for informado', risco: riscoDeAtribuir,
      params: { id: P_ID('do negócio'), nome: { tipo: 'texto', descricao: 'novo nome' }, ...P_NEGOCIO }, resumo: (a) => `Atualizar um negócio no HubSpot:\n${detalhes(a, R_NEGOCIO)}`,
      preparar: cartaoDe({ id: 'negocio' }, exigeAlgum('nome', ...Object.keys(P_NEGOCIO))),
      metodo: 'PATCH', caminho: `/crm/objects/${V}/deals/{id}`, antes: exigeAlgum('nome', ...Object.keys(P_NEGOCIO)),
      corpo: (a: Args) => ({ properties: propsNegocio(a) }), texto: 'Negócio atualizado (id: {id}).' },
    { id: 'hubspot.mover_negocio', descricao: 'leva um negócio para outra etapa. Veja os ids em hubspot.funis', rotulo: 'leva um negócio para outra etapa', risco: 'organizar',
      params: { id: P_ID('do negócio'), etapa: { tipo: 'texto', obrigatorio: true, descricao: 'id da etapa de destino' }, funil: { tipo: 'texto', descricao: 'id do funil, se a etapa for de outro funil' } },
      resumo: (a) => `Mover o negócio ${String(a.id)} do HubSpot para a etapa ${String(a.etapa)}${vazio(a.funil) ? '' : ` do funil ${String(a.funil)}`}`,
      preparar: CARTAO_MOVER, metodo: 'PATCH', caminho: `/crm/objects/${V}/deals/{id}`, corpo: { properties: { dealstage: '{etapa}', pipeline: '{funil}' } }, texto: 'Negócio movido (id: {id}).' },
    { id: 'hubspot.criar_tarefa', descricao: 'cria uma tarefa, ligada ou não a um contato, empresa ou negócio. Não manda nada ao cliente', risco: riscoDeAtribuir,
      params: {
        assunto: { tipo: 'texto', obrigatorio: true, descricao: 'título da tarefa' }, prazo: { tipo: 'texto', obrigatorio: true, descricao: 'como 2026-11-20 ou 2026-11-20T15:00:00-03:00. Só a data vale 9h de Brasília' },
        detalhes: { tipo: 'texto', descricao: 'anotações da tarefa' }, tipo: { tipo: 'texto', descricao: 'tipo da tarefa', opcoes: ['TODO', 'CALL', 'EMAIL'] }, prioridade: { tipo: 'texto', descricao: 'prioridade', opcoes: ['LOW', 'MEDIUM', 'HIGH'] },
        responsavel: P_RESPONSAVEL, ...LIGACOES,
      },
      resumo: (a) => `Criar uma tarefa no HubSpot:\n${detalhes(a, { assunto: 'assunto', prazo: 'prazo', detalhes: 'detalhes', tipo: 'tipo', prioridade: 'prioridade', responsavel: 'responsável', contato: 'ligada ao contato', empresa: 'ligada à empresa', negocio: 'ligada ao negócio' })}`,
      metodo: 'POST', caminho: `/crm/objects/${V}/tasks`,
      corpo: (a: Args) => ({ properties: { hs_timestamp: instante(a.prazo, 'prazo'), hs_task_subject: a.assunto, hs_task_body: vazio(a.detalhes) ? undefined : paraHtml(a.detalhes), hs_task_status: 'NOT_STARTED', hs_task_type: a.tipo, hs_task_priority: a.prioridade, hubspot_owner_id: a.responsavel }, ...ligar(a, LIGA_TAREFA) }),
      texto: 'Tarefa criada (id: {id}).' },
    { id: 'hubspot.registrar_nota', descricao: 'registra uma nota interna num contato, empresa ou negócio. Não manda nada ao cliente', risco: 'organizar',
      params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'o texto da nota' }, ...LIGACOES },
      resumo: (a) => `Registrar uma nota no HubSpot:\n${detalhes(a, { contato: 'no contato', empresa: 'na empresa', negocio: 'no negócio', texto: 'texto' })}`,
      preparar: cartaoDe({ contato: 'contato', empresa: 'empresa', negocio: 'negocio' }, exigeAlgum('contato', 'empresa', 'negocio')),
      metodo: 'POST', caminho: `/crm/objects/${V}/notes`, antes: exigeAlgum('contato', 'empresa', 'negocio'),
      corpo: (a: Args) => ({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: paraHtml(a.texto) }, ...ligar(a, LIGA_NOTA) }), texto: 'Nota registrada (id: {id}).' },
  ],
};

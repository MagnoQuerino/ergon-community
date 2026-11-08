/**
 * Kommo: contatos, empresas, leads (negócios), tarefas e notas. Nenhuma ação manda mensagem a cliente.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   developers.kommo.com/docs/private-integration e /docs/long-lived-token (Settings › Integrations, Keys and scopes, token de 1 dia a 5 anos)
 *   developers.kommo.com/docs/limitations (sempre o endereço da conta; até 250 por vez; 7 chamadas por segundo)
 *   developers.kommo.com/docs/http-codes (erros: title, status, detail e validation-errors)
 *   developers.kommo.com/reference/account-parameters, /users-list, /pipelines-list
 *   developers.kommo.com/reference/leads-list, /getting-a-lead-by-its-id, /adding-leads, /updating-single-lead
 *   developers.kommo.com/reference/contacts-list, /get-contact, /add-contacts, /update-contact, /companies-list, /get-company
 *   developers.kommo.com/reference/custom-fields (PHONE e EMAIL com enum_code)
 *   developers.kommo.com/reference/tasks, /tasks-list, /add-tasks (1 = Follow-up, 2 = Meeting; responsável padrão é quem tem o token)
 *   developers.kommo.com/reference/notes-types, /add-notes, /notes-by-entity-id (nota "common" com params.text)
 *
 * Risco: atribuir a alguém (responsavel) pode avisar essa pessoa, então conta como envio; sem isso, só organiza.
 */
import { neutral } from '../../operations.ts';
import { hostSeguro, linhaDe, type AcaoDecl, type ConectorDef, type Credenciais } from './declarativo.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param, type Risco } from '../tipos.ts';

const vazio = (v: unknown) => v === undefined || v === null || v === '';

/** Aceita "suaempresa" ou "suaempresa.kommo.com". A credencial só vai a um subdomínio do próprio Kommo. */
const hostDoKommo = (c: Credenciais): string => {
  const v = String(c.subdominio ?? '').trim();
  return hostSeguro(/[./:]/.test(v) ? v : `${v}.kommo.com`, /^[a-z0-9-]+\.kommo\.com$/).split(':')[0];
};

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

/** A qual registro a tarefa ou nota pertence: o Kommo aceita um só. */
const QUEM: Array<[string, string]> = [['negocio', 'leads'], ['contato', 'contacts'], ['empresa', 'companies']];
const registroLigado = (a: Args): { entity_type: string; entity_id: number } | null => {
  const l = QUEM.filter(([k]) => !vazio(a[k]));
  if (l.length > 1) throw new ErroAcao('diga só um: negocio, contato ou empresa');
  return l.length ? { entity_type: l[0][1], entity_id: Number(a[l[0][0]]) } : null;
};
const exigeRegistro = async (_c: CtxAcao, a: Args): Promise<Args> => {
  const r = registroLigado(a);
  if (!r) throw new ErroAcao('diga a qual registro: negocio, contato ou empresa');
  return { ...a, ...r };
};

/** Segundos desde 1970, como o Kommo pede. Só a data vale meio-dia UTC: continua no mesmo dia no Brasil. */
const segundos = (v: unknown, nome: string): number => {
  const s = String(v).trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  if (Number.isNaN(t)) throw new ErroAcao(`"${nome}" precisa ser uma data como 2026-11-20`);
  return Math.floor(t / 1000);
};
/** Unix do Kommo para leitura. */
const dataDe = (v: unknown): string => (typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : '');

/** A resposta traz a página atual (_page) e, se houver mais, _links.next. */
const proximaPagina = (j: any) => (j?._links?.next && j?._page ? String(Number(j._page) + 1) : null);

/** Telefone e e-mail ficam nos campos do contato, identificados por código. */
const camposDoContato = (a: Args) => {
  const l = [
    ...(vazio(a.telefone) ? [] : [{ field_code: 'PHONE', values: [{ value: a.telefone, enum_code: 'WORK' }] }]),
    ...(vazio(a.email) ? [] : [{ field_code: 'EMAIL', values: [{ value: a.email, enum_code: 'WORK' }] }]),
  ];
  return l.length ? { custom_fields_values: l } : {};
};
const campoDe = (x: any, codigo: string): string => {
  const c = (x?.custom_fields_values ?? []).find((f: any) => f?.field_code === codigo);
  return (c?.values ?? []).map((v: any) => v?.value).filter(Boolean).join(' / ');
};

const P_ID = (de: string): Param => ({ tipo: 'texto', obrigatorio: true, descricao: `id ${de}` });
const P_LIMITE: Param = { tipo: 'numero', descricao: 'quantos por página, até 250 (padrão 50)', padrao: 50, max: 250 };
const P_BUSCA: Param = { tipo: 'texto', descricao: 'o que procurar; sem isso, lista' };
const P_RESPONSAVEL: Param = { tipo: 'numero', descricao: 'id do responsável (veja kommo.usuarios). A pessoa pode receber aviso, por isso conta como envio' };
const P_FILTRO_RESP: Param = { tipo: 'numero', descricao: 'só deste responsável (id, veja kommo.usuarios)' };
const LIGACOES: Record<string, Param> = {
  negocio: { tipo: 'numero', descricao: 'id do negócio (lead)' }, contato: { tipo: 'numero', descricao: 'id do contato' }, empresa: { tipo: 'numero', descricao: 'id da empresa' },
};

const contatoPlano = (x: any) => ({ ...x, fone: campoDe(x, 'PHONE'), mail: campoDe(x, 'EMAIL'), negocios: (x?._embedded?.leads ?? []).map((l: any) => l?.id).join(', '), empresa: (x?._embedded?.companies ?? []).map((l: any) => l?.id).join(', ') });
const linhaContato = (x: any) => ficha(contatoPlano(x), [['nome', 'name'], ['id', 'id'], ['telefone', 'fone'], ['e-mail', 'mail'], ['responsável', 'responsible_user_id'], ['empresa', 'empresa'], ['negócios', 'negocios']]);
const linhaEmpresa = (x: any) => ficha({ ...contatoPlano(x), contatos: (x?._embedded?.contacts ?? []).map((l: any) => l?.id).join(', ') }, [['nome', 'name'], ['id', 'id'], ['telefone', 'fone'], ['e-mail', 'mail'], ['responsável', 'responsible_user_id'], ['contatos', 'contatos'], ['negócios', 'negocios']]);
const linhaNegocio = (x: any) => ficha({ ...x, contatos: (x?._embedded?.contacts ?? []).map((l: any) => l?.id).join(', '), empresa: x?._embedded?.companies?.[0]?.id }, [['nome', 'name'], ['id', 'id'], ['valor', 'price'], ['etapa', 'status_id'], ['funil', 'pipeline_id'], ['responsável', 'responsible_user_id'], ['contatos', 'contatos'], ['empresa', 'empresa']]);
const linhaTarefa = (x: any) => ficha({ ...x, feita: x?.is_completed === true ? 'sim' : 'não', prazo: dataDe(x?.complete_till) }, [['texto', 'text'], ['id', 'id'], ['prazo', 'prazo'], ['feita', 'feita'], ['tipo', 'task_type_id'], ['em', 'entity_type'], ['id do registro', 'entity_id'], ['responsável', 'responsible_user_id']]);
const linhaNota = (x: any) => ficha({ ...x, quando: dataDe(x?.created_at) }, [['id', 'id'], ['data', 'quando'], ['tipo', 'note_type'], ['texto', 'params.text']], 2000);

const ler = (id: string, caminho: string, nome: string, idDe: string, com: string, linha: (x: any) => string): AcaoDecl => ({
  id, descricao: `mostra ${nome} pelo id, com o que está ligado`, rotulo: `mostra ${nome}, com o que está ligado`, risco: 'ler', params: { id: P_ID(idDe) }, resumo: `Ler ${nome} {id} no Kommo`,
  metodo: 'GET', caminho, consulta: { with: com }, texto: (j) => (j?.id ? linha(j) : 'nada encontrado'),
});
const listar = (id: string, caminho: string, descricao: string, nome: string, chave: string, com: string, linha: (x: any) => string): AcaoDecl => ({
  id, descricao, risco: 'ler', params: { busca: P_BUSCA, responsavel: P_FILTRO_RESP, limite: P_LIMITE },
  resumo: (a) => (vazio(a.busca) ? `Listar ${nome} do Kommo` : `Buscar ${nome} no Kommo: ${String(a.busca)}`),
  metodo: 'GET', caminho, consulta: { query: '{busca}', 'filter[responsible_user_id][]': '{responsavel}', with: com, limit: '{limite}' },
  lista: `_embedded.${chave}`, linha, proximo: proximaPagina, paramCursor: 'page',
});

const P_CONTATO: Record<string, Param> = {
  nome: { tipo: 'texto', descricao: 'nome completo' }, telefone: { tipo: 'texto', descricao: 'telefone. Ao atualizar, troca os telefones atuais por este' }, email: { tipo: 'texto', descricao: 'e-mail. Ao atualizar, troca os e-mails atuais por este' },
};
const R_CONTATO = { id: 'contato', nome: 'nome', telefone: 'telefone (troca os telefones atuais por este)', email: 'e-mail (troca os e-mails atuais por este)' };
const R_NEGOCIO = { id: 'negócio', nome: 'nome', valor: 'valor', funil: 'funil', etapa: 'etapa', responsavel: 'responsável', contato: 'ligado ao contato', empresa: 'ligado à empresa' };

/** O cartão de confirmação diz o nome do negócio e o da etapa, no funil informado ou no do negócio: as etapas 142 e 143 existem em todo funil. */
const CARTAO_MOVER: Acao['preparar'] = async (ctx, a) => {
  const negocio = await ctx.http(`/leads/${seg(a.id)}`, { method: 'GET', kind: 'read' });
  const funis = await ctx.http('/leads/pipelines', { method: 'GET', kind: 'read' });
  const qual = String(vazio(a.funil) ? negocio?.pipeline_id : a.funil);
  const funil = (funis?._embedded?.pipelines ?? []).find((f: any) => String(f?.id) === qual);
  const etapa = (funil?._embedded?.statuses ?? []).find((e: any) => String(e?.id) === String(a.etapa));
  if (!etapa) throw new ErroAcao(`não achei a etapa "${neutral(String(a.etapa), 60)}" neste funil: veja os ids em kommo.funis`);
  return { detalhe: `Negócio: ${neutral(String(negocio?.name ?? a.id), 200)}\nEtapa de destino: ${neutral(String(etapa.name ?? a.etapa), 120)} (funil ${neutral(String(funil.name ?? funil.id), 120)})` };
};

/** O nome de cada registro, para o cartão: o agente só tem os ids. Só lê; id que não existe para aqui, antes do cartão. */
const NOMES: Record<string, { caminho: string; rotulo: string }> = {
  contato: { caminho: '/contacts', rotulo: 'Contato' }, empresa: { caminho: '/companies', rotulo: 'Empresa' }, negocio: { caminho: '/leads', rotulo: 'Negócio' },
};
const cartaoDe = (campos: Record<string, keyof typeof NOMES>, antes?: (c: CtxAcao, a: Args) => Promise<Args>): Acao['preparar'] => async (ctx, a) => {
  if (antes) await antes(ctx, a); // o que o clique recusaria não vira cartão
  const linhas: string[] = [];
  for (const [k, tipo] of Object.entries(campos)) {
    if (vazio(a[k])) continue;
    const n = NOMES[tipo];
    const j = await ctx.http(`${n.caminho}/${seg(a[k])}`, { method: 'GET', kind: 'read' });
    linhas.push(`${n.rotulo}: ${neutral(String(j?.name || a[k]), 200)}`);
  }
  return { detalhe: linhas.join('\n') };
};

export const KOMMO: ConectorDef = {
  kind: 'kommo', nome: 'Kommo', site: 'kommo.com', grupo: 'vendas',
  sobre: 'Seu CRM no Kommo: os agentes buscam contatos, empresas e negócios, veem tarefas e notas, e criam ou atualizam contatos, negócios, tarefas e notas. As ações daqui não mandam mensagem; automações da sua conta continuam valendo.',
  campos: [
    { name: 'subdominio', label: 'Endereço da sua conta', placeholder: 'suaempresa.kommo.com' },
    { name: 'token', label: 'Token de longa duração', secret: true, placeholder: 'Cole o token aqui' },
  ],
  ajuda: {
    url: 'https://www.kommo.com/',
    passos: 'Entre no Kommo como administrador da conta. Vá em Settings › Integrations e clique em "Create integration"; numa conta técnica, escolha "Private". Salve o formulário sem preencher "Redirect URL": ao clicar só em "Save", todas as permissões ficam marcadas, e os agentes podem ler e escrever. Abra a aba "Keys and scopes", clique em "Generate long-lived token", escolha até quando ele vale (de 1 dia a 5 anos) e copie na hora, porque ele não aparece de novo. Cole aqui, junto com o endereço da sua conta, que é o que aparece no navegador, como suaempresa.kommo.com. O token age com os direitos do administrador: guarde com cuidado.',
  },
  base: (c) => `https://${hostDoKommo(c)}/api/v4`,
  auth: { tipo: 'bearer' },
  erroNoCorpo: (j) => {
    const s = Number(j?.status);
    if (!j?.['validation-errors'] && !(s >= 400 && j?.title)) return null;
    return { mensagem: String(j.detail ?? j.title ?? 'erro nos dados enviados'), permissao: s === 401 || s === 402 || s === 403 };
  },
  quemSou: { caminho: '/account', nome: (j) => String(j?.name || j?.subdomain || 'conta do Kommo'), id: (j) => j?.id },
  acoes: [
    listar('kommo.contatos', '/contacts', 'busca contatos; sem texto, lista. Procura também por telefone', 'contatos', 'contacts', 'leads', linhaContato),
    ler('kommo.contato', '/contacts/{id}', 'o contato', 'do contato', 'leads', linhaContato),
    listar('kommo.empresas', '/companies', 'busca empresas; sem texto, lista', 'empresas', 'companies', 'contacts,leads', linhaEmpresa),
    ler('kommo.empresa', '/companies/{id}', 'a empresa', 'da empresa', 'contacts,leads', linhaEmpresa),
    { id: 'kommo.negocios', descricao: 'busca negócios (leads); sem texto, lista. Veja os ids de funil e etapa em kommo.funis', rotulo: 'busca negócios (leads); sem texto, lista', risco: 'ler',
      params: { busca: P_BUSCA, funil: { tipo: 'numero', descricao: 'só deste funil (id)' }, etapa: { tipo: 'numero', descricao: 'só desta etapa (id); precisa do funil junto' }, responsavel: P_FILTRO_RESP, limite: P_LIMITE },
      resumo: (a) => (vazio(a.busca) ? 'Listar os negócios do Kommo' : `Buscar negócios no Kommo: ${String(a.busca)}`), metodo: 'GET', caminho: '/leads',
      antes: async (_c, a) => {
        if (!vazio(a.etapa) && vazio(a.funil)) throw new ErroAcao('para filtrar por etapa, diga também o funil');
        return vazio(a.etapa) ? { ...a, so_funil: a.funil } : { ...a, funil_da_etapa: a.funil };
      },
      consulta: { query: '{busca}', 'filter[pipeline_id][]': '{so_funil}', 'filter[statuses][0][pipeline_id]': '{funil_da_etapa}', 'filter[statuses][0][status_id]': '{etapa}', 'filter[responsible_user_id][]': '{responsavel}', with: 'contacts', limit: '{limite}' },
      lista: '_embedded.leads', linha: linhaNegocio, proximo: proximaPagina, paramCursor: 'page' },
    ler('kommo.negocio', '/leads/{id}', 'o negócio', 'do negócio', 'contacts', linhaNegocio),
    { id: 'kommo.funis', descricao: 'lista os funis e as etapas de cada um, com os ids que mover_negocio usa', rotulo: 'lista os funis e as etapas de cada um', risco: 'ler', params: {}, resumo: 'Listar os funis do Kommo',
      metodo: 'GET', caminho: '/leads/pipelines', lista: '_embedded.pipelines',
      linha: (x: any) => `${ficha(x, [['funil', 'name'], ['id', 'id']])}; etapas: ${(x?._embedded?.statuses ?? []).map((e: any) => linhaDe('{name} (id: {id})', e)).join(', ')}` },
    { id: 'kommo.tarefas', descricao: 'lista tarefas, as de prazo mais próximo primeiro', risco: 'ler',
      params: { situacao: { tipo: 'texto', descricao: 'só as abertas ou só as concluídas', opcoes: ['aberta', 'concluida'] }, ...LIGACOES, responsavel: P_FILTRO_RESP, limite: P_LIMITE },
      resumo: 'Listar as tarefas do Kommo', metodo: 'GET', caminho: '/tasks',
      antes: async (_c, a) => ({ ...a, ...(registroLigado(a) ?? {}), feita: a.situacao === 'concluida' ? 1 : a.situacao === 'aberta' ? 0 : undefined }),
      consulta: { 'filter[is_completed]': '{feita}', 'filter[entity_type]': '{entity_type}', 'filter[entity_id][]': '{entity_id}', 'filter[responsible_user_id][]': '{responsavel}', 'order[complete_till]': 'asc', limit: '{limite}' },
      lista: '_embedded.tasks', linha: linhaTarefa, proximo: proximaPagina, paramCursor: 'page' },
    { id: 'kommo.notas', descricao: 'lista as notas de um negócio, contato ou empresa', risco: 'ler', params: { ...LIGACOES, limite: P_LIMITE }, resumo: (a) => `Listar as notas de um registro do Kommo:\n${detalhes(a, { negocio: 'negócio', contato: 'contato', empresa: 'empresa' })}`,
      metodo: 'GET', caminho: '/{entity_type}/{entity_id}/notes', antes: exigeRegistro, consulta: { limit: '{limite}' }, lista: '_embedded.notes', linha: linhaNota, proximo: proximaPagina, paramCursor: 'page' },
    { id: 'kommo.usuarios', descricao: 'lista as pessoas da conta, com o id que serve de responsável', rotulo: 'lista as pessoas da conta', risco: 'ler', params: { limite: P_LIMITE }, resumo: 'Listar as pessoas da conta do Kommo',
      metodo: 'GET', caminho: '/users', consulta: { limit: '{limite}' }, lista: '_embedded.users', linha: '{name} (id: {id}, e-mail: {email})', proximo: proximaPagina, paramCursor: 'page' },

    { id: 'kommo.criar_contato', descricao: 'cria um contato. Não manda nada a ele', risco: 'organizar',
      params: { ...P_CONTATO, nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome completo' } }, resumo: (a) => `Criar um contato no Kommo:\n${detalhes(a, R_CONTATO)}`,
      metodo: 'POST', caminho: '/contacts', corpo: (a: Args) => [{ name: a.nome, ...camposDoContato(a) }], texto: (j) => `Contato criado (id: ${linhaDe('{id}', j?._embedded?.contacts?.[0])}).` },
    { id: 'kommo.atualizar_contato', descricao: 'muda dados de um contato: só o que for informado', risco: 'organizar',
      params: { id: P_ID('do contato'), ...P_CONTATO }, resumo: (a) => `Atualizar um contato no Kommo:\n${detalhes(a, R_CONTATO)}`, preparar: cartaoDe({ id: 'contato' }, exigeAlgum(...Object.keys(P_CONTATO))),
      metodo: 'PATCH', caminho: '/contacts/{id}', antes: exigeAlgum(...Object.keys(P_CONTATO)),
      corpo: (a: Args) => ({ name: a.nome, ...camposDoContato(a) }), texto: (_j, a) => `Contato atualizado (id: ${String(a.id)}).` },
    { id: 'kommo.criar_negocio', descricao: 'cria um negócio (lead). Sem etapa, entra na primeira do funil principal. Veja os ids em kommo.funis', rotulo: 'cria um negócio (lead). Sem etapa, entra na primeira do funil principal', risco: riscoDeAtribuir,
      params: {
        nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome do negócio' }, valor: { tipo: 'numero', descricao: 'valor da venda' }, funil: { tipo: 'numero', descricao: 'id do funil' }, etapa: { tipo: 'numero', descricao: 'id da etapa' },
        responsavel: P_RESPONSAVEL, contato: { tipo: 'numero', descricao: 'id do contato ligado' }, empresa: { tipo: 'numero', descricao: 'id da empresa ligada' },
      },
      resumo: (a) => `Criar um negócio no Kommo:\n${detalhes(a, R_NEGOCIO)}`, metodo: 'POST', caminho: '/leads',
      corpo: (a: Args) => [{
        name: a.nome, price: a.valor, pipeline_id: a.funil, status_id: a.etapa, responsible_user_id: a.responsavel,
        ...(vazio(a.contato) && vazio(a.empresa) ? {} : { _embedded: { ...(vazio(a.contato) ? {} : { contacts: [{ id: a.contato }] }), ...(vazio(a.empresa) ? {} : { companies: [{ id: a.empresa }] }) } }),
      }],
      texto: (j) => `Negócio criado (id: ${linhaDe('{id}', j?._embedded?.leads?.[0])}).` },
    { id: 'kommo.atualizar_negocio', descricao: 'muda nome, valor ou responsável de um negócio: só o que for informado. Para trocar de etapa, use kommo.mover_negocio', rotulo: 'muda nome, valor ou responsável de um negócio: só o que for informado', risco: riscoDeAtribuir,
      params: { id: P_ID('do negócio'), nome: { tipo: 'texto', descricao: 'novo nome' }, valor: { tipo: 'numero', descricao: 'valor da venda' }, responsavel: P_RESPONSAVEL },
      resumo: (a) => `Atualizar um negócio no Kommo:\n${detalhes(a, R_NEGOCIO)}`, preparar: cartaoDe({ id: 'negocio' }, exigeAlgum('nome', 'valor', 'responsavel')),
      metodo: 'PATCH', caminho: '/leads/{id}', antes: exigeAlgum('nome', 'valor', 'responsavel'),
      corpo: { name: '{nome}', price: '{valor}', responsible_user_id: '{responsavel}' }, texto: (_j, a) => `Negócio atualizado (id: ${String(a.id)}).` },
    { id: 'kommo.mover_negocio', descricao: 'leva um negócio para outra etapa. Veja os ids em kommo.funis. Em todo funil, a etapa 142 é ganho e a 143 é perda', rotulo: 'leva um negócio para outra etapa, inclusive ganho ou perdido', risco: 'organizar',
      params: { id: P_ID('do negócio'), etapa: { tipo: 'numero', obrigatorio: true, descricao: 'id da etapa de destino' }, funil: { tipo: 'numero', descricao: 'id do funil, se a etapa for de outro funil' } },
      resumo: (a) => `Mover o negócio ${String(a.id)} do Kommo para a etapa ${String(a.etapa)}${vazio(a.funil) ? '' : ` do funil ${String(a.funil)}`}`, preparar: CARTAO_MOVER,
      metodo: 'PATCH', caminho: '/leads/{id}', corpo: { status_id: '{etapa}', pipeline_id: '{funil}' }, texto: (_j, a) => `Negócio movido (id: ${String(a.id)}).` },
    { id: 'kommo.criar_tarefa', descricao: 'cria uma tarefa, ligada ou não a um negócio, contato ou empresa. Não manda nada ao cliente. Sem responsável, fica com quem tem o token', rotulo: 'cria uma tarefa, ligada ou não a um negócio, contato ou empresa. Não manda nada ao cliente. Sem responsável, fica com a conta conectada', risco: riscoDeAtribuir,
      params: {
        texto: { tipo: 'texto', obrigatorio: true, descricao: 'o que fazer' }, prazo: { tipo: 'texto', obrigatorio: true, descricao: 'como 2026-11-20 ou 2026-11-20T15:00:00-03:00. Só a data vale 9h de Brasília' },
        tipo: { tipo: 'numero', descricao: '1 = retorno (follow-up), 2 = reunião' }, responsavel: P_RESPONSAVEL, ...LIGACOES,
      },
      resumo: (a) => `Criar uma tarefa no Kommo:\n${detalhes(a, { texto: 'texto', prazo: 'prazo', tipo: 'tipo', responsavel: 'responsável', negocio: 'ligada ao negócio', contato: 'ligada ao contato', empresa: 'ligada à empresa' })}`,
      metodo: 'POST', caminho: '/tasks',
      corpo: (a: Args) => [{ text: a.texto, complete_till: segundos(a.prazo, 'prazo'), task_type_id: a.tipo, responsible_user_id: a.responsavel, ...(registroLigado(a) ?? {}) }],
      texto: (j) => `Tarefa criada (id: ${linhaDe('{id}', j?._embedded?.tasks?.[0])}).` },
    { id: 'kommo.registrar_nota', descricao: 'registra uma nota interna num negócio, contato ou empresa. Não manda nada ao cliente', risco: 'organizar',
      params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'o texto da nota' }, ...LIGACOES },
      resumo: (a) => `Registrar uma nota no Kommo:\n${detalhes(a, { negocio: 'no negócio', contato: 'no contato', empresa: 'na empresa', texto: 'texto' })}`,
      preparar: cartaoDe({ negocio: 'negocio', contato: 'contato', empresa: 'empresa' }, exigeRegistro),
      metodo: 'POST', caminho: '/{entity_type}/notes', antes: exigeRegistro,
      corpo: (a: Args) => [{ entity_id: a.entity_id, note_type: 'common', params: { text: a.texto } }], texto: (j) => `Nota registrada (id: ${linhaDe('{id}', j?._embedded?.notes?.[0])}).` },
  ],
};

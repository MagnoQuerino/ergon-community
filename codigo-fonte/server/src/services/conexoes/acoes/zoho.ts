/**
 * Zoho (rc.48): CRM, Books e Mail com o login da conta (sso.ts, provedor "zoho"). Uma conexão só, com um data center por
 * conta (zoho.in, zoho.com, zoho.eu...): as chamadas vão aos endereços daquele data center (ZOHO_DCS), nunca a um endereço
 * que o modelo escreva. Os caminhos das ações são relativos: "/crm/...", "/books/..." vão à API do data center
 * (www.zohoapis.<dc>) e "/mail/..." ao Zoho Mail (mail.zoho.<dc>/api). Escrito de memória da documentação oficial (a rede
 * desta máquina não alcança zoho.com): CRM API v8 (records, search, upsert por id), Books API v3 (organization_id em toda
 * chamada; invoices, contacts, customerpayments, invoices/{id}/email) e Mail API (accounts, messages/view, messages/search,
 * folders/{f}/messages/{m}/content, POST messages). Conferir na primeira conta de verdade.
 *
 * O que cada uma pode:
 * - CRM: leads, contatos e negócios — listar, buscar, ler (livre), criar e atualizar (organizar: não avisa ninguém).
 * - Books: faturas, clientes e pagamentos (livre) e criar fatura em RASCUNHO (organizar: o Books não manda nada). Enviar a
 *   fatura ao cliente e registrar pagamento são sempre-protegidas (Acao.protegida): pedem o cartão toda vez, mesmo com
 *   "Liberar tudo" e com regra aprovada.
 * - Mail: listar, ler (livre) e enviar, com a mesma política dos outros e-mails (risco enviar; as ações se chamam email.*,
 *   e a regra "podem mandar os e-mails" vale também aqui).
 */
import { clip } from '../../../lib/util.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, emails, seg, type Acao, type Args, type CtxAcao, type Http, type Param } from '../tipos.ts';
import { acaoDe, detalhes, ficha, linhaDe, vazio, type AcaoDecl } from '../conectores/declarativo.ts';
import { request } from '../../task-providers.ts';
import { ProviderError } from '../../mirror.ts';
import { ZOHO_DCS, ehZohoDc, type ZohoDc } from './zoho-dc.ts';

/** O que o login pede (separado por vírgula na Zoho). O perfil dá o e-mail da conta, que vira o nome dela no Ergon. */
export const ESCOPOS_ZOHO = [
  'AaaServer.profile.READ',
  'ZohoCRM.modules.leads.ALL', 'ZohoCRM.modules.contacts.ALL', 'ZohoCRM.modules.deals.ALL', 'ZohoCRM.users.READ',
  'ZohoBooks.invoices.CREATE', 'ZohoBooks.invoices.READ', 'ZohoBooks.invoices.UPDATE', 'ZohoBooks.contacts.READ',
  'ZohoBooks.customerpayments.CREATE', 'ZohoBooks.customerpayments.READ', 'ZohoBooks.settings.READ',
  'ZohoMail.accounts.READ', 'ZohoMail.folders.READ', 'ZohoMail.messages.ALL',
];

const dcDe = (ctx: Pick<CtxAcao, 'dc'>): ZohoDc => (ehZohoDc(ctx.dc) ? ctx.dc : 'com');

/**
 * A chamada autenticada à Zoho, no data center da conta. O caminho é relativo e só pode ser de CRM, Books ou Mail; o
 * acesso vai no cabeçalho "Zoho-oauthtoken". Erro dentro de uma resposta 200 (Books: code diferente de 0) nunca parece sucesso.
 */
export function httpZoho(dc: ZohoDc, acesso: (renovar: boolean) => Promise<string>): Http {
  const d = ZOHO_DCS[dc];
  return async (caminho, init = {}) => {
    if (!/^\/(crm|books|mail)\//.test(caminho)) throw new ErroAcao('endereço fora da Zoho');
    const url = caminho.startsWith('/mail/') ? `https://${d.mail}/api/${caminho.slice('/mail/'.length)}` : `https://${d.api}${caminho}`;
    const chama = async (renovar: boolean) => request(url, { ...init, redirect: 'error', headers: { Authorization: `Zoho-oauthtoken ${await acesso(renovar)}`, ...init.headers } });
    let j: any;
    try { j = await chama(false); } catch (e) {
      if (!(e instanceof ProviderError && e.status === 401)) throw e;
      j = await chama(true); // 401: o acesso venceu antes da hora; nada foi feito, repetir é seguro
    }
    if (caminho.startsWith('/books/') && j && typeof j.code === 'number' && j.code !== 0) throw new ProviderError(j.code === 57 || j.code === 14 ? 'forbidden' : 'unavailable', `o Zoho Books respondeu com erro: ${clip(String(j.message ?? j.code), 200)}`);
    if (caminho.startsWith('/mail/') && j?.status && typeof j.status.code === 'number' && j.status.code >= 400) throw new ProviderError('unavailable', `o Zoho Mail respondeu com erro: ${clip(String(j.status.description ?? j.status.code), 200)}`);
    return j;
  };
}

// ------------------------------------------------------------------------------------------------------------- CRM
const MODULOS: Record<string, { api: string; nome: string; campos: string; titulo: (x: any) => string }> = {
  leads: { api: 'Leads', nome: 'lead', campos: 'First_Name,Last_Name,Company,Email,Phone,Lead_Status,Lead_Source,Owner,Modified_Time', titulo: (x) => [x.First_Name, x.Last_Name].filter(Boolean).join(' ') },
  contatos: { api: 'Contacts', nome: 'contato', campos: 'First_Name,Last_Name,Email,Phone,Account_Name,Owner,Modified_Time', titulo: (x) => [x.First_Name, x.Last_Name].filter(Boolean).join(' ') },
  negocios: { api: 'Deals', nome: 'negócio', campos: 'Deal_Name,Stage,Amount,Closing_Date,Account_Name,Contact_Name,Owner,Modified_Time', titulo: (x) => String(x.Deal_Name ?? '') },
};
const P_MODULO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'leads, contatos ou negocios', opcoes: Object.keys(MODULOS) };
const P_LIMITE: Param = { tipo: 'numero', descricao: 'quantos (padrão 20, até 200)', padrao: 20, max: 200 };
/** Os campos de um registro, com o nome que a Zoho usa (o rótulo é o que a pessoa lê no cartão). */
const CAMPOS_CRM: Record<string, { api: string; rotulo: string; modulos: string[] }> = {
  nome: { api: 'First_Name', rotulo: 'nome', modulos: ['leads', 'contatos'] },
  sobrenome: { api: 'Last_Name', rotulo: 'sobrenome', modulos: ['leads', 'contatos'] },
  empresa: { api: 'Company', rotulo: 'empresa', modulos: ['leads'] },
  email: { api: 'Email', rotulo: 'e-mail', modulos: ['leads', 'contatos'] },
  telefone: { api: 'Phone', rotulo: 'telefone', modulos: ['leads', 'contatos'] },
  situacao: { api: 'Lead_Status', rotulo: 'situação do lead', modulos: ['leads'] },
  origem: { api: 'Lead_Source', rotulo: 'origem', modulos: ['leads', 'contatos'] },
  titulo: { api: 'Deal_Name', rotulo: 'nome do negócio', modulos: ['negocios'] },
  etapa: { api: 'Stage', rotulo: 'etapa', modulos: ['negocios'] },
  valor: { api: 'Amount', rotulo: 'valor', modulos: ['negocios'] },
  fechamento: { api: 'Closing_Date', rotulo: 'previsão de fechamento (AAAA-MM-DD)', modulos: ['negocios'] },
  conta: { api: 'Account_Name', rotulo: 'conta (id da conta no CRM)', modulos: ['contatos', 'negocios'] },
  descricao: { api: 'Description', rotulo: 'descrição', modulos: ['leads', 'contatos', 'negocios'] },
};
const PARAMS_CAMPOS: Record<string, Param> = Object.fromEntries(Object.entries(CAMPOS_CRM).map(([k, c]) => [k, (k === 'valor' ? { tipo: 'numero', descricao: `${c.rotulo} (${c.modulos.join(', ')})` } : { tipo: 'texto', descricao: `${c.rotulo} (${c.modulos.join(', ')})`, max: k === 'descricao' ? 32_000 : 255 }) as Param]));
const ROTULOS_CAMPOS = Object.fromEntries(Object.entries(CAMPOS_CRM).map(([k, c]) => [k, c.rotulo]));

const moduloDe = (a: Args) => {
  const m = MODULOS[String(a.modulo)];
  if (!m) throw new ErroAcao('"modulo" precisa ser uma destas opções', Object.keys(MODULOS));
  return m;
};
/** O link do registro no CRM, no data center da conta: o agente cita, a pessoa abre. */
export const linkCrm = (dc: ZohoDc, modulo: string, id: unknown) => `https://${ZOHO_DCS[dc].crm}/crm/tab/${MODULOS[modulo]?.api ?? 'Leads'}/${seg(id)}`;
const comDc = (ctx: CtxAcao, a: Args): Args => ({ ...a, _dc: dcDe(ctx), _modulo: moduloDe(a).api });

const linhaCrm = (modulo: string, dc: ZohoDc) => (x: any): string => {
  const m = MODULOS[modulo];
  const base = modulo === 'negocios'
    ? ficha(x, [['Negócio', 'Deal_Name'], ['Etapa', 'Stage'], ['Valor', 'Amount'], ['Fechamento', 'Closing_Date'], ['Conta', 'Account_Name.name'], ['Contato', 'Contact_Name.name'], ['Responsável', 'Owner.name']])
    : ficha({ ...x, _nome: m.titulo(x) }, [['Nome', '_nome'], ['Empresa', 'Company'], ['Conta', 'Account_Name.name'], ['E-mail', 'Email'], ['Telefone', 'Phone'], ['Situação', 'Lead_Status'], ['Origem', 'Lead_Source'], ['Responsável', 'Owner.name']]);
  return `${base}, id: ${linhaDe('{id}', x)}, link: ${linkCrm(dc, modulo, x.id)}`;
};
const listaCrm = (j: any, a: Args): string => {
  const itens: any[] = Array.isArray(j?.data) ? j.data : [];
  return itens.length ? itens.map((x) => `- ${linhaCrm(String(a.modulo), a._dc as ZohoDc)(x)}`).join('\n') : 'nada encontrado';
};
const paginaCrm = (j: any, a: Args) => (j?.info?.more_records ? String(Number(a.cursor ?? 1) + 1) : null);

/** O registro que vai ao CRM: só os campos que valem para o módulo; o que não vale é recusado antes do cartão. */
function registroCrm(a: Args, modulo: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(CAMPOS_CRM)) {
    if (vazio(a[k])) continue;
    if (!c.modulos.includes(modulo)) throw new ErroAcao(`"${k}" não existe em ${modulo}: use só ${Object.entries(CAMPOS_CRM).filter(([, x]) => x.modulos.includes(modulo)).map(([n]) => n).join(', ')}`);
    if (k === 'fechamento' && !/^\d{4}-\d{2}-\d{2}$/.test(String(a[k]))) throw new ErroAcao('"fechamento" precisa estar no formato AAAA-MM-DD');
    out[c.api] = k === 'conta' ? { id: String(a[k]) } : a[k];
  }
  return out;
}
const conferirCriar = async (_c: CtxAcao, a: Args): Promise<Args> => {
  const modulo = String(a.modulo);
  moduloDe(a);
  registroCrm(a, modulo);
  const falta = modulo === 'negocios' ? ['titulo', 'etapa'] : modulo === 'leads' ? ['sobrenome', 'empresa'] : ['sobrenome'];
  const sem = falta.filter((k) => vazio(a[k]));
  if (sem.length) throw new ErroAcao(`para criar ${MODULOS[modulo].nome} no Zoho CRM, diga: ${sem.join(', ')}`);
  return a;
};
/** A resposta de criar/atualizar traz o resultado item por item: um "error" ali não pode virar "feito". */
function resultadoCrm(j: any, a: Args, verbo: string): string {
  const r = Array.isArray(j?.data) ? j.data[0] : null;
  if (!r || r.status !== 'success') throw new ErroAcao(`o Zoho CRM não ${verbo}: ${neutral(clip(String(r?.message ?? r?.code ?? 'resposta sem resultado'), 200), 210)}${r?.details?.api_name ? ` (campo ${neutral(String(r.details.api_name), 60)})` : ''}`);
  const id = r.details?.id ?? a.id;
  return `${MODULOS[String(a.modulo)].nome[0].toUpperCase()}${MODULOS[String(a.modulo)].nome.slice(1)} ${verbo} no Zoho CRM (id: ${linhaDe('{id}', { id })}): ${linkCrm(a._dc as ZohoDc, String(a.modulo), id)}`;
}

const CRM: AcaoDecl[] = [
  { id: 'crm.listar', descricao: 'lista leads, contatos ou negócios do Zoho CRM, os mais recentes primeiro, com o link de cada um', rotulo: 'lista leads, contatos e negócios', risco: 'ler',
    params: { modulo: P_MODULO, limite: P_LIMITE },
    resumo: (a) => `Listar ${String(a.modulo)} do Zoho CRM`, metodo: 'GET', caminho: '/crm/v8/{_modulo}',
    consulta: { fields: '{_campos}', per_page: '{limite}', sort_by: 'Modified_Time', sort_order: 'desc' },
    antes: async (ctx, a) => ({ ...comDc(ctx, a), _campos: moduloDe(a).campos }),
    proximo: paginaCrm, paramCursor: 'page', texto: listaCrm },
  { id: 'crm.buscar', descricao: 'busca no Zoho CRM por palavra (nome, empresa), e-mail, telefone ou um critério da Zoho, como ((Lead_Status:equals:Contacted)and(Lead_Source:equals:Web))', rotulo: 'busca leads, contatos e negócios', risco: 'ler',
    params: { modulo: P_MODULO, texto: { tipo: 'texto', descricao: 'palavra a buscar' }, email: { tipo: 'texto', descricao: 'e-mail exato' }, telefone: { tipo: 'texto', descricao: 'telefone' }, criterio: { tipo: 'texto', descricao: 'critério no formato da Zoho' }, limite: P_LIMITE },
    resumo: (a) => `Buscar ${String(a.modulo)} no Zoho CRM${[a.texto, a.email, a.telefone, a.criterio].filter((x) => !vazio(x)).map((x) => `: ${String(x)}`).join('')}`,
    metodo: 'GET', caminho: '/crm/v8/{_modulo}/search', consulta: { word: '{texto}', email: '{email}', phone: '{telefone}', criteria: '{criterio}', per_page: '{limite}' },
    antes: async (ctx, a) => {
      if (['texto', 'email', 'telefone', 'criterio'].every((k) => vazio(a[k]))) throw new ErroAcao('diga pelo menos um destes: texto, email, telefone, criterio');
      return comDc(ctx, a);
    },
    proximo: paginaCrm, paramCursor: 'page', texto: listaCrm },
  { id: 'crm.ler', descricao: 'lê um lead, contato ou negócio do Zoho CRM pelo id, com todos os campos preenchidos e o link', rotulo: 'lê um registro do CRM', risco: 'ler',
    params: { modulo: P_MODULO, id: { tipo: 'texto', obrigatorio: true, descricao: 'id do registro' } },
    resumo: (a) => `Ler ${String(a.modulo)} ${String(a.id)} do Zoho CRM`, metodo: 'GET', caminho: '/crm/v8/{_modulo}/{id}', antes: async (ctx, a) => comDc(ctx, a),
    texto: (j, a) => {
      const x = Array.isArray(j?.data) ? j.data[0] : null;
      if (!x) return 'nada encontrado';
      const campos = Object.entries(x).filter(([k, v]) => !k.startsWith('$') && !vazio(v) && typeof v !== 'object' && !Array.isArray(v)).slice(0, 60);
      const ligados = Object.entries(x).filter(([k, v]) => !k.startsWith('$') && v && typeof v === 'object' && !Array.isArray(v) && (v as any).name).slice(0, 10);
      return [...campos.map(([k, v]) => `${k}: ${linhaDe('{v}', { v }, 2000)}`), ...ligados.map(([k, v]) => `${k}: ${linhaDe('{name}', v)}`), `Link: ${linkCrm(a._dc as ZohoDc, String(a.modulo), x.id)}`].join('\n');
    },
    url: (j, a) => (Array.isArray(j?.data) && j.data[0]?.id ? linkCrm(a._dc as ZohoDc, String(a.modulo), j.data[0].id) : null) },
  { id: 'crm.criar', descricao: 'cria um lead (sobrenome e empresa), contato (sobrenome) ou negócio (titulo e etapa) no Zoho CRM. Não avisa ninguém', rotulo: 'cria lead, contato ou negócio', risco: 'organizar',
    params: { modulo: P_MODULO, ...PARAMS_CAMPOS },
    resumo: (a) => `Criar ${MODULOS[String(a.modulo)]?.nome ?? String(a.modulo)} no Zoho CRM:\n${detalhes(a, ROTULOS_CAMPOS)}`,
    preparar: async (ctx, a) => { await conferirCriar(ctx, a); return {}; },
    metodo: 'POST', caminho: '/crm/v8/{_modulo}', antes: async (ctx, a) => comDc(ctx, await conferirCriar(ctx, a)),
    corpo: (a: Args) => ({ data: [registroCrm(a, String(a.modulo))], trigger: [] }),
    texto: (j, a) => resultadoCrm(j, a, 'criado'),
    url: (j, a) => (j?.data?.[0]?.details?.id ? linkCrm(a._dc as ZohoDc, String(a.modulo), j.data[0].details.id) : null) },
  { id: 'crm.atualizar', descricao: 'muda campos de um lead, contato ou negócio do Zoho CRM (ex.: a etapa do negócio). Não avisa ninguém', rotulo: 'atualiza um registro do CRM', risco: 'organizar',
    params: { modulo: P_MODULO, id: { tipo: 'texto', obrigatorio: true, descricao: 'id do registro' }, ...PARAMS_CAMPOS },
    resumo: (a) => `Atualizar ${MODULOS[String(a.modulo)]?.nome ?? String(a.modulo)} ${String(a.id)} no Zoho CRM:\n${detalhes(a, ROTULOS_CAMPOS)}`,
    preparar: async (_ctx, a) => { moduloDe(a); if (!Object.keys(registroCrm(a, String(a.modulo))).length) throw new ErroAcao('diga o que mudar'); return {}; },
    metodo: 'PUT', caminho: '/crm/v8/{_modulo}/{id}', antes: async (ctx, a) => comDc(ctx, a),
    corpo: (a: Args) => ({ data: [registroCrm(a, String(a.modulo))], trigger: [] }),
    texto: (j, a) => resultadoCrm(j, a, 'atualizado'),
    url: (_j, a) => linkCrm(a._dc as ZohoDc, String(a.modulo), a.id) },
];

// ----------------------------------------------------------------------------------------------------------- Books
/** A organização do Books: a que a pessoa disser, ou a padrão da conta (toda chamada do Books leva organization_id). */
async function organizacao(ctx: CtxAcao, a: Args): Promise<Args> {
  let org = vazio(a.organizacao) ? '' : String(a.organizacao);
  if (!/^\d*$/.test(org)) throw new ErroAcao('"organizacao" precisa ser o número da organização no Zoho Books');
  if (!org) {
    const j = await ctx.http('/books/v3/organizations', { method: 'GET', kind: 'read' });
    const l: any[] = Array.isArray(j?.organizations) ? j.organizations : [];
    const o = l.find((x) => x.is_default_org) ?? (l.length === 1 ? l[0] : null);
    if (!o) {
      if (!l.length) throw new ErroAcao('esta conta não tem organização no Zoho Books');
      throw new ErroAcao('a conta tem mais de uma organização no Zoho Books: diga "organizacao"', l.slice(0, 10).map((x) => `${String(x.organization_id)} (${neutral(String(x.name ?? ''), 80)})`));
    }
    org = String(o.organization_id);
  }
  return { ...a, organization_id: org, _dc: dcDe(ctx) };
}
const P_ORG: Param = { tipo: 'texto', descricao: 'número da organização no Zoho Books (sem ele, a organização padrão da conta)' };
const linkBooks = (dc: ZohoDc, org: unknown, tipo: string, id: unknown) => `https://${ZOHO_DCS[dc].books}/app/${seg(org)}#/${tipo}/${seg(id)}`;
const SITUACOES_FATURA = ['draft', 'sent', 'overdue', 'paid', 'void', 'unpaid', 'partially_paid'];
const paginaBooks = (j: any, a: Args) => (j?.page_context?.has_more_page ? String(Number(a.cursor ?? 1) + 1) : null);
const linhaFatura = (x: any, a: Args) => `${ficha(x, [['Fatura', 'invoice_number'], ['Cliente', 'customer_name'], ['Situação', 'status'], ['Data', 'date'], ['Vencimento', 'due_date'], ['Total', 'total'], ['Em aberto', 'balance'], ['Moeda', 'currency_code']])}, id: ${linhaDe('{invoice_id}', x)}, link: ${linkBooks(a._dc as ZohoDc, a.organization_id, 'invoices', x.invoice_id)}`;

/** Itens da fatura, um por linha: "descrição | quantidade | preço" (a pessoa lê no cartão exatamente o que vai). */
function itensDe(texto: unknown): Array<{ name: string; quantity: number; rate: number }> {
  const linhas = String(texto ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) throw new ErroAcao('diga os "itens", um por linha: descrição | quantidade | preço');
  if (linhas.length > 50) throw new ErroAcao('no máximo 50 itens por fatura');
  return linhas.map((l, i) => {
    const [nome, q, p] = l.split('|').map((x) => x.trim());
    const quantity = Number(String(q ?? '').replace(',', '.')); const rate = Number(String(p ?? '').replace(/[,\s](?=\d{3}\b)/g, '').replace(',', '.'));
    if (!nome || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0) throw new ErroAcao(`item ${i + 1} inválido: use descrição | quantidade | preço`);
    return { name: clip(nome, 200), quantity, rate };
  });
}
const totalDe = (itens: Array<{ quantity: number; rate: number }>) => Math.round(itens.reduce((s, x) => s + x.quantity * x.rate, 0) * 100) / 100;

const BOOKS: AcaoDecl[] = [
  { id: 'books.faturas', descricao: 'lista faturas do Zoho Books, por situação, cliente ou texto, com o link de cada uma', rotulo: 'lista faturas', risco: 'ler',
    params: { situacao: { tipo: 'texto', descricao: 'situação', opcoes: SITUACOES_FATURA }, cliente: { tipo: 'texto', descricao: 'id do cliente (books.clientes)' }, busca: { tipo: 'texto', descricao: 'número da fatura, cliente ou referência' }, limite: P_LIMITE, organizacao: P_ORG },
    resumo: (a) => `Ler as faturas do Zoho Books${a.situacao ? ` (${String(a.situacao)})` : ''}`, metodo: 'GET', caminho: '/books/v3/invoices',
    consulta: { organization_id: '{organization_id}', status: '{situacao}', customer_id: '{cliente}', search_text: '{busca}', per_page: '{limite}' },
    antes: organizacao, proximo: paginaBooks, paramCursor: 'page',
    texto: (j, a) => { const l: any[] = Array.isArray(j?.invoices) ? j.invoices : []; return l.length ? l.map((x) => `- ${linhaFatura(x, a)}`).join('\n') : 'nada encontrado'; } },
  { id: 'books.fatura', descricao: 'lê uma fatura do Zoho Books, com os itens e o link', rotulo: 'lê uma fatura', risco: 'ler',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id da fatura' }, organizacao: P_ORG },
    resumo: (a) => `Ler a fatura ${String(a.id)} do Zoho Books`, metodo: 'GET', caminho: '/books/v3/invoices/{id}', consulta: { organization_id: '{organization_id}' }, antes: organizacao,
    texto: (j, a) => {
      const x = j?.invoice ?? {};
      const itens: any[] = Array.isArray(x.line_items) ? x.line_items : [];
      return [linhaFatura(x, a), ...itens.slice(0, 50).map((i) => `- ${ficha(i, [['Item', 'name'], ['Descrição', 'description'], ['Quantidade', 'quantity'], ['Preço', 'rate'], ['Total', 'item_total']])}`)].join('\n');
    },
    url: (j, a) => (j?.invoice?.invoice_id ? linkBooks(a._dc as ZohoDc, a.organization_id, 'invoices', j.invoice.invoice_id) : null) },
  { id: 'books.clientes', descricao: 'lista ou busca clientes do Zoho Books (o id serve para criar fatura)', rotulo: 'lista clientes', risco: 'ler',
    params: { busca: { tipo: 'texto', descricao: 'nome, empresa ou e-mail' }, limite: P_LIMITE, organizacao: P_ORG },
    resumo: 'Ler os clientes do Zoho Books', metodo: 'GET', caminho: '/books/v3/contacts',
    consulta: { organization_id: '{organization_id}', contact_type: 'customer', search_text: '{busca}', per_page: '{limite}' },
    antes: organizacao, proximo: paginaBooks, paramCursor: 'page',
    texto: (j) => { const l: any[] = Array.isArray(j?.contacts) ? j.contacts : []; return l.length ? l.map((x) => `- ${ficha(x, [['Cliente', 'contact_name'], ['Empresa', 'company_name'], ['E-mail', 'email'], ['GSTIN', 'gst_no'], ['A receber', 'outstanding_receivable_amount'], ['Moeda', 'currency_code']])}, id: ${linhaDe('{contact_id}', x)}`).join('\n') : 'nada encontrado'; } },
  { id: 'books.pagamentos', descricao: 'lista os pagamentos recebidos no Zoho Books', rotulo: 'lista pagamentos recebidos', risco: 'ler',
    params: { cliente: { tipo: 'texto', descricao: 'id do cliente' }, limite: P_LIMITE, organizacao: P_ORG },
    resumo: 'Ler os pagamentos do Zoho Books', metodo: 'GET', caminho: '/books/v3/customerpayments',
    consulta: { organization_id: '{organization_id}', customer_id: '{cliente}', per_page: '{limite}' },
    antes: organizacao, proximo: paginaBooks, paramCursor: 'page',
    texto: (j) => { const l: any[] = Array.isArray(j?.customerpayments) ? j.customerpayments : []; return l.length ? l.map((x) => `- ${ficha(x, [['Pagamento', 'payment_number'], ['Cliente', 'customer_name'], ['Data', 'date'], ['Valor', 'amount'], ['Forma', 'payment_mode'], ['Faturas', 'invoice_numbers'], ['Referência', 'reference_number']])}, id: ${linhaDe('{payment_id}', x)}`).join('\n') : 'nada encontrado'; } },
  { id: 'books.criar_fatura', descricao: 'cria uma fatura em RASCUNHO no Zoho Books (não vai ao cliente). itens: um por linha, "descrição | quantidade | preço"', rotulo: 'cria fatura em rascunho (não envia)', risco: 'organizar',
    params: { cliente: { tipo: 'texto', obrigatorio: true, descricao: 'id do cliente (books.clientes)' }, itens: { tipo: 'texto', obrigatorio: true, descricao: 'um por linha: descrição | quantidade | preço', max: 10_000 },
      data: { tipo: 'texto', descricao: 'AAAA-MM-DD (padrão hoje)' }, vencimento: { tipo: 'texto', descricao: 'AAAA-MM-DD' }, referencia: { tipo: 'texto', descricao: 'número do pedido ou referência', max: 100 }, observacao: { tipo: 'texto', descricao: 'observação na fatura', max: 2000 }, organizacao: P_ORG },
    resumo: (a) => { let itens = ''; try { const l = itensDe(a.itens); itens = `${l.map((i) => `- ${i.name}: ${i.quantity} × ${i.rate}`).join('\n')}\nTotal (sem impostos): ${totalDe(l)}`; } catch { itens = String(a.itens ?? ''); }
      return `Criar uma fatura em RASCUNHO no Zoho Books (não vai ao cliente) para o cliente ${String(a.cliente)}:\n${itens}${detalhes(a, { data: '\ndata', vencimento: '\nvencimento', referencia: '\nreferência', observacao: '\nobservação' }).replace(/\n\n/g, '\n')}`; },
    preparar: async (_c, a) => { itensDe(a.itens); for (const k of ['data', 'vencimento']) if (!vazio(a[k]) && !/^\d{4}-\d{2}-\d{2}$/.test(String(a[k]))) throw new ErroAcao(`"${k}" precisa estar no formato AAAA-MM-DD`); return {}; },
    metodo: 'POST', caminho: '/books/v3/invoices', consulta: { organization_id: '{organization_id}', send: false }, antes: organizacao,
    corpo: (a: Args) => ({ customer_id: a.cliente, line_items: itensDe(a.itens), ...(a.data ? { date: a.data } : {}), ...(a.vencimento ? { due_date: a.vencimento } : {}), ...(a.referencia ? { reference_number: a.referencia } : {}), ...(a.observacao ? { notes: a.observacao } : {}) }),
    texto: (j, a) => `Fatura criada em rascunho no Zoho Books (não foi ao cliente): ${linhaFatura(j?.invoice ?? {}, a)}`,
    url: (j, a) => (j?.invoice?.invoice_id ? linkBooks(a._dc as ZohoDc, a.organization_id, 'invoices', j.invoice.invoice_id) : null) },
  { id: 'books.enviar_fatura', descricao: 'envia a fatura por e-mail ao cliente pelo Zoho Books (sempre pede a aprovação da pessoa)', rotulo: 'envia a fatura ao cliente (sempre pede a sua aprovação)', risco: 'enviar',
    protegida: 'a fatura vai ao cliente e passa a cobrar: enviar fatura pelo Zoho Books pede a sua aprovação sempre, mesmo com "Liberar tudo"',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id da fatura' }, para: { tipo: 'lista', obrigatorio: true, descricao: 'e-mails de quem recebe' }, organizacao: P_ORG },
    resumo: (a) => `Enviar a fatura ${String(a.id)} do Zoho Books por e-mail para ${(Array.isArray(a.para) ? a.para : String(a.para ?? '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean).join(', ')}`,
    preparar: async (ctx, a) => {
      emails(a, 'para');
      const o = await organizacao(ctx, a);
      const j = await ctx.http(`/books/v3/invoices/${seg(a.id)}?organization_id=${encodeURIComponent(String(o.organization_id))}`, { method: 'GET', kind: 'read' });
      return { detalhe: `Fatura: ${linhaFatura(j?.invoice ?? {}, o)}` };
    },
    metodo: 'POST', caminho: '/books/v3/invoices/{id}/email', consulta: { organization_id: '{organization_id}' },
    antes: async (ctx, a) => ({ ...(await organizacao(ctx, a)), _para: emails(a, 'para') }),
    corpo: (a: Args) => ({ to_mail_ids: a._para }), texto: (_j, a) => `O Zoho Books aceitou o envio da fatura ${String(a.id)} para ${(a._para as string[]).join(', ')}.`,
    url: (_j, a) => linkBooks(a._dc as ZohoDc, a.organization_id, 'invoices', a.id) },
  { id: 'books.registrar_pagamento', descricao: 'registra no Zoho Books um pagamento recebido de um cliente, aplicado a uma fatura (sempre pede a aprovação da pessoa)', rotulo: 'registra pagamento recebido (sempre pede a sua aprovação)', risco: 'organizar',
    protegida: 'registrar pagamento muda o que o cliente deve e o caixa: pede a sua aprovação sempre, mesmo com "Liberar tudo"',
    params: { cliente: { tipo: 'texto', obrigatorio: true, descricao: 'id do cliente' }, fatura: { tipo: 'texto', obrigatorio: true, descricao: 'id da fatura paga' }, valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor recebido' },
      data: { tipo: 'texto', obrigatorio: true, descricao: 'AAAA-MM-DD' }, forma: { tipo: 'texto', descricao: 'forma de pagamento (padrão banktransfer)', opcoes: ['banktransfer', 'cash', 'cheque', 'creditcard', 'upi', 'bankremittance', 'others'], padrao: 'banktransfer' },
      referencia: { tipo: 'texto', descricao: 'referência (UTR do UPI, número do cheque)', max: 100 }, organizacao: P_ORG },
    resumo: (a) => `Registrar no Zoho Books um pagamento de ${String(a.valor)} do cliente ${String(a.cliente)}, aplicado à fatura ${String(a.fatura)}, em ${String(a.data)}${a.forma ? `, por ${String(a.forma)}` : ''}${a.referencia ? `, referência ${String(a.referencia)}` : ''}`,
    preparar: async (_c, a) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.data ?? ''))) throw new ErroAcao('"data" precisa estar no formato AAAA-MM-DD'); if (!(Number(a.valor) > 0)) throw new ErroAcao('"valor" precisa ser maior que zero'); return {}; },
    metodo: 'POST', caminho: '/books/v3/customerpayments', consulta: { organization_id: '{organization_id}' }, antes: organizacao,
    corpo: (a: Args) => ({ customer_id: a.cliente, payment_mode: a.forma, amount: a.valor, date: a.data, ...(a.referencia ? { reference_number: a.referencia } : {}), invoices: [{ invoice_id: a.fatura, amount_applied: a.valor }] }),
    texto: (j) => `Pagamento registrado no Zoho Books: ${ficha(j?.payment ?? {}, [['Pagamento', 'payment_number'], ['Valor', 'amount'], ['Data', 'date']])}, id: ${linhaDe('{payment_id}', j?.payment ?? {})}.` },
];

// ------------------------------------------------------------------------------------------------------------- Mail
/** A conta do Zoho Mail (a primeira, a principal): o id e o endereço de quem envia. */
async function contaMail(ctx: CtxAcao, a: Args): Promise<Args> {
  const j = await ctx.http('/mail/accounts', { method: 'GET', kind: 'read' });
  const c = Array.isArray(j?.data) ? j.data[0] : null;
  if (!c?.accountId) throw new ErroAcao('esta conta Zoho não tem Zoho Mail');
  return { ...a, _conta: String(c.accountId), _de: String(c.primaryEmailAddress ?? c.mailboxAddress ?? '') };
}
const linhaMail = (x: any) => `${linhaDe('{data} de {fromAddress}: "{subject}" {summary}', { ...x, data: x.receivedTime ? new Date(Number(x.receivedTime)).toISOString().slice(0, 16).replace('T', ' ') : '' }, 300)} (id: ${linhaDe('{folderId}:{messageId}', x)}${x.status === '0' ? ', não lido' : ''})`;
const P_PARA: Param = { tipo: 'lista', obrigatorio: true, descricao: 'e-mails de quem recebe' };
const sobreEmail = (verbo: string, a: Args) => `${verbo} pelo Zoho Mail para ${(Array.isArray(a.para) ? a.para : String(a.para ?? '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean).join(', ')}${vazio(a.cc) ? '' : `, cópia para ${(Array.isArray(a.cc) ? a.cc : String(a.cc).split(/[,;]/)).join(', ')}`}. Assunto: "${String(a.assunto ?? '').replace(/\s+/g, ' ')}". Texto: "${String(a.texto ?? '')}"`;

const MAIL: AcaoDecl[] = [
  { id: 'email.buscar', descricao: 'lista os e-mails do Zoho Mail, os mais novos primeiro, ou busca por palavra; o id serve para email.ler', rotulo: 'lista e busca e-mails', risco: 'ler',
    params: { texto: { tipo: 'texto', descricao: 'palavra a buscar (assunto, remetente, conteúdo)' }, limite: { tipo: 'numero', descricao: 'quantos (padrão 20, até 100)', padrao: 20, max: 100 } },
    resumo: (a) => (a.texto ? `Buscar "${String(a.texto)}" no Zoho Mail` : 'Ler os e-mails recentes do Zoho Mail'),
    metodo: 'GET', caminho: '/mail/accounts/{_conta}/messages/{_tipo}', consulta: { searchKey: '{_busca}', limit: '{limite}' },
    antes: async (ctx, a) => ({ ...(await contaMail(ctx, a)), _tipo: vazio(a.texto) ? 'view' : 'search', ...(vazio(a.texto) ? {} : { _busca: `entire:${String(a.texto).replace(/::/g, ' ')}` }) }),
    proximo: (j, a) => (Array.isArray(j?.data) && j.data.length >= Number(a.limite) ? String(Number(a.cursor ?? 1) + Number(a.limite)) : null), paramCursor: 'start',
    texto: (j) => { const l: any[] = Array.isArray(j?.data) ? j.data : []; return l.length ? l.map((x) => `- ${linhaMail(x)}`).join('\n') : 'nada encontrado'; } },
  { id: 'email.ler', descricao: 'lê um e-mail do Zoho Mail pelo id que veio em email.buscar (pasta:mensagem)', rotulo: 'lê um e-mail', risco: 'ler',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id no formato pasta:mensagem' } },
    resumo: (a) => `Ler o e-mail ${String(a.id)} do Zoho Mail`, metodo: 'GET', caminho: '/mail/accounts/{_conta}/folders/{_pasta}/messages/{_msg}/content',
    antes: async (ctx, a) => {
      const [pasta, msg] = String(a.id).split(':');
      if (!/^\d+$/.test(pasta ?? '') || !/^\d+$/.test(msg ?? '')) throw new ErroAcao('"id" precisa ser pasta:mensagem, como veio em email.buscar');
      return { ...(await contaMail(ctx, a)), _pasta: pasta, _msg: msg };
    },
    texto: (j) => linhaDe('{c}', { c: String(j?.data?.content ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') }, 20_000) || 'sem texto' },
  { id: 'email.enviar', descricao: 'envia um e-mail novo pelo Zoho Mail, em nome da pessoa', rotulo: 'envia e-mail', risco: 'enviar',
    params: { para: P_PARA, cc: { tipo: 'lista', descricao: 'e-mails em cópia' }, assunto: { tipo: 'texto', obrigatorio: true, descricao: 'assunto', max: 500 }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'texto, sem formatação', max: 50_000 } },
    resumo: (a) => sobreEmail('Enviar e-mail', a),
    preparar: async (_c, a) => { emails(a, 'para'); emails(a, 'cc'); return {}; },
    metodo: 'POST', caminho: '/mail/accounts/{_conta}/messages',
    antes: async (ctx, a) => ({ ...(await contaMail(ctx, a)), _para: emails(a, 'para'), _cc: emails(a, 'cc') }),
    corpo: (a: Args) => ({ fromAddress: a._de, toAddress: (a._para as string[]).join(','), ...((a._cc as string[]).length ? { ccAddress: (a._cc as string[]).join(',') } : {}), subject: String(a.assunto).replace(/[\r\n]+/g, ' '), content: String(a.texto), mailFormat: 'plaintext' }),
    texto: (_j, a) => `O Zoho Mail aceitou o envio para ${(a._para as string[]).join(', ')}, assunto "${neutral(String(a.assunto), 200)}".` },
];

const TODAS: AcaoDecl[] = [...CRM, ...BOOKS, ...MAIL];
export const ACOES_ZOHO: Acao[] = TODAS.map(acaoDe);
export const DEFINICOES_ZOHO: readonly AcaoDecl[] = TODAS;

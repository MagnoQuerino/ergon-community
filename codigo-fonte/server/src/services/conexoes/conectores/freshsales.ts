/**
 * Freshsales (Freshworks CRM, rc.48), com a chave de API de um usuário e o domínio da conta: contatos, contas (sales accounts) e
 * negócios (deals) — ler, buscar, criar e atualizar. Escrito de memória da documentação oficial (developers.freshworks.com/crm/api;
 * a rede desta máquina não a alcança): "Authorization: Token token=<chave>"; contas novas em <empresa>.myfreshworks.com/crm/sales/api
 * e as antigas em <empresa>.freshsales.io/api; busca em /search?q=&include=; listas por visão (/<tipo>/filters e /<tipo>/view/<id>);
 * corpo { contact | sales_account | deal: {...} }. Conferir na primeira conta de verdade.
 * Criar e atualizar só organizam o CRM (não mandam nada a ninguém): risco organizar. Com responsável (owner_id), o Freshsales avisa
 * essa pessoa: envio.
 */
import { ErroAcao, emails, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { detalhes, ficha, hostSeguro, linhaDe, riscoDeAtribuir, vazio, type ConectorDef, type Credenciais } from './declarativo.ts';

/** "empresa", "empresa.myfreshworks.com", "empresa.freshsales.io" ou o endereço colado: a chave só vai a um domínio da Freshworks. */
export const hostFreshsales = (c: Credenciais): string => {
  const v = String(c.dominio ?? '').trim();
  return hostSeguro(v.includes('.') ? v : `${v}.myfreshworks.com`, /^[a-z0-9-]+\.(myfreshworks\.com|freshsales\.io)$/).replace(/:\d+$/, '');
};
const antigo = (c: Credenciais) => hostFreshsales(c).endsWith('.freshsales.io');

const TIPOS: Record<string, { api: string; corpo: string; nome: string; web: string }> = {
  contatos: { api: 'contacts', corpo: 'contact', nome: 'contato', web: 'contacts' },
  contas: { api: 'sales_accounts', corpo: 'sales_account', nome: 'conta', web: 'accounts' },
  negocios: { api: 'deals', corpo: 'deal', nome: 'negócio', web: 'deals' },
};
const P_TIPO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'contatos, contas ou negocios', opcoes: Object.keys(TIPOS) };
const tipoDe = (a: Args) => { const t = TIPOS[String(a.tipo)]; if (!t) throw new ErroAcao('"tipo" precisa ser uma destas opções', Object.keys(TIPOS)); return t; };

/** Os campos que os agentes escrevem, com o nome do Freshsales e em quais tipos valem. */
const CAMPOS: Record<string, { api: string; rotulo: string; tipos: string[]; numero?: boolean }> = {
  nome: { api: 'first_name', rotulo: 'nome', tipos: ['contatos'] },
  sobrenome: { api: 'last_name', rotulo: 'sobrenome', tipos: ['contatos'] },
  email: { api: 'email', rotulo: 'e-mail', tipos: ['contatos'] },
  celular: { api: 'mobile_number', rotulo: 'celular', tipos: ['contatos'] },
  cargo: { api: 'job_title', rotulo: 'cargo', tipos: ['contatos'] },
  conta: { api: 'sales_account_id', rotulo: 'conta (id)', tipos: ['contatos', 'negocios'], numero: true },
  empresa: { api: 'name', rotulo: 'nome da conta', tipos: ['contas'] },
  site: { api: 'website', rotulo: 'site', tipos: ['contas'] },
  telefone: { api: 'phone', rotulo: 'telefone', tipos: ['contas'] },
  cidade: { api: 'city', rotulo: 'cidade', tipos: ['contatos', 'contas'] },
  titulo: { api: 'name', rotulo: 'nome do negócio', tipos: ['negocios'] },
  valor: { api: 'amount', rotulo: 'valor', tipos: ['negocios'], numero: true },
  etapa: { api: 'deal_stage_id', rotulo: 'etapa (id: veja freshsales.etapas)', tipos: ['negocios'], numero: true },
  fechamento: { api: 'expected_close', rotulo: 'previsão de fechamento (AAAA-MM-DD)', tipos: ['negocios'] },
  responsavel: { api: 'owner_id', rotulo: 'responsável (id do usuário)', tipos: ['contatos', 'contas', 'negocios'], numero: true },
};
const PARAMS: Record<string, Param> = Object.fromEntries(Object.entries(CAMPOS).map(([k, c]) => [k, (c.numero ? { tipo: 'numero', descricao: `${c.rotulo} (${c.tipos.join(', ')})` } : { tipo: 'texto', descricao: `${c.rotulo} (${c.tipos.join(', ')})`, max: 255 }) as Param]));
const ROTULOS = Object.fromEntries(Object.entries(CAMPOS).map(([k, c]) => [k, c.rotulo]));

function registro(a: Args): Record<string, unknown> {
  const tipo = String(a.tipo);
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(CAMPOS)) {
    if (vazio(a[k])) continue;
    if (!c.tipos.includes(tipo)) throw new ErroAcao(`"${k}" não existe em ${tipo}: use só ${Object.entries(CAMPOS).filter(([, x]) => x.tipos.includes(tipo)).map(([n]) => n).join(', ')}`);
    if (k === 'email') emails(a, 'email', 1);
    if (k === 'fechamento' && !/^\d{4}-\d{2}-\d{2}$/.test(String(a[k]))) throw new ErroAcao('"fechamento" precisa estar no formato AAAA-MM-DD');
    out[c.api] = a[k];
  }
  return out;
}
const conferirCriar = async (_c: CtxAcao, a: Args): Promise<Args> => {
  tipoDe(a); registro(a);
  const falta = a.tipo === 'contatos' ? (vazio(a.email) && vazio(a.sobrenome) ? ['sobrenome ou email'] : []) : a.tipo === 'contas' ? (vazio(a.empresa) ? ['empresa'] : []) : ['titulo', 'valor'].filter((k) => vazio(a[k]));
  if (falta.length) throw new ErroAcao(`para criar ${tipoDe(a).nome} no Freshsales, diga: ${falta.join(', ')}`);
  return a;
};

/** O domínio da conta (não é segredo), para os links: o motor recebe só o resultado. */
const dominioDe = (ctx: CtxAcao): string => String(ctx.creds?.dominio ?? '');
/** O link do registro na tela do Freshsales (o agente cita, a pessoa abre). */
const linkDe = (c: Credenciais, tipo: string, id: unknown) => `https://${hostFreshsales(c)}${antigo(c) ? '' : '/crm/sales'}/${TIPOS[tipo]?.web ?? 'contacts'}/${encodeURIComponent(String(id ?? ''))}`;
const linhaDoTipo = (tipo: string, x: any, c: Credenciais): string => {
  const base = tipo === 'contatos' ? ficha({ ...x, _nome: x.display_name ?? [x.first_name, x.last_name].filter(Boolean).join(' ') }, [['Contato', '_nome'], ['E-mail', 'email'], ['Celular', 'mobile_number'], ['Cargo', 'job_title'], ['Cidade', 'city']])
    : tipo === 'contas' ? ficha(x, [['Conta', 'name'], ['Site', 'website'], ['Telefone', 'phone'], ['Cidade', 'city']])
      : ficha(x, [['Negócio', 'name'], ['Valor', 'amount'], ['Etapa', 'deal_stage_id'], ['Fechamento', 'expected_close'], ['Conta', 'sales_account_id']]);
  return `${base}, id: ${linhaDe('{id}', x)}, link: ${linkDe(c, tipo, x.id)}`;
};
/** O tipo de cada resultado da busca vem como "contact", "sales_account" ou "deal". */
const DO_TIPO_BUSCA: Record<string, string> = { contact: 'contatos', sales_account: 'contas', deal: 'negocios' };

export const FRESHSALES: ConectorDef = {
  kind: 'freshsales', nome: 'Freshsales', site: 'freshworks.com', grupo: 'vendas',
  sobre: 'Contatos, contas e negócios do Freshsales (Freshworks CRM): os agentes buscam, leem, criam e atualizam, com o link de cada registro.',
  campos: [
    { name: 'dominio', label: 'Domínio do Freshsales', placeholder: 'suaempresa (de suaempresa.myfreshworks.com)' },
    { name: 'chave', label: 'Chave de API', secret: true, placeholder: 'Cole a chave aqui' },
  ],
  ajuda: {
    url: 'https://crmsupport.freshworks.com/support/solutions/articles/50000002503-how-to-find-my-api-key-',
    passos: 'Entre no Freshsales com a conta de um usuário que possa ver e editar contatos, contas e negócios: a chave tem as mesmas permissões dele. Clique na sua foto, no canto superior direito, e escolha Profile Settings › API Settings. Copie a chave (Your API key) e cole aqui. O domínio é a primeira parte do endereço do seu Freshsales: suaempresa, de suaempresa.myfreshworks.com (conta antiga: suaempresa.freshsales.io, cole o endereço inteiro).',
  },
  base: (c) => `https://${hostFreshsales(c)}${antigo(c) ? '/api' : '/crm/sales/api'}`,
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ Authorization: `Token token=${c.chave}` }) },
  erroNoCorpo: (j) => {
    const e = j?.errors;
    if (!e || typeof e !== 'object') return null;
    const m = Array.isArray(e.message) ? e.message.join('; ') : String(e.message ?? e.code ?? 'erro');
    return { mensagem: m, permissao: /unauthori|permission|access/i.test(m) };
  },
  quemSou: { caminho: '/selector/owners', nome: (j) => { const u = Array.isArray(j?.users) ? j.users[0] : null; return String(u?.display_name ?? u?.email ?? 'conta do Freshsales'); } },
  acoes: [
    { id: 'freshsales.buscar', descricao: 'busca contatos, contas e negócios por nome, e-mail ou telefone, com o link de cada um', rotulo: 'busca contatos, contas e negócios', risco: 'ler',
      params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'o que buscar (nome, e-mail, telefone)' }, tipo: { tipo: 'texto', descricao: 'só contatos, contas ou negocios', opcoes: Object.keys(TIPOS) }, limite: { tipo: 'numero', descricao: 'quantos (padrão 25, até 100)', padrao: 25, max: 100 } },
      resumo: (a) => `Buscar "${String(a.texto)}" no Freshsales`, metodo: 'GET', caminho: '/search', consulta: { q: '{texto}', include: '{_incluir}', per_page: '{limite}' },
      antes: async (c, a) => ({ ...a, _dominio: dominioDe(c), _incluir: a.tipo ? TIPOS[String(a.tipo)].corpo : 'contact,sales_account,deal' }),
      texto: (j, a) => {
        const l: any[] = Array.isArray(j) ? j : [];
        return l.length ? l.map((x) => `- [${TIPOS[DO_TIPO_BUSCA[String(x.type)] ?? 'contatos'].nome}] ${linhaDe('{name}', x)}${x.email ? `, e-mail: ${linhaDe('{email}', x)}` : ''}, id: ${linhaDe('{id}', x)}${a._dominio ? `, link: ${linkDe({ dominio: String(a._dominio) }, DO_TIPO_BUSCA[String(x.type)] ?? 'contatos', x.id)}` : ''}`).join('\n') : 'nada encontrado';
      } },
    { id: 'freshsales.listar', descricao: 'lista contatos, contas ou negócios pela visão padrão (ou a visão escolhida), os mais recentes primeiro', rotulo: 'lista contatos, contas e negócios', risco: 'ler',
      params: { tipo: P_TIPO, visao: { tipo: 'texto', descricao: 'id da visão (filtro salvo); sem ela, a padrão' }, limite: { tipo: 'numero', descricao: 'quantos (padrão 25, até 100)', padrao: 25, max: 100 } },
      resumo: (a) => `Listar ${String(a.tipo)} do Freshsales`, metodo: 'GET', caminho: '/{_api}/view/{_visao}', consulta: { per_page: '{limite}', sort: 'updated_at', sort_type: 'desc' },
      antes: async (ctx, a) => {
        const t = tipoDe(a);
        let visao = vazio(a.visao) ? '' : String(a.visao);
        if (!visao) {
          const f = await ctx.http(`/${t.api}/filters`, { method: 'GET', kind: 'read' });
          const l: any[] = Array.isArray(f?.filters) ? f.filters : [];
          const v = l.find((x) => x.is_default) ?? l.find((x) => /^all\b/i.test(String(x.name ?? ''))) ?? l[0];
          if (!v) throw new ErroAcao(`o Freshsales não devolveu nenhuma visão de ${String(a.tipo)}`);
          visao = String(v.id);
        }
        return { ...a, _api: t.api, _visao: visao, _dominio: dominioDe(ctx) };
      },
      proximo: (j, a) => (j?.meta && Number(j.meta.total_pages) > Number(a.cursor ?? 1) ? String(Number(a.cursor ?? 1) + 1) : null), paramCursor: 'page',
      texto: (j, a) => { const l: any[] = Array.isArray(j?.[TIPOS[String(a.tipo)].api]) ? j[TIPOS[String(a.tipo)].api] : []; return l.length ? l.map((x) => `- ${linhaDoTipo(String(a.tipo), x, { dominio: String(a._dominio ?? '') })}`).join('\n') : 'nada encontrado'; } },
    { id: 'freshsales.ler', descricao: 'lê um contato, conta ou negócio pelo id, com o link', rotulo: 'lê um registro', risco: 'ler',
      params: { tipo: P_TIPO, id: { tipo: 'texto', obrigatorio: true, descricao: 'id do registro' } },
      resumo: (a) => `Ler ${String(a.tipo)} ${String(a.id)} do Freshsales`, metodo: 'GET', caminho: '/{_api}/{id}', antes: async (c, a) => ({ ...a, _api: tipoDe(a).api, _dominio: dominioDe(c) }),
      texto: (j, a) => { const x = j?.[TIPOS[String(a.tipo)].corpo]; return x ? linhaDoTipo(String(a.tipo), x, { dominio: String(a._dominio ?? '') }) : 'nada encontrado'; } },
    { id: 'freshsales.etapas', descricao: 'lista as etapas dos negócios (o id vai em "etapa" ao criar ou mudar um negócio)', rotulo: 'lista as etapas dos negócios', risco: 'ler',
      params: {}, resumo: 'Ler as etapas dos negócios do Freshsales', metodo: 'GET', caminho: '/selector/deal_stages',
      lista: 'deal_stages', linha: (x) => `${linhaDe('{name}', x)} (id: ${linhaDe('{id}', x)})` },
    { id: 'freshsales.criar', descricao: 'cria um contato (sobrenome ou e-mail), uma conta (empresa) ou um negócio (titulo e valor). Com responsável, o Freshsales avisa essa pessoa', rotulo: 'cria contato, conta ou negócio',
      risco: riscoDeAtribuir, params: { tipo: P_TIPO, ...PARAMS },
      resumo: (a) => `Criar ${TIPOS[String(a.tipo)]?.nome ?? String(a.tipo)} no Freshsales:\n${detalhes(a, ROTULOS)}`,
      preparar: async (ctx, a) => { await conferirCriar(ctx, a); return {}; },
      metodo: 'POST', caminho: '/{_api}', antes: async (ctx, a) => ({ ...(await conferirCriar(ctx, a)), _api: tipoDe(a).api, _dominio: dominioDe(ctx) }),
      corpo: (a: Args) => ({ [tipoDe(a).corpo]: registro(a) }),
      texto: (j, a) => { const x = j?.[tipoDe(a).corpo] ?? {}; return `${tipoDe(a).nome[0].toUpperCase()}${tipoDe(a).nome.slice(1)} criado no Freshsales (id: ${linhaDe('{id}', x)}).`; },
      url: (j, a) => { const x = j?.[TIPOS[String(a.tipo)]?.corpo ?? '']; return x?.id && a._dominio ? linkDe({ dominio: String(a._dominio) }, String(a.tipo), x.id) : null; } },
    { id: 'freshsales.atualizar', descricao: 'muda campos de um contato, conta ou negócio (ex.: a etapa ou o valor do negócio). Com responsável novo, o Freshsales avisa essa pessoa', rotulo: 'atualiza um registro',
      risco: riscoDeAtribuir, params: { tipo: P_TIPO, id: { tipo: 'texto', obrigatorio: true, descricao: 'id do registro' }, ...PARAMS },
      resumo: (a) => `Atualizar ${TIPOS[String(a.tipo)]?.nome ?? String(a.tipo)} ${String(a.id)} no Freshsales:\n${detalhes(a, ROTULOS)}`,
      preparar: async (_c, a) => { tipoDe(a); if (!Object.keys(registro(a)).length) throw new ErroAcao('diga o que mudar'); return {}; },
      metodo: 'PUT', caminho: '/{_api}/{id}', antes: async (c, a) => ({ ...a, _api: tipoDe(a).api, _dominio: dominioDe(c) }),
      corpo: (a: Args) => ({ [tipoDe(a).corpo]: registro(a) }),
      texto: (_j, a) => `${tipoDe(a).nome[0].toUpperCase()}${tipoDe(a).nome.slice(1)} ${String(a.id)} atualizado no Freshsales.`,
      url: (_j, a) => (a._dominio ? linkDe({ dominio: String(a._dominio) }, String(a.tipo), a.id) : null) },
  ],
};

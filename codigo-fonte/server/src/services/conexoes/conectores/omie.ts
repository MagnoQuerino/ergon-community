/**
 * Omie: contas a receber, contas a pagar e clientes. SOMENTE LEITURA, por decisão de segurança: só chamadas Listar,
 * Pesquisar e Consultar (o tipo Chamada abaixo não aceita outras), e todas têm risco 'ler'. Nada aqui lança, baixa, cancela
 * ou altera valores. A Omie usa POST também para ler; o risco 'ler' é o que faz o motor tratar a chamada como leitura.
 *
 * A credencial vai no corpo de cada chamada (é o formato da Omie): nunca entra em resumo, parâmetro nem texto de resultado.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   https://ajuda.omie.com.br/pt-BR/articles/5412721-caracteristicas-e-recomendacoes-das-apis-do-omie (call, app_key, app_secret, param; só POST)
 *   https://ajuda.omie.com.br/pt-BR/articles/499061-obtendo-a-chave-de-acesso-para-integracoes-de-api (onde ver a chave; só administrador; nova chave derruba as integrações)
 *   https://ajuda.omie.com.br/pt-BR/articles/8112984-limites-de-consumo-da-api-do-omie (mesmo id em 60 s; bloqueio de 30 min com HTTP 425)
 *   https://ajuda.omie.com.br/pt-BR/articles/8001888-tratando-os-erros-de-api, https://ajuda.omie.com.br/pt-BR/articles/12607801-boas-praticas-de-integracao-com-as-apis-do-omie
 *   https://developer.omie.com.br/service-list/ (lista dos serviços)
 *   https://app.omie.com.br/api/v1/financas/contareceber/, https://app.omie.com.br/api/v1/financas/contapagar/,
 *   https://app.omie.com.br/api/v1/financas/pesquisartitulos/, https://app.omie.com.br/api/v1/geral/clientes/,
 *   https://app.omie.com.br/api/v1/geral/empresas/ (cada método, com parâmetros e resposta)
 *
 * ListarContasReceber e ListarContasPagar não filtram por vencimento: as datas delas são de inclusão, alteração, emissão e
 * registro. Por isso existe omie.pesquisar_contas, com PesquisarLancamentos, que filtra por vencimento e pagamento.
 * CPF, CNPJ e dados bancários servem de filtro ou ficam de fora: não saem nas respostas.
 */
import { linhaDe, type ConectorDef, type Credenciais } from './declarativo.ts';
import { ErroAcao, type Args, type CtxAcao, type Param } from '../tipos.ts';

type Chamada = 'ListarEmpresas' | 'ListarContasReceber' | 'ConsultarContaReceber' | 'ListarContasPagar' | 'ConsultarContaPagar' | 'PesquisarLancamentos' | 'ListarClientes' | 'ConsultarCliente';
type Campos = Array<[rotulo: string, campo: string]>;

/** Corpo de toda chamada à Omie. Sem credencial, recusa aqui em vez de ir ao serviço (erro repetido lá gera bloqueio). */
const envelope = (call: Chamada, c: Credenciais, param: Record<string, unknown>) => {
  if (!c.app_key || !c.app_secret) throw new ErroAcao('falta a credencial da Omie: conecte de novo em Conexões');
  return { call, app_key: c.app_key, app_secret: c.app_secret, param: [param] };
};

/** Só o que veio preenchido, com o valor limpo por linhaDe: texto de terceiros nunca vira linha de controle. */
const ficha = (x: unknown, campos: Campos, separador = '\n'): string =>
  campos.flatMap(([rotulo, campo]) => { const v = linhaDe(`{${campo}}`, x); return v ? [`${rotulo}: ${v}`] : []; }).join(separador);

const comFiltros = (frase: string, a: Args, nomes: Record<string, string>): string => {
  const f = Object.entries(nomes).flatMap(([k, nome]) => (a[k] === undefined || a[k] === '' ? [] : [`${nome}: ${String(a[k])}`]));
  return f.length ? `${frase} (${f.join('; ')})` : frase;
};

const exigir = (a: Args, k: string): unknown => { if (a[k] === undefined) throw new ErroAcao(`falta "${k}"`); return a[k]; };

/** A Omie usa dd/mm/aaaa; AAAA-MM-DD também é aceito aqui e convertido. Data inválida não chega a ir ao serviço. */
const dataOmie = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : s;
  if (!/^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/.test(d)) throw new ErroAcao(`data inválida: "${s.slice(0, 20)}". Use dd/mm/aaaa`);
  return d;
};

/**
 * A página da Omie vai no corpo, não no endereço. O motor pede o cursor na consulta, então ele vira `pagina` aqui e sai dos
 * parâmetros: assim o endereço fica limpo e o agente continua usando o cursor como em qualquer outro aplicativo.
 */
const paginaDoCursor = async (_ctx: CtxAcao, a: Args): Promise<Args> => {
  const { cursor, ...resto } = a;
  if (cursor === undefined) return resto;
  const pagina = Number(cursor);
  if (!Number.isInteger(pagina) || pagina < 1) throw new ErroAcao('"cursor" precisa ser o número que veio na resposta anterior');
  return { ...resto, pagina };
};
const proximaPagina = (atual: unknown, total: unknown): string | null => (Number(atual) < Number(total) ? String(Number(atual) + 1) : null);
const paginaDe = (a: Args) => ({ pagina: a.pagina ?? 1, registros_por_pagina: a.limite, apenas_importado_api: 'N' });

// Os campos que os agentes leem. Dados bancários, CPF e CNPJ ficam de fora de propósito.
const camposConta = (quem: string): Campos => [['Id', 'codigo_lancamento_omie'], ['Vencimento', 'data_vencimento'], ['Valor em R$', 'valor_documento'], ['Situação', 'status_titulo'], [quem, 'codigo_cliente_fornecedor'], ['Documento', 'numero_documento'], ['Parcela', 'numero_parcela']];
const contaInteira = (quem: string): Campos => [...camposConta(quem), ['Previsão', 'data_previsao'], ['Emissão', 'data_emissao'], ['Categoria', 'codigo_categoria'], ['Observação', 'observacao']];
const TITULO: Campos = [['Id', 'cabecTitulo.nCodTitulo'], ['Tipo (R receber, P pagar)', 'cabecTitulo.cNatureza'], ['Vencimento', 'cabecTitulo.dDtVenc'], ['Pagamento', 'cabecTitulo.dDtPagamento'], ['Valor em R$', 'cabecTitulo.nValorTitulo'], ['Em aberto em R$', 'resumo.nValAberto'], ['Situação', 'cabecTitulo.cStatus'], ['Cliente ou fornecedor', 'cabecTitulo.nCodCliente'], ['Número', 'cabecTitulo.cNumTitulo']];
const CLIENTE: Campos = [['Id', 'codigo_cliente_omie'], ['Razão social', 'razao_social'], ['Nome fantasia', 'nome_fantasia'], ['Contato', 'contato'], ['E-mail', 'email'], ['DDD', 'telefone1_ddd'], ['Telefone', 'telefone1_numero'], ['Cidade', 'cidade'], ['Estado', 'estado'], ['Inativo', 'inativo']];
const CLIENTE_INTEIRO: Campos = [...CLIENTE, ['Endereço', 'endereco'], ['Número', 'endereco_numero'], ['Bairro', 'bairro'], ['Observação', 'observacao']];

const LIMITE: Param = { tipo: 'numero', descricao: 'quantos trazer por vez, até 50 (padrão 30)', padrao: 30, max: 50 };
const data = (descricao: string): Param => ({ tipo: 'texto', descricao: `${descricao}, como dd/mm/aaaa` });
const ID_LANCAMENTO: Param = { tipo: 'numero', obrigatorio: true, descricao: 'id da conta, que vem nas listas' };
const FILTROS_CONTA: Record<string, Param> = {
  cliente: { tipo: 'numero', descricao: 'id do cliente ou fornecedor' }, cpf_cnpj: { tipo: 'texto', descricao: 'CPF ou CNPJ, só números' },
  emissao_de: data('emitida a partir de'), emissao_ate: data('emitida até'), limite: LIMITE,
};
const NOMES_CONTA = { cliente: 'cliente ou fornecedor', cpf_cnpj: 'CPF ou CNPJ', emissao_de: 'emitida a partir de', emissao_ate: 'emitida até' };
const filtrosConta = (a: Args) => ({ ...paginaDe(a), filtrar_cliente: a.cliente, filtrar_por_cpf_cnpj: a.cpf_cnpj, filtrar_por_emissao_de: dataOmie(a.emissao_de), filtrar_por_emissao_ate: dataOmie(a.emissao_ate) });
/** A página da Omie não deixa claro se a consulta devolve o cadastro direto ou dentro do nome dele: aceita os dois. */
const fichaOuNada = (j: any, campos: Campos, chave: string): string => ficha(j?.[chave] ?? j, campos) || 'nada encontrado';
const ligado = (v: unknown) => v === true || v === 'true' || v === 'sim';

export const OMIE: ConectorDef = {
  kind: 'omie', nome: 'Omie', site: 'omie.com.br', grupo: 'financeiro',
  sobre: 'Seu sistema de gestão na Omie: os agentes consultam contas a receber, contas a pagar e clientes. Só leitura: por esta conexão nenhum agente lança, baixa, cancela ou altera valores.',
  // o App Key é o identificador do aplicativo, curto demais para a regra de campo secreto (a Omie mostra de exemplo 10 dígitos)
  campos: [
    { name: 'app_key', label: 'App Key', placeholder: 'Cole o App Key aqui' },
    { name: 'app_secret', label: 'App Secret', secret: true, placeholder: 'Cole o App Secret aqui' },
  ],
  ajuda: {
    url: 'https://developer.omie.com.br/my-apps/',
    passos: 'Só um administrador do aplicativo na Omie consegue ver a chave. Entre na Omie, clique no botão "Developer" e depois em "Aplicativos". Clique no seu aplicativo para abrir os detalhes e copie "App Key" e "App Secret" para cá. Não clique em "Gerar nova chave de acesso": isso faz parar tudo o que já usa a chave de hoje. A Omie não informa uma chave só de leitura, então trate esta como acesso completo e não a guarde em outro lugar.',
  },
  base: 'https://app.omie.com.br/api/v1',
  auth: { tipo: 'nenhuma' },
  // formatos de erro da Omie: omie_fail (nas páginas dos métodos) e status com message (no artigo de características);
  // faultstring é o erro padrão do SOAP, que a Omie diz seguir
  erroNoCorpo: (j) => {
    const m = j?.faultstring ?? j?.omie_fail?.description ?? (j?.status !== undefined && typeof j?.message === 'string' ? j.message : null);
    return m ? { mensagem: String(m), permissao: /chave de acesso|app_?(key|secret)|suspenso|permiss|n[aã]o autorizad/i.test(String(m)) } : null;
  },
  quemSou: {
    caminho: '/geral/empresas/', metodo: 'POST', semRepetir: true,
    corpo: (c: Credenciais) => envelope('ListarEmpresas', c, { pagina: 1, registros_por_pagina: 1 }),
    nome: (j) => { const e = j?.empresas_cadastro?.[0]; return String(e?.nome_fantasia || e?.razao_social || 'conta Omie'); },
  },
  acoes: [
    { id: 'omie.contas_receber', descricao: 'lista as contas a receber. Para filtrar por vencimento ou pagamento, use omie.pesquisar_contas', rotulo: 'lista as contas a receber', risco: 'ler',
      params: { ...FILTROS_CONTA, em_aberto: { tipo: 'booleano', descricao: 'só as que ainda estão em aberto' } },
      resumo: (a) => comFiltros(ligado(a.em_aberto) ? 'Ler as contas a receber em aberto da Omie' : 'Ler as contas a receber da Omie', a, NOMES_CONTA),
      metodo: 'POST', caminho: '/financas/contareceber/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => envelope('ListarContasReceber', c, { ...filtrosConta(a), filtrar_apenas_titulos_em_aberto: a.em_aberto ? 'S' : undefined }),
      lista: 'conta_receber_cadastro', linha: (x) => ficha(x, camposConta('Cliente'), ', '), proximo: (j) => proximaPagina(j.pagina, j.total_de_paginas) },
    { id: 'omie.conta_receber', descricao: 'mostra uma conta a receber pelo id. A Omie só responde uma vez por minuto à mesma conta', rotulo: 'mostra uma conta a receber', risco: 'ler',
      params: { id: ID_LANCAMENTO }, resumo: 'Ler a conta a receber {id} da Omie', metodo: 'POST', caminho: '/financas/contareceber/',
      corpo: (a: Args, c: Credenciais) => envelope('ConsultarContaReceber', c, { codigo_lancamento_omie: exigir(a, 'id') }),
      texto: (j) => fichaOuNada(j, contaInteira('Cliente'), 'conta_receber_cadastro') },
    { id: 'omie.contas_pagar', descricao: 'lista as contas a pagar. Para filtrar por vencimento ou pagamento, use omie.pesquisar_contas', rotulo: 'lista as contas a pagar', risco: 'ler',
      params: { ...FILTROS_CONTA, situacao: { tipo: 'texto', descricao: 'situação da conta', opcoes: ['CANCELADO', 'PAGO', 'LIQUIDADO', 'EMABERTO', 'PAGTO_PARCIAL', 'VENCEHOJE', 'AVENCER', 'ATRASADO'] } },
      resumo: (a) => comFiltros('Ler as contas a pagar da Omie', a, { ...NOMES_CONTA, situacao: 'situação' }),
      metodo: 'POST', caminho: '/financas/contapagar/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => envelope('ListarContasPagar', c, { ...filtrosConta(a), filtrar_por_status: a.situacao }),
      lista: 'conta_pagar_cadastro', linha: (x) => ficha(x, camposConta('Fornecedor'), ', '), proximo: (j) => proximaPagina(j.pagina, j.total_de_paginas) },
    { id: 'omie.conta_pagar', descricao: 'mostra uma conta a pagar pelo id. A Omie só responde uma vez por minuto à mesma conta', rotulo: 'mostra uma conta a pagar', risco: 'ler',
      params: { id: ID_LANCAMENTO }, resumo: 'Ler a conta a pagar {id} da Omie', metodo: 'POST', caminho: '/financas/contapagar/',
      corpo: (a: Args, c: Credenciais) => envelope('ConsultarContaPagar', c, { codigo_lancamento_omie: exigir(a, 'id') }),
      texto: (j) => fichaOuNada(j, contaInteira('Fornecedor'), 'conta_pagar_cadastro') },
    { id: 'omie.pesquisar_contas', descricao: 'procura contas a receber ou a pagar por vencimento, pagamento, situação ou cliente', risco: 'ler',
      params: {
        tipo: { tipo: 'texto', descricao: 'receber ou pagar; sem isso, traz as duas', opcoes: ['receber', 'pagar'] },
        vencimento_de: data('vencimento a partir de'), vencimento_ate: data('vencimento até'),
        pagamento_de: data('pagamento a partir de'), pagamento_ate: data('pagamento até'),
        situacao: { tipo: 'texto', descricao: 'situação da conta', opcoes: ['CANCELADO', 'RECEBIDO', 'LIQUIDADO', 'EMABERTO', 'PAGTO_PARCIAL', 'VENCEHOJE', 'AVENCER', 'ATRASADO'] },
        cliente: { tipo: 'numero', descricao: 'id do cliente ou fornecedor' }, limite: LIMITE,
      },
      resumo: (a) => comFiltros('Procurar contas na Omie', a, { tipo: 'tipo', vencimento_de: 'vencimento a partir de', vencimento_ate: 'vencimento até', pagamento_de: 'pagamento a partir de', pagamento_ate: 'pagamento até', situacao: 'situação', cliente: 'cliente ou fornecedor' }),
      metodo: 'POST', caminho: '/financas/pesquisartitulos/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => envelope('PesquisarLancamentos', c, {
        nPagina: a.pagina ?? 1, nRegPorPagina: a.limite, cNatureza: a.tipo === 'receber' ? 'R' : a.tipo === 'pagar' ? 'P' : undefined,
        dDtVencDe: dataOmie(a.vencimento_de), dDtVencAte: dataOmie(a.vencimento_ate), dDtPagtoDe: dataOmie(a.pagamento_de), dDtPagtoAte: dataOmie(a.pagamento_ate),
        cStatus: a.situacao, nCodCliente: a.cliente,
      }),
      lista: 'titulosEncontrados', linha: (x) => ficha(x, TITULO, ', '), proximo: (j) => proximaPagina(j.nPagina, j.nTotPaginas) },
    { id: 'omie.clientes', descricao: 'lista clientes e fornecedores, com filtros por nome, e-mail, CPF ou CNPJ', risco: 'ler',
      params: {
        razao_social: { tipo: 'texto', descricao: 'razão social' }, nome_fantasia: { tipo: 'texto', descricao: 'nome fantasia' },
        email: { tipo: 'texto', descricao: 'e-mail' }, cpf_cnpj: { tipo: 'texto', descricao: 'CPF ou CNPJ' }, limite: LIMITE,
      },
      resumo: (a) => comFiltros('Ler os clientes da Omie', a, { razao_social: 'razão social', nome_fantasia: 'nome fantasia', email: 'e-mail', cpf_cnpj: 'CPF ou CNPJ' }),
      metodo: 'POST', caminho: '/geral/clientes/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => {
        const filtro = Object.entries({ razao_social: a.razao_social, nome_fantasia: a.nome_fantasia, email: a.email, cnpj_cpf: a.cpf_cnpj }).filter(([, v]) => v !== undefined);
        return envelope('ListarClientes', c, { ...paginaDe(a), ...(filtro.length ? { clientesFiltro: Object.fromEntries(filtro) } : {}) });
      },
      lista: 'clientes_cadastro', linha: (x) => ficha(x, CLIENTE, ', '), proximo: (j) => proximaPagina(j.pagina, j.total_de_paginas) },
    { id: 'omie.cliente', descricao: 'mostra um cliente ou fornecedor pelo id. A Omie só responde uma vez por minuto ao mesmo cliente', rotulo: 'mostra um cliente ou fornecedor', risco: 'ler',
      params: { id: { tipo: 'numero', obrigatorio: true, descricao: 'id do cliente, que vem na lista' } },
      resumo: 'Ler o cliente {id} da Omie', metodo: 'POST', caminho: '/geral/clientes/',
      corpo: (a: Args, c: Credenciais) => envelope('ConsultarCliente', c, { codigo_cliente_omie: exigir(a, 'id') }),
      texto: (j) => fichaOuNada(j, CLIENTE_INTEIRO, 'clientes_cadastro') },
  ],
};

// a Omie usa 500 também para parâmetro errado e bloqueia depois de poucos pedidos errados: nenhuma ação repete sozinha
for (const a of OMIE.acoes) a.semRepetir = true;

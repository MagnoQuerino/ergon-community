/**
 * Omie: contas a receber, contas a pagar e clientes, e a escrita que uma pequena empresa usa no dia a dia: incluir um cliente e
 * incluir uma conta a receber. NADA AQUI MOVE DINHEIRO: só chamadas Listar, Pesquisar, Consultar e Incluir (o tipo Chamada
 * abaixo não aceita outras); nenhuma baixa, recebimento, pagamento, cancelamento, estorno, exclusão ou alteração de valor
 * (test/conexoes-financeiro.test.ts confere). Incluir só organiza: a Omie não manda nada a ninguém (o boleto não é gerado).
 * A Omie usa POST também para ler; o risco 'ler' é o que faz o motor tratar a chamada como leitura.
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
 * Escrita e listas de apoio, conferidas em 08/11/2026:
 *   https://app.omie.com.br/api/v1/geral/clientes/ (IncluirCliente: clientes_cadastro; volta clientes_status com codigo_cliente_omie)
 *   https://app.omie.com.br/api/v1/financas/contareceber/ (IncluirContaReceber: codigo_lancamento_integracao, codigo_cliente_fornecedor,
 *     data_vencimento, valor_documento, codigo_categoria, data_previsao, id_conta_corrente; volta codigo_lancamento_omie)
 *   https://app.omie.com.br/api/v1/geral/categorias/ (ListarCategorias: categoria_cadastro) e
 *   https://app.omie.com.br/api/v1/geral/contacorrente/ (ListarContasCorrentes: lista em ListarContasCorrentes, nCodCC)
 * Código de integração (a Omie recusa um código repetido):
 *  - cliente: sai dos dados e do dia (no fuso do workspace): repetir o mesmo cadastro no mesmo dia faz a Omie recusar a cópia;
 *  - conta a receber: um código novo a cada inclusão (decisão de 09/11: lançamento idêntico no mesmo dia fica liberado — duas
 *    vendas iguais no mesmo dia são comuns). Quem segura a repetição do MESMO envio numa nova tentativa é o sistema: a
 *    conferência por trabalho (servico.ts, dedupe: o mesmo pedido já feito no card, ou na conversa nos últimos 15 minutos,
 *    não sai de novo), a resposta que se perdeu ("pode ter feito ou não": o mesmo envio não sai de novo sozinho, no card até a
 *    pessoa responder pedindo de novo e na conversa por 15 minutos, a menos que a mensagem nova dela peça de novo).
 *
 * ListarContasReceber e ListarContasPagar não filtram por vencimento: as datas delas são de inclusão, alteração, emissão e
 * registro. Por isso existe omie.pesquisar_contas, com PesquisarLancamentos, que filtra por vencimento e pagamento.
 * CPF, CNPJ e dados bancários servem de filtro ou ficam de fora: não saem nas respostas.
 */
import crypto from 'node:crypto';
import { linhaDe, type ConectorDef, type Credenciais } from './declarativo.ts';
import { ErroAcao, type Args, type CtxAcao, type Param } from '../tipos.ts';

type Chamada = 'ListarEmpresas' | 'ListarContasReceber' | 'ConsultarContaReceber' | 'ListarContasPagar' | 'ConsultarContaPagar' | 'PesquisarLancamentos' | 'ListarClientes' | 'ConsultarCliente'
  | 'ListarCategorias' | 'ListarContasCorrentes' | 'IncluirCliente' | 'IncluirContaReceber';
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

// ---------------------------------------------------------------------------------------------------------- escrita
const vazio = (v: unknown) => v === undefined || v === null || v === '';
/**
 * O dia no fuso do workspace (AAAA-MM-DD). Em UTC, um pedido repetido às 21h01 em Brasília já cairia no dia seguinte e
 * levaria outro código: a Omie lançaria duas vezes.
 */
export const diaNoFuso = (tz: string | undefined, agora = new Date()): string => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora); } catch { return agora.toISOString().slice(0, 10); }
};
/** Código de integração do cliente: o mesmo cadastro no mesmo dia (do workspace) dá o mesmo código, e a Omie recusa a cópia. */
const codigoIntegracao = (tipo: string, dados: unknown, dia?: unknown): string =>
  `ergon-${tipo}-${crypto.createHash('sha256').update(JSON.stringify([typeof dia === 'string' && dia ? dia : diaNoFuso(undefined), dados])).digest('hex').slice(0, 32)}`;
/** Código de integração da conta a receber: um novo a cada inclusão (mesmo formato do de cliente: "ergon-cr-" e 32 letras e números). */
const codigoUnico = (tipo: string): string => `ergon-${tipo}-${crypto.randomBytes(16).toString('hex')}`;
/** A Omie recusou o código de integração repetido: a inclusão já foi feita antes (talvez a resposta tenha se perdido). */
const REPETIDA = (m: string) => /c[óo]digo de integra[çc][ãa]o/i.test(m) && /j[áa]\s+(?:foi\s+)?(?:cadastrad|existe|inclu[íi]d|lan[çc]ad)/i.test(m);
const JA_INCLUIDO: Record<'cli' | 'cr', string> = {
  cli: 'este cliente já foi incluído antes na Omie, com os mesmos dados, e não incluí de novo: procure o id dele em omie.clientes e siga com ele',
  cr: 'a Omie diz que esta conta a receber já foi incluída antes, e não incluí de novo: confira em omie.contas_receber antes de pedir outra',
};
/** O erro de código repetido, em palavras que o agente entende: ele confere ou muda o pedido, em vez de insistir no mesmo. */
const erroDaInclusao = (tipo: 'cli' | 'cr') => (e: unknown): Error | null => (e instanceof Error && REPETIDA(e.message) ? new ErroAcao(JA_INCLUIDO[tipo]) : null);
const valorOk = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ErroAcao('"valor" precisa ser maior que zero, em reais (ex.: 129.90)');
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new ErroAcao('"valor" tem mais de dois decimais: use reais e centavos (ex.: 129.90)');
  return Math.round(n * 100) / 100;
};
const reais = (v: unknown) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
/** O que a pessoa lê no cartão: cada campo preenchido, por extenso e sem cortar. */
const detalhes = (a: Args, rotulos: Record<string, string>): string =>
  Object.entries(rotulos).flatMap(([k, r]) => (vazio(a[k]) ? [] : [`${r}: ${k === 'valor' ? reais(a[k]) : String(a[k])}`])).join('\n');
/** A Omie diz codigo_status "0" quando incluiu; outro código é recusa, mesmo com 200. */
const incluido = (j: any, oQue: string, campoId: string, tipo: 'cli' | 'cr'): string => {
  const st = j?.codigo_status;
  if (st !== undefined && String(st) !== '0') {
    const motivo = linhaDe('{descricao_status}', j);
    throw new ErroAcao(REPETIDA(motivo) ? JA_INCLUIDO[tipo] : `a Omie não incluiu ${oQue}: ${motivo || `código ${String(st)}`}`);
  }
  return `${oQue[0].toUpperCase()}${oQue.slice(1)} incluíd${oQue.startsWith('a ') ? 'a' : 'o'} na Omie (id: ${linhaDe(`{${campoId}}`, j) || 'sem id na resposta'}).`;
};
const R_CLIENTE = { razao_social: 'razão social', nome_fantasia: 'nome fantasia', cpf_cnpj: 'CPF ou CNPJ', email: 'e-mail', ddd: 'DDD', telefone: 'telefone', contato: 'contato', endereco: 'endereço', numero: 'número', bairro: 'bairro', cidade: 'cidade', estado: 'estado', cep: 'CEP', observacao: 'observação' };
const R_CONTA = { cliente: 'cliente (id)', valor: 'valor', vencimento: 'vencimento', previsao: 'previsão de recebimento', categoria: 'categoria', conta_corrente: 'conta corrente (id)', documento: 'número do documento', observacao: 'observação' };

export const OMIE: ConectorDef = {
  kind: 'omie', nome: 'Omie', site: 'omie.com.br', grupo: 'financeiro',
  sobre: 'Seu sistema de gestão na Omie: os agentes consultam contas a receber, contas a pagar e clientes, e incluem clientes e contas a receber. Nenhum agente dá baixa, paga, cancela ou altera valores por esta conexão. Para só consultar, use "Só leitura".',
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
    { id: 'omie.categorias', descricao: 'lista as categorias (receitas e despesas), com o código que omie.incluir_conta_receber usa', rotulo: 'lista as categorias de receitas e despesas', risco: 'ler',
      params: { limite: LIMITE }, resumo: 'Ler as categorias da Omie', metodo: 'POST', caminho: '/geral/categorias/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => envelope('ListarCategorias', c, { pagina: a.pagina ?? 1, registros_por_pagina: a.limite }),
      lista: 'categoria_cadastro',
      linha: (x: any) => ficha({ ...x, tipo: x?.conta_receita === 'S' ? 'receita' : x?.conta_despesa === 'S' ? 'despesa' : '', inativa: x?.conta_inativa === 'S' ? 'sim' : '' }, [['Código', 'codigo'], ['Descrição', 'descricao'], ['Tipo', 'tipo'], ['Inativa', 'inativa']], ', '),
      proximo: (j) => proximaPagina(j.pagina, j.total_de_paginas) },
    { id: 'omie.contas_correntes', descricao: 'lista as contas correntes (bancos e caixa), com o id que omie.incluir_conta_receber usa', rotulo: 'lista as contas correntes', risco: 'ler',
      params: { limite: LIMITE }, resumo: 'Ler as contas correntes da Omie', metodo: 'POST', caminho: '/geral/contacorrente/', antes: paginaDoCursor,
      corpo: (a: Args, c: Credenciais) => envelope('ListarContasCorrentes', c, paginaDe(a)),
      lista: 'ListarContasCorrentes', linha: (x) => ficha(x, [['Id', 'nCodCC'], ['Descrição', 'descricao'], ['Banco', 'codigo_banco'], ['Inativa', 'inativo']], ', '),
      proximo: (j) => proximaPagina(j.pagina, j.total_de_paginas) },

    { id: 'omie.incluir_cliente', descricao: 'inclui um cliente na Omie (razão social obrigatória). Não manda nada a ele. Antes, veja em omie.clientes se ele já existe', rotulo: 'inclui um cliente', risco: 'organizar',
      params: {
        razao_social: { tipo: 'texto', obrigatorio: true, descricao: 'razão social ou nome completo', max: 60 }, nome_fantasia: { tipo: 'texto', descricao: 'nome fantasia', max: 100 },
        cpf_cnpj: { tipo: 'texto', descricao: 'CPF ou CNPJ' }, email: { tipo: 'texto', descricao: 'e-mail', max: 500 },
        ddd: { tipo: 'texto', descricao: 'DDD do telefone' }, telefone: { tipo: 'texto', descricao: 'telefone, sem o DDD' }, contato: { tipo: 'texto', descricao: 'nome da pessoa de contato' },
        endereco: { tipo: 'texto', descricao: 'rua' }, numero: { tipo: 'texto', descricao: 'número' }, bairro: { tipo: 'texto', descricao: 'bairro' },
        cidade: { tipo: 'texto', descricao: 'cidade' }, estado: { tipo: 'texto', descricao: 'estado, com a sigla (MG)' }, cep: { tipo: 'texto', descricao: 'CEP' },
        observacao: { tipo: 'texto', descricao: 'observação', max: 2000 },
      },
      resumo: (a) => `Incluir um cliente na Omie:\n${detalhes(a, R_CLIENTE)}`,
      metodo: 'POST', caminho: '/geral/clientes/',
      antes: async (ctx, a) => {
        if (!vazio(a.cpf_cnpj) && ![11, 14].includes(String(a.cpf_cnpj).replace(/\D/g, '').length)) throw new ErroAcao('"cpf_cnpj" precisa ter 11 números (CPF) ou 14 (CNPJ)');
        if (!vazio(a.estado) && !/^[A-Za-z]{2}$/.test(String(a.estado))) throw new ErroAcao('"estado" precisa ser a sigla, como MG');
        return { ...a, diaDoPedido: diaNoFuso(ctx.tz) };
      },
      corpo: (a: Args, c: Credenciais) => {
        const dados = Object.fromEntries(Object.entries({
          razao_social: a.razao_social, nome_fantasia: a.nome_fantasia, cnpj_cpf: vazio(a.cpf_cnpj) ? undefined : String(a.cpf_cnpj).replace(/\D/g, ''), email: a.email,
          telefone1_ddd: a.ddd, telefone1_numero: a.telefone, contato: a.contato, endereco: a.endereco, endereco_numero: a.numero, bairro: a.bairro,
          cidade: a.cidade, estado: vazio(a.estado) ? undefined : String(a.estado).toUpperCase(), cep: a.cep, observacao: a.observacao,
        }).filter(([, v]) => !vazio(v)));
        return envelope('IncluirCliente', c, { codigo_cliente_integracao: codigoIntegracao('cli', dados, a.diaDoPedido), ...dados });
      },
      texto: (j) => incluido(j, 'o cliente', 'codigo_cliente_omie', 'cli'), erro: erroDaInclusao('cli') },
    { id: 'omie.incluir_conta_receber', descricao: 'inclui uma conta a receber (um título) para um cliente já cadastrado. Veja o código da categoria em omie.categorias e o id da conta corrente em omie.contas_correntes. Só lança o título: não gera boleto, não manda nada ao cliente e não dá baixa', rotulo: 'inclui uma conta a receber', risco: 'organizar',
      params: {
        cliente: { tipo: 'numero', obrigatorio: true, descricao: 'id do cliente, que vem em omie.clientes' }, valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor em reais, como 129.90' },
        vencimento: { ...data('vencimento'), obrigatorio: true }, previsao: data('previsão de recebimento (padrão: o vencimento)'),
        categoria: { tipo: 'texto', obrigatorio: true, descricao: 'código da categoria, como 1.01.02 (veja omie.categorias)' },
        conta_corrente: { tipo: 'numero', obrigatorio: true, descricao: 'id da conta corrente (veja omie.contas_correntes)' },
        documento: { tipo: 'texto', descricao: 'número do documento, como o da nota', max: 20 }, observacao: { tipo: 'texto', descricao: 'observação', max: 2000 },
      },
      resumo: (a) => `Incluir uma conta a receber na Omie (não gera boleto e não avisa o cliente):\n${detalhes(a, R_CONTA)}`,
      metodo: 'POST', caminho: '/financas/contareceber/',
      antes: async (_ctx, a) => {
        // código novo a cada inclusão: lançamento idêntico no mesmo dia vai (a repetição do mesmo envio, o sistema segura antes)
        return { ...a, codigoDaInclusao: codigoUnico('cr'), valor: valorOk(a.valor), vencimento: dataOmie(a.vencimento), previsao: dataOmie(vazio(a.previsao) ? a.vencimento : a.previsao) };
      },
      corpo: (a: Args, c: Credenciais) => {
        const dados = Object.fromEntries(Object.entries({
          codigo_cliente_fornecedor: a.cliente, data_vencimento: a.vencimento, data_previsao: a.previsao, valor_documento: a.valor,
          codigo_categoria: a.categoria, id_conta_corrente: a.conta_corrente, numero_documento: a.documento, observacao: a.observacao,
        }).filter(([, v]) => !vazio(v)));
        const codigo = typeof a.codigoDaInclusao === 'string' && /^ergon-cr-[0-9a-f]{32}$/.test(a.codigoDaInclusao) ? a.codigoDaInclusao : codigoUnico('cr');
        return envelope('IncluirContaReceber', c, { codigo_lancamento_integracao: codigo, ...dados });
      },
      texto: (j) => incluido(j, 'a conta a receber', 'codigo_lancamento_omie', 'cr'), erro: erroDaInclusao('cr') },
  ],
};

// a Omie usa 500 também para parâmetro errado e bloqueia depois de poucos pedidos errados: nenhuma ação repete sozinha
for (const a of OMIE.acoes) a.semRepetir = true;

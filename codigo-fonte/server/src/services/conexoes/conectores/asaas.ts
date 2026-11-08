/**
 * Asaas: cobranças, clientes e saldo. SOMENTE LEITURA, por decisão de segurança: nenhuma ação daqui cobra, paga, transfere,
 * cancela ou altera valores, e todas têm risco 'ler' com método GET. Não acrescente escrita a este arquivo: a chave do Asaas
 * não tem permissões por tipo ("carrega todos os privilégios de acesso e controle" da conta), então o limite é este arquivo.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   https://docs.asaas.com/docs/autentica%C3%A7%C3%A3o-1 (cabeçalho access_token, User-Agent, endereços, códigos de erro)
 *   https://docs.asaas.com/docs/chaves-de-api (só pela web, só administrador, exibida uma vez, inatividade de 3 e 6 meses)
 *   https://docs.asaas.com/changelog/novidade-novo-prefixo-de-identifica%C3%A7%C3%A3o-das-chaves-api ($aact_prod_, $aact_hmlg_; as antigas seguem valendo)
 *   https://central.ajuda.asaas.com/hc/pt-br/articles/33618186066331-Como-gerar-uma-chave-de-API (nomes de menu e botão)
 *   https://www.asaas.com/desenvolvedores (a chave dá acesso total à conta)
 *   https://docs.asaas.com/reference/listar-cobrancas, .../recuperar-uma-unica-cobranca, .../listar-clientes,
 *   .../recuperar-um-unico-cliente, .../recuperar-saldo-da-conta, .../recuperar-dados-comerciais, .../rate-e-quota-limit
 *
 * CPF e CNPJ dos clientes servem de filtro, mas não saem nas respostas: o agente não precisa deles para responder.
 */
import { linhaDe, type ConectorDef } from './declarativo.ts';
import type { Args, Param } from '../tipos.ts';

type Campos = Array<[rotulo: string, campo: string]>;

/** Só o que veio preenchido, com o valor limpo por linhaDe: texto de terceiros nunca vira linha de controle. */
const ficha = (x: unknown, campos: Campos, separador = '\n'): string =>
  campos.flatMap(([rotulo, campo]) => { const v = linhaDe(`{${campo}}`, x); return v ? [`${rotulo}: ${v}`] : []; }).join(separador);

const comFiltros = (frase: string, a: Args, nomes: Record<string, string>): string => {
  const f = Object.entries(nomes).flatMap(([k, nome]) => (a[k] === undefined || a[k] === '' ? [] : [`${nome}: ${String(a[k])}`]));
  return f.length ? `${frase} (${f.join('; ')})` : frase;
};

/** A resposta diz se há mais e onde esta página começou; o próximo começo é o cursor. */
const proximaPagina = (j: any): string | null => (j.hasMore ? String(Number(j.offset) + Number(j.limit)) : null);

const COBRANCA: Campos = [['Id', 'id'], ['Descrição', 'description'], ['Cliente', 'customer'], ['Valor em R$', 'value'], ['Situação', 'status'], ['Forma', 'billingType'], ['Vencimento', 'dueDate'], ['Pagamento', 'paymentDate']];
const COBRANCA_INTEIRA: Campos = [...COBRANCA, ['Valor líquido em R$', 'netValue'], ['Crédito', 'creditDate'], ['Referência', 'externalReference'], ['Fatura', 'invoiceUrl']];
const CLIENTE: Campos = [['Id', 'id'], ['Nome', 'name'], ['E-mail', 'email'], ['Celular', 'mobilePhone'], ['Telefone', 'phone'], ['Referência', 'externalReference']];
const CLIENTE_INTEIRO: Campos = [...CLIENTE, ['Cidade', 'cityName'], ['Estado', 'state'], ['Observações', 'observations']];

const LIMITE: Param = { tipo: 'numero', descricao: 'quantos trazer, até 100 (padrão 30)', padrao: 30, max: 100 };
const SITUACOES = ['PENDING', 'RECEIVED', 'CONFIRMED', 'OVERDUE', 'REFUNDED', 'RECEIVED_IN_CASH', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL', 'DUNNING_REQUESTED', 'DUNNING_RECEIVED', 'AWAITING_RISK_ANALYSIS'];
const dia = (descricao: string): Param => ({ tipo: 'texto', descricao: `${descricao}, no formato AAAA-MM-DD` });

export const ASAAS: ConectorDef = {
  kind: 'asaas', nome: 'Asaas', site: 'asaas.com', grupo: 'financeiro',
  sobre: 'Sua conta no Asaas: os agentes consultam cobranças, clientes e saldo. Só leitura: por esta conexão nenhum agente cobra, paga, transfere, cancela ou altera valores.',
  campos: [{ name: 'access_token', label: 'Chave de API', secret: true, placeholder: 'Cole a chave, que começa com $aact_' }],
  ajuda: {
    url: 'https://www.asaas.com/login/auth',
    passos: 'Entre no site do Asaas com um usuário administrador (o aplicativo de celular não gera chave). No menu do seu usuário, abra Integrações, vá até a aba Chaves API e clique em "Gerar chave de API". Dê um nome, como Ergon, e, se quiser, uma data para expirar. Confirme com o código do aplicativo ou do SMS e copie a chave: ela aparece uma só vez. Se o botão estiver apagado, complete seu cadastro em Minha conta › Informações › Dados comerciais. Atenção: o Asaas não tem chave só de leitura. Esta chave dá controle total da conta, então cole aqui e não a guarde em outro lugar. Se ela ficar 3 meses sem uso, o Asaas a desliga.',
  },
  // chave de testes vai ao ambiente de testes do próprio Asaas: dá para experimentar sem dinheiro de verdade
  base: (c) => (c.access_token?.startsWith('$aact_hmlg_') ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3'),
  // o Asaas não usa "Authorization: Bearer", e exige User-Agent de quem abriu a conta a partir de 13/06/2024
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ access_token: c.access_token, 'User-Agent': 'Ergon/1.0.0' }) },
  // o Asaas responde erro com status 400, 401 ou 403; se um dia vier 200 com "errors", também não pode parecer sucesso
  erroNoCorpo: (j) => {
    const e = Array.isArray(j?.errors) ? j.errors[0] : null;
    return e ? { mensagem: String(e.description ?? e.code ?? 'erro'), permissao: /access_token|environment/i.test(String(e.code)) } : null;
  },
  quemSou: { caminho: '/myAccount/commercialInfo/', nome: (j) => String(j.tradingName || j.companyName || j.name || 'conta Asaas') },
  acoes: [
    { id: 'asaas.cobrancas', descricao: 'lista as cobranças, com filtros por cliente, situação, forma e datas', risco: 'ler',
      params: {
        cliente: { tipo: 'texto', descricao: 'id do cliente (cus_...)' },
        situacao: { tipo: 'texto', descricao: 'situação da cobrança', opcoes: SITUACOES },
        forma: { tipo: 'texto', descricao: 'forma de pagamento', opcoes: ['UNDEFINED', 'BOLETO', 'CREDIT_CARD', 'PIX'] },
        vencimento_de: dia('vencimento a partir de'), vencimento_ate: dia('vencimento até'),
        pagamento_de: dia('recebimento a partir de'), pagamento_ate: dia('recebimento até'),
        criada_de: dia('criada a partir de'), criada_ate: dia('criada até'),
        referencia: { tipo: 'texto', descricao: 'identificador da cobrança no seu sistema' },
        limite: LIMITE,
      },
      resumo: (a) => comFiltros('Ler as cobranças do Asaas', a, { cliente: 'cliente', situacao: 'situação', forma: 'forma', vencimento_de: 'vencimento a partir de', vencimento_ate: 'vencimento até', pagamento_de: 'recebimento a partir de', pagamento_ate: 'recebimento até', criada_de: 'criada a partir de', criada_ate: 'criada até', referencia: 'referência' }),
      metodo: 'GET', caminho: '/payments',
      consulta: { limit: '{limite}', customer: '{cliente}', status: '{situacao}', billingType: '{forma}', 'dueDate[ge]': '{vencimento_de}', 'dueDate[le]': '{vencimento_ate}', 'paymentDate[ge]': '{pagamento_de}', 'paymentDate[le]': '{pagamento_ate}', 'dateCreated[ge]': '{criada_de}', 'dateCreated[le]': '{criada_ate}', externalReference: '{referencia}' },
      lista: 'data', linha: (x) => ficha(x, COBRANCA, ', '), proximo: proximaPagina, paramCursor: 'offset' },
    { id: 'asaas.cobranca', descricao: 'mostra uma cobrança pelo id', rotulo: 'mostra uma cobrança', risco: 'ler',
      params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id da cobrança (pay_...)' } },
      resumo: 'Ler a cobrança {id} do Asaas', metodo: 'GET', caminho: '/payments/{id}', texto: (j) => ficha(j, COBRANCA_INTEIRA) || 'nada encontrado' },
    { id: 'asaas.clientes', descricao: 'lista os clientes, com filtros por nome, e-mail, CPF ou CNPJ e grupo', risco: 'ler',
      params: {
        nome: { tipo: 'texto', descricao: 'nome do cliente' }, email: { tipo: 'texto', descricao: 'e-mail do cliente' },
        cpf_cnpj: { tipo: 'texto', descricao: 'CPF ou CNPJ do cliente' }, grupo: { tipo: 'texto', descricao: 'nome do grupo' },
        referencia: { tipo: 'texto', descricao: 'identificador do cliente no seu sistema' }, limite: LIMITE,
      },
      resumo: (a) => comFiltros('Ler os clientes do Asaas', a, { nome: 'nome', email: 'e-mail', cpf_cnpj: 'CPF ou CNPJ', grupo: 'grupo', referencia: 'referência' }),
      metodo: 'GET', caminho: '/customers', consulta: { limit: '{limite}', name: '{nome}', email: '{email}', cpfCnpj: '{cpf_cnpj}', groupName: '{grupo}', externalReference: '{referencia}' },
      lista: 'data', linha: (x) => ficha(x, CLIENTE, ', '), proximo: proximaPagina, paramCursor: 'offset' },
    { id: 'asaas.cliente', descricao: 'mostra um cliente pelo id', rotulo: 'mostra um cliente', risco: 'ler',
      params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do cliente (cus_...)' } },
      resumo: 'Ler o cliente {id} do Asaas', metodo: 'GET', caminho: '/customers/{id}', texto: (j) => ficha(j, CLIENTE_INTEIRO) || 'nada encontrado' },
    { id: 'asaas.saldo', descricao: 'mostra o saldo da conta', risco: 'ler', params: {}, resumo: 'Ler o saldo da conta no Asaas', metodo: 'GET', caminho: '/finance/balance', texto: 'Saldo da conta: R$ {balance}' },
  ],
};

/**
 * Asaas: cobranças, clientes e saldo, e a escrita que uma pequena empresa usa no dia a dia: cadastrar cliente, criar cobrança e
 * criar link de pagamento. NADA AQUI MOVE DINHEIRO: nenhuma ação paga, transfere, estorna, antecipa, cancela, apaga ou dá baixa
 * (test/conexoes-financeiro.test.ts confere a lista e os endereços). A chave do Asaas não tem permissões por tipo ("carrega
 * todos os privilégios de acesso e controle" da conta), então o limite é este arquivo: não acrescente ação que mova dinheiro.
 * Criar cobrança é envio (o Asaas avisa o cliente pelos canais ligados nas notificações da conta) e sempre pede a confirmação
 * da pessoa, mesmo quando ela pediu na conversa (sempreConfirma, decisão de 09/11: o cliente é avisado na hora); cadastrar cliente e criar
 * link só organizam (o link só chega a alguém se a pessoa o compartilhar). Quem quer só consulta usa "Só leitura" em Conexões.
 *
 * Referências oficiais, conferidas em 05/11/2026:
 *   https://docs.asaas.com/docs/autentica%C3%A7%C3%A3o-1 (cabeçalho access_token, User-Agent, endereços, códigos de erro)
 *   https://docs.asaas.com/docs/chaves-de-api (só pela web, só administrador, exibida uma vez, inatividade de 3 e 6 meses)
 *   https://docs.asaas.com/changelog/novidade-novo-prefixo-de-identifica%C3%A7%C3%A3o-das-chaves-api ($aact_prod_, $aact_hmlg_; as antigas seguem valendo)
 *   https://central.ajuda.asaas.com/hc/pt-br/articles/33618186066331-Como-gerar-uma-chave-de-API (nomes de menu e botão)
 *   https://www.asaas.com/desenvolvedores (a chave dá acesso total à conta)
 *   https://docs.asaas.com/reference/listar-cobrancas, .../recuperar-uma-unica-cobranca, .../listar-clientes,
 *   .../recuperar-um-unico-cliente, .../recuperar-saldo-da-conta, .../recuperar-dados-comerciais, .../rate-e-quota-limit
 * Escrita, conferida em 08/11/2026:
 *   https://docs.asaas.com/reference/criar-novo-cliente (POST /v3/customers: name e cpfCnpj obrigatórios)
 *   https://docs.asaas.com/reference/criar-nova-cobranca (POST /v3/payments: customer, billingType, value e dueDate obrigatórios)
 *   https://docs.asaas.com/reference/criar-um-link-de-pagamentos (POST /v3/paymentLinks: name, billingType e chargeType; volta id e url)
 *   https://docs.asaas.com/docs/notificacoes (as notificações de cobrança, inclusive a da criação, seguem a configuração da conta)
 * Campos que movem dinheiro para outra conta (split) ou mudam regras da conta (callback, juros e multa próprios) não são enviados.
 * Repetição sem cópia: a resposta de uma criação pode se perder (o Asaas criou e não confirmou a tempo) e a equipe tenta de novo.
 * Por isso a cobrança sempre leva uma referência (externalReference; sem a da pessoa, uma tirada dos dados) e, antes de criar,
 * GET /payments?customer=...&externalReference=... (filtros de listar-cobrancas) acha a que já existe; o cliente, por
 * GET /customers?cpfCnpj=... (listar-clientes). O link de pagamento não tem essa conferência: repetido, sobra um link a mais,
 * que não chega a ninguém sem ser compartilhado.
 *
 * CPF e CNPJ dos clientes servem de filtro, mas não saem nas respostas: o agente não precisa deles para responder.
 */
import crypto from 'node:crypto';
import { neutral } from '../../operations.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';
import { ErroAcao, dia as diaDe, seg, type Acao, type Args, type CtxAcao, type Param, type Resultado } from '../tipos.ts';

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

// ---------------------------------------------------------------------------------------------------------- escrita
const vazio = (v: unknown) => v === undefined || v === null || v === '';
const FORMAS = ['UNDEFINED', 'BOLETO', 'PIX', 'CREDIT_CARD'];
const NOME_FORMA: Record<string, string> = { UNDEFINED: 'o cliente escolhe', BOLETO: 'boleto', PIX: 'Pix', CREDIT_CARD: 'cartão de crédito' };
/** R$ com vírgula, como a pessoa lê no cartão de confirmação. */
const reais = (v: unknown) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
/** Valor positivo e com centavos: o que o cartão mostra é o que vai. */
const valorOk = (v: unknown, nome = 'valor'): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ErroAcao(`"${nome}" precisa ser um valor maior que zero, em reais (ex.: 129.90)`);
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new ErroAcao(`"${nome}" tem mais de dois decimais: use reais e centavos (ex.: 129.90)`);
  return Math.round(n * 100) / 100;
};
/** CPF (11) ou CNPJ (14), só os números. */
const documento = (v: unknown): string => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 11 && d.length !== 14) throw new ErroAcao('"cpf_cnpj" precisa ter 11 números (CPF) ou 14 (CNPJ)');
  return d;
};
/** O que a pessoa lê no cartão: cada campo preenchido, por extenso e sem cortar. */
const detalhes = (a: Args, rotulos: Record<string, string | [string, (v: unknown) => string]>): string =>
  Object.entries(rotulos).flatMap(([k, r]) => (vazio(a[k]) ? [] : [Array.isArray(r) ? `${r[0]}: ${r[1](a[k])}` : `${r}: ${String(a[k])}`])).join('\n');
/** O cartão mostra o nome do cliente: o agente só tem o id. Só lê; cliente que não existe para aqui, antes do cartão. */
const CARTAO_CLIENTE: Acao['preparar'] = async (ctx: CtxAcao, a: Args) => {
  const j = await ctx.http(`/customers/${seg(a.cliente)}`, { method: 'GET', kind: 'read' });
  if (j?.deleted === true) throw new ErroAcao('este cliente foi removido no Asaas: escolha outro');
  return { detalhe: `Cliente: ${neutral(String(j?.name || a.cliente), 200)}` };
};
/**
 * A referência da cobrança quando a pessoa não deu uma: sai dos dados da cobrança, então o mesmo pedido repetido (a resposta
 * do Asaas se perdeu e a equipe tentou de novo) leva a mesma referência, e COBRANCA_JA_FEITA acha a primeira em vez de criar
 * outra. Não entra o dia: repetir depois da meia-noite também acha. Cobrança igual de propósito pede outra referência.
 */
const referenciaDe = (a: Args): string => `ergon-${crypto.createHash('sha256').update(JSON.stringify([a.cliente, a.valor, a.vencimento, a.forma, a.descricao ?? ''])).digest('hex').slice(0, 32)}`;
const textoCobranca = (j: any) => `Cobrança criada no Asaas (id: ${linhaDe('{id}', j)}${j?.status ? `, situação: ${linhaDe('{status}', j)}` : ''})${j?.invoiceUrl ? `. Fatura: ${linhaDe('{invoiceUrl}', j)}` : ''}.`;
const faturaDe = (j: any) => (typeof j?.invoiceUrl === 'string' && j.invoiceUrl.startsWith('https://') ? j.invoiceUrl : null);
/** A cobrança com esta referência, para este cliente, já existe: devolve ela, sem criar a segunda (o Asaas avisaria o cliente duas vezes). */
const COBRANCA_JA_FEITA = async (ctx: CtxAcao, a: Args): Promise<Resultado | null> => {
  const j = await ctx.http(`/payments?${new URLSearchParams({ customer: String(a.cliente), externalReference: String(a.referencia), limit: '1' })}`, { method: 'GET', kind: 'read' });
  const x = Array.isArray(j?.data) ? j.data.find((c: any) => c && c.deleted !== true) : null;
  if (!x) return null;
  return { texto: `Esta cobrança já existia no Asaas, com os mesmos dados (id: ${linhaDe('{id}', x)}${x.status ? `, situação: ${linhaDe('{status}', x)}` : ''}): não criei outra. Para criar outra igual de propósito, informe uma "referencia" diferente.`, url: faturaDe(x) };
};
/** O cliente com este CPF ou CNPJ já está cadastrado: devolve ele, sem cadastrar o segundo. */
const CLIENTE_JA_FEITO = async (ctx: CtxAcao, a: Args): Promise<Resultado | null> => {
  const j = await ctx.http(`/customers?${new URLSearchParams({ cpfCnpj: String(a.cpf_cnpj), limit: '1' })}`, { method: 'GET', kind: 'read' });
  const x = Array.isArray(j?.data) ? j.data.find((c: any) => c && c.deleted !== true) : null;
  return x ? { texto: `Este cliente já estava cadastrado no Asaas com este CPF ou CNPJ (id: ${linhaDe('{id}', x)}): não cadastrei outro.` } : null;
};
const R_COBRANCA = { cliente: 'cliente (id)', valor: ['valor', reais] as [string, (v: unknown) => string], vencimento: 'vencimento', forma: ['forma', (v: unknown) => NOME_FORMA[String(v)] ?? String(v)] as [string, (v: unknown) => string], descricao: 'descrição', referencia: 'referência' };
const R_LINK = { nome: 'nome', valor: ['valor', reais] as [string, (v: unknown) => string], forma: ['forma', (v: unknown) => NOME_FORMA[String(v)] ?? String(v)] as [string, (v: unknown) => string], tipo: 'tipo', parcelas_max: 'até quantas parcelas', dias_boleto: 'dias para pagar o boleto', fim: 'vale até', descricao: 'descrição' };
const R_CLIENTE = { nome: 'nome', cpf_cnpj: 'CPF ou CNPJ', email: 'e-mail', celular: 'celular', telefone: 'telefone', cep: 'CEP', numero: 'número do endereço', referencia: 'referência', observacoes: 'observações' };

export const ASAAS: ConectorDef = {
  kind: 'asaas', nome: 'Asaas', site: 'asaas.com', grupo: 'financeiro',
  sobre: 'Sua conta no Asaas: os agentes consultam cobranças, clientes e saldo, e cadastram clientes, criam cobranças e links de pagamento. Nenhum agente paga, transfere, estorna ou cancela por esta conexão. Para só consultar, use "Só leitura".',
  campos: [{ name: 'access_token', label: 'Chave de API', secret: true, placeholder: 'Cole a chave, que começa com $aact_' }],
  ajuda: {
    url: 'https://www.asaas.com/login/auth',
    passos: 'Entre no site do Asaas com um usuário administrador (o aplicativo de celular não gera chave). No menu do seu usuário, abra Integrações, vá até a aba Chaves API e clique em "Gerar chave de API". Dê um nome, como Ergon, e, se quiser, uma data para expirar. Confirme com o código do aplicativo ou do SMS e copie a chave: ela aparece uma só vez. Se o botão estiver apagado, complete seu cadastro em Minha conta › Informações › Dados comerciais. Atenção: o Asaas não tem chave só de leitura. Esta chave dá controle total da conta, então cole aqui e não a guarde em outro lugar. Se ela ficar 3 meses sem uso, o Asaas a desliga. Para experimentar sem dinheiro de verdade, use uma chave do ambiente de testes do Asaas (Sandbox).',
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

    { id: 'asaas.criar_cliente', descricao: 'cadastra um cliente no Asaas (nome e CPF ou CNPJ são obrigatórios). Não manda nada a ele. Antes, veja em asaas.clientes se ele já existe', rotulo: 'cadastra um cliente', risco: 'organizar',
      params: {
        nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome do cliente', max: 200 }, cpf_cnpj: { tipo: 'texto', obrigatorio: true, descricao: 'CPF ou CNPJ do cliente' },
        email: { tipo: 'texto', descricao: 'e-mail' }, celular: { tipo: 'texto', descricao: 'celular, com DDD' }, telefone: { tipo: 'texto', descricao: 'telefone fixo, com DDD' },
        cep: { tipo: 'texto', descricao: 'CEP' }, numero: { tipo: 'texto', descricao: 'número do endereço' },
        referencia: { tipo: 'texto', descricao: 'identificador do cliente no seu sistema' }, observacoes: { tipo: 'texto', descricao: 'observações', max: 1000 },
      },
      resumo: (a) => `Cadastrar um cliente no Asaas:\n${detalhes(a, R_CLIENTE)}`,
      metodo: 'POST', caminho: '/customers',
      antes: async (_c, a) => ({ ...a, cpf_cnpj: documento(a.cpf_cnpj) }),
      jaFeito: CLIENTE_JA_FEITO,
      corpo: { name: '{nome}', cpfCnpj: '{cpf_cnpj}', email: '{email}', mobilePhone: '{celular}', phone: '{telefone}', postalCode: '{cep}', addressNumber: '{numero}', externalReference: '{referencia}', observations: '{observacoes}' },
      texto: (j) => `Cliente cadastrado no Asaas (id: ${linhaDe('{id}', j)}).` },
    { id: 'asaas.criar_cobranca', descricao: 'cria uma cobrança para um cliente já cadastrado (veja o id em asaas.clientes). O Asaas avisa o cliente conforme as notificações da conta. Não recebe, não estorna e não cancela nada', rotulo: 'cria uma cobrança (o Asaas avisa o cliente na hora; sempre pede a sua confirmação)', risco: 'enviar',
      sempreConfirma: 'o Asaas avisa o cliente na hora: criar cobrança sempre pede a sua confirmação',
      params: {
        cliente: { tipo: 'texto', obrigatorio: true, descricao: 'id do cliente (cus_...)' }, valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor em reais, como 129.90' },
        vencimento: { tipo: 'texto', obrigatorio: true, descricao: 'vencimento, no formato AAAA-MM-DD' },
        forma: { tipo: 'texto', descricao: 'forma de pagamento; UNDEFINED deixa o cliente escolher (padrão)', opcoes: FORMAS, padrao: 'UNDEFINED' },
        descricao: { tipo: 'texto', descricao: 'descrição que o cliente vê, até 500 letras', max: 500 }, referencia: { tipo: 'texto', descricao: 'identificador da cobrança no seu sistema' },
      },
      resumo: (a) => `Criar uma cobrança no Asaas (o Asaas avisa o cliente conforme as notificações da sua conta):\n${detalhes(a, R_COBRANCA)}`,
      preparar: CARTAO_CLIENTE,
      metodo: 'POST', caminho: '/payments',
      antes: async (_c, a) => {
        const b = { ...a, valor: valorOk(a.valor), vencimento: diaDe(a, 'vencimento') };
        return { ...b, referencia: vazio(a.referencia) ? referenciaDe(b) : a.referencia };
      },
      jaFeito: COBRANCA_JA_FEITA,
      corpo: { customer: '{cliente}', billingType: '{forma}', value: '{valor}', dueDate: '{vencimento}', description: '{descricao}', externalReference: '{referencia}' },
      texto: textoCobranca, url: faturaDe },
    { id: 'asaas.criar_link', descricao: 'cria um link de pagamento para compartilhar (avulso ou parcelado). Ninguém recebe nada até a pessoa compartilhar o link. Sem valor, quem paga escolhe o valor', rotulo: 'cria um link de pagamento', risco: 'organizar',
      params: {
        nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome do link, que quem paga vê', max: 200 },
        valor: { tipo: 'numero', descricao: 'valor em reais, como 129.90; sem ele, quem paga escolhe' },
        forma: { tipo: 'texto', descricao: 'forma de pagamento; UNDEFINED deixa escolher (padrão)', opcoes: FORMAS, padrao: 'UNDEFINED' },
        tipo: { tipo: 'texto', descricao: 'avulso (padrão) ou parcelado (só cartão)', opcoes: ['avulso', 'parcelado'], padrao: 'avulso' },
        parcelas_max: { tipo: 'numero', descricao: 'parcelado: até quantas parcelas (1 a 21)', max: 21 },
        dias_boleto: { tipo: 'numero', descricao: 'dias úteis para pagar o boleto depois de gerado (padrão 10)', padrao: 10, max: 365 },
        fim: { tipo: 'texto', descricao: 'o link vale até este dia, no formato AAAA-MM-DD' }, descricao: { tipo: 'texto', descricao: 'descrição', max: 500 },
      },
      resumo: (a) => `Criar um link de pagamento no Asaas (só chega a alguém se você compartilhar):\n${detalhes(a, R_LINK)}`,
      metodo: 'POST', caminho: '/paymentLinks',
      antes: async (_c, a) => {
        if (a.tipo === 'parcelado' && vazio(a.parcelas_max)) throw new ErroAcao('link parcelado: diga até quantas parcelas em "parcelas_max"');
        if (a.tipo === 'parcelado' && a.forma !== 'CREDIT_CARD') throw new ErroAcao('link parcelado só existe no cartão de crédito: use forma CREDIT_CARD');
        return { ...a, ...(vazio(a.valor) ? {} : { valor: valorOk(a.valor) }), ...(vazio(a.fim) ? {} : { fim: diaDe(a, 'fim') }), tipoAsaas: a.tipo === 'parcelado' ? 'INSTALLMENT' : 'DETACHED' };
      },
      corpo: { name: '{nome}', description: '{descricao}', billingType: '{forma}', chargeType: '{tipoAsaas}', value: '{valor}', dueDateLimitDays: '{dias_boleto}', endDate: '{fim}', maxInstallmentCount: '{parcelas_max}' },
      texto: (j) => `Link de pagamento criado no Asaas: ${linhaDe('{url}', j)} (id: ${linhaDe('{id}', j)}).`,
      url: (j) => (typeof j?.url === 'string' && j.url.startsWith('https://') ? j.url : null) },
  ],
};

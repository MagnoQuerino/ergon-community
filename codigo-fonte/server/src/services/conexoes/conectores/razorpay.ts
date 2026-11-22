/**
 * Razorpay (rc.48), com a chave da conta (Key Id e Key Secret, em Account & Settings › API Keys): pagamentos, pedidos, links de
 * pagamento, reembolsos e liquidações (settlements). O UPI vem pelos próprios pagamentos (method "upi", o VPA de quem pagou) e
 * pelos links (upi_link). Escrito de memória da documentação oficial (razorpay.com/docs/api; a rede desta máquina não a alcança):
 * Basic com key_id:key_secret, valores em paise, listas em { entity: 'collection', count, items } com count e skip (até 100),
 * erro em { error: { code, description } }. Conferir na primeira conta de verdade.
 *
 * O que pode:
 * - ler: livre (pagamentos, pedidos, links, reembolsos, liquidações).
 * - criar link de pagamento: sempre pede a confirmação da pessoa (sempreConfirma); com aviso ao cliente (SMS ou e-mail do
 *   Razorpay) é envio.
 * - reembolsar e capturar um pagamento autorizado (cobrar de fato): movem dinheiro, são sempre-protegidas (Acao.protegida),
 *   pedem o cartão toda vez, mesmo com "Liberar tudo" e com regra aprovada. Nenhuma outra ação mexe em dinheiro
 *   (test/conexoes-india.test.ts confere a lista e os endereços).
 */
import { ErroAcao, emails, type Args, type Param } from '../tipos.ts';
import { detalhes, ficha, linhaDe, vazio, type ConectorDef } from './declarativo.ts';

/** Valor em paise → rupias com o agrupamento indiano (₹12,34,567.50); outra moeda sai com o código dela. */
export const emRupias = (paise: unknown, moeda: unknown = 'INR'): string => {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '';
  const v = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n / 100);
  return String(moeda || 'INR').toUpperCase() === 'INR' ? `₹${v}` : `${v} ${String(moeda).toUpperCase()}`;
};
/** Rupias → paise, conferido (o Razorpay só aceita inteiro em paise; o mínimo é ₹1). */
const paraPaise = (nome: string, v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new ErroAcao(`"${nome}" precisa ser um valor em rupias, de pelo menos 1`);
  if (Math.round(n * 100) !== Math.round(n * 1000) / 10) throw new ErroAcao(`"${nome}" tem no máximo 2 casas decimais`);
  return Math.round(n * 100);
};
const quando = (s: unknown) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '');
const desde = (d: unknown, fim = false): number | undefined => {
  if (vazio(d)) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new ErroAcao('a data precisa estar no formato AAAA-MM-DD');
  return Math.floor(Date.parse(`${String(d)}T${fim ? '23:59:59' : '00:00:00'}+05:30`) / 1000);
};

const LIMITE: Param = { tipo: 'numero', descricao: 'quantos (padrão 25, até 100)', padrao: 25, max: 100 };
const DE: Param = { tipo: 'texto', descricao: 'a partir de (AAAA-MM-DD, horário da Índia)' };
const ATE: Param = { tipo: 'texto', descricao: 'até (AAAA-MM-DD, horário da Índia)' };
const ID = (o: string): Param => ({ tipo: 'texto', obrigatorio: true, descricao: `id ${o}` });
const periodo = async (_c: unknown, a: Args): Promise<Args> => ({ ...a, _de: desde(a.de), _ate: desde(a.ate, true) });
const PAGINA = { count: '{limite}', from: '{_de}', to: '{_ate}' };
/** A próxima página é o skip seguinte, quando a página veio cheia. */
const proximo = (j: any, a: Args) => (Array.isArray(j?.items) && j.items.length >= Number(a.limite) ? String(Number(a.cursor ?? 0) + Number(a.limite)) : null);
const PAINEL = 'https://dashboard.razorpay.com/app';

const linhaPagamento = (x: any) => `${ficha({ ...x, _valor: emRupias(x.amount, x.currency), _reemb: Number(x.amount_refunded) > 0 ? emRupias(x.amount_refunded, x.currency) : '', _quando: quando(x.created_at) },
  [['Pagamento', 'id'], ['Valor', '_valor'], ['Situação', 'status'], ['Forma', 'method'], ['UPI', 'vpa'], ['Banco', 'bank'], ['Carteira', 'wallet'], ['Pedido', 'order_id'], ['Descrição', 'description'], ['E-mail', 'email'], ['Telefone', 'contact'], ['Reembolsado', '_reemb'], ['Quando', '_quando']])}, link: ${PAINEL}/payments/${encodeURIComponent(String(x.id ?? ''))}`;
const linhaPedido = (x: any) => ficha({ ...x, _valor: emRupias(x.amount, x.currency), _pago: emRupias(x.amount_paid, x.currency), _quando: quando(x.created_at) },
  [['Pedido', 'id'], ['Valor', '_valor'], ['Pago', '_pago'], ['Situação', 'status'], ['Recibo', 'receipt'], ['Tentativas', 'attempts'], ['Quando', '_quando']]);
const linhaLink = (x: any) => ficha({ ...x, _valor: emRupias(x.amount, x.currency), _pago: emRupias(x.amount_paid, x.currency), _cliente: [x.customer?.name, x.customer?.email, x.customer?.contact].filter(Boolean).join(' '), _upi: x.upi_link ? 'sim' : '', _vence: quando(x.expire_by), _quando: quando(x.created_at) },
  [['Link', 'id'], ['Endereço', 'short_url'], ['Valor', '_valor'], ['Pago', '_pago'], ['Situação', 'status'], ['Descrição', 'description'], ['Cliente', '_cliente'], ['Só UPI', '_upi'], ['Referência', 'reference_id'], ['Vence', '_vence'], ['Criado', '_quando']]);
const linhaReembolso = (x: any) => ficha({ ...x, _valor: emRupias(x.amount, x.currency), _quando: quando(x.created_at) }, [['Reembolso', 'id'], ['Pagamento', 'payment_id'], ['Valor', '_valor'], ['Situação', 'status'], ['Velocidade', 'speed_processed'], ['Quando', '_quando']]);
const linhaLiquidacao = (x: any) => ficha({ ...x, _valor: emRupias(x.amount), _taxas: emRupias(x.fees), _imposto: emRupias(x.tax), _quando: quando(x.created_at) }, [['Liquidação', 'id'], ['Valor', '_valor'], ['Situação', 'status'], ['Taxas', '_taxas'], ['Imposto (GST)', '_imposto'], ['UTR', 'utr'], ['Quando', '_quando']]);

const P_REEMBOLSO = {
  pagamento: ID('do pagamento (pay_...)'),
  valor: { tipo: 'numero', descricao: 'valor em rupias; sem ele, o pagamento inteiro' } as Param,
  velocidade: { tipo: 'texto', descricao: 'normal (padrão) ou optimum (instantâneo, com taxa)', opcoes: ['normal', 'optimum'], padrao: 'normal' } as Param,
  motivo: { tipo: 'texto', descricao: 'motivo, guardado nas notas do reembolso', max: 250 } as Param,
};
const avisa = (a: Args) => a.avisar_sms === true || a.avisar_email === true || a.avisar_sms === 'true' || a.avisar_email === 'true' || a.avisar_sms === 'sim' || a.avisar_email === 'sim';

export const RAZORPAY: ConectorDef = {
  kind: 'razorpay', nome: 'Razorpay', site: 'razorpay.com', grupo: 'financeiro',
  sobre: 'Sua conta no Razorpay: os agentes consultam pagamentos (inclusive UPI), pedidos, links de pagamento, reembolsos e liquidações. Criar link de pagamento sempre pede a sua confirmação; reembolsar ou capturar um pagamento pede a sua aprovação toda vez, mesmo com "Liberar tudo".',
  campos: [
    { name: 'key_id', label: 'Key Id', placeholder: 'rzp_live_... ou rzp_test_...', pattern: /^rzp_(live|test)_[A-Za-z0-9]{6,40}$/, patternHelp: 'o Key Id começa com rzp_live_ ou rzp_test_' },
    { name: 'key_secret', label: 'Key Secret', secret: true, placeholder: 'Cole o Key Secret aqui' },
  ],
  ajuda: {
    url: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys',
    passos: 'Entre no painel do Razorpay (Dashboard) com um usuário Owner ou Admin. Escolha o modo no alto da tela: Test Mode para experimentar sem dinheiro de verdade, ou Live Mode. Abra Account & Settings › API Keys e clique em "Generate Key" (ou "Regenerate", se já houver uma: a antiga para de funcionar). Copie o Key Id e o Key Secret e cole aqui: o Key Secret aparece uma só vez. A chave dá acesso total à conta, por isso o Ergon guarda ela só neste computador, cifrada, e os agentes nunca a veem.',
  },
  base: 'https://api.razorpay.com/v1',
  auth: { tipo: 'basic', usuario: (c) => c.key_id, senha: (c) => c.key_secret },
  erroNoCorpo: (j) => (j?.error && typeof j.error === 'object' && (j.error.code || j.error.description) ? { mensagem: `${String(j.error.code ?? '')}: ${String(j.error.description ?? '')}`, permissao: /authentication|unauthori/i.test(String(j.error.description ?? '')) } : null),
  quemSou: { caminho: '/payments?count=1', nome: (_j) => 'Razorpay', id: () => undefined },
  acoes: [
    // ------------------------------------------------------------------------------------------- leitura (livre)
    { id: 'razorpay.pagamentos', descricao: 'lista pagamentos recebidos (cartão, UPI, netbanking, carteira), mais novos primeiro, com o link do painel', rotulo: 'lista pagamentos', risco: 'ler',
      params: { de: DE, ate: ATE, limite: LIMITE }, resumo: 'Ler os pagamentos do Razorpay', metodo: 'GET', caminho: '/payments', consulta: PAGINA, antes: periodo,
      lista: 'items', linha: linhaPagamento, proximo, paramCursor: 'skip' },
    { id: 'razorpay.pagamento', descricao: 'mostra um pagamento pelo id (pay_...), com a forma, o VPA do UPI e o que já foi reembolsado', rotulo: 'mostra um pagamento', risco: 'ler',
      params: { id: ID('do pagamento (pay_...)') }, resumo: 'Ler o pagamento {id} do Razorpay', metodo: 'GET', caminho: '/payments/{id}', texto: (j) => linhaPagamento(j),
      url: (j) => (typeof j?.id === 'string' ? `${PAINEL}/payments/${encodeURIComponent(j.id)}` : null) },
    { id: 'razorpay.pedidos', descricao: 'lista pedidos (orders)', rotulo: 'lista pedidos', risco: 'ler',
      params: { de: DE, ate: ATE, limite: LIMITE }, resumo: 'Ler os pedidos do Razorpay', metodo: 'GET', caminho: '/orders', consulta: PAGINA, antes: periodo,
      lista: 'items', linha: linhaPedido, proximo, paramCursor: 'skip' },
    { id: 'razorpay.pedido', descricao: 'mostra um pedido (order_...) e os pagamentos dele', rotulo: 'mostra um pedido', risco: 'ler',
      params: { id: ID('do pedido (order_...)') }, resumo: 'Ler o pedido {id} do Razorpay', metodo: 'GET', caminho: '/orders/{id}/payments',
      texto: (j, a) => { const l: any[] = Array.isArray(j?.items) ? j.items : []; return `Pedido ${String(a.id)}: ${l.length ? `\n${l.map((x) => `- ${linhaPagamento(x)}`).join('\n')}` : 'nenhum pagamento ainda'}`; } },
    { id: 'razorpay.links', descricao: 'lista os links de pagamento (com a situação: criado, pago, parcialmente pago, vencido, cancelado)', rotulo: 'lista links de pagamento', risco: 'ler',
      params: { referencia: { tipo: 'texto', descricao: 'a referência do link' }, limite: LIMITE }, resumo: 'Ler os links de pagamento do Razorpay', metodo: 'GET', caminho: '/payment_links',
      consulta: { count: '{limite}', reference_id: '{referencia}' }, lista: 'payment_links', linha: linhaLink,
      proximo: (j, a) => (Array.isArray(j?.payment_links) && j.payment_links.length >= Number(a.limite) ? String(Number(a.cursor ?? 0) + Number(a.limite)) : null), paramCursor: 'skip' },
    { id: 'razorpay.link', descricao: 'mostra um link de pagamento (plink_...)', rotulo: 'mostra um link de pagamento', risco: 'ler',
      params: { id: ID('do link (plink_...)') }, resumo: 'Ler o link de pagamento {id} do Razorpay', metodo: 'GET', caminho: '/payment_links/{id}', texto: (j) => linhaLink(j),
      url: (j) => (typeof j?.short_url === 'string' && j.short_url.startsWith('https://') ? j.short_url : null) },
    { id: 'razorpay.reembolsos', descricao: 'lista os reembolsos feitos', rotulo: 'lista reembolsos', risco: 'ler',
      params: { de: DE, ate: ATE, limite: LIMITE }, resumo: 'Ler os reembolsos do Razorpay', metodo: 'GET', caminho: '/refunds', consulta: PAGINA, antes: periodo,
      lista: 'items', linha: linhaReembolso, proximo, paramCursor: 'skip' },
    { id: 'razorpay.liquidacoes', descricao: 'lista as liquidações (settlements): o que o Razorpay depositou na conta do banco, com taxas, GST e UTR', rotulo: 'lista liquidações (settlements)', risco: 'ler',
      params: { de: DE, ate: ATE, limite: LIMITE }, resumo: 'Ler as liquidações do Razorpay', metodo: 'GET', caminho: '/settlements', consulta: PAGINA, antes: periodo,
      lista: 'items', linha: linhaLiquidacao, proximo, paramCursor: 'skip' },
    // -------------------------------------------------------------------------- link de pagamento (pede confirmação)
    { id: 'razorpay.criar_link', descricao: 'cria um link de pagamento (aceita UPI, cartão e outros; upi=true faz um link só de UPI). Sempre pede a confirmação da pessoa', rotulo: 'cria link de pagamento (sempre pede a sua confirmação)',
      risco: (a) => (avisa(a) ? 'enviar' : 'organizar'),
      sempreConfirma: 'é uma cobrança em nome da empresa: criar link de pagamento no Razorpay sempre pede a sua confirmação',
      params: {
        valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor em rupias (ex.: 1499.50)' },
        descricao: { tipo: 'texto', obrigatorio: true, descricao: 'o que está sendo cobrado (o cliente vê)', max: 2048 },
        cliente: { tipo: 'texto', descricao: 'nome do cliente', max: 200 }, email: { tipo: 'texto', descricao: 'e-mail do cliente' }, telefone: { tipo: 'texto', descricao: 'celular do cliente, com DDI (ex.: +919812345678)' },
        avisar_sms: { tipo: 'booleano', descricao: 'o Razorpay manda o link por SMS ao cliente (padrão não)', padrao: false },
        avisar_email: { tipo: 'booleano', descricao: 'o Razorpay manda o link por e-mail ao cliente (padrão não)', padrao: false },
        upi: { tipo: 'booleano', descricao: 'link só de UPI (só no modo real)', padrao: false },
        vence: { tipo: 'texto', descricao: 'vale até (AAAA-MM-DD)' }, referencia: { tipo: 'texto', descricao: 'referência sua (número do pedido), única', max: 40 },
        moeda: { tipo: 'texto', descricao: 'moeda (padrão INR)', padrao: 'INR', opcoes: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] },
      },
      resumo: (a) => {
        let valor = String(a.valor); try { valor = emRupias(paraPaise('valor', a.valor), a.moeda); } catch { /* o cartão mostra como veio; o erro sai no preparar */ }
        const quem = [a.cliente, a.email, a.telefone].filter((x) => !vazio(x)).map(String).join(', ');
        const aviso = avisa(a) ? `\nO Razorpay avisa o cliente por ${[a.avisar_sms === true || a.avisar_sms === 'true' || a.avisar_sms === 'sim' ? 'SMS' : '', a.avisar_email === true || a.avisar_email === 'true' || a.avisar_email === 'sim' ? 'e-mail' : ''].filter(Boolean).join(' e ')} na hora.` : '\nO Razorpay não avisa o cliente: o link volta para você mandar.';
        return `Criar um link de pagamento no Razorpay de ${valor}${a.upi === true || a.upi === 'true' ? ' (só UPI)' : ''}${quem ? ` para ${quem}` : ''}.\n${detalhes(a, { descricao: 'Descrição', vence: 'Vale até', referencia: 'Referência' })}${aviso}`;
      },
      preparar: async (_c, a) => {
        paraPaise('valor', a.valor);
        if (!vazio(a.email)) emails(a, 'email', 1);
        if (!vazio(a.telefone) && !/^\+?\d{8,15}$/.test(String(a.telefone).replace(/[\s-]/g, ''))) throw new ErroAcao('"telefone" precisa ser só números, com DDI');
        if ((a.avisar_email === true || a.avisar_email === 'true') && vazio(a.email)) throw new ErroAcao('para avisar por e-mail, diga o "email" do cliente');
        if ((a.avisar_sms === true || a.avisar_sms === 'true') && vazio(a.telefone)) throw new ErroAcao('para avisar por SMS, diga o "telefone" do cliente');
        desde(a.vence, true);
        return {};
      },
      metodo: 'POST', caminho: '/payment_links',
      corpo: (a: Args) => ({
        amount: paraPaise('valor', a.valor), currency: a.moeda, description: a.descricao, accept_partial: false,
        ...(a.upi ? { upi_link: true } : {}),
        ...([a.cliente, a.email, a.telefone].some((x) => !vazio(x)) ? { customer: { ...(a.cliente ? { name: a.cliente } : {}), ...(a.email ? { email: a.email } : {}), ...(a.telefone ? { contact: String(a.telefone).replace(/[\s-]/g, '') } : {}) } } : {}),
        notify: { sms: a.avisar_sms === true, email: a.avisar_email === true }, reminder_enable: false,
        ...(a.vence ? { expire_by: desde(a.vence, true) } : {}), ...(a.referencia ? { reference_id: a.referencia } : {}),
      }),
      texto: (j) => `Link de pagamento criado no Razorpay: ${linhaDe('{short_url}', j)} (id: ${linhaDe('{id}', j)}, ${emRupias(j?.amount, j?.currency)}).`,
      url: (j) => (typeof j?.short_url === 'string' && j.short_url.startsWith('https://') ? j.short_url : null) },
    // ------------------------------------------------------------------------- movem dinheiro (sempre-protegidas)
    { id: 'razorpay.reembolsar', descricao: 'devolve ao cliente um pagamento capturado, inteiro ou parte. Move dinheiro: pede a aprovação da pessoa sempre', rotulo: 'reembolsa um pagamento (sempre pede a sua aprovação)', risco: 'enviar',
      protegida: 'reembolso devolve dinheiro da empresa ao cliente e não tem volta: pede a sua aprovação sempre, mesmo com "Liberar tudo"',
      params: P_REEMBOLSO,
      resumo: (a) => `Reembolsar ${vazio(a.valor) ? 'o valor inteiro' : (() => { try { return emRupias(paraPaise('valor', a.valor)); } catch { return String(a.valor); } })()} do pagamento ${String(a.pagamento)} no Razorpay${a.velocidade === 'optimum' ? ', instantâneo (com taxa)' : ''}${a.motivo ? `. Motivo: ${String(a.motivo)}` : ''}`,
      preparar: async (ctx, a) => {
        if (!vazio(a.valor)) paraPaise('valor', a.valor);
        const p = await ctx.http(`/payments/${encodeURIComponent(String(a.pagamento ?? ''))}`, { method: 'GET', kind: 'read' });
        return { detalhe: `Pagamento: ${linhaPagamento(p)}` };
      },
      metodo: 'POST', caminho: '/payments/{pagamento}/refund',
      corpo: (a: Args) => ({ ...(vazio(a.valor) ? {} : { amount: paraPaise('valor', a.valor) }), speed: a.velocidade, ...(a.motivo ? { notes: { motivo: a.motivo } } : {}) }),
      texto: (j) => `Reembolso pedido ao Razorpay: ${linhaReembolso(j)}.` },
    { id: 'razorpay.capturar', descricao: 'captura um pagamento só autorizado (cobra do cliente de fato). Move dinheiro: pede a aprovação da pessoa sempre', rotulo: 'captura um pagamento autorizado (sempre pede a sua aprovação)', risco: 'enviar',
      protegida: 'capturar cobra o cliente de fato: pede a sua aprovação sempre, mesmo com "Liberar tudo"',
      params: { pagamento: ID('do pagamento (pay_...)'), valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor em rupias, igual ao autorizado' }, moeda: { tipo: 'texto', descricao: 'moeda (padrão INR)', padrao: 'INR' } },
      resumo: (a) => `Capturar ${(() => { try { return emRupias(paraPaise('valor', a.valor), a.moeda); } catch { return String(a.valor); } })()} do pagamento ${String(a.pagamento)} no Razorpay (o cliente é cobrado)`,
      preparar: async (ctx, a) => {
        paraPaise('valor', a.valor);
        const p = await ctx.http(`/payments/${encodeURIComponent(String(a.pagamento ?? ''))}`, { method: 'GET', kind: 'read' });
        return { detalhe: `Pagamento: ${linhaPagamento(p)}` };
      },
      metodo: 'POST', caminho: '/payments/{pagamento}/capture', corpo: (a: Args) => ({ amount: paraPaise('valor', a.valor), currency: a.moeda }),
      texto: (j) => `Pagamento capturado no Razorpay: ${linhaPagamento(j)}.` },
  ],
};

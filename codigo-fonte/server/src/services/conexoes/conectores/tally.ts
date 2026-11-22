/**
 * TallyPrime (rc.48), só no Community local. O Tally responde a pedidos XML por HTTP na porta que o dono liga nele (F1 Help ›
 * Settings › Connectivity › "TallyPrime acts as": Server, porta 9000 por padrão), na própria máquina ou na rede local. O dono
 * aponta host e porta; o Ergon conversa com o Tally pelo servidor dele, e por isso:
 * - só endereço da rede local: o nome é resolvido aqui e TODO endereço que ele der tem de ser privado (10/8, 172.16/12,
 *   192.168/16, 100.64/10, fc00::/7) ou desta máquina (127/8, ::1). IP público, de enlace (169.254, onde mora o metadado das
 *   nuvens) e endereço "0" são recusados; a chamada vai ao IP já conferido (o nome não é resolvido de novo no meio do caminho)
 *   e nunca segue redirecionamento. Nesta máquina, as portas abaixo de 1024 e as do próprio Ergon e do motor ficam de fora.
 * - na nuvem, indisponível (ConectorDef.soLocal), com o motivo no cartão; a conexão nem vai à nuvem (world/sync-conexoes.ts).
 * Leitura: empresas, razões (ledgers) com saldo, grupos com saldo (o balancete) e vouchers de um período. Escrita: criar um
 * voucher, sempre-protegida (pede o cartão toda vez, mesmo com "Liberar tudo").
 * Formato: o XML de integração do Tally (help.tallysolutions.com/xml-integration; Export de Collection com TDL e Import Data de
 * Vouchers). Escrito de memória da documentação (a rede desta máquina não a alcança): conferir num TallyPrime de verdade.
 * Saldos do Tally: negativo é débito (Dr) e positivo é crédito (Cr).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { clip } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { ErroAcao, type Args, type Http } from '../tipos.ts';
import { detalhes, linhaDe, vazio, type ConectorDef, type Credenciais } from './declarativo.ts';

// ---------------------------------------------------------------------------------------------------- rede local
/** Só endereço privado ou desta máquina (o servidor do Ergon nunca vira ponte para a internet nem para o metadado da nuvem). */
export function enderecoLocal(ip: string): 'privado' | 'maquina' | null {
  let v = ip.toLowerCase();
  const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapeado) v = mapeado[1];
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 127) return 'maquina';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'privado';
    return null; // 0/8, 169.254 (enlace e metadado), e todo o resto, público
  }
  if (net.isIPv6(v)) {
    if (v === '::1') return 'maquina';
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return 'privado';
    return null; // fe80:: (enlace) e o resto
  }
  return null;
}
/** Portas desta máquina que não são do Tally: as de sistema, a do Ergon e as do motor. */
const PORTAS_DA_MAQUINA = new Set([Number(process.env.ERGON_PORT) || 8787, 8642, 8643, 8644, 8645]);

export function hostTally(c: Credenciais): { host: string; porta: number } {
  const host = String(c.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const ip6 = /^\[([0-9a-f:.]+)\]$/.exec(host)?.[1];
  if (!ip6 && !/^[a-z0-9.-]{1,253}$/.test(host)) throw new ErroAcao('endereço do Tally inválido: use o nome ou o IP do computador do Tally, como 192.168.1.20 ou tally-pc.local');
  const p = vazio(c.porta) ? 9000 : Number(String(c.porta).trim());
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ErroAcao('porta do Tally inválida (a padrão é 9000)');
  return { host: ip6 ?? host, porta: p };
}

/** O IP conferido do Tally (todos os endereços do nome precisam ser locais). `resolver`: só para os testes. */
export async function ipDoTally(c: Credenciais, resolver: (h: string) => Promise<string[]> = async (h) => (await dns.lookup(h, { all: true, verbatim: true })).map((x) => x.address)): Promise<{ ip: string; porta: number }> {
  const { host, porta } = hostTally(c);
  let ips: string[];
  try { ips = net.isIP(host) ? [host] : await resolver(host); } catch { throw new ErroAcao(`não achei o computador "${host}" na rede: confira o nome ou use o IP dele`); }
  if (!ips.length) throw new ErroAcao(`não achei o computador "${host}" na rede`);
  const tipos = ips.map(enderecoLocal);
  if (tipos.some((t) => t === null)) throw new ErroAcao('o Tally precisa estar nesta máquina ou na rede local: endereço público não é aceito, por segurança do servidor do Ergon');
  if (tipos.includes('maquina') && (porta < 1024 || PORTAS_DA_MAQUINA.has(porta))) throw new ErroAcao(`a porta ${porta} desta máquina não é a do Tally (a padrão é 9000)`);
  return { ip: ips[0], porta };
}

// ---------------------------------------------------------------------------------------------------- XML
export interface No { tag: string; attrs: Record<string, string>; filhos: No[]; texto: string }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const desfaz = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n >= 32 || n === 9 || n === 10 || n === 13 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
/** Texto que entra no XML do pedido: escapado, sem caracteres de controle (o Tally não aceita). */
export const xml = (s: unknown) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Um leitor de XML pequeno, para a resposta do Tally (sem DTD, sem entidades externas: não há como pedir arquivo nem rede). */
export function lerXml(s: string): No {
  const raiz: No = { tag: '#', attrs: {}, filhos: [], texto: '' };
  const pilha: No[] = [raiz];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w.:-]+)\s*>|<([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s))) {
    if (++n > 400_000) throw new ProviderError('unavailable', 'a resposta do Tally é grande demais: peça um período menor');
    const topo = pilha[pilha.length - 1];
    if (m[1] !== undefined) topo.texto += m[1];
    else if (m[2]) { if (pilha.length > 1 && topo.tag.toUpperCase() === m[2].toUpperCase()) pilha.pop(); }
    else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toUpperCase()] = desfaz(a[2] ?? a[3] ?? '');
      const no: No = { tag: m[3].toUpperCase(), attrs, filhos: [], texto: '' };
      topo.filhos.push(no);
      if (!m[5] && pilha.length < 64) pilha.push(no);
    } else if (m[6]) topo.texto += desfaz(m[6]);
  }
  return raiz;
}
export const filho = (n: No | undefined, tag: string): No | undefined => n?.filhos.find((f) => f.tag === tag);
export const todos = (n: No | undefined, tag: string): No[] => n?.filhos.filter((f) => f.tag === tag) ?? [];
/** O texto de um campo do nó (ou do atributo NAME, onde o Tally guarda o nome do razão e do grupo). */
const campo = (n: No, tag: string): string => (tag === 'NAME' ? n.attrs.NAME ?? filho(n, 'NAME')?.texto ?? '' : filho(n, tag)?.texto ?? '').trim();
/** Procura em profundidade (o Tally embrulha a coleção em ENVELOPE › BODY › DATA › COLLECTION). */
export function achar(n: No, tag: string): No | undefined {
  for (const f of n.filhos) { if (f.tag === tag) return f; const x = achar(f, tag); if (x) return x; }
  return undefined;
}

/** Valor do Tally: negativo é débito (Dr), positivo é crédito (Cr), com o agrupamento indiano. */
export function saldo(v: string): string {
  const t = v.replace(/[^\d.-]/g, '');
  const n = Number(t);
  if (!t || !Number.isFinite(n)) return v || '0';
  if (n === 0) return '0.00';
  return `${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))} ${n < 0 ? 'Dr' : 'Cr'}`;
}

// ---------------------------------------------------------------------------------------------------- transporte
/** Lê a resposta: o Tally pode responder em UTF-16 (com BOM) ou UTF-8. */
const textoDe = (b: Buffer) => (b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3).toString('utf8') : b.length > 1 && b[1] === 0 ? b.toString('utf16le') : b.toString('utf8'));
const MAX_RESPOSTA = 8 * 1024 * 1024;

/** O "http" do conector: o corpo é o XML do pedido; volta a árvore da resposta. */
export function transporteTally(c: Credenciais, resolver?: (h: string) => Promise<string[]>): Http {
  return async (_caminho, init = {}) => {
    const { ip, porta } = await ipDoTally(c, resolver);
    const url = `http://${net.isIPv6(ip) ? `[${ip}]` : ip}:${porta}/`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' }, body: String(init.body ?? ''), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new ProviderError('unavailable', 'o Tally não respondeu: confira se o TallyPrime está aberto, com a empresa carregada, e se em F1 › Settings › Connectivity ele está como Server (ou "Both") na porta informada');
    }
    if (!res.ok) throw new ProviderError('unavailable', `o Tally respondeu ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPOSTA) throw new ProviderError('unavailable', 'a resposta do Tally é grande demais: peça um período menor');
    const arvore = lerXml(textoDe(buf));
    // erro do Tally: LINEERROR na importação, ou ERRORS/"Could not find" na exportação
    const linhaErro = achar(arvore, 'LINEERROR')?.texto.trim();
    if (linhaErro) throw new ProviderError('unavailable', `o Tally recusou: ${clip(linhaErro, 200)}`);
    if (!achar(arvore, 'ENVELOPE') && !achar(arvore, 'RESPONSE')) throw new ProviderError('unavailable', 'a resposta não parece do Tally: confira o endereço e a porta');
    return arvore;
  };
}

// ---------------------------------------------------------------------------------------------------- pedidos
const empresaXml = (a: Args) => (vazio(a._empresa) ? '' : `<SVCURRENTCOMPANY>${xml(a._empresa)}</SVCURRENTCOMPANY>`);
const data8 = (d: unknown) => String(d).replace(/-/g, '');
/** Exportar uma coleção pelo TDL do próprio pedido (não muda nada no Tally). */
export const pedidoColecao = (tipo: string, campos: string, a: Args, filtro = '') => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ErgonColecao</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${empresaXml(a)}${a._de ? `<SVFROMDATE>${data8(a._de)}</SVFROMDATE><SVTODATE>${data8(a._ate)}</SVTODATE>` : ''}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="ErgonColecao" ISMODIFY="No"><TYPE>${tipo}</TYPE><FETCH>${campos}</FETCH>${filtro ? '<FILTERS>ErgonFiltro</FILTERS>' : ''}</COLLECTION>${filtro ? `<SYSTEM TYPE="Formulae" NAME="ErgonFiltro">${filtro}</SYSTEM>` : ''}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

const periodo = (a: Args): Args => {
  const ok = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  if (!vazio(a.de) && !ok(a.de)) throw new ErroAcao('"de" precisa estar no formato AAAA-MM-DD');
  if (!vazio(a.ate) && !ok(a.ate)) throw new ErroAcao('"ate" precisa estar no formato AAAA-MM-DD');
  if (vazio(a.de) && vazio(a.ate)) return a;
  const ate = vazio(a.ate) ? new Date().toISOString().slice(0, 10) : String(a.ate);
  const de = vazio(a.de) ? `${ate.slice(0, 8)}01` : String(a.de);
  if (de > ate) throw new ErroAcao('"de" precisa vir antes de "ate"');
  return { ...a, _de: de, _ate: ate };
};
const comEmpresa = (c: Credenciais | undefined, a: Args): Args => ({ ...a, _empresa: vazio(a.empresa) ? String(c?.empresa ?? '') : String(a.empresa) });
const P_EMPRESA = { tipo: 'texto' as const, descricao: 'nome da empresa no Tally (sem ele, a da conexão ou a que estiver aberta)' };
const linhas = (l: string[]) => (l.length ? l.map((x) => `- ${x}`).join('\n') : 'nada encontrado');
const TIPOS_VOUCHER = ['Receipt', 'Payment', 'Journal', 'Contra', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'];
const nomeTdl = (nome: string, v: unknown) => {
  const s = String(v ?? '');
  if (/["\r\n<>]/.test(s) || s.length > 200) throw new ErroAcao(`"${nome}" não pode ter aspas, < > ou quebra de linha`);
  return s;
};

export const TALLY: ConectorDef = {
  kind: 'tally', nome: 'Tally', site: 'tallysolutions.com', grupo: 'financeiro',
  soLocal: 'O Tally só se conecta com o Ergon instalado no computador ou na rede da empresa (Community local): na nuvem do Ergon ele não alcança o TallyPrime, que fica na sua rede.',
  sobre: 'O TallyPrime da sua empresa, na rede local: os agentes leem razões (ledgers), saldos, o balancete e os vouchers de um período. Criar um voucher sempre pede a sua aprovação, mesmo com "Liberar tudo". Só no Ergon instalado no computador ou na rede da empresa.',
  campos: [
    { name: 'host', label: 'Computador do Tally (nome ou IP na rede local)', placeholder: '192.168.1.20 ou tally-pc.local' },
    { name: 'porta', label: 'Porta', placeholder: '9000', pattern: /^\d{1,5}$/, patternHelp: 'só números (a padrão é 9000)', opcional: true },
    { name: 'empresa', label: 'Empresa no Tally (se houver mais de uma)', placeholder: 'Como aparece no Tally, ex.: Sharma Traders', opcional: true },
  ],
  ajuda: {
    url: 'https://help.tallysolutions.com/xml-integration/',
    passos: 'No TallyPrime, abra a empresa e vá em F1 (Help) › Settings › Connectivity. Em "TallyPrime acts as", escolha Server (ou Both) e anote a porta (a padrão é 9000). Deixe o TallyPrime aberto com a empresa carregada: é ele que responde ao Ergon. Aqui, informe o nome ou o IP do computador do Tally na rede local (no próprio computador do Ergon, use 127.0.0.1; com o Ergon no Docker e o Tally no mesmo computador, host.docker.internal) e a porta. Se o firewall do Windows perguntar, permita o TallyPrime na rede privada. Endereço público não é aceito.',
  },
  base: (c) => { const { host, porta } = hostTally(c); return `http://${host}:${porta}`; },
  auth: { tipo: 'nenhuma' },
  transporte: (c) => transporteTally(c),
  quemSou: {
    caminho: '/', metodo: 'POST', corpo: (c: Credenciais) => pedidoColecao('Company', 'Name,StartingFrom', comEmpresa(c, {})),
    nome: (j) => { const l = todos(achar(j, 'COLLECTION'), 'COMPANY').map((n) => campo(n, 'NAME')).filter(Boolean); return l.length ? `TallyPrime: ${l.slice(0, 3).join(', ')}` : 'TallyPrime'; },
  },
  acoes: [
    { id: 'tally.empresas', descricao: 'lista as empresas abertas no TallyPrime', rotulo: 'lista as empresas abertas', risco: 'ler', params: {},
      resumo: 'Ler as empresas abertas no Tally', metodo: 'POST', caminho: '/', corpo: (a: Args) => pedidoColecao('Company', 'Name,StartingFrom,BooksFrom', a),
      texto: (j) => linhas(todos(achar(j, 'COLLECTION'), 'COMPANY').map((n) => linhaDe('{nome} (livros desde {desde})', { nome: campo(n, 'NAME'), desde: campo(n, 'BOOKSFROM') || campo(n, 'STARTINGFROM') }))) },
    { id: 'tally.razoes', descricao: 'lista os razões (ledgers) com o grupo e o saldo de abertura e de fechamento (Dr/Cr); filtra por grupo ou nome', rotulo: 'lista razões (ledgers) e saldos', risco: 'ler',
      params: { grupo: { tipo: 'texto', descricao: 'só os razões deste grupo, como Sundry Debtors ou Bank Accounts' }, nome: { tipo: 'texto', descricao: 'parte do nome do razão' }, de: { tipo: 'texto', descricao: 'período: de (AAAA-MM-DD)' }, ate: { tipo: 'texto', descricao: 'período: até (AAAA-MM-DD)' }, empresa: P_EMPRESA },
      resumo: (a) => `Ler os razões do Tally${detalhes(a, { grupo: ' do grupo', nome: ' com o nome', de: ' de', ate: ' até' }).replace(/\n/g, ',')}`, metodo: 'POST', caminho: '/',
      antes: async (ctx, a) => periodo(comEmpresa(ctx.creds, a)), corpo: (a: Args) => pedidoColecao('Ledger', 'Name,Parent,OpeningBalance,ClosingBalance', a),
      texto: (j, a) => {
        const g = String(a.grupo ?? '').toLowerCase(); const nm = String(a.nome ?? '').toLowerCase();
        const l = todos(achar(j, 'COLLECTION'), 'LEDGER').filter((n) => (!g || campo(n, 'PARENT').toLowerCase() === g) && (!nm || campo(n, 'NAME').toLowerCase().includes(nm)));
        return linhas(l.slice(0, 500).map((n) => linhaDe('{nome} [{grupo}]: abertura {ab}, fechamento {fe}', { nome: campo(n, 'NAME'), grupo: campo(n, 'PARENT'), ab: saldo(campo(n, 'OPENINGBALANCE')), fe: saldo(campo(n, 'CLOSINGBALANCE')) })));
      } },
    { id: 'tally.saldos', descricao: 'o balancete: os grupos principais (ou os subgrupos de um grupo) com o saldo de fechamento (Dr/Cr) no período', rotulo: 'mostra o balancete (saldos por grupo)', risco: 'ler',
      params: { grupo: { tipo: 'texto', descricao: 'os subgrupos deste grupo; sem ele, os grupos principais' }, de: { tipo: 'texto', descricao: 'de (AAAA-MM-DD)' }, ate: { tipo: 'texto', descricao: 'até (AAAA-MM-DD)' }, empresa: P_EMPRESA },
      resumo: (a) => `Ler os saldos do Tally${a.grupo ? ` do grupo ${String(a.grupo)}` : ''}`, metodo: 'POST', caminho: '/',
      antes: async (ctx, a) => periodo(comEmpresa(ctx.creds, a)), corpo: (a: Args) => pedidoColecao('Group', 'Name,Parent,ClosingBalance', a),
      texto: (j, a) => {
        const g = String(a.grupo ?? '').toLowerCase();
        const l = todos(achar(j, 'COLLECTION'), 'GROUP').filter((n) => { const p = campo(n, 'PARENT').toLowerCase(); return g ? p === g : !p || p === 'primary'; });
        return linhas(l.map((n) => linhaDe('{nome}: {fe}', { nome: campo(n, 'NAME'), fe: saldo(campo(n, 'CLOSINGBALANCE')) })));
      } },
    { id: 'tally.vouchers', descricao: 'lista os vouchers (lançamentos) de um período, como o Day Book; filtra por tipo (Sales, Receipt...) e por razão', rotulo: 'lista vouchers de um período', risco: 'ler',
      params: { de: { tipo: 'texto', descricao: 'de (AAAA-MM-DD; padrão: o começo do mês)' }, ate: { tipo: 'texto', descricao: 'até (AAAA-MM-DD; padrão: hoje)' }, tipo: { tipo: 'texto', descricao: 'tipo do voucher, como Sales, Purchase, Receipt, Payment, Journal' }, razao: { tipo: 'texto', descricao: 'só os vouchers com este razão (party ledger)' }, limite: { tipo: 'numero', descricao: 'quantos (padrão 100, até 500)', padrao: 100, max: 500 }, empresa: P_EMPRESA },
      resumo: (a) => `Ler os vouchers do Tally${detalhes(a, { tipo: ' do tipo', razao: ' do razão', de: ' de', ate: ' até' }).replace(/\n/g, ',')}`, metodo: 'POST', caminho: '/',
      antes: async (ctx, a) => { const p = periodo(comEmpresa(ctx.creds, { ...a, de: vazio(a.de) && vazio(a.ate) ? `${new Date().toISOString().slice(0, 8)}01` : a.de })); if (!vazio(a.tipo)) nomeTdl('tipo', a.tipo); return p; },
      corpo: (a: Args) => pedidoColecao('Voucher', 'Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Amount,MasterID', a,
        vazio(a.tipo) ? '' : `$VoucherTypeName = "${xml(nomeTdl('tipo', a.tipo))}"`),
      texto: (j, a) => {
        const r = String(a.razao ?? '').toLowerCase();
        const l = todos(achar(j, 'COLLECTION'), 'VOUCHER').filter((n) => !r || campo(n, 'PARTYLEDGERNAME').toLowerCase().includes(r)).slice(0, Number(a.limite) || 100);
        return linhas(l.map((n) => linhaDe('{data} {tipo} nº {num}: {parte}, {valor} — {narr} (id {id})', { data: campo(n, 'DATE').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), tipo: campo(n, 'VOUCHERTYPENAME'), num: campo(n, 'VOUCHERNUMBER'), parte: campo(n, 'PARTYLEDGERNAME'), valor: saldo(campo(n, 'AMOUNT')), narr: campo(n, 'NARRATION'), id: campo(n, 'MASTERID') })));
      } },
    { id: 'tally.criar_voucher', descricao: 'cria um voucher simples no Tally: um razão a débito e outro a crédito, com o mesmo valor (ex.: Receipt de um cliente em Cash ou no banco). Sempre pede a aprovação da pessoa', rotulo: 'cria um voucher (sempre pede a sua aprovação)', risco: 'organizar',
      protegida: 'um voucher entra na contabilidade da empresa: criar voucher no Tally pede a sua aprovação sempre, mesmo com "Liberar tudo"',
      params: {
        tipo: { tipo: 'texto', obrigatorio: true, descricao: 'tipo do voucher', opcoes: TIPOS_VOUCHER },
        data: { tipo: 'texto', obrigatorio: true, descricao: 'AAAA-MM-DD' },
        debito: { tipo: 'texto', obrigatorio: true, descricao: 'razão a débito (Dr), com o nome exato do Tally', max: 200 },
        credito: { tipo: 'texto', obrigatorio: true, descricao: 'razão a crédito (Cr), com o nome exato do Tally', max: 200 },
        valor: { tipo: 'numero', obrigatorio: true, descricao: 'valor (em rupias)' },
        narracao: { tipo: 'texto', descricao: 'narração do voucher', max: 1000 }, empresa: P_EMPRESA,
      },
      resumo: (a) => `Criar um voucher ${String(a.tipo)} no Tally em ${String(a.data)}:\nDébito (Dr): ${String(a.debito)}\nCrédito (Cr): ${String(a.credito)}\nValor: ${saldo(String(a.valor)).replace(/ Cr$/, '')}${a.narracao ? `\nNarração: ${String(a.narracao)}` : ''}`,
      preparar: async (_c, a) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.data ?? ''))) throw new ErroAcao('"data" precisa estar no formato AAAA-MM-DD');
        if (!(Number(a.valor) > 0)) throw new ErroAcao('"valor" precisa ser maior que zero');
        if (String(a.debito ?? '').trim().toLowerCase() === String(a.credito ?? '').trim().toLowerCase()) throw new ErroAcao('débito e crédito precisam ser razões diferentes');
        return {};
      },
      metodo: 'POST', caminho: '/', antes: async (ctx, a) => comEmpresa(ctx.creds, a),
      corpo: (a: Args) => {
        const v = (Math.round(Number(a.valor) * 100) / 100).toFixed(2);
        const lanc = (razao: unknown, debito: boolean) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(razao)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debito ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${debito ? '-' : ''}${v}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
        return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES>${empresaXml(a)}</STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${xml(a.tipo)}" ACTION="Create"><DATE>${data8(a.data)}</DATE><VOUCHERTYPENAME>${xml(a.tipo)}</VOUCHERTYPENAME>${a.narracao ? `<NARRATION>${xml(a.narracao)}</NARRATION>` : ''}${lanc(a.debito, true)}${lanc(a.credito, false)}</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
      },
      texto: (j) => {
        const r = achar(j, 'RESPONSE') ?? j;
        const criados = Number(filho(r, 'CREATED')?.texto ?? achar(j, 'CREATED')?.texto ?? 0);
        if (criados < 1) throw new ErroAcao(`o Tally não criou o voucher (erros: ${(achar(j, 'ERRORS')?.texto ?? '?').trim()}): confira os nomes dos razões e o tipo do voucher`);
        return `Voucher criado no Tally (id ${(achar(j, 'LASTVCHID')?.texto ?? '').trim() || 'sem número'}).`;
      } },
  ],
};

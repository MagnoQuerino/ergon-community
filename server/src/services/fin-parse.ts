/**
 * Leitura estruturada para as rotinas de administração, por código: lançamentos a partir de NF-e/NFS-e (XML),
 * extrato OFX, planilhas (data + valor + descrição) e, com confiança baixa, PDF/texto (DANFE, recibo, boleto);
 * conferência entre duas fontes (casamento por valor e data); e as datas e obrigações dos contratos (vigência,
 * renovação, reajuste, aviso prévio, pagamentos). Os valores e as datas saem daqui — o agente classifica e explica.
 */
import { parseDate, parseNumber } from './csv.ts';
import type { DocText, Sheet } from './doc-text.ts';
import { analyzeSheet, fmt } from './table-stats.ts';

export interface Lancamento {
  n: number; data: string; descricao: string; valor: number; documento: string;
  origem: 'nfe' | 'nfse' | 'ofx' | 'planilha' | 'texto'; parte?: string; vencimento?: string; numero?: string;
  confianca: 'alta' | 'media' | 'baixa';
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`, 'i'))?.[1]?.trim();
const block = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'))?.[1] ?? '';
const num = (s: string | undefined) => (s === undefined ? null : Number.isFinite(Number(s)) ? Number(s) : parseNumber(s));
const cut = (s: string, n = 80) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Lançamentos de um documento já lido (a numeração continua de `start`). */
export function lancamentosOf(doc: DocText, start = 1): Lancamento[] {
  const out: Lancamento[] = [];
  const push = (l: Omit<Lancamento, 'n' | 'documento'>) => out.push({ n: start + out.length, documento: doc.name, ...l });
  if (doc.kind === 'xml' && doc.raw) {
    const x = doc.raw;
    if (/<infNFe\b/i.test(x)) { // NF-e (modelo 55/65)
      const ide = block(x, 'ide'); const emit = block(x, 'emit'); const dest = block(x, 'dest');
      const data = (tag(ide, 'dhEmi') ?? tag(ide, 'dEmi') ?? '').slice(0, 10);
      const total = num(tag(block(x, 'ICMSTot'), 'vNF'));
      const nNF = tag(ide, 'nNF');
      const emitente = tag(emit, 'xNome') ?? 'emitente'; const destinatario = tag(dest, 'xNome') ?? '';
      const itens = [...x.matchAll(/<det\b[\s\S]*?<xProd>([^<]*)<\/xProd>/gi)].map((m) => m[1]).slice(0, 3);
      const dups = [...x.matchAll(/<dup>([\s\S]*?)<\/dup>/gi)].map((m) => ({ venc: tag(m[1], 'dVenc'), v: num(tag(m[1], 'vDup')), n: tag(m[1], 'nDup') }));
      const desc = `NF-e ${nNF ?? ''} ${emitente}${itens.length ? ` — ${itens.map((i) => cut(i, 40)).join('; ')}` : ''}`;
      if (dups.length > 1) for (const d of dups) { if (d.v !== null) push({ data, descricao: cut(`${desc} (parcela ${d.n ?? ''})`, 140), valor: -Math.abs(d.v), origem: 'nfe', parte: cut(emitente), vencimento: d.venc, numero: nNF, confianca: 'alta' }); }
      else if (total !== null) push({ data, descricao: cut(desc, 140), valor: -Math.abs(total), origem: 'nfe', parte: cut(emitente), vencimento: dups[0]?.venc, numero: nNF, confianca: 'alta' });
      if (out.length && destinatario) out.forEach((l) => { l.descricao = cut(`${l.descricao} · para ${destinatario}`, 160); });
      return out;
    }
    if (/<(?:\w+:)?(?:InfNfse|Nfse|CompNfse)\b/i.test(x)) { // NFS-e (padrão ABRASF)
      const valor = num(tag(x, 'ValorLiquidoNfse') ?? tag(x, 'ValorServicos'));
      const data = (tag(x, 'DataEmissao') ?? tag(x, 'Competencia') ?? '').slice(0, 10);
      const prest = tag(block(x, 'PrestadorServico') || block(x, 'Prestador'), 'RazaoSocial') ?? tag(x, 'RazaoSocial') ?? 'prestador';
      const disc = tag(x, 'Discriminacao') ?? '';
      if (valor !== null) push({ data, descricao: cut(`NFS-e ${tag(x, 'Numero') ?? ''} ${prest}${disc ? ` — ${disc}` : ''}`, 160), valor: -Math.abs(valor), origem: 'nfse', parte: cut(prest), numero: tag(x, 'Numero'), confianca: 'alta' });
      return out;
    }
  }
  if (doc.kind === 'ofx' && doc.raw) { // extrato bancário: cada STMTTRN é um lançamento (crédito +, débito −)
    const sgml = (b: string, k: string) => b.match(new RegExp(`<${k}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim();
    for (const m of doc.raw.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
      const d = sgml(m[1], 'DTPOSTED') ?? ''; const v = num(sgml(m[1], 'TRNAMT'));
      if (!/^\d{8}/.test(d) || v === null) continue;
      push({ data: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, descricao: cut(sgml(m[1], 'MEMO') ?? sgml(m[1], 'NAME') ?? sgml(m[1], 'TRNTYPE') ?? 'lançamento', 140), valor: v, origem: 'ofx', numero: sgml(m[1], 'FITID') ?? sgml(m[1], 'CHECKNUM'), confianca: 'alta' });
      if (out.length >= 2000) break;
    }
    return out;
  }
  if (doc.kind === 'planilha' && doc.sheets) {
    for (const s of doc.sheets) out.push(...sheetLancamentos(s, doc.name, start + out.length));
    return out;
  }
  if ((doc.kind === 'pdf' || doc.kind === 'texto') && doc.text) { // DANFE, recibo, boleto: o total e a data, para conferir
    const t = doc.text;
    const total = t.match(/(?:valor\s+total(?:\s+da\s+nota)?|total\s+a\s+pagar|valor\s+do\s+documento|valor\s+cobrado|total\s+geral|valor\s+l[ií]quido|valor)\s*[:\-]?\s*(?:R\$\s*)?([\d.]+,\d{2})/i);
    const date = t.match(/(?:data\s+(?:de\s+)?(?:emiss[aã]o|pagamento|vencimento)|emitid[oa]\s+em|vencimento)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i) ?? t.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
    const iso = date ? parseDate(date[1]) : null;
    const party = t.match(/(?:raz[aã]o\s+social|emitente|benefici[aá]rio|cedente|prestador)\s*[:\-]?\s*([^\n|]{3,80})/i)?.[1];
    const v = total ? parseNumber(total[1]) : null;
    if (v !== null) push({ data: typeof iso === 'string' ? iso : '', descricao: cut(`${doc.kind === 'pdf' ? 'Documento' : 'Texto'} ${doc.name}${party ? ` — ${party}` : ''}`, 140), valor: -Math.abs(v), origem: 'texto', parte: party ? cut(party) : undefined, confianca: 'baixa' });
  }
  return out;
}

/** Planilha de lançamentos: coluna de data, de valor (ou débito e crédito) e de descrição. */
export function sheetLancamentos(s: Sheet, documento: string, start = 1): Lancamento[] {
  const st = analyzeSheet(s);
  const cols = st.columns;
  const idx = (re: RegExp, type?: string) => cols.findIndex((c) => re.test(c.name) && (!type || c.type === type));
  const di = idx(/data|date|dt\b|lan[cç]amento|pagamento|vencimento/i, 'data') >= 0 ? idx(/data|date|dt\b|lan[cç]amento|pagamento|vencimento/i, 'data') : cols.findIndex((c) => c.type === 'data');
  const deb = idx(/d[eé]bito|sa[ií]da|pagamento|despesa/i, 'numero'); const cred = idx(/cr[eé]dito|entrada|recebimento|receita/i, 'numero');
  const vi = idx(/valor|value|amount|montante|total|quantia/i, 'numero') >= 0 ? idx(/valor|value|amount|montante|total|quantia/i, 'numero') : cols.findIndex((c) => c.type === 'numero');
  const ti = idx(/descri|hist[oó]rico|memo|fornecedor|cliente|favorecido|nome|benefici/i, 'texto') >= 0 ? idx(/descri|hist[oó]rico|memo|fornecedor|cliente|favorecido|nome|benefici/i, 'texto') : cols.findIndex((c) => c.type === 'texto');
  const ni = idx(/n[uú]mero|doc|nf|nota|id\b|c[oó]digo/i);
  if (di < 0 || (vi < 0 && deb < 0 && cred < 0)) return [];
  const body = s.rows.slice(1); const out: Lancamento[] = [];
  for (const r of body) {
    const d = parseDate(r[di] ?? '');
    let v: number | null = null;
    if (deb >= 0 || cred >= 0) { const a = cred >= 0 ? parseNumber(r[cred] ?? '') ?? 0 : 0; const b = deb >= 0 ? parseNumber(r[deb] ?? '') ?? 0 : 0; v = a || b ? Math.round((a - Math.abs(b)) * 100) / 100 : null; }
    if (v === null && vi >= 0) v = parseNumber(r[vi] ?? '');
    if (typeof d !== 'string' || v === null) continue;
    out.push({ n: start + out.length, data: d, descricao: cut(ti >= 0 ? r[ti] ?? '' : '(sem descrição)', 140) || '(sem descrição)', valor: v, documento, origem: 'planilha', numero: ni >= 0 ? cut(r[ni] ?? '', 30) || undefined : undefined, confianca: 'media' });
    if (out.length >= 3000) break;
  }
  return out;
}

const brl = (v: number) => `${v < 0 ? '−' : ''}R$ ${fmt(Math.abs(v))}`;
const brd = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'sem data');
export const lancamentoLine = (l: Lancamento) =>
  `L${l.n} · ${brd(l.data)} · ${brl(l.valor)} · ${l.descricao}${l.vencimento ? ` · vence ${brd(l.vencimento)}` : ''}${l.numero ? ` · nº ${l.numero}` : ''} · ${l.documento}${l.confianca === 'baixa' ? ' · CONFERIR (lido de PDF/texto)' : ''}`;

// --- conferência entre duas fontes ---------------------------------------------------------------------------------

export interface Conferencia {
  a: string; b: string; casados: number; totalA: number; totalB: number;
  soA: Lancamento[]; soB: Lancamento[]; valorDiferente: Array<{ a: Lancamento; b: Lancamento; diff: number }>;
  repetidosA: Lancamento[]; repetidosB: Lancamento[];
  /** casados que tinham mais de um candidato (mesmo valor na mesma janela): qual é qual não é certo */
  ambiguos: Lancamento[];
  /** casados por valor com sinal oposto (entrada numa fonte, saída na outra): pode ser só a convenção da planilha */
  sinalTrocado: Array<{ a: Lancamento; b: Lancamento }>;
}
const days = (x: string, y: string) => Math.abs(Date.parse(`${x}T12:00:00Z`) - Date.parse(`${y}T12:00:00Z`)) / 86_400_000;
const cents = (v: number) => Math.round(Math.abs(v) * 100);

/** Casa os lançamentos de A com os de B: mesmo valor (centavos) e data até ±3 dias; depois, quase iguais (até 1%). */
/**
 * Casa lançamentos por valor e data (até `tolDays`): é uma conferência **provável**, não comprovada — a descrição não
 * é comparada. Primeiro com o mesmo sinal; depois, o que sobrou, com sinal oposto (dito em `sinalTrocado`). Quando
 * havia mais de um candidato possível, o casamento fica em `ambiguos`.
 */
export function conferir(nameA: string, A: Lancamento[], nameB: string, B: Lancamento[], tolDays = 3): Conferencia {
  const usedB = new Set<number>(); const matchedA = new Set<number>();
  const ambiguos: Lancamento[] = []; const sinalTrocado: Conferencia['sinalTrocado'] = [];
  const dup = (L: Lancamento[]) => { const seen = new Set<string>(); return L.filter((l) => { const k = `${l.data}|${cents(l.valor)}|${l.descricao.toLowerCase()}`; if (seen.has(k)) return true; seen.add(k); return false; }); };
  const pass = (sameSign: boolean) => A.forEach((a, i) => {
    if (matchedA.has(i)) return;
    let best = -1; let bd = Infinity; let cands = 0;
    B.forEach((b, j) => {
      if (usedB.has(j) || cents(a.valor) !== cents(b.valor) || (Math.sign(a.valor) === Math.sign(b.valor)) !== sameSign) return;
      const d = a.data && b.data ? days(a.data, b.data) : 99;
      if (d <= tolDays) { cands++; if (d < bd) { bd = d; best = j; } }
    });
    if (best < 0) return;
    usedB.add(best); matchedA.add(i);
    if (cands > 1) ambiguos.push(a);
    if (!sameSign) sinalTrocado.push({ a, b: B[best] });
  });
  pass(true); pass(false);
  const valorDiferente: Conferencia['valorDiferente'] = [];
  A.forEach((a, i) => {
    if (matchedA.has(i)) return;
    const j = B.findIndex((b, k) => !usedB.has(k) && a.data && b.data && days(a.data, b.data) <= tolDays && Math.abs(cents(a.valor) - cents(b.valor)) <= Math.max(1, cents(a.valor) * 0.01));
    if (j >= 0) { usedB.add(j); matchedA.add(i); valorDiferente.push({ a, b: B[j], diff: Math.round((Math.abs(a.valor) - Math.abs(B[j].valor)) * 100) / 100 }); }
  });
  return {
    a: nameA, b: nameB, casados: matchedA.size - valorDiferente.length, totalA: A.length, totalB: B.length,
    soA: A.filter((_, i) => !matchedA.has(i)), soB: B.filter((_, j) => !usedB.has(j)), valorDiferente, repetidosA: dup(A), repetidosB: dup(B),
    ambiguos, sinalTrocado,
  };
}

export function conferenciaLines(c: Conferencia): string[] {
  const sum = (L: Lancamento[]) => brl(L.reduce((s, l) => s + l.valor, 0));
  // lista longa: as primeiras aqui, todas no CSV da conferência (nada some calado)
  const more = (n: number, shown: number) => (n > shown ? [`  … e mais ${n - shown} (lista inteira no CSV da conferência)`] : []);
  return [
    `Fonte A = ${c.a} (${c.totalA} lançamento(s)); fonte B = ${c.b} (${c.totalB}). Casados por valor e data (até 3 dias; a descrição não é comparada): ${c.casados} — prováveis, não comprovados.`,
    ...(c.ambiguos.length ? [`Casamentos incertos (${c.ambiguos.length}): havia mais de um lançamento com o mesmo valor na mesma janela — confira qual é qual: ${c.ambiguos.slice(0, 15).map((l) => `A L${l.n}`).join(', ')}${c.ambiguos.length > 15 ? ' e outros (no CSV)' : ''}`] : []),
    ...(c.sinalTrocado.length ? [`Casados com sinal trocado (${c.sinalTrocado.length}): entrada numa fonte, saída na outra — pode ser só a convenção da planilha, ou outro lançamento; confira:`, ...c.sinalTrocado.slice(0, 15).map((d) => `  A L${d.a.n} ${brl(d.a.valor)} × B L${d.b.n} ${brl(d.b.valor)} · ${brd(d.a.data)} · ${d.a.descricao}`), ...more(c.sinalTrocado.length, 15)] : []),
    `Só em A (${c.soA.length}, soma ${sum(c.soA)}):`, ...c.soA.slice(0, 25).map((l) => `  A ${lancamentoLine(l)}`), ...more(c.soA.length, 25),
    `Só em B (${c.soB.length}, soma ${sum(c.soB)}):`, ...c.soB.slice(0, 25).map((l) => `  B ${lancamentoLine(l)}`), ...more(c.soB.length, 25),
    `Valor diferente (até 1%, na mesma janela — pode ser outro lançamento) (${c.valorDiferente.length}):`, ...c.valorDiferente.slice(0, 15).map((d) => `  A L${d.a.n} ${brl(d.a.valor)} × B L${d.b.n} ${brl(d.b.valor)} (diferença ${brl(d.diff)}) · ${brd(d.a.data)} · ${d.a.descricao}`), ...more(c.valorDiferente.length, 15),
    ...(c.repetidosA.length ? [`Repetidos em A (${c.repetidosA.length}): ${c.repetidosA.slice(0, 10).map((l) => `L${l.n}`).join(', ')}`] : []),
    ...(c.repetidosB.length ? [`Repetidos em B (${c.repetidosB.length}): ${c.repetidosB.slice(0, 10).map((l) => `L${l.n}`).join(', ')}`] : []),
  ];
}

// --- contratos: datas e obrigações ---------------------------------------------------------------------------------

export type ObrigacaoTipo = 'fim' | 'renovacao' | 'reajuste' | 'aviso' | 'pagamento' | 'assinatura' | 'outra';
export interface Obrigacao { code: string; contrato: string; tipo: ObrigacaoTipo; data: string; trecho: string; derivada?: string }
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const TIPO_LABEL: Record<ObrigacaoTipo, string> = { fim: 'fim da vigência', renovacao: 'renovação', reajuste: 'reajuste', aviso: 'prazo do aviso prévio', pagamento: 'pagamento', assinatura: 'assinatura', outra: 'data' };
const KIND: Array<[ObrigacaoTipo, RegExp]> = [
  ['aviso', /aviso\s+pr[eé]vio|anteced[eê]ncia\s+m[ií]nima|notifica[cç][aã]o\s+pr[eé]via|denunci/i],
  ['renovacao', /renova[cç][aã]o|renovad[oa]|prorroga/i],
  ['reajuste', /reajust|igp-?m|ipca|inpc|corre[cç][aã]o\s+monet/i],
  ['fim', /vig[eê]ncia|vigorar|t[eé]rmino|termina|encerra|validade|vencimento\s+do\s+contrato|at[eé]\s+o\s+dia/i],
  ['pagamento', /pagamento|parcela|mensalidade|fatura|boleto|vencimento/i],
  ['assinatura', /assinatura|assinad[oa]|firmad[oa]|celebrad[oa]/i],
];

/** datas por contrato além das quais a leitura para (e a rotina diz que parou) */
export const OBRIG_MAX = 1000;
const addMonths = (iso: string, m: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Datas do contrato com o tipo (pelas palavras em volta) e as derivadas: fim pela duração, prazo do aviso prévio. */
export function obrigacoesOf(contrato: string, prefix: string, text: string): Obrigacao[] {
  const out: Obrigacao[] = []; const t = text.replace(/\s+/g, ' ');
  const found: Array<{ at: number; iso: string }> = [];
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) { const iso = parseDate(m[0]); if (typeof iso === 'string') found.push({ at: m.index!, iso }); }
  for (const m of t.matchAll(/\b(\d{1,2})º?\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/gi)) {
    const mo = MESES.indexOf(m[2].toLowerCase().replace('marco', 'março')) + 1; const iso = parseDate(`${m[1]}/${mo}/${m[3]}`);
    if (typeof iso === 'string') found.push({ at: m.index!, iso });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  for (const f of found) {
    // o tipo vem da frase da data (não das vizinhas): do último ponto/ponto e vírgula antes dela até o próximo
    const from = Math.max(t.lastIndexOf('. ', f.at), t.lastIndexOf('; ', f.at), f.at - 220) + 1;
    const next = t.slice(f.at).search(/\.\s|;\s|$/);
    const ctx = t.slice(Math.max(0, from), f.at + Math.min(next < 0 ? 60 : next, 160));
    const tipo = KIND.find(([, re]) => re.test(ctx))?.[0] ?? 'outra';
    const k = `${tipo}|${f.iso}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ code: '', contrato, tipo, data: f.iso, trecho: cut(t.slice(Math.max(0, f.at - 110), f.at + 50), 170) });
  }
  // duração ("prazo de 12 (doze) meses a contar da assinatura"): fim = assinatura + duração
  const dur = t.match(/prazo\s+de\s+(?:vig[eê]ncia\s+(?:de\s+)?)?(\d{1,3})\s*(?:\([^)]*\)\s*)?(meses|m[eê]s|anos?)/i);
  const sign = out.find((o) => o.tipo === 'assinatura') ?? out[0];
  if (dur && sign && !out.some((o) => o.tipo === 'fim')) {
    const n = Number(dur[1]) * (/ano/i.test(dur[2]) ? 12 : 1);
    out.push({ code: '', contrato, tipo: 'fim', data: addMonths(sign.data, n), trecho: cut(dur[0], 120), derivada: `${dur[1]} ${dur[2]} a partir de ${brd(sign.data)}` });
  }
  // aviso prévio ("com antecedência mínima de 30 dias"): o último dia para avisar = fim − N dias
  const av = t.match(/(?:aviso\s+pr[eé]vio|anteced[eê]ncia(?:\s+m[ií]nima)?|notifica[cç][aã]o\s+pr[eé]via)\s+de\s+(\d{1,3})\s*(?:\([^)]*\)\s*)?dias/i);
  const end = [...out].reverse().find((o) => o.tipo === 'fim' || o.tipo === 'renovacao');
  if (av && end) out.push({ code: '', contrato, tipo: 'aviso', data: addDays(end.data, -Number(av[1])), trecho: cut(av[0], 120), derivada: `${av[1]} dias antes de ${brd(end.data)} (${TIPO_LABEL[end.tipo]})` });
  if (/renova[cç][aã]o\s+autom[aá]tica|renovad[oa]\s+automaticamente|prorrogad[oa]\s+automaticamente/i.test(t) && end) {
    out.push({ code: '', contrato, tipo: 'renovacao', data: end.data, trecho: 'renovação automática prevista no contrato', derivada: 'renova sozinho se ninguém avisar' });
  }
  out.sort((a, b) => a.data.localeCompare(b.data));
  // teto de segurança alto (antes, 40: num contrato longo, as datas futuras eram as cortadas, caladas)
  return out.filter((o, i, all) => all.findIndex((x) => x.tipo === o.tipo && x.data === o.data) === i).slice(0, OBRIG_MAX).map((o, i) => ({ ...o, code: `${prefix}.${i + 1}` }));
}

export const obrigacaoLine = (o: Obrigacao, today: string) => {
  const d = Math.round((Date.parse(`${o.data}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const when = d < 0 ? `passou há ${-d} dia(s)` : d === 0 ? 'HOJE' : `em ${d} dia(s)`;
  return `${o.code} · ${o.contrato} · ${TIPO_LABEL[o.tipo]}: ${brd(o.data)} (${when})${o.derivada ? ` · calculado: ${o.derivada}` : ''} · trecho: "${o.trecho}"`;
};

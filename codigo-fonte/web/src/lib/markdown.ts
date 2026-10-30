/**
 * Formatação do texto dos colegas (o que os modelos escrevem em Markdown): títulos, negrito, itálico, listas,
 * tabelas, citações, blocos de código e links. Vira uma árvore simples que a tela desenha com elementos do React —
 * nada de HTML cru (o texto nunca vira código na página). Aguenta texto pela metade (a resposta chegando ao vivo):
 * um ``` ainda aberto vira bloco de código até o fim, um ** sem par fica como texto.
 */

export type Inline =
  | { t: 'text'; v: string } | { t: 'br' }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'img'; id: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][]; start: number }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'center' | 'right' | null> }
  | { t: 'hr' };

const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1-2 código
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 3 negrito
  /__(?=\S)([\s\S]*?\S)__/.source, // 4 negrito
  /~~(?=\S)([\s\S]*?\S)~~/.source, // 5 riscado
  /\*(?=[^\s*])([^*]*?[^\s*])\*/.source, // 6 itálico
  /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/u.source, // 7 itálico
  /\[imagem: (art_[a-f0-9]{32})\]/.source, // 8 imagem guardada em Documentos
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.source, // 9-10 link
  /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"”’])/.source, // 11 endereço solto
].join('|'), 'gu');

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => { if (!v) return; const last = out[out.length - 1]; if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    text(src.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'b', c: parseInline(m[3] ?? m[4]) });
    else if (m[5] !== undefined) out.push({ t: 's', c: parseInline(m[5]) });
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: 'i', c: parseInline(m[6] ?? m[7]) });
    else if (m[8] !== undefined) out.push({ t: 'img', id: m[8] });
    else if (m[9] !== undefined) out.push({ t: 'a', href: m[10], c: parseInline(m[9]) });
    else if (m[11] !== undefined) out.push({ t: 'a', href: m[11], c: [{ t: 'text', v: m[11] }] });
  }
  text(src.slice(at));
  return out;
}

/** linhas de um parágrafo: a quebra de linha que a pessoa vê no texto continua quebra */
function lines(ls: string[]): Inline[] {
  const out: Inline[] = [];
  ls.forEach((l, i) => { if (i) out.push({ t: 'br' }); out.push(...parseInline(l)); });
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+•]|(\d{1,9})[.)])\s+(.*)$/;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const startsBlock = (l: string, next?: string) => FENCE.test(l) || HEAD.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || (l.includes('|') && !!next && SEP.test(next));

export function parseMarkdown(src: string): Block[] {
  const ls = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < ls.length && !new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`).test(ls[i])) body.push(ls[i++]);
      i++; // a cerca de fecho (ou o fim, se o texto ainda está chegando)
      out.push({ t: 'code', lang: fence[2], v: body.join('\n') });
      continue;
    }
    const head = l.match(HEAD);
    if (head) { out.push({ t: 'h', level: Math.min(3, head[1].length) as 1 | 2 | 3, c: parseInline(head[2]) }); i++; continue; }
    if (HR.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (l.includes('|') && i + 1 < ls.length && SEP.test(ls[i + 1])) {
      const head = cells(l);
      const align = cells(ls[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < ls.length && ls[i].includes('|') && ls[i].trim()) {
        const r = cells(ls[i++]);
        rows.push(head.map((_, k) => parseInline(r[k] ?? '')));
      }
      out.push({ t: 'table', head: head.map((c) => parseInline(c)), rows, align: head.map((_, k) => align[k] ?? null) });
      continue;
    }
    if (QUOTE.test(l)) {
      const body: string[] = [];
      while (i < ls.length && QUOTE.test(ls[i])) body.push(ls[i++].match(QUOTE)![1]);
      out.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    const item = l.match(ITEM);
    if (item) {
      const ordered = item[3] !== undefined;
      const start = ordered ? Number(item[3]) : 1;
      const items: string[][] = [];
      while (i < ls.length) {
        const m = ls[i].match(ITEM);
        if (m && (m[3] !== undefined) === ordered) { items.push([m[4]]); i++; continue; }
        if (m) { items.push([m[4]]); i++; continue; } // lista dentro de lista: vira item (simples de ler)
        // continuação do item (linha recuada, sem marcador)
        if (ls[i].trim() && /^\s{2,}/.test(ls[i]) && items.length) { items[items.length - 1].push(ls[i].trim()); i++; continue; }
        break;
      }
      const parsed = items.map((x) => lines(x));
      out.push(ordered ? { t: 'ol', items: parsed, start } : { t: 'ul', items: parsed });
      continue;
    }
    const para: string[] = [];
    while (i < ls.length && ls[i].trim() && !(para.length && startsBlock(ls[i], ls[i + 1]))) para.push(ls[i++]);
    out.push({ t: 'p', c: lines(para) });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Documento para baixar (abre no Word e no LibreOffice, com a formatação): HTML montado da árvore, com todo texto
 * escapado. Só para o arquivo baixado, nunca para a página.
 */
export function toWordHtml(src: string, title: string): string {
  const inl = (c: Inline[]): string => c.map((x) => {
    switch (x.t) {
      case 'text': return esc(x.v);
      case 'br': return '<br>';
      case 'b': return `<b>${inl(x.c)}</b>`;
      case 'i': return `<i>${inl(x.c)}</i>`;
      case 's': return `<s>${inl(x.c)}</s>`;
      case 'code': return `<code>${esc(x.v)}</code>`;
      case 'a': return `<a href="${esc(x.href)}">${inl(x.c)}</a>`;
      case 'img': return '[imagem]';
    }
  }).join('');
  const blk = (b: Block): string => {
    switch (b.t) {
      case 'p': return `<p>${inl(b.c)}</p>`;
      case 'h': return `<h${b.level}>${inl(b.c)}</h${b.level}>`;
      case 'ul': return `<ul>${b.items.map((x) => `<li>${inl(x)}</li>`).join('')}</ul>`;
      case 'ol': return `<ol start="${b.start}">${b.items.map((x) => `<li>${inl(x)}</li>`).join('')}</ol>`;
      case 'code': return `<pre>${esc(b.v)}</pre>`;
      case 'quote': return `<blockquote>${b.c.map(blk).join('')}</blockquote>`;
      case 'hr': return '<hr>';
      case 'table': return `<table border="1" cellspacing="0" cellpadding="4"><tr>${b.head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    }
  };
  return `<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}table{border-collapse:collapse}</style></head><body>${parseMarkdown(src).map(blk).join('\n')}</body></html>`;
}

/** Texto puro (para copiar sem os símbolos, contar, prévia). */
export function plainText(src: string): string {
  const inl = (c: Inline[]): string => c.map((x) => (x.t === 'text' ? x.v : x.t === 'br' ? '\n' : x.t === 'code' ? x.v : x.t === 'img' ? '[imagem]' : inl(x.c))).join('');
  return parseMarkdown(src).map((b) => {
    switch (b.t) {
      case 'p': case 'h': return inl(b.c);
      case 'ul': return b.items.map((x) => `• ${inl(x)}`).join('\n');
      case 'ol': return b.items.map((x, k) => `${b.start + k}. ${inl(x)}`).join('\n');
      case 'code': return b.v;
      case 'quote': return b.c.map((x) => (x.t === 'p' ? inl(x.c) : '')).join('\n');
      case 'table': return [b.head.map(inl).join('\t'), ...b.rows.map((r) => r.map(inl).join('\t'))].join('\n');
      case 'hr': return '—';
    }
  }).join('\n\n');
}

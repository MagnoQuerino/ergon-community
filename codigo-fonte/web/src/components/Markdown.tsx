import { Fragment, useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown.ts';

/** Inline → elementos (o texto sempre como texto: o React escapa). */
function inl(c: Inline[], key = ''): ReactNode[] {
  return c.map((x, i) => {
    const k = `${key}${i}`;
    switch (x.t) {
      case 'text': return <Fragment key={k}>{x.v}</Fragment>;
      case 'br': return <br key={k} />;
      case 'b': return <strong key={k}>{inl(x.c, k)}</strong>;
      case 'i': return <em key={k}>{inl(x.c, k)}</em>;
      case 's': return <s key={k}>{inl(x.c, k)}</s>;
      case 'code': return <code key={k}>{x.v}</code>;
      case 'a': return <a key={k} href={x.href} target="_blank" rel="noreferrer noopener">{inl(x.c, k)}</a>;
      case 'img': return (
        <a key={k} className="msg__img" href={`/api/artifacts/${x.id}/download?inline=1`} target="_blank" rel="noreferrer" title="Abrir a imagem (também em Documentos)">
          <img src={`/api/artifacts/${x.id}/download?inline=1`} alt="Imagem gerada pelo agente" loading="lazy" />
        </a>
      );
    }
  });
}

function block(b: Block, k: string): ReactNode {
  switch (b.t) {
    case 'p': return <p key={k}>{inl(b.c, k)}</p>;
    case 'h': { const H = (`h${b.level + 2}`) as 'h3' | 'h4' | 'h5'; return <H key={k}>{inl(b.c, k)}</H>; }
    case 'ul': return <ul key={k}>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}</li>)}</ul>;
    case 'ol': return <ol key={k} start={b.start}>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}</li>)}</ol>;
    case 'code': return <pre key={k} className="md__code"><code>{b.v}</code></pre>;
    case 'quote': return <blockquote key={k}>{b.c.map((x, i) => block(x, `${k}.${i}`))}</blockquote>;
    case 'hr': return <hr key={k} />;
    case 'table': return (
      <div key={k} className="md__table">
        <table>
          <thead><tr>{b.head.map((c, i) => <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>{inl(c, `${k}h${i}`)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, i) => <td key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>{inl(c, `${k}r${j}.${i}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

/** Texto dos colegas formatado (Markdown seguro, sem HTML). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md ${className ?? ''}`}>{blocks.map((b, i) => block(b, String(i)))}</div>;
}

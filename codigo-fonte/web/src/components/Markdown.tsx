import { Fragment, useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown.ts';
import { t, useIdioma } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { blocoVisual } from '../lib/documento.ts';
import '../visuais/registro.ts';

/** Inline → elementos (o texto sempre como texto: o React escapa). */
export function inl(c: Inline[], key = ''): ReactNode[] {
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
        <a key={k} className="msg__img" href={`/api/artifacts/${x.id}/download?inline=1`} target="_blank" rel="noreferrer" title={t('geral.arquivo.abrirImagem')}>
          <img src={`/api/artifacts/${x.id}/download?inline=1`} alt={x.alt || t('geral.arquivo.imagemDoAgente')} loading="lazy" />
        </a>
      );
      // arquivo de Documentos citado pelo agente (no lugar do caminho dentro do motor): baixa pelo Ergon
      case 'doc': return (
        <a key={k} className="msg__doc" href={`/api/artifacts/${x.id}/download`} title={t('geral.arquivo.abrirDocumento', { nome: x.nome })}>
          <Icon name="file" size={12} /> {x.nome}
        </a>
      );
    }
  });
}

function block(b: Block, k: string, aoVivo = false): ReactNode {
  switch (b.t) {
    case 'p': return <p key={k}>{inl(b.c, k)}</p>;
    case 'h': { const H = (`h${Math.min(3, b.level) + 2}`) as 'h3' | 'h4' | 'h5'; return <H key={k}>{inl(b.c, k)}</H>; }
    case 'ul': return <ul key={k}>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}{b.subs?.[i]?.map((y, j) => block(y, `${k}.${i}.${j}`))}</li>)}</ul>;
    case 'ol': return <ol key={k} start={b.start}>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}{b.subs?.[i]?.map((y, j) => block(y, `${k}.${i}.${j}`))}</li>)}</ol>;
    // bloco visual (```ergon-<tipo>): o desenho de quem registrou o tipo (lib/documento.ts, registrarBlocoVisual; os
    // blocos do agente em visuais/registro.ts). Chegando ao vivo, o esqueleto até a cerca fechar.
    case 'code': {
      const v = blocoVisual(b.lang);
      if (v) return <v.Componente key={k} tipo={v.tipo} conteudo={b.v} aoVivo={aoVivo} />;
      return <pre key={k} className="md__code"><code>{b.v}</code></pre>;
    }
    case 'quote': return <blockquote key={k}>{b.c.map((x, i) => block(x, `${k}.${i}`, aoVivo))}</blockquote>;
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
export function Markdown({ text, className, aoVivo = false }: { text: string; className?: string; aoVivo?: boolean }) {
  useIdioma(); // a dica e o texto alternativo da imagem trocam de idioma junto com a tela
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md ${className ?? ''}`}>{blocks.map((b, i) => block(b, String(i), aoVivo && i === blocks.length - 1))}</div>;
}

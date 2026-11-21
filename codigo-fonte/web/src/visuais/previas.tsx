// As pré-visualizações: pessoa ou contato, galeria, link (título, descrição e imagem buscados pelo servidor), arquivo dos
// Documentos (a primeira página do PDF, as primeiras linhas da planilha, o começo do documento, o código com realce),
// endereço e os chips das referências (o formato dos modelos de entrega).
import { useState } from 'react';
import type { BlocoDe, Referencia } from '../../../shared/visuais/esquema.ts';
import { useT, fmtBytes } from '../i18n/index.ts';
import { useResource } from '../lib/live.ts';
import { Icon } from '../components/Icon.tsx';
import { destinoDe } from './Visual.tsx';
import { realcar } from './realce.ts';
import { srcDe } from './blocos.tsx';

const iniciais = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export function Pessoa({ b }: { b: BlocoDe<'pessoa'> }) {
  const t = useT();
  return (
    <div className="vis-pessoa">
      {b.foto ? <img className="vis-pessoa__f" src={srcDe(b.foto.src)} alt={b.foto.alt} loading="lazy" /> : <span className="vis-pessoa__f vis-pessoa__f--ini" aria-hidden="true">{iniciais(b.nome)}</span>}
      <div className="vis-pessoa__c">
        <p className="vis-pessoa__n">{b.nome}</p>
        {(b.cargo || b.empresa) && <p className="vis-pessoa__cargo">{[b.cargo, b.empresa].filter(Boolean).join(' · ')}</p>}
        <p className="vis-pessoa__contatos">
          {b.email && <a href={`mailto:${b.email}`} title={t('visuais.pessoa.email')}><Icon name="send" size={12} /> {b.email}</a>}
          {b.telefone && <a href={`tel:${b.telefone.replace(/[^\d+]/g, '')}`} title={t('visuais.pessoa.telefone')}><Icon name="chat" size={12} /> {b.telefone}</a>}
          {b.site && <a href={b.site} target="_blank" rel="noopener noreferrer" title={t('visuais.pessoa.site')}><Icon name="globe" size={12} /> {b.site.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>}
          {b.local && <span><Icon name="map" size={12} /> {b.local}</span>}
        </p>
        {!!b.tags?.length && <p className="vis-pessoa__tags">{b.tags.map((x, i) => <span key={i} className="vis-selo">{x}</span>)}</p>}
      </div>
    </div>
  );
}

export function Galeria({ b }: { b: BlocoDe<'galeria'> }) {
  const t = useT();
  const um = b.imagens.length === 1;
  return (
    <div className={`vis-galeria ${um ? 'is-uma' : ''}`}>
      {b.imagens.map((im, i) => (
        <a key={i} className="vis-galeria__i vis-in" href={srcDe(im.src)} target="_blank" rel="noopener noreferrer" title={t('visuais.galeria.abrir', { legenda: im.legenda ?? im.alt })} style={{ '--i': i } as React.CSSProperties}>
          <img src={srcDe(im.src)} alt={im.alt} loading="lazy" />
          {im.legenda && <span className="vis-galeria__l">{im.legenda}</span>}
        </a>
      ))}
    </div>
  );
}

interface Meta { titulo?: string; descricao?: string; imagem?: string | null; site?: string; erro?: string }
export function LinkPrevia({ b }: { b: BlocoDe<'link'> }) {
  const t = useT();
  const m = useResource<Meta>(`/api/visuais/link?url=${encodeURIComponent(b.url)}`, []);
  const host = (() => { try { return new URL(b.url).hostname.replace(/^www\./, ''); } catch { return b.url; } })();
  const titulo = b.titulo ?? m.data?.titulo ?? host;
  const desc = b.descricao ?? m.data?.descricao;
  const imagem = b.imagem ?? m.data?.imagem ?? null;
  const [semImagem, setSemImagem] = useState(false);
  return (
    <a className={`vis-link ${m.loading && !m.data ? 'is-carregando' : ''}`} href={b.url} target="_blank" rel="noopener noreferrer" aria-label={t('visuais.link.abrir', { site: m.data?.site ?? host })}>
      {imagem && !semImagem && <img className="vis-link__img" src={srcDe(imagem)} alt="" loading="lazy" onError={() => setSemImagem(true)} />}
      <span className="vis-link__c">
        <span className="vis-link__site"><Icon name="globe" size={12} /> {m.data?.site || host}</span>
        <span className="vis-link__t">{titulo}</span>
        {desc && <span className="vis-link__d">{desc}</span>}
      </span>
    </a>
  );
}

interface PreviaArquivo { id: string; nome: string; mime: string; tamanho: number; tipo: 'pdf' | 'planilha' | 'documento' | 'markdown' | 'codigo' | 'imagem' | 'outro'; texto?: string; paginas?: number | null; linhas?: string[][]; abas?: number; nomeAba?: string; linguagem?: string }
const ICONE_ARQ = { pdf: 'file', planilha: 'grid', documento: 'file', markdown: 'file', codigo: 'code', imagem: 'image', outro: 'file' } as const;
export function Arquivo({ b }: { b: BlocoDe<'arquivo'> }) {
  const t = useT();
  const p = useResource<PreviaArquivo>(`/api/visuais/arquivo/${encodeURIComponent(b.id)}`, ['artifacts.changed']);
  const url = `/api/artifacts/${encodeURIComponent(b.id)}/download`;
  if (p.error) return <p className="vis-arq vis-arq--erro"><Icon name="file" size={14} /> {t('visuais.arquivo.indisponivel')}</p>;
  const a = p.data;
  return (
    <div className={`vis-arq ${a ? `is-${a.tipo}` : 'is-carregando'}`}>
      <div className="vis-arq__previa" aria-hidden={!a}>
        {a?.tipo === 'imagem' && <img src={`${url}?inline=1`} alt={a.nome} loading="lazy" />}
        {a?.tipo === 'pdf' && <div className="vis-arq__folha"><p>{a.texto || '…'}</p></div>}
        {(a?.tipo === 'documento' || a?.tipo === 'markdown') && <div className="vis-arq__folha vis-arq__folha--doc"><p>{a.texto}</p></div>}
        {a?.tipo === 'codigo' && <pre className="vis-arq__codigo"><code>{realcar(a.texto ?? '', a.linguagem ?? 'ts').map((x, i) => (x.c ? <span key={i} className={`tk-${x.c}`}>{x.t}</span> : x.t))}</code></pre>}
        {a?.tipo === 'planilha' && (
          <div className="vis-arq__planilha"><table><tbody>{(a.linhas ?? []).map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody></table></div>
        )}
        {a?.tipo === 'outro' && <span className="vis-arq__icone"><Icon name="file" size={28} /></span>}
      </div>
      <div className="vis-arq__pe">
        <Icon name={a ? ICONE_ARQ[a.tipo] : 'file'} size={14} />
        <span className="vis-arq__n">{b.titulo ?? a?.nome ?? '…'}</span>
        {a && <span className="vis-arq__m">{[a.paginas ? t('visuais.arquivo.paginas', { n: a.paginas }) : null, a.abas ? t('visuais.arquivo.abas', { n: a.abas }) : null, fmtBytes(a.tamanho)].filter(Boolean).join(' · ')}</span>}
        <a className="btn btn--sm" href={a?.tipo === 'pdf' || a?.tipo === 'imagem' ? `${url}?inline=1` : url} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={13} /> {t('visuais.arquivo.abrir')}</a>
      </div>
    </div>
  );
}

export function Mapa({ b }: { b: BlocoDe<'mapa'> }) {
  const t = useT();
  const q = b.lat !== undefined && b.lng !== undefined ? `${b.lat},${b.lng}` : b.endereco;
  const href = b.lat !== undefined && b.lng !== undefined ? `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}` : `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`;
  return (
    <div className="vis-mapa">
      <span className="vis-mapa__pino" aria-hidden="true"><Icon name="map" size={18} /></span>
      <div className="vis-mapa__c"><p className="vis-mapa__e">{b.endereco}</p>{b.lat !== undefined && <p className="vis-mapa__g">{b.lat.toFixed(5)}, {b.lng?.toFixed(5)}</p>}</div>
      <a className="btn btn--sm" href={href} target="_blank" rel="noopener noreferrer"><Icon name="compass" size={13} /> {t('visuais.mapa.abrir')}</a>
    </div>
  );
}

const ICONE_REF: Record<string, string> = { email: 'send', documento: 'file', arquivo: 'file', evento: 'clock', tarefa: 'tasks', pr: 'code', issue: 'code', mensagem: 'chat', conversa: 'chat', card: 'flag', pagina: 'globe' };
/** Os chips do que foi citado (o mesmo jeito dos modelos de entrega): um clique abre o e-mail, o documento, o card. */
export function RefChips({ refs }: { refs: Referencia[] }) {
  const t = useT();
  return (
    <span className="vis-refs ent-refs">
      {refs.map((r, i) => {
        const d = destinoDe(r); const rotulo = t('visuais.referencias.abrir', { titulo: r.titulo });
        const corpo = <><Icon name={ICONE_REF[r.tipo] ?? 'globe'} size={12} /><span className="ent-ref__t">{r.titulo}</span></>;
        if (d.abrir) return <button key={i} type="button" className="chip ent-ref" title={rotulo} aria-label={rotulo} onClick={d.abrir}>{corpo}</button>;
        return d.href ? <a key={i} className="chip ent-ref" href={d.href} title={rotulo} aria-label={rotulo} {...(d.href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{corpo}</a>
          : <span key={i} className="chip ent-ref">{corpo}</span>;
      })}
    </span>
  );
}
export const Referencias = ({ b }: { b: BlocoDe<'referencias'> }) => <RefChips refs={b.itens} />;

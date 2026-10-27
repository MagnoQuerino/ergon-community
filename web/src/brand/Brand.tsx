import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { EMBLEM_VIEWBOX, emblemMarkup, logoSvg, palette, splashHtml, type LockupKind } from './logo.ts';

// Desenho e animação vêm de logo.ts e brand.css (embutido no index.html); aqui só os invólucros para o React.
// O conteúdo vem de geometria fixa (nenhum texto de usuário), por isso o innerHTML.

/** Onda proporcional ao tamanho: num ícone pequeno o movimento precisa ser maior para aparecer. */
const amp = (size: number) => (size >= 64 ? 26 : Math.min(70, Math.round((26 * 64) / size)));

/** Emblema (cinco pessoas em volta do centro dourado). `animated`: em movimento; `loopOnly`: sem a entrada. */
export function ErgonMark({ size = 24, onDark, mono, animated, loopOnly, title, className }: {
  size?: number; onDark?: boolean; mono?: string; animated?: boolean; loopOnly?: boolean; title?: string; className?: string;
}) {
  const html = useMemo(() => emblemMarkup(palette({ onDark, mono })), [onDark, mono]);
  const cls = ['eg-mark', animated && 'eg-anim', animated && loopOnly && 'eg-anim--loop', className].filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox={EMBLEM_VIEWBOX} width={size} height={size} style={{ '--amp': amp(size) } as CSSProperties}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** Marca completa: horizontal (topo, cartões) ou empilhada. `animated`: o emblema faz a onda (trabalhando). */
export function ErgonLogo({ kind = 'horizontal', height = 28, onDark, mono, animated, className }: {
  kind?: LockupKind; height?: number; onDark?: boolean; mono?: string; animated?: boolean; className?: string;
}) {
  const html = useMemo(() => logoSvg({ kind, onDark, mono, className: animated ? 'eg-anim eg-anim--loop' : undefined }), [kind, onDark, mono, animated]);
  return <span className={`brand-logo ${className ?? ''}`} style={{ height }} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Tela de carregamento inteira. É a mesma que o index.html mostra antes do app carregar: continua a animação de
 * onde ela estava (--t0 = tempo desde que a página abriu), então a troca não se nota.
 */
export function Splash({ label }: { label?: string }) {
  const [t0] = useState(() => `${Math.round(performance.now())}ms`);
  const html = useMemo(() => splashHtml(label), [label]);
  return <div style={{ '--t0': t0 } as CSSProperties} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Carregando dentro de uma área (cidade, painel): emblema em movimento com legenda. */
export function ErgonLoader({ size = 72, onDark, label }: { size?: number; onDark?: boolean; label?: string }) {
  return (
    <div className="eg-loader" role="status" aria-live="polite">
      <ErgonMark size={size} onDark={onDark} animated />
      {label && <span className="eg-loader__label">{label}</span>}
    </div>
  );
}

/**
 * Espera com bom humor: o emblema em movimento e frases que se revezam ("Consultando o oráculo de Delfos…").
 * As frases vêm embaralhadas a cada vez; quem pede menos movimento continua lendo as frases, só sem a animação.
 */
export function PhraseLoader({ phrases, size = 96, every = 2600, onDark }: { phrases: string[]; size?: number; every?: number; onDark?: boolean }) {
  const order = useMemo(() => [...phrases].sort(() => Math.random() - 0.5), [phrases]);
  const [i, setI] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setI((x) => x + 1), every); return () => clearInterval(t); }, [every]);
  return (
    <div className="eg-loader eg-phrases" role="status" aria-live="polite">
      <ErgonMark size={size} onDark={onDark} animated />
      <span key={i} className="eg-phrases__txt">{order[i % order.length]}</span>
    </div>
  );
}

/** "Carregando…" numa linha: o emblema pequeno fazendo a onda ao lado do texto (ou o erro, se houver). */
export function Loading({ error, label = 'Carregando…' }: { error?: string | null; label?: string }) {
  if (error) return <p className="muted">{error}</p>;
  return <p className="muted eg-inline" role="status"><ErgonMark size={18} animated loopOnly /> {label}</p>;
}

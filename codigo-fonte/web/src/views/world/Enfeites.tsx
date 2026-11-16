// Os enfeites do World (a página do Ergon World e a Governança): os personagens em pixel art e o céu estrelado.
import { useMemo } from 'react';
import { figura, type Imagem, type Personagem } from './arte.ts';
import type { Gesture } from '../../iso/figures.ts';

/** Um personagem da equipe, em pixel art (enfeite: sem texto alternativo). */
export function Fig({ k, gesture = 'none', scale = 3, className = '', facing = 'front' }: { k: Personagem; gesture?: Gesture; scale?: number; className?: string; facing?: 'front' | 'back' }) {
  const img = useMemo<Imagem | null>(() => figura(k, gesture, facing, scale), [k, gesture, facing, scale]);
  if (!img) return null;
  return <img className={`mundo-fig ${className}`} src={img.url} width={img.w / 2} height={img.h / 2} alt="" draggable={false} />;
}

/** Estrelas espalhadas (posições fixas, sorteadas por uma semente: a mesma tela a cada visita). */
export function Estrelas({ n }: { n: number }) {
  const pontos = useMemo(() => {
    let x = 7 * n + 3; const r = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    return Array.from({ length: n }, (_, i) => ({ l: r() * 100, t: r() * 92, s: r() < 0.18 ? 3 : r() < 0.5 ? 2 : 1, d: (r() * 4).toFixed(2), i }));
  }, [n]);
  return (
    <div className="mundo-estrelas" aria-hidden="true">
      {pontos.map((p) => <i key={p.i} className={`mundo-estrela mundo-estrela--${p.s}`} style={{ left: `${p.l}%`, top: `${p.t}%`, animationDelay: `${p.d}s` }} />)}
    </div>
  );
}

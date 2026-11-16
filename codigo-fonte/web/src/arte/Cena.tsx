/**
 * Peças da arte do Ergon para as telas (o mesmo estilo da página do Ergon World): a equipe grega em pixel art, o céu
 * com estrelas e nuvens, o barco voador e a banca da Loja. Tudo é enfeite (aria-hidden, sem texto), em SVG inline ou
 * nas figuras pequenas de arte/figuras.ts; sem movimento pedido pelo sistema, tudo fica parado (styles.css).
 */
import { useMemo } from 'react';
import type { Facing, Gesture } from '../iso/figures.ts';
import { figura, type Imagem, type Personagem } from './figuras.ts';

/** Um personagem da equipe, em pixel art (enfeite: sem texto alternativo). */
export function Fig({ k, gesture = 'none', scale = 3, className = '', facing = 'front' }: { k: Personagem; gesture?: Gesture; scale?: number; className?: string; facing?: Facing }) {
  const img = useMemo<Imagem | null>(() => figura(k, gesture, facing, scale), [k, gesture, facing, scale]);
  if (!img) return null;
  return <img className={`cena-fig ${className}`} src={img.url} width={img.w / 2} height={img.h / 2} alt="" draggable={false} />;
}

/** Estrelas espalhadas (posições fixas, sorteadas por uma semente: a mesma tela a cada visita). */
export function Estrelas({ n, semente = 0 }: { n: number; semente?: number }) {
  const pontos = useMemo(() => {
    let x = 7 * n + 3 + semente * 131; const r = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    return Array.from({ length: n }, (_, i) => ({ l: r() * 100, t: r() * 92, s: r() < 0.18 ? 3 : r() < 0.5 ? 2 : 1, d: (r() * 4).toFixed(2), i }));
  }, [n, semente]);
  return (
    <div className="cena-estrelas" aria-hidden="true">
      {pontos.map((p) => <i key={p.i} className={`cena-estrela cena-estrela--${p.s}`} style={{ left: `${p.l}%`, top: `${p.t}%`, animationDelay: `${p.d}s` }} />)}
    </div>
  );
}

/** Uma nuvem (o mesmo desenho do Ergon World). */
export function Nuvem({ className = '' }: { className?: string }) {
  return <svg className={`cena-nuvem ${className}`} viewBox="0 0 120 40" aria-hidden="true"><path d="M10 34h96a14 14 0 0 0-8-26 18 18 0 0 0-33-4A15 15 0 0 0 40 14a12 12 0 0 0-30 20z" /></svg>;
}

/** O barco voador, pequeno (o trabalho que vai e volta da nuvem), com quem vai a bordo. */
export function Barco({ className = '', tripulacao = [] as Personagem[] }: { className?: string; tripulacao?: Personagem[] }) {
  return (
    <div className={`cena-barco ${className}`} aria-hidden="true">
      {tripulacao.length > 0 && <div className="cena-barco__tripulacao">{tripulacao.map((k, i) => <Fig key={k} k={k} gesture={i % 2 ? 'joy' : 'point'} scale={2} />)}</div>}
      <svg className="cena-barco__casco" viewBox="0 0 240 120">
        <path className="cena-barco__vela" d="M120 4 L120 70 L178 70z" />
        <path className="cena-barco__vela cena-barco__vela--2" d="M114 14 L114 70 L74 70z" />
        <rect className="cena-barco__mastro" x="115" y="0" width="5" height="86" />
        <path className="cena-barco__madeira" d="M8 78 L232 78 L206 112 L36 112z" />
        <path className="cena-barco__faixa" d="M14 86 L226 86 L222 92 L18 92z" />
        <path className="cena-barco__asa" d="M40 92 Q-6 70 -2 106 Q20 98 40 104z" />
        <path className="cena-barco__asa" d="M200 92 Q246 70 242 106 Q220 98 200 104z" />
      </svg>
    </div>
  );
}

/**
 * A banca da Loja na ágora: toldo listrado, prateleira com o que a comunidade fez (rolos, paleta, caixas) e a equipe
 * trocando o que fez, de graça. O barco passa ao fundo trazendo mais.
 */
export function BancaLoja() {
  return (
    <div className="cena-banca" aria-hidden="true">
      <div className="cena-banca__lua" />
      <Nuvem className="cena-nuvem--a" />
      <Nuvem className="cena-nuvem--b" />
      <Barco className="cena-banca__barco" />
      <svg className="cena-banca__barraca" viewBox="0 0 320 210">
        <rect className="cena-banca__poste" x="22" y="44" width="8" height="160" rx="2" />
        <rect className="cena-banca__poste" x="290" y="44" width="8" height="160" rx="2" />
        <path className="cena-banca__toldo" d="M8 46 L312 46 L300 18 L20 18z" />
        <path className="cena-banca__listra" d="M58 46 L66 18 L96 18 L94 46z M146 46 L148 18 L178 18 L182 46z M234 46 L232 18 L262 18 L270 46z" />
        <path className="cena-banca__franja" d="M8 46 q19 18 38 0 q19 18 38 0 q19 18 38 0 q19 18 38 0 q19 18 38 0 q19 18 38 0 q19 18 38 0 q19 18 38 0z" />
        <rect className="cena-banca__balcao" x="14" y="150" width="292" height="16" rx="3" />
        <rect className="cena-banca__frente" x="24" y="166" width="272" height="40" rx="2" />
        {/* o que está à venda... de graça: rolos (competências), a paleta (temas), caixas (pacotes) e um vaso (equipes) */}
        <rect className="cena-banca__rolo" x="40" y="128" width="40" height="18" rx="9" />
        <rect className="cena-banca__rolo cena-banca__rolo--2" x="50" y="112" width="34" height="16" rx="8" />
        <ellipse className="cena-banca__paleta" cx="136" cy="138" rx="26" ry="14" />
        <circle className="cena-banca__tinta cena-banca__tinta--1" cx="124" cy="134" r="4" />
        <circle className="cena-banca__tinta cena-banca__tinta--2" cx="136" cy="131" r="4" />
        <circle className="cena-banca__tinta cena-banca__tinta--3" cx="148" cy="135" r="4" />
        <rect className="cena-banca__caixa" x="186" y="118" width="34" height="30" rx="3" />
        <rect className="cena-banca__caixa cena-banca__caixa--2" x="222" y="126" width="26" height="22" rx="3" />
        <path className="cena-banca__vaso" d="M262 148 q-12 -20 4 -34 h12 q16 14 4 34z" />
      </svg>
      <div className="cena-banca__equipe">
        <Fig k="fidias" gesture="offer" scale={3} />
        <Fig k="aspasia" gesture="talk" scale={3} />
        <Fig k="hipatia" gesture="joy" scale={3} />
      </div>
    </div>
  );
}

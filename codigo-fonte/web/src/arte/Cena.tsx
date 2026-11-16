/**
 * Peças da arte do Ergon para as telas (o mesmo estilo da página do Ergon World): a equipe grega em pixel art, o céu
 * com estrelas e nuvens, o barco voador e a banca da Loja. Tudo é enfeite (aria-hidden, sem texto), em SVG inline ou
 * nas figuras pequenas de arte/figuras.ts; sem movimento pedido pelo sistema, tudo fica parado (styles.css).
 */
import { useMemo, type ReactNode } from 'react';
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

/** Os temas dos cabeçalhos ilustrados: cada tela com a arte do que ela faz. */
export type TemaCena = 'equipe' | 'fluxos' | 'tarefas' | 'rotinas' | 'documentos' | 'atividade' | 'conexoes' | 'configuracoes' | 'ajuda';

/** Uma ilha pequena (chão com grama) para os bonecos ficarem de pé. */
function Ilha({ className = '' }: { className?: string }) {
  return (
    <svg className={`cena-ilha ${className}`} viewBox="0 0 120 34" aria-hidden="true">
      <path className="cena-ilha__grama" d="M0 6 Q60 -4 120 6 L120 12 Q60 4 0 12z" />
      <path className="cena-ilha__pedra" d="M2 10 Q60 2 118 10 Q110 22 86 28 Q60 36 34 28 Q10 22 2 10z" />
    </svg>
  );
}
/** Engrenagem simples (Configurações). */
function Engrenagem({ className = '' }: { className?: string }) {
  const dentes = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <svg className={`cena-engrenagem ${className}`} viewBox="-20 -20 40 40" aria-hidden="true">
      {dentes.map((a) => <rect key={a} x="-3" y="-19" width="6" height="8" rx="1.5" transform={`rotate(${a})`} />)}
      <circle r="13" /><circle className="cena-engrenagem__furo" r="5" />
    </svg>
  );
}

/**
 * A arte do cabeçalho de uma tela, no canto direito (some em tela estreita): um céu pequeno com estrelas e nuvens e a
 * cena da tela. Fica fora da área de trabalho; enfeite, sem texto.
 */
export function CenaCabecalho({ tema }: { tema: TemaCena }) {
  return (
    <div className={`cena-arte cena-arte--${tema}`} aria-hidden="true">
      <Estrelas n={14} semente={tema.length} />
      <Nuvem className="cena-arte__nuvem" />
      {tema === 'equipe' && (
        <>
          <Ilha className="cena-arte__chao" />
          <div className="cena-arte__fila"><Fig k="hipatia" gesture="talk" scale={2} /><Fig k="aristoteles" gesture="joy" scale={2} /><Fig k="arquimedes" gesture="point" scale={2} /><Fig k="aspasia" gesture="offer" scale={2} /></div>
        </>
      )}
      {tema === 'fluxos' && (
        <>
          <svg className="cena-arte__arco" viewBox="0 0 200 60"><path d="M30 50 Q100 -10 170 50" /></svg>
          <div className="cena-arte__rolo" />
          <Fig k="hesiodo" gesture="offer" scale={2} className="cena-arte__esq" />
          <Fig k="euclides" gesture="reach" scale={2} className="cena-arte__dir" />
        </>
      )}
      {tema === 'tarefas' && (
        <>
          <svg className="cena-arte__tabua" viewBox="0 0 60 70"><rect x="4" y="4" width="52" height="62" rx="5" /><path d="M14 22 l5 5 9-10 M14 40 l5 5 9-10" /><rect className="cena-arte__linha" x="32" y="21" width="16" height="3" rx="1.5" /><rect className="cena-arte__linha" x="32" y="39" width="16" height="3" rx="1.5" /><rect className="cena-arte__linha" x="14" y="55" width="34" height="3" rx="1.5" /></svg>
          <Fig k="euclides" gesture="point" scale={2} className="cena-arte__esq" />
        </>
      )}
      {tema === 'rotinas' && (
        <>
          <svg className="cena-arte__arco" viewBox="0 0 200 60"><path d="M20 58 Q100 -18 180 58" /></svg>
          <div className="cena-arte__sol" />
          <div className="cena-arte__lua" />
          <Fig k="hesiodo" gesture="think" scale={2} className="cena-arte__centro" />
        </>
      )}
      {tema === 'documentos' && (
        <>
          <svg className="cena-arte__estante" viewBox="0 0 120 70">
            <rect className="cena-arte__madeira" x="2" y="26" width="116" height="5" rx="2" /><rect className="cena-arte__madeira" x="2" y="60" width="116" height="5" rx="2" />
            {[8, 26, 44, 62, 80, 98].map((x, i) => <rect key={x} className={`cena-arte__pergaminho cena-arte__pergaminho--${i % 3}`} x={x} y="10" width="14" height="16" rx="7" />)}
            {[12, 34, 56, 78].map((x, i) => <rect key={x} className={`cena-arte__pergaminho cena-arte__pergaminho--${(i + 1) % 3}`} x={x} y="44" width="18" height="16" rx="8" />)}
          </svg>
          <Fig k="hipatia" gesture="reach" scale={2} className="cena-arte__dir" />
        </>
      )}
      {tema === 'atividade' && (
        <>
          <div className="cena-arte__facho" />
          <svg className="cena-arte__farol" viewBox="0 0 40 90"><rect className="cena-arte__torre" x="12" y="30" width="16" height="56" rx="2" /><rect className="cena-arte__torre" x="8" y="80" width="24" height="8" rx="2" /><circle className="cena-arte__luz" cx="20" cy="22" r="7" /><path className="cena-arte__teto" d="M11 16 L20 4 L29 16z" /></svg>
          <Fig k="aristoteles" gesture="think" scale={2} className="cena-arte__dir" />
        </>
      )}
      {tema === 'conexoes' && (
        <>
          <Ilha className="cena-arte__ilha-a" />
          <Ilha className="cena-arte__ilha-b" />
          <svg className="cena-arte__ponte" viewBox="0 0 120 30"><path d="M0 8 Q60 30 120 8" /><path d="M0 4 Q60 26 120 4" /></svg>
          <Barco className="cena-arte__barco" />
          <Fig k="aspasia" gesture="talk" scale={2} className="cena-arte__esq" />
          <Fig k="fidias" gesture="joy" scale={2} className="cena-arte__dir" />
        </>
      )}
      {tema === 'configuracoes' && (
        <>
          <Engrenagem className="cena-arte__eng-a" />
          <Engrenagem className="cena-arte__eng-b" />
          <Fig k="arquimedes" gesture="think" scale={2} className="cena-arte__esq" />
        </>
      )}
      {tema === 'ajuda' && (
        <>
          <svg className="cena-arte__constelacao" viewBox="0 0 120 60"><path d="M10 50 L34 22 L62 34 L88 12 L112 28" /><circle cx="10" cy="50" r="2.5" /><circle cx="34" cy="22" r="2.5" /><circle cx="62" cy="34" r="2.5" /><circle cx="88" cy="12" r="2.5" /><circle cx="112" cy="28" r="2.5" /></svg>
          <Fig k="platao" gesture="point" scale={2} className="cena-arte__esq" />
        </>
      )}
    </div>
  );
}

/** Estado vazio com a equipe (uma frase da tela vem como filho). */
export function CenaVazio({ figs = ['hipatia', 'arquimedes'] as Personagem[], children }: { figs?: Personagem[]; children?: ReactNode }) {
  return (
    <div className="cena-vazio">
      <div className="cena-vazio__figs" aria-hidden="true">{figs.map((k, i) => <Fig key={k} k={k} gesture={i % 2 ? 'offer' : 'talk'} scale={3} />)}</div>
      {children}
    </div>
  );
}

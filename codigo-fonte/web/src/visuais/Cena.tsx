// A cena de um gráfico (shared/visuais/cena.ts) desenhada com elementos SVG do React, nas cores do tema (variáveis CSS).
// A largura é a do lugar onde ela está (a conversa, a sala, o diálogo): a cena é refeita ao mudar, e o texto fica no
// tamanho certo. Entrada suave (cresce, traça, surge), sem movimento para quem pede.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Cena as CenaT, Cor, Prim } from '../../../shared/visuais/cena.ts';
import { DESENHOS } from '../../../shared/visuais/pictogramas.ts';
import { VARIAVEL } from '../../../shared/visuais/paleta.ts';

const cor = (c: Cor | null | undefined) => (c ? `var(${VARIAVEL[c]})` : 'none');
const anim = (p: Prim): { className?: string; style?: CSSProperties } => (p.anim ? { className: `vis-a vis-a--${p.anim}`, style: { '--i': p.i ?? 0 } as CSSProperties } : {});

let clips = 0;
function Prim({ p }: { p: Prim }): ReactNode {
  const a = anim(p);
  switch (p.t) {
    case 'rect': return <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} fill={cor(p.cor)} opacity={p.op} {...a} />;
    case 'circ': return <circle cx={p.cx} cy={p.cy} r={p.r} fill={cor(p.cor)} stroke={p.traco ? cor(p.traco) : undefined} strokeWidth={p.larg} opacity={p.op} {...a} />;
    case 'path': return <path d={p.d} fill={cor(p.cor ?? null)} stroke={p.traco ? cor(p.traco) : undefined} strokeWidth={p.larg} strokeLinecap={p.redondo ? 'round' : undefined} strokeLinejoin={p.redondo ? 'round' : undefined}
      strokeDasharray={p.tracejado ? '4 4' : undefined} opacity={p.op} pathLength={p.anim === 'traca' ? 1 : undefined} {...a} />;
    case 'text': return <text x={p.x} y={p.y} fontSize={p.tam} fontWeight={p.peso ?? 400} fill={cor(p.cor)} textAnchor={p.ancora} opacity={p.op} {...a}>{p.s}</text>;
    case 'pict': {
      const d = DESENHOS[p.nome]; const id = `vis-clip-${++clips}`;
      return (
        // a animação fica num grupo por fora: o transform dela não pode apagar o translate do desenho
        <g opacity={p.op} {...a}>
          <g transform={`translate(${p.x} ${p.y}) scale(${p.tam / 24})`}>
            {p.corte !== undefined && <clipPath id={id}><rect x={0} y={0} width={24 * p.corte} height={24} /></clipPath>}
            <g clipPath={p.corte !== undefined ? `url(#${id})` : undefined}>
              <path d={d.cheio} fill={cor(p.cor)} />
              {d.recorte && <path d={d.recorte} fill={cor(p.fundo)} />}
            </g>
          </g>
        </g>
      );
    }
  }
}

/** A cena em SVG. `rotulo`: o texto alternativo (o leitor de tela lê; a tabela de dados fica ao lado). */
export function CenaSvg({ cena, rotulo, className }: { cena: CenaT; rotulo?: string; className?: string }) {
  return (
    <svg className={`vis-cena ${className ?? ''}`} viewBox={`0 0 ${cena.w} ${cena.h}`} width={cena.w} height={cena.h} role="img" aria-label={rotulo ?? cena.alt}>
      {cena.prims.map((p, i) => <Prim key={i} p={p} />)}
    </svg>
  );
}

/** A largura útil de um elemento (muda junto com a janela, a gaveta da conversa, a rotação do celular). */
export function useLargura<T extends HTMLElement>(inicial = 560): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(inicial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => { const x = Math.floor(el.getBoundingClientRect().width); if (x > 0) setW((a) => (Math.abs(a - x) > 2 ? x : a)); };
    medir();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

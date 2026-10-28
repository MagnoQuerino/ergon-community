import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

/**
 * Tour inicial: destaca um elemento da tela por vez (marcado com data-tour="…") e explica em duas linhas.
 * Setas do teclado avançam e voltam; Esc fecha. Elemento fora da tela (modo foco, janela estreita) → cartão no centro.
 */
export interface TourStep { target: string; title: string; text: string }

type Box = { top: number; left: number; width: number; height: number } | null;

function boxOf(target: string): Box {
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 };
}

export function Tour({ steps, final, onClose }: { steps: TourStep[]; final: (close: () => void) => ReactNode; onClose: (finished: boolean) => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box>(null);
  const atEnd = i >= steps.length;
  const step = steps[i];

  useLayoutEffect(() => {
    if (atEnd) { setBox(null); return; }
    let raf = 0;
    const place = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setBox(boxOf(step.target))); };
    place();
    addEventListener('resize', place); addEventListener('scroll', place, true);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', place); removeEventListener('scroll', place, true); };
  }, [i, atEnd, step?.target]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc pela pilha de superfícies (a de cima fecha); as setas passam os passos
  const root = useRef<HTMLDivElement>(null);
  useSurface(root, { onClose: () => onClose(atEnd), modal: true, autoFocus: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && !atEnd) setI((x) => x + 1);
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [atEnd]);

  // cartão ao lado do destaque (à direita; se não couber, embaixo; sem destaque, no centro)
  const W = 320;
  const pos = box
    ? (box.left + box.width + W + 24 < innerWidth
      ? { top: Math.max(12, Math.min(box.top, innerHeight - 220)), left: box.left + box.width + 14 }
      : { top: Math.min(box.top + box.height + 12, innerHeight - 220), left: Math.max(12, Math.min(box.left, innerWidth - W - 12)) })
    : null;

  return (
    <div ref={root} className="tour" role="dialog" aria-modal="true" aria-label="Tour pelo Ergon">
      {box ? <div className="tour__spot" style={box} /> : <div className="tour__dim" />}
      <div className={`tour__card ${pos ? '' : 'tour__card--center'}`} style={pos ?? undefined}>
        {atEnd ? final(() => onClose(true)) : (
          <>
            <div className="tour__count">{i + 1} de {steps.length}</div>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            <div className="tour__nav">
              <button className="link" onClick={() => onClose(false)}>Sair do tour</button>
              <span className="tour__grow" />
              {i > 0 && <button className="btn btn--sm" onClick={() => setI(i - 1)}>Voltar</button>}
              <button className="btn btn--sm btn--primary" autoFocus onClick={() => setI(i + 1)}>{i === steps.length - 1 ? 'Concluir' : 'Próximo'} <Icon name="chevron" size={13} /></button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

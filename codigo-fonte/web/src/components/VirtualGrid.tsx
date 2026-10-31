import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { colsFor, visibleRange } from '../lib/virtual.ts';

/**
 * Grade virtualizada que rola com a página (qualquer ancestral com rolagem): mede a própria posição na janela e
 * monta só as linhas visíveis. Perto do fim do que já veio, pede mais (`onNeedMore`). Os itens mantêm a chave (id),
 * então seleção e foco sobrevivem às atualizações.
 */
export function VirtualGrid<T>({ items, hasMore, onNeedMore, rowHeight, minColWidth, gap = 12, render, keyOf, label, empty }: {
  items: T[]; hasMore: boolean; onNeedMore: () => void; rowHeight: number; minColWidth: number; gap?: number;
  render: (item: T) => ReactNode; keyOf: (item: T) => string; label: string; empty?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const cols = colsFor(width || minColWidth, minColWidth, gap);
  const colW = width ? (width - gap * (cols - 1)) / cols : minColWidth;
  const rowH = rowHeight + gap;
  const count = items.length;
  const frame = useRef(0);
  const measure = useCallback(() => {
    frame.current = 0;
    const el = box.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setRange((old) => { const next = visibleRange({ count, cols, rowH, top: r.top, viewH: window.innerHeight, overscan: 2 }); return old[0] === next[0] && old[1] === next[1] ? old : next; });
  }, [count, cols, rowH]);
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(measure); }, [measure]);
  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); schedule(); });
    ro.observe(el); setWidth(el.clientWidth);
    addEventListener('scroll', schedule, { capture: true, passive: true }); addEventListener('resize', schedule);
    return () => { ro.disconnect(); removeEventListener('scroll', schedule, { capture: true }); removeEventListener('resize', schedule); if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [schedule]);
  // perto do fim do que já veio: pede a próxima página
  useEffect(() => { if (hasMore && range[1] >= count - cols * 2) onNeedMore(); }, [range, count, cols, hasMore, onNeedMore]);

  const rows = Math.ceil(count / cols) + (hasMore ? 1 : 0);
  if (!count && !hasMore) return <>{empty ?? null}</>;
  return (
    <div ref={box} className="vgrid" role="list" aria-label={label} style={{ height: Math.max(0, rows * rowH - gap) }}>
      {items.slice(range[0], range[1]).map((it, k) => {
        const i = range[0] + k; const row = Math.floor(i / cols); const col = i % cols;
        return <div key={keyOf(it)} role="listitem" className="vgrid__cell" style={{ top: row * rowH, left: col * (colW + gap), width: colW, height: rowHeight }}>{render(it)}</div>;
      })}
      {hasMore && <div className="vgrid__more muted small" style={{ top: Math.ceil(count / cols) * rowH }}>Carregando mais…</div>}
    </div>
  );
}

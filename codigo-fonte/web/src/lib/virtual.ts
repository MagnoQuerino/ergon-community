// Contas da grade virtualizada (components/VirtualGrid.tsx), puras para teste.

/**
 * Faixa de itens visíveis numa grade de linhas de altura fixa (pura, testada): só esses itens e uma pequena margem
 * viram elementos na página. `top` é a posição da grade em relação à janela (negativa quando já passou do topo).
 */
export function visibleRange(o: { count: number; cols: number; rowH: number; top: number; viewH: number; overscan: number }): [number, number] {
  const rows = Math.ceil(o.count / o.cols);
  if (!rows) return [0, 0];
  const first = Math.max(0, Math.floor(-o.top / o.rowH) - o.overscan);
  const last = Math.min(rows, Math.ceil((o.viewH - o.top) / o.rowH) + o.overscan);
  if (last <= first) return [0, 0];
  return [first * o.cols, Math.min(o.count, last * o.cols)];
}
export const colsFor = (width: number, minCol: number, gap: number) => Math.max(1, Math.floor((width + gap) / (minCol + gap)));

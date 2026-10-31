// Contraste de leitura (WCAG): o texto da tela precisa ser legível nos dois temas, inclusive para quem enxerga mal.
// Usado pelo teste que lê a folha de estilos (contraste.test.ts).

const hex = (h: string): [number, number, number] => {
  const rgb = h.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [1, 2, 3].map((i) => Number(rgb[i]) / 255) as [number, number, number];
  let x = h.replace('#', '').toLowerCase();
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255) as [number, number, number];
};
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const luminance = (h: string) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
/** Razão de contraste entre duas cores (1 a 21). Texto normal pede pelo menos 4,5. */
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** As variáveis de cor de um bloco da folha de estilos (`:root {` ou `:root[data-theme="dark"] {`), em hex ou rgb(a). */
export function varsOf(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return {};
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\))/g)) out[m[1]] = m[2];
  return out;
}

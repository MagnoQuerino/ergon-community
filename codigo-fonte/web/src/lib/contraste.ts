// Contraste de leitura na tela: a conta e o readableOn vêm de shared/contraste.ts (os mesmos do validador de pacotes);
// aqui fica o que só a tela usa (o estilo do retrato de letra e a leitura das variáveis de um bloco da folha).
// A leitura da folha de estilos (teste que reprova a publicação) fica em contraste-folha.ts.
import { readableOn } from '../../../shared/contraste.ts';

export * from '../../../shared/contraste.ts';

/**
 * Estilo do retrato de letra (a inicial sobre a cor do agente): fundo e letra que se leem. Sem cor (ou cor inválida),
 * devolve `undefined` e vale o padrão da classe `.avatar` (navy com letra branca).
 */
export function letterStyle(color: string | null | undefined): { background: string; color: string } | undefined {
  const r = readableOn(color);
  return r ? { background: r.bg, color: r.fg } : undefined;
}

/** As variáveis de cor de um bloco da folha de estilos (`:root {` ou `:root[data-theme="dark"] {`), em hex ou rgb(a). */
export function varsOf(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return {};
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g)) out[m[1]] = m[2];
  return out;
}

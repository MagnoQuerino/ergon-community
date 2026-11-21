// Navegador ao vivo (rc.41): as contas da tela — coordenadas corrigidas pela escala, o que cada tecla vira, a roda do
// mouse e o toque. Sem DOM (o componente components/NavegadorAoVivo.tsx chama; os testes rodam sem navegador).

export interface Tela { largura: number; altura: number }
export interface Caixa { left: number; top: number; width: number; height: number }

/**
 * Onde a pessoa apontou, em pixels do viewport do navegador do agente. A imagem aparece inteira dentro da caixa do
 * elemento (como object-fit: contain), encolhida ou ampliada e com faixas vazias quando a proporção é outra: a conta tira
 * as faixas e desfaz a escala. Fora da imagem: null (não é clique na página).
 */
export function paraViewport(clientX: number, clientY: number, caixa: Caixa, tela: Tela): { x: number; y: number } | null {
  if (!(caixa.width > 0) || !(caixa.height > 0) || !(tela.largura > 0) || !(tela.altura > 0)) return null;
  const escala = Math.min(caixa.width / tela.largura, caixa.height / tela.altura);
  const sobraX = (caixa.width - tela.largura * escala) / 2, sobraY = (caixa.height - tela.altura * escala) / 2;
  const x = (clientX - caixa.left - sobraX) / escala, y = (clientY - caixa.top - sobraY) / escala;
  if (x < 0 || y < 0 || x >= tela.largura || y >= tela.altura) return null;
  return { x: Math.min(tela.largura - 1, Math.round(x)), y: Math.min(tela.altura - 1, Math.round(y)) };
}

export interface TeclaLida { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }
/** Alt=1, Ctrl=2, Meta=4, Shift=8 (os do protocolo do Chromium) */
export const modificadores = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export type MsgTecla = { t: 'k'; e: 'dn' | 'up'; key: string; code: string; vk: number; k: number };
/**
 * O que fazer com uma tecla:
 * - 'texto': é um caractere (ou acento em composição, ou colar com Ctrl+V): a tecla segue para o campo escondido, e o
 *   texto pronto vai de lá (evento input). Assim acento, teclado de celular e colar funcionam em qualquer teclado;
 * - a mensagem: tecla com nome (Enter, Backspace, setas, Tab, Esc…) ou atalho (Ctrl+A): vai como tecla;
 * - null: só um modificador sozinho, ou tecla que o sistema não nomeou: nada a mandar.
 */
export function lerTecla(e: TeclaLida, fase: 'dn' | 'up'): MsgTecla | 'texto' | null {
  const { key } = e;
  if (e.isComposing || key === 'Dead' || key === 'Process' || key === 'Unidentified') return fase === 'dn' ? 'texto' : null;
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(key)) return null;
  const atalho = e.ctrlKey || e.metaKey;
  const umCaractere = [...key].length === 1;
  if (umCaractere && !atalho) return fase === 'dn' ? 'texto' : null;
  // colar: o texto vem pelo campo escondido (a área de transferência é a do computador da pessoa)
  if (umCaractere && atalho && key.toLowerCase() === 'v') return fase === 'dn' ? 'texto' : null;
  if (!umCaractere && !/^[A-Za-z0-9]{1,24}$/.test(key)) return null;
  return { t: 'k', e: fase, key, code: /^[A-Za-z0-9]{1,24}$/.test(e.code) ? e.code : '', vk: e.keyCode > 0 && e.keyCode < 256 ? e.keyCode : 0, k: modificadores(e) };
}

/** A roda do mouse em pixels do viewport (linhas e páginas viram pixels; a escala da miniatura não muda o passo). */
export function rodaEmPixels(deltaX: number, deltaY: number, deltaMode: number, tela: Tela): { dx: number; dy: number } {
  const f = deltaMode === 1 ? 40 : deltaMode === 2 ? tela.altura * 0.9 : 1;
  const preso = (v: number) => Math.max(-2000, Math.min(2000, Math.round(v * f)));
  return { dx: preso(deltaX), dy: preso(deltaY) };
}

/** Conta cliques seguidos no mesmo lugar (duplo clique seleciona a palavra, triplo a linha). */
export class ContaCliques {
  private ultimo = { t: -1e9, x: 0, y: 0, n: 0 };
  clique(x: number, y: number, agora: number): number {
    const u = this.ultimo;
    const n = agora - u.t <= 450 && Math.abs(x - u.x) <= 6 && Math.abs(y - u.y) <= 6 ? Math.min(3, u.n + 1) : 1;
    this.ultimo = { t: agora, x, y, n };
    return n;
  }
}

export type MsgMouse = { t: 'm'; e: 'mv' | 'dn' | 'up' | 'wh'; x: number; y: number; b?: number; c?: number; dx?: number; dy?: number; k?: number };
/**
 * Toque com um dedo: tocar e soltar no lugar é um clique; arrastar rola a página (o conteúdo acompanha o dedo). Devolve
 * as mensagens de cada passo (em pixels do viewport).
 */
export class Toque {
  private ini: { x: number; y: number } | null = null;
  private ant: { x: number; y: number } | null = null;
  private arrastou = false;
  comecar(p: { x: number; y: number }): MsgMouse[] { this.ini = p; this.ant = p; this.arrastou = false; return [{ t: 'm', e: 'mv', x: p.x, y: p.y }]; }
  mover(p: { x: number; y: number }): MsgMouse[] {
    if (!this.ini || !this.ant) return [];
    if (!this.arrastou && Math.hypot(p.x - this.ini.x, p.y - this.ini.y) < 10) return [];
    this.arrastou = true;
    const dx = this.ant.x - p.x, dy = this.ant.y - p.y;
    this.ant = p;
    return dx || dy ? [{ t: 'm', e: 'wh', x: this.ini.x, y: this.ini.y, dx, dy }] : [];
  }
  soltar(): MsgMouse[] {
    const p = this.ini, foiClique = !!p && !this.arrastou;
    this.ini = null; this.ant = null;
    return foiClique ? [{ t: 'm', e: 'dn', x: p!.x, y: p!.y, b: 0, c: 1 }, { t: 'm', e: 'up', x: p!.x, y: p!.y, b: 0, c: 1 }] : [];
  }
  cancelar(): void { this.ini = null; this.ant = null; }
}

/** Quanto falta para o controle voltar sozinho, em minutos inteiros (arredondado para cima), nunca negativo. */
export function minutosAte(ate: string | null, agora: number): number | null {
  if (!ate) return null;
  const t = Date.parse(ate);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - agora) / 60_000)) : null;
}

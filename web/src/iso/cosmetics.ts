/**
 * Cosméticos de pacote (.ergon): efeitos em volta do boneco e pets. O mesmo desenho serve à cidade (engine.ts) e à
 * prévia do editor em Configurações › Pacotes, para o que se vê ao criar ser o que aparece na cidade.
 * Só pixels: não mexem em decisão, processo ou dado do agente.
 */
import { RES } from './projection.ts';
import { mix } from './theme.ts';

export interface FxSpec { effect: string; color: string; intensity: number }
export interface PetSpec { species: string; color: string }

/** Efeitos sob/ao redor do boneco (fx, fy = pés). t = 0 congela a animação (menos movimento). */
export function paintFx(g: CanvasRenderingContext2D, list: FxSpec[], fx: number, fy: number, t: number, moving: boolean, mirror: boolean): void {
  for (const e of list) {
    const a = 0.25 + 0.45 * e.intensity;
    g.save(); g.fillStyle = e.color;
    if (e.effect === 'aura') {
      for (let i = -10; i <= 10; i++) { const h = Math.round(Math.sqrt(1 - (i / 11) ** 2) * 4); g.globalAlpha = a * 0.6; g.fillRect(fx + i * RES, fy - h * RES / 2, RES, h * RES); }
    } else if (e.effect === 'fire_circle') {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2; const flick = Math.floor(t / 120 + k) % 3;
        g.globalAlpha = a; g.fillStyle = flick === 0 ? e.color : mix(e.color, '#ffe08a', 0.5);
        g.fillRect(Math.round(fx + Math.cos(ang) * 11 * RES), Math.round(fy + Math.sin(ang) * 4 * RES) - (1 + flick) * RES, RES, (1 + flick) * RES);
      }
    } else if (e.effect === 'celestial_glow') {
      for (let y = 0; y < 14; y++) { g.globalAlpha = a * (1 - y / 14) * 0.5; g.fillRect(fx - 3 * RES, fy - (y + 1) * 3 * RES, 6 * RES, 3 * RES); }
    } else if (e.effect === 'fire_trail' && moving) {
      for (let k = 1; k <= 4; k++) { g.globalAlpha = a * (1 - k / 5); g.fillRect(fx - (k * 4) * RES * (mirror ? -1 : 1), fy - RES - (Math.floor(t / 90 + k) % 2) * RES, 2 * RES, 2 * RES); }
    }
    g.restore();
  }
}

/** Pet ao lado do boneco; hop = pulinho em pixels (0 parado). */
export function paintPet(g: CanvasRenderingContext2D, p: PetSpec, fx: number, fy: number, hop: number): void {
  const x = fx + 9 * RES; const y = fy - hop;
  const px = (dx: number, dy: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(x + dx * RES, y + dy * RES, w * RES, h * RES); };
  const dark = mix(p.color, '#000000', 0.45);
  if (p.species === 'coruja') { px(-2, -6, 4, 5, p.color); px(-2, -6, 1, 1, dark); px(1, -6, 1, 1, dark); px(-1, -5, 1, 1, '#fbf7ee'); px(0, -5, 1, 1, '#fbf7ee'); px(-1, -1, 2, 1, dark); }
  else if (p.species === 'tartaruga') { px(-3, -3, 5, 2, p.color); px(-2, -4, 3, 1, dark); px(2, -3, 2, 1, mix(p.color, '#ffffff', 0.2)); px(-3, -1, 1, 1, dark); px(1, -1, 1, 1, dark); }
  else { px(-3, -3, 5, 2, p.color); px(1, -5, 2, 2, p.color); px(1, -6, 1, 1, dark); px(-4, -4, 1, 2, p.color); px(-3, -1, 1, 1, dark); px(1, -1, 1, 1, dark); if (p.species === 'cao') px(3, -4, 1, 1, dark); }
}

/**
 * Móveis e objetos de interior em pixel art (sprites ordenáveis), um por tipo de objeto das plantas
 * (world/buildings.ts ObjKind). Cada sprite é desenhado em volta da âncora (centro do objeto, no piso) e
 * cabe na caixa declarada na planta — é a caixa que decide quem cobre quem.
 */
import { RES } from './projection.ts';
import { backQuad, fillPoly, flatQuad, isoBox, line, sideQuad, type Tone } from './raster.ts';
import { amphoraSprite, benchSprite, blob, deskSprite, fitSprite, mapTableSprite, plantSprite, scrollBasketSprite, stoolSprite, type Sprite } from './props.ts';
import { klismosSprite, readingDeskSprite, roundTableSprite } from './architecture.ts';
import { mix, type Theme } from './theme.ts';
import type { ObjKind, PlanObj } from '../world/buildings.ts';

const cache = new Map<string, Sprite>();
function cached(key: string, make: () => Sprite): Sprite { let s = cache.get(key); if (!s) { s = make(); cache.set(key, s); } return s; }

/** Bancada de oficina: tampo grosso, prensa, martelo e cinzel. */
function workbenchSprite(t: Theme, v: number): Sprite {
  return cached(`${t.id}|bench-w|${v % 2}`, () => fitSprite(-0.75, 0, -0.45, 0.75, 1.1, 0.45, (g, P) => {
    const top = 0.62; const y2 = top + 0.12;
    for (const [lx, lz] of [[-0.66, -0.36], [0.56, -0.36], [-0.66, 0.26], [0.56, 0.26]]) isoBox(g, P, lx, 0, lz, lx + 0.1, top, lz + 0.1, t.woodDark, t.outline);
    line(g, P(-0.6, 0.2, 0.32), P(0.6, 0.2, 0.32), t.woodDark[1]);
    isoBox(g, P, -0.72, top, -0.42, 0.72, y2, 0.42, t.wood, t.outline);
    for (const z of [-0.2, 0.1]) line(g, P(-0.7, y2, z), P(0.7, y2, z), t.wood[1]);
    isoBox(g, P, 0.3, y2, -0.34, 0.48, y2 + 0.3, -0.16, t.woodDark, t.outline); // prensa
    line(g, P(0.39, y2 + 0.3, -0.25), P(0.39, y2 + 0.45, -0.25), t.bronze[1]);
    line(g, P(-0.5, y2 + 0.02, 0.0), P(-0.15, y2 + 0.02, 0.2), t.woodDark[0]); // cabo do martelo
    isoBox(g, P, -0.56, y2, -0.06, -0.42, y2 + 0.08, 0.06, t.bronze, t.outline);
    if (v % 2) isoBox(g, P, -0.1, y2, -0.3, 0.2, y2 + 0.16, -0.12, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline); // tábua em obra
    else line(g, P(0.0, y2 + 0.01, 0.15), P(0.25, y2 + 0.01, 0.3), t.bronze[0]); // cinzel
  }));
}

/** Balcão de loja: frente fechada, mercadorias (potes e ânforas pequenas) sobre o tampo. */
function counterSprite(t: Theme, v: number): Sprite {
  return cached(`${t.id}|counter|${v % 3}`, () => fitSprite(-0.75, 0, -0.45, 0.75, 1.15, 0.45, (g, P) => {
    const top = 0.72;
    isoBox(g, P, -0.72, 0, -0.42, 0.72, top, 0.42, t.woodDark, t.outline);
    backQuad(g, P, 0.42, -0.6, 0.6, 0.1, top - 0.1, t.wood[1]);
    for (const x of [-0.2, 0.2]) line(g, P(x, 0.1, 0.42), P(x, top - 0.1, 0.42), t.woodDark[2]);
    isoBox(g, P, -0.75, top, -0.45, 0.75, top + 0.06, 0.45, t.wood, t.outline);
    const goods = [t.terracotta, t.teal[0], t.gold, t.papyrus[0]] as const;
    for (let k = 0; k < 3; k++) {
      const x = -0.45 + k * 0.42; const c = goods[(k + v) % goods.length];
      const tone: Tone = typeof c === 'string' ? [c, mix(c, '#000000', 0.15), mix(c, '#000000', 0.3)] : c as Tone;
      isoBox(g, P, x - 0.1, top + 0.06, -0.1, x + 0.1, top + 0.28 + (k % 2) * 0.08, 0.1, tone, t.outline);
    }
  }));
}

/** Mesa longa do conselho (câmara): tampo comprido com rolos e um tinteiro. */
function longTableSprite(t: Theme, hx: number, hz: number): Sprite {
  return cached(`${t.id}|longtable|${hx}|${hz}`, () => fitSprite(-hx - 0.05, 0, -hz - 0.05, hx + 0.05, 1.0, hz + 0.05, (g, P) => {
    const top = 0.66; const y2 = top + 0.08;
    for (const [lx, lz] of [[-hx + 0.08, -hz + 0.08], [hx - 0.16, -hz + 0.08], [-hx + 0.08, hz - 0.16], [hx - 0.16, hz - 0.16]]) isoBox(g, P, lx, 0, lz, lx + 0.08, top, lz + 0.08, t.woodDark, t.outline);
    isoBox(g, P, -hx, top, -hz, hx, y2, hz, t.woodDark, t.outline);
    flatQuad(g, P, y2 + 0.002, -hx + 0.15, -0.12, hx - 0.15, 0.12, t.carpet.field);
    for (let x = -hx + 0.35; x < hx - 0.2; x += 0.7) isoBox(g, P, x - 0.06, y2, -hz + 0.12, x + 0.06, y2 + 0.08, -hz + 0.42, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline);
  }));
}

/** Estante de pergaminhos encostada na parede da esquerda (Arquivos). Caixa: hx × hz × h. */
function archiveShelfSprite(t: Theme, hx: number, hz: number, h: number): Sprite {
  return cached(`${t.id}|archive|${hx}|${hz}|${h}`, () => fitSprite(-hx, 0, -hz, hx, h, hz, (g, P) => {
    isoBox(g, P, -hx, 0, -hz, hx, h, hz, t.woodDark, t.outline);
    for (let rr = 0; rr < 4; rr++) for (let c = 0; c < 4; c++) {
      const z0 = -hz + 0.1 + c * ((2 * hz - 0.2) / 4); const y0 = 0.14 + rr * ((h - 0.2) / 4);
      sideQuad(g, P, hx, z0, z0 + (2 * hz - 0.2) / 4 - 0.09, y0, y0 + 0.4, '#20160f');
      for (const [dz, dh] of [[0.1, 0.12], [0.27, 0.12], [0.18, 0.27]]) {
        if ((rr * 4 + c + dz * 10) % 7 < 1) continue;
        const [px, py] = P(hx, y0 + dh, z0 + dz); g.fillStyle = t.papyrus[0]; g.fillRect(px - RES, py - 1, 2 * RES, RES + 1); g.fillStyle = t.papyrus[1]; g.fillRect(px - 1, py, RES, 1);
      }
    }
  }));
}

/** Estante alta do fundo da biblioteca (nichos com rolos), como objeto ordenável. */
function backShelvesSprite(t: Theme, hx: number, hz: number, h: number): Sprite {
  return cached(`${t.id}|bshelves|${hx}|${hz}|${h}`, () => fitSprite(-hx, 0, -hz, hx, h, hz, (g, P) => {
    isoBox(g, P, -hx, 0, -hz, hx, h, hz, t.woodDark, t.outline);
    const cols = Math.floor((2 * hx) / 0.5);
    for (let r = 0; r < 4; r++) for (let c = 0; c < cols; c++) {
      const a = -hx + 0.08 + c * ((2 * hx - 0.16) / cols); const b = a + (2 * hx - 0.16) / cols - 0.07;
      const h0 = 0.14 + r * 0.55; const h1 = h0 + 0.44;
      backQuad(g, P, hz, a, b, h0, h1, '#20160f');
      for (const [dx, dh] of [[0.1, 0.1], [0.25, 0.1], [0.17, 0.24], [0.33, 0.24]]) {
        if (((r * 7 + c * 3 + dx * 10) | 0) % 6 === 0 || a + dx > b - 0.04) continue;
        const [px, py] = P(a + dx, h0 + dh, hz); g.fillStyle = t.papyrus[0]; g.fillRect(px - RES, py - 1, 2 * RES, RES + 1); g.fillStyle = t.papyrus[1]; g.fillRect(px, py, 1, 1);
      }
    }
    line(g, P(-hx, h, hz), P(hx, h, hz), t.wood[0]);
  }));
}

/** Prateleira de jarros da botica (ervas, unguentos). */
function jarsSprite(t: Theme): Sprite {
  return cached(`${t.id}|jars`, () => fitSprite(-0.26, 0, -0.26, 0.26, 1.2, 0.26, (g, P) => {
    isoBox(g, P, -0.24, 0, -0.24, 0.24, 0.9, 0.24, t.woodDark, t.outline);
    const cols = [t.teal[0], t.terracotta[0], t.papyrus[0], t.olive[0], t.gold];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) {
      const [x, y] = P(0.24, 0.12 + r * 0.27, -0.12 + k * 0.22);
      g.fillStyle = t.outline; g.fillRect(x - 1, y - 2 * RES - 1, 2 * RES + 2, 2 * RES + 2);
      g.fillStyle = cols[(r * 2 + k) % cols.length]; g.fillRect(x, y - 2 * RES, 2 * RES, 2 * RES);
    }
    for (const [x, z] of [[-0.1, -0.1], [0.08, 0.06]]) { const [px, py] = P(x, 0.9, z); blob(g, px, py - RES, RES + 1, RES, t.outline); blob(g, px, py - RES, RES, RES - 1, t.marble[1]); }
  }));
}

/** Arca de madeira com ferragens. */
function chestSprite(t: Theme): Sprite {
  return cached(`${t.id}|chest`, () => fitSprite(-0.3, 0, -0.24, 0.3, 0.6, 0.24, (g, P) => {
    isoBox(g, P, -0.28, 0, -0.22, 0.28, 0.42, 0.22, t.wood, t.outline);
    isoBox(g, P, -0.3, 0.42, -0.24, 0.3, 0.5, 0.24, t.woodDark, t.outline);
    for (const x of [-0.18, 0.18]) line(g, P(x, 0.02, 0.22), P(x, 0.5, 0.24), t.bronze[1]);
    const [px, py] = P(0, 0.34, 0.22); g.fillStyle = t.bronze[0]; g.fillRect(px - 1, py - 1, RES, RES);
  }));
}

/** Bigorna sobre um toco (oficina). */
function anvilSprite(t: Theme): Sprite {
  return cached(`${t.id}|anvil`, () => fitSprite(-0.3, 0, -0.26, 0.3, 0.75, 0.26, (g, P) => {
    isoBox(g, P, -0.16, 0, -0.16, 0.16, 0.42, 0.16, t.woodDark, t.outline);
    const dark: Tone = [mix(t.outline, '#888888', 0.45), mix(t.outline, '#666666', 0.35), mix(t.outline, '#444444', 0.3)];
    isoBox(g, P, -0.1, 0.42, -0.08, 0.1, 0.52, 0.08, dark, t.outline);
    isoBox(g, P, -0.26, 0.52, -0.12, 0.24, 0.64, 0.12, dark, t.outline);
  }));
}

/** Meia parede inteira (divisória baixa), ordenada pela própria caixa. */
export function halfWallSprite(t: Theme, hx: number, hz: number, wood: boolean): Sprite {
  return cached(`${t.id}|hw2|${hx.toFixed(3)}|${hz.toFixed(3)}|${wood ? 1 : 0}`, () => fitSprite(-hx - 0.05, 0, -hz - 0.05, hx + 0.05, 0.72, hz + 0.05, (g, P) => {
    const H = 0.72; const ix = hx * 0.9; const iz = hz * 0.9;
    const low: Tone = wood ? t.wood : [t.dado, mix(t.dado, '#000000', 0.08), mix(t.dado, '#000000', 0.22)];
    isoBox(g, P, -ix, 0, -iz, ix, 0.4, iz, low, t.outline);
    isoBox(g, P, -ix, 0.4, -iz, ix, H - 0.08, iz, [t.wallBack, t.wallBack, t.wallSide], t.outline);
    if (hx >= hz) line(g, P(-ix, 0.4, iz), P(ix, 0.4, iz), wood ? t.bronze[1] : t.trim); else line(g, P(ix, 0.4, -iz), P(ix, 0.4, iz), wood ? t.bronze[1] : t.trim);
    isoBox(g, P, -ix - 0.03, H - 0.08, -iz - 0.03, ix + 0.03, H, iz + 0.03, t.marble, t.outline);
  }, 3 * RES));
}

/** Degrau da escada (caixa do piso até a altura do degrau), com o balaústre a cada dois degraus. */
export function stepSprite(t: Theme, hx: number, hz: number, h: number, rail: 'x0' | 'z1' | null): Sprite {
  return cached(`${t.id}|step|${hx.toFixed(3)}|${hz.toFixed(3)}|${h.toFixed(3)}|${rail}`, () => fitSprite(-hx, 0, -hz, hx, h + 0.8, hz, (g, P) => {
    isoBox(g, P, -hx, 0, -hz, hx, h, hz, t.stone);
    if (hx >= hz) line(g, P(-hx, h, hz), P(hx, h, hz), t.stone[0]); else line(g, P(hx, h, -hz), P(hx, h, hz), t.stone[0]);
    if (rail === 'x0') { line(g, P(-hx + 0.06, h, 0), P(-hx + 0.06, h + 0.75, 0), t.bronze[2]); line(g, P(-hx + 0.06, h + 0.75, -hz), P(-hx + 0.06, h + 0.75, hz), t.bronze[0]); }
    if (rail === 'z1') { line(g, P(0, h, hz - 0.06), P(0, h + 0.75, hz - 0.06), t.bronze[2]); line(g, P(-hx, h + 0.75, hz - 0.06), P(hx, h + 0.75, hz - 0.06), t.bronze[0]); }
  }, 2 * RES));
}

/** Sprite de um objeto da planta (o mesmo para qualquer prédio ou mod que use o tipo). */
export function objectSprite(t: Theme, o: PlanObj): Sprite {
  const v = o.variant ?? 0;
  const k: ObjKind = o.kind;
  switch (k) {
    case 'desk': return deskSprite(t, v);
    case 'reading': case 'lectern': return readingDeskSprite(t, v);
    case 'workbench': return workbenchSprite(t, v);
    case 'counter': return counterSprite(t, v);
    case 'stool': return stoolSprite(t);
    case 'klismos': return klismosSprite(t);
    case 'meet-table': return o.hx > 0.7 ? longTableSprite(t, o.hx, o.hz) : mapTableSprite(t);
    case 'round-table': return roundTableSprite(t);
    case 'long-table': return longTableSprite(t, o.hx, o.hz);
    case 'bench': return benchSprite(t);
    case 'plant': case 'herbs': return plantSprite(t);
    case 'amphora': return amphoraSprite(t, v % 2 === 1);
    case 'basket': return scrollBasketSprite(t);
    case 'shelf': return archiveShelfSprite(t, o.hx, o.hz, o.h);
    case 'back-shelves': return backShelvesSprite(t, o.hx, o.hz, o.h);
    case 'jars': return jarsSprite(t);
    case 'chest': return chestSprite(t);
    case 'anvil': return anvilSprite(t);
    default: return chestSprite(t);
  }
}

export { fillPoly };

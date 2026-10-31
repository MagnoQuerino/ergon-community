/**
 * Personagens em pixel art, montados pixel a pixel numa grade (26×50) e recoloridos por agente.
 * Estilo "cabeçudo robusto", sóbrio: cabeça grande (~40% da altura), tronco largo, braços e pernas curtos,
 * rosto simples (olhos em ponto, sobrancelhas, boca pequena) — a expressão acompanha o estado real do agente.
 * Quíton claro, himácio na cor do agente, sandálias e um objeto de ofício.
 * A grade é TypeScript puro (testável); o canvas só nasce no cache.
 */
import { mix, shade, harmonize, type Theme } from './theme.ts';
import { Lru } from './lru.ts';
import { GRECIA_CLASSICA, rollFigure, type GraphicPack, type HairStyle, type Headwear, type Item } from '../world/pack.ts';
import type { SkinFace, Species } from '../../../shared/skin.ts';
import { hairBack, hairFront, headwear as skinHeadwear, item as skinItem, kitBottom, kitCape, kitLegs, kitSleeves, kitTop, speciesAndFace, type Kit, type Pen } from './figureParts.ts';

export type { HairStyle, Item } from '../world/pack.ts';
export type Facing = 'front' | 'back'; // frente = 3/4 virado para o observador; costas = afastando-se
export type Pose = 'stand' | 'walk' | 'sit' | 'perch'; // sit = atrás da mesa (pernas escondidas); perch = em banco ou degrau, pernas à mostra
export type Expr = 'smile' | 'neutral' | 'surprised' | 'focused' | 'worried' | 'angry';
/** Gestos de corpo: conversa, raiva (braços sacudindo), preocupação (mão na cabeça), alegria (braços para cima),
 * pensar (mão no queixo), alcançar (estante, ânfora, planta), apontar (quadro) e entregar um rolo. */
export type Gesture = 'none' | 'talk' | 'angry' | 'worry' | 'joy' | 'think' | 'reach' | 'point' | 'offer' | 'receive';

export interface Look {
  skin: [string, string]; hair: string; hairStyle: HairStyle; beard: boolean;
  drape: [string, string]; chiton: [string, string]; item: Item; wreath: boolean;
  /**
   * quíton com himácio (padrão), exômide (túnica curta de trabalho na cor do agente, um ombro à mostra), peplo
   * (vestido longo com a dobra do peito na cor do agente) ou armadura de general (couraça, saiote de tiras, capa)
   */
  outfit?: 'chiton' | 'armor' | 'exomis' | 'peplos';
  /** barba curta (rente) em vez da cheia, quando beard */
  beardShort?: boolean;
  /** cobertura de cabeça além da coroa de louros: faixa (fita na cor do agente) ou pétaso (chapéu de viagem) */
  headwear?: Headwear;
  /** barra da roupa com meandro na cor do agente */
  hem?: boolean;
  /** skin (figureParts.ts): roupa por peças, espécie, acessório de rosto e cor do chapéu */
  kit?: Kit; species?: Species; face?: SkinFace; hat?: [string, string] | null;
}

export const FIG_W = 30;
export const FIG_H = 50;
export const FIG_AX = 15; // âncora: entre os pés
export const FIG_AY = 47;
const Y0 = 2; // folga no alto da grade (coque, cajado)
const X0 = 2; // folga dos lados (braços abertos em V)

export type Grid = (string | null)[][];

export function figureGrid(look: Look, facing: Facing, pose: Pose, frame: number, t: Theme, expr: Expr = 'smile', gesture: Gesture = 'none'): Grid {
  const g: Grid = Array.from({ length: FIG_H }, () => Array<string | null>(FIG_W).fill(null));
  const put = (x: number, y: number, c: string) => { const xx = x + X0; const yy = y + Y0; if (xx >= 0 && xx < FIG_W && yy >= 0 && yy < FIG_H) g[yy][xx] = c; };
  const rect = (x: number, y: number, w: number, h: number, c: string) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
  const span = (y: number, x0: number, x1: number, c: string) => rect(x0, y, x1 - x0 + 1, 1, c);
  const seated = pose === 'sit';
  const perch = pose === 'perch';
  const back = facing === 'back';
  const dy = seated ? 3 : perch ? 5 : 0; // sentado: tronco e cabeça descem (no banco, mais: o colo fica na altura do assento)
  const writing = seated && frame === 1;
  const hy = dy + (writing ? 1 : 0); // ao escrever, a cabeça inclina
  const [S, s] = look.skin;
  const H = look.hair; const h = shade(H, -0.28); const hl = shade(H, 0.14);
  const [T, tt] = look.chiton;
  const [D, d] = look.drape;
  const E = '#2b2028'; const M = '#6e3b33';
  const late: Array<() => void> = []; // partes que ficam à frente da cabeça (mão na cabeça, mão no queixo)
  const armor = look.outfit === 'armor';
  const holding = gesture === 'none' && !back && !seated && !perch && ['scroll', 'abacus', 'tablet', 'laptop', 'book', 'binoculars', 'clipboard', 'cat', 'datapad'].includes(look.item);
  const exomis = look.outfit === 'exomis'; const peplos = look.outfit === 'peplos';
  const kit = look.kit ?? null;
  const pen: Pen = { put, rect, span };
  const accent = kit?.A ?? t.teal[0];

  if (kit && !seated) kitCape(pen, kit, dy, perch);
  if (armor && !seated) { rect(3, 22 + dy, 3, perch ? 13 : 18, D); rect(3, 22 + dy, 1, perch ? 13 : 18, d); rect(20, 22 + dy, 2, perch ? 10 : 14, d); } // capa (clâmide) por trás
  // cabelo comprido cai por trás dos ombros (desenhado antes do corpo)
  if (look.hairStyle === 'long' && !back) { rect(3, 9 + hy, 3, 17, H); rect(3, 9 + hy, 1, 17, h); rect(20, 10 + hy, 2, 11, h); }
  // rabo de cavalo: preso atrás, aparece do lado da nuca
  if (look.hairStyle === 'ponytail' && !back) { rect(3, 10 + hy, 3, 8, H); rect(3, 10 + hy, 1, 8, h); span(10 + hy, 3, 5, t.bronze[1]); }

  // pernas curtas e firmes, sandálias
  if (perch) {
    // sentado num banco ou degrau: joelhos à frente (colo largo), canelas curtas, sandálias no chão
    const knee = kit && (kit.bottom === 'pants' || kit.bottom === 'robe') ? kit.B : null;
    const shoe = kit ? (kit.shoes === 'sneakers' ? '#f2f2ee' : kit.shoes === 'shoes' ? '#2b2b33' : kit.shoes === 'boots' ? '#4a3a28' : kit.shoes === 'bare' ? S : t.sandal) : t.sandal;
    for (const L of [7, 16]) { rect(L, 41, 3, 2, knee ? knee[0] : S); rect(L + 2, 41, 1, 2, knee ? knee[1] : s); rect(L - 1, 43, 5, 2, shoe); }
  } else if (kit && !seated) {
    kitLegs(pen, kit, S, s, pose === 'walk' && frame === 1);
  } else if (!seated) {
    const step = pose === 'walk' && frame === 1;
    const L = step ? 7 : 8; const R = step ? 16 : 15; const up = step ? 1 : 0;
    // exômide curta: pernas aparecem mais; peplo longo: só as sandálias
    const top = exomis ? 36 : 39; const len = 43 - top;
    if (!peplos) {
      rect(L, top - up, 3, len, armor ? t.bronze[1] : S); rect(L + 2, top - up, 1, len, armor ? t.bronze[2] : s); // grevas na armadura
      rect(R, top, 3, len, S); rect(R, top, 1, len, s);
    }
    rect(L - 1, 43 - up, 5, 2, t.sandal); put(L + 1, 42 - up, t.sandal);
    rect(R - 1, 43, 5, 2, t.sandal); put(R + 1, 42, t.sandal);
  }
  // saia do quíton (pregas)
  if (kit) kitBottom(pen, kit, back, seated, perch, dy);
  else if (seated) rect(5, 31 + dy, 16, 3, T);
  else if (perch) { rect(5, 31 + dy, 16, 2, T); rect(4, 33 + dy, 18, 3, T); span(35 + dy, 4, 21, tt); for (const x of [8, 17]) put(x, 34 + dy, tt); put(12, 34 + dy, tt); put(13, 34 + dy, tt); }
  else if (armor) {
    // saiote de tiras (ptéruges): couro e linho alternados
    for (let x = 5; x <= 20; x++) for (let y = 31; y <= 37; y++) put(x, y, Math.floor((x - 5) / 2) % 2 ? T : t.woodDark[0]);
    span(37, 5, 20, shade(T, -0.15));
  } else if (exomis) {
    // túnica curta de trabalho, na cor do agente
    rect(6, 31, 14, 3, D); rect(5, 34, 16, 2, D);
    for (const x of [9, 13, 16]) for (let y = 32; y <= 35; y++) put(x, y, d);
    span(35, 5, 20, shade(D, -0.12));
  } else if (peplos) {
    // vestido longo até os pés, pregas finas
    rect(6, 31, 14, 3, T); rect(5, 34, 16, 8, T);
    for (const x of [8, 11, 14, 17]) for (let y = 32; y <= 41; y++) put(x, y, tt);
    rect(back ? 5 : 19, 34, 2, 8, tt);
    span(41, 5, 20, shade(T, -0.1));
  } else {
    rect(6, 31, 14, 3, T); rect(5, 34, 16, 5, T);
    for (const x of [9, 13, 16]) for (let y = 32; y <= 38; y++) put(x, y, tt);
    rect(back ? 5 : 19, 34, 2, 5, tt);
    span(38, 5, 20, shade(T, -0.1));
  }
  // barra decorada: meandro simples na cor do agente (na exômide, no tom claro)
  if (look.hem && !seated && !armor && !kit) {
    const row = perch ? 35 + dy : exomis ? 35 : peplos ? 41 : 38;
    for (let x = 5; x <= 20; x++) put(x, row, x % 3 === 0 ? (exomis ? D : T) : exomis ? T : D);
  }
  // tronco largo, ombros arredondados, cinto simples
  if (kit) kitTop(pen, kit, S, s, back, seated, perch, dy, hashOf(kit.T[0] + kit.A));
  else if (armor) {
    // couraça anatômica de bronze: luz à esquerda, peitorais e abdômen marcados, cinto de couro
    const [B0, B1, B2] = t.bronze;
    span(22 + dy, 7, 18, B1); rect(6, 23 + dy, 14, 7, B1); rect(6, 23 + dy, 4, 7, B0); rect(back ? 6 : 18, 23 + dy, 2, 7, B2);
    if (!back) { span(25 + dy, 8, 11, B2); span(25 + dy, 14, 17, B2); put(12, 27 + dy, B2); put(13, 27 + dy, B2); put(12, 29 + dy, B2); put(13, 29 + dy, B2); }
    span(30 + dy, 6, 19, t.woodDark[0]); put(12, 30 + dy, B0);
  } else if (exomis) {
    // exômide: presa no ombro esquerdo; o direito fica à mostra; cinto de couro
    span(22 + dy, 7, 18, D); rect(6, 23 + dy, 14, 7, D);
    rect(back ? 6 : 18, 23 + dy, 2, 7, d);
    if (!back) { rect(15, 22 + dy, 4, 2, S); rect(16, 24 + dy, 3, 1, S); put(15, 24 + dy, s); }
    span(30 + dy, 6, 19, t.woodDark[0]);
  } else if (peplos) {
    // peplo: corpo claro, dobra do peito (apoptigma) na cor do agente, presa nos ombros por fíbulas de bronze
    span(22 + dy, 7, 18, T); rect(6, 23 + dy, 14, 7, T);
    rect(back ? 6 : 18, 23 + dy, 2, 7, tt);
    rect(6, 26 + dy, 14, 4, D); span(29 + dy, 6, 19, d);
    put(8, 22 + dy, t.bronze[0]); put(17, 22 + dy, t.bronze[0]);
  } else {
    span(22 + dy, 7, 18, T); rect(6, 23 + dy, 14, 7, T);
    rect(back ? 6 : 18, 23 + dy, 2, 7, tt);
    span(30 + dy, 6, 19, t.bronze[1]);
    // himácio na cor do agente: faixa diagonal + caimento
    for (let i = 0; i < 8; i++) {
      const x0 = back ? 17 - Math.round(i * 1.6) : 6 + Math.round(i * 1.6);
      put(x0, 22 + dy + i, D); put(x0 + 1, 22 + dy + i, D); put(back ? x0 : x0 + 2, 22 + dy + i, d);
    }
  }
  if (!seated && !perch && !armor && !exomis && !peplos && !kit) {
    const fx = back ? 5 : 18;
    rect(fx, 31, 3, 7, D); rect(back ? fx : fx + 2, 31, 1, 7, d); rect(back ? 4 : 21, 34, 1, 4, d);
  }
  // braços: manga + antebraço + mão (exômide: braço direito nu; peplo: mangas claras)
  const ks = kit ? kitSleeves(kit, S, back) : null;
  const leftSleeve = ks ? ks.left : armor ? t.bronze[0] : peplos ? T : exomis ? D : back ? T : D;
  const rightSleeve = ks ? ks.right : armor ? D : peplos ? T : exomis ? (back ? D : S) : back ? D : T; // general: capa presa no ombro direito
  const longSleeve = !!ks?.long;
  const arm = (x: number, sleeve: string, off: number, len: number) => {
    rect(x, 22 + dy, 3, 4, sleeve);
    if (longSleeve && len > 1) {
      // manga comprida até o punho; a mão continua de fora
      rect(x, 26 + dy + off, 3, len - 1, sleeve);
      rect(x < 13 ? x + 2 : x, 26 + dy + off, 1, len - 1, shade(sleeve, -0.2));
      rect(x, 26 + dy + off + len - 1, 3, 1, S);
    } else {
      rect(x, 26 + dy + off, 3, len, S);
      rect(x < 13 ? x + 2 : x, 26 + dy + off, 1, len, s);
    }
    span(26 + dy + off + len, x, x + 2, s);
  };
  // braço erguido: manga no ombro, antebraço subindo por fora do corpo, mão (3×3) no alto
  const raised = (x: number, sleeve: string, handY: number) => {
    rect(x < 13 ? 3 : 20, 22 + dy, 3, 4, sleeve);
    const ax = x < 13 ? x : x;
    rect(ax, handY + 3, 3, 22 + dy - handY - 3, S); rect(x < 13 ? ax + 2 : ax, handY + 3, 1, 22 + dy - handY - 3, s);
    rect(ax, handY, 3, 3, S); span(handY + 2, ax, ax + 2, s);
  };
  const up = frame === 1;
  // braço erguido em V, curto: sai do ombro, o antebraço sobe rente à cabeça e a mão fica na altura da testa
  // (nunca acima do alto da cabeça); high = um pouco mais alto (alegria, punho da raiva)
  const vArm = (left: boolean, sleeve: string, high: boolean) => {
    rect(left ? 3 : 20, 22 + dy, 3, 4, sleeve);
    const fx = left ? 1 : 22; const top = (high ? 8 : 11) + dy;
    rect(left ? 2 : 21, 19 + dy, 3, 3, S);
    rect(fx, top + 3, 3, 19 + dy - (top + 3), S);
    rect(left ? fx + 2 : fx, top + 3, 1, 19 + dy - (top + 3), s);
    rect(fx, top, 3, 3, S); span(top + 2, fx, fx + 2, s);
  };
  if (gesture === 'angry') { vArm(true, leftSleeve, up); vArm(false, rightSleeve, !up); } // sacode os punhos alternando
  else if (gesture === 'joy') { vArm(true, leftSleeve, true); vArm(false, rightSleeve, true); }
  else if (gesture === 'worry') {
    // mão na cabeça (coçando: sobe e desce 1 px)
    if (seated) { rect(3, 22 + dy, 3, 4, leftSleeve); rect(5, 27, 2, 2, S); rect(7, 27, 3, 2, S); }
    else arm(3, leftSleeve, 0, 5);
    rect(20, 22 + dy, 3, 4, rightSleeve);
    rect(20, 12 + hy, 2, 10 + dy - hy, S); rect(21, 12 + hy, 1, 10 + dy - hy, s);
    late.push(() => { rect(20, 7 + hy, 2, 6, S); rect(16, (up ? 4 : 5) + hy, 5, 3, S); span((up ? 6 : 7) + hy, 16, 20, s); });
  } else if (gesture === 'think') {
    // mão no queixo, divagando
    arm(3, leftSleeve, 0, 5);
    rect(20, 22 + dy, 3, 4, rightSleeve);
    late.push(() => { rect(18, 20 + hy, 3, 3, S); rect(15, 18 + hy, 3, 3, S); span(20 + hy, 15, 17, s); });
  } else if (gesture === 'talk') {
    // gesticula com a mão direita; no outro quadro a mão desce para o peito
    arm(3, leftSleeve, 0, 5);
    if (up) { rect(20, 22 + dy, 3, 4, rightSleeve); rect(21, 17 + dy, 3, 5, S); rect(21, 15 + dy, 3, 2, S); span(16 + dy, 21, 23, s); }
    else { rect(20, 22 + dy, 3, 4, rightSleeve); rect(18, 26 + dy, 3, 2, S); rect(15, 26 + dy, 3, 3, S); span(28 + dy, 15, 17, s); }
  } else if (gesture === 'reach') {
    arm(3, leftSleeve, 0, 5); raised(20, rightSleeve, up ? 13 : 11);
  } else if (gesture === 'offer' || gesture === 'receive') {
    // braço direito estendido: entregando um rolo (pontas de madeira) ou com a mão aberta para recebê-lo
    arm(3, leftSleeve, 0, 5);
    rect(20, 22 + dy, 3, 4, rightSleeve); rect(21, 26 + dy, 4, 2, S); span(28 + dy, 21, 24, s);
    if (gesture === 'offer') {
      rect(25, 23 + dy, 2, 6, t.papyrus[0]); span(28 + dy, 25, 26, t.papyrus[1]);
      span(22 + dy, 25, 26, t.woodDark[0]); span(29 + dy, 25, 26, t.woodDark[0]);
    } else { rect(25, 25 + dy, 2, 3, S); span(27 + dy, 25, 26, s); }
  } else if (gesture === 'point') {
    arm(3, leftSleeve, 0, 5);
    rect(20, 22 + dy, 3, 4, rightSleeve); rect(21, 17, 3, 5, S); rect(22, 14, 3, 3, S); span(16, 22, 24, s);
  } else if (seated && !back) {
    // braços apoiados na mesa, mãos à frente do peito; ao escrever, a mão direita sobe com o estilete
    rect(3, 22 + dy, 3, 4, leftSleeve); rect(20, 22 + dy, 3, 4, rightSleeve);
    rect(5, 27, 2, 2, S); rect(19, 27, 2, 2, S);
    rect(7, 27, 3, 2, S); span(29, 7, 9, s);
    const hand = writing ? 26 : 27; // mãos logo acima da borda da mesa
    rect(16, hand, 3, 2, S); span(hand + 2, 16, 18, s);
    if (writing) { put(18, hand - 2, t.bronze[0]); put(19, hand - 3, t.bronze[0]); }
  } else if (holding) { arm(3, leftSleeve, 0, 3); arm(20, rightSleeve, 0, 3); }
  else {
    const sw = pose === 'walk' ? (frame === 1 ? 1 : -1) : 0;
    arm(3, leftSleeve, sw, 5); arm(20, rightSleeve, -sw, 5);
  }

  // objeto de ofício (de frente, em pé)
  if (!back && !seated && !perch && gesture === 'none') {
    const [P0, P1] = t.papyrus;
    switch (look.item) {
      case 'scroll': // rolo atravessado, mais largo que o tronco e com pontas de madeira (lê-se sobre a túnica clara)
        rect(4, 27, 18, 3, P0); span(29, 4, 21, P1); rect(2, 26, 2, 5, t.woodDark[0]); rect(22, 26, 2, 5, t.woodDark[0]);
        break;
      case 'tablet':
        rect(8, 24, 6, 7, t.wood[1]); rect(9, 25, 4, 5, t.olive[1]); span(26, 10, 11, t.olive[0]); span(28, 10, 12, t.olive[0]);
        rect(21, 23, 1, 3, t.bronze[0]);
        break;
      case 'abacus':
        span(25, 7, 18, t.wood[1]); span(30, 7, 18, t.wood[1]); rect(7, 26, 1, 4, t.wood[2]); rect(18, 26, 1, 4, t.wood[2]);
        span(27, 8, 17, t.wood[2]); span(29, 8, 17, t.wood[2]);
        for (const [x, y, c] of [[9, 27, t.papyrus[0]], [10, 27, t.papyrus[0]], [14, 27, t.bronze[0]], [8, 29, t.terracotta[1]], [11, 29, t.papyrus[0]], [12, 29, t.papyrus[0]], [16, 29, t.bronze[0]]] as const) put(x, y, c);
        break;
      case 'compass':
        put(21, 32, t.bronze[0]); for (const y of [33, 34, 35]) { put(20, y, t.bronze[1]); put(22, y, t.bronze[2]); }
        break;
      case 'lamp': { // lamparina acesa pendurada da mão direita (Diógenes procura alguém… ou um pedido bem definido)
        const [L0, L1, L2] = t.bronze;
        put(21, 32, L2); put(21, 33, L2); rect(19, 34, 5, 1, L1); rect(19, 35, 5, 3, L2); rect(20, 35, 3, 3, t.flame[1]); put(21, 36, t.flame[0]); span(38, 19, 23, L1); put(20, 34, L0);
        break;
      }
      case 'satchel':
        for (let y = 22; y <= 30; y++) put(17, y, t.woodDark[0]);
        rect(17, 31, 6, 5, t.wood[1]); span(31, 17, 22, t.woodDark[1]);
        break;
      default: skinItem(pen, look.item, accent, t.bronze[0]); break;
    }
  }
  if (look.item === 'staff' && !seated && !perch) { const x = back ? 2 : 23; for (let y = 3; y <= 44; y++) put(x, y, t.woodDark[0]); rect(x - 1, 1, 3, 2, t.bronze[0]); }
  if (look.item === 'spear' && !seated && !perch) { // lança de general: haste longa e ponta de bronze em folha
    const x = back ? 2 : 23; for (let y = 2; y <= 44; y++) put(x, y, t.woodDark[0]);
    put(x, -2, t.bronze[0]); rect(x - 1, -1, 3, 2, t.bronze[0]); put(x + 1, 0, t.bronze[2]); put(x, 1, t.bronze[1]);
  }

  // pescoço e cabeça (14×14, arredondada)
  rect(11, 21 + dy, 4, 1, s);
  const headRows: Array<[number, number, number]> = [[7, 9, 16], [8, 7, 18]];
  for (let y = 9; y <= 18; y++) headRows.push([y, 6, 19]);
  headRows.push([19, 7, 18], [20, 9, 16]);
  for (const [y, a, b] of headRows) span(y + hy, a, b, S);

  if (back) {
    // de costas: o cabelo cobre a cabeça; a nuca aparece nos cabelos curtos
    for (const [y, a, b] of headRows) span(y + hy, a, b, H);
    span(4 + hy, 9, 16, H); span(5 + hy, 7, 18, H); span(6 + hy, 6, 19, H);
    span(5 + hy, 9, 13, hl); rect(18, 9 + hy, 2, 10, h);
    if (look.hairStyle === 'bald') {
      for (const [y, a, b] of headRows) if (y <= 12) span(y + hy, a, b, S);
      span(4 + hy, 9, 16, S); span(5 + hy, 7, 18, S); span(6 + hy, 6, 19, S); span(6 + hy, 9, 13, shade(S, 0.12));
    }
    if (look.hairStyle === 'long') { rect(6, 21 + hy, 14, 5, H); rect(18, 21 + hy, 2, 5, h); }
    else if (look.hairStyle !== 'curly') { span(19 + hy, 8, 17, s); span(20 + hy, 9, 16, s); }
    if (look.hairStyle === 'bun') { span(1 + hy, 11, 14, H); rect(10, 2 + hy, 6, 2, H); }
    if (look.hairStyle === 'curly') { rect(4, 7 + hy, 1, 11, H); rect(21, 7 + hy, 1, 11, h); for (let x = 6; x <= 19; x += 3) put(x, 3 + hy, H); }
    if (look.hairStyle === 'ponytail') { rect(11, 19 + hy, 3, 6, H); rect(13, 19 + hy, 1, 6, h); span(19 + hy, 11, 13, t.bronze[1]); }
    hairBack(pen, look.hairStyle, H, h, hy);
  } else {
    // rosto em 3/4 (virado para a direita), traços simples e sóbrios
    rect(18, 10 + hy, 2, 9, s); span(20 + hy, 9, 16, s); // sombra da face e do queixo
    const brow = mix(H, S, 0.3);
    if (expr === 'surprised') { span(11 + hy, 9, 10, brow); span(11 + hy, 14, 15, brow); }
    else if (expr === 'angry') { put(9, 11 + hy, brow); put(10, 12 + hy, brow); put(14, 12 + hy, brow); put(15, 11 + hy, brow); }
    else if (expr === 'worried') { put(9, 12 + hy, brow); put(10, 11 + hy, brow); put(14, 11 + hy, brow); put(15, 12 + hy, brow); }
    else { span(12 + hy, 9, 10, brow); span(12 + hy, 14, 15, brow); }
    // olhos: pontos escuros 1×2; concentrado = pálpebras baixas (olhando a mesa)
    if (expr === 'focused') { span(14 + hy, 9, 10, E); span(14 + hy, 14, 15, E); }
    else { rect(10, 13 + hy, 1, 2, E); rect(15, 13 + hy, 1, 2, E); }
    put(13, 16 + hy, s); // nariz
    // cabelo de frente
    if (hairFront(pen, look.hairStyle, H, h, hl, S, hy)) { /* cabelo das skins */ }
    else if (look.hairStyle === 'bald') {
      rect(5, 12 + hy, 2, 4, H); rect(19, 12 + hy, 2, 3, H); span(8 + hy, 9, 13, shade(S, 0.12));
    } else if (look.hairStyle === 'cropped') {
      // rente: só a calota, sem mechas caindo nas têmporas
      span(5 + hy, 8, 17, H); span(6 + hy, 6, 19, H); span(7 + hy, 6, 19, H); span(8 + hy, 6, 19, H);
      rect(5, 9 + hy, 1, 3, H); rect(19, 8 + hy, 1, 2, h); span(6 + hy, 9, 12, hl);
    } else {
      span(4 + hy, 9, 16, H); span(5 + hy, 7, 18, H); span(6 + hy, 6, 19, H);
      for (const y of [7, 8, 9]) span(y + hy, 5, 20, H);
      span(10 + hy, 6, 12, H); span(11 + hy, 6, 8, H);
      rect(5, 10 + hy, 2, 5, H); rect(19, 10 + hy, 2, 2, h);
      span(5 + hy, 9, 12, hl); rect(19, 7 + hy, 2, 3, h);
      if (look.hairStyle === 'bun') { span(1 + hy, 5, 7, H); span(2 + hy, 4, 8, H); span(3 + hy, 4, 8, H); }
      if (look.hairStyle === 'curly') {
        span(3 + hy, 8, 17, H); rect(4, 6 + hy, 1, 9, H); rect(21, 6 + hy, 1, 6, h);
        for (let x = 7; x <= 18; x += 3) { put(x, 3 + hy, hl); put(x + 1, 7 + hy, h); }
      }
    }
    if (look.beard && look.beardShort) {
      // barba rente: sombra do cabelo no queixo e nas faces
      const st = mix(H, S, 0.45);
      span(18 + hy, 8, 17, st); span(19 + hy, 8, 17, st); span(20 + hy, 9, 16, st); put(17, 17 + hy, st);
    } else if (look.beard) {
      span(17 + hy, 11, 14, H); // bigode
      span(18 + hy, 7, 18, H); span(19 + hy, 7, 18, H); span(20 + hy, 8, 17, H); span(21 + hy, 10, 15, H);
      rect(17, 18 + hy, 2, 3, h);
    }
    // boca pequena; a expressão é sutil (sobrancelhas fazem a maior parte)
    if (expr === 'smile') { span(18 + hy, 12, 13, M); put(14, 17 + hy, M); }
    else if (expr === 'surprised') rect(12, 17 + hy, 2, 2, M);
    else if (expr === 'worried') { span(17 + hy, 12, 13, M); put(11, 18 + hy, M); put(14, 18 + hy, M); }
    else if (expr === 'angry') span(18 + hy, 11, 14, M);
    else span(18 + hy, 12, 13, M);
  }
  for (const draw of late) draw();
  if (look.species || look.face) speciesAndFace(pen, { species: look.species ?? 'human', face: look.face ?? 'none', hat: look.hat ?? null, kit }, S, s, back, hy, accent);
  const hw = look.headwear ?? (look.wreath ? 'wreath' : 'none');
  if (look.hat && !['none', 'wreath', 'fillet', 'petasos'].includes(hw)) skinHeadwear(pen, hw, look.hat, back, hy, accent);
  if (look.wreath || hw === 'wreath') { for (let x = 5; x <= 20; x++) put(x, 8 + hy, x % 2 ? t.gold : t.bronze[0]); for (const [x, y] of [[4, 7], [21, 7], [4, 9], [21, 9]]) put(x, y + hy, t.gold); }
  if (hw === 'fillet' && look.hairStyle !== 'bald') {
    // faixa de tecido na cor do agente, com as pontas soltas atrás
    span(8 + hy, 5, 20, D);
    if (back) rect(12, 9 + hy, 2, 3, d); else { put(4, 9 + hy, D); put(4, 10 + hy, d); }
  }
  if (hw === 'petasos') {
    // pétaso: chapéu de viagem de feltro, aba larga e copa baixa
    const F = mix(t.sand[0], t.wood[1], 0.45); const f = shade(F, -0.22);
    span(2 + hy, 9, 16, F); span(3 + hy, 8, 17, F); span(4 + hy, 7, 18, F); span(5 + hy, 7, 18, f);
    span(6 + hy, 2, 23, F); span(7 + hy, 3, 22, f); span(3 + hy, 9, 12, shade(F, 0.15));
  }

  // contorno: vazio vizinho (4-conexo) de algo preenchido
  const out = g.map((row) => row.slice());
  for (let y = 0; y < FIG_H; y++) for (let x = 0; x < FIG_W; x++) {
    if (g[y][x]) continue;
    if ((g[y - 1]?.[x]) || (g[y + 1]?.[x]) || g[y][x - 1] || g[y][x + 1]) out[y][x] = t.outline;
  }
  return out;
}

export function mirrorGrid(g: Grid): Grid { return g.map((row) => row.slice().reverse()); }

/** Altura ocupada (linhas com pixel) — usada para conferir proporções nos testes. */
export function gridExtent(g: Grid): { top: number; bottom: number } {
  let top = -1; let bottom = -1;
  g.forEach((row, y) => { if (row.some(Boolean)) { if (top < 0) top = y; bottom = y; } });
  return { top, bottom };
}

/** Linha (na grade) onde termina a cabeça, para conferir a proporção nos testes. */
export const HEAD_BOTTOM = 20 + Y0;

// ---------------- aparência de cada agente ----------------
export function hashOf(s: string): number { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; }

const ROLE_ITEMS: Array<[RegExp, Item]> = [
  [/dado|anál|anal/i, 'abacus'],
  [/document|escrit/i, 'tablet'],
  [/estrat|planej|projet|prazo/i, 'compass'],
  [/comunic|teams|whats|mensag/i, 'satchel'],
  [/pesquis|organiz|demand|central/i, 'scroll'],
  [/design|cria/i, 'tablet'],
  [/opera/i, 'scroll'],
];

export function itemForRole(role: string, h: number): Item {
  for (const [re, item] of ROLE_ITEMS) if (re.test(role)) return item;
  return (['scroll', 'tablet', 'abacus', 'compass'] as const)[h % 4];
}

/** Iconografia de cada personagem (por chave): cabelo, barba, pele e objeto de ofício. */
export const CHARACTER_LOOKS: Record<string, { skin: number; hair: string; hairStyle: HairStyle; beard: boolean; item: Item; wreath?: boolean }> = {
  aristoteles: { skin: 1, hair: '#4b3022', hairStyle: 'short', beard: true, item: 'scroll' },
  socrates: { skin: 1, hair: '#9b938a', hairStyle: 'bald', beard: true, item: 'none' },
  platao: { skin: 0, hair: '#e4dfd4', hairStyle: 'short', beard: true, item: 'scroll' },
  arquimedes: { skin: 1, hair: '#8a8580', hairStyle: 'curly', beard: true, item: 'abacus' },
  hipatia: { skin: 1, hair: '#2a1e19', hairStyle: 'bun', beard: false, item: 'tablet' },
  herodoto: { skin: 2, hair: '#2a1e19', hairStyle: 'curly', beard: true, item: 'scroll' },
  euclides: { skin: 0, hair: '#6f4a2c', hairStyle: 'short', beard: true, item: 'compass' },
  fidias: { skin: 2, hair: '#4b3022', hairStyle: 'short', beard: true, item: 'tablet' },
  hipodamo: { skin: 1, hair: '#3a2a1c', hairStyle: 'long', beard: true, item: 'compass' },
  diogenes: { skin: 2, hair: '#8a8a80', hairStyle: 'curly', beard: true, item: 'lamp' },
  hesiodo: { skin: 1, hair: '#9b938a', hairStyle: 'short', beard: true, item: 'staff', wreath: true },
  aspasia: { skin: 0, hair: '#2a1e19', hairStyle: 'long', beard: false, item: 'satchel' },
};

/**
 * Boneco sorteado do pacote gráfico pela semente (o agente guarda só a semente: "Redefinir" troca a semente). A cor
 * da roupa continua sendo a do agente — é a identidade dele na tela.
 */
export function lookFromSeed(seed: number, color: string, t: Theme, pack: GraphicPack = GRECIA_CLASSICA): Look {
  const p = rollFigure(seed, t.skins.length, t.hairs.length, pack);
  return {
    skin: t.skins[p.skin], hair: p.extraHair ?? t.hairs[p.hair], hairStyle: p.hairStyle, beard: p.beard !== 'none', beardShort: p.beard === 'short',
    drape: harmonize(color, t), chiton: t.chiton, item: p.item, wreath: p.headwear === 'wreath', headwear: p.headwear, outfit: p.outfit, hem: p.hem,
  };
}

/** Aparência do agente: a sorteada (semente), a do personagem (iconografia própria) ou, sem nenhuma, pelo nome. */
export function lookFor(a: { name: string; color: string; role?: string; key?: string | null; seed?: number | null }, t: Theme): Look {
  if (a.seed) return lookFromSeed(a.seed, a.color, t);
  const c = a.key ? CHARACTER_LOOKS[a.key] : undefined;
  if (c) {
    return { skin: t.skins[c.skin % t.skins.length], hair: c.hair, hairStyle: c.hairStyle, beard: c.beard, drape: harmonize(a.color, t), chiton: t.chiton, item: c.item, wreath: !!c.wreath };
  }
  const h = hashOf(a.name);
  const styles: HairStyle[] = ['short', 'long', 'bun', 'curly', 'short', 'bun', 'long'];
  const hairStyle = styles[(h >>> 4) % styles.length];
  return {
    skin: t.skins[h % t.skins.length],
    hair: t.hairs[(h >>> 2) % t.hairs.length],
    hairStyle,
    beard: (hairStyle === 'short' || hairStyle === 'curly') && ((h >>> 9) & 1) === 1,
    drape: harmonize(a.color, t),
    chiton: t.chiton,
    item: itemForRole(a.role ?? '', h),
    wreath: false,
  };
}

/** Alexandre Magno (o anfitrião, fundador aposentado): jovem, moreno, sem barba, cabelo revolto; armadura de general, capa vermelha e lança — sem capacete. */
export function npcLook(t: Theme): Look {
  return { skin: t.skins[2], hair: '#5a3a22', hairStyle: 'curly', beard: false, drape: ['#9b2d30', '#6e1f22'], chiton: t.chiton, item: 'spear', wreath: false, outfit: 'armor' };
}

// ---------------- sprites em cache ----------------
export interface Sprite {
  canvas: HTMLCanvasElement; ax: number; ay: number; w: number; h: number; mask: Uint8Array;
  box?: [number, number, number, number]; // retângulo ocupado (x0, y0, x1, y1) — área de clique
}

// cache com descarte do menos usado: passear pela cidade grande carrega e descarrega milhares de agentes, e cada um
// tem dezenas de poses; sem limite, a memória só crescia. A capacidade acompanha quantos bonecos estão na tela.
const cache = new Lru<Sprite>(2000);
/** Espaço para pelo menos `n` sprites de bonecos (os da tela, com folga para poses e quadros). */
export function reserveFigures(n: number): void { cache.reserve(n); }
/** Quantos sprites de bonecos estão guardados (medição). */
export function figureCacheSize(): number { return cache.size; }

/** Retângulo ocupado por pixels — área de clique generosa para figuras pequenas. */
export function gridBox(grid: Grid): [number, number, number, number] {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  grid.forEach((row, y) => row.forEach((c, x) => { if (c) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }));
  return [x0, y0, x1, y1];
}

export function gridSprite(grid: Grid, ax: number, ay: number): Sprite {
  const h = grid.length; const w = grid[0]?.length ?? 0;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const mask = new Uint8Array(w * h);
  grid.forEach((row, y) => row.forEach((col, x) => { if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); mask[y * w + x] = 1; } }));
  return { canvas: c, ax, ay, w, h, mask, box: gridBox(grid) };
}

export function figureSprite(look: Look, facing: Facing, pose: Pose, frame: number, mirror: boolean, t: Theme, expr: Expr = 'smile', gesture: Gesture = 'none'): Sprite {
  const key = `${t.id}|${JSON.stringify(look)}|${facing}|${pose}|${frame}|${mirror ? 1 : 0}|${expr}|${gesture}`;
  let sp = cache.get(key);
  if (!sp) {
    const grid = figureGrid(look, facing, pose, frame, t, expr, gesture);
    sp = gridSprite(mirror ? mirrorGrid(grid) : grid, FIG_AX, FIG_AY);
    cache.set(key, sp);
  }
  return sp;
}

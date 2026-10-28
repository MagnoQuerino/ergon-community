import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KX, KY, KZ, fitScale, insidePoly, project, unproject } from './projection.ts';
import { fillPoly, line, projector, type PixelCtx } from './raster.ts';
import { FIG_AY, HEAD_BOTTOM, figureGrid, gridBox, gridExtent, itemForRole, lookFor, mirrorGrid, npcLook } from './figures.ts';
import { ALEXANDRIA_NOITE as T } from './theme.ts';

class FakeCtx implements PixelCtx {
  fillStyle: string = '';
  px = new Map<string, string>();
  fillRect(x: number, y: number, w: number, h: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px.set(`${x + i},${y + j}`, String(this.fillStyle));
  }
}

test('projeção 2:1: x desce à direita, z desce à esquerda, altura sobe', () => {
  assert.equal(KX, 2 * KY, 'degrau 2:1');
  assert.deepEqual(project(1, 0, 0), [KX, KY]);
  assert.deepEqual(project(0, 0, 1), [-KX, KY]);
  assert.deepEqual(project(0, 1, 0), [0, -KZ]);
  for (const [x, z] of [[3, -2], [-7.5, 4], [0.6, 0.8]]) {
    const [ux, uz] = unproject(...project(x, 0, z));
    assert.ok(Math.abs(ux - x) < 0.15 && Math.abs(uz - z) < 0.15, `ida e volta de (${x}, ${z})`);
  }
});

test('ampliação é sempre inteira e limitada', () => {
  const b = { x0: -150, y0: -110, x1: 150, y1: 90 };
  assert.equal(fitScale(b, 1200, 800), 4);
  assert.equal(fitScale(b, 300, 200), 1);
  assert.equal(fitScale(b, 100, 100), 1, 'nunca menor que 1');
  assert.equal(fitScale(b, 9000, 9000), 8, 'nunca maior que 8');
});

test('polígono sem suavização: losango simétrico e quadriláteros vizinhos sem frestas nem buracos', () => {
  const g = new FakeCtx();
  fillPoly(g, [[10, 0], [20, 5], [10, 10], [0, 5]], 'a');
  const rows = new Map<number, number[]>();
  for (const k of g.px.keys()) { const [x, y] = k.split(',').map(Number); (rows.get(y) ?? rows.set(y, []).get(y)!).push(x); }
  for (const [y, xs] of rows) {
    const mid = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
    assert.equal(mid, 10, `linha ${y} centrada`);
    assert.equal(xs.length, Math.max(...xs) - Math.min(...xs) + 1, 'sem falhas na linha');
  }
  // dois ladrilhos vizinhos no piso cobrem exatamente o mesmo que um ladrilho duplo
  const P = projector(100, 100);
  const a = new FakeCtx(); const whole = new FakeCtx();
  fillPoly(a, [P(0, 0, 0), P(2, 0, 0), P(2, 0, 2), P(0, 0, 2)], 'x');
  fillPoly(a, [P(2, 0, 0), P(4, 0, 0), P(4, 0, 2), P(2, 0, 2)], 'x');
  fillPoly(whole, [P(0, 0, 0), P(4, 0, 0), P(4, 0, 2), P(0, 0, 2)], 'x');
  for (const k of whole.px.keys()) assert.ok(a.px.has(k), `pixel ${k} coberto`);
});

test('reta 2:1 sai em degraus regulares de 2 pixels', () => {
  const g = new FakeCtx();
  line(g, [0, 0], [20, 10], 'l');
  const byRow = new Map<number, number>();
  for (const k of g.px.keys()) { const y = Number(k.split(',')[1]); byRow.set(y, (byRow.get(y) ?? 0) + 1); }
  for (const [y, n] of byRow) if (y > 0 && y < 10) assert.equal(n, 2, `linha ${y}`);
});

test('personagem cabeçudo e robusto: ~44 px, cabeça grande (35–50%), pés na âncora, contorno presente', () => {
  const look = lookFor({ name: 'Helena', color: '#2f6f8f', role: 'Central de demandas' }, T);
  const g = figureGrid(look, 'front', 'stand', 0, T);
  const { top, bottom } = gridExtent(g);
  const height = bottom - top + 1;
  assert.ok(height >= 40 && height <= 48, `altura ${height}`);
  const head = (HEAD_BOTTOM - top) / height;
  assert.ok(head >= 0.35 && head <= 0.5, `proporção da cabeça ${head.toFixed(2)}`);
  assert.equal(bottom, FIG_AY, 'contorno dos pés encosta na âncora');
  assert.ok(g.flat().includes(T.outline), 'tem contorno');
  const back = figureGrid(look, 'back', 'stand', 0, T);
  assert.notDeepEqual(back, g, 'costas diferem da frente');
  assert.deepEqual(mirrorGrid(mirrorGrid(g)), g);
  const sit = gridExtent(figureGrid(look, 'front', 'sit', 0, T, 'focused'));
  assert.ok(sit.bottom - sit.top < height, 'sentado é mais baixo');
  assert.notDeepEqual(figureGrid(look, 'front', 'walk', 1, T), g, 'passo muda as pernas');
  assert.notDeepEqual(figureGrid(look, 'front', 'sit', 1, T, 'focused'), figureGrid(look, 'front', 'sit', 0, T, 'focused'), 'escrever anima a mão');
  const [x0, , x1] = gridBox(g);
  assert.ok(x1 - x0 >= 16, 'área de clique com largura útil');
  // expressões distintas no rosto
  const faces = (['smile', 'neutral', 'surprised', 'focused', 'worried'] as const).map((e) => JSON.stringify(figureGrid(look, 'front', 'stand', 0, T, e)));
  assert.equal(new Set(faces).size, 5, 'cada expressão muda o rosto');
  assert.equal(JSON.stringify(figureGrid(look, 'back', 'stand', 0, T, 'smile')), JSON.stringify(figureGrid(look, 'back', 'stand', 0, T, 'worried')), 'de costas não há rosto');
});

test('identidade: cor do agente no manto, objeto pelo papel, aparência estável', () => {
  const a = lookFor({ name: 'Teo', color: '#2d5f5a', role: 'Análise de dados' }, T);
  const b = lookFor({ name: 'Teo', color: '#2d5f5a', role: 'Análise de dados' }, T);
  assert.deepEqual(a, b, 'determinística');
  assert.equal(a.item, 'abacus');
  assert.equal(itemForRole('Documentos e escrita', 0), 'tablet');
  assert.equal(itemForRole('Comunicações (Teams/WhatsApp)', 0), 'satchel');
  assert.equal(itemForRole('Estratégia e planejamento', 0), 'compass');
  const c = lookFor({ name: 'Teo', color: '#a33b4c', role: 'x' }, T);
  assert.notEqual(c.drape[0], a.drape[0], 'manto segue a cor do agente');
  const npc = npcLook(T);
  assert.ok(npc.outfit === 'armor' && npc.item === 'spear', 'Alexandre Magno: general, com lança');
});

test('clique em polígono de parede (quadro de tarefas)', () => {
  const poly = [project(2, 2.4, -4.7), project(5, 2.4, -4.7), project(5, 1.25, -4.7), project(2, 1.25, -4.7)];
  const [cx, cy] = project(3.5, 1.8, -4.7);
  assert.ok(insidePoly(cx, cy, poly), 'clique no meio do quadro acerta o quadro');
});

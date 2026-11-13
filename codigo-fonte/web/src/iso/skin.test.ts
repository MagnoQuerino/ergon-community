import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LOTS } from '../../../shared/city.ts';
import { OFFICIAL_SKINS } from '../../../shared/skins-oficiais.ts';
import { SKIN_DECOR, SKIN_FACES, SKIN_HAIR, SKIN_HEADWEAR, SKIN_ITEMS, SKIN_SPECIES, rollSkinLook, type SkinData } from '../../../shared/skin.ts';
import { Town, type StructureIn } from '../world/town.ts';
import { FIG_H, FIG_W, figureGrid, type Expr, type Facing, type Gesture, type Pose } from './figures.ts';
import { agentSkinLook, lookFromSkin, skinPack, skinPet, skinTheme } from './skin.ts';
import { THEMES, type Theme } from './theme.ts';

const HEX = /^#[0-9a-f]{6}$/i;
const POSES: Array<[Pose, Facing, Gesture]> = [['stand', 'front', 'none'], ['walk', 'front', 'none'], ['walk', 'back', 'none'], ['sit', 'front', 'none'], ['perch', 'front', 'none'], ['stand', 'front', 'talk'], ['stand', 'front', 'joy'], ['stand', 'front', 'think']];
const colors = (g: (string | null)[][]) => new Set(g.flat().filter(Boolean) as string[]);

function themeOk(t: Theme, label: string) {
  for (const [k, v] of Object.entries(t)) {
    if (k === 'id' || k === 'name' || k === 'skin') continue;
    if (k === 'grass' && v === null) continue;
    const vals = typeof v === 'string' ? [v] : Array.isArray(v) ? v.flat() : Object.values(v as object);
    for (const c of vals) assert.match(String(c), HEX, `${label}: cor ${k} = ${c}`);
  }
}

test('cada skin oficial gera o tema inteiro de dia e de noite, com o estilo dela', () => {
  for (const sk of OFFICIAL_SKINS) for (const mode of ['dia', 'noite'] as const) {
    const t = skinTheme(THEMES[mode], sk, mode);
    themeOk(t, `${sk.name} ${mode}`);
    assert.ok(t.id.includes(sk.id), 'cache por skin');
    assert.equal(t.skin?.night, mode === 'noite');
    assert.equal(t.skin?.arch.roof, sk.arch.roof);
  }
});

test('os personagens e os bonecos sorteados de cada skin desenham em todas as poses, sem sair da grade', () => {
  for (const sk of OFFICIAL_SKINS) {
    const t = skinTheme(THEMES.dia, sk, 'dia');
    const looks = [...sk.characters.map((c) => c.look), ...Array.from({ length: 25 }, (_, i) => rollSkinLook(sk, 1000 + i * 7919))];
    for (const sl of looks) {
      const look = lookFromSkin(sl, sk, '#3f7fb5', t);
      for (const [pose, facing, gesture] of POSES) {
        const g = figureGrid(look, facing, pose, 0, t, 'smile' as Expr, gesture);
        assert.equal(g.length, FIG_H); assert.equal(g[0].length, FIG_W);
        assert.ok(colors(g).has(look.skin[0]), `${sk.name}/${sl.outfit}/${pose}: a pele aparece`);
      }
      const front = colors(figureGrid(look, 'front', 'stand', 0, t));
      const outfit = sk.figures.outfits.find((o) => o.id === sl.outfit)!;
      // a cor do agente aparece: na roupa (quando a skin pediu) ou no distintivo do peito
      assert.ok(front.has(look.drape[0]) || front.has(look.drape[1]), `${sk.name}/${outfit.id}: identidade do agente visível`);
    }
  }
});

test('todo o vocabulário de cabelos, chapéus, rostos, espécies e objetos desenha', () => {
  const sk = OFFICIAL_SKINS[1];
  const t = skinTheme(THEMES.noite, sk, 'noite');
  const base = sk.characters[0].look;
  for (const hairStyle of SKIN_HAIR) for (const headwear of SKIN_HEADWEAR) {
    const g = figureGrid(lookFromSkin({ ...base, hairStyle, headwear }, sk, '#a04070', t), 'front', 'stand', 0, t);
    assert.ok(colors(g).size > 5, `${hairStyle}/${headwear}`);
    figureGrid(lookFromSkin({ ...base, hairStyle, headwear }, sk, '#a04070', t), 'back', 'walk', 1, t);
  }
  for (const face of SKIN_FACES) for (const species of SKIN_SPECIES) for (const item of SKIN_ITEMS) {
    const g = figureGrid(lookFromSkin({ ...base, face, species, item }, sk, '#a04070', t), 'front', 'stand', 0, t);
    assert.ok(colors(g).size > 5, `${face}/${species}/${item}`);
  }
  // espécies mudam o boneco: orelha de elfo, presas de orc
  const humano = figureGrid(lookFromSkin({ ...base, species: 'human' }, sk, '#a04070', t), 'front', 'stand', 0, t);
  const elfo = figureGrid(lookFromSkin({ ...base, species: 'elf' }, sk, '#a04070', t), 'front', 'stand', 0, t);
  assert.notDeepEqual(humano, elfo);
});

function city(sk: SkinData | null): Town {
  const structs: StructureIn[] = Object.entries(DEFAULT_LOTS).map(([kind, [i, j]]) => ({ id: `s-${kind}`, kind, name: kind, i, j, floors: kind === 'stoa' ? [{ id: 'f0', level: 0, slots: 6 }] : [] }));
  return new Town(structs, sk ? skinPack(sk) : undefined);
}

test('a paisagem que nasce com a cidade sai da skin (borda, lotes livres e cruzamentos)', () => {
  for (const sk of OFFICIAL_SKINS) {
    const allowed = new Set<string>([...sk.decor.border.map(([k]) => k), ...sk.decor.lot.map(([k]) => k), sk.decor.junction]);
    const town = city(sk);
    assert.ok(town.decor.length > 10, `${sk.name}: paisagem gerada`);
    for (const d of town.decor) { assert.ok(allowed.has(d.kind), `${sk.name}: ${d.kind} fora da skin`); assert.ok((SKIN_DECOR as readonly string[]).includes(d.kind)); }
    assert.deepEqual(city(sk).decor, town.decor, 'mesma cidade, mesma paisagem');
  }
});

test('o mesmo agente veste sempre o mesmo boneco e o pet da skin é estável', () => {
  const sk = OFFICIAL_SKINS[4];
  const t = skinTheme(THEMES.dia, sk, 'dia');
  const skin = { data: sk, characters: new Map([['agt-1', 0]]) };
  assert.deepEqual(agentSkinLook({ id: 'agt-2', name: 'X', color: '#336699' }, skin, t), agentSkinLook({ id: 'agt-2', name: 'X', color: '#336699' }, skin, t));
  assert.equal(agentSkinLook({ id: 'agt-1', name: 'X', color: '#336699' }, skin, t).hairStyle, sk.characters[0].look.hairStyle, 'personagem da skin');
  const pets = Array.from({ length: 40 }, (_, i) => skinPet(`agt-${i}`, sk));
  assert.ok(pets.filter(Boolean).length > 20, 'Vila Ronrom: gatos para quase todo mundo');
  assert.ok(pets.every((p) => !p || p.species === 'gato'));
  assert.deepEqual(skinPet('agt-3', sk), skinPet('agt-3', sk));
});

// ---------- etiquetas da Cidade legíveis em toda skin (shared/legibilidade.ts) ----------
import { contrast, MIN_TEXTO } from '../lib/contraste.ts';
import { ETIQUETAS_DE_FABRICA, legibilizarSkin } from '../../../shared/legibilidade.ts';
import { deriveThemeColors, validateSkin } from '../../../shared/skin.ts';
import { parseColor } from '../lib/contraste.ts';

const hsl = (h: string) => { const [r, g, b] = parseColor(h)!.rgb.map((x) => x / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn; const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0; const h0 = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h0 * 60, s]; };
const tom = (h: string) => hsl(h)[0]; const sat = (h: string) => hsl(h)[1];
import { comEtiquetasLegiveis } from './skin.ts';

const etiquetas = (t: Theme) => [t.papyrus[0], t.papyrus[1], t.marks.waiting].map((c) => contrast(t.outline, c));

test('etiquetas da Cidade: as cores de fábrica que o validador usa são as do tema da Cidade', () => {
  for (const m of ['dia', 'noite'] as const) {
    assert.deepEqual(ETIQUETAS_DE_FABRICA[m], { outline: THEMES[m].outline, papyrus: THEMES[m].papyrus, marks: THEMES[m].marks });
    for (const r of etiquetas(THEMES[m])) assert.ok(r >= MIN_TEXTO, `${m}: ${r.toFixed(2)}`);
  }
});

test('etiquetas da Cidade: as 6 skins oficiais se leem de dia e de noite (≥ 4,5), corrigidas sozinhas onde precisava', () => {
  assert.equal(OFFICIAL_SKINS.length, 6);
  let corrigidas = 0;
  for (const sk of OFFICIAL_SKINS) for (const mode of ['dia', 'noite'] as const) {
    const t = skinTheme(THEMES[mode], sk, mode);
    for (const r of etiquetas(t)) assert.ok(r >= MIN_TEXTO, `${sk.id} ${mode}: ${r.toFixed(2)}`);
    // o contorno (que desenha a cidade inteira) não muda: só o fundo da etiqueta
    const spec = sk.palette[mode];
    assert.equal(t.outline, ({ ...deriveThemeColors(spec.seeds), ...(spec.colors ?? {}) } as { outline: string }).outline);
  }
  // a auditoria achou cromo-9 de noite, vila-ronrom e enseada-coral de dia abaixo de 4,5: o validador corrige e avisa
  for (const sk of OFFICIAL_SKINS) corrigidas += legibilizarSkin(sk).ajustes.length;
  assert.ok(corrigidas >= 3, `ajustes: ${corrigidas}`);
});

test('etiquetas da Cidade: a correção da skin é estável (corrigir de novo não muda nada) e mantém o tom', () => {
  for (const sk of OFFICIAL_SKINS) {
    const uma = legibilizarSkin(sk);
    assert.deepEqual(legibilizarSkin(uma.skin).ajustes, [], sk.id);
    for (const a of uma.ajustes) { assert.notEqual(a.de, a.para); assert.ok(Math.abs(tom(a.de) - tom(a.para)) < 4 || sat(a.de) < 0.08, `${sk.id}: ${a.de} → ${a.para} mudou de tom`); }
    // a skin corrigida passa na validação de sempre
    assert.equal(validateSkin(uma.skin).ok, true, sk.id);
  }
  // tema com contorno claro demais: as etiquetas ganham fundo mais escuro e se leem
  const t = comEtiquetasLegiveis({ ...THEMES.dia, outline: '#8a8a8a' }, 'dia');
  for (const r of etiquetas(t)) assert.ok(r >= MIN_TEXTO, r.toFixed(2));
  assert.equal(comEtiquetasLegiveis(THEMES.noite, 'noite'), THEMES.noite);
});

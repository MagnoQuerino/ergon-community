/**
 * Skin ativa na cidade (shared/skin.ts): o tema de cores vem das cores-semente da skin (dia ou noite), os agentes vestem
 * o personagem da skin ou um boneco sorteado dela (estável pela semente do agente), os pets e a paisagem gerada saem da
 * skin. Tudo aqui é aparência: nada muda função, ferramenta ou dado de ninguém.
 */
import { deriveThemeColors, hashText, pickWeighted, rollSkinLook, skinRng, type ColorRef, type SkinData, type SkinLook } from '../../../shared/skin.ts';
import { GRECIA_CLASSICA, type GraphicPack } from '../world/pack.ts';
import type { Kit } from './figureParts.ts';
import type { Look } from './figures.ts';
import { harmonize, shade, type Theme, type ThemeId } from './theme.ts';

export interface ActiveSkin { data: SkinData; characters: Map<string, number> }

/** Tema da cidade com a paleta da skin (no modo pedido) e o estilo dela para prédios e chão. */
export function skinTheme(base: Theme, skin: SkinData, mode: ThemeId): Theme {
  const spec = skin.palette[mode] ?? skin.palette.dia;
  const out: Record<string, unknown> = { ...base, ...deriveThemeColors(spec.seeds) };
  for (const [k, v] of Object.entries(spec.colors ?? {})) if (k in base) out[k] = v;
  out.id = `${base.id}+${skin.id}`;
  out.name = `${skin.name} (${mode === 'noite' ? 'noite' : 'dia'})`;
  out.skin = { id: skin.id, arch: skin.arch, water: skin.ground.water, roadLine: skin.ground.roadLine, swap: skin.decor.swap, night: mode === 'noite' };
  return out as unknown as Theme;
}

/** Pacote gráfico da paisagem gerada (borda, lotes livres e cruzamentos). */
export function skinPack(skin: SkinData): GraphicPack {
  return { id: skin.id, name: skin.name, figure: GRECIA_CLASSICA.figure, decor: { border: skin.decor.border, lot: skin.decor.lot, junction: skin.decor.junction } };
}

const pair = (c: string): [string, string] => [c, shade(c, -0.22)];

function hatColor(hw: string, kit: Kit, agent: [string, string], t: Theme): [string, string] | null {
  switch (hw) {
    case 'helmet': return pair(kit.top === 'plate' ? '#a8aeb6' : kit.top === 'uniform' ? shade(kit.T[0], -0.08) : '#6a7048');
    case 'cap': return pair(kit.top === 'uniform' ? kit.T[0] : agent[0]);
    case 'sunhat': return ['#e8cf8a', '#c9ab62'];
    case 'hood': return pair(kit.T[0]);
    case 'circlet': case 'crown': return [t.gold, t.bronze[1]];
    case 'headphones': return ['#2b2b33', '#1c1c22'];
    case 'visor': return pair(kit.A);
    case 'beret': case 'beanie': case 'wizard': case 'bandana': return agent;
    default: return null;
  }
}

/** Aparência (figures.ts) de um visual da skin, com a cor do agente onde a skin pediu 'agente'. */
export function lookFromSkin(sl: SkinLook, skin: SkinData, agentColor: string, t: Theme): Look {
  const outfit = skin.figures.outfits.find((o) => o.id === sl.outfit) ?? skin.figures.outfits[0];
  const agent = harmonize(agentColor, t);
  const ref = (c: ColorRef): [string, string] => (c === 'agente' ? agent : pair(c));
  const k = outfit.kit;
  const usesAgent = [k.colors.top, k.colors.bottom, k.colors.accent].includes('agente');
  const kit: Kit = { top: k.top, bottom: k.bottom, sleeves: k.sleeves, shoes: k.shoes, detail: k.detail, T: ref(k.colors.top), B: ref(k.colors.bottom), A: ref(k.colors.accent)[0], badge: usesAgent ? null : agent[0] };
  const tones = skin.figures.speciesSkins[sl.species] ?? t.skins;
  return {
    skin: tones[sl.skin % tones.length], hair: sl.hair, hairStyle: sl.hairStyle, beard: sl.beard !== 'none', beardShort: sl.beard === 'short',
    drape: agent, chiton: t.chiton, item: sl.item, wreath: false, headwear: sl.headwear, kit, species: sl.species, face: sl.face, hat: hatColor(sl.headwear, kit, agent, t),
  };
}

/** O agente veste o personagem da skin (se houver um para ele) ou um boneco sorteado da skin. */
export function agentSkinLook(a: { id: string; name: string; color: string; seed?: number | null }, skin: ActiveSkin, t: Theme): Look {
  const idx = skin.characters.get(a.id);
  const sl = idx !== undefined && skin.data.characters[idx] ? skin.data.characters[idx].look : rollSkinLook(skin.data, a.seed || hashText(a.id || a.name));
  return lookFromSkin(sl, skin.data, a.color, t);
}

const PET_COLORS: Record<string, string[]> = { gato: ['#e8a050', '#3a3a3a', '#f2efe8', '#8a8a8a', '#c07a30'], coruja: ['#b08a5a', '#8a7a6a'], cao: ['#c8a070', '#6a4a2a', '#f2efe8'], tartaruga: ['#6f8f4e', '#8a9a5a'] };
/** Pet sorteado da skin para o agente (estável pelo id), ou nada. */
export function skinPet(agentId: string, skin: SkinData): { species: string; color: string } | null {
  const r = skinRng(hashText(agentId) ^ 0x2b1d);
  if (r() >= skin.pets.chance) return null;
  const species = pickWeighted(r, skin.pets.species);
  const cs = PET_COLORS[species] ?? ['#c8a070'];
  return { species, color: cs[Math.floor(r() * cs.length)] };
}

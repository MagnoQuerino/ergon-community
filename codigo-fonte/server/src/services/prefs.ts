/**
 * Preferências de quem usa (por pessoa, dentro do workspace): dicas ligadas ou não, dicas já dispensadas e se o
 * tour inicial já foi feito. Ficam nas configurações do workspace com a chave `prefs:<usuário>`.
 */
import type { Db } from '../db/db.ts';
import { getSetting, setSetting } from './sectors.ts';

/** updateNotice: ao abrir o Ergon, procurar versão nova e mostrar "Atualização disponível" (ligado por padrão) */
/** cityCalm: cidade em modo calmo; musicVolume/musicShuffle: a música ambiente (nunca liga sozinha: não há "tocando" guardado) */
/** cityBarCollapsed: a barra de cima da Cidade recolhida (escolha da pessoa, não do navegador: na multiconta não passa de uma para outra) */
export interface Prefs { tips: boolean; dismissed: string[]; tourDone: boolean; updateNotice: boolean; cityCalm: boolean; musicVolume: number; musicShuffle: boolean; cityBarCollapsed: boolean }
const DEFAULT: Prefs = { tips: true, dismissed: [], tourDone: false, updateNotice: true, cityCalm: false, musicVolume: 0.5, musicShuffle: false, cityBarCollapsed: false };
const MAX_DISMISSED = 200;

export function readPrefs(db: Db, workspaceId: string, userId: string): Prefs {
  try {
    const v = JSON.parse(getSetting(db, workspaceId, `prefs:${userId}`) ?? '{}') as Partial<Prefs>;
    return {
      tips: typeof v.tips === 'boolean' ? v.tips : DEFAULT.tips,
      dismissed: Array.isArray(v.dismissed) ? v.dismissed.map(String).slice(0, MAX_DISMISSED) : [],
      tourDone: v.tourDone === true,
      updateNotice: v.updateNotice !== false,
      cityCalm: v.cityCalm === true,
      musicVolume: typeof v.musicVolume === 'number' && v.musicVolume >= 0 && v.musicVolume <= 1 ? v.musicVolume : DEFAULT.musicVolume,
      musicShuffle: v.musicShuffle === true,
      cityBarCollapsed: v.cityBarCollapsed === true,
    };
  } catch { return { ...DEFAULT, dismissed: [] }; }
}

/** Atualiza só o que veio; `dismiss` acrescenta dicas dispensadas e `resetTips` traz todas de volta. */
export function writePrefs(db: Db, workspaceId: string, userId: string, patch: Partial<Prefs> & { dismiss?: string[]; resetTips?: boolean }): Prefs {
  const cur = readPrefs(db, workspaceId, userId);
  const dismissed = patch.resetTips ? [] : [...new Set([...(patch.dismissed ?? cur.dismissed), ...(patch.dismiss ?? [])])].slice(-MAX_DISMISSED);
  const next: Prefs = { tips: patch.tips ?? cur.tips, dismissed, tourDone: patch.tourDone ?? cur.tourDone, updateNotice: patch.updateNotice ?? cur.updateNotice,
    cityCalm: patch.cityCalm ?? cur.cityCalm, musicVolume: patch.musicVolume ?? cur.musicVolume, musicShuffle: patch.musicShuffle ?? cur.musicShuffle,
    cityBarCollapsed: patch.cityBarCollapsed ?? cur.cityBarCollapsed };
  setSetting(db, workspaceId, `prefs:${userId}`, JSON.stringify(next));
  return next;
}

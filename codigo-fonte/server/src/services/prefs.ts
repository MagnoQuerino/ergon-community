/**
 * Preferências de quem usa (por pessoa, dentro do workspace): dicas ligadas ou não, dicas já dispensadas e se o
 * tour inicial já foi feito. Ficam nas configurações do workspace com a chave `prefs:<usuário>`. O idioma da tela é a
 * exceção: é da pessoa em todos os workspaces dela (coluna users.lang), para trocar de workspace não trocar a língua.
 */
import type { Db } from '../db/db.ts';
import { getSetting, setSetting } from './sectors.ts';

/** updateNotice: ao abrir o Ergon, procurar versão nova e mostrar "Atualização disponível" (ligado por padrão) */
/** cityCalm: cidade em modo calmo; musicVolume/musicShuffle: a música ambiente (nunca liga sozinha: não há "tocando" guardado) */
/** lang: o idioma da tela escolhido pela pessoa (só 'pt-BR' ou 'en'), o mesmo em todos os workspaces; sem escolha fica de fora */
/** cityBarCollapsed: a barra de cima da Cidade recolhida (escolha da pessoa, não do navegador: na multiconta não passa de uma para outra) */
export interface Prefs { tips: boolean; dismissed: string[]; tourDone: boolean; updateNotice: boolean; cityCalm: boolean; musicVolume: number; musicShuffle: boolean; cityBarCollapsed: boolean; lang?: Idioma }
type PrefsDoWorkspace = Omit<Prefs, 'lang'>;
const DEFAULT: PrefsDoWorkspace = { tips: true, dismissed: [], tourDone: false, updateNotice: true, cityCalm: false, musicVolume: 0.5, musicShuffle: false, cityBarCollapsed: false };
const MAX_DISMISSED = 200;
export type Idioma = 'pt-BR' | 'en';
export const IDIOMAS: readonly Idioma[] = ['pt-BR', 'en'];
const ehIdioma = (v: unknown): v is Idioma => v === 'pt-BR' || v === 'en';

/** O idioma escolhido pela pessoa (o mesmo em todos os workspaces dela); sem escolha, undefined. */
export function readLang(db: Db, userId: string): Idioma | undefined {
  const v = db.get<{ lang: string | null }>('SELECT lang FROM users WHERE id = ?', userId)?.lang;
  return ehIdioma(v) ? v : undefined;
}

function readWorkspacePrefs(db: Db, workspaceId: string, userId: string): PrefsDoWorkspace {
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

export function readPrefs(db: Db, workspaceId: string, userId: string): Prefs {
  const lang = readLang(db, userId);
  return { ...readWorkspacePrefs(db, workspaceId, userId), ...(lang ? { lang } : {}) };
}

/** Atualiza só o que veio; `dismiss` acrescenta dicas dispensadas e `resetTips` traz todas de volta. O idioma vai para a pessoa. */
export function writePrefs(db: Db, workspaceId: string, userId: string, patch: Partial<Prefs> & { dismiss?: string[]; resetTips?: boolean }): Prefs {
  const cur = readWorkspacePrefs(db, workspaceId, userId);
  const dismissed = patch.resetTips ? [] : [...new Set([...(patch.dismissed ?? cur.dismissed), ...(patch.dismiss ?? [])])].slice(-MAX_DISMISSED);
  const next: PrefsDoWorkspace = { tips: patch.tips ?? cur.tips, dismissed, tourDone: patch.tourDone ?? cur.tourDone, updateNotice: patch.updateNotice ?? cur.updateNotice,
    cityCalm: patch.cityCalm ?? cur.cityCalm, musicVolume: patch.musicVolume ?? cur.musicVolume, musicShuffle: patch.musicShuffle ?? cur.musicShuffle,
    cityBarCollapsed: patch.cityBarCollapsed ?? cur.cityBarCollapsed };
  return db.tx(() => {
    if (ehIdioma(patch.lang)) db.run('UPDATE users SET lang = ? WHERE id = ?', patch.lang, userId);
    setSetting(db, workspaceId, `prefs:${userId}`, JSON.stringify(next));
    const lang = readLang(db, userId);
    return { ...next, ...(lang ? { lang } : {}) };
  });
}

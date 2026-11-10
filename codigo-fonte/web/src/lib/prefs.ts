// Preferências da pessoa (dicas e tour), guardadas no servidor por usuário. Um pequeno armazém para todas as telas
// lerem o mesmo valor; cada mudança vai ao servidor e já aparece na tela (sem esperar a resposta).
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import type { Prefs } from './types.ts';
import { setIdioma, usarIdiomaDaPessoa, type Idioma } from '../i18n/index.ts';

let current: Prefs = { tips: true, dismissed: [], tourDone: false, updateNotice: true, cityCalm: false, musicVolume: 0.5, musicShuffle: false, cityBarCollapsed: false };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/**
 * As preferências que chegaram com a pessoa (ao entrar): o idioma dela vale na hora (a promessa resolve com o dicionário
 * dele já baixado; a ordem está em i18n/index.ts). O que ainda não estava no servidor vai para lá agora.
 */
export function initPrefs(p: Prefs | undefined, quem: string | null = null): Promise<void> {
  if (!p) return Promise.resolve();
  current = { ...current, ...p, updateNotice: p.updateNotice !== false };
  emit();
  const { pronto, gravar } = usarIdiomaDaPessoa(p.lang, quem);
  if (gravar) savePrefs({ lang: gravar });
  return pronto;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
}

type Patch = Partial<Prefs> & { dismiss?: string[]; resetTips?: boolean };
export function savePrefs(patch: Patch) {
  const dismissed = patch.resetTips ? [] : [...new Set([...current.dismissed, ...(patch.dismiss ?? [])])];
  current = { ...current, tips: patch.tips ?? current.tips, dismissed, tourDone: patch.tourDone ?? current.tourDone, updateNotice: patch.updateNotice ?? current.updateNotice,
    cityCalm: patch.cityCalm ?? current.cityCalm, musicVolume: patch.musicVolume ?? current.musicVolume, musicShuffle: patch.musicShuffle ?? current.musicShuffle,
    cityBarCollapsed: patch.cityBarCollapsed ?? current.cityBarCollapsed, lang: patch.lang ?? current.lang };
  emit();
  void api.put<Prefs>('/api/me/prefs', patch).then((p) => { current = p; emit(); }).catch(() => {});
}

/** Português ou inglês, escolhido pela pessoa: a tela troca na hora e a escolha fica nela (servidor) e neste navegador. */
export function escolherIdioma(l: Idioma) {
  setIdioma(l);
  savePrefs({ lang: l });
}

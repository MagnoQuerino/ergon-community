// Preferências da pessoa (dicas e tour), guardadas no servidor por usuário. Um pequeno armazém para todas as telas
// lerem o mesmo valor; cada mudança vai ao servidor e já aparece na tela (sem esperar a resposta).
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import type { Prefs } from './types.ts';

let current: Prefs = { tips: true, dismissed: [], tourDone: false };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function initPrefs(p: Prefs | undefined) { if (p) { current = p; emit(); } }

export function usePrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
}

type Patch = Partial<Prefs> & { dismiss?: string[]; resetTips?: boolean };
export function savePrefs(patch: Patch) {
  const dismissed = patch.resetTips ? [] : [...new Set([...current.dismissed, ...(patch.dismiss ?? [])])];
  current = { tips: patch.tips ?? current.tips, dismissed, tourDone: patch.tourDone ?? current.tourDone };
  emit();
  void api.put<Prefs>('/api/me/prefs', patch).then((p) => { current = p; emit(); }).catch(() => {});
}

// Tema da plataforma inteira, o mesmo da cidade: claro (dia), escuro (noite) ou automático — que segue o relógio da
// cidade (isDarkHour: escuro das 19h às 6h). Trocar na cidade troca a plataforma, e vice-versa. Guardado neste
// navegador (é uma preferência de tela, como o tamanho da janela).
import { useSyncExternalStore } from 'react';
import { isDarkHour } from '../iso/life.ts';

export type ThemeMode = 'auto' | 'dia' | 'noite';
export type ThemeId = 'dia' | 'noite';
const KEY = 'ergon.themeMode';

const read = (): ThemeMode => { try { const v = localStorage.getItem(KEY); return v === 'dia' || v === 'noite' ? v : 'auto'; } catch { return 'auto'; } };
let mode: ThemeMode = read();
let hour = new Date().getHours();
const subs = new Set<() => void>();

/** O tema que vale agora (no automático, pelo relógio). */
export const themeOf = (m: ThemeMode, h: number): ThemeId => (m === 'auto' ? (isDarkHour(h) ? 'noite' : 'dia') : m);

function apply(): void {
  if (typeof document === 'undefined') return;
  const dark = themeOf(mode, hour) === 'noite';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#12151b' : '#f4efe6');
}
const emit = () => { apply(); subs.forEach((f) => f()); };

/** Liga o tema (uma vez, no início) e o relógio do automático. */
export function startTheme(): () => void {
  apply();
  const t = window.setInterval(() => { const h = new Date().getHours(); if (h !== hour) { hour = h; emit(); } }, 60_000);
  return () => window.clearInterval(t);
}

export function setThemeMode(m: ThemeMode): void {
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* sem armazenamento: vale só nesta visita */ }
  emit();
}

export const THEME_NEXT: Record<ThemeMode, ThemeMode> = { auto: 'dia', dia: 'noite', noite: 'auto' };
export const THEME_LABEL: Record<ThemeMode, string> = {
  auto: 'Tema automático: claro de dia, escuro à noite (o relógio da cidade)', dia: 'Tema claro (sempre dia)', noite: 'Tema escuro (sempre noite)',
};
export const THEME_ICON: Record<ThemeMode, string> = { auto: 'auto', dia: 'sun', noite: 'moon' };

let snap = { mode, theme: themeOf(mode, hour), hour };
/** Modo escolhido e o tema de agora (a cidade usa o mesmo). */
export function useTheme(): { mode: ThemeMode; theme: ThemeId; hour: number } {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => {
    if (snap.mode !== mode || snap.hour !== hour) snap = { mode, theme: themeOf(mode, hour), hour };
    return snap;
  });
}

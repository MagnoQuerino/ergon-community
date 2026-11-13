// Tema da plataforma inteira, o mesmo da cidade: claro (dia), escuro (noite), automático — que segue o relógio da
// cidade (isDarkHour: escuro das 19h às 6h) — ou alto contraste (texto preto sobre branco, 7:1 ou mais, contornos
// fortes). No automático, o alto contraste liga sozinho quando o sistema pede mais contraste (prefers-contrast: more,
// ou as cores forçadas do Windows). Trocar na cidade troca a plataforma, e vice-versa. Guardado neste navegador (é uma
// preferência de tela, como o tamanho da janela). A Cidade não tem desenho próprio de alto contraste: nele, fica de dia.
import { useSyncExternalStore } from 'react';
import { isDarkHour } from '../iso/life.ts';
import { t } from '../i18n/index.ts';

export type ThemeMode = 'auto' | 'dia' | 'noite' | 'contraste';
export type ThemeId = 'dia' | 'noite';
const KEY = 'ergon.themeMode';

const read = (): ThemeMode => { try { const v = localStorage.getItem(KEY); return v === 'dia' || v === 'noite' || v === 'contraste' ? v : 'auto'; } catch { return 'auto'; } };
/** O sistema pede mais contraste ("aumentar contraste" no Windows, macOS e Linux) ou está nas cores forçadas do Windows. */
const MAIS_CONTRASTE = '(prefers-contrast: more), (forced-colors: active)';
const pedeContraste = (): boolean => { try { return typeof matchMedia === 'function' && matchMedia(MAIS_CONTRASTE).matches; } catch { return false; } };
let mode: ThemeMode = read();
let hour = new Date().getHours();
let sistema = pedeContraste();
const subs = new Set<() => void>();

/** Alto contraste agora: escolhido, ou pedido pelo sistema com o tema no automático. */
export const contrasteDe = (m: ThemeMode, pedido: boolean): boolean => m === 'contraste' || (m === 'auto' && pedido);
/** O tema da Cidade agora (no automático, pelo relógio; no alto contraste, de dia). */
export const themeOf = (m: ThemeMode, h: number, pedido = false): ThemeId => (contrasteDe(m, pedido) ? 'dia' : m === 'auto' ? (isDarkHour(h) ? 'noite' : 'dia') : m === 'noite' ? 'noite' : 'dia');
/** O data-theme da página: light, dark ou contraste (styles.css tem um bloco de cores para cada). */
export const dataThemeOf = (m: ThemeMode, h: number, pedido = false): 'light' | 'dark' | 'contraste' => (contrasteDe(m, pedido) ? 'contraste' : themeOf(m, h) === 'noite' ? 'dark' : 'light');
const COR_DA_BARRA = { light: '#f4efe6', dark: '#12151b', contraste: '#ffffff' } as const;

function apply(): void {
  if (typeof document === 'undefined') return;
  const t = dataThemeOf(mode, hour, sistema);
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COR_DA_BARRA[t]);
}
const emit = () => { apply(); subs.forEach((f) => f()); };

/** Liga o tema (uma vez, no início) e o relógio do automático. */
export function startTheme(): () => void {
  apply();
  const t = window.setInterval(() => { const h = new Date().getHours(); if (h !== hour) { hour = h; emit(); } }, 60_000);
  // o pedido do sistema muda com o app aberto (a pessoa liga o contraste no Windows): segue na hora
  let mq: MediaQueryList | null = null;
  const mudou = () => { const v = pedeContraste(); if (v !== sistema) { sistema = v; emit(); } };
  try { mq = matchMedia(MAIS_CONTRASTE); mq.addEventListener('change', mudou); } catch { mq = null; }
  return () => { window.clearInterval(t); mq?.removeEventListener('change', mudou); };
}

export function setThemeMode(m: ThemeMode): void {
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* sem armazenamento: vale só nesta visita */ }
  emit();
}

export const THEME_NEXT: Record<ThemeMode, ThemeMode> = { auto: 'dia', dia: 'noite', noite: 'contraste', contraste: 'auto' };
/** O nome do tema no idioma atual: inteiro (dica do botão) ou curto (o item do menu). */
export const rotuloDoTema = (m: ThemeMode, curto = false): string => (curto ? t(`geral.tema.${m}Curto`) : t(`geral.tema.${m}`));
export const THEME_ICON: Record<ThemeMode, string> = { auto: 'auto', dia: 'sun', noite: 'moon', contraste: 'contraste' };

let snap = { mode, theme: themeOf(mode, hour, sistema), hour, contraste: contrasteDe(mode, sistema) };
/** Modo escolhido, o tema de agora (a cidade usa o mesmo) e se o alto contraste está valendo. */
export function useTheme(): { mode: ThemeMode; theme: ThemeId; hour: number; contraste: boolean } {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => {
    const c = contrasteDe(mode, sistema);
    if (snap.mode !== mode || snap.hour !== hour || snap.contraste !== c) snap = { mode, theme: themeOf(mode, hour, sistema), hour, contraste: c };
    return snap;
  });
}

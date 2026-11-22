// A fala dos agentes (rc.49): a resposta lida em voz alta, cada agente com a sua voz. Primeiro a voz da equipe (o Piper ou o
// edge-tts da ponte, pela rota /api/recursos/voz/falar, com a voz do agente); quando a equipe não tem voz, a voz do próprio
// sistema (a fala do navegador: no Windows, as vozes do Windows), também com uma voz e um tom por agente. Assim toda
// conversa por voz tem resposta falada.
import { ApiError, api } from './api.ts';
import { textoFalado } from './conversa-voz.ts';
import { RECURSOS } from './recursos.ts';

/** Um número fixo para cada agente (pelo nome): escolhe a voz e o tom da fala do sistema. */
export function perfilDoNome(nome: string): number {
  let h = 2166136261;
  for (const c of String(nome ?? '').normalize('NFC')) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return (h >>> 0) % 997;
}

/** tom e ritmo da fala do sistema, por perfil (vozes iguais ainda soam diferentes) */
const TONS: ReadonlyArray<readonly [number, number]> = [[1, 1], [0.8, 0.98], [1.2, 1.04], [0.9, 1.06], [1.1, 0.95], [0.72, 1.0], [1.3, 1.0]];

export const temFalaDoSistema = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** as vozes do sistema chegam depois do carregamento em alguns navegadores */
function vozesDoSistema(): Promise<SpeechSynthesisVoice[]> {
  const s = window.speechSynthesis;
  const ja = s.getVoices();
  if (ja.length) return Promise.resolve(ja);
  return new Promise((ok) => {
    const fim = () => { s.removeEventListener('voiceschanged', fim); ok(s.getVoices()); };
    s.addEventListener('voiceschanged', fim);
    window.setTimeout(fim, 1500);
  });
}

/** A voz do sistema para o idioma (pt-BR, en-US...) e o perfil: as do idioma exato primeiro, depois as da língua. */
export function escolherVoz<V extends { lang: string; name: string; localService?: boolean }>(vozes: readonly V[], idioma: string, perfil: number): V | null {
  const exato = idioma.toLowerCase();
  const lingua = exato.split('-')[0];
  const doIdioma = vozes.filter((v) => v.lang.toLowerCase().replace('_', '-') === exato);
  const daLingua = vozes.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === lingua);
  const lista = doIdioma.length ? doIdioma : daLingua;
  if (!lista.length) return null;
  const ordem = [...lista].sort((a, b) => a.name.localeCompare(b.name));
  return ordem[perfil % ordem.length];
}

export interface Fala {
  /** termina quando a fala acaba (ou é parada) */
  fim: Promise<void>;
  parar: () => void;
  /** a voz usada: a da equipe ou a do sistema */
  por: 'equipe' | 'sistema';
}

/** Fala pelo sistema (a voz do navegador). */
export async function falarPeloSistema(texto: string, idioma: string, perfil: number): Promise<Fala> {
  const s = window.speechSynthesis;
  const vozes = await vozesDoSistema();
  const v = escolherVoz(vozes, idioma, perfil);
  // a fala do sistema corta textos longos em alguns navegadores: frase a frase
  const frases = textoFalado(texto).split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const [tom, ritmo] = TONS[perfil % TONS.length];
  let parado = false;
  s.cancel();
  const fim = new Promise<void>((ok) => {
    let i = 0;
    const proxima = () => {
      if (parado || i >= frases.length) { ok(); return; }
      const u = new SpeechSynthesisUtterance(frases[i++]);
      u.lang = v?.lang ?? idioma;
      if (v) u.voice = v;
      u.pitch = tom; u.rate = ritmo;
      u.onend = proxima; u.onerror = () => ok();
      s.speak(u);
    };
    proxima();
  });
  return { fim, por: 'sistema', parar: () => { parado = true; s.cancel(); } };
}

/**
 * Fala a mensagem de um agente: a voz da equipe quando há (`podeEquipe`), senão (ou se ela falhar) a do sistema. Devolve
 * null quando não há voz nenhuma neste computador.
 */
export async function falarMensagem(m: { id: string; content: string; autor?: string | null }, o: { podeEquipe: boolean; idioma: string; audio?: HTMLAudioElement | null; aoTocar?: () => void }): Promise<Fala | null> {
  if (o.podeEquipe) {
    try {
      const blob = await api.postBlob(`${RECURSOS}/voz/falar`, { mensagem: m.id });
      const a = o.audio ?? new Audio();
      const url = URL.createObjectURL(blob);
      a.src = url;
      let parar = () => { /* trocado abaixo */ };
      const fim = new Promise<void>((ok) => {
        const acabou = () => { URL.revokeObjectURL(url); ok(); };
        a.onended = acabou; a.onerror = acabou; a.onpause = acabou;
        parar = () => { try { a.pause(); } catch { /* já parado */ } acabou(); };
      });
      await a.play();
      o.aoTocar?.();
      return { fim, parar, por: 'equipe' };
    } catch (err) {
      // sem a voz da equipe (ou ela falhou nesta): a do sistema
      if (!(err instanceof ApiError) && !(err instanceof DOMException)) throw err;
    }
  }
  if (!temFalaDoSistema()) return null;
  const f = await falarPeloSistema(m.content, o.idioma, perfilDoNome(m.autor ?? ''));
  o.aoTocar?.();
  return f;
}

/** O idioma da fala do sistema para o idioma da tela. */
export const idiomaDaFala = (tela: string): string => ({ pt: 'pt-BR', en: 'en-US', hi: 'hi-IN', 'zh-CN': 'zh-CN' } as Record<string, string>)[tela] ?? tela; // i18n-ok: códigos de idioma (BCP 47)

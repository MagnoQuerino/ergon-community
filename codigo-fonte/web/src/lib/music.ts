/**
 * Música ambiente (lo-fi do Ergon): um tocador só, fora da cidade e das telas, para nada reiniciar ao navegar. Toca só
 * quando a pessoa clica (nunca sozinho, nem ao reabrir); volume e aleatório são preferências da pessoa (servidor).
 * As faixas vêm com o aplicativo (public/musica, manifesto com SHA-256): funciona sem internet, sem streaming e sem
 * telemetria. Duas abas ou janelas: quando uma começa a tocar, as outras param (BroadcastChannel).
 */
import { useSyncExternalStore } from 'react';

/** gain: o que a faixa precisa para tocar no mesmo nível das outras (medido; 0..1) */
export interface Track { file: string; title: string; author: string; source: string; license: string; licenseUrl: string; sha256: string; gain?: number }
export interface MusicState { tracks: Track[]; index: number; playing: boolean; volume: number; shuffle: boolean; error: string | null }

const BASE = '/musica/';
const FADE_MS = 1200;

type Persist = (p: { musicVolume?: number; musicShuffle?: boolean }) => void;

export class Player {
  private st: MusicState = { tracks: [], index: 0, playing: false, volume: 0.5, shuffle: false, error: null };
  private subs = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private loading: Promise<void> | null = null;
  private fails = 0;
  private fade: number | null = null;
  private saveTimer: number | null = null;
  private persist: Persist | null = null;
  private readonly tab = Math.random().toString(36).slice(2);
  private bc: BroadcastChannel | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      this.bc = new BroadcastChannel('ergon-musica');
      (this.bc as { unref?: () => void }).unref?.(); // fora do navegador (testes) não segura o processo
      // outra aba começou a tocar: esta para (sem duas músicas ao mesmo tempo)
      this.bc.onmessage = (e) => { const d = e.data as { type?: string; tab?: string }; if (d?.type === 'playing' && d.tab !== this.tab) this.pause(); };
    } catch { /* sem canal: cada aba por si */ }
    window.addEventListener('pagehide', () => this.pause());
  }

  /** volume que vai ao áudio: o da pessoa × o ganho da faixa (todas no mesmo nível) */
  private level(volume = this.st.volume): number {
    const g = this.st.tracks[this.st.index]?.gain;
    return volume * (typeof g === 'number' && g > 0 && g <= 1 ? g : 1);
  }

  snapshot = (): MusicState => this.st;
  subscribe = (f: () => void): (() => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  private set(p: Partial<MusicState>) { this.st = { ...this.st, ...p }; this.subs.forEach((f) => f()); }

  /** preferências da pessoa (volume, aleatório) e onde guardá-las; não toca nada */
  configure(p: { musicVolume?: number; musicShuffle?: boolean } | undefined, persist: Persist): void {
    this.persist = persist;
    if (!p) return;
    const volume = typeof p.musicVolume === 'number' ? Math.min(1, Math.max(0, p.musicVolume)) : this.st.volume;
    this.set({ volume, shuffle: p.musicShuffle === true });
    if (this.audio && !this.fade) this.audio.volume = this.level(volume);
  }

  private load(): Promise<void> {
    if (this.st.tracks.length) return Promise.resolve();
    this.loading ??= fetch(`${BASE}musicas.json`).then((r) => r.json()).then((m: { tracks: Track[] }) => {
      this.set({ tracks: Array.isArray(m.tracks) ? m.tracks : [], index: 0 });
    }).catch(() => { this.loading = null; this.set({ error: 'Não deu para abrir a lista de músicas.' }); });
    return this.loading;
  }

  private el(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio(); a.preload = 'auto';
    a.addEventListener('ended', () => this.next());
    // faixa com problema: passa para a próxima sem travar a tela (todas falharam: para e avisa)
    a.addEventListener('error', () => {
      if (!this.st.playing) return;
      this.fails++;
      if (this.fails >= Math.max(1, this.st.tracks.length)) { this.pause(); this.set({ error: 'As músicas não abriram neste computador.' }); return; }
      this.next();
    });
    a.addEventListener('playing', () => { this.fails = 0; });
    this.audio = a;
    return a;
  }

  private fadeIn(a: HTMLAudioElement): void {
    if (this.fade) cancelAnimationFrame(this.fade);
    const t0 = performance.now(); const target = this.level(); a.volume = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / FADE_MS);
      a.volume = target * k;
      this.fade = k < 1 ? requestAnimationFrame(step) : null;
    };
    this.fade = requestAnimationFrame(step);
  }

  private async start(index: number): Promise<void> {
    await this.load();
    const t = this.st.tracks[index]; if (!t) return;
    const a = this.el();
    if (!a.src.endsWith(BASE + t.file)) a.src = BASE + t.file;
    this.set({ index, playing: true, error: null });
    try {
      await a.play();
      this.fadeIn(a);
      this.bc?.postMessage({ type: 'playing', tab: this.tab });
    } catch {
      // o navegador barrou (sem clique) ou o arquivo não abriu
      this.set({ playing: false });
    }
  }

  /** um clique liga, outro pausa */
  toggle(): void { if (this.st.playing) this.pause(); else void this.start(this.st.index); }

  pause(): void {
    if (this.fade) { cancelAnimationFrame(this.fade); this.fade = null; }
    this.audio?.pause();
    if (this.audio) this.audio.volume = this.level();
    if (this.st.playing) this.set({ playing: false });
  }

  nextIndex(): number {
    const n = this.st.tracks.length; if (n < 2) return 0;
    if (!this.st.shuffle) return (this.st.index + 1) % n;
    let i = this.st.index; while (i === this.st.index) i = Math.floor(Math.random() * n);
    return i;
  }

  next(): void {
    const i = this.nextIndex();
    if (this.st.playing) void this.start(i);
    else { this.set({ index: i }); if (this.audio) this.audio.removeAttribute('src'); }
  }

  setVolume(v: number): void {
    const volume = Math.min(1, Math.max(0, v));
    if (this.fade) { cancelAnimationFrame(this.fade); this.fade = null; }
    this.set({ volume });
    if (this.audio) this.audio.volume = this.level(volume);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist?.({ musicVolume: Math.round(volume * 100) / 100 }), 600);
  }

  setShuffle(on: boolean): void { this.set({ shuffle: on }); this.persist?.({ musicShuffle: on }); }

  /** a lista (para os créditos), sem tocar */
  ensureList(): void { void this.load(); }
}

export const music = new Player();

export function useMusic(): MusicState { return useSyncExternalStore(music.subscribe, music.snapshot); }

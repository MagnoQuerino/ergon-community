import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

// navegador mínimo: o tocador usa window, Audio, requestAnimationFrame, fetch e BroadcastChannel (este, do próprio Node)
const PUB = path.resolve(import.meta.dirname, '..', '..', 'public', 'musica');
const manifesto = JSON.parse(fs.readFileSync(path.join(PUB, 'musicas.json'), 'utf8')) as { tracks: Array<{ file: string; title: string; sha256: string; bytes: number; license: string; licenseUrl: string; source: string; author: string; gain: number }> };
const quebrado = new Set<string>();
class FakeAudio {
  src = ''; volume = 1; preload = ''; paused = true;
  private on = new Map<string, Array<() => void>>();
  addEventListener(t: string, f: () => void) { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  emit(t: string) { for (const f of this.on.get(t) ?? []) f(); }
  removeAttribute() { this.src = ''; }
  async play() {
    if ([...quebrado].some((f) => this.src.endsWith(f))) { queueMicrotask(() => this.emit('error')); return; }
    this.paused = false; queueMicrotask(() => this.emit('playing'));
  }
  pause() { this.paused = true; }
}
const g = globalThis as Record<string, unknown>;
g.window = { addEventListener() {}, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) };
g.Audio = FakeAudio;
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.fetch = async () => new Response(JSON.stringify(manifesto));

const { Player } = await import('./music.ts');
const espera = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const audioOf = (p: InstanceType<typeof Player>) => (p as unknown as { audio: FakeAudio | null }).audio;

describe('música ambiente', () => {
  test('começa em silêncio: nada toca sem clique, mesmo com volume guardado', async () => {
    const p = new Player();
    p.configure({ musicVolume: 0.3, musicShuffle: false }, () => {});
    await espera();
    assert.equal(p.snapshot().playing, false);
    assert.equal(audioOf(p), null, 'nem cria o áudio');
    assert.equal(p.snapshot().volume, 0.3);
  });

  test('um clique toca, o segundo pausa na hora; a próxima segue a ordem', async () => {
    const p = new Player();
    p.toggle(); await espera();
    assert.equal(p.snapshot().playing, true);
    assert.match(audioOf(p)!.src, new RegExp(`${manifesto.tracks[0].file}$`));
    p.toggle();
    assert.equal(p.snapshot().playing, false);
    assert.equal(audioOf(p)!.paused, true);
    p.toggle(); await espera(); p.next(); await espera();
    assert.equal(p.snapshot().index, 1);
    assert.equal(p.snapshot().playing, true, 'trocar de faixa não para a música');
    p.pause();
  });

  test('volume igual entre faixas: o áudio recebe o volume da pessoa × o ganho medido da faixa', async () => {
    const p = new Player();
    p.configure({ musicVolume: 0.8 }, () => {});
    p.toggle(); await espera(1400); // depois da entrada suave
    const g = manifesto.tracks[0].gain;
    assert.ok(Math.abs(audioOf(p)!.volume - 0.8 * g) < 0.01, `${audioOf(p)!.volume} ≈ ${0.8 * g}`);
    p.setVolume(0.5);
    assert.ok(Math.abs(audioOf(p)!.volume - 0.5 * g) < 0.01);
    p.pause();
  });

  test('volume e aleatório são guardados como preferência da pessoa', async () => {
    const salvo: unknown[] = [];
    const p = new Player();
    p.configure(undefined, (x) => salvo.push(x));
    p.setVolume(0.8); p.setShuffle(true);
    await espera(700);
    assert.deepEqual(salvo, [{ musicShuffle: true }, { musicVolume: 0.8 }]);
  });

  test('duas abas: quando uma toca, a outra para', async () => {
    const a = new Player(); const b = new Player();
    a.toggle(); await espera();
    b.toggle(); await espera(50);
    assert.equal(b.snapshot().playing, true);
    assert.equal(a.snapshot().playing, false, 'sem duas músicas ao mesmo tempo');
    b.pause();
  });

  test('faixa com defeito: passa para a próxima sem travar', async () => {
    quebrado.add(manifesto.tracks[0].file);
    const p = new Player();
    p.toggle(); await espera(50);
    assert.equal(p.snapshot().index, 1);
    assert.equal(p.snapshot().playing, true);
    p.pause(); quebrado.clear();
  });

  test('manifesto: cada faixa com arquivo, SHA-256, autor, origem e licença de redistribuição', () => {
    assert.ok(manifesto.tracks.length >= 6 && manifesto.tracks.length <= 10);
    const arquivos = fs.readdirSync(PUB).filter((f) => f.endsWith('.ogg') || f.endsWith('.mp3'));
    assert.deepEqual(new Set(arquivos), new Set(manifesto.tracks.map((t) => t.file)), 'nenhum arquivo sem crédito, nenhum crédito sem arquivo');
    for (const t of manifesto.tracks) {
      const buf = fs.readFileSync(path.join(PUB, t.file));
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), t.sha256, t.file);
      assert.equal(buf.length, t.bytes);
      assert.match(t.license, /CC0/); assert.match(t.licenseUrl, /^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\//);
      assert.ok(t.author && t.title && t.source.startsWith('https://'));
      assert.ok(t.gain > 0 && t.gain <= 1, `ganho medido de ${t.file}`);
    }
    assert.ok(fs.existsSync(path.join(PUB, 'LICENCAS.md')));
  });
});

import { useRef, useState } from 'react';
import { music, useMusic } from '../lib/music.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

/**
 * Botão de música da cidade (todos os temas, web e Desktop): um clique toca, outro pausa. A setinha abre o painel com
 * volume, faixa atual, próxima, aleatório e os créditos. Desligado por padrão; nunca toca sozinho.
 */
export function MusicButton() {
  const m = useMusic();
  const [open, setOpen] = useState(false);
  const t = m.tracks[m.index];
  return (
    <span className="music">
      <button className={`tool tool--icon ${m.playing ? 'tool--on music--on' : ''}`} onClick={() => music.toggle()} aria-pressed={m.playing}
        title={m.playing ? `Tocando: ${t?.title ?? 'lo-fi'} · clique para pausar` : 'Música ambiente (lo-fi, sem internet): clique para tocar'}
        aria-label={m.playing ? 'Pausar a música' : 'Tocar música ambiente'}>
        <Icon name="music" size={17} />
      </button>
      <button className="tool tool--icon music__more" onClick={() => { music.ensureList(); setOpen((v) => !v); }} aria-expanded={open} aria-label="Opções da música" title="Volume, faixas e créditos">
        <Icon name="chevron-up" size={13} />
      </button>
      {open && <MusicPanel onClose={() => setOpen(false)} />}
    </span>
  );
}

function MusicPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  const m = useMusic();
  const [credits, setCredits] = useState(false);
  const t = m.tracks[m.index];
  const next = m.tracks[music.nextIndex()];
  return (
    <div ref={ref} className="music__panel" role="dialog" aria-label="Música ambiente">
      <div className="music__row">
        <button className="btn btn--sm" onClick={() => music.toggle()}>{m.playing ? 'Pausar' : 'Tocar'}</button>
        <button className="btn btn--sm" onClick={() => music.next()} disabled={m.tracks.length < 2}>Próxima</button>
      </div>
      <p className="small"><b>{t ? t.title : '…'}</b>{t ? <span className="muted"> · {t.author}</span> : null}</p>
      {next && m.tracks.length > 1 && <p className="small muted">A seguir: {next.title}</p>}
      <label className="music__vol small">Volume
        <input type="range" min={0} max={1} step={0.05} value={m.volume} onChange={(e) => music.setVolume(Number(e.target.value))} aria-label="Volume da música" />
      </label>
      <label className="small music__check"><input type="checkbox" checked={m.shuffle} onChange={(e) => music.setShuffle(e.target.checked)} /> Ordem aleatória</label>
      {m.error && <p className="error small" role="status">{m.error}</p>}
      <button className="link small" onClick={() => setCredits((v) => !v)} aria-expanded={credits}>Créditos das músicas</button>
      {credits && <MusicCredits />}
    </div>
  );
}

/** Créditos: título, autor, origem e licença de cada faixa (também em Configurações). */
export function MusicCredits() {
  const m = useMusic();
  if (!m.tracks.length) { music.ensureList(); return <p className="small muted">Carregando…</p>; }
  return (
    <ul className="music__credits small">
      {m.tracks.map((t) => (
        <li key={t.file}><b>{t.title}</b> · {t.author} · <a href={t.licenseUrl} target="_blank" rel="noreferrer noopener">{t.license}</a> · <a href={t.source} target="_blank" rel="noreferrer noopener">origem</a></li>
      ))}
    </ul>
  );
}

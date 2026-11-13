import { useEffect, useRef } from 'react';
import { music, useMusic } from '../lib/music.ts';
import { useSurface } from '../lib/surface.ts';
import { useBalao } from '../lib/balao.ts';
import { pedeCreditos } from '../lib/barra.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

/**
 * Música ambiente na barra de cima, em qualquer tela (o tocador é um só: trocar de tela não para a música).
 * A nota abre um painel pequeno: tocar/pausar, próxima, volume e ordem aleatória. Desligada por padrão; nunca toca
 * sozinha. Os créditos ficam em Configurações.
 */
export function MusicButton({ onCredits }: { onCredits: () => void }) {
  const t = useT();
  const m = useMusic();
  const [open, setOpen] = useBalao('musica'); // abrir a música fecha o Estado, o workspace… (um balão por vez)
  const faixa = m.tracks[m.index];
  const nome = m.playing ? t('geral.musica.tocando', { faixa: faixa?.title ?? 'lo-fi' }) : t('geral.musica.nome');
  return (
    <span className="topbar__musicwrap">
      <button className={`tb-icon ${open ? 'is-on' : ''}`} data-keep-surface onClick={() => { music.ensureList(); setOpen((v) => !v); }}
        aria-expanded={open} aria-haspopup="dialog" aria-label={nome} title={m.playing ? t('geral.musica.dicaTocando', { nome }) : t('geral.musica.dica')}>
        <Icon name="music" size={18} />
        {m.playing && <span className="tb-dot tb-dot--music" aria-hidden="true" />}
      </button>
      {open && <MusicPanel onClose={() => setOpen(false)} onCredits={() => { setOpen(false); onCredits(); }} />}
    </span>
  );
}

function MusicPanel({ onClose, onCredits }: { onClose: () => void; onCredits: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  const m = useMusic();
  const faixa = m.tracks[m.index];
  const next = m.tracks.length > 1 ? m.tracks[music.nextIndex()] : null;
  return (
    <div ref={ref} className="status-pop music-pop" role="dialog" aria-label={t('geral.musica.nome')}>
      <div className="music-pop__row">
        <button className="btn btn--sm music-pop__play" data-autofocus onClick={() => music.toggle()} aria-pressed={m.playing}>
          <Icon name={m.playing ? 'pause' : 'play'} size={14} /> {m.playing ? t('geral.musica.pausar') : t('geral.musica.tocar')}
        </button>
        {next && <button className="btn btn--sm" onClick={() => music.next()} title={t('geral.musica.aSeguir', { faixa: next.title })}><Icon name="next" size={14} /> {t('geral.musica.proxima')}</button>}
      </div>
      <p className="small music-pop__now"><b>{faixa ? faixa.title : '…'}</b>{faixa ? <span className="muted"> · {faixa.author}</span> : null}</p>
      {next && <p className="small muted music-pop__now">{t('geral.musica.aSeguir', { faixa: next.title })}</p>}
      <label className="music-pop__vol small">{t('geral.musica.volume')}
        <input type="range" min={0} max={1} step={0.05} value={m.volume} onChange={(e) => music.setVolume(Number(e.target.value))} aria-label={t('geral.musica.volumeAria')} />
      </label>
      <label className="small music-pop__check"><input type="checkbox" checked={m.shuffle} onChange={(e) => music.setShuffle(e.target.checked)} /> {t('geral.musica.aleatoria')}</label>
      {m.error && <p className="error small" role="status">{m.error === 'lista' ? t('geral.musica.erroLista') : t('geral.musica.erroFaixas')}</p>}
      <button className="link small music-pop__credits" onClick={onCredits}>{t('geral.musica.creditos')}</button>
    </div>
  );
}

/** Créditos: título, autor, origem e licença de cada faixa (em Configurações; o link do painel abre o bloco e rola até ele). */
export function MusicCreditsBlock() {
  const tr = useT();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const ver = () => {
      const el = ref.current;
      if (!el || !pedeCreditos(location.hash)) return;
      el.open = true;
      // já à vista (a segunda conferência): não rola de novo
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > innerHeight - 80) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    };
    // confere de novo logo depois: o que fica acima pode crescer (painéis que terminam de chegar), e o balão da música,
    // ao fechar, devolve o foco ao botão dele, o que interrompe a rolagem suave começada agora
    let t = 0;
    const agora = () => { ver(); clearTimeout(t); t = window.setTimeout(ver, 400); };
    agora();
    addEventListener('hashchange', agora);
    return () => { clearTimeout(t); removeEventListener('hashchange', agora); };
  }, []);
  return <details ref={ref} id="creditos-musica" className="hint music-credits"><summary>{tr('geral.musica.creditosBloco')}</summary><MusicCredits /></details>;
}

/** Créditos: título, autor, origem e licença de cada faixa (em Configurações). */
function MusicCredits() {
  const t = useT();
  const m = useMusic();
  if (!m.tracks.length) { music.ensureList(); return <p className="small muted">{t('geral.comum.carregando')}</p>; }
  return (
    <ul className="music__credits small">
      {m.tracks.map((f) => (
        <li key={f.file}><b>{f.title}</b> · {f.author} · <a href={f.licenseUrl} target="_blank" rel="noreferrer noopener">{f.license}</a> · <a href={f.source} target="_blank" rel="noreferrer noopener">{t('geral.musica.origem')}</a></li>
      ))}
    </ul>
  );
}

import { useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { Icon } from './Icon.tsx';

/*
 * Trabalho contínuo numa conversa ou num card: meta com juiz, repetir até cumprir, checagem periódica, comentar sem
 * interromper e revisão independente. As cinco ações ficam sempre à vista, com uma linha explicando e o aviso de custo;
 * o que está ligado aparece com o botão de parar. Os atalhos digitados (/meta, /goal…) fazem o mesmo.
 */

export type TipoComando = 'meta' | 'repetir' | 'checagem' | 'comentar' | 'revisao';
export interface Comando {
  id: string; kind: 'meta' | 'repetir' | 'checagem' | 'revisao'; texto: string; criterio: string | null; intervalo_s: number | null;
  max_rodadas: number; rodadas: number; status: 'ativo' | 'cumprido' | 'esgotado' | 'bloqueado' | 'parado'; nota: string | null; updated_at: string;
}
export interface ResultadoComando { tipo: TipoComando; codigo: 'ligado' | 'parado' | 'nada_a_parar' | 'entregue' | 'sem_trabalho' | 'pedida' }

const TIPOS: TipoComando[] = ['meta', 'repetir', 'checagem', 'comentar', 'revisao'];
const ICONE: Record<TipoComando, string> = { meta: 'flag', repetir: 'repeat', checagem: 'pulse', comentar: 'chat', revisao: 'shield' };
const INTERVALOS = [900, 1800, 3600, 6 * 3600, 86400];
/** os atalhos digitados, na ordem em que a dica mostra (o do Ergon e o original) */
export const ATALHOS: Array<{ tipo: TipoComando; nomes: string }> = [
  { tipo: 'meta', nomes: '/meta · /goal' }, { tipo: 'repetir', nomes: '/repetir · /loop' }, { tipo: 'checagem', nomes: '/checagem · /heartbeat' },
  { tipo: 'comentar', nomes: '/comentar · /btw' }, { tipo: 'revisao', nomes: '/revisao · /review' },
];

/** O texto que a tela mostra depois de um comando (na conversa, como dica; no card, como aviso). */
export function useFraseDoComando(): (r: ResultadoComando) => string {
  const t = useT();
  return (r) => (r.codigo === 'ligado' ? t(`conversas.comando.ligado.${r.tipo === 'comentar' || r.tipo === 'revisao' ? 'meta' : r.tipo}`)
    : r.codigo === 'parado' ? t('conversas.comando.parado') : r.codigo === 'nada_a_parar' ? t('conversas.comando.nadaAParar')
    : r.codigo === 'entregue' ? t('conversas.comando.entregue') : r.codigo === 'sem_trabalho' ? t('conversas.comando.semTrabalho') : t('conversas.comando.pedida'));
}

/** Dica ao digitar "/" na conversa: os atalhos, cada um com a sua linha; um clique escreve o começo no campo. */
export function DicaDeAtalhos({ onEscolher }: { onEscolher: (inicio: string) => void }) {
  const t = useT();
  return (
    <div className="cmd-dica" role="list" aria-label={t('conversas.comando.atalhos')}>
      {ATALHOS.map((a) => (
        <button key={a.tipo} type="button" role="listitem" className="cmd-dica__item" onClick={() => onEscolher(`${a.nomes.split(' · ')[0]} `)}>
          <Icon name={ICONE[a.tipo]} size={13} /> <b>{a.nomes}</b> <span className="muted">{t(`conversas.comando.linha.${a.tipo}`)}</span>
        </button>
      ))}
    </div>
  );
}

function rotuloIntervalo(t: ReturnType<typeof useT>, s: number): string {
  return s % 86400 === 0 ? t('conversas.comando.cadaDias', { n: s / 86400 }) : s % 3600 === 0 ? t('conversas.comando.cadaHoras', { n: s / 3600 }) : t('conversas.comando.cadaMinutos', { n: Math.round(s / 60) });
}

/**
 * As ações e o que está ligado. `postUrl`: a rota de comandos da conversa ou do card (null = a conversa ainda não existe:
 * `garantir` cria e devolve a rota). `listaUrl`: de onde vem a lista.
 */
export function ComandosBar({ postUrl, garantir, listaUrl, compacto, onFeito }: {
  postUrl: string | null; garantir?: () => Promise<string>; listaUrl: string | null; compacto?: boolean; onFeito?: (frase: string) => void;
}) {
  const t = useT();
  const frase = useFraseDoComando();
  const lista = useResource<{ comandos: Comando[] }>(listaUrl, ['comandos.changed', 'runs.changed']);
  const [aberto, setAberto] = useState<TipoComando | null>(null);
  const [texto, setTexto] = useState('');
  const [criterio, setCriterio] = useState('');
  const [intervalo, setIntervalo] = useState(1800);
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const ativos = (lista.data?.comandos ?? []).filter((c) => c.status === 'ativo');
  const recentes = (lista.data?.comandos ?? []).filter((c) => c.status !== 'ativo').slice(0, 3);

  const enviar = async () => {
    setBusy(true); setErr(null);
    try {
      const url = postUrl ?? (garantir ? await garantir() : null);
      if (!url) return;
      const corpo: Record<string, unknown> = { tipo: aberto, texto: texto.trim() };
      if (aberto === 'repetir' || aberto === 'checagem') corpo.intervaloS = intervalo;
      if (aberto === 'repetir' && criterio.trim()) corpo.criterio = criterio.trim();
      if (max.trim() && Number(max) > 0 && aberto !== 'comentar' && aberto !== 'revisao') corpo.max = Math.min(50, Math.round(Number(max)));
      const r = await api.post<ResultadoComando>(url, corpo);
      const f = frase(r);
      setAviso(f); onFeito?.(f);
      setAberto(null); setTexto(''); setCriterio(''); setMax('');
      lista.reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const parar = async (id: string) => {
    setErr(null);
    try { await api.del(`/api/comandos/${id}`); lista.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const precisaTexto = aberto === 'meta' || aberto === 'repetir' || aberto === 'checagem' || aberto === 'comentar';

  return (
    <section className={`cmd-bar${compacto ? ' cmd-bar--compacto' : ''}`} aria-label={t('conversas.comando.titulo')}>
      {ativos.length > 0 && (
        <ul className="cmd-bar__ativos">
          {ativos.map((c) => (
            <li key={c.id} className="cmd-bar__ativo">
              <Icon name={ICONE[c.kind]} size={13} />
              <span><b>{t(`conversas.comando.nome.${c.kind}`)}</b> {c.texto !== '—' && c.texto}
                <span className="muted small"> · {c.intervalo_s ? `${rotuloIntervalo(t, c.intervalo_s)} · ` : ''}{t('conversas.comando.rodadas', { feitas: c.rodadas, max: c.max_rodadas })}
                  {c.nota && c.kind !== 'revisao' && c.nota !== 'sem_juiz' ? ` · ${c.nota}` : ''}</span></span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void parar(c.id)}><Icon name="stop" size={12} /> {t('conversas.comando.parar')}</button>
            </li>
          ))}
        </ul>
      )}
      {recentes.length > 0 && !compacto && (
        <ul className="cmd-bar__recentes">
          {recentes.map((c) => (
            <li key={c.id} className="muted small">
              <Icon name={ICONE[c.kind]} size={12} /> {t(`conversas.comando.nome.${c.kind}`)}: {t(`conversas.comando.status.${c.status}`)}
              {c.nota === 'sem_juiz' ? ` — ${t('conversas.comando.semJuiz')}` : c.nota && c.kind !== 'revisao' ? ` — ${c.nota}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="cmd-bar__acoes" role="group" aria-label={t('conversas.comando.acoes')}>
        {TIPOS.map((k) => (
          <button key={k} type="button" className={`btn btn--sm${aberto === k ? ' btn--primary' : ' btn--ghost'}`} aria-expanded={aberto === k}
            title={t(`conversas.comando.linha.${k}`)} onClick={() => { setAberto(aberto === k ? null : k); setErr(null); }}>
            <Icon name={ICONE[k]} size={13} /> {t(`conversas.comando.nome.${k}`)}
          </button>
        ))}
      </div>
      {aberto && (
        <form className="cmd-bar__form" onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
          <p className="small">{t(`conversas.comando.linha.${aberto}`)}</p>
          <p className="hint warn small">{t(`conversas.comando.custo.${aberto}`)}</p>
          <input value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={4000} autoFocus required={precisaTexto}
            placeholder={t(`conversas.comando.campo.${aberto}`)} aria-label={t(`conversas.comando.campo.${aberto}`)} />
          {(aberto === 'repetir' || aberto === 'checagem') && (
            <label className="row small">{t('conversas.comando.intervalo')}
              <select value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
                {INTERVALOS.map((s) => <option key={s} value={s}>{rotuloIntervalo(t, s)}</option>)}
              </select>
            </label>
          )}
          {aberto === 'repetir' && (
            <input value={criterio} onChange={(e) => setCriterio(e.target.value)} maxLength={2000}
              placeholder={t('conversas.comando.campo.criterio')} aria-label={t('conversas.comando.campo.criterio')} />
          )}
          {(aberto === 'meta' || aberto === 'repetir' || aberto === 'checagem') && (
            <label className="row small">{t('conversas.comando.maxRodadas')}
              <input type="number" min={1} max={50} value={max} onChange={(e) => setMax(e.target.value)} placeholder={t(`conversas.comando.maxPadrao.${aberto}`)} className="cmd-bar__num" />
            </label>
          )}
          <div className="row">
            <button className="btn btn--sm btn--primary" aria-busy={busy}>{busy ? t('conversas.comando.enviando') : t(`conversas.comando.confirmar.${aberto}`)}</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAberto(null)}>{t('conversas.comando.fechar')}</button>
          </div>
        </form>
      )}
      {aviso && !onFeito && <p className="ok small" role="status">{aviso}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

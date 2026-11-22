import type { SyntheticEvent } from 'react';
import { useT } from '../i18n/index.ts';
import type { Attachment } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/**
 * Áudio da mensagem (rc.33): o player (pela rota de sempre do arquivo) e, embaixo, a transcrição gravada no servidor —
 * "transcrevendo…", "preparando (primeira vez)…", o texto recolhido, ou a falha com "tentar de novo".
 */
export function AudioDaMensagem({ f, onTentar, podeTranscrever }: { f: Attachment; onTentar: (f: Attachment) => void; /** áudio de antes, sem transcrição: o botão */ podeTranscrever: boolean }) {
  const t = useT();
  const tr = f.transcricao;
  // o WebM do gravador não traz a duração no cabeçalho: o navegador só sabe depois de ir até o fim (sem isso, a barra
  // do player fica sem tamanho)
  const duracao = (ev: SyntheticEvent<HTMLAudioElement>) => {
    const a = ev.currentTarget;
    if (a.duration !== Infinity) return;
    const volta = () => { a.removeEventListener('timeupdate', volta); a.currentTime = 0; };
    a.addEventListener('timeupdate', volta);
    a.currentTime = 1e7;
  };
  return (
    <div className="msg__audio">
      <audio controls preload="metadata" src={`/api/artifacts/${f.id}/download?inline=1`} onLoadedMetadata={duracao} aria-label={t('conversas.audio.player', { nome: f.filename })} />
      {!tr ? (podeTranscrever ? <button type="button" className="linkish small" onClick={() => onTentar(f)}><Icon name="file" size={12} /> {t('conversas.audio.transcrever')}</button> : null)
        : tr.estado === 'transcrevendo' ? <span className="muted small msg__transcricao">{t('conversas.audio.transcrevendo')}</span>
        : tr.estado === 'preparando' ? <span className="muted small msg__transcricao">{t('conversas.audio.preparando')}</span>
        : tr.estado === 'falhou' ? (
          <span className="small msg__transcricao msg__transcricao--falhou">
            {tr.motivo === 'longo' ? t('conversas.audio.falhouLongo') : tr.motivo === 'componente' ? t('conversas.audio.falhouComponente') : tr.motivo === 'sem_motor' ? t('conversas.audio.falhouSemMotor') : t('conversas.audio.falhou')}
            {tr.motivo !== 'longo' && <> <button type="button" className="linkish" onClick={() => onTentar(f)}><Icon name="repeat" size={12} /> {t('conversas.audio.tentar')}</button></>}
          </span>
        ) : (
          <details className="msg__transcricao">
            <summary>{t('conversas.audio.transcricao')}</summary>
            <p>{tr.texto?.trim() ? tr.texto : <span className="muted">{t('conversas.recursos.semFala')}</span>}</p>
          </details>
        )}
    </div>
  );
}

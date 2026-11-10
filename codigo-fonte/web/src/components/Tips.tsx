import type { ReactNode } from 'react';
import { t, tn, useT } from '../i18n/index.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import { useModalOpen } from '../lib/surface.ts';
import type { View } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/**
 * Dicas: uma por tela, discreta no canto, até a pessoa dispensar. Dá para desligar todas (e trazer de volta) na
 * própria dica ou na Ajuda. O texto usa o nome de quem coordena hoje — a equipe pode ter outro tema. Os textos vêm
 * do dicionário na hora de mostrar (a troca de idioma redesenha a dica).
 */
const TIPS: Partial<Record<View, (coord: string, other: string) => ReactNode>> = {
  ambiente: (c) => tn('ajuda.dica.cidade', { coord: <b>{c}</b> }),
  agentes: (c, o) => tn('ajuda.dica.agentes', { coord: <b>{c}</b>, nome: c, outro: o }),
  rotinas: (c) => tn('ajuda.dica.rotinas', { briefing: <b>{t('ajuda.dica.rotinasBriefing')}</b>, nome: c }),
  equipe: () => t('ajuda.dica.equipe'),
  tarefas: () => t('ajuda.dica.tarefas'),
  atividade: () => t('ajuda.dica.atividade'),
  documentos: (c) => tn('ajuda.dica.documentos', { coord: <b>{c}</b> }),
  conexoes: () => tn('ajuda.dica.conexoes', { nous: <b>{t('ajuda.dica.conexoesNous')}</b> }),
  configuracao: () => t('ajuda.dica.configuracao'),
};

export function ViewTip({ view, coord, other, onTour }: { view: View; coord: string; other: string; onTour?: () => void }) {
  const prefs = usePrefs();
  useT();
  // com uma janela aberta (conversas, agente, card em diálogo) a dica ficava atrás do fundo dela: o "Entendi" aparecia,
  // mas o clique caía no fundo — fechava a janela e a dica não saía. Ela espera a janela fechar.
  const covered = useModalOpen();
  const id = `${view}.intro`;
  const text = TIPS[view];
  if (!text || !prefs.tips || prefs.dismissed.includes(id) || covered) return null;
  return (
    // data-keep-surface: clicar na dica (Entendi, Desligar) não conta como clique fora do card ou da janela aberta
    <aside className="tip" role="note" aria-label={t('ajuda.dica.aria')} data-keep-surface>
      <span className="tip__ico"><Icon name="bulb" size={18} /></span>
      <div className="tip__body">
        <p>{text(coord, other)}</p>
        <div className="tip__actions">
          <button className="btn btn--sm btn--primary" onClick={() => savePrefs({ dismiss: [id] })}>{t('ajuda.dica.entendi')}</button>
          {view === 'ambiente' && !prefs.tourDone && onTour && <button className="btn btn--sm" onClick={onTour}><Icon name="compass" size={13} /> {t('ajuda.dica.fazerTour')}</button>}
          <button className="link" onClick={() => savePrefs({ tips: false })}>{t('ajuda.dica.desligar')}</button>
        </div>
      </div>
    </aside>
  );
}

import type { ReactNode } from 'react';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import type { View } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/**
 * Dicas: uma por tela, discreta no canto, até a pessoa dispensar. Dá para desligar todas (e trazer de volta) na
 * própria dica ou na Ajuda. O texto usa o nome de quem coordena hoje — a equipe pode ter outro tema.
 */
const TIPS: Partial<Record<View, (coord: string, other: string) => ReactNode>> = {
  ambiente: (c) => <>Esta é a cidade da sua equipe: cada pessoa nas construções é um agente trabalhando. Clique em alguém para conversar — ou fale com <b>{c}</b>, que coordena e encaminha.</>,
  agentes: (c, o) => <>Só o Coordenador (<b>{c}</b>) tem cargo fixo; os outros agentes são seus para criar, mudar ou desativar, quantos quiser. Abra um perfil ou peça a {c}: “renomeie {o} para Ana” ou “transforme a equipe num tema de faroeste”.</>,
  rotinas: (c) => <>Comece pelo <b>Briefing Diário</b>: ao ativar, {c} estuda o seu jeito de trabalhar e adapta a rotina antes da primeira execução.</>,
  equipe: () => <>Este é o quadro onde os agentes trabalham: eles movem os cards conforme avançam. Abra um card para ver o histórico ou pedir uma revisão crítica.</>,
  tarefas: () => <>As suas tarefas são só suas. Quando quiser ajuda, envie uma delas para a equipe: vira card no quadro da equipe com responsável.</>,
  atividade: () => <>Tudo o que a equipe faz fica registrado aqui, com evidência. Os arquivos que os agentes entregam ficam na aba Arquivos.</>,
  conexoes: () => <>Sem uma conta de IA conectada, as respostas são simuladas. A melhor escolha é a <b>assinatura Nous</b>: os principais modelos numa conta só, inclusive gratuitos, e um modelo para cada agente.</>,
  configuracao: () => <>Ferramentas da equipe, andamento, segurança, pacotes e consumo ficam aqui. A conta de IA e o modelo padrão ficam em Conexões.</>,
};

export function ViewTip({ view, coord, other, onTour }: { view: View; coord: string; other: string; onTour?: () => void }) {
  const prefs = usePrefs();
  const id = `${view}.intro`;
  const text = TIPS[view];
  if (!text || !prefs.tips || prefs.dismissed.includes(id)) return null;
  return (
    <aside className="tip" role="note" aria-label="Dica">
      <span className="tip__ico"><Icon name="bulb" size={18} /></span>
      <div className="tip__body">
        <p>{text(coord, other)}</p>
        <div className="tip__actions">
          <button className="btn btn--sm btn--primary" onClick={() => savePrefs({ dismiss: [id] })}>Entendi</button>
          {view === 'ambiente' && !prefs.tourDone && onTour && <button className="btn btn--sm" onClick={onTour}><Icon name="compass" size={13} /> Fazer o tour</button>}
          <button className="link" onClick={() => savePrefs({ tips: false })}>Desligar dicas</button>
        </div>
      </div>
    </aside>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { openCard, openConversation, openSala } from '../lib/open.ts';
import { fmtHora, useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

interface Aviso { id: string; recurso: 'navegador' | 'computador'; motivo: 'ocioso' | 'teto' | 'queda' | 'sessao' | 'prazo'; agente: string | null; agentId: string | null; quando: string; conversa: string | null; sala: boolean; tarefa: string | null }

/**
 * O controle voltou sozinho ao agente (rc.43): o navegador ao vivo ou o computador, por prazo, tempo sem uso ou aba
 * fechada, enquanto a pessoa não via. Na próxima vez que ela abre o Ergon, um aviso discreto no canto, uma vez só
 * (server/src/services/controle-devolvido.ts). Quem estava vendo na hora já leu no painel do navegador.
 */
export function AvisoDevolvido() {
  const t = useT();
  const [aviso, setAviso] = useState<Aviso | null>(null);
  useEffect(() => {
    let vivo = true;
    // um instante depois de abrir: o aviso não disputa a atenção com a tela montando
    const i = window.setTimeout(() => {
      void api.get<{ avisos: Aviso[] }>('/api/controle/devolvido').then((r) => { if (vivo) setAviso(r.avisos[0] ?? null); }).catch(() => undefined);
    }, 1200);
    return () => { vivo = false; clearTimeout(i); };
  }, []);
  if (!aviso) return null;
  const fechar = () => { setAviso(null); void api.post('/api/controle/devolvido/visto').catch(() => undefined); };
  const ver = () => {
    fechar();
    if (aviso.sala && aviso.conversa) openSala(aviso.conversa);
    else if (aviso.conversa) openConversation(aviso.agentId, aviso.conversa);
    else if (aviso.tarefa) openCard(aviso.tarefa);
  };
  const nome = aviso.agente ?? t('conversas.navegador.aviso.agente');
  return (
    <div className="aviso-devolvido" role="status">
      <Icon name={aviso.recurso === 'computador' ? 'monitor' : 'globe'} size={16} />
      <span className="aviso-devolvido__txt">
        <b>{t(`conversas.navegador.aviso.${aviso.recurso}`, { nome })}</b>
        <small>{t(`conversas.navegador.aviso.motivo.${aviso.motivo}`, { hora: fmtHora(new Date(aviso.quando)) })}</small>
      </span>
      {(aviso.conversa || aviso.tarefa) && <button type="button" className="btn btn--sm" onClick={ver}>{t('conversas.navegador.aviso.ver')}</button>}
      <button type="button" className="icon-btn" onClick={fechar} aria-label={t('conversas.navegador.aviso.ok')} title={t('conversas.navegador.aviso.ok')}><Icon name="x" size={14} /></button>
    </div>
  );
}

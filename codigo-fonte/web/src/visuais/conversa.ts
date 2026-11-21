// A conversa direta oferece aos blocos visuais: os votos (mensagens da pessoa só com a cerca do voto) e votar (sem chamar
// o agente). As salas fazem o mesmo com as mensagens delas (quem votou é o autor da mensagem).
import { useMemo } from 'react';
import { votoDe } from '../../../shared/visuais/cercas.ts';
import { t } from '../i18n/index.ts';
import { api, requestId } from '../lib/api.ts';
import type { VisuaisContexto, VotoVisto } from './contexto.ts';

interface MsgMin { id: string; role: string; content: string; created_at: string }

/** Os votos das mensagens; `autor` diz quem escreveu cada uma (na conversa direta, sempre a pessoa). */
export function votosDe(msgs: MsgMin[], autor: (m: MsgMin) => { quem: string; nome: string }): VotoVisto[] {
  return msgs.flatMap((m) => { const v = m.role === 'user' ? votoDe(m.content) : null; return v ? [{ ...v, ...autor(m) }] : []; });
}

export function useVisuaisDaConversa(msgs: MsgMin[], convId: string | null, recarregar: () => void): VisuaisContexto {
  return useMemo<VisuaisContexto>(() => ({
    votos: votosDe(msgs, () => ({ quem: 'eu', nome: t('conversas.conversa.voce') })),
    eu: 'eu',
    votar: convId ? async (enquete, opcao) => { await api.post(`/api/conversations/${convId}/votos`, { enquete, opcao, pedido: requestId() }); recarregar(); } : undefined,
  }), [msgs, convId, recarregar]);
}

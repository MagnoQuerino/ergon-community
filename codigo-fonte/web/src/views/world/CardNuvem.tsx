import { useEffect, useState } from 'react';
import { api, errMsg } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { SEM_NUVEM, type NuvemNoCartao } from '../../lib/nuvem-cartao.ts';
import { acompanhar, estadoDoCartao, SELO, TOM, type CartaoNuvem } from './nuvem-cartao.ts';
import { useTw } from './textos.ts';

interface Status { configured: boolean; link: { currentIsBound: boolean } | null }
interface Lista { offer: boolean; stale: boolean; cards: CartaoNuvem[] }

/**
 * "Rodar na nuvem" num cartão (`card:<id>` do quadro ou `rotina:<id>`): o item do menu e o selo. Só no workspace
 * ligado ao Ergon World; nos outros (ou sem o World), nada. Com cartão na nuvem, relê de leve a cada 20 s.
 */
export function useNuvemNoCartao(ref: string | null): NuvemNoCartao {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const on = !!ref && !!st.data?.configured && !!st.data?.link?.currentIsBound;
  const url = on ? (ref!.startsWith('card:') ? `/api/world/cards?ref=${encodeURIComponent(ref!)}` : '/api/world/cards') : null;
  const l = useResource<Lista>(url, ['routines.changed', 'tasks.changed']);
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const vivo = !!l.data?.offer && acompanhar(l.data.cards);
  const { reload } = l;
  useEffect(() => {
    if (!vivo) return;
    const h = window.setInterval(() => reload(), 20_000);
    return () => window.clearInterval(h);
  }, [vivo, reload]);
  const c = l.data?.offer ? l.data.cards.find((x) => x.ref === ref) ?? null : null;
  if (!c) return SEM_NUVEM;
  const e = estadoDoCartao(c);
  const go = async (path: string, ok: string) => {
    setBusy(true); setAviso(null);
    try { await api.post(path, { ref }); setAviso(ok); } catch (err) { setAviso(errMsg(err)); } finally { setBusy(false); reload(); }
  };
  const item = e.acao === 'enviar'
    ? { label: busy ? t('cartao.enviando') : t('cartao.rodar'), icon: 'cloud', disabled: busy || !e.pode, ...(e.motivo ? { motivo: e.motivo } : {}), onClick: () => void go('/api/world/cards/send', t('cartao.enviado')) }
    : e.acao === 'trazer'
      ? { label: busy ? t('cartao.trazendo') : t('cartao.trazer'), icon: 'download', disabled: busy, onClick: () => void go('/api/world/cards/claim', t('cartao.trazido')) }
      : null;
  return { item, selo: e.selo ? { texto: t(SELO[e.selo]), tom: TOM[e.selo] } : null, aviso };
}

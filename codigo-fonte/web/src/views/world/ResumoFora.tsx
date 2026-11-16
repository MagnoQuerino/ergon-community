import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { detalheDoResumo, linhaDoResumo, type ResumoFora as Resumo } from './nuvem-cartao.ts';
import { useTw } from './textos.ts';

interface Status { configured: boolean; link: { currentIsBound: boolean } | null }

/**
 * "Enquanto você esteve fora": uma linha com os números do que chegou da nuvem desde a última vez (concluídos,
 * recuperados, falharam, rodaram no Ergon AI), o detalhe sob pedido e "Ok" para dar por visto. Nada de aviso por card.
 * Só no workspace ligado ao Ergon World; sem nada novo, não aparece.
 */
export default function ResumoFora() {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const on = !!st.data?.configured && !!st.data?.link?.currentIsBound;
  const r = useResource<Resumo>(on ? '/api/world/cards/summary' : null, []);
  const [aberto, setAberto] = useState(false);
  const [visto, setVisto] = useState(false);
  const linha = linhaDoResumo(r.data, t);
  if (!on || !linha || visto) return null;
  const ok = () => { setVisto(true); void api.post('/api/world/cards/summary/seen').catch(() => undefined); };
  return (
    <div className="hint resumo-fora" role="status">
      <span>{linha}</span>{' '}
      <button type="button" className="linkish" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>{t('fora.detalhes')}</button>{' '}
      <button type="button" className="linkish" onClick={ok}>{t('fora.ok')}</button>
      {aberto && <ul className="small">{r.data!.items.map((x, i) => <li key={`${x.ref}-${i}`}>{detalheDoResumo(x, t)}</li>)}</ul>}
    </div>
  );
}

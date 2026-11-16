import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { emitLocal, useResource } from '../../lib/live.ts';
import { Icon } from '../../components/Icon.tsx';
import type { AiStatus } from '../../lib/types.ts';
import { erroConta } from './WorldLinkDialog.tsx';
import { figura } from './arte.ts';
import { useTw } from './textos.ts';

interface Status { configured: boolean; link: { currentIsBound: boolean } | null }
interface Billing { entitlement: { status: string; plan_sku: string | null } }

/**
 * Conexões › IA: o Ergon AI em destaque. Com o workspace ligado ao Ergon World e um plano ativo, aparece como a opção
 * recomendada, com "Usar Ergon AI" (a mesma ação de Configurações › Ergon World). Sem plano, um convite discreto para a
 * página do Ergon World. As outras contas de IA continuam logo abaixo, como sempre.
 */
export default function ErgonAiConexoes({ onRecomendado }: { onRecomendado?: (sim: boolean) => void }) {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const bound = !!st.data?.configured && !!st.data.link?.currentIsBound;
  const bill = useResource<Billing>(bound ? '/api/world/billing' : null, []);
  const ai = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const [padrao, setPadrao] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const ativo = bound && ['active', 'grace'].includes(bill.data?.entitlement.status ?? '') && !!bill.data?.entitlement.plan_sku;
  // com o Ergon AI recomendado, a outra conta de IA deixa de ser "a melhor escolha" (um destaque só)
  useEffect(() => { onRecomendado?.(ativo); }, [ativo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st.data?.configured) return null;
  if (bound && !bill.data) return null;
  const ligado = (ai.data?.byokCustom ?? []).some((c) => /ergon-ai/i.test(`${c.id} ${c.name}`));
  const fig = figura('platao', 'joy', 'front', 2);

  if (!ativo) {
    return (
      <aside className="eai-convite" aria-labelledby="eai-convite">
        {fig && <img className="eai-convite__fig" src={fig.url} width={fig.w / 2} height={fig.h / 2} alt="" draggable={false} />}
        <div>
          <b id="eai-convite">{t('conexoes.convite.titulo')}</b>
          <p className="small">{t('conexoes.convite.texto')}</p>
        </div>
        <a className="btn btn--sm" href="#world"><Icon name="globe" size={14} /> {t('conexoes.convite.botao')}</a>
      </aside>
    );
  }
  const usar = async () => {
    setBusy(true); setMsg(null);
    try { await api.post('/api/world/ai/connect', { makeDefault: padrao }); setMsg({ kind: 'ok', text: t('ia.ligado') }); ai.reload(); emitLocal('ai.changed'); }
    catch (e) { setMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  return (
    <article className={`ai-best eai ${ligado ? 'ai-best--on' : ''}`} aria-labelledby="eai-titulo">
      <span className="ai-best__ribbon"><Icon name="check" size={12} /> {t('conexoes.recomendado')}</span>
      <header className="ai-best__head">
        <span className="eai__marca" aria-hidden="true"><Icon name="globe" size={26} /></span>
        <div>
          <h4 id="eai-titulo">{t('ia.titulo')}</h4>
          <p>{t('conexoes.texto')}</p>
        </div>
        {ligado && <span className="badge badge--ok">{t('conexoes.ligado')}</span>}
      </header>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <div className="row row--wrap eai__acoes">
        <button className="btn btn--gold ai-best__cta" disabled={busy} onClick={() => void usar()}>{t('ia.usar')}</button>
        <label className="check"><input type="checkbox" checked={padrao} onChange={(ev) => setPadrao(ev.target.checked)} /> {t('ia.padrao')}</label>
      </div>
    </article>
  );
}

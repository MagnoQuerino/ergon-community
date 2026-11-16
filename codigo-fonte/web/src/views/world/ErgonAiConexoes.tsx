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
 * Conexões › IA: o Ergon AI é a melhor escolha, sempre em destaque (com ou sem plano). Com o workspace ligado ao Ergon
 * World e um plano ativo, "Usar Ergon AI" (a mesma ação da página do Ergon World); sem plano, o caminho para a página
 * do Ergon World. As outras contas de IA continuam logo abaixo, sem destaque.
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
  const configurado = !!st.data?.configured;
  const ativo = bound && ['active', 'grace'].includes(bill.data?.entitlement.status ?? '') && !!bill.data?.entitlement.plan_sku;
  // um destaque só: com o Ergon World nesta instalação, o Ergon AI é a melhor escolha
  useEffect(() => { onRecomendado?.(configurado); }, [configurado]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!configurado) return null;
  if (bound && !bill.data) return null;
  const ligado = (ai.data?.byokCustom ?? []).some((c) => /ergon-ai/i.test(`${c.id} ${c.name}`));
  const fig = figura('platao', 'joy', 'front', 2);
  const usar = async () => {
    setBusy(true); setMsg(null);
    try { await api.post('/api/world/ai/connect', { makeDefault: padrao }); setMsg({ kind: 'ok', text: t('ia.ligado') }); ai.reload(); emitLocal('ai.changed'); }
    catch (e) { setMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  return (
    <article className={`ai-best eai ${ligado ? 'ai-best--on' : ''}`} aria-labelledby="eai-titulo">
      <span className="ai-best__ribbon"><Icon name="check" size={12} /> {t('conexoes.melhorEscolha')}</span>
      <header className="ai-best__head">
        {fig ? <img className="eai__fig" src={fig.url} width={fig.w / 2} height={fig.h / 2} alt="" draggable={false} /> : <span className="eai__marca" aria-hidden="true"><Icon name="globe" size={26} /></span>}
        <div>
          <h4 id="eai-titulo">{t('conexoes.titulo')}</h4>
          <p>{t('conexoes.texto')}</p>
        </div>
        {ligado && <span className="badge badge--ok">{t('conexoes.ligado')}</span>}
      </header>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {ativo ? (
        <div className="row row--wrap eai__acoes">
          <button className="btn btn--gold ai-best__cta" disabled={busy} onClick={() => void usar()}>{t('ia.usar')}</button>
          <label className="check"><input type="checkbox" checked={padrao} onChange={(ev) => setPadrao(ev.target.checked)} /> {t('ia.padrao')}</label>
        </div>
      ) : (
        <div className="row row--wrap eai__acoes">
          <a className="btn btn--gold ai-best__cta" href="#world"><Icon name="globe" size={14} /> {t('conexoes.convite.botao')}</a>
          <span className="muted small">{t('conexoes.semPlano')}</span>
        </div>
      )}
    </article>
  );
}

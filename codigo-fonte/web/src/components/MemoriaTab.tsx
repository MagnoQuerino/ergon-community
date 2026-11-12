import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Agent, MemoriaDoAgente } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { useT } from '../i18n/index.ts';

/**
 * A memória longa do agente (rc.27): o que ele guarda sobre você e as anotações dele, de uma conversa para outra. Nada entra
 * sem a sua aprovação: o que ele quis anotar espera aqui até você aprovar ou recusar.
 */
export function MemoriaTab({ agent }: { agent: Pick<Agent, 'id' | 'name'> }) {
  const t = useT();
  const d = useResource<MemoriaDoAgente>(`/api/agents/${agent.id}/memoria`, ['agents.memoria', 'agents.changed']);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!d.data) return <Loading error={d.error} />;
  const m = d.data;
  const decidir = async (id: string, aprovar: boolean) => {
    setBusy(id); setErr(null);
    try { await api.post(`/api/agents/${agent.id}/memoria/${id}`, { aprovar }); d.reload(); }
    catch (x) { setErr(errMsg(x)); }
    finally { setBusy(null); }
  };
  if (!m.pronta) return <div className="train"><p className="hint">{t('agente.memoria.preparando', { nome: agent.name })}</p></div>;
  return (
    <div className="train">
      <p className="hint">{t('agente.memoria.intro', { nome: agent.name })}</p>
      {err && <p className="error-inline small">{err}</p>}
      <div className="block">
        <h4>{t('agente.memoria.esperando')} {m.pendentes.length ? <span className="badge badge--warn">{m.pendentes.length}</span> : null}</h4>
        {m.pendentes.length ? m.pendentes.map((p) => (
          <div key={p.id} className="card card--tight">
            <p className="small muted">{p.alvo === 'pessoa' ? t('agente.memoria.sobreVoce') : t('agente.memoria.notas')}</p>
            <ul className="plain">{p.itens.map((i, k) => (
              <li key={k}>{i.antes ? <><s className="muted">{i.antes}</s> → </> : null}{i.texto || (i.acao === 'remove' ? t('agente.memoria.apagar') : '')}</li>
            ))}</ul>
            <div className="row">
              <button className="btn btn--sm" disabled={busy === p.id} onClick={() => void decidir(p.id, true)}>{t('agente.memoria.aprovar')}</button>
              <button className="btn btn--sm btn--ghost" disabled={busy === p.id} onClick={() => void decidir(p.id, false)}>{t('agente.memoria.recusar')}</button>
            </div>
          </div>
        )) : <p className="hint">{t('agente.memoria.nadaEsperando')}</p>}
      </div>
      <div className="block">
        <h4>{t('agente.memoria.sobreVoce')}</h4>
        {m.pessoa.trim() ? <pre className="memoria__texto">{m.pessoa}</pre> : <p className="hint">{t('agente.memoria.vazia')}</p>}
      </div>
      <div className="block">
        <h4>{t('agente.memoria.notas')}</h4>
        {m.notas.trim() ? <pre className="memoria__texto">{m.notas}</pre> : <p className="hint">{t('agente.memoria.vazia')}</p>}
      </div>
    </div>
  );
}

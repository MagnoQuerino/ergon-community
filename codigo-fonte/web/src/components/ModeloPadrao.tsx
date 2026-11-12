import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { ModelCatalog } from '../lib/types.ts';
import { ModelSelect } from './AgentProfile.tsx';
import { ModelosPorTarefa } from './ModelosPorTarefa.tsx';
import { useT } from '../i18n/index.ts';

/**
 * Modelo padrão da conta: o primeiro item das Contas de IA (em Conexões), porque, com as contas ligadas, é o que a
 * pessoa mais mexe. Vale para os agentes sem modelo próprio; cada agente pode ter o seu, no perfil dele.
 */
export function ModeloPadrao({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const catalog = useResource<ModelCatalog>('/api/ai/models', ['ai.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [def, setDef] = useState<{ model: string | null; provider: string | null }>({ model: null, provider: null });
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { if (catalog.data) setDef({ model: catalog.data.default.model, provider: catalog.data.default.provider }); }, [catalog.data]);

  const salvar = async (force = false) => {
    if (!def.model || !def.provider) return;
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; confirmMessage: string | null }>('/api/ai/default-model', { provider: def.provider, model: def.model, confirm: force });
      if (!r.ok && r.confirmMessage) { setConfirm(r.confirmMessage); return; }
      setConfirm(null); setMsg({ kind: 'ok', text: t('conexoes.modelo.alterado') });
      catalog.reload(); onChanged?.();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  // sem conta conectada, não há o que escolher: a seção fica de fora até a primeira conta
  if (catalog.error || (catalog.data && !catalog.data.providers.length)) return null;
  return (
    <div className="modelo-padrao">
      <div className="modelo-padrao__head">
        <b>{t('conexoes.modelo.titulo')}</b>
        <span className="muted small">{t('conexoes.modelo.texto')}</span>
      </div>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <div className="row row--wrap">
        <ModelSelect catalog={catalog.data} value={def.model} provider={def.provider} allowDefault={false} onChange={(model, provider) => { setDef({ model, provider }); setConfirm(null); }} />
        <button className="btn btn--primary" disabled={!def.model || (def.model === catalog.data?.default.model && def.provider === catalog.data?.default.provider)} onClick={() => void salvar()}>{t('conexoes.acao.salvar')}</button>
      </div>
      {confirm && <div className="confirm">{confirm} <button className="btn btn--sm btn--primary" onClick={() => void salvar(true)}>{t('conexoes.modelo.usarMesmoAssim')}</button><button className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>{t('conexoes.acao.cancelar')}</button></div>}
      <p className="hint">{t('conexoes.modelo.preco')}</p>
      <ModelosPorTarefa />
    </div>
  );
}

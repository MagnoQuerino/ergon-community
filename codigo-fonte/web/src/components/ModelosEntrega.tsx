// Configurações › Modelos de entrega (server/src/services/modelos-entrega.ts): os cinco modelos ativos, enxutos — o
// essencial (travado) e o que a pessoa pediu ao coordenador a mais —, e "Restaurar originais". Ajustar é pela conversa
// com o coordenador ("Ari, nos resumos quero também o valor em R$"); aqui só se vê e se volta ao original.
import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import type { TipoEntrega } from './EntregaDetalhes.tsx';

interface Ativos {
  personalizado: boolean;
  modelos: Array<{ tipo: TipoEntrega; essencial: string[]; extras: Array<{ chave: string; rotulo: string; obrigatorio: boolean }>; tom: string; instrucao: string }>;
}

export function ModelosEntrega({ dono }: { dono: boolean }) {
  const t = useT();
  const d = useResource<Ativos>('/api/modelos-entrega', ['settings.changed']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const restaurar = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/api/modelos-entrega/restaurar', {}); d.reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (!d.data) return null;
  return (
    <section className="card modelos-ent" aria-labelledby="modelos-ent-t">
      <h3 id="modelos-ent-t">{t('configuracoes.modelosEntrega.titulo')}</h3>
      <ul className="modelos-ent__lista">
        {d.data.modelos.map((m) => {
          const ajustado = m.extras.length > 0 || !!m.tom || !!m.instrucao;
          return (
            <li key={m.tipo} className={ajustado ? 'is-ajustado' : ''}>
              <span className="modelos-ent__nome">{t(`tarefa.entrega.tipo.${m.tipo}`)}</span>
              <span className="muted small">
                {ajustado
                  ? [...m.extras.map((x) => x.rotulo), ...(m.tom ? [t('configuracoes.modelosEntrega.tom', { tom: m.tom })] : []), ...(m.instrucao ? [m.instrucao] : [])].join(' · ')
                  : t('configuracoes.modelosEntrega.original')}
              </span>
            </li>
          );
        })}
      </ul>
      {err && <p className="error" role="alert">{err}</p>}
      {dono && d.data.personalizado && (
        <button className="btn btn--sm" aria-busy={busy} onClick={() => void restaurar()}><Icon name="undo" size={14} /> {t('configuracoes.modelosEntrega.restaurar')}</button>
      )}
    </section>
  );
}

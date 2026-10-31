import type { Agent, AgentTool, ModelCatalog } from '../lib/types.ts';

export const TOOL_BADGE: Record<AgentTool['status'], string> = {
  'disponível': 'badge--ok', 'parcial': 'badge--warn', 'desligada': 'badge--plan', 'bloqueada': 'badge--plan', 'preparado': 'badge--sim', 'planejado': 'badge--plan',
};
const HINT_LABEL: Record<NonNullable<Agent['model_hint']>, string> = {
  ponta: 'modelo de ponta', intermediário: 'modelo intermediário', econômico: 'modelo econômico',
};

/** Nome curto de um modelo ("anthropic/claude-sonnet-5.5" → "Claude Sonnet 5.5"), igual ao do servidor. */
export function modelName(id: string | null, catalog?: ModelCatalog | null): string {
  if (!id) return 'padrão da conta';
  for (const p of catalog?.providers ?? []) { const m = p.models.find((x) => x.id === id); if (m) return m.label; }
  const base = id.split(':')[0];
  return (base.includes('/') ? base.split('/').slice(1).join('/') : base).split(/[-_]/).filter(Boolean)
    .map((w) => (/^gpt$/i.test(w) ? 'GPT' : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** O que o perfil mostra: só existe no perfil completo (GET /api/agents/:id), não nas linhas leves das listas. */
export type ProfileFields = Pick<Agent, 'bio' | 'skills' | 'tools' | 'model' | 'model_hint'>;

/** Perfil do agente: bio, métodos, ferramentas (com o estado real) e o modelo que ele usa. */
export function AgentProfile({ agent, compact }: { agent: ProfileFields; compact?: boolean }) {
  if (!agent.bio && !agent.skills.length && !agent.tools.length) return null;
  return (
    <div className={`profile ${compact ? 'profile--compact' : ''}`}>
      {agent.bio && <p className="profile__bio">{agent.bio}</p>}
      {agent.skills.length > 0 && (
        <div className="profile__row" aria-label="Métodos">
          <span className="profile__label">Métodos</span>
          {agent.skills.map((s) => <span key={s} className="skill">{s}</span>)}
        </div>
      )}
      {agent.tools.length > 0 && (
        <div className="profile__row" aria-label="Ferramentas">
          <span className="profile__label">Ferramentas</span>
          {agent.tools.map((t) => (
            <span key={t.id} className={`badge ${TOOL_BADGE[t.status]}`} title={`${t.status}: ${t.note}`}>{t.label}{t.status !== 'disponível' ? ` · ${t.status}` : ''}</span>
          ))}
        </div>
      )}
      <p className="profile__model">
        Modelo: <strong>{modelName(agent.model)}</strong>
        {!agent.model && agent.model_hint && !compact && <span className="muted"> · indicado para o papel: {HINT_LABEL[agent.model_hint]}</span>}
      </p>
    </div>
  );
}

/** Seletor de modelo: "padrão da conta" + modelos das contas conectadas, com faixa e preço publicado. */
export function ModelSelect({ catalog, value, provider, onChange, allowDefault = true, id }: {
  catalog: ModelCatalog | null; value: string | null; provider: string | null; allowDefault?: boolean; id?: string;
  onChange: (model: string | null, provider: string | null) => void;
}) {
  const key = value ? `${provider ?? ''}::${value}` : '';
  const price = (m: { input: number | null; output: number | null; tier: string | null }) =>
    m.tier === 'grátis' ? 'grátis' : m.input !== null ? `US$ ${m.input.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / ${m.output?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '?'} por milhão de tokens` : '';
  return (
    <select id={id} value={key} onChange={(e) => { const v = e.target.value; if (!v) onChange(null, null); else { const [p, ...rest] = v.split('::'); onChange(rest.join('::'), p); } }}>
      {allowDefault && <option value="">Padrão da conta{catalog?.default.model ? ` (${catalog.default.label})` : ''}</option>}
      {catalog?.providers.map((p) => (
        <optgroup key={p.id} label={`${p.name}${p.billing === 'subscription' ? ' — assinatura, sem custo por uso' : ''}`}>
          {p.models.map((m) => (
            <option key={m.id} value={`${p.id}::${m.id}`}>{m.label}{m.vendor ? ` · ${m.vendor}` : ''}{m.tier ? ` · ${m.tier}` : ''}{price(m) ? ` · ${price(m)}` : ''}</option>
          ))}
        </optgroup>
      ))}
      {value && !catalog?.providers.some((p) => p.models.some((m) => m.id === value)) && <option value={key}>{modelName(value)} (conta não conectada)</option>}
    </select>
  );
}

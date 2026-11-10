import type { Agent, AgentTool, ModelCatalog, ModelEntry } from '../lib/types.ts';
import { fmtNumero, t, tn, useT } from '../i18n/index.ts';

export const TOOL_BADGE: Record<AgentTool['status'], string> = {
  'disponível': 'badge--ok', 'parcial': 'badge--warn', 'desligada': 'badge--plan', 'bloqueada': 'badge--plan', 'preparado': 'badge--sim', 'planejado': 'badge--plan',
  'atualizando': 'badge--warn',
};
/** O estado da ferramenta (o servidor manda em português, como código) no idioma da tela. */
const TOOL_STATUS = {
  'disponível': 'equipe.ferramenta.disponivel', 'parcial': 'equipe.ferramenta.parcial', 'desligada': 'equipe.ferramenta.desligada',
  'bloqueada': 'equipe.ferramenta.bloqueada', 'preparado': 'equipe.ferramenta.preparado', 'planejado': 'equipe.ferramenta.planejado',
  'atualizando': 'equipe.ferramenta.atualizando',
} as const satisfies Record<AgentTool['status'], string>;
export const toolStatusLabel = (s: AgentTool['status']): string => (TOOL_STATUS[s] ? t(TOOL_STATUS[s]) : s);
const HINT_LABEL = {
  ponta: 'equipe.modelo.ponta', intermediário: 'equipe.modelo.intermediario', econômico: 'equipe.modelo.economico',
} as const satisfies Record<NonNullable<Agent['model_hint']>, string>;
const TIER_LABEL = {
  grátis: 'equipe.faixa.gratis', econômico: 'equipe.faixa.economico', intermediário: 'equipe.faixa.intermediario', ponta: 'equipe.faixa.ponta',
} as const satisfies Record<NonNullable<ModelEntry['tier']>, string>;

/** Nome curto de um modelo ("anthropic/claude-sonnet-5.5" → "Claude Sonnet 5.5"), igual ao do servidor. */
export function modelName(id: string | null, catalog?: ModelCatalog | null): string {
  if (!id) return t('equipe.modelo.padraoDaConta');
  for (const p of catalog?.providers ?? []) { const m = p.models.find((x) => x.id === id); if (m) return m.label; }
  const base = id.split(':')[0];
  return (base.includes('/') ? base.split('/').slice(1).join('/') : base).split(/[-_]/).filter(Boolean)
    .map((w) => (/^gpt$/i.test(w) ? 'GPT' : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** O que o perfil mostra: só existe no perfil completo (GET /api/agents/:id), não nas linhas leves das listas. */
export type ProfileFields = Pick<Agent, 'bio' | 'skills' | 'tools' | 'model' | 'model_hint'>;

/** Perfil do agente: bio, métodos, ferramentas (com o estado real) e o modelo que ele usa. */
export function AgentProfile({ agent, compact }: { agent: ProfileFields; compact?: boolean }) {
  const t = useT();
  if (!agent.bio && !agent.skills.length && !agent.tools.length) return null;
  return (
    <div className={`profile ${compact ? 'profile--compact' : ''}`}>
      {agent.bio && <p className="profile__bio">{agent.bio}</p>}
      {agent.skills.length > 0 && (
        <div className="profile__row" aria-label={t('equipe.perfil.metodos')}>
          <span className="profile__label">{t('equipe.perfil.metodos')}</span>
          {agent.skills.map((s) => <span key={s} className="skill">{s}</span>)}
        </div>
      )}
      {agent.tools.length > 0 && (
        <div className="profile__row" aria-label={t('equipe.perfil.ferramentas')}>
          <span className="profile__label">{t('equipe.perfil.ferramentas')}</span>
          {agent.tools.map((x) => (
            // i18n-ok: 'disponível' é o código do estado que o servidor manda, não texto de tela
            <span key={x.id} className={`badge ${TOOL_BADGE[x.status]}`} title={`${toolStatusLabel(x.status)}: ${x.note}`}>{x.label}{x.status !== 'disponível' ? ` · ${toolStatusLabel(x.status)}` : ''}</span>
          ))}
        </div>
      )}
      <p className="profile__model">
        {tn('equipe.perfil.modelo', { nome: <strong>{modelName(agent.model)}</strong> })}
        {!agent.model && agent.model_hint && !compact && <span className="muted">{t('equipe.perfil.indicado', { tipo: t(HINT_LABEL[agent.model_hint]) })}</span>}
      </p>
    </div>
  );
}

/** Seletor de modelo: "padrão da conta" + modelos das contas conectadas, com faixa e preço publicado. */
export function ModelSelect({ catalog, value, provider, onChange, allowDefault = true, id }: {
  catalog: ModelCatalog | null; value: string | null; provider: string | null; allowDefault?: boolean; id?: string;
  onChange: (model: string | null, provider: string | null) => void;
}) {
  const t = useT();
  const key = value ? `${provider ?? ''}::${value}` : '';
  const dinheiro = (v: number) => fmtNumero(v, { minimumFractionDigits: 2 });
  const tier = (x: ModelEntry['tier']) => (x && TIER_LABEL[x] ? t(TIER_LABEL[x]) : x);
  const price = (m: ModelEntry) =>
    // i18n-ok: 'grátis' é o código da faixa que o servidor manda, não texto de tela
    m.tier === 'grátis' ? t('equipe.faixa.gratis') : m.input !== null ? t('equipe.modelo.preco', { entrada: dinheiro(m.input), saida: m.output !== null ? dinheiro(m.output) : '?' }) : '';
  return (
    <select id={id} value={key} onChange={(e) => { const v = e.target.value; if (!v) onChange(null, null); else { const [p, ...rest] = v.split('::'); onChange(rest.join('::'), p); } }}>
      {allowDefault && <option value="">{catalog?.default.model ? t('equipe.modelo.padraoDaContaCom', { modelo: catalog.default.label }) : t('equipe.modelo.padraoDaContaOpcao')}</option>}
      {catalog?.providers.map((p) => (
        <optgroup key={p.id} label={p.billing === 'subscription' ? t('equipe.modelo.assinatura', { nome: p.name }) : p.name}>
          {p.models.map((m) => (
            <option key={m.id} value={`${p.id}::${m.id}`}>{m.label}{m.vendor ? ` · ${m.vendor}` : ''}{m.tier ? ` · ${tier(m.tier)}` : ''}{price(m) ? ` · ${price(m)}` : ''}</option>
          ))}
        </optgroup>
      ))}
      {value && !catalog?.providers.some((p) => p.models.some((m) => m.id === value)) && <option value={key}>{t('equipe.modelo.naoConectada', { modelo: modelName(value) })}</option>}
    </select>
  );
}

import { useState } from 'react';
import { EXTREME_WARNING, PERSONALITIES, PERSONALITY, type PersonalityId } from '../../../shared/personalities.ts';
import { api, errMsg } from '../lib/api.ts';
import type { Agent } from '../lib/types.ts';
import { ConfirmPopup } from './ConfirmPopup.tsx';

const GROUPS: Array<{ id: 'dia a dia' | 'humor' | 'extremo'; label: string }> = [
  { id: 'dia a dia', label: 'Do dia a dia' }, { id: 'humor', label: 'Com humor' }, { id: 'extremo', label: 'Extremos' },
];

/**
 * Personalidade do colega: o jeito de falar com você na conversa (o trabalho e as entregas não mudam). Vale na hora,
 * sem "Salvar". Os dois extremos pedem o aviso antes ("OK, eu sei onde estou me metendo").
 */
export function PersonalityPicker({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const cur = (agent.personality ?? 'cordial') as PersonalityId;
  const [hover, setHover] = useState<PersonalityId | null>(null);
  const [confirm, setConfirm] = useState<PersonalityId | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const shown = PERSONALITY[hover ?? cur] ?? PERSONALITY.cordial;
  const apply = async (id: PersonalityId, accepted = false) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/agents/${agent.id}/personality`, { personality: id, ...(accepted ? { accepted: true } : {}) });
      setMsg({ kind: 'ok', text: `${agent.name} agora fala com você no jeito ${PERSONALITY[id].label.toLowerCase()}. Vale a partir da próxima mensagem.` });
      onChanged();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const pick = (id: PersonalityId) => { if (id === cur) return; if (PERSONALITY[id].extreme) setConfirm(id); else void apply(id); };
  return (
    <div className="persona">
      <div className="persona__head"><b>Personalidade</b><span className="hint">O jeito de {agent.name} falar com você. O trabalho continua o mesmo, e documentos e mensagens para outras pessoas saem sempre profissionais.</span></div>
      {GROUPS.map((g) => (
        <div key={g.id} className="persona__group" role="radiogroup" aria-label={g.label}>
          <span className="persona__group-name">{g.label}</span>
          <div className="persona__opts">
            {PERSONALITIES.filter((p) => p.group === g.id).map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === cur} disabled={busy}
                className={`persona__opt ${p.id === cur ? 'is-on' : ''} ${p.extreme ? 'persona__opt--extreme' : ''}`}
                onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)}
                onClick={() => pick(p.id)} title={p.summary}>
                <b>{p.label}</b><small>{p.summary}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="persona__preview" aria-live="polite">
        <span className="muted small">{hover && hover !== cur ? `Se escolher ${shown.label}:` : `Hoje, ${shown.label}:`}</span>
        {shown.examples.map((e) => <p key={e} className="persona__bubble">{e}</p>)}
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'hint ok' : 'error'} role="status">{msg.text}</p>}
      {confirm && (
        <ConfirmPopup title={`${PERSONALITY[confirm].label}: tem certeza?`} confirmLabel="OK, eu sei onde estou me metendo"
          onConfirm={() => { const id = confirm; setConfirm(null); void apply(id, true); }} onCancel={() => setConfirm(null)}>
          <p>{EXTREME_WARNING}</p>
          <p className="persona__bubble">{PERSONALITY[confirm].examples[0]}</p>
        </ConfirmPopup>
      )}
    </div>
  );
}

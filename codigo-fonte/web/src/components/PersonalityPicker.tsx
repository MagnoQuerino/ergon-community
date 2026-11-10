import { useState } from 'react';
import { PERSONALITIES, PERSONALITY, type PersonalityId } from '../../../shared/personalities.ts';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import type { Agent } from '../lib/types.ts';
import { ConfirmPopup } from './ConfirmPopup.tsx';

const GROUPS = [
  { id: 'dia a dia', label: 'equipe.persona.grupo.diaADia' }, { id: 'humor', label: 'equipe.persona.grupo.humor' }, { id: 'extremo', label: 'equipe.persona.grupo.extremo' },
] as const;

/**
 * Personalidade do colega: o jeito de falar com você na conversa (o trabalho e as entregas não mudam). Vale na hora,
 * sem "Salvar". Os dois extremos pedem o aviso antes ("OK, eu sei onde estou me metendo"). O nome, o resumo e os
 * exemplos que a tela mostra vêm do dicionário (equipe.persona.<id>.*); o jeito de falar que vai para o modelo fica em
 * shared/personalities.ts.
 */
export function PersonalityPicker({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const t = useT();
  const cur = (agent.personality ?? 'cordial') as PersonalityId;
  const [hover, setHover] = useState<PersonalityId | null>(null);
  const [confirm, setConfirm] = useState<PersonalityId | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const shownId: PersonalityId = PERSONALITY[hover ?? cur] ? (hover ?? cur) : 'cordial';
  const nome = (id: PersonalityId) => t(`equipe.persona.${id}.nome`);
  const resumo = (id: PersonalityId) => t(`equipe.persona.${id}.resumo`);
  const exemplos = (id: PersonalityId) => t(`equipe.persona.${id}.exemplos`).split('\n');
  const apply = async (id: PersonalityId, accepted = false) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/agents/${agent.id}/personality`, { personality: id, ...(accepted ? { accepted: true } : {}) });
      setMsg({ kind: 'ok', text: t('equipe.persona.aplicada', { nome: agent.name, jeito: nome(id).toLowerCase() }) });
      onChanged();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const pick = (id: PersonalityId) => { if (id === cur) return; if (PERSONALITY[id].extreme) setConfirm(id); else void apply(id); };
  return (
    <div className="persona">
      <div className="persona__head"><b>{t('equipe.persona.titulo')}</b><span className="hint">{t('equipe.persona.dica', { nome: agent.name })}</span></div>
      {GROUPS.map((g) => (
        <div key={g.id} className="persona__group" role="radiogroup" aria-label={t(g.label)}>
          <span className="persona__group-name">{t(g.label)}</span>
          <div className="persona__opts">
            {PERSONALITIES.filter((p) => p.group === g.id).map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === cur} disabled={busy}
                className={`persona__opt ${p.id === cur ? 'is-on' : ''} ${p.extreme ? 'persona__opt--extreme' : ''}`}
                onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)}
                onClick={() => pick(p.id)} title={resumo(p.id)}>
                <b>{nome(p.id)}</b><small>{resumo(p.id)}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="persona__preview" aria-live="polite">
        <span className="muted small">{hover && hover !== cur ? t('equipe.persona.seEscolher', { nome: nome(shownId) }) : t('equipe.persona.hoje', { nome: nome(shownId) })}</span>
        {exemplos(shownId).map((e) => <p key={e} className="persona__bubble">{e}</p>)}
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'hint ok' : 'error'} role="status">{msg.text}</p>}
      {confirm && (
        <ConfirmPopup title={t('equipe.persona.temCerteza', { nome: nome(confirm) })} confirmLabel={t('equipe.persona.aceitar')}
          onConfirm={() => { const id = confirm; setConfirm(null); void apply(id, true); }} onCancel={() => setConfirm(null)}>
          <p>{t('equipe.persona.aviso')}</p>
          <p className="persona__bubble">{exemplos(confirm)[0]}</p>
        </ConfirmPopup>
      )}
    </div>
  );
}

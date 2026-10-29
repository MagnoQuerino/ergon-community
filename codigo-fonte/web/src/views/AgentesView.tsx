import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import type { Agent, AppState } from '../lib/types.ts';
import { Icon } from '../components/Icon.tsx';
import { modelName } from '../components/AgentProfile.tsx';
import { coordName } from '../lib/team.ts';

const RUN_LABEL: Record<string, string> = { running: 'trabalhando', queued: 'na fila', waiting_user: 'aguarda você' };

export function AgentesView({ state, reload, onOpen }: { state: AppState; reload: () => void; onOpen: (id: string, tab?: 'conversa' | 'perfil') => void }) {
  const [form, setForm] = useState({ name: '', role: '', sectorKey: 'auto', structureId: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [where, setWhere] = useState<string>(''); // '' = cidade inteira
  const [busy, setBusy] = useState(false);
  const work = state.structures.filter((s) => s.floors.length);
  const cap = state.capacity;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  const create = async () => {
    setMsg(null); setBusy(true);
    try {
      const r = await api.post<{ id: string; sector: string; sectorReason: string | null }>('/api/agents', {
        name: form.name.trim(), role: form.role.trim(), sectorKey: form.sectorKey, ...(form.structureId ? { structureId: form.structureId } : {}),
      });
      setForm({ name: '', role: '', sectorKey: 'auto', structureId: '' });
      setMsg({ kind: 'ok', text: `${form.name.trim()} entrou no setor ${r.sector}${r.sectorReason ? ` (automático: ${r.sectorReason})` : ''}. Ajuste instruções, modelo e ferramentas no perfil.` });
      reload();
      onOpen(r.id, 'perfil');
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };

  const sel = work.find((s) => s.id === where) ?? null;
  const occ = (floors: Array<{ slots: number; active: number }>) => floors.reduce((a, f) => ({ slots: a.slots + f.slots, active: a.active + f.active }), { slots: 0, active: 0 });
  const active = state.agents.filter((a) => a.status === 'active');
  const off = state.agents.filter((a) => a.status !== 'active');
  const bySector = state.sectors.map((s) => ({ s, agents: active.filter((a) => a.profile === s.key) })).filter((g) => g.agents.length || !g.s.custom);

  return (
    <div className="page">
      <header className="page__head">
        <h2>Agentes</h2>
        <p className="muted">Cada agente é um especialista com instruções, ferramentas e modelo próprios, organizado em setores. {coordName(state.agents)} é o Coordenador — o único cargo fixo: encaminha os pedidos, controla as travas de ferramentas e redistribui o trabalho quando alguém sai. Os outros agentes são todos seus para criar, mudar ou desativar, quantos quiser.</p>
        {state.themed > 0 && (
          <p className="hint theme-note">
            <Icon name="palette" size={14} /> {state.themed === 1 ? 'Um nome da equipe de partida (personagem ou setor) está' : `${state.themed} nomes da equipe de partida (personagens ou setores) estão`} diferentes do tema padrão.{' '}
            <button className="linkish" onClick={() => act(async () => {
              const r = await api.post<{ restored: string[]; skipped: string[] }>('/api/team/restore-theme');
              if (r.skipped.length) throw new Error(`Voltaram: ${r.restored.join(', ') || 'nenhum'}. Ficaram como estão: ${r.skipped.join('; ')}.`);
            }, 'Pronto: nomes e histórias gregos de volta, e os setores com os nomes do seu perfil. Funções e instruções continuam como estavam.')}>Voltar aos nomes e histórias gregos</button>
          </p>
        )}
      </header>

      <section className="card">
        <div className="row row--wrap cap-head">
          <h3>Capacidade</h3>
          <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Construção">
            <option value="">Cidade (todas as construções)</option>
            {work.map((s) => { const o = occ(s.floors); return <option key={s.id} value={s.id}>{s.name} — {o.active}/{o.slots}</option>; })}
          </select>
        </div>
        {!sel ? (
          <>
            <p className="cap-total"><strong>{cap.active}</strong> de <strong>{cap.slots}</strong> vagas ocupadas na cidade · {cap.free} livre{cap.free === 1 ? '' : 's'}</p>
            <div className="cap-list">
              {work.map((s) => {
                const o = occ(s.floors);
                return (
                  <button key={s.id} className="cap-row" onClick={() => setWhere(s.id)} title={`Ver ${s.name}`}>
                    <span className="cap-row__name">{s.name}</span>
                    <span className="bar" aria-label={`${o.active} de ${o.slots} vagas`}><span style={{ width: `${o.slots ? (o.active / o.slots) * 100 : 0}%` }} /></span>
                    <span className="muted">{o.active}/{o.slots} · {s.floors.length} andar{s.floors.length === 1 ? '' : 'es'}</span>
                  </button>
                );
              })}
            </div>
            <p className="hint">Vagas vêm dos andares. Na versão local você tem quantos agentes quiser: sem vaga, a cidade ganha um andar ou uma construção nova sozinha (grátis). Também dá para crescer à mão: escolha uma construção acima e adicione andares, ou construa num lote livre (em Ambiente).</p>
          </>
        ) : (
          <>
            <div className="floors">
              {[...sel.floors].reverse().map((f, k) => (
                <div key={f.id} className="floor-row">
                  <span className="floor-row__name">{f.name}</span>
                  <span className="slots" aria-label={`${f.active} de ${f.slots} vagas ocupadas`}>
                    {Array.from({ length: f.slots }, (_, i) => <span key={i} className={`slot ${i < f.active ? 'slot--on' : ''}`} />)}
                  </span>
                  <span className="muted small">{active.filter((a) => a.floor_id === f.id).map((a) => a.name).join(', ') || 'vazio'}</span>
                  {k === 0 && f.origin === 'simulated' && f.active === 0 && (
                    <button className="btn btn--sm btn--ghost" onClick={() => act(() => api.del(`/api/floors/${f.id}`), `Andar removido de ${sel.name}.`)}>Remover andar</button>
                  )}
                </div>
              ))}
            </div>
            <div className="row">
              <button className="btn btn--sm" onClick={() => act(() => api.post(`/api/structures/${sel.id}/floors`), `Andar adicionado em ${sel.name} (grátis).`)}><Icon name="plus" size={13} /> Adicionar andar</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setWhere('')}>Ver a cidade</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h3>Novo agente</h3>
        <form className="newagent" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="field">Nome<input required maxLength={40} placeholder="ex.: Temístocles" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">Papel<input required maxLength={80} placeholder="ex.: Vendas e propostas comerciais" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></label>
          <label className="field">Setor
            <select value={form.sectorKey} onChange={(e) => setForm({ ...form, sectorKey: e.target.value })}>
              <option value="auto">Automático (a coordenação escolhe pelo papel)</option>
              {state.sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
          <label className="field">Alocação
            <select value={form.structureId} onChange={(e) => setForm({ ...form, structureId: e.target.value })}>
              <option value="">Automática (primeira vaga)</option>
              {work.map((s) => { const o = occ(s.floors); return <option key={s.id} value={s.id} disabled={o.active >= o.slots}>{s.name} ({o.slots - o.active} vaga{o.slots - o.active === 1 ? '' : 's'})</option>; })}
            </select>
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>Criar</button>
        </form>
        <p className="hint">Começa com as instruções, métodos e ferramentas recomendados do setor e o modelo padrão da conta. Depois você ajusta no perfil, ou pede à coordenação que escreva. Também dá para pedir na conversa com {coordName(state.agents)}: "crie um agente chamado X para Y".</p>
        {cap.free === 0 && <p className="hint warn">Sem vagas: adicione um andar a uma construção (acima) ou desative um agente.</p>}
      </section>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      {bySector.map(({ s, agents }) => (
        <section key={s.key} className="sector">
          <header className="sector__head">
            <h3>{s.name} <span className="muted">· {agents.length}</span></h3>
            {s.description && <p className="muted small">{s.description}</p>}
          </header>
          <div className="grid">
            {agents.map((a) => <AgentCard key={a.id} a={a} state={state} onOpen={onOpen} />)}
            {!agents.length && <p className="hint">Ninguém neste setor ainda.</p>}
          </div>
        </section>
      ))}

      {off.length > 0 && (
        <details className="sector">
          <summary className="muted">Desativados ({off.length})</summary>
          <div className="grid">{off.map((a) => <AgentCard key={a.id} a={a} state={state} onOpen={onOpen} />)}</div>
        </details>
      )}
    </div>
  );
}

function AgentCard({ a, state, onOpen }: { a: Agent; state: AppState; onOpen: (id: string, tab?: 'conversa' | 'perfil') => void }) {
  const b = state.structures.find((s) => s.id === a.building_id);
  const usable = a.tools.filter((t) => t.status === 'disponível' || t.status === 'parcial');
  return (
    <article className={`agent-card agent-card--click ${a.status !== 'active' ? 'agent-card--off' : ''}`} role="button" tabIndex={0}
      onClick={() => onOpen(a.id, a.status === 'active' ? 'conversa' : 'perfil')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a.id); } }}
      aria-label={`Abrir ${a.name}`}>
      <span className="avatar" style={{ background: a.color }}>{a.name[0]}</span>
      <div className="agent-card__body">
        <strong>{a.name}{a.coordinator ? <span className="badge badge--fixed" title="O único cargo fixo: sempre na equipe; a função não muda"><Icon name="lock" size={11} /> cargo fixo</span> : null}</strong>
        <span>{a.role}</span>
        <span className="muted small">{b?.name ?? '—'} · modelo: {modelName(a.model)}{a.demo ? ' · demonstração' : ''}</span>
        {a.run_status && <span className="badge badge--warn">{RUN_LABEL[a.run_status]}</span>}
        {a.status !== 'active' && <span className="muted small">{a.deactivation_note ?? 'desativado'}</span>}
        <div className="profile__row">{usable.slice(0, 5).map((t) => <span key={t.id} className="badge badge--ok">{t.label}</span>)}{usable.length > 5 && <span className="badge">+{usable.length - 5}</span>}</div>
      </div>
      {a.status === 'active' && (
        <div className="agent-card__actions">
          <button className="btn btn--sm" onClick={(e) => { e.stopPropagation(); onOpen(a.id, 'conversa'); }}><Icon name="chat" size={14} /> Conversar</button>
        </div>
      )}
    </article>
  );
}

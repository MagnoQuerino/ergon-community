import { useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { keepTyped, useSurface } from '../lib/surface.ts';
import { teamUrl, useGroupPages, type TeamSector } from '../lib/teamData.ts';
import { newSeed } from '../world/pack.ts';
import { AgentPreview } from './AgentPreview.tsx';
import { EffectPicker, effectsFor, useFxOptions, type FxChoice } from './EffectPicker.tsx';
import { Icon } from './Icon.tsx';
import { MoveTray, type Pick } from './MoveTray.tsx';

const COLORS = ['#2f6f8f', '#8a5a2b', '#c2603a', '#3f7d4e', '#6b4f8f', '#a33b4c', '#2d5f5a', '#b07d1f', '#4a5a8c', '#7a6a3a'];
const SHOWN = 6;

/**
 * Novo agente: a prévia à esquerda é exatamente o boneco que será salvo (a semente e a cor vão junto na criação).
 * "Sortear outro" troca só a aparência; digitar, escolher setor, endereço ou efeito não sorteia de novo. Instruções,
 * ferramentas e modelo começam com o padrão do setor e ficam no perfil.
 */
export function NewAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { id: string; name: string; sector: string; sectorReason: string | null }) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [seed, setSeed] = useState(() => newSeed());
  const [color] = useState(() => COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [name, setName] = useState(''); const [role, setRole] = useState('');
  const [sector, setSector] = useState<{ key: string; name: string } | null>(null); // null = automático
  const [place, setPlace] = useState<{ id: string; name: string } | null>(null); // null = primeiro lugar livre
  const [fx, setFx] = useState<FxChoice>({ mode: 'inherit' });
  const [tray, setTray] = useState<'sector' | 'structure' | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const dirty = !!(name || role);
  const close = () => { if (!busy && keepTyped(dirty, 'o agente novo')) onClose(); };
  useSurface(ref, { onClose: close, modal: true, outside: true, active: !tray });
  const sectors = useGroupPages<TeamSector>((c) => `${teamUrl.sectors('', c, SHOWN)}&sample=0`, 'novo');
  const options = useFxOptions();
  const draft = useMemo(() => ({ name: name.trim() || 'Novo agente', color, role, look_seed: seed }), [name, color, role, seed]);
  const effects = effectsFor(fx, options, { name });
  const shownSectors = sectors.data?.items ?? [];
  const extraSector = sector && !shownSectors.some((s) => s.key === sector.key);

  const create = async () => {
    if (busy) return; // duplo clique não cria dois
    if (!name.trim() || !role.trim()) { setErr('Preencha o nome e o que ele faz.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ id: string; sector: string; sectorReason: string | null }>('/api/agents', {
        name: name.trim(), role: role.trim(), sectorKey: sector?.key ?? 'auto', lookSeed: seed, color,
        ...(place ? { structureId: place.id } : {}), ...(fx.mode !== 'inherit' ? { fx } : {}),
      });
      onCreated({ ...r, name: name.trim() });
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };

  const pick = (p: Pick) => {
    if (p.kind === 'sector') setSector({ key: p.key, name: p.name }); else setPlace({ id: p.id, name: p.name });
    setTray(null);
  };

  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg newagent2" role="dialog" aria-modal="true" aria-labelledby="newagent-t">
        <header className="dlg__head">
          <h3 id="newagent-t">Novo agente</h3>
          <button className="icon-btn" onClick={close} aria-label="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        <form className="newagent2__body" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="newagent2__look">
            <div className="newagent2__stage"><AgentPreview agent={draft} fx={effects} size={5} label={`Prévia de ${draft.name}`} /></div>
            <button type="button" className="btn btn--ghost btn--block" onClick={() => setSeed(newSeed())}><Icon name="shuffle" size={14} /> Sortear outro</button>
            <strong className="center">{draft.name}</strong>
            <span className="muted small center">Mesmo boneco na cidade e no perfil</span>
          </div>
          <div className="newagent2__fields">
            <label className="field">Nome<input required maxLength={40} placeholder="ex.: Temístocles" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
            <label className="field">O que ele faz?<input required maxLength={80} placeholder="ex.: Propostas comerciais" value={role} onChange={(e) => setRole(e.target.value)} /></label>
            <div className="field"><span>Setor</span>
              <div className="chips" role="group" aria-label="Setor">
                <button type="button" className={`chip chip--pick ${!sector ? 'is-on' : ''}`} aria-pressed={!sector} onClick={() => setSector(null)} title="A coordenação escolhe pelo que ele faz">Automático</button>
                {shownSectors.map((s) => <button key={s.key} type="button" className={`chip chip--pick ${sector?.key === s.key ? 'is-on' : ''}`} aria-pressed={sector?.key === s.key} onClick={() => setSector({ key: s.key, name: s.name })}>{s.name}</button>)}
                {extraSector && <button type="button" className="chip chip--pick is-on" aria-pressed>{sector!.name}</button>}
                {(sectors.data?.total ?? 0) > SHOWN && <button type="button" className="chip chip--pick" onClick={() => setTray('sector')}><Icon name="search" size={12} /> Outro setor…</button>}
              </div>
            </div>
            <div className="field"><span>Endereço</span>
              <div className="newagent2__place">
                <button type="button" className="newagent2__placebtn" onClick={() => setTray('structure')}>
                  <Icon name="pin" size={14} /> {place ? place.name : 'Primeiro lugar livre · ajuste depois'}
                </button>
                {place && <button type="button" className="icon-btn" onClick={() => setPlace(null)} aria-label="Voltar ao primeiro lugar livre" title="Voltar ao primeiro lugar livre"><Icon name="x" size={14} /></button>}
              </div>
            </div>
            <div className="field"><span>Efeitos dos seus Pacotes</span><EffectPicker value={fx} onChange={setFx} options={options} /></div>
            {err && <p className="error" role="alert">{err}</p>}
          </div>
          <footer className="dlg__foot">
            <button type="button" className="btn btn--ghost" onClick={close}>Cancelar</button>
            <button type="submit" className="btn btn--primary" aria-busy={busy}><Icon name="plus" size={14} /> {busy ? 'Criando…' : 'Criar agente'}</button>
          </footer>
        </form>
      </section>
      {tray && <MoveTray agent={null} kinds={[tray]} initial={tray} title={tray === 'sector' ? 'Setor do agente novo' : 'Endereço do agente novo'} onPick={pick} onClose={() => setTray(null)} />}
    </div>
  );
}

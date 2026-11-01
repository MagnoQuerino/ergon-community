import { useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { CATALOG } from '../../../shared/city.ts';
import { Icon } from './Icon.tsx';

/** Construções de trabalho que a loja oferece (as cívicas, como a ágora, são únicas e já vêm com a cidade). */
const WORK = CATALOG.filter((t) => t.category === 'trabalho' && t.store);

export type NewGroup = { kind: 'sector'; key: string; name: string } | { kind: 'structure'; id: string; name: string };

/**
 * Setor ou construção nova direto na Equipe. O setor nasce com as instruções e ferramentas de partida da Central (dá
 * para ajustar depois); a construção vai sozinha para o lote livre mais perto do centro da cidade, sem escolher lote.
 */
export function NewGroupDialog({ kind, onClose, onCreated }: { kind: 'sector' | 'structure'; onClose: () => void; onCreated: (g: NewGroup) => void }) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [type, setType] = useState(WORK[0]?.id ?? 'stoa');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sector = kind === 'sector';
  const t = WORK.find((x) => x.id === type);
  const ok = sector ? name.trim().length > 0 : !!t;

  const save = async () => {
    if (busy) return;
    if (!ok) { setErr(sector ? 'Dê um nome ao setor.' : 'Escolha o tipo de construção.'); return; }
    setBusy(true); setErr(null);
    try {
      if (sector) {
        const r = await api.post<{ key: string; name: string }>('/api/sectors', { name: name.trim(), ...(desc.trim() ? { description: desc.trim() } : {}) });
        onCreated({ kind: 'sector', key: r.key, name: r.name });
      } else {
        const label = name.trim() || t!.name;
        const r = await api.post<{ id: string }>('/api/structures', { kind: type, ...(name.trim() ? { name: name.trim() } : {}) });
        onCreated({ kind: 'structure', id: r.id, name: label });
      }
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg newgroup" role="dialog" aria-modal="true" aria-labelledby="newgroup-t">
        <header className="dlg__head">
          <h3 id="newgroup-t">{sector ? 'Novo setor' : 'Nova construção'}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {sector ? (
            <>
              <p className="muted small">Um grupo de especialistas com o mesmo tipo de trabalho. Depois é só arrastar colegas para ele ou usar “Mover para…”.</p>
              <label className="field"><span>Nome do setor</span>
                <input data-autofocus autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Atendimento, Jurídico, Conteúdo" /></label>
              <label className="field"><span>O que esse setor faz <span className="muted">(opcional)</span></span>
                <textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} rows={2} placeholder="Ex.: responde clientes e organiza os pedidos" /></label>
            </>
          ) : (
            <>
              <p className="muted small">A construção aparece sozinha na cidade, no lugar livre mais perto do centro. Depois dá para arrastá-la no editor da Cidade.</p>
              <div className="newgroup__types" role="radiogroup" aria-label="Tipo de construção">
                {WORK.map((x) => (
                  <button type="button" key={x.id} role="radio" aria-checked={type === x.id} className={`newgroup__type ${type === x.id ? 'is-on' : ''}`} onClick={() => setType(x.id)}>
                    <b>{x.name}</b><span className="muted small">{x.common}</span>
                    <span className="small">{x.floors.initial * x.slotsPerFloor} lugares · até {x.floors.max * x.slotsPerFloor}</span>
                  </button>
                ))}
              </div>
              <label className="field"><span>Nome <span className="muted">(opcional)</span></span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t ? `${t.name} de ...` : ''} /></label>
            </>
          )}
          {err && <p className="err" role="alert">{err}</p>}
          <footer className="dlg__foot">
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn--primary">{busy ? 'Criando…' : sector ? 'Criar setor' : 'Construir'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

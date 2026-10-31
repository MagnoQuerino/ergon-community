import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { getRecents, type Recent } from '../lib/recents.ts';
import { rank } from '../lib/search.ts';
import type { AgentLite } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/** Um resultado da busca: o que aparece e o que acontece ao escolher. */
export interface PaletteItem { key: string; label: string; sub?: string; icon: string; keywords?: string; run: () => void }
export interface CardHit { id: string; number: number; title: string; completed: number; board_id: string; audience: string; origin: string; column_name: string }
/** agents: os melhores para o termo (todas as palavras no nome, no papel ou no setor), já ordenados pelo servidor */
interface Found { tasks: CardHit[]; routines: Array<{ id: string; name: string; status: string }>; agents?: AgentLite[] }

/**
 * Busca rápida (Ctrl+K, ou a lupa do cabeçalho): áreas, ações, agentes, cards de todos os quadros (pelo número ou
 * pelo título) e rotinas. Sem nada digitado, mostra os recentes. Setas escolhem, Enter abre, Esc fecha. Agentes,
 * cards e rotinas vêm do servidor (a equipe pode ter milhares: a busca não carrega ninguém antes de você digitar).
 */
export function CommandPalette({ base, onAgent, onCard, onRoutine, onRecent, onClose }: {
  base: { acoes: PaletteItem[]; areas: PaletteItem[] };
  onAgent: (a: AgentLite) => void;
  onCard: (t: CardHit) => void; onRoutine: (id: string, name: string) => void; onRecent: (r: Recent) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const recents = useMemo(() => getRecents(), []);
  useSurface(ref, { onClose, modal: true, outside: true });

  // cards e rotinas vêm do servidor (títulos cifrados no banco); espera a pessoa parar de digitar
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setFound(null); setBusy(false); return; }
    const my = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(async () => {
      try { const r = await api.get<Found>(`/api/search?q=${encodeURIComponent(term.slice(0, 100))}`); if (my === seq.current) setFound(r); }
      catch { if (my === seq.current) setFound({ tasks: [], routines: [] }); }
      finally { if (my === seq.current) setBusy(false); }
    }, 160);
    return () => window.clearTimeout(t);
  }, [q]);

  const groups = useMemo(() => {
    const term = q.trim();
    const pick = (list: PaletteItem[], max: number) => list
      .map((it) => ({ it, r: rank(term, `${it.label} ${it.sub ?? ''} ${it.keywords ?? ''}`) })).filter((x) => x.r >= 0)
      .sort((a, b) => b.r - a.r).slice(0, max).map((x) => x.it);
    if (!term) {
      const rec: PaletteItem[] = recents.map((r) => ({
        key: `rec-${r.kind}-${r.id}`, label: r.label, sub: { card: 'Card', agente: 'Agente', rotina: 'Rotina' }[r.kind] + (r.where ? ` · ${r.where}` : ''),
        icon: { card: 'tasks', agente: 'users', rotina: 'repeat' }[r.kind], run: () => onRecent(r),
      }));
      return [['Recentes', rec], ['Ações', base.acoes], ['Ir para', base.areas]] as Array<[string, PaletteItem[]]>;
    }
    const cards: PaletteItem[] = (found?.tasks ?? []).map((t) => ({
      key: `card-${t.id}`, label: `#${t.number} ${t.title}`, icon: 'tasks', run: () => onCard(t),
      sub: `${t.audience === 'team' ? 'Fluxos da equipe' : t.origin === 'mirror' ? 'Tarefas (espelho)' : 'Tarefas'} · ${t.completed ? 'concluída' : t.column_name}`,
    }));
    const rotinas: PaletteItem[] = (found?.routines ?? []).map((r) => ({
      key: `rot-${r.id}`, label: r.name, sub: r.status === 'active' ? 'Rotina ligada' : 'Rotina pausada', icon: 'repeat', run: () => onRoutine(r.id, r.name),
    }));
    const agentes: PaletteItem[] = (found?.agents ?? []).map((a) => ({ key: `ag-${a.id}`, label: a.name, sub: a.role, icon: 'users', run: () => onAgent(a) }));
    return [['Cards', cards], ['Agentes', agentes], ['Rotinas', rotinas], ['Ações', pick(base.acoes, 5)], ['Ir para', pick(base.areas, 6)]] as Array<[string, PaletteItem[]]>;
  }, [q, found, recents, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = groups.flatMap(([, items]) => items);
  useEffect(() => { setActive(0); }, [q, found]);
  // a opção escolhida fica à vista ao andar com as setas
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const choose = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    // depois de fechar e o foco voltar a quem abriu: o que abrir agora (janela, card) guarda de onde veio
    requestAnimationFrame(() => requestAnimationFrame(() => it.run()));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]); }
  };
  let n = -1;
  const empty = q.trim() && !busy && !flat.length;

  return (
    <div className="palette-back">
      <div ref={ref} className="palette" role="dialog" aria-modal="true" aria-label="Buscar no Ergon">
        <div className="palette__input">
          <Icon name="search" size={18} />
          <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} maxLength={100}
            placeholder="Buscar cards, agentes, rotinas e áreas…" aria-label="Buscar"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={flat[active] ? `pal-${flat[active].key}` : undefined} />
          {busy && <span className="palette__busy" aria-hidden="true" />}
          <kbd>Esc</kbd>
        </div>
        <div id="palette-list" role="listbox" aria-label="Resultados" className="palette__list">
          {groups.map(([name, items]) => items.length > 0 && (
            <div key={name} role="group" aria-label={name}>
              <div className="palette__group" aria-hidden="true">{name}</div>
              {items.map((it) => {
                const i = ++n;
                return (
                  <div key={it.key} id={`pal-${it.key}`} role="option" aria-selected={i === active} className={`palette__item ${i === active ? 'is-on' : ''}`}
                    onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => choose(it)}>
                    <Icon name={it.icon} size={16} />
                    <span className="palette__txt"><span className="palette__label">{it.label}</span>{it.sub && <small>{it.sub}</small>}</span>
                    {i === active && <Icon name="chevron-right" size={14} />}
                  </div>
                );
              })}
            </div>
          ))}
          {empty && <p className="palette__empty">Nada encontrado para “{q.trim()}”. Tente o número do card (#12) ou outra palavra do título.</p>}
          {!q.trim() && !recents.length && <p className="palette__empty palette__empty--soft">Os cards, agentes e rotinas que você abrir aparecem aqui como recentes.</p>}
        </div>
        <footer className="palette__foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> escolher</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> busca de qualquer lugar</span></footer>
      </div>
    </div>
  );
}

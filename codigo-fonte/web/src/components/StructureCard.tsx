import { useMemo, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { CityAgent, CityAgentsPage, Structure } from '../lib/types.ts';
import type { SceneFocus } from '../scene/types.ts';
import { Icon } from './Icon.tsx';
import { typeOf } from '../../../shared/city.ts';
import { useT } from '../i18n/index.ts';
import { comumDoTipo, descricaoDoTipo, nomeDaConstrucao, nomeDoAndar, nomeDoTipo } from '../world/buildings.ts';

/** Nomes por andar no cartão: as primeiras vagas de cada andar; havendo mais gente (contagem do próprio andar), "…". */
const NAMES_PER_FLOOR = 3;

/**
 * Cartão da estrutura escolhida: andares (abrir um andar), ocupação, adicionar andar e remover (versão local: grátis).
 * Os nomes vêm do servidor (as 3 primeiras vagas de cada andar, mesmo com o prédio longe e sem ninguém carregado); até
 * chegarem, os que a cena já tem deste prédio (`known`, na mesma ordem).
 */
export function StructureCard({ s, focus, known, onClose, onOpenFloor, onCloseBuilding, onChanged, onError }: {
  s: Structure; focus: SceneFocus | null; known: CityAgent[]; onClose: () => void; onOpenFloor: (level: number) => void; onCloseBuilding: () => void;
  onChanged: (msg?: string) => void; onError: (msg: string) => void;
}) {
  const t = useT();
  const tipo = typeOf(s.kind);
  const nome = nomeDaConstrucao(s.name, s.kind);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const work = tipo?.category === 'trabalho';
  const open = focus?.building === s.id ? focus.level : null;
  const active = s.floors.reduce((n, f) => n + f.active, 0);
  const canAdd = work && tipo && s.floors.length < tipo.floors.max;
  const res = useResource<CityAgentsPage>(work ? `/api/city/agents?b=${encodeURIComponent(s.id)}&per=${NAMES_PER_FLOOR}` : null, ['agents.changed', 'city.changed']);
  const names = useMemo(() => {
    // a resposta de outro prédio (trocando de cartão) não vale para este
    const rows = res.data && res.data.agents.every((a) => a.building_id === s.id) ? res.data.agents : known;
    const by = new Map<string, string[]>();
    for (const a of rows) {
      if (a.building_id !== s.id) continue;
      const l = by.get(a.floor_id) ?? [];
      if (l.length < NAMES_PER_FLOOR) { l.push(a.name); by.set(a.floor_id, l); }
    }
    return by;
  }, [res.data, known, s.id]);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); onChanged(msg); } catch (e) { onError(errMsg(e)); } finally { setBusy(false); setConfirmDel(false); }
  };
  return (
    <aside className="scard" aria-label={t('cidade.cartao.aria', { nome })}>
      <header className="scard__head">
        <div>
          <h3>{nome}</h3>
          <span className="muted">{comumDoTipo(s.kind)}{tipo && tipo.name !== s.name ? ` · ${nomeDoTipo(s.kind)}` : ''}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t('cidade.tela.fechar')}><Icon name="x" /></button>
      </header>
      {tipo && <p className="scard__desc">{descricaoDoTipo(s.kind)}</p>}
      {work && (
        <>
          <ul className="scard__floors">
            {[...s.floors].reverse().map((f) => {
              const who = names.get(f.id) ?? [];
              return (
                <li key={f.id}>
                  <button className={`scard__floor ${open === f.level ? 'scard__floor--on' : ''}`} onClick={() => (open === f.level ? onCloseBuilding() : onOpenFloor(f.level))} title={open === f.level ? t('cidade.cartao.fecharPredio') : t('cidade.cartao.abrirAndar')}>
                    <span>{nomeDoAndar(f.name)}</span>
                    <span className="slots" aria-label={t('cidade.cartao.vagas', { ativos: f.active, vagas: f.slots })}>{Array.from({ length: f.slots }, (_, i) => <span key={i} className={`slot slot--sm ${i < f.active ? 'slot--on' : ''}`} />)}</span>
                    <span className="muted small">{who.join(', ')}{f.active > NAMES_PER_FLOOR ? '…' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="row row--wrap">
            {canAdd && <button className="btn btn--sm" disabled={busy} onClick={() => run(() => api.post(`/api/structures/${s.id}/floors`), t('cidade.cartao.andarAdicionado', { n: tipo!.slotsPerFloor }))}><Icon name="plus" size={13} /> {t('cidade.cartao.adicionarAndar', { n: tipo!.slotsPerFloor })}</button>}
            {!canAdd && tipo && <span className="hint">{t('cidade.cartao.limiteAndares', { n: tipo.floors.max, tipo: nomeDoTipo(s.kind) })}</span>}
            {s.origin === 'local' && (confirmDel ? (
              <span className="confirm">{t('cidade.cartao.removerPergunta', { nome })} <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => run(() => api.del(`/api/structures/${s.id}`), t('cidade.cartao.removida', { nome }))}>{t('cidade.cartao.remover')}</button><button className="btn btn--sm" onClick={() => setConfirmDel(false)}>{t('geral.comum.cancelar')}</button></span>
            ) : (
              <button className="btn btn--sm btn--ghost" disabled={busy || active > 0} title={active ? t('cidade.cartao.temAgentes') : t('cidade.cartao.removerDica')} onClick={() => setConfirmDel(true)}><Icon name="trash" size={13} /> {t('cidade.cartao.remover')}</button>
            ))}
          </div>
        </>
      )}
      {!work && <p className="hint">{t('cidade.cartao.mudarDeLote')}</p>}
    </aside>
  );
}

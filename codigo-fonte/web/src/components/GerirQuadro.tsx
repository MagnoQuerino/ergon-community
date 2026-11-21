/**
 * Os quadros da pessoa (rc.41): criar um quadro e organizar o atual (nome, colunas livres: criar, renomear, reordenar e
 * apagar levando os cards; apagar o quadro levando os cards para outro). Só nos quadros criados no Ergon: o da equipe é
 * dos agentes e os espelhados têm as colunas do aplicativo de origem. O servidor confere tudo (routes/quadros.ts).
 * Os campos próprios dos cartões (CamposDoQuadro) valem também num quadro espelhado, só no Ergon: nele, este painel
 * mostra só os campos.
 */
import { useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { SOURCE_LABEL, type BoardSummary, type CampoQuadro, type Column } from '../lib/types.ts';
import { CamposDoQuadro } from './CamposDoQuadro.tsx';

export function NovoQuadro({ onCriado, onFechar }: { onCriado: (id: string) => void; onFechar: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: onFechar, modal: true, outside: true });
  const [nome, setNome] = useState('');
  const [cols, setCols] = useState(() => t('quadro.gerir.colunasPadrao'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const criar = async () => {
    setBusy(true); setErr(null);
    try {
      const columns = cols.split(',').map((c) => c.trim()).filter(Boolean);
      const r = await api.post<{ id: string }>('/api/boards', { name: nome, ...(columns.length ? { columns } : {}) });
      onCriado(r.id);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card" role="dialog" aria-modal="true" aria-labelledby="novo-quadro-t">
        <h3 id="novo-quadro-t">{t('quadro.gerir.criarTitulo')}</h3>
        <form className="cpop__body stack" onSubmit={(e) => { e.preventDefault(); void criar(); }}>
          <label className="small" htmlFor="nq-nome">{t('quadro.gerir.criarNome')}</label>
          <input id="nq-nome" className="input" value={nome} maxLength={60} autoFocus onChange={(e) => setNome(e.target.value)} />
          <label className="small" htmlFor="nq-cols">{t('quadro.gerir.criarColunas')}</label>
          <input id="nq-cols" className="input" value={cols} onChange={(e) => setCols(e.target.value)} />
          {err && <p className="error small" role="alert">{err}</p>}
          <div className="cpop__acts">
            <button type="button" className="btn btn--ghost" onClick={onFechar}>{t('quadro.gerir.cancelar')}</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !nome.trim()}>{t('quadro.gerir.criar')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function GerirQuadro({ quadro, entrada, columns, campos, outros, onMudou, onApagado, onFechar }: {
  quadro: BoardSummary; entrada: boolean; columns: Column[]; campos: CampoQuadro[]; outros: BoardSummary[];
  onMudou: () => void; onApagado: (destino: string) => void; onFechar: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: onFechar, outside: true });
  const [nome, setNome] = useState(quadro.name);
  const [nomes, setNomes] = useState<Record<string, string>>({});
  const [nova, setNova] = useState('');
  const [apagando, setApagando] = useState<{ coluna: Column; destino: string } | null>(null);
  const [apagandoQuadro, setApagandoQuadro] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fazer = async (f: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await f(); onMudou(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const ordem = [...columns].sort((a, b) => a.position - b.position);
  const espelho = quadro.origin === 'mirror';
  const cabeca = (
    <div className="drawer__head"><h3 className="drawer__title" id="gerir-t">{espelho ? t('quadro.campos.titulo') : t('quadro.gerir.titulo')}</h3>
      <button className="icon-btn" onClick={onFechar} aria-label={t('quadro.gerir.fechar')} title={t('quadro.gerir.fechar')}><Icon name="x" /></button></div>
  );
  // quadro espelhado: nome e colunas vêm do aplicativo; aqui, só os campos (que ficam no Ergon)
  if (espelho) {
    return (
      <aside ref={ref} className="status-pop gerir-quadro" role="dialog" aria-labelledby="gerir-t">
        {cabeca}
        <CamposDoQuadro quadroId={quadro.id} campos={campos} espelho={SOURCE_LABEL[quadro.source ?? ''] ?? t('quadro.tarefas.aplicativo')} onMudou={onMudou} />
      </aside>
    );
  }

  return (
    <aside ref={ref} className="status-pop gerir-quadro" role="dialog" aria-labelledby="gerir-t">
      {cabeca}
      {err && <p className="error small" role="alert">{err}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void fazer(() => api.patch(`/api/boards/${quadro.id}`, { name: nome })); }}>
        <input className="input grow" value={nome} maxLength={60} aria-label={t('quadro.gerir.nomeQuadro')} onChange={(e) => setNome(e.target.value)} />
        <button className="btn btn--sm" disabled={busy || !nome.trim() || nome.trim() === quadro.name}>{t('quadro.gerir.salvar')}</button>
      </form>

      <h4>{t('quadro.gerir.colunas')}</h4>
      <ul className="gerir-quadro__cols">
        {ordem.map((c, i) => (
          <li key={c.id} className="row">
            <input className="input grow" value={nomes[c.id] ?? c.name} maxLength={40} aria-label={t('quadro.gerir.nomeColuna')}
              onChange={(e) => setNomes({ ...nomes, [c.id]: e.target.value })}
              onBlur={() => { const v = (nomes[c.id] ?? c.name).trim(); if (v && v !== c.name) void fazer(() => api.patch(`/api/columns/${c.id}`, { name: v })); }} />
            <button className="icon-btn" disabled={busy || i === 0} aria-label={t('quadro.gerir.subir', { nome: c.name })} title={t('quadro.gerir.subir', { nome: c.name })} onClick={() => void fazer(() => api.patch(`/api/columns/${c.id}`, { position: i - 1 }))}><Icon name="chevron-left" size={16} /></button>
            <button className="icon-btn" disabled={busy || i === ordem.length - 1} aria-label={t('quadro.gerir.descer', { nome: c.name })} title={t('quadro.gerir.descer', { nome: c.name })} onClick={() => void fazer(() => api.patch(`/api/columns/${c.id}`, { position: i + 1 }))}><Icon name="chevron-right" size={16} /></button>
            <button className="icon-btn" disabled={busy || ordem.length < 2} aria-label={t('quadro.gerir.apagarColuna', { nome: c.name })} title={t('quadro.gerir.apagarColuna', { nome: c.name })} onClick={() => setApagando({ coluna: c, destino: ordem[i > 0 ? i - 1 : 1].id })}><Icon name="trash" size={16} /></button>
          </li>
        ))}
      </ul>
      {apagando && (
        <div className="gerir-quadro__confirma">
          <label className="small" htmlFor="gq-destino">{t('quadro.gerir.paraOnde', { nome: apagando.coluna.name })}</label>
          <div className="row">
            <select id="gq-destino" value={apagando.destino} onChange={(e) => setApagando({ ...apagando, destino: e.target.value })}>
              {ordem.filter((c) => c.id !== apagando.coluna.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => void fazer(async () => { await api.del(`/api/columns/${apagando.coluna.id}`, { destino: apagando.destino }); setApagando(null); })}>{t('quadro.gerir.confirmarApagarColuna')}</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setApagando(null)}>{t('quadro.gerir.cancelar')}</button>
          </div>
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (nova.trim()) void fazer(async () => { await api.post(`/api/boards/${quadro.id}/columns`, { name: nova }); setNova(''); }); }}>
        <input className="input grow" value={nova} maxLength={40} placeholder={t('quadro.gerir.novaColuna')} aria-label={t('quadro.gerir.novaColuna')} onChange={(e) => setNova(e.target.value)} />
        <button className="btn btn--sm" disabled={busy || !nova.trim()}>{t('quadro.gerir.adicionarColuna')}</button>
      </form>

      <CamposDoQuadro quadroId={quadro.id} campos={campos} onMudou={onMudou} />

      <div className="gerir-quadro__perigo">
        {entrada ? <p className="muted small">{t('quadro.gerir.entradaFica')}</p> : apagandoQuadro === null ? (
          <button className="btn btn--sm btn--danger" onClick={() => setApagandoQuadro(outros[0]?.id ?? '')} disabled={!outros.length}>{t('quadro.gerir.apagarQuadro')}</button>
        ) : (
          <>
            <p className="small">{t('quadro.gerir.apagarQuadroTexto')}</p>
            <div className="row">
              <select value={apagandoQuadro} aria-label={t('quadro.gerir.apagarQuadroTexto')} onChange={(e) => setApagandoQuadro(e.target.value)}>
                {outros.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => { setBusy(true); setErr(null); api.del(`/api/boards/${quadro.id}`, { destino: apagandoQuadro }).then(() => onApagado(apagandoQuadro), (e) => { setErr(errMsg(e)); setBusy(false); }); }}>{t('quadro.gerir.confirmarApagarQuadro')}</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setApagandoQuadro(null)}>{t('quadro.gerir.cancelar')}</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

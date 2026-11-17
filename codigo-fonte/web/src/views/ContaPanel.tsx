import { useRef, useState } from 'react';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { Avatar } from '../components/AccountMenu.tsx';
import { BaixarMeusDados } from '../components/BaixarMeusDados.tsx';
import { PastaDeDownloads } from '../components/AvisoDeDownload.tsx';
import { SeletorIdioma } from '../components/SeletorIdioma.tsx';
import { t as tr, tn, useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { Icon } from '../components/Icon.tsx';
import { WsCard } from '../components/WsCard.tsx';
import { filtrarWorkspaces, mostraBuscaWs } from '../lib/busca-ws.ts';
import type { AppState, Me } from '../lib/types.ts';

const LADO = 256;
// i18n-ok: o nome do personagem não se traduz (é o mesmo nas duas línguas); a frase em volta vem do dicionário
const NPC = 'Alexandre Magno';

/** Foto escolhida → quadrado de 256 px (corte central), JPEG: pequena o bastante para guardar no cadastro. */
async function reduzir(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(tr('conta.minha.erroFormato'));
  if (file.size > 15 * 1024 * 1024) throw new Error(tr('conta.minha.erroGrande'));
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, falha) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => falha(new Error(tr('conta.minha.erroAbrir'))); i.src = url; });
    const lado = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas'); c.width = LADO; c.height = LADO;
    c.getContext('2d')!.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, LADO, LADO);
    return c.toDataURL('image/jpeg', 0.86);
  } finally { URL.revokeObjectURL(url); }
}

/** Minha conta: foto de perfil e nome de exibição. */
export function MinhaContaPanel({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const t = useT();
  const arquivo = useRef<HTMLInputElement>(null);
  const [nome, setNome] = useState(me.user.displayName);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); onChanged(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const foto = (f: File | undefined) => f && act(async () => api.put('/api/me/avatar', { image: await reduzir(f) }), t('conta.minha.fotoAtualizada'));
  return (
    <section className="card">
      <h3>{t('conta.minha.titulo')}</h3>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <div className="conta__foto">
        <Avatar me={me} size={88} />
        <div className="conta__foto-acts">
          <input ref={arquivo} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void foto(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn" disabled={busy} onClick={() => arquivo.current?.click()}>{me.user.avatar ? t('conta.minha.trocarFoto') : t('conta.minha.enviarFoto')}</button>
          {me.user.avatar && <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.del('/api/me/avatar'), t('conta.minha.fotoRemovida'))}>{t('conta.minha.removerFoto')}</button>}
          <p className="muted small">{t('conta.minha.fotoDica')}</p>
        </div>
      </div>
      <form className="conta__nome" onSubmit={(e) => { e.preventDefault(); void act(() => api.patch('/api/me', { displayName: nome }), t('conta.minha.nomeAtualizado')); }}>
        <label htmlFor="conta-nome">{t('conta.campo.nomeExibicao')}</label>
        <div className="ws-item__edit">
          <input id="conta-nome" className="input" value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} />
          <button className="btn" disabled={busy || !nome.trim() || nome.trim() === me.user.displayName}>{t('conta.acao.salvar')}</button>
        </div>
        <p className="muted small">{tn('conta.minha.usuarioEntrar', { usuario: <b>{me.user.username}</b> })}</p>
      </form>
      {/* Português / English */}
      <SeletorIdioma />
      <div className="conta__dados">
        <h4>{t('conta.minha.baixarTitulo')}</h4>
        <BaixarMeusDados />
      </div>
      <PastaDeDownloads />
    </section>
  );
}

/** Alexandre Magno na cidade deste workspace: ligado por padrão; desligar só o esconde aqui (ele continua no Ergon). */
function NpcToggle({ dona }: { dona: boolean }) {
  const t = useT();
  const s = useResource<{ npc: boolean }>('/api/city/settings', ['city.changed']);
  const [err, setErr] = useState<string | null>(null);
  const on = s.data?.npc !== false;
  const set = async (v: boolean) => { setErr(null); try { await api.put('/api/city/settings', { npc: v }); s.reload(); } catch (e) { setErr(errMsg(e)); } };
  return (
    <div className="row sec-toggle ws-npc">
      <div><b>{t('conta.npc.exibir', { nome: NPC })}</b><p className="muted small">{t('conta.npc.texto', { nome: NPC })}</p></div>
      <button role="switch" aria-checked={on} aria-label={t('conta.npc.aria', { nome: NPC })} className={`switch ${on ? 'switch--on' : ''}`} disabled={!dona || !s.data} onClick={() => void set(!on)}>
        <span className="switch__knob" /><span className="switch__txt">{on ? t('conta.estado.ligado') : t('conta.estado.desligado')}</span>
      </button>
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
  );
}

interface WsResumo { id: string; name: string; role: string; current: boolean; agents: number; openTasks: number; working: number; waiting: number }
interface WorldResumo { configured: boolean; link: { boundWorkspaceId: string | null; boundWorkspaceIds?: string[] } | null }

/** Os workspaces da pessoa em cartões: a cidade de cada um, onde está (neste computador ou no Ergon World) e as ações. */
function SeusWorkspaces() {
  const t = useT();
  const res = useResource<WsResumo[]>('/api/workspaces', ['tasks.changed', 'runs.changed', 'agents.changed']);
  const world = useResource<WorldResumo>('/api/world/status', []);
  const [editando, setEditando] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [confirmar, setConfirmar] = useState<WsResumo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [criando, setCriando] = useState<string | null>(null);
  const [busca, setBusca] = useState('');
  const ligadosWorld = world.data?.link?.boundWorkspaceIds ?? (world.data?.link?.boundWorkspaceId ? [world.data.link.boundWorkspaceId] : []);
  const comBusca = !!res.data && mostraBuscaWs(res.data.length);
  const vistos = res.data ? (comBusca ? filtrarWorkspaces(res.data, busca) : res.data) : [];
  const criar = async () => {
    if (!criando?.trim()) return;
    setBusy(true); setErr(null);
    try { await api.post('/api/workspaces', { name: criando }); window.location.reload(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const comWorld = !!world.data?.configured && !!world.data.link;
  const novo = nome.trim().replace(/\s+/g, ' ');
  const abrir = async (w: WsResumo) => {
    setBusy(true); setErr(null);
    try { await api.post('/api/session/workspace', { workspaceId: w.id }); window.location.reload(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const salvar = async (w: WsResumo) => {
    setBusy(true); setErr(null);
    try { await api.patch(`/api/workspaces/${w.id}`, { name: novo }); if (w.current) { window.location.reload(); return; } setEditando(null); setConfirmar(null); res.reload(); }
    catch (e) { setErr(errMsg(e)); setConfirmar(null); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h3>{t('conta.ws.todos')}</h3>
      <p className="muted small">{t('conta.ws.todosTexto')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {comBusca && (
        <label className="help__search ws-busca ws-busca--cartoes"><Icon name="search" size={15} />
          <input type="search" value={busca} placeholder={t('geral.ws.buscar')} aria-label={t('geral.ws.buscarAria')} onChange={(e) => setBusca(e.target.value)} />
        </label>
      )}
      {comBusca && !vistos.length && <p className="muted small" role="status">{t('geral.ws.nenhum')}</p>}
      {!res.data ? <p className="muted small">{t('geral.comum.carregando')}</p> : (
        <div className="ws-cards">
          {vistos.map((w) => {
            const dona = w.role === 'owner';
            return (
              <WsCard key={w.id} id={w.id} nome={w.name} atual={w.current}
                selos={<>
                  {w.current && <span className="badge badge--atual">{t('geral.ws.atualChip')}</span>}
                  {comWorld && ligadosWorld.includes(w.id) ? <span className="badge badge--world"><Icon name="globe" size={11} /> {t('geral.ws.noWorld')}</span> : <span className="badge">{t('geral.ws.local')}</span>}
                </>}
                numeros={<>{t('geral.ws.agentes', { n: w.agents })} · {t('geral.ws.tarefasAbertas', { n: w.openTasks })}{w.working > 0 ? ` · ${t('geral.ws.trabalhando', { n: w.working })}` : ''}</>}
                acoes={editando === w.id ? null : <>
                  {!w.current && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void abrir(w)}>{t('conta.ws.abrir')}</button>}
                  {dona && <button className="btn btn--sm" disabled={busy} onClick={() => { setEditando(w.id); setNome(w.name); }}><Icon name="edit" size={13} /> {t('conta.ws.renomear')}</button>}
                  {comWorld && w.current && <a className="btn btn--sm btn--ghost" href="#configuracao?world"><Icon name="globe" size={13} /> {ligadosWorld.includes(w.id) ? t('conta.ws.gerenciarWorld') : t('conta.ws.levarWorld')}</a>}
                </>}>
                {editando === w.id && (
                  <form className="ws-renomear" onSubmit={(e) => { e.preventDefault(); if (novo && novo !== w.name) setConfirmar(w); }}>
                    <input className="input" aria-label={t('conta.ws.nomeDe', { nome: w.name })} value={nome} maxLength={60} autoFocus onChange={(e) => setNome(e.target.value)} />
                    <button className="btn btn--sm btn--primary" disabled={busy || !novo || novo === w.name}>{t('conta.acao.salvar')}</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditando(null)}>{t('conta.acao.cancelar')}</button>
                  </form>
                )}
              </WsCard>
            );
          })}
          <div className="ws-card ws-card--novo">
            {criando === null ? (
              <button className="ws-card__novo" onClick={() => setCriando('')}><Icon name="plus" size={22} /> {t('geral.ws.novo')}</button>
            ) : (
              <form className="ws-card__corpo" onSubmit={(e) => { e.preventDefault(); void criar(); }}>
                <label className="small" htmlFor="ws-novo-cartao">{t('geral.ws.nomeNovo')}</label>
                <input id="ws-novo-cartao" className="input" value={criando} maxLength={60} autoFocus placeholder={t('geral.ws.exemplo')} onChange={(e) => setCriando(e.target.value)} />
                <p className="muted small">{t('geral.ws.nasce')}</p>
                <div className="ws-card__acoes">
                  <button className="btn btn--sm btn--gold" disabled={busy || !criando.trim()}>{t('geral.ws.criar')}</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setCriando(null)}>{t('conta.acao.cancelar')}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {confirmar && (
        <ConfirmPopup title={t('conta.ws.renomearPergunta')} confirmLabel={t('conta.ws.renomear')} busy={busy} onConfirm={() => void salvar(confirmar)} onCancel={() => setConfirmar(null)}>
          <p>{tn('conta.ws.renomearTexto', { antes: <b>{confirmar.name}</b>, depois: <b>{novo}</b> })}</p>
        </ConfirmPopup>
      )}
    </section>
  );
}

export function WorkspaceConfigPanel({ state, me }: { state: AppState; me: Me }) {
  const t = useT();
  const atual = state.workspace;
  const dona = me.workspaces.find((w) => w.id === atual.id)?.role === 'owner';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // excluir: de vez, digitando o nome; nunca o último
  const [excluir, setExcluir] = useState(false);
  const [digitado, setDigitado] = useState('');
  const unico = me.workspaces.length < 2;
  const apagar = async () => {
    setBusy(true); setErr(null);
    try { await api.del(`/api/workspaces/${atual.id}`, { confirmName: digitado }); window.location.reload(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); setExcluir(false); }
  };
  return (
    <>
      <SeusWorkspaces />
      <section className="card">
        <h3>{t('conta.ws.este', { nome: atual.name })}</h3>
        <p className="muted small">{t('conta.ws.explica')}</p>
        {err && <p className="error" role="alert">{err}</p>}
        {!dona && <p className="muted small">{t('conta.ws.soDona')}</p>}
        <NpcToggle dona={dona} />
        {dona && (
          <div className="ws-perigo">
            <div><b>{t('conta.ws.excluirTitulo')}</b><p className="muted small">{unico ? t('conta.ws.unico') : t('conta.ws.excluirExplica')}</p></div>
            <button className="btn btn--danger" disabled={unico} onClick={() => { setDigitado(''); setExcluir(true); }}>{t('conta.ws.excluirBotao')}</button>
          </div>
        )}
        {excluir && (
          <ConfirmPopup title={t('conta.ws.excluirPergunta', { nome: atual.name })} confirmLabel={t('conta.acao.excluirDeVez')} busy={busy} canConfirm={digitado.trim() === atual.name} onConfirm={() => void apagar()} onCancel={() => setExcluir(false)}>
            <p>{tn('conta.ws.excluirAviso', { semVolta: <b>{t('conta.ws.semVolta')}</b> })}</p>
            <label className="small" htmlFor="ws-excluir">{tn('conta.ws.excluirDigite', { nome: <b>{atual.name}</b> })}</label>
            <input id="ws-excluir" className="input" value={digitado} autoComplete="off" onChange={(e) => setDigitado(e.target.value)} />
          </ConfirmPopup>
        )}
      </section>
    </>
  );
}

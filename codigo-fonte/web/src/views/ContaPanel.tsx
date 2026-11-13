import { useRef, useState } from 'react';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { Avatar } from '../components/AccountMenu.tsx';
import { BaixarMeusDados } from '../components/BaixarMeusDados.tsx';
import { SeletorIdioma } from '../components/SeletorIdioma.tsx';
import { t as tr, tn, useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
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
    </section>
  );
}

/** Workspace atual: o nome (com confirmação). */
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

export function WorkspaceConfigPanel({ state, me }: { state: AppState; me: Me }) {
  const t = useT();
  const atual = state.workspace;
  const dona = me.workspaces.find((w) => w.id === atual.id)?.role === 'owner';
  const [nome, setNome] = useState(atual.name);
  const [confirmar, setConfirmar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const salvar = async () => {
    setBusy(true); setErr(null);
    try { await api.patch(`/api/workspaces/${atual.id}`, { name: nome }); window.location.reload(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); setConfirmar(false); }
  };
  const novo = nome.trim().replace(/\s+/g, ' ');
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
    <section className="card">
      <h3>{t('conta.ws.titulo')}</h3>
      <p className="muted small">{t('conta.ws.explica')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      <form onSubmit={(e) => { e.preventDefault(); setConfirmar(true); }}>
        <label htmlFor="ws-nome">{t('conta.ws.nome')}</label>
        <div className="ws-item__edit">
          <input id="ws-nome" className="input" value={nome} maxLength={60} disabled={!dona} onChange={(e) => setNome(e.target.value)} />
          <button className="btn" disabled={!dona || !novo || novo === atual.name}>{t('conta.ws.renomear')}</button>
        </div>
        {!dona && <p className="muted small">{t('conta.ws.soDona')}</p>}
      </form>
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
      {confirmar && (
        <ConfirmPopup title={t('conta.ws.renomearPergunta')} confirmLabel={t('conta.ws.renomear')} busy={busy} onConfirm={() => void salvar()} onCancel={() => setConfirmar(false)}>
          <p>{tn('conta.ws.renomearTexto', { antes: <b>{atual.name}</b>, depois: <b>{novo}</b> })}</p>
        </ConfirmPopup>
      )}
    </section>
  );
}

import { useRef, useState } from 'react';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { Avatar } from '../components/AccountMenu.tsx';
import { api, errMsg } from '../lib/api.ts';
import type { AppState, Me } from '../lib/types.ts';

const LADO = 256;

/** Foto escolhida → quadrado de 256 px (corte central), JPEG: pequena o bastante para guardar no cadastro. */
async function reduzir(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('use uma imagem PNG, JPEG ou WebP');
  if (file.size > 15 * 1024 * 1024) throw new Error('imagem grande demais (até 15 MB)');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, falha) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => falha(new Error('não deu para abrir a imagem')); i.src = url; });
    const lado = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas'); c.width = LADO; c.height = LADO;
    c.getContext('2d')!.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, LADO, LADO);
    return c.toDataURL('image/jpeg', 0.86);
  } finally { URL.revokeObjectURL(url); }
}

/** Minha conta: foto de perfil e nome de exibição. */
export function MinhaContaPanel({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const arquivo = useRef<HTMLInputElement>(null);
  const [nome, setNome] = useState(me.user.displayName);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); onChanged(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const foto = (f: File | undefined) => f && act(async () => api.put('/api/me/avatar', { image: await reduzir(f) }), 'Foto atualizada.');
  return (
    <section className="card">
      <h3>Minha conta</h3>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <div className="conta__foto">
        <Avatar me={me} size={88} />
        <div className="conta__foto-acts">
          <input ref={arquivo} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void foto(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn" disabled={busy} onClick={() => arquivo.current?.click()}>{me.user.avatar ? 'Trocar foto' : 'Enviar foto'}</button>
          {me.user.avatar && <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.del('/api/me/avatar'), 'Foto removida.')}>Remover foto</button>}
          <p className="muted small">PNG, JPEG ou WebP. Fica só neste computador, no seu cadastro.</p>
        </div>
      </div>
      <form className="conta__nome" onSubmit={(e) => { e.preventDefault(); void act(() => api.patch('/api/me', { displayName: nome }), 'Nome atualizado.'); }}>
        <label htmlFor="conta-nome">Nome de exibição</label>
        <div className="ws-item__edit">
          <input id="conta-nome" className="input" value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} />
          <button className="btn" disabled={busy || !nome.trim() || nome.trim() === me.user.displayName}>Salvar</button>
        </div>
        <p className="muted small">Usuário para entrar: <b>{me.user.username}</b></p>
      </form>
    </section>
  );
}

/** Workspace atual: o nome (com confirmação). */
export function WorkspaceConfigPanel({ state, me }: { state: AppState; me: Me }) {
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
      <h3>Workspace</h3>
      <p className="muted small">Cada workspace tem a sua equipe, cidade, quadros, conversas e rotinas. Para trocar ou criar outro, use o botão com o nome dele, na barra de cima.</p>
      {err && <p className="error" role="alert">{err}</p>}
      <form onSubmit={(e) => { e.preventDefault(); setConfirmar(true); }}>
        <label htmlFor="ws-nome">Nome deste workspace</label>
        <div className="ws-item__edit">
          <input id="ws-nome" className="input" value={nome} maxLength={60} disabled={!dona} onChange={(e) => setNome(e.target.value)} />
          <button className="btn" disabled={!dona || !novo || novo === atual.name}>Renomear</button>
        </div>
        {!dona && <p className="muted small">Só quem é dona do workspace muda o nome.</p>}
      </form>
      {dona && (
        <div className="ws-perigo">
          <div><b>Excluir este workspace</b><p className="muted small">{unico ? 'É o seu único workspace: crie outro antes de excluir este.' : 'Apaga de vez a equipe, a cidade, as tarefas, as conversas, as rotinas e os arquivos dele. A conta de IA continua sua.'}</p></div>
          <button className="btn btn--danger" disabled={unico} onClick={() => { setDigitado(''); setExcluir(true); }}>Excluir…</button>
        </div>
      )}
      {excluir && (
        <ConfirmPopup title={`Excluir "${atual.name}"?`} confirmLabel="Excluir de vez" busy={busy} canConfirm={digitado.trim() === atual.name} onConfirm={() => void apagar()} onCancel={() => setExcluir(false)}>
          <p>Isso apaga de vez a equipe, a cidade, as tarefas, as conversas, as rotinas e os arquivos deste workspace. <b>Não tem volta.</b></p>
          <label className="small" htmlFor="ws-excluir">Para confirmar, digite o nome do workspace: <b>{atual.name}</b></label>
          <input id="ws-excluir" className="input" value={digitado} autoComplete="off" onChange={(e) => setDigitado(e.target.value)} />
        </ConfirmPopup>
      )}
      {confirmar && (
        <ConfirmPopup title="Renomear o workspace?" confirmLabel="Renomear" busy={busy} onConfirm={() => void salvar()} onCancel={() => setConfirmar(false)}>
          <p>O workspace <b>{atual.name}</b> passa a se chamar <b>{novo}</b>. Nada mais muda: equipe, tarefas e conversas continuam como estão.</p>
        </ConfirmPopup>
      )}
    </section>
  );
}

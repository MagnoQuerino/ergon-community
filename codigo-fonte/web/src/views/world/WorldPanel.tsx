import { useEffect, useRef, useState } from 'react';
import { api, EMAIL_PEDIDO, errMsg, tomarFocoEmail } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { ErgonMarca, Loading } from '../../brand/Brand.tsx';
import { ConnectForm, DeviceLimit, erroConta, type LoginLimit } from './WorldLinkDialog.tsx';
import { fmtDataHora } from '../../i18n/index.ts';
import { twn, useTw } from './textos.ts';
import { Icon } from '../../components/Icon.tsx';
import { AceitarConvite } from './Gestao.tsx';
import NuvemWs from './NuvemWs.tsx';

interface WorkspaceRef { workspaceId: string; label?: string | null; role: string; status: string; plan_sku: string | null }
interface Link { accountEmail: string | null; emailVerified: boolean; deviceId: string; workspaces?: WorkspaceRef[]; boundWorkspaceId: string | null; boundWorkspaceName: string | null; currentIsBound: boolean }
interface Status { configured: boolean; service: string | null; me: { displayName: string }; deviceLimit: LoginLimit | null; link: Link | null }
interface Device { id: string; name: string; status: string; current: boolean; connected: boolean; lastSeenAt: string | null }
type Msg = (m: { kind: 'ok' | 'error'; text: string } | null) => void;
const when = (iso: string | null) => (iso ? fmtDataHora(iso) : '—');

/**
 * Configurações › Ergon World: só a conta e a segurança. Sem conta, o botão "Conectar ao Ergon World" (desligado, com
 * o motivo, quando a instalação não tem o endereço do World). Com conta: o e-mail, os aparelhos, desconectar e "Tenho
 * um convite". Os workspaces, o plano, as pessoas, os Dracmas, a nuvem e o Ergon AI ficam na página do Ergon World.
 */
export default function WorldPanel() {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false);
  const [pedido, setPedido] = useState(0); const reload = st.reload;
  // o World pediu o e-mail confirmado (em qualquer tela): relê o vínculo e chama a caixa do código
  useEffect(() => {
    const f = () => { setPedido((n) => n + 1); reload(); };
    window.addEventListener(EMAIL_PEDIDO, f);
    return () => window.removeEventListener(EMAIL_PEDIDO, f);
  }, [reload]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null); setBusy(true);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); st.reload(); } catch (e) { setMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  if (!st.data) return <Loading error={st.error} />;
  const s = st.data;
  if (!s.link) {
    return (
      <section className="card">
        <h3 className="mundo-titulo-marca"><ErgonMarca size={22} /> {t('mundo.titulo')}</h3>
        {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
        <p className="muted">{t('mundo.texto')}</p>
        {s.deviceLimit ? <DeviceLimit limit={s.deviceLimit} onDone={() => { setMsg({ kind: 'ok', text: t('conta.conectada') }); st.reload(); }} />
          : form && s.configured ? <ConnectForm displayName={s.me.displayName} onDone={() => { setForm(false); setMsg({ kind: 'ok', text: t('conta.conectada') }); st.reload(); }} onCancel={() => setForm(false)} />
          : (
            <>
              <button className="btn btn--primary" disabled={!s.configured} onClick={() => setForm(true)}>{t('mundo.conectar')}</button>
              {!s.configured && <p className="muted small">{t('mundo.semEndereco')}</p>}
            </>
          )}
      </section>
    );
  }
  const l = s.link;
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <section className="card">
        <h3 className="mundo-titulo-marca"><ErgonMarca size={22} /> {t('mundo.titulo')}</h3>
        <p>{twn('conta.conectado', { email: <b>{l.accountEmail ?? t('conta.suaConta')}</b> })}</p>
        {!l.emailVerified && <VerifyEmail onMsg={setMsg} onDone={st.reload} pedido={pedido} />}
        <Devices onMsg={setMsg} />
        <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.post('/api/world/unlink'), t('conta.desconectada'))}>{t('conta.desconectar')}</button>
      </section>
      <section className="card">
        <AceitarConvite onDone={st.reload} />
      </section>
      <section className="card card--world-gestao">
        <p className="muted small">{t('painel.contaGestao')}</p>
        <a className="btn btn--primary" href="#world"><Icon name="globe" size={14} /> {t('painel.abrirPagina')}</a>
      </section>
      <NuvemWs />
    </>
  );
}

/** Confirmar o e-mail da conta com o código que o World enviou. */
export function VerifyEmail({ onMsg, onDone, pedido }: { onMsg: Msg; onDone: () => void; pedido: number }) {
  const t = useTw();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [pedida, setPedida] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  // veio de uma recusa do World (criar ou comprar sem o e-mail confirmado): diz o porquê e põe o foco no código
  useEffect(() => {
    if (!tomarFocoEmail() && !pedido) return;
    setPedida(true);
    campo.current?.scrollIntoView?.({ block: 'center' }); campo.current?.focus();
  }, [pedido]);
  const go = async (fn: () => Promise<unknown>, ok: string) => {
    onMsg(null); setBusy(true);
    try { await fn(); onMsg({ kind: 'ok', text: ok }); onDone(); } catch (e) { onMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  return (
    <div className="card card--inner">
      {pedida && <p className="hint warn" role="status">{t('erro.email_unverified')}</p>}
      <p className="small">{t('email.confirmar')}</p>
      <div className="row row--wrap">
        <label className="field">{t('senha.codigo')}<input ref={campo} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value)} /></label>
      </div>
      <div className="row row--wrap">
        <button className="btn btn--sm" disabled={busy || !code.trim()} onClick={() => void go(() => api.post('/api/world/account/email/verify', { code: code.trim() }), t('email.confirmado'))}>{t('email.botao')}</button>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void go(() => api.post('/api/world/account/email/resend'), t('email.reenviado'))}>{t('email.reenviar')}</button>
      </div>
    </div>
  );
}


/** Aparelhos da conta: até 4 cadastrados e 2 com sessão ao mesmo tempo; a sessão de outro pode ser encerrada daqui. */
function Devices({ onMsg }: { onMsg: Msg }) {
  const t = useTw();
  const d = useResource<Device[]>('/api/world/devices', []);
  const [busy, setBusy] = useState(false);
  const list = (d.data ?? []).filter((x) => x.status === 'active');
  if (!list.length) return null;
  const end = async (x: Device) => {
    onMsg(null); setBusy(true);
    try { await api.post(`/api/world/devices/${x.id}/end-sessions`, {}); onMsg({ kind: 'ok', text: t('aparelhos.encerrada', { nome: x.name }) }); d.reload(); }
    catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <details>
      <summary>{t('aparelhos.resumo', { cadastrados: list.length, conectados: list.filter((x) => x.connected).length })}</summary>
      <ul className="sec-rows small">
        {list.map((x) => (
          <li key={x.id}>
            <span>{x.name}{x.current ? ` · ${t('aparelhos.este')}` : ''}<span className="muted"> · {x.connected ? t('aparelhos.usadoEm', { quando: when(x.lastSeenAt) }) : t('aparelhos.semSessao')}</span></span>
            {!x.current && x.connected && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void end(x)}>{t('aparelhos.encerrar')}</button>}
          </li>
        ))}
      </ul>
    </details>
  );
}

import { useState } from 'react';
import { api, ApiError, errMsg, pedirConfirmacaoEmail } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { tw, useTw, type ChaveWorld } from './textos.ts';
import { idiomaAtual } from '../../i18n/index.ts';

export interface ConnectedDevice { id: string; name: string; lastSeenAt: string | null }
/** login recusado: 2 aparelhos já com sessão (session_limit) ou 4 já cadastrados (device_limit) */
export interface LoginLimit { kind: 'session_limit' | 'device_limit'; devices: ConnectedDevice[]; canRetry: boolean }

const ERROS = ['invalid_credentials', 'email_in_use', 'invalid_request', 'too_many_attempts', 'account_locked', 'email_unconfigured', 'invalid_code',
  'invalid_local_password', 'password_short', 'invalid_email', 'world_login_again', 'world_offline', 'invite', 'seats', 'sync_forbidden', 'owner', 'payer', 'has_subscription', 'email_unverified'] as const;

/** O erro das contas no idioma da tela (o código vem do servidor); os outros, como vieram. */
export function erroConta(e: unknown, t: ReturnType<typeof useTw> = tw): string {
  const code = e instanceof ApiError ? e.code : '';
  if (code === 'email_unverified') pedirConfirmacaoEmail();
  return (ERROS as readonly string[]).includes(code) ? t(`erro.${code}` as Extract<ChaveWorld, `erro.${string}`>) : errMsg(e);
}

/**
 * A conta do World fica conectada em no máximo 2 aparelhos ao mesmo tempo e tem até 4 cadastrados. Quando a conexão
 * daqui foi recusada por isso, a pessoa escolhe em qual encerrar a sessão (ou qual remover) e a conexão recomeça.
 */
export function DeviceLimit({ limit, onDone }: { limit: LoginLimit; onDone: () => void }) {
  const t = useTw();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sessions = limit.kind === 'session_limit';
  const escolher = async (d: ConnectedDevice) => {
    setBusy(true); setErr('');
    try { await api.post('/api/world/connect/device', sessions ? { endSessionsOf: d.id } : { replaceDeviceId: d.id }); onDone(); }
    catch (e) { setErr(erroConta(e, t)); setBusy(false); }
  };
  return (
    <div role="alert">
      <p>{sessions ? t('limite.sessoes', { n: limit.devices.length }) : t('limite.aparelhos', { n: limit.devices.length })}</p>
      {err && <p className="error">{err}</p>}
      {limit.canRetry
        ? <div className="row row--wrap">{limit.devices.map((d) => <button key={d.id} className="btn" disabled={busy} onClick={() => void escolher(d)}>{sessions ? t('limite.entrarEncerrando', { nome: d.name }) : t('limite.entrarRemovendo', { nome: d.name })}</button>)}</div>
        : <p className="muted small">{t('limite.deNovo')}</p>}
    </div>
  );
}

type Aba = 'criar' | 'entrar' | 'esqueci';

/**
 * Conectar ao Ergon World: conta nova (nome, e-mail e senha), conta nova com as mesmas credenciais do Ergon (o nome
 * daqui, um e-mail e a senha do Ergon, conferida neste computador antes) ou entrar numa conta que já existe.
 */
export function ConnectForm({ displayName, onDone, onCancel }: { displayName: string; onDone: () => void; onCancel?: () => void }) {
  const t = useTw();
  const [aba, setAba] = useState<Aba>('criar');
  const [mesmas, setMesmas] = useState(true);
  const [nome, setNome] = useState(displayName);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [limit, setLimit] = useState<LoginLimit | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(''); setOk('');
    try { await fn(); }
    catch (e) {
      setErr(erroConta(e, t));
      if (e instanceof ApiError && (e.code === 'session_limit' || e.code === 'device_limit')) {
        const st = await api.get<{ deviceLimit: LoginLimit | null }>('/api/world/status').catch(() => null);
        setLimit(st?.deviceLimit ?? null);
      }
    } finally { setBusy(false); }
  };
  const conectar = () => run(async () => {
    const body = aba === 'entrar' ? { mode: 'login', email, password: senha }
      : mesmas ? { mode: 'local', email, localPassword: senha } : { mode: 'signup', email, password: senha, displayName: nome };
    // os e-mails da conta saem no idioma da tela (o servidor converte para o formato do World)
    await api.post('/api/world/connect', { ...body, locale: idiomaAtual() });
    onDone();
  });
  if (limit) return <DeviceLimit limit={limit} onDone={onDone} />;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const pronto = emailOk && (aba === 'criar' && mesmas ? senha.length > 0 : senha.length >= 10) && (aba !== 'criar' || mesmas || nome.trim().length > 0);
  const trocarAba = (a: Aba) => { setAba(a); setErr(''); setOk(''); setSenha(''); setCodigo(''); setEnviado(false); };
  if (aba === 'esqueci') {
    return (
      <div>
        <label className="field">{t('conectar.email')}<input type="email" autoComplete="email" value={email} onChange={(ev) => setEmail(ev.target.value)} /></label>
        {enviado && (
          <>
            <label className="field">{t('senha.codigo')}<input inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(ev) => setCodigo(ev.target.value)} /></label>
            <label className="field">{t('senha.nova')}<input type="password" autoComplete="new-password" value={senha} onChange={(ev) => setSenha(ev.target.value)} /></label>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        {ok && <p className="ok" role="status">{ok}</p>}
        <div className="row row--wrap">
          {!enviado
            ? <button className="btn btn--primary" disabled={busy || !emailOk} onClick={() => void run(async () => { await api.post('/api/world/account/password/forgot', { email }); setEnviado(true); setOk(t('senha.enviado')); })}>{t('senha.enviar')}</button>
            : <button className="btn btn--primary" disabled={busy || !codigo.trim() || senha.length < 10} onClick={() => void run(async () => { await api.post('/api/world/account/password/reset', { email, code: codigo, password: senha }); trocarAba('entrar'); setOk(t('senha.trocada')); })}>{t('senha.trocar')}</button>}
          <button className="btn btn--ghost" disabled={busy} onClick={() => trocarAba('entrar')}>{t('senha.voltar')}</button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="row row--wrap" role="tablist">
        <button role="tab" aria-selected={aba === 'criar'} className={`btn btn--sm${aba === 'criar' ? '' : ' btn--ghost'}`} onClick={() => trocarAba('criar')}>{t('conectar.criar')}</button>
        <button role="tab" aria-selected={aba === 'entrar'} className={`btn btn--sm${aba === 'entrar' ? '' : ' btn--ghost'}`} onClick={() => trocarAba('entrar')}>{t('conectar.entrar')}</button>
      </div>
      {aba === 'criar' && <label className="check"><input type="checkbox" checked={mesmas} onChange={(ev) => { setMesmas(ev.target.checked); setSenha(''); setNome(displayName); }} /> {t('conectar.mesmas')}</label>}
      {aba === 'criar' && <label className="field">{t('conectar.nome')}<input value={nome} readOnly={mesmas} onChange={(ev) => setNome(ev.target.value)} autoComplete="name" /></label>}
      <label className="field">{t('conectar.email')}<input type="email" autoComplete="email" value={email} onChange={(ev) => setEmail(ev.target.value)} /></label>
      <label className="field">{aba === 'criar' ? (mesmas ? t('conectar.senhaErgon') : t('conectar.senha')) : t('conectar.senhaWorld')}
        <input type="password" autoComplete={aba === 'entrar' ? 'current-password' : mesmas ? 'current-password' : 'new-password'} value={senha} onChange={(ev) => setSenha(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter' && pronto && !busy) void conectar(); }} />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}
      <div className="row row--wrap">
        <button className="btn btn--primary" disabled={busy || !pronto} onClick={() => void conectar()}>{aba === 'criar' ? t('conectar.criarBotao') : t('conectar.entrarBotao')}</button>
        {aba === 'entrar' && <button className="link" disabled={busy} onClick={() => trocarAba('esqueci')}>{t('conectar.esqueci')}</button>}
        {onCancel && <button className="btn btn--ghost" disabled={busy} onClick={onCancel}>{t('conectar.cancelar')}</button>}
      </div>
    </div>
  );
}

/**
 * Aparece quando um recurso do World responde "world_link_required" (este perfil ainda não está conectado, ou foi
 * desconectado). Conectar aqui é o mesmo das Configurações.
 */
export default function WorldLinkDialog({ onClose }: { onClose: () => void }) {
  const t = useTw();
  const st = useResource<{ configured: boolean; me: { displayName: string } }>('/api/world/status', []);
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-label={t('mundo.conectar')}>
      <div className="auth__card">
        <h2 className="auth__title">{t('mundo.conectar')}</h2>
        <p className="muted">{t('link.texto')}</p>
        {st.data && (st.data.configured
          ? <ConnectForm displayName={st.data.me.displayName} onDone={onClose} />
          : <p className="muted small">{t('mundo.semEndereco')}</p>)}
        <button className="link" onClick={onClose}>{t('agoraNao')}</button>
      </div>
    </div>
  );
}

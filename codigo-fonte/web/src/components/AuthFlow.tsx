import { useEffect, useState } from 'react';
import { ApiError, api, errMsg, setCsrf } from '../lib/api.ts';
import { passkeyLogin, passkeyUnlock, passkeysHere } from '../lib/passkey.ts';
import type { AuthState, Me } from '../lib/types.ts';
import { ErgonLogo } from '../brand/Brand.tsx';
import { t as tr, tn, useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { SetupSteps } from './Onboarding.tsx';

type LoginResult = { ok: boolean; need2fa?: boolean; challenge?: string; methods?: { totp: boolean; passkey: boolean }; recovery?: Recovery };
type Recovery = { phrase: string; ask: number[] };

/** Depois de destrancar, o portão dá lugar ao servidor completo: espera ele responder (alguns segundos no máximo). */
async function waitOpen(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { const s = await api.get<AuthState>('/api/auth/state'); if (!s.sealed) return; } catch { /* trocando de servidor */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(tr('conta.entrar.demorou'));
}

/** Cartão das telas de entrada. Enquanto algo demora (abrir os dados, entrar), o emblema faz a onda. */
function Card({ title, sub, busy, steps, children }: { title?: string; sub?: string; busy?: boolean; steps?: number; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__brand"><ErgonLogo height={36} animated={busy} /></h1>
        {steps !== undefined && <SetupSteps at={steps} />}
        {title && <h2 className="auth__title">{title}</h2>}
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </main>
  );
}

function NewPassword({ value, confirm, onChange, label }: { value: string; confirm: string; onChange: (v: string, c: string) => void; label?: string }) {
  const t = useT();
  const mismatch = confirm.length > 0 && confirm !== value;
  return (
    <>
      <label className="field">{label ?? t('conta.senha.rotulo')}<input required type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value, confirm)} minLength={12} /></label>
      <label className="field">{t('conta.senha.repita')}<input required type="password" autoComplete="new-password" value={confirm} onChange={(e) => onChange(value, e.target.value)} minLength={12} /></label>
      {mismatch ? <p className="hint warn">{t('conta.senha.diferentes')}</p> : <p className="hint">{t('conta.senha.dica')}</p>}
    </>
  );
}

/**
 * Entrada no Ergon: primeiro uso (cria a conta e a frase), trancado depois de reiniciar (senha ou frase abrem
 * os dados), login normal, 2º fator e recuperação com a frase.
 */
export function AuthFlow({ st, onDone }: { st: AuthState; onDone: () => void }) {
  const t = useT();
  const mode: 'setup' | 'unseal' | 'login' = st.needsSetup ? 'setup' : st.sealed ? 'unseal' : 'login';
  const [f, setF] = useState({ username: '', password: '', confirm: '', displayName: '', setupToken: '', phrase: '', code: '', invite: '' });
  const [step, setStep] = useState<{ k: 'form' } | { k: 'recover' } | { k: 'register' } | { k: '2fa'; challenge: string; methods: { totp: boolean; passkey: boolean } } | { k: 'phrase'; r: Recovery }>({ k: 'form' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // instalação antiga (ainda sem proteção): não há frase nem passkeys para usar
  const passkey = st.protected && passkeysHere(st.rpId);
  // trancado: se outra coisa abrir o Ergon (o ajudante do computador, outra aba), a tela segue sozinha
  useEffect(() => {
    if (mode !== 'unseal' || busy) return;
    const timer = window.setInterval(() => { void api.get<AuthState>('/api/auth/state').then((s) => { if (!s.sealed) onDone(); }).catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [mode, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<void>) => {
    setErr(null); setBusy(label);
    try { await fn(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const after = async (r: LoginResult, opening: boolean) => {
    // senha e frase saem da memória da tela assim que cumprem o papel
    setF((p) => ({ ...p, password: '', confirm: '', phrase: '' }));
    if (opening) await waitOpen();
    if (r.recovery) {
      // sessão recém-criada: a confirmação da frase já precisa do token CSRF dela
      setCsrf((await api.get<Me>('/api/me')).csrf);
      return setStep({ k: 'phrase', r: r.recovery });
    }
    if (r.need2fa && r.challenge && r.methods) return setStep({ k: '2fa', challenge: r.challenge, methods: r.methods });
    onDone();
  };

  const submit = () => run(mode === 'unseal' ? t('conta.entrar.abrindo') : mode === 'setup' ? t('conta.entrar.criandoProtegendo') : t('conta.entrar.entrando'), async () => {
    if (mode === 'setup') {
      if (f.password !== f.confirm) throw new Error(t('conta.senha.diferentes'));
      const r = await api.post<LoginResult>('/api/auth/setup', { username: f.username, password: f.password, displayName: f.displayName || f.username, ...(st.setupTokenRequired ? { setupToken: f.setupToken } : {}) });
      return after(r, false);
    }
    if (mode === 'unseal') return after(await api.post<LoginResult>('/api/unseal', { username: f.username, password: f.password }), true);
    return after(await api.post<LoginResult>('/api/auth/login', { username: f.username, password: f.password }), false);
  });
  // conta nova neste computador: workspace, chave e frase próprios (as boas-vindas vêm em seguida)
  const register = () => run(t('conta.entrar.criandoConta'), async () => {
    if (f.password !== f.confirm) throw new Error(t('conta.senha.diferentes'));
    const r = await api.post<LoginResult>('/api/auth/register', { username: f.username, password: f.password, displayName: f.displayName || f.username, ...(st.signup === 'convite' ? { invite: f.invite } : {}) });
    return after(r, false);
  });
  const recover = () => run(t('conta.entrar.conferindoFrase'), async () => {
    if (f.password !== f.confirm) throw new Error(t('conta.senha.diferentes'));
    const body = { username: f.username, phrase: f.phrase, newPassword: f.password };
    if (mode === 'unseal') return after(await api.post<LoginResult>('/api/unseal/recovery', body), true);
    await api.post('/api/auth/recover', body);
    onDone();
  });

  if (step.k === 'phrase') return <Card steps={mode === 'setup' || st.signup ? 1 : undefined}><RecoveryReveal r={step.r} onDone={onDone} /></Card>;

  if (step.k === 'register') {
    return (
      <Card busy={!!busy} steps={0} title={t('conta.registro.titulo')} sub={t('conta.registro.sub')}>
        <form onSubmit={(e) => { e.preventDefault(); void register(); }}>
          <label className="field">{t('conta.campo.nomeExibicao')}<input autoFocus value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={60} /></label>
          <label className="field">{t('conta.campo.usuario')}<input required autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
          <NewPassword value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          {st.signup === 'convite' && <label className="field">{t('conta.registro.convite')}<input required autoComplete="off" spellCheck={false} placeholder="ABCD-2345" value={f.invite} onChange={(e) => setF({ ...f, invite: e.target.value.toUpperCase() })} maxLength={20} /></label>}
          {st.signup === 'convite' && <p className="hint">{t('conta.registro.conviteDica')}</p>}
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? t('conta.entrar.criarProteger')}</button>
        </form>
        <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '' }); setStep({ k: 'form' }); }}>{t('conta.registro.jaTenho')}</button>
        <p className="hint">{t('conta.registro.emSeguida')}</p>
      </Card>
    );
  }

  if (step.k === '2fa') {
    const { challenge, methods } = step;
    return (
      <Card title={t('conta.verificacao.titulo')} sub={t('conta.verificacao.sub')} busy={!!busy}>
        {methods.totp && (
          <form onSubmit={(e) => { e.preventDefault(); void run(t('conta.acao.conferindo'), async () => { await api.post('/api/auth/login/totp', { challenge, code: f.code.replace(/\s/g, '') }); onDone(); }); }}>
            <label className="field">{t('conta.verificacao.codigo')}<input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
            <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? t('conta.acao.confirmar')}</button>
          </form>
        )}
        {methods.passkey && (passkey
          ? <button className="btn btn--block" disabled={!!busy} onClick={() => run(t('conta.passkey.esperando'), async () => { await passkeyLogin(challenge); onDone(); })}><Icon name="key" size={16} /> {t('conta.passkey.usar')}</button>
          : <p className="hint">{t('conta.passkey.soPor', { endereco: st.publicUrl })}</p>)}
        {err && <p className="error" role="alert">{err}</p>}
      </Card>
    );
  }

  if (step.k === 'recover') {
    return (
      <Card busy={!!busy} title={t('conta.recuperar.titulo')} sub={t('conta.recuperar.sub')}>
        <form onSubmit={(e) => { e.preventDefault(); void recover(); }}>
          <label className="field">{t('conta.campo.usuario')}<input required autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
          <label className="field">{t('conta.frase.titulo')}<textarea required rows={4} spellCheck={false} autoComplete="off" value={f.phrase} onChange={(e) => setF({ ...f, phrase: e.target.value })} /></label>
          <NewPassword label={t('conta.senha.nova')} value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? t('conta.recuperar.botao')}</button>
        </form>
        <button className="link" onClick={() => { setErr(null); setStep({ k: 'form' }); }}>{t('conta.acao.voltar')}</button>
      </Card>
    );
  }

  return (
    <Card
      busy={!!busy}
      steps={mode === 'setup' ? 0 : undefined}
      title={mode === 'setup' ? t('conta.entrar.bemVindo') : mode === 'unseal' ? t('conta.entrar.trancado') : undefined}
      sub={mode === 'setup' ? t('conta.entrar.bemVindoSub')
        : mode === 'unseal' ? t('conta.entrar.trancadoSub')
          : st.signup ? t('conta.entrar.subComputador') : t('conta.entrar.sub')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {mode === 'setup' && <label className="field">{t('conta.campo.nomeExibicao')}<input autoFocus value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={60} /></label>}
        <label className="field">{t('conta.campo.usuario')}<input required autoFocus={mode !== 'setup'} autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
        {mode === 'setup'
          ? <NewPassword value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          : <label className="field">{t('conta.senha.rotulo')}<input required type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>}
        {mode === 'setup' && st.setupTokenRequired && <label className="field">{t('conta.entrar.codigoConfiguracao')}<input required value={f.setupToken} onChange={(e) => setF({ ...f, setupToken: e.target.value })} /></label>}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" type="submit" disabled={!!busy}>{busy ?? (mode === 'setup' ? t('conta.entrar.criarProteger') : mode === 'unseal' ? t('conta.entrar.abrir') : t('conta.entrar.entrar'))}</button>
      </form>
      {mode === 'login' && passkey && (
        <button className="btn btn--block auth__alt" disabled={!!busy} onClick={() => run(t('conta.passkey.esperando'), async () => { await passkeyLogin(); onDone(); })}><Icon name="key" size={16} /> {t('conta.passkey.entrar')}</button>
      )}
      {mode !== 'setup' && st.protected && <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '', phrase: '' }); setStep({ k: 'recover' }); }}>{t('conta.entrar.esqueci')}</button>}
      {mode === 'login' && st.signup && (
        <p className="auth__signup">{tn('conta.entrar.primeiraVez', {
          criar: <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '' }); setStep({ k: 'register' }); }}>{t('conta.entrar.criarMinha')}</button>,
        })}</p>
      )}
      {mode === 'setup' && <p className="hint">{t('conta.entrar.setupEmSeguida')}</p>}
      {mode === 'unseal' && <p className="hint">{t('conta.entrar.trancadoDica')}</p>}
    </Card>
  );
}

/**
 * Frase de recuperação: aparece uma vez, escondida até a pessoa pedir; só passa a valer depois de confirmar 3
 * palavras. Sem botão de copiar (a área de transferência vaza para outros programas).
 */
export function RecoveryReveal({ r, onDone, onCancel }: { r: Recovery; onDone: () => void; onCancel?: () => void }) {
  const t = useT();
  const [stage, setStage] = useState<'hidden' | 'show' | 'check'>('hidden');
  const [noted, setNoted] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = r.phrase.split(' ');

  if (stage === 'check') {
    return (
      <form className="recovery" onSubmit={async (e) => {
        e.preventDefault(); setErr(null); setBusy(true);
        try { await api.post('/api/security/recovery/confirm', { answers }); onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
      }}>
        <h2 className="auth__title">{t('conta.frase.confira')}</h2>
        <p className="muted">{t('conta.frase.digite')}</p>
        {r.ask.map((n) => (
          <label key={n} className="field">{t('conta.frase.palavra', { numero: n })}<input required autoComplete="off" spellCheck={false} value={answers[n] ?? ''} onChange={(e) => setAnswers({ ...answers, [n]: e.target.value.trim() })} /></label>
        ))}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? t('conta.acao.conferindo') : t('conta.acao.confirmar')}</button>
        <button type="button" className="link" onClick={() => { setErr(null); setStage('show'); }}>{t('conta.frase.verDeNovo')}</button>
      </form>
    );
  }
  return (
    <div className="recovery">
      <h2 className="auth__title">{t('conta.frase.titulo')}</h2>
      <p>{tn('conta.frase.anote', { papel: <b>{t('conta.frase.emPapel')}</b> })}</p>
      <p className="hint warn">{t('conta.frase.soAgora')}</p>
      {stage === 'hidden'
        ? <button className="btn btn--block" onClick={() => setStage('show')}><Icon name="eye" size={16} /> {t('conta.frase.mostrar')}</button>
        : <ol className="phrase">{words.map((w, i) => <li key={i}><small>{i + 1}</small> {w}</li>)}</ol>}
      <label className="check"><input type="checkbox" checked={noted} disabled={stage === 'hidden'} onChange={(e) => setNoted(e.target.checked)} /> {t('conta.frase.anotei')}</label>
      <button className="btn btn--primary btn--block" disabled={!noted} onClick={() => setStage('check')}>{t('conta.acao.continuar')}</button>
      {onCancel && <button className="link" onClick={onCancel}>{t('conta.acao.agoraNao')}</button>}
    </div>
  );
}

/** Instalação antiga, ainda sem criptografia: confere a senha (troca se for fraca), cifra tudo e mostra a frase. */
export function ProtectScreen({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const t = useT();
  const [f, setF] = useState({ password: '', next: '', confirm: '' });
  const [needNew, setNeedNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rec, setRec] = useState<Recovery | null>(null);
  if (rec) return <Card><RecoveryReveal r={rec} onDone={onDone} /></Card>;
  return (
    <Card busy={busy} title={t('conta.proteger.titulo')} sub={t('conta.proteger.sub')}>
      <form onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        if (needNew && f.next !== f.confirm) return setErr(t('conta.senha.novasDiferentes'));
        setBusy(true);
        try {
          const r = await api.post<{ recovery: Recovery }>('/api/security/protect', { password: f.password, ...(needNew ? { newPassword: f.next } : {}) });
          setRec(r.recovery);
        } catch (x) {
          if (x instanceof ApiError && x.code === 'weak_password_change') setNeedNew(true);
          setErr(errMsg(x));
        } finally { setBusy(false); }
      }}>
        <label className="field">{t('conta.senha.atual')}<input required autoFocus type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {needNew && <NewPassword label={t('conta.senha.nova')} value={f.next} confirm={f.confirm} onChange={(next, confirm) => setF({ ...f, next, confirm })} />}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? t('conta.proteger.cifrando') : t('conta.proteger.agora')}</button>
      </form>
      <p className="hint">{t('conta.proteger.dica')}</p>
      <button className="link" onClick={onLogout}>{t('conta.acao.sair')}</button>
    </Card>
  );
}

/** Formulário de destrancar/confirmar: senha ou passkey (o autenticador é só no login). */
function UnlockForm({ factors, rpId, submitLabel, onDone }: { factors: { totp: boolean; passkeys: number }; rpId: string; submitLabel: string; onDone: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (fn: () => Promise<unknown>) => {
    setErr(null); setBusy(true);
    try { await fn(); setPassword(''); onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); void go(() => api.post('/api/session/unlock', { password })); }}>
        <label className="field">{t('conta.senha.rotulo')}<input required autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? t('conta.acao.conferindo') : submitLabel}</button>
      </form>
      {factors.passkeys > 0 && passkeysHere(rpId) && <button className="btn btn--block auth__alt" disabled={busy} onClick={() => void go(passkeyUnlock)}><Icon name="key" size={16} /> {t('conta.passkey.usar')}</button>}
    </>
  );
}

/**
 * Depois de reiniciar, com várias pessoas no computador: a instalação abriu, mas a parte de cada pessoa só abre com a
 * senha dela (passkey e autenticador não trazem a chave). Até lá, os agentes e as rotinas dela esperam.
 */
export function PersonOpenScreen({ name, onDone, onLogout }: { name: string; onDone: () => void; onLogout: () => void }) {
  const t = useT();
  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__brand"><ErgonLogo height={36} /></h1>
        <h2 className="auth__title"><Icon name="lock" size={18} /> {t('conta.abrirDados.titulo')}</h2>
        <p className="muted">{t('conta.abrirDados.texto', { nome: name })}</p>
        <UnlockForm factors={{ totp: false, passkeys: 0 }} rpId="" submitLabel={t('conta.entrar.abrir')} onDone={onDone} />
        <p className="hint">{t('conta.abrirDados.esqueceu')}</p>
        <button className="link" onClick={onLogout}>{t('conta.acao.sair')}</button>
      </div>
    </main>
  );
}

/** Tela trancada por inatividade: cobre tudo (nada fica visível atrás); os agentes seguem trabalhando. */
export function LockOverlay({ name, factors, rpId, onUnlocked, onLogout }: { name: string; factors: { totp: boolean; passkeys: number }; rpId: string; onUnlocked: () => void; onLogout: () => void }) {
  const t = useT();
  return (
    <div className="lock" role="dialog" aria-modal="true" aria-label={t('conta.trancada.titulo')}>
      <div className="auth__card">
        <h1 className="auth__brand"><ErgonLogo height={36} /></h1>
        <h2 className="auth__title"><Icon name="lock" size={18} /> {t('conta.trancada.titulo')}</h2>
        <p className="muted">{t('conta.trancada.texto', { nome: name })}</p>
        <UnlockForm factors={factors} rpId={rpId} submitLabel={t('conta.trancada.destrancar')} onDone={onUnlocked} />
        <button className="link" onClick={onLogout}>{t('conta.acao.sair')}</button>
      </div>
    </div>
  );
}

/**
 * Primeiro acesso: o Ergon foi feito para trabalhar sozinho, então recomenda ligar o destrancar sozinho — mas a
 * escolha é da pessoa e fica explicada (o que ganha, o que arrisca). Aparece uma vez; muda-se em Configurações.
 */
export function AutoUnlockPrompt({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const choose = async (on: boolean) => {
    setErr(null); setBusy(on ? 'on' : 'off');
    try {
      if (on) await api.post('/api/security/auto-unlock'); else await api.post('/api/security/auto-unlock/asked', { choice: 'desligar' });
      onDone();
    } catch (x) { setErr(errMsg(x)); setBusy(null); }
  };
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="au-title">
      <div className="auth__card prompt">
        <h2 className="auth__title" id="au-title"><Icon name="key" size={18} /> {t('conta.auto.pergunta')}</h2>
        <p>{tn('conta.auto.ligadoTexto', { ligado: <b>{t('conta.auto.palavraLigado')}</b> })}</p>
        <p>{tn('conta.auto.desligadoTexto', { desligado: <b>{t('conta.auto.palavraDesligado')}</b> })}</p>
        <p className="hint warn">{t('conta.auto.aviso')}</p>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={!!busy} onClick={() => void choose(true)}>{busy === 'on' ? t('conta.estado.ligando') : t('conta.auto.ligar')}</button>
        <button className="btn btn--block auth__alt" disabled={!!busy} onClick={() => void choose(false)}>{t('conta.auto.deixarDesligado')}</button>
        <p className="hint">{t('conta.auto.mudarDepois')}</p>
      </div>
    </div>
  );
}

/** Ação sensível (frase nova, autenticador, passkey, destrancar sozinho): confirma a identidade antes. */
export function ReauthDialog({ factors, rpId, onDone, onCancel }: { factors: { totp: boolean; passkeys: number }; rpId: string; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-label={t('conta.reauth.aria')}>
      <div className="auth__card">
        <h2 className="auth__title"><Icon name="lock" size={18} /> {t('conta.reauth.titulo')}</h2>
        <p className="muted">{t('conta.reauth.texto')}</p>
        <UnlockForm factors={factors} rpId={rpId} submitLabel={t('conta.acao.confirmar')} onDone={onDone} />
        <button className="link" onClick={onCancel}>{t('conta.acao.cancelar')}</button>
      </div>
    </div>
  );
}

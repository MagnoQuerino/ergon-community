import { useEffect, useState } from 'react';
import { ApiError, api, errMsg, setCsrf } from '../lib/api.ts';
import { passkeyLogin, passkeyUnlock, passkeysHere } from '../lib/passkey.ts';
import type { AuthState, Me } from '../lib/types.ts';
import { ErgonLogo } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';
import { SetupSteps } from './Onboarding.tsx';

type LoginResult = { ok: boolean; need2fa?: boolean; challenge?: string; methods?: { totp: boolean; passkey: boolean }; recovery?: Recovery };
type Recovery = { phrase: string; ask: number[] };
const PASS_HINT = 'Mínimo de 12 caracteres. Uma frase de 3 ou 4 palavras que só você conhece é forte e fácil de lembrar.';

/** Depois de destrancar, o portão dá lugar ao servidor completo: espera ele responder (alguns segundos no máximo). */
async function waitOpen(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { const s = await api.get<AuthState>('/api/auth/state'); if (!s.sealed) return; } catch { /* trocando de servidor */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('O Ergon demorou para abrir. Recarregue a página.');
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

function NewPassword({ value, confirm, onChange, label = 'Senha' }: { value: string; confirm: string; onChange: (v: string, c: string) => void; label?: string }) {
  const mismatch = confirm.length > 0 && confirm !== value;
  return (
    <>
      <label className="field">{label}<input required type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value, confirm)} minLength={12} /></label>
      <label className="field">Repita a senha<input required type="password" autoComplete="new-password" value={confirm} onChange={(e) => onChange(value, e.target.value)} minLength={12} /></label>
      {mismatch ? <p className="hint warn">As senhas não são iguais.</p> : <p className="hint">{PASS_HINT}</p>}
    </>
  );
}

/**
 * Entrada no Ergon: primeiro uso (cria a conta e a frase), trancado depois de reiniciar (senha ou frase abrem
 * os dados), login normal, 2º fator e recuperação com a frase.
 */
export function AuthFlow({ st, onDone }: { st: AuthState; onDone: () => void }) {
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
    const t = window.setInterval(() => { void api.get<AuthState>('/api/auth/state').then((s) => { if (!s.sealed) onDone(); }).catch(() => {}); }, 3000);
    return () => clearInterval(t);
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

  const submit = () => run(mode === 'unseal' ? 'Abrindo os dados…' : mode === 'setup' ? 'Criando e protegendo…' : 'Entrando…', async () => {
    if (mode === 'setup') {
      if (f.password !== f.confirm) throw new Error('As senhas não são iguais.');
      const r = await api.post<LoginResult>('/api/auth/setup', { username: f.username, password: f.password, displayName: f.displayName || f.username, ...(st.setupTokenRequired ? { setupToken: f.setupToken } : {}) });
      return after(r, false);
    }
    if (mode === 'unseal') return after(await api.post<LoginResult>('/api/unseal', { username: f.username, password: f.password }), true);
    return after(await api.post<LoginResult>('/api/auth/login', { username: f.username, password: f.password }), false);
  });
  // conta nova neste computador: workspace, chave e frase próprios (as boas-vindas vêm em seguida)
  const register = () => run('Criando a sua conta…', async () => {
    if (f.password !== f.confirm) throw new Error('As senhas não são iguais.');
    const r = await api.post<LoginResult>('/api/auth/register', { username: f.username, password: f.password, displayName: f.displayName || f.username, ...(st.signup === 'convite' ? { invite: f.invite } : {}) });
    return after(r, false);
  });
  const recover = () => run('Conferindo a frase…', async () => {
    if (f.password !== f.confirm) throw new Error('As senhas não são iguais.');
    const body = { username: f.username, phrase: f.phrase, newPassword: f.password };
    if (mode === 'unseal') return after(await api.post<LoginResult>('/api/unseal/recovery', body), true);
    await api.post('/api/auth/recover', body);
    onDone();
  });

  if (step.k === 'phrase') return <Card steps={mode === 'setup' || st.signup ? 1 : undefined}><RecoveryReveal r={step.r} onDone={onDone} /></Card>;

  if (step.k === 'register') {
    return (
      <Card busy={!!busy} steps={0} title="Criar conta neste computador"
        sub="Cada pessoa tem a própria conta: os seus dados ficam cifrados com a sua senha, e quem mais usa este computador não vê nada do que é seu (nem você o deles).">
        <form onSubmit={(e) => { e.preventDefault(); void register(); }}>
          <label className="field">Nome de exibição<input autoFocus value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={60} /></label>
          <label className="field">Usuário<input required autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
          <NewPassword value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          {st.signup === 'convite' && <label className="field">Código do convite<input required autoComplete="off" spellCheck={false} placeholder="ABCD-2345" value={f.invite} onChange={(e) => setF({ ...f, invite: e.target.value.toUpperCase() })} maxLength={20} /></label>}
          {st.signup === 'convite' && <p className="hint">Neste computador, conta nova precisa de um convite de quem administra o Ergon (Configurações › Pessoas).</p>}
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? 'Criar e proteger'}</button>
        </form>
        <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '' }); setStep({ k: 'form' }); }}>Já tenho conta</button>
        <p className="hint">Em seguida: a sua frase de 24 palavras (a chave reserva dos seus dados), duas perguntas sobre como você trabalha e a conexão da sua conta de IA.</p>
      </Card>
    );
  }

  if (step.k === '2fa') {
    const { challenge, methods } = step;
    return (
      <Card title="Segunda verificação" sub="Falta confirmar que é você." busy={!!busy}>
        {methods.totp && (
          <form onSubmit={(e) => { e.preventDefault(); void run('Conferindo…', async () => { await api.post('/api/auth/login/totp', { challenge, code: f.code.replace(/\s/g, '') }); onDone(); }); }}>
            <label className="field">Código do autenticador<input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
            <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? 'Confirmar'}</button>
          </form>
        )}
        {methods.passkey && (passkey
          ? <button className="btn btn--block" disabled={!!busy} onClick={() => run('Esperando a passkey…', async () => { await passkeyLogin(challenge); onDone(); })}><Icon name="key" size={16} /> Usar passkey</button>
          : <p className="hint">A passkey só funciona abrindo o Ergon por {st.publicUrl}.</p>)}
        {err && <p className="error" role="alert">{err}</p>}
      </Card>
    );
  }

  if (step.k === 'recover') {
    return (
      <Card busy={!!busy} title="Recuperar com a frase" sub="Digite as 24 palavras anotadas, na ordem, e escolha uma senha nova. Acentos e maiúsculas não importam.">
        <form onSubmit={(e) => { e.preventDefault(); void recover(); }}>
          <label className="field">Usuário<input required autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
          <label className="field">Frase de recuperação<textarea required rows={4} spellCheck={false} autoComplete="off" value={f.phrase} onChange={(e) => setF({ ...f, phrase: e.target.value })} /></label>
          <NewPassword label="Senha nova" value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={!!busy}>{busy ?? 'Redefinir a senha e entrar'}</button>
        </form>
        <button className="link" onClick={() => { setErr(null); setStep({ k: 'form' }); }}>Voltar</button>
      </Card>
    );
  }

  return (
    <Card
      busy={!!busy}
      steps={mode === 'setup' ? 0 : undefined}
      title={mode === 'setup' ? 'Crie a sua conta' : mode === 'unseal' ? 'Ergon trancado' : undefined}
      sub={mode === 'setup' ? 'Tudo fica cifrado neste computador, com a sua senha. Leva uns dois minutos até a equipe estar pronta.'
        : mode === 'unseal' ? 'O Ergon foi reiniciado e os dados estão cifrados. Digite a senha para abrir: os agentes voltam ao trabalho logo em seguida.'
          : st.signup ? 'Entre com a sua conta deste computador (a mesma do navegador).' : 'Entre com a sua conta.'}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {mode === 'setup' && <label className="field">Nome de exibição<input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={60} /></label>}
        <label className="field">Usuário<input required autoFocus autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} maxLength={32} /></label>
        {mode === 'setup'
          ? <NewPassword value={f.password} confirm={f.confirm} onChange={(password, confirm) => setF({ ...f, password, confirm })} />
          : <label className="field">Senha<input required type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>}
        {mode === 'setup' && st.setupTokenRequired && <label className="field">Token de configuração<input required value={f.setupToken} onChange={(e) => setF({ ...f, setupToken: e.target.value })} /></label>}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" type="submit" disabled={!!busy}>{busy ?? (mode === 'setup' ? 'Criar e proteger' : mode === 'unseal' ? 'Abrir' : 'Entrar')}</button>
      </form>
      {mode === 'login' && passkey && (
        <button className="btn btn--block auth__alt" disabled={!!busy} onClick={() => run('Esperando a passkey…', async () => { await passkeyLogin(); onDone(); })}><Icon name="key" size={16} /> Entrar com passkey</button>
      )}
      {mode !== 'setup' && st.protected && <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '', phrase: '' }); setStep({ k: 'recover' }); }}>Esqueci a senha</button>}
      {mode === 'login' && st.signup && (
        <p className="auth__signup">Primeira vez neste computador? <button className="link" onClick={() => { setErr(null); setF({ ...f, password: '', confirm: '' }); setStep({ k: 'register' }); }}>Criar a minha conta</button></p>
      )}
      {mode === 'setup' && <p className="hint">Em seguida: uma frase de 24 palavras (a chave reserva dos seus dados, mostrada uma única vez), duas perguntas sobre como você trabalha e a conexão da sua conta de IA. A equipe chega montada para o seu caso.</p>}
      {mode === 'unseal' && <p className="hint">Passkey e autenticador não abrem os dados depois de reiniciar (eles não guardam a chave); a senha ou a frase, sim.</p>}
    </Card>
  );
}

/**
 * Frase de recuperação: aparece uma vez, escondida até a pessoa pedir; só passa a valer depois de confirmar 3
 * palavras. Sem botão de copiar (a área de transferência vaza para outros programas).
 */
export function RecoveryReveal({ r, onDone, onCancel }: { r: Recovery; onDone: () => void; onCancel?: () => void }) {
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
        <h2 className="auth__title">Confira a frase</h2>
        <p className="muted">Digite estas palavras da sua anotação:</p>
        {r.ask.map((n) => (
          <label key={n} className="field">Palavra nº {n}<input required autoComplete="off" spellCheck={false} value={answers[n] ?? ''} onChange={(e) => setAnswers({ ...answers, [n]: e.target.value.trim() })} /></label>
        ))}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? 'Conferindo…' : 'Confirmar'}</button>
        <button type="button" className="link" onClick={() => { setErr(null); setStage('show'); }}>Ver a frase de novo</button>
      </form>
    );
  }
  return (
    <div className="recovery">
      <h2 className="auth__title">Frase de recuperação</h2>
      <p>Anote estas 24 palavras <b>em papel</b>, na ordem, e guarde em lugar seguro. Se você esquecer a senha, só elas abrem os seus dados — nem nós conseguimos.</p>
      <p className="hint warn">Ela aparece só agora. Não tire foto nem salve em arquivo ou nuvem.</p>
      {stage === 'hidden'
        ? <button className="btn btn--block" onClick={() => setStage('show')}><Icon name="eye" size={16} /> Mostrar a frase (confira se ninguém está olhando)</button>
        : <ol className="phrase">{words.map((w, i) => <li key={i}><small>{i + 1}</small> {w}</li>)}</ol>}
      <label className="check"><input type="checkbox" checked={noted} disabled={stage === 'hidden'} onChange={(e) => setNoted(e.target.checked)} /> Anotei as 24 palavras em papel</label>
      <button className="btn btn--primary btn--block" disabled={!noted} onClick={() => setStage('check')}>Continuar</button>
      {onCancel && <button className="link" onClick={onCancel}>Agora não</button>}
    </div>
  );
}

/** Instalação antiga, ainda sem criptografia: confere a senha (troca se for fraca), cifra tudo e mostra a frase. */
export function ProtectScreen({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [f, setF] = useState({ password: '', next: '', confirm: '' });
  const [needNew, setNeedNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rec, setRec] = useState<Recovery | null>(null);
  if (rec) return <Card><RecoveryReveal r={rec} onDone={onDone} /></Card>;
  return (
    <Card busy={busy} title="Proteger o Ergon" sub="Esta instalação foi criada antes da criptografia. Ao proteger, o banco, as conversas, as tarefas, os arquivos e os dados do motor de IA passam a ficar cifrados com a sua senha.">
      <form onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        if (needNew && f.next !== f.confirm) return setErr('As senhas novas não são iguais.');
        setBusy(true);
        try {
          const r = await api.post<{ recovery: Recovery }>('/api/security/protect', { password: f.password, ...(needNew ? { newPassword: f.next } : {}) });
          setRec(r.recovery);
        } catch (x) {
          if (x instanceof ApiError && x.code === 'weak_password_change') setNeedNew(true);
          setErr(errMsg(x));
        } finally { setBusy(false); }
      }}>
        <label className="field">Senha atual<input required autoFocus type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {needNew && <NewPassword label="Senha nova" value={f.next} confirm={f.confirm} onChange={(next, confirm) => setF({ ...f, next, confirm })} />}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? 'Cifrando os dados… (alguns segundos)' : 'Proteger agora'}</button>
      </form>
      <p className="hint">Os agentes e as conexões continuam como estão. Depois disso, ao reiniciar o computador, o Ergon pede a senha para abrir (ou destranca sozinho, se você ligar essa opção em Configurações › Segurança).</p>
      <button className="link" onClick={onLogout}>Sair</button>
    </Card>
  );
}

/** Formulário de destrancar/confirmar: senha ou passkey (o autenticador é só no login). */
export function UnlockForm({ factors, rpId, submitLabel, onDone }: { factors: { totp: boolean; passkeys: number }; rpId: string; submitLabel: string; onDone: () => void }) {
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
        <label className="field">Senha<input required autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{busy ? 'Conferindo…' : submitLabel}</button>
      </form>
      {factors.passkeys > 0 && passkeysHere(rpId) && <button className="btn btn--block auth__alt" disabled={busy} onClick={() => void go(passkeyUnlock)}><Icon name="key" size={16} /> Usar passkey</button>}
    </>
  );
}

/**
 * Depois de reiniciar, com várias pessoas no computador: a instalação abriu, mas a parte de cada pessoa só abre com a
 * senha dela (passkey e autenticador não trazem a chave). Até lá, os agentes e as rotinas dela esperam.
 */
export function PersonOpenScreen({ name, onDone, onLogout }: { name: string; onDone: () => void; onLogout: () => void }) {
  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__brand"><ErgonLogo height={36} /></h1>
        <h2 className="auth__title"><Icon name="lock" size={18} /> Abrir os seus dados</h2>
        <p className="muted">{name}, o Ergon foi reiniciado. Os seus dados ficam cifrados com a sua senha: digite-a para abrir. Os seus agentes e rotinas voltam ao trabalho logo em seguida.</p>
        <UnlockForm factors={{ totp: false, passkeys: 0 }} rpId="" submitLabel="Abrir" onDone={onDone} />
        <p className="hint">Esqueceu? Saia e use "Esqueci a senha" com a sua frase de 24 palavras.</p>
        <button className="link" onClick={onLogout}>Sair</button>
      </div>
    </main>
  );
}

/** Tela trancada por inatividade: cobre tudo (nada fica visível atrás); os agentes seguem trabalhando. */
export function LockOverlay({ name, factors, rpId, onUnlocked, onLogout }: { name: string; factors: { totp: boolean; passkeys: number }; rpId: string; onUnlocked: () => void; onLogout: () => void }) {
  return (
    <div className="lock" role="dialog" aria-modal="true" aria-label="Tela trancada">
      <div className="auth__card">
        <h1 className="auth__brand"><ErgonLogo height={36} /></h1>
        <h2 className="auth__title"><Icon name="lock" size={18} /> Tela trancada</h2>
        <p className="muted">{name}, o Ergon trancou por inatividade. Os agentes continuam trabalhando.</p>
        <UnlockForm factors={factors} rpId={rpId} submitLabel="Destrancar" onDone={onUnlocked} />
        <button className="link" onClick={onLogout}>Sair</button>
      </div>
    </div>
  );
}

/**
 * Primeiro acesso: o Ergon foi feito para trabalhar sozinho, então recomenda ligar o destrancar sozinho — mas a
 * escolha é da pessoa e fica explicada (o que ganha, o que arrisca). Aparece uma vez; muda-se em Configurações.
 */
export function AutoUnlockPrompt({ onDone }: { onDone: () => void }) {
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
        <h2 className="auth__title" id="au-title"><Icon name="key" size={18} /> Destrancar sozinho ao ligar o computador?</h2>
        <p>Os agentes do Ergon foram feitos para trabalhar por você o tempo todo. Com isto <b>ligado</b>, quando o computador reinicia o Ergon destranca sozinho e os agentes voltam ao trabalho sem esperar você.</p>
        <p>Com isto <b>desligado</b>, depois de reiniciar os dados ficam trancados até você digitar a senha — e os agentes ficam parados até lá.</p>
        <p className="hint warn">Ligado, quem entrar na sua conta deste computador abre o Ergon sem a senha. Recomendamos ligar se o computador é só seu e tem senha, PIN ou biometria.</p>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={!!busy} onClick={() => void choose(true)}>{busy === 'on' ? 'Ligando…' : 'Ligar (recomendado)'}</button>
        <button className="btn btn--block auth__alt" disabled={!!busy} onClick={() => void choose(false)}>Deixar desligado</button>
        <p className="hint">Dá para mudar quando quiser em Configurações › Segurança.</p>
      </div>
    </div>
  );
}

/** Ação sensível (frase nova, autenticador, passkey, destrancar sozinho): confirma a identidade antes. */
export function ReauthDialog({ factors, rpId, onDone, onCancel }: { factors: { totp: boolean; passkeys: number }; rpId: string; onDone: () => void; onCancel: () => void }) {
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-label="Confirmar identidade">
      <div className="auth__card">
        <h2 className="auth__title"><Icon name="lock" size={18} /> Confirme que é você</h2>
        <p className="muted">Esta ação mexe na segurança da conta. Vale por 5 minutos.</p>
        <UnlockForm factors={factors} rpId={rpId} submitLabel="Confirmar" onDone={onDone} />
        <button className="link" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

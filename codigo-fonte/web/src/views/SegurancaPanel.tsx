import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { passkeyRegister, passkeysHere } from '../lib/passkey.ts';
import type { Me, SecurityStatus } from '../lib/types.ts';
import { RecoveryReveal } from '../components/AuthFlow.tsx';
import { Loading } from '../brand/Brand.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
/** "Chrome · Windows" a partir do user agent (só para reconhecer a sessão). */
function device(ua: string | null): string {
  const s = ua ?? '';
  const b = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Navegador';
  const o = /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}

/** Botão liga/desliga do destrancar sozinho (precisa do ajudante do computador para ligar). */
function AutoUnlockSwitch({ s, busy, onOn, onOff }: { s: SecurityStatus; busy: boolean; onOn: () => void; onOff: () => void }) {
  const on = s.autoUnlock.length > 0;
  const pending = !on && s.autoUnlockPending;
  return (
    <button role="switch" aria-checked={on || pending} aria-label="Destrancar sozinho ao ligar o computador" className={`switch ${on || pending ? 'switch--on' : ''}`}
      disabled={busy || pending || (!on && !s.agentConfigured)} onClick={on ? onOff : onOn}>
      <span className="switch__knob" /><span className="switch__txt">{on ? 'Ligado' : pending ? 'Ligando…' : 'Desligado'}</span>
    </button>
  );
}

/**
 * Trancamento: ligado, o Ergon pede a senha ao reiniciar; desligado (padrão no computador), abre sozinho e a proteção
 * passa a ser a do computador. Desligar mostra antes um aviso curto dos riscos.
 */
function LockCard({ s, busy, onSet }: { s: SecurityStatus; busy: boolean; onSet: (on: boolean) => void }) {
  const [ask, setAsk] = useState(false);
  const on = s.lock.enabled;
  return (
    <section className="card">
      <div className="row sec-toggle">
        <h3>Trancamento</h3>
        <button role="switch" aria-checked={on} aria-label="Trancar o Ergon ao reiniciar" className={`switch ${on ? 'switch--on' : ''}`}
          disabled={busy || ask} onClick={() => (on ? setAsk(true) : onSet(true))}>
          <span className="switch__knob" /><span className="switch__txt">{on ? 'Ligado' : 'Desligado'}</span>
        </button>
      </div>
      {on
        ? <p>Ligado: ao reiniciar, o Ergon pede a senha (ou a frase) para abrir, e a sessão vale {s.lock.sessionDays} dias. Os agentes esperam até você destrancar.</p>
        : <p>Desligado: o Ergon abre sozinho ao reiniciar e você não digita senha ({s.lock.sessionDays} dias sem pedir, renovados com o uso). Quem protege o acesso é o computador.</p>}
      {ask && (
        <div className="lock-warn" role="alertdialog" aria-label="Desligar o trancamento">
          <p><b>Antes de desligar:</b> quem usar este computador — ou copiar os arquivos do Ergon — abre o Ergon e lê tudo, sem senha. Os dados continuam cifrados no disco, mas a chave fica ao lado deles. Use só se o computador é seu, tem senha ou biometria e a criptografia do disco (BitLocker, FileVault) ligada, e não fica desbloqueado sem você.</p>
          <p>Mais seguro e também sem senha: deixe o trancamento ligado e use <b>Destrancar sozinho</b> (abaixo) — a chave fica no cofre do sistema, presa à sua conta do computador, e não junto dos dados.</p>
          <div className="row">
            <button className="btn btn--primary" disabled={busy} onClick={() => { setAsk(false); onSet(false); }}>Desligar mesmo assim</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setAsk(false)}>Manter ligado</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Configurações › Segurança: senha, trava, frase, autenticador, passkeys, destrancar sozinho e sessões. */
export function SegurancaPanel({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const st = useResource<SecurityStatus>('/api/security/status', []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [rec, setRec] = useState<{ phrase: string; ask: number[] } | null>(null);
  const [totp, setTotp] = useState<{ secret: string; qr: string; code: string } | null>(null);
  const [pkName, setPkName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const s = st.data;
  // ajustes da instalação (trancamento): quem administra; frase, trava, abrir sozinho: cada pessoa a sua
  const admin = me.admin;
  const isolated = !!s?.people?.isolated;
  const [leaving, setLeaving] = useState<string | null>(null);
  // ligando: o ajudante do computador busca a chave em poucos segundos; a tela acompanha
  useEffect(() => {
    if (!s?.autoUnlockPending) return;
    const t = window.setInterval(() => st.reload(), 2000);
    return () => clearInterval(t);
  }, [s?.autoUnlockPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null); setBusy(label);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); st.reload(); onChanged(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(null); }
  };
  if (!s) return <Loading error={st.error} />;
  const here = passkeysHere(s.rpId);

  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>Proteção dos dados</h3>
        <ul className="sec-list">
          <li><span className="badge badge--ok">cifrado</span> Banco de dados inteiro (SQLCipher, AES-256)</li>
          <li><span className="badge badge--ok">cifrado</span> Conversas, tarefas, instruções, arquivos e chaves das conexões (AES-256-GCM, chave própria por workspace)</li>
          {isolated && <li><span className="badge badge--ok">só seu</span> {s.people!.count} pessoas neste computador: a chave dos seus dados é sua (abre com a sua senha ou frase); quem administra o Ergon não lê nada do que é seu</li>}
          {s.motorVault
            ? <li><span className="badge badge--ok">cifrado</span> Dados do motor de IA: contas conectadas, histórico e memória (volume cifrado)</li>
            : <li><span className="badge">sem motor</span> Motor de IA desligado nesta instalação (nada a cifrar)</li>}
        </ul>
        <p className="hint">{s.lock.enabled
          ? 'A chave mestra só existe na memória enquanto o Ergon está aberto. Ao reiniciar, é preciso a senha (ou a frase, ou o destrancar sozinho) para abrir.'
          : 'Sem trancamento, a chave para abrir fica guardada ao lado dos dados: protege contra quem só levar o banco, não contra quem usar este computador.'} Recomendado também: criptografia do disco do sistema (BitLocker no Windows, FileVault no macOS, LUKS no Linux) — protege o resto do computador.</p>
      </section>

      {admin && s.mode === 'local' && s.protected && (
        <LockCard s={s} busy={busy === 'lock'} onSet={(on) => void act('lock', () => api.put('/api/security/lock', { enabled: on }),
          on ? 'Trancamento ligado. Ao reiniciar, o Ergon vai pedir a senha.' : 'Trancamento desligado. O Ergon abre sozinho; mantenha este computador protegido.')} />
      )}

      <section className="card">
        <h3>Senha</h3>
        <form className="row row--wrap" onSubmit={(e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) return setMsg({ kind: 'error', text: 'As senhas novas não são iguais.' });
          void act('senha', async () => { await api.post('/api/security/password', { current: pw.current, next: pw.next }); setPw({ current: '', next: '', confirm: '' }); }, 'Senha alterada. As outras sessões foram encerradas.');
        }}>
          <label className="field">Senha atual<input required type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
          <label className="field">Senha nova<input required type="password" autoComplete="new-password" minLength={s.minPassword} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
          <label className="field">Repita<input required type="password" autoComplete="new-password" minLength={s.minPassword} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
          <button className="btn btn--primary" disabled={busy === 'senha'}>{busy === 'senha' ? 'Salvando…' : 'Trocar senha'}</button>
        </form>
        <p className="hint">Mínimo de {s.minPassword} caracteres; uma frase de 3 ou 4 palavras é forte e fácil de lembrar. A senha nova também abre os dados depois de reiniciar.</p>
      </section>

      <IdleLock minutes={s.idleMinutes} owner busy={busy === 'idle'} onSave={(m, label) => void act('idle', () => api.put('/api/security/idle', { minutes: m }), label)} />

      <section className="card">
        {!rec && <h3>{isolated ? 'A sua frase de recuperação' : 'Frase de recuperação'}</h3>}
        {rec ? (
          <div className="sec-reveal"><RecoveryReveal r={rec} onDone={() => { setRec(null); setMsg({ kind: 'ok', text: 'Frase confirmada. Uma frase anterior, se havia, deixou de valer.' }); st.reload(); onChanged(); }} onCancel={() => setRec(null)} /></div>
        ) : (
          <>
            <p>{s.recovery ? <><span className="badge badge--ok">confirmada</span> A frase de 24 palavras abre os dados se a senha for esquecida.</> : <><span className="badge badge--warn">sem frase</span> Ainda não há uma frase confirmada: se a senha for esquecida, os dados não abrem.</>}</p>
            <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('frase', async () => setRec(await api.post('/api/security/recovery/new')))}>{s.recovery ? 'Gerar frase nova' : 'Gerar a frase'}</button>
            <p className="hint">Gerar uma nova invalida a anterior assim que você confirmar 3 palavras dela.</p>
          </>
        )}
      </section>

      <section className="card">
        <h3>Autenticador (código de 6 dígitos)</h3>
        {s.totp ? (
          <>
            <p><span className="badge badge--ok">ligado</span> Pedido no login e ao destrancar, junto com a senha.</p>
            <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('totp-off', () => api.del('/api/security/totp'), 'Autenticador desligado.')}>Desligar</button>
          </>
        ) : totp ? (
          <form className="totp" onSubmit={(e) => { e.preventDefault(); void act('totp', async () => { await api.post('/api/security/totp/confirm', { code: totp.code.replace(/\s/g, '') }); setTotp(null); }, 'Autenticador ligado.'); }}>
            <img src={totp.qr} alt="QR code para o aplicativo autenticador" width={180} height={180} />
            <div>
              <p>1. No aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…), leia o QR code.</p>
              <p className="muted small">Sem câmera? Digite a chave: <code className="totp__secret">{totp.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
              <label className="field">2. Digite o código que aparece<input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={totp.code} onChange={(e) => setTotp({ ...totp, code: e.target.value })} /></label>
              <div className="row"><button className="btn btn--primary btn--sm" disabled={!!busy}>Ligar</button><button type="button" className="btn btn--ghost btn--sm" onClick={() => setTotp(null)}>Cancelar</button></div>
            </div>
          </form>
        ) : (
          <>
            <p className="muted">Opcional neste computador; obrigatório na versão em nuvem.</p>
            <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('totp-start', async () => { const r = await api.post<{ secret: string; qr: string }>('/api/security/totp/start'); setTotp({ secret: r.secret, qr: r.qr, code: '' }); })}>Configurar</button>
          </>
        )}
      </section>

      <section className="card">
        <h3>Passkeys</h3>
        <p className="muted small">Entrar e destrancar com a digital, o rosto ou o PIN do aparelho (Windows Hello, Touch ID, celular). A chave privada nunca sai do aparelho.</p>
        {s.passkeys.length > 0 && (
          <ul className="sec-rows">
            {s.passkeys.map((p) => (
              <li key={p.id}><b>{p.name}</b><span className="muted small">criada {when(p.created_at)} · último uso {when(p.last_used_at)}</span>
                <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('pk-del', () => api.del(`/api/security/passkeys/${p.id}`), 'Passkey removida.')}>Remover</button></li>
            ))}
          </ul>
        )}
        {here ? (
          <form className="row row--wrap" onSubmit={(e) => { e.preventDefault(); void act('pk', async () => { await passkeyRegister(pkName.trim() || 'Este computador'); setPkName(''); }, 'Passkey cadastrada.'); }}>
            <label className="field">Nome (para reconhecer depois)<input value={pkName} maxLength={60} placeholder="Ex.: Notebook, Celular" onChange={(e) => setPkName(e.target.value)} /></label>
            <button className="btn btn--primary" disabled={!!busy}>{busy === 'pk' ? 'Esperando o aparelho…' : 'Adicionar passkey'}</button>
          </form>
        ) : <p className="hint warn">Passkeys só funcionam abrindo o Ergon por <a href={s.publicUrl}>{s.publicUrl}</a>.</p>}
      </section>

      {s.mode === 'local' && (s.lock.enabled || isolated) && (
        <section className="card">
          <div className="row sec-toggle">
            <h3>{isolated ? 'Abrir os meus dados sozinho ao ligar o computador' : 'Destrancar sozinho ao ligar o computador'}</h3>
            <AutoUnlockSwitch s={s} busy={!!busy} onOn={() => void act('auto-on', () => api.post('/api/security/auto-unlock'))}
              onOff={() => void act('auto-off', () => api.del('/api/security/auto-unlock'), 'Desligado. Depois de reiniciar, o Ergon vai pedir a senha.')} />
          </div>
          {s.autoUnlock.length
            ? <p>Ligado em <b>{s.autoUnlock[0].label || 'este computador'}</b> desde {when(s.autoUnlock[0].createdAt)}. Depois de reiniciar, o Ergon destranca sozinho e os agentes voltam ao trabalho sem esperar você.</p>
            : s.autoUnlockPending ? <p className="muted">Ligando… {s.agent ? 'o ajudante deste computador está guardando a chave.' : 'esperando o ajudante deste computador (ele começa ao entrar no computador).'}</p>
            : <p>Desligado: depois de reiniciar, o Ergon pede a senha, e os agentes esperam até você digitar.</p>}
          {!s.autoUnlock.length && !s.agentConfigured && <p className="hint warn">Esta instalação ainda não tem o ajudante do computador (ele vem com o instalador do Ergon), então o botão fica indisponível.</p>}
          <p className="hint">A chave fica no cofre do próprio sistema (proteção de dados do Windows, Chaves do macOS ou o chaveiro do Linux), presa à sua conta do computador: quem entrar nela abre o Ergon sem a senha. Recomendado se o computador é só seu e tem senha, PIN ou biometria.</p>
          {isolated && <p className="hint warn">Várias pessoas usam este computador: ligue só se a sua conta do Windows (ou do macOS/Linux) é só sua. Se todos entram na mesma conta do computador, quem usar essa conta abre os seus dados sem a sua senha.</p>}
        </section>
      )}

      {!admin && s.mode === 'local' && (
        <section className="card">
          <h3>Excluir a minha conta</h3>
          <p className="muted">Apaga de vez a sua equipe, as conversas, as tarefas, os arquivos, as conexões e o seu motor de IA neste computador. Primeiro sai a sua chave: daí em diante, nada disso abre mais, nem por backup.</p>
          {leaving === null
            ? <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => setLeaving('')}>Excluir a minha conta…</button>
            : (
              <form className="lock-warn" onSubmit={(e) => { e.preventDefault(); void act('leave', async () => { await api.del('/api/me/account', { confirm: leaving }); location.hash = ''; location.reload(); }); }}>
                <label className="field">Digite o seu usuário ({me.user.username}) para confirmar<input required autoFocus value={leaving} onChange={(e) => setLeaving(e.target.value)} /></label>
                <div className="row">
                  <button className="btn btn--danger btn--sm" disabled={busy === 'leave' || leaving !== me.user.username}>{busy === 'leave' ? 'Excluindo…' : 'Excluir de vez'}</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLeaving(null)}>Cancelar</button>
                </div>
              </form>
            )}
        </section>
      )}

      <section className="card">
        <h3>Sessões abertas</h3>
        <ul className="sec-rows">
          {s.sessions.map((x) => (
            <li key={x.id}><b>{device(x.user_agent)}</b><span className="muted small">{x.current ? 'esta sessão · ' : ''}desde {when(x.created_at)} · último uso {when(x.last_seen_at)}</span>
              {!x.current && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('sess', () => api.del(`/api/security/sessions/${x.id}`), 'Sessão encerrada.')}>Encerrar</button>}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * Trava por inatividade: desligada por padrão. Ligada, você diz depois de quanto tempo sem usar (minutos ou horas,
 * até 24 h). Só mouse e teclado contam; com a tela trancada, os agentes continuam trabalhando.
 */
function IdleLock({ minutes, owner, busy, onSave }: { minutes: number; owner: boolean; busy: boolean; onSave: (minutes: number, label: string) => void }) {
  const on = minutes > 0;
  const initUnit = minutes > 0 && minutes % 60 === 0 ? 'h' : 'min';
  const [unit, setUnit] = useState<'min' | 'h'>(initUnit);
  const [value, setValue] = useState(String(minutes > 0 ? (initUnit === 'h' ? minutes / 60 : minutes) : 15));
  useEffect(() => { if (minutes > 0) { const u = minutes % 60 === 0 ? 'h' : 'min'; setUnit(u); setValue(String(u === 'h' ? minutes / 60 : minutes)); } }, [minutes]);
  const n = Math.round(Number(value.replace(',', '.')) * (unit === 'h' ? 60 : 1));
  const valid = Number.isFinite(n) && n >= 1 && n <= 24 * 60;
  const text = (m: number) => (m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  return (
    <section className="card">
      <header className="row">
        <h3>Trava por inatividade</h3>
        <button role="switch" aria-checked={on} aria-label="Trancar a tela por inatividade" className={`switch ${on ? 'switch--on' : ''}`} disabled={!owner || busy}
          onClick={() => onSave(on ? 0 : (valid ? n : 15), on ? 'Trava desligada.' : `Trava ligada: tranca depois de ${text(valid ? n : 15)} sem uso.`)}>
          <span className="switch__knob" /><span className="switch__txt">{on ? 'Ligada' : 'Desligada'}</span>
        </button>
      </header>
      {on ? (
        <div className="row row--wrap">
          <label className="field field--inline">Trancar a tela depois de
            <input type="number" min={1} max={unit === 'h' ? 24 : 1440} step={unit === 'h' ? 0.5 : 1} value={value} disabled={!owner} onChange={(e) => setValue(e.target.value)} style={{ width: 80 }} />
            <select value={unit} disabled={!owner} onChange={(e) => setUnit(e.target.value as 'min' | 'h')}>
              <option value="min">minutos</option><option value="h">horas</option>
            </select>
            sem uso</label>
          <button className="btn btn--sm" disabled={!owner || busy || !valid || n === minutes} onClick={() => onSave(n, `Trava ajustada: ${text(n)} sem uso.`)}>Salvar</button>
          {!valid && <span className="hint warn">De 1 minuto a 24 horas.</span>}
        </div>
      ) : (
        <p className="muted">Desligada: a tela não tranca sozinha. Se o computador fica em lugar com outras pessoas, ligue e escolha depois de quanto tempo sem usar.</p>
      )}
      <p className="hint">Só mouse e teclado contam. Com a tela trancada, os agentes continuam trabalhando; nada fica visível até destrancar com a senha.</p>
    </section>
  );
}

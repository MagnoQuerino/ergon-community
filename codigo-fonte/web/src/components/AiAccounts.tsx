import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AiStatus } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import { Icon } from './Icon.tsx';
import { Typewriter } from './Typewriter.tsx';

interface Login { provider: string; sessionId: string; userCode: string | null; verificationUrl: string | null; expiresAt: string | null; pollSeconds: number }
const BILLING: Record<string, string> = {
  subscription: 'Assinatura: sem custo por uso; valem a mensalidade e os limites do plano. O painel mostra só os tokens.',
  credits: 'Créditos: cada uso consome os créditos da conta (na Nous, os da sua assinatura). O custo aparece no painel quando a conta informa o valor cobrado; o saldo fica no portal da conta.',
  api: 'Chave de API: cobra por uso; o custo aparece quando o provedor informa o valor cobrado.',
  none: 'Nenhuma conta conectada: os agentes respondem em modo de simulação.',
};
/** A melhor escolha para o Ergon: uma assinatura, os principais modelos do mercado e um modelo por agente. */
const RECOMMENDED = 'nous';
const NOUS_WHY = [
  'Os principais modelos do mercado numa assinatura só — Claude, GPT, Gemini, DeepSeek e muitos outros',
  'Plano grátis com modelos gratuitos para começar sem gastar nada',
  'Cada agente com o modelo certo: o mais forte para quem pensa, o mais econômico para quem organiza',
  'Melhor resultado pelo menor custo: você não paga modelo de ponta para tarefa simples',
];
/** Enquanto o motor de IA da pessoa liga (conta nova: até alguns minutos): a espera dentro do universo do Ergon. */
const LIGANDO = [
  'Acendendo a chama do templo da sabedoria…',
  'Aristóteles está reunindo a equipe na ágora…',
  'Tentando tirar Sócrates de um diálogo interminável na feira de Atenas…',
  'Hipátia afina os instrumentos do observatório…',
  'Abrindo as portas da biblioteca de Alexandria…',
];
/** depois disso sem resposta, a tela avisa que está demorando (e continua conferindo) */
const PACIENCIA_MS = 6 * 60_000;

/**
 * Contas de IA (a conta que paga os modelos dos agentes): login por código, no navegador da pessoa. A Nous aparece
 * sempre em destaque, como a melhor escolha (versatilidade e custo); o ChatGPT fica como alternativa para quem já
 * assina; a chave própria (BYOK) só fora das boas-vindas. O mesmo componente nas boas-vindas, em Conexões e em
 * Configurações.
 */
export function AiAccounts({ onChanged, pitch }: { onChanged?: () => void; pitch?: boolean }) {
  const status = useResource<AiStatus>('/api/ai/status', []);
  const [login, setLogin] = useState<Login | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const desde = useRef(Date.now());
  const s = status.data;

  const start = async (provider: string) => {
    setMsg(null);
    try { setLogin(await api.post<Login>(`/api/ai/accounts/${provider}/login`)); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const conectado = (quem: string | null | undefined, modelo: string | null | undefined) => {
    const m = modelo ? ` Modelo para começar: ${modelo} (troque quando quiser em Configurações › IA da equipe ou no perfil de cada agente).` : '';
    setMsg({ kind: 'ok', text: `Conta conectada${quem ? ` (${quem})` : ''}. ${pitch ? 'A equipe já pode trabalhar de verdade.' : 'Os modelos dela já aparecem em Configurações.'}${m}` });
    status.reload(); onChanged?.();
  };
  useEffect(() => {
    if (!login) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<{ status: string; error: string | null; email: string | null; starterModel?: string | null }>(`/api/ai/logins/${login.sessionId}`);
        if (stop) return;
        if (r.status === 'pending') { window.setTimeout(poll, login.pollSeconds * 1000); return; }
        setLogin(null);
        if (r.status === 'approved') conectado(r.email, r.starterModel);
        else setMsg({ kind: 'error', text: r.error ?? `Login não concluído (${r.status}).` });
      } catch (e) { if (!stop) { setLogin(null); setMsg({ kind: 'error', text: errMsg(e) }); } }
    };
    const t = window.setTimeout(poll, login.pollSeconds * 1000);
    return () => { stop = true; clearTimeout(t); };
  }, [login]); // eslint-disable-line react-hooks/exhaustive-deps
  // motor da pessoa ainda ligando (conta nova: até alguns minutos; um erro de tempo na primeira vez também passa):
  // confere a cada 3 s até responder; os botões se liberam sozinhos
  useEffect(() => {
    if (!s || s.available || !s.motor) return;
    const t = window.setTimeout(() => status.reload(), 3000);
    return () => clearTimeout(t);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const disconnect = async (provider: string) => {
    try { await api.del(`/api/ai/accounts/${provider}`); status.reload(); onChanged?.(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  if (!s) return <Loading error={status.error} />;
  const nous = s.accounts.find((a) => a.id === RECOMMENDED);
  const others = s.accounts.filter((a) => a.id !== RECOMMENDED);
  const otherOn = others.some((a) => a.connected) || (s.byok ?? []).some((b) => b.connected);
  const demorando = Date.now() - desde.current > PACIENCIA_MS;
  const codigo = (provider: string) => login?.provider === provider && (
    <div className="device" role="status">
      <p>1. Abra <a href={login.verificationUrl ?? '#'} target="_blank" rel="noreferrer noopener">a página de login</a> e entre na sua conta.</p>
      <p>2. Confirme este código: <code className="device__code">{login.userCode}</code></p>
      <p className="muted small">Esperando a confirmação…{login.expiresAt ? ` (vale até ${new Date(login.expiresAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })})` : ''}</p>
      <button className="btn btn--sm btn--ghost" onClick={async () => { await api.del(`/api/ai/logins/${login.sessionId}`).catch(() => {}); setLogin(null); }}>Cancelar</button>
    </div>
  );
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {s.executor === 'simulated' && <p className="hint warn">Esta instalação está em modo de simulação: as respostas dos agentes não usam IA de verdade, mesmo com uma conta conectada.</p>}
      {!s.available && (s.motor ? (
        <div className="ai-wait" role="status">
          <span className="dot dot--amber dot--pulse" />
          <div>
            <Typewriter phrases={LIGANDO} />
            <p className="muted small">{demorando
              ? <>Está levando mais que o normal. Continuamos tentando{s.motor.error ? ` (${s.motor.error})` : ''}. <button className="link" onClick={() => { desde.current = Date.now(); status.reload(); }}>Tentar de novo</button></>
              : 'Na primeira vez leva alguns instantes. Os botões se liberam sozinhos.'}</p>
          </div>
        </div>
      ) : (
        <p className="hint">A conexão de contas de IA não está disponível nesta instalação.</p>
      ))}
      {nous && (
        <article className={`ai-best ${nous.connected ? 'ai-best--on' : ''}`} aria-label="Nous Portal, a melhor escolha">
          <span className="ai-best__ribbon"><Icon name="check" size={12} /> Melhor escolha</span>
          <header className="ai-best__head">
            <BrandLogo kind={nous.id} name={nous.name} size={44} />
            <div>
              <h4>Assinatura {nous.name}</h4>
              <p>A melhor experiência no Ergon, pelo custo e pela versatilidade.</p>
            </div>
            <span className={`badge ${nous.connected ? 'badge--ok' : 'badge--rec'}`}>{nous.connected ? 'conectada' : 'recomendada'}</span>
          </header>
          <ul className="ai-best__why">{NOUS_WHY.map((w) => <li key={w}><Icon name="check" size={14} /> {w}</li>)}</ul>
          {nous.connected
            ? <div className="row"><span className="ok-inline"><Icon name="check" size={14} /> Conectada: cada agente pode usar um modelo diferente (perfil do agente › Modelo de IA).</span><span className="grow" /><button className="btn btn--sm btn--ghost" onClick={() => disconnect(nous.id)}>Desconectar</button></div>
            : login?.provider !== nous.id && <button className="btn btn--gold ai-best__cta" disabled={!s.available || !!login} onClick={() => start(nous.id)}>Conectar a Nous{otherOn ? ' também' : ''}</button>}
          {codigo(nous.id)}
          {!nous.connected && otherOn && <p className="hint">Você já tem outra conta ligada. Conectando a Nous também, cada agente pode usar o modelo mais adequado e mais barato para o trabalho dele.</p>}
        </article>
      )}
      {others.length > 0 && (
        <div className="ai-alt">
          <span className="ai-alt__label">Outra opção</span>
          {others.map((a) => (
            <div key={a.id} className={`ai-alt__row ${a.connected ? 'ai-alt__row--on' : ''} ${login?.provider === a.id ? 'ai-alt__row--open' : ''}`}>
              <div className="ai-alt__main">
                <BrandLogo kind={a.id} name={a.name} size={26} />
                <div className="ai-alt__txt">
                  <b>{a.name}</b>
                  <small>{a.id === 'openai-codex'
                    ? 'Já paga o ChatGPT? Conecte também e a equipe aproveita a assinatura que você já tem, sem custo por token. Dá para ter as duas contas ligadas e escolher, por agente, o modelo de cada uma.'
                    : a.about}</small>
                </div>
                <span className={`badge ${a.connected ? 'badge--ok' : ''}`}>{a.connected ? 'conectada' : a.detail}</span>
                {a.connected
                  ? <button className="btn btn--sm btn--ghost" onClick={() => disconnect(a.id)}>Desconectar</button>
                  : login?.provider !== a.id && <button className="btn btn--sm" disabled={!s.available || !!login} onClick={() => start(a.id)}>Conectar</button>}
              </div>
              {codigo(a.id)}
            </div>
          ))}
        </div>
      )}
      {!pitch && s.byok && s.byok.length > 0 && <ChavePropria byok={s.byok} available={s.available} onDone={(m) => conectado(null, m)} onRemoved={() => { status.reload(); onChanged?.(); }} />}
      {(!pitch || s.accounts.some((a) => a.connected)) && <p className="hint">{BILLING[s.default.billing]}</p>}
    </>
  );
}

/** Chave própria (BYOK): a chave de API do provedor que a pessoa já usa. Vai direto para o motor, que confere no
 *  provedor antes de gravar; aqui ela nunca volta a aparecer. */
function ChavePropria({ byok, available, onDone, onRemoved }: {
  byok: NonNullable<AiStatus['byok']>; available: boolean; onDone: (starterModel: string | null) => void; onRemoved: () => void;
}) {
  const [aberto, setAberto] = useState<string | null>(null);
  const [chave, setChave] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const salvar = async (id: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<{ verified: boolean; starterModel: string | null }>(`/api/ai/byok/${id}`, { key: chave });
      setAberto(null); setChave(''); onDone(r.starterModel);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const remover = async (id: string) => {
    setBusy(true); setErr(null);
    try { await api.del(`/api/ai/byok/${id}`); onRemoved(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="ai-alt ai-byok">
      <span className="ai-alt__label">Chave própria (BYOK)</span>
      <p className="muted small">Já tem uma chave de API? Conecte e os modelos desse provedor ficam disponíveis para a equipe. O custo é por uso, na sua conta do provedor.</p>
      {byok.map((b) => (
        <div key={b.id} className={`ai-alt__row ${b.connected ? 'ai-alt__row--on' : ''} ${aberto === b.id ? 'ai-alt__row--open' : ''}`}>
          <div className="ai-alt__main">
            <BrandLogo kind={b.id} name={b.name} size={26} />
            <div className="ai-alt__txt"><b>{b.name}</b><small>{b.about}</small></div>
            {b.connected && <span className="badge badge--ok">conectada</span>}
            {b.connected
              ? <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void remover(b.id)}>Desconectar</button>
              : aberto !== b.id && <button className="btn btn--sm" disabled={!available || busy} onClick={() => { setAberto(b.id); setChave(''); setErr(null); }}>Conectar</button>}
          </div>
          {aberto === b.id && (
            <form className="device ai-byok__form" onSubmit={(e) => { e.preventDefault(); void salvar(b.id); }}>
              <label htmlFor={`byok-${b.id}`}>Chave de API da {b.name} <a href={b.site} target="_blank" rel="noreferrer noopener">(criar uma)</a></label>
              <input id={`byok-${b.id}`} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={b.keyHint} value={chave} autoFocus onChange={(e) => setChave(e.target.value)} />
              {err && <p className="error" role="alert">{err}</p>}
              <div className="row">
                <button className="btn btn--sm btn--primary" disabled={busy || chave.trim().length < 20}>{busy ? 'Conferindo a chave…' : 'Conectar'}</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setAberto(null); setChave(''); setErr(null); }}>Cancelar</button>
              </div>
              <p className="muted small">A chave é conferida no provedor e guardada no motor de IA desta conta, cifrada. Ela não aparece de novo aqui.</p>
            </form>
          )}
        </div>
      ))}
      {err && !aberto && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

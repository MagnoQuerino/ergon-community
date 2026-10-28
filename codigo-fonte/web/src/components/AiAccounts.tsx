import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AiStatus } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import { Icon } from './Icon.tsx';

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

/**
 * Contas de IA (a conta que paga os modelos dos agentes): login por código, no navegador da pessoa. A Nous aparece
 * sempre em destaque, como a melhor escolha (versatilidade e custo); o ChatGPT fica como alternativa para quem já
 * assina. O mesmo componente nas boas-vindas, em Conexões e em Configurações.
 */
export function AiAccounts({ onChanged, pitch }: { onChanged?: () => void; pitch?: boolean }) {
  const status = useResource<AiStatus>('/api/ai/status', []);
  const [login, setLogin] = useState<Login | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const s = status.data;

  const start = async (provider: string) => {
    setMsg(null);
    try { setLogin(await api.post<Login>(`/api/ai/accounts/${provider}/login`)); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  useEffect(() => {
    if (!login) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<{ status: string; error: string | null; email: string | null }>(`/api/ai/logins/${login.sessionId}`);
        if (stop) return;
        if (r.status === 'pending') { window.setTimeout(poll, login.pollSeconds * 1000); return; }
        setLogin(null);
        if (r.status === 'approved') { setMsg({ kind: 'ok', text: `Conta conectada${r.email ? ` (${r.email})` : ''}. ${pitch ? 'A equipe já pode trabalhar de verdade.' : 'Os modelos dela já aparecem em Configurações.'}` }); status.reload(); onChanged?.(); }
        else setMsg({ kind: 'error', text: r.error ?? `Login não concluído (${r.status}).` });
      } catch (e) { if (!stop) { setLogin(null); setMsg({ kind: 'error', text: errMsg(e) }); } }
    };
    const t = window.setTimeout(poll, login.pollSeconds * 1000);
    return () => { stop = true; clearTimeout(t); };
  }, [login]); // eslint-disable-line react-hooks/exhaustive-deps
  const disconnect = async (provider: string) => {
    try { await api.del(`/api/ai/accounts/${provider}`); status.reload(); onChanged?.(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  if (!s) return <Loading error={status.error} />;
  const nous = s.accounts.find((a) => a.id === RECOMMENDED);
  const others = s.accounts.filter((a) => a.id !== RECOMMENDED);
  const otherOn = others.some((a) => a.connected);
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {s.executor === 'simulated' && <p className="hint warn">Esta instalação está em modo de simulação: as respostas dos agentes não usam IA de verdade, mesmo com uma conta conectada.</p>}
      {!s.available && <p className="hint">A conexão de contas de IA não está disponível nesta instalação (o motor de IA não está ligado).</p>}
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
            : <button className="btn btn--gold ai-best__cta" disabled={!s.available || !!login} onClick={() => start(nous.id)}>Conectar a Nous{otherOn ? ' também' : ''}</button>}
          {!nous.connected && otherOn && <p className="hint">Você já tem outra conta ligada. Conectando a Nous também, cada agente pode usar o modelo mais adequado e mais barato para o trabalho dele.</p>}
        </article>
      )}
      {others.length > 0 && (
        <div className="ai-alt">
          <span className="ai-alt__label">Outra opção</span>
          {others.map((a) => (
            <div key={a.id} className={`ai-alt__row ${a.connected ? 'ai-alt__row--on' : ''}`}>
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
                : <button className="btn btn--sm" disabled={!s.available || !!login} onClick={() => start(a.id)}>Conectar</button>}
            </div>
          ))}
        </div>
      )}
      {login && (
        <div className="device">
          <p>1. Abra <a href={login.verificationUrl ?? '#'} target="_blank" rel="noreferrer noopener">a página de login</a> e entre na sua conta.</p>
          <p>2. Confirme este código: <code className="device__code">{login.userCode}</code></p>
          <p className="muted small">Esperando a confirmação…{login.expiresAt ? ` (vale até ${new Date(login.expiresAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })})` : ''}</p>
          <button className="btn btn--sm btn--ghost" onClick={async () => { await api.del(`/api/ai/logins/${login.sessionId}`).catch(() => {}); setLogin(null); }}>Cancelar</button>
        </div>
      )}
      {(!pitch || s.accounts.some((a) => a.connected)) && <p className="hint">{BILLING[s.default.billing]}</p>}
    </>
  );
}

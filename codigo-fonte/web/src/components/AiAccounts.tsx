import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AiStatus } from '../lib/types.ts';
import { ErgonLogo, Loading } from '../brand/Brand.tsx';
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
/** Enquanto a IA da conta acorda, os cartões não aparecem (nada de botão esperando): um carregamento com uma frase
 *  só, sorteada destas; quando ela responde, os cartões chegam prontos para conectar. */
export const ACORDANDO_IA = [
  'Acendendo a chama do templo da sabedoria…',
  'Aristóteles está reunindo a equipe na ágora…',
  'Tentando tirar Sócrates de um diálogo interminável na feira de Atenas…',
  'Hipátia afina os instrumentos do observatório…',
  'Abrindo as portas da biblioteca de Alexandria…',
  'Arquimedes confere as alavancas uma última vez…',
  'Heródoto termina de anotar a viagem…',
  'Fídias tira o pó das estátuas da ágora…',
];
/** depois disso sem resposta, o carregamento diz que está demorando (e continua conferindo) */
const PACIENCIA_MS = 5 * 60_000;
export const sortear = (lista: string[]) => lista[Math.floor(Math.random() * lista.length)];

/** A IA da conta ainda acordando: logo e uma frase (sem botões); avisa só se passar muito do normal. */
export function AcordandoIa({ desde, erro, onRetry }: { desde: number; erro?: string | null; onRetry: () => void }) {
  const [frase] = useState(() => sortear(ACORDANDO_IA));
  const demorando = Date.now() - desde > PACIENCIA_MS;
  return (
    <div className="ai-acordando" role="status">
      <ErgonLogo height={44} animated />
      <Typewriter phrases={[frase]} />
      {demorando && <p className="muted small">Está levando mais que o normal{erro ? ` (${erro})` : ''}. Continuamos tentando. <button className="link" onClick={onRetry}>Tentar de novo</button></p>}
    </div>
  );
}

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
  if (!s.available && s.motor) return <AcordandoIa desde={desde.current} erro={s.motor.error} onRetry={() => { desde.current = Date.now(); status.reload(); }} />;
  const nous = s.accounts.find((a) => a.id === RECOMMENDED);
  const others = s.accounts.filter((a) => a.id !== RECOMMENDED);
  const otherOn = others.some((a) => a.connected) || (s.byok ?? []).some((b) => b.connected);
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
      {!s.available && <p className="hint">A conexão de contas de IA não está disponível nesta instalação.</p>}
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
      {!pitch && s.available && <ChavePropria byok={s.byok ?? []} custom={s.byokCustom ?? []} onDone={(m) => conectado(null, m)} onRemoved={() => { status.reload(); onChanged?.(); }} />}
      {(!pitch || s.accounts.some((a) => a.connected)) && <p className="hint">{BILLING[s.default.billing]}</p>}
    </>
  );
}


type Escolha = { tipo: 'chave'; id: string } | { tipo: 'outro' | 'lmstudio' | 'ollama' };
const LOCAIS = {
  lmstudio: { nome: 'LM Studio', porta: 1234, dica: 'No LM Studio, ligue o servidor e a opção "Serve on Local Network".' },
  ollama: { nome: 'Ollama', porta: 11434, dica: 'No Ollama, deixe o servidor aceitar conexões da rede (OLLAMA_HOST=0.0.0.0).' },
} as const;

/**
 * Chave própria (BYOK): a lista é a dos provedores que o motor de IA já suporta (com busca), mais "Outro (compatível
 * com OpenAI)" e os modelos locais (LM Studio, Ollama). A chave vai direto para o motor, que confere no provedor antes
 * de gravar; aqui ela nunca volta a aparecer.
 */
function ChavePropria({ byok, custom, onDone, onRemoved }: {
  byok: NonNullable<AiStatus['byok']>; custom: NonNullable<AiStatus['byokCustom']>;
  onDone: (starterModel: string | null) => void; onRemoved: () => void;
}) {
  const [busca, setBusca] = useState('');
  const [escolha, setEscolha] = useState<Escolha | null>(null);
  const [chave, setChave] = useState('');
  const [url, setUrl] = useState('');
  const [nome, setNome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ligados = byok.filter((b) => b.connected);
  const q = busca.trim().toLowerCase();
  const opcoes = byok.filter((b) => !b.connected && (!q || b.name.toLowerCase().includes(q) || b.id.includes(q)));
  const escolher = (e: Escolha | null) => {
    setEscolha(e); setChave(''); setErr(null); setNome('');
    setUrl(e && e.tipo !== 'chave' && e.tipo !== 'outro' ? `http://192.168.0.10:${LOCAIS[e.tipo].porta}/v1` : '');
  };
  const prov = escolha?.tipo === 'chave' ? byok.find((b) => b.id === escolha.id) : null;
  const salvar = async () => {
    if (!escolha) return;
    setBusy(true); setErr(null);
    try {
      const r = escolha.tipo === 'chave'
        ? await api.put<{ starterModel: string | null }>(`/api/ai/byok/${escolha.id}`, { key: chave })
        : await api.post<{ starterModel: string | null }>('/api/ai/byok-custom', { kind: escolha.tipo, baseUrl: url.trim(), ...(nome.trim() ? { name: nome.trim() } : {}), ...(chave.trim() ? { key: chave.trim() } : {}) });
      escolher(null); setBusca(''); onDone(r.starterModel);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const remover = async (caminho: string) => {
    setBusy(true); setErr(null);
    try { await api.del(caminho); onRemoved(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const pronto = escolha?.tipo === 'chave' ? chave.trim().length >= 8 : url.trim().startsWith('http');
  const conectados = [
    ...ligados.map((b) => ({ k: b.id, nome: b.name, det: 'chave de API', del: `/api/ai/byok/${b.id}` })),
    ...custom.map((c) => ({ k: c.id, nome: c.name, det: `${c.baseUrl}${c.model ? ` · ${c.model}` : ''}`, del: `/api/ai/byok-custom/${c.id}` })),
  ];
  return (
    <div className="ai-alt ai-byok">
      <span className="ai-alt__label">Chave própria (BYOK)</span>
      <p className="muted small">Já usa outro provedor? Conecte a sua chave de API (o custo é por uso, na sua conta do provedor), um serviço compatível com a OpenAI ou um modelo rodando na sua rede (LM Studio, Ollama).</p>
      {conectados.map((x) => (
        <div key={x.k} className="ai-alt__row ai-alt__row--on">
          <div className="ai-alt__main">
            <BrandLogo kind={x.k} name={x.nome} size={26} />
            <div className="ai-alt__txt"><b>{x.nome}</b><small>{x.det}</small></div>
            <span className="badge badge--ok">conectada</span>
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void remover(x.del)}>Desconectar</button>
          </div>
        </div>
      ))}
      {!escolha ? (
        <div className="ai-byok__pick">
          <input className="input" type="search" placeholder={`Buscar entre ${byok.length} provedores…`} value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar provedor" />
          <ul className="ai-byok__list" aria-label="Provedores">
            {opcoes.slice(0, 60).map((b) => (
              <li key={b.id}><button className="ai-byok__opt" onClick={() => escolher({ tipo: 'chave', id: b.id })}><BrandLogo kind={b.id} name={b.name} size={22} /> {b.name}</button></li>
            ))}
            {!opcoes.length && <li className="muted small">Nenhum provedor com esse nome. Se ele for compatível com a OpenAI, use "Outro".</li>}
          </ul>
          <div className="ai-byok__extras">
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'outro' })}>Outro (compatível com OpenAI)</button>
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'lmstudio' })}>Modelo local: LM Studio</button>
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'ollama' })}>Modelo local: Ollama</button>
          </div>
        </div>
      ) : (
        <form className="device ai-byok__form" onSubmit={(e) => { e.preventDefault(); void salvar(); }}>
          {escolha.tipo === 'chave' ? (
            <>
              <label htmlFor="byok-chave">Chave de API — {prov?.name}{prov?.url && <> <a href={prov.url} target="_blank" rel="noreferrer noopener">(criar uma)</a></>}</label>
              <input id="byok-chave" className="input" type="password" autoComplete="off" spellCheck={false} value={chave} autoFocus onChange={(e) => setChave(e.target.value)} />
            </>
          ) : (
            <>
              {escolha.tipo === 'outro' && (
                <>
                  <label htmlFor="byok-nome">Nome (como vai aparecer na lista de modelos)</label>
                  <input id="byok-nome" className="input" maxLength={40} placeholder="Ex.: Meu provedor" value={nome} autoFocus onChange={(e) => setNome(e.target.value)} />
                </>
              )}
              <label htmlFor="byok-url">{escolha.tipo === 'outro' ? 'Endereço da API (https; na maioria termina em /v1)' : `Endereço do ${LOCAIS[escolha.tipo].nome} na sua rede`}</label>
              <input id="byok-url" className="input" type="url" spellCheck={false} placeholder={escolha.tipo === 'outro' ? 'https://api.exemplo.com/v1' : ''} value={url} autoFocus={escolha.tipo !== 'outro'} onChange={(e) => setUrl(e.target.value)} />
              {escolha.tipo !== 'outro' && <p className="muted small">Use o endereço do computador onde o modelo roda, na rede local (ex.: 192.168.0.10). {LOCAIS[escolha.tipo].dica}</p>}
              <label htmlFor="byok-chave">Chave de API (se o serviço pedir)</label>
              <input id="byok-chave" className="input" type="password" autoComplete="off" spellCheck={false} value={chave} onChange={(e) => setChave(e.target.value)} />
            </>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row">
            <button className="btn btn--sm btn--primary" disabled={busy || !pronto}>{busy ? 'Conferindo…' : 'Conectar'}</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => escolher(null)}>Cancelar</button>
          </div>
          <p className="muted small">{escolha.tipo === 'chave'
            ? 'A chave é conferida no provedor e guardada no motor de IA desta conta, cifrada. Ela não aparece de novo aqui.'
            : 'O endereço é conferido antes de gravar, e os modelos que ele oferece passam a aparecer na escolha de modelos.'}</p>
        </form>
      )}
      {err && !escolha && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

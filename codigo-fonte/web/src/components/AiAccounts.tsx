import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { emitLocal, useResource } from '../lib/live.ts';
import type { AiStatus } from '../lib/types.ts';
import { ErgonLogo, Loading } from '../brand/Brand.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import { Icon } from './Icon.tsx';
import { Typewriter } from './Typewriter.tsx';
import { FRASE_RENOVANDO, semJargao } from '../lib/textos-tela.ts';
import { fmtHora, tn, useIdioma, useT, type Chave } from '../i18n/index.ts';

interface Login { provider: string; sessionId: string; userCode: string | null; verificationUrl: string | null; expiresAt: string | null; pollSeconds: number }
const BILLING = {
  subscription: 'configuracoes.contas.billingAssinatura',
  credits: 'configuracoes.contas.billingCreditos',
  api: 'configuracoes.contas.billingApi',
  none: 'configuracoes.contas.billingNenhuma',
} as const satisfies Record<string, Chave>;
/** A Nous aparece primeiro entre as contas de IA (a melhor escolha é o Ergon AI, no cartão do Ergon World). */
const RECOMMENDED = 'nous';
/** Enquanto a IA da conta acorda, os cartões não aparecem (nada de botão esperando): um carregamento com uma frase
 *  só, sorteada destas; quando ela responde, os cartões chegam prontos para conectar. */
const ACORDANDO_IA = [
  'configuracoes.contas.acordando1',
  'configuracoes.contas.acordando2',
  'configuracoes.contas.acordando3',
  'configuracoes.contas.acordando4',
  'configuracoes.contas.acordando5',
  'configuracoes.contas.acordando6',
  'configuracoes.contas.acordando7',
  'configuracoes.contas.acordando8',
] as const satisfies readonly Chave[];
/** depois disso sem resposta, o carregamento diz que está demorando (e continua conferindo) */
const PACIENCIA_MS = 5 * 60_000;
export const sortear = <T,>(lista: readonly T[]): T => lista[Math.floor(Math.random() * lista.length)];

/**
 * A IA da conta ainda acordando: logo e uma frase (sem botões); avisa só se passar muito do normal. renovando: a equipe está
 * sendo atualizada para a versão nova (a frase diz isso, em vez de uma sorteada). O motivo da demora só aparece se for dito
 * para a pessoa: com peça interna (motor, gerente, endereço…), fica no registro.
 */
export function AcordandoIa({ desde, erro, onRetry, renovando }: { desde: number; erro?: string | null; onRetry: () => void; renovando?: boolean }) {
  const t = useT();
  const [frase] = useState(() => sortear(ACORDANDO_IA));
  const demorando = Date.now() - desde > PACIENCIA_MS;
  const motivo = semJargao(erro);
  return (
    <div className="ai-acordando" role="status">
      <ErgonLogo height={44} animated />
      <Typewriter key={renovando ? 'renovando' : 'acordando'} phrases={[renovando ? FRASE_RENOVANDO : t(frase)]} />
      {demorando && <p className="muted small">{motivo ? t('configuracoes.contas.demorandoMotivo', { motivo }) : t('configuracoes.contas.demorando')} <button className="link" onClick={onRetry}>{t('configuracoes.contas.tentarDeNovo')}</button></p>}
    </div>
  );
}

/**
 * Contas de IA (a conta que paga os modelos dos agentes): login por código, no navegador da pessoa. A Nous e o ChatGPT
 * são opções comuns, sem destaque (a melhor escolha é o Ergon AI, no cartão do Ergon World); a chave própria (BYOK) só
 * fora das boas-vindas. O mesmo componente nas boas-vindas, em Conexões e em Configurações.
 */
export function AiAccounts({ onChanged, pitch }: { onChanged?: () => void; pitch?: boolean }) {
  const t = useT();
  const status = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const [login, setLogin] = useState<Login | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const desde = useRef(Date.now());
  const s = status.data;

  const start = async (provider: string) => {
    setMsg(null);
    try { setLogin(await api.post<Login>(`/api/ai/accounts/${provider}/login`)); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const conectado = (quem: string | null | undefined, modelo: string | null | undefined) => {
    const frases = [
      quem ? t('configuracoes.contas.conectadaDe', { quem }) : t('configuracoes.contas.conectada'),
      pitch ? t('configuracoes.contas.prontaParaTrabalhar') : t('configuracoes.contas.modelosAparecem'),
      ...(modelo ? [t('configuracoes.contas.modeloInicial', { modelo })] : []),
    ];
    setMsg({ kind: 'ok', text: frases.join(' ') });
    status.reload(); emitLocal('ai.changed'); onChanged?.();
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
        else setMsg({ kind: 'error', text: r.error ?? t('configuracoes.contas.loginNaoConcluido', { status: r.status }) });
      } catch (e) { if (!stop) { setLogin(null); setMsg({ kind: 'error', text: errMsg(e) }); } }
    };
    const timer = window.setTimeout(poll, login.pollSeconds * 1000);
    return () => { stop = true; clearTimeout(timer); };
  }, [login]); // eslint-disable-line react-hooks/exhaustive-deps
  // motor da pessoa ainda ligando (conta nova: até alguns minutos; um erro de tempo na primeira vez também passa):
  // confere a cada 3 s até responder; os botões se liberam sozinhos
  useEffect(() => {
    if (!s || s.available || !s.motor) return;
    const timer = window.setTimeout(() => status.reload(), 3000);
    return () => clearTimeout(timer);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const disconnect = async (provider: string) => {
    try { await api.del(`/api/ai/accounts/${provider}`); status.reload(); emitLocal('ai.changed'); onChanged?.(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  if (!s) return <Loading error={status.error} />;
  if (!s.available && s.motor) return <AcordandoIa desde={desde.current} erro={s.motor.error} renovando={s.motor.state === 'renovando'} onRetry={() => { desde.current = Date.now(); status.reload(); }} />;
  const nous = s.accounts.find((a) => a.id === RECOMMENDED);
  const others = s.accounts.filter((a) => a.id !== RECOMMENDED);
  const otherOn = others.some((a) => a.connected) || (s.byok ?? []).some((b) => b.connected);
  const billing = (BILLING as Partial<Record<string, (typeof BILLING)[keyof typeof BILLING]>>)[s.default.billing];
  const codigo = (provider: string) => login?.provider === provider && (
    <div className="device" role="status">
      <p>{tn('configuracoes.contas.passo1', { pagina: <a href={login.verificationUrl ?? '#'} target="_blank" rel="noreferrer noopener">{t('configuracoes.contas.paginaDeLogin')}</a> })}</p>
      <p>{tn('configuracoes.contas.passo2', { codigo: <code className="device__code">{login.userCode}</code> })}</p>
      <p className="muted small">{login.expiresAt ? t('configuracoes.contas.esperandoAte', { hora: fmtHora(login.expiresAt) }) : t('configuracoes.contas.esperando')}</p>
      <button className="btn btn--sm btn--ghost" onClick={async () => { await api.del(`/api/ai/logins/${login.sessionId}`).catch(() => {}); setLogin(null); }}>{t('configuracoes.comum.cancelar')}</button>
    </div>
  );
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {s.executor === 'simulated' && <p className="hint warn">{t('configuracoes.contas.instalacaoSemContas')}</p>}
      {!s.available && <p className="hint">{t('configuracoes.contas.indisponivel')}</p>}
      {nous && (
        <article className={`ai-best ai-best--calmo ${nous.connected ? 'ai-best--on' : ''}`} aria-label={t('configuracoes.contas.nousAria')}>
          <header className="ai-best__head">
            <BrandLogo kind={nous.id} name={nous.name} size={44} />
            <div>
              <h4>{t('configuracoes.contas.assinatura', { nome: nous.name })}</h4>
              <p>{t('configuracoes.contas.nousExperiencia')}</p>
            </div>
            {nous.connected && <span className="badge badge--ok">{t('configuracoes.comum.conectada')}</span>}
          </header>
          {nous.connected
            ? <div className="row"><span className="ok-inline"><Icon name="check" size={14} /> {t('configuracoes.contas.nousConectada')}</span><span className="grow" /><button className="btn btn--sm btn--ghost" onClick={() => disconnect(nous.id)}>{t('configuracoes.comum.desconectar')}</button></div>
            : login?.provider !== nous.id && <button className="btn ai-best__cta" disabled={!s.available || !!login} onClick={() => start(nous.id)}>{otherOn ? t('configuracoes.contas.conectarNousTambem') : t('configuracoes.contas.conectarNous')}</button>}
          {codigo(nous.id)}
          {!nous.connected && otherOn && <p className="hint">{t('configuracoes.contas.nousOutraLigada')}</p>}
        </article>
      )}
      {others.length > 0 && (
        <div className="ai-alt">
          <span className="ai-alt__label">{t('configuracoes.contas.outraOpcao')}</span>
          {others.map((a) => (
            <div key={a.id} className={`ai-alt__row ${a.connected ? 'ai-alt__row--on' : ''} ${login?.provider === a.id ? 'ai-alt__row--open' : ''}`}>
              <div className="ai-alt__main">
                <BrandLogo kind={a.id} name={a.name} size={26} />
                <div className="ai-alt__txt">
                  <b>{a.name}</b>
                  <small>{a.id === 'openai-codex' ? t('configuracoes.contas.chatgpt') : a.about}</small>
                </div>
                <span className={`badge ${a.connected ? 'badge--ok' : ''}`}>{a.connected ? t('configuracoes.comum.conectada') : a.detail}</span>
                {a.connected
                  ? <button className="btn btn--sm btn--ghost" onClick={() => disconnect(a.id)}>{t('configuracoes.comum.desconectar')}</button>
                  : login?.provider !== a.id && <button className="btn btn--sm" disabled={!s.available || !!login} onClick={() => start(a.id)}>{t('configuracoes.comum.conectar')}</button>}
              </div>
              {codigo(a.id)}
            </div>
          ))}
        </div>
      )}
      {!pitch && s.available && <ChavePropria byok={s.byok ?? []} custom={s.byokCustom ?? []} onDone={(m) => conectado(null, m)} onRemoved={() => { status.reload(); emitLocal('ai.changed'); onChanged?.(); }} />}
      {(!pitch || s.accounts.some((a) => a.connected)) && billing && <p className="hint">{t(billing)}</p>}
    </>
  );
}


type Escolha = { tipo: 'chave'; id: string } | { tipo: 'outro' | 'lmstudio' | 'ollama' };

/**
 * Os provedores de IA da China que a equipe de IA já suporta (rc.44), na ordem do cartão. Na China só valem modelos
 * registrados lá (Anthropic, OpenAI e Google ficam de fora): o Ergon local com um destes. O id é o do catálogo do motor;
 * o que ele não oferecer (versão antiga) simplesmente não aparece. Qwen: uma chave do DashScope serve aos dois endereços
 * (o motor lista só "alibaba"; "alibaba-cn" fica aqui para quando listar). GLM: o motor acha bigmodel.cn ou z.ai pela chave.
 */
const DA_CHINA: ReadonlyArray<{ id: string; nome: string; regiao: 'cn' | 'intl' | 'auto'; dica?: 'configuracoes.byok.china.qwenDica' | 'configuracoes.byok.china.glmDica' }> = [
  { id: 'deepseek', nome: 'DeepSeek', regiao: 'auto' }, // i18n-ok: nomes de marca, iguais em todas as línguas
  { id: 'alibaba', nome: 'Qwen · DashScope', regiao: 'auto', dica: 'configuracoes.byok.china.qwenDica' }, // i18n-ok: marca
  { id: 'alibaba-cn', nome: 'Qwen · DashScope', regiao: 'cn' }, // i18n-ok: marca
  { id: 'kimi-coding-cn', nome: 'Kimi · Moonshot', regiao: 'cn' }, // i18n-ok: marca
  { id: 'kimi-coding', nome: 'Kimi · Moonshot', regiao: 'intl' }, // i18n-ok: marca
  { id: 'zai', nome: 'GLM · Zhipu', regiao: 'auto', dica: 'configuracoes.byok.china.glmDica' }, // i18n-ok: marca
  { id: 'minimax-cn', nome: 'MiniMax', regiao: 'cn' }, // i18n-ok: marca
  { id: 'minimax', nome: 'MiniMax', regiao: 'intl' }, // i18n-ok: marca
  { id: 'stepfun', nome: 'StepFun', regiao: 'cn' }, // i18n-ok: marca
  { id: 'tencent-tokenhub', nome: 'Tencent TokenHub', regiao: 'cn' }, // i18n-ok: marca
  { id: 'xiaomi', nome: 'Xiaomi MiMo', regiao: 'cn' }, // i18n-ok: marca
];
const ID_DA_CHINA = new Set(DA_CHINA.map((c) => c.id));
const REGIAO = { cn: 'configuracoes.byok.china.regiaoCn', intl: 'configuracoes.byok.china.regiaoIntl', auto: 'configuracoes.byok.china.regiaoAuto' } as const satisfies Record<string, Chave>;
const LOCAIS = {
  lmstudio: { nome: 'LM Studio', porta: 1234, dica: 'configuracoes.byok.dicaLmstudio' }, // i18n-ok: nome do produto, igual nas duas línguas
  ollama: { nome: 'Ollama', porta: 11434, dica: 'configuracoes.byok.dicaOllama' }, // i18n-ok: nome do produto, igual nas duas línguas
} as const satisfies Record<string, { nome: string; porta: number; dica: Chave }>;

/**
 * Chave própria (BYOK): a lista é a dos provedores que o motor de IA já suporta (com busca), mais "Outro (compatível
 * com OpenAI)" e os modelos locais (LM Studio, Ollama). A chave vai direto para o motor, que confere no provedor antes
 * de gravar; aqui ela nunca volta a aparecer.
 */
function ChavePropria({ byok, custom, onDone, onRemoved }: {
  byok: NonNullable<AiStatus['byok']>; custom: NonNullable<AiStatus['byokCustom']>;
  onDone: (starterModel: string | null) => void; onRemoved: () => void;
}) {
  const t = useT();
  const idioma = useIdioma();
  const [busca, setBusca] = useState('');
  const [escolha, setEscolha] = useState<Escolha | null>(null);
  const [chave, setChave] = useState('');
  const [url, setUrl] = useState('');
  const [nome, setNome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ligados = byok.filter((b) => b.connected);
  const q = busca.trim().toLowerCase();
  // sem busca, os da China ficam no grupo deles (abaixo, ou no alto em chinês); com busca, aparecem na lista como os outros
  const opcoes = byok.filter((b) => !b.connected && (q ? b.name.toLowerCase().includes(q) || b.id.includes(q) : !ID_DA_CHINA.has(b.id)));
  const chineses = DA_CHINA.flatMap((c) => { const b = byok.find((x) => x.id === c.id && !x.connected); return b ? [{ ...c, b }] : []; });
  const daChina = DA_CHINA.find((c) => c.id === (escolha?.tipo === 'chave' ? escolha.id : ''));
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
    ...ligados.map((b) => ({ k: b.id, nome: b.name, det: t('configuracoes.byok.chaveDeApi'), del: `/api/ai/byok/${b.id}` })),
    ...custom.map((c) => ({ k: c.id, nome: c.name, det: `${c.baseUrl}${c.model ? ` · ${c.model}` : ''}`, del: `/api/ai/byok-custom/${c.id}` })),
  ];
  return (
    <div className="ai-alt ai-byok">
      <span className="ai-alt__label">{t('configuracoes.byok.rotulo')}</span>
      <p className="muted small">{t('configuracoes.byok.texto')}</p>
      {conectados.map((x) => (
        <div key={x.k} className="ai-alt__row ai-alt__row--on">
          <div className="ai-alt__main">
            <BrandLogo kind={x.k} name={x.nome} size={26} />
            <div className="ai-alt__txt"><b>{x.nome}</b><small>{x.det}</small></div>
            <span className="badge badge--ok">{t('configuracoes.comum.conectada')}</span>
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void remover(x.del)}>{t('configuracoes.comum.desconectar')}</button>
          </div>
        </div>
      ))}
      {!escolha && idioma === 'zh-CN' && <ModelosDaChina itens={chineses} escolher={(id) => escolher({ tipo: 'chave', id })} />}
      {!escolha ? (
        <div className="ai-byok__pick">
          <input className="input" type="search" placeholder={t('configuracoes.byok.buscar', { n: byok.length })} value={busca} onChange={(e) => setBusca(e.target.value)} aria-label={t('configuracoes.byok.buscarAria')} />
          <ul className="ai-byok__list" aria-label={t('configuracoes.byok.provedores')}>
            {opcoes.slice(0, 60).map((b) => (
              <li key={b.id}><button className="ai-byok__opt" onClick={() => escolher({ tipo: 'chave', id: b.id })}><BrandLogo kind={b.id} name={b.name} size={22} /> {b.name}</button></li>
            ))}
            {!opcoes.length && <li className="muted small">{t('configuracoes.byok.nenhum')}</li>}
          </ul>
          {!q && idioma !== 'zh-CN' && <ModelosDaChina itens={chineses} escolher={(id) => escolher({ tipo: 'chave', id })} />}
          <div className="ai-byok__extras">
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'outro' })}>{t('configuracoes.byok.outro')}</button>
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'lmstudio' })}>{t('configuracoes.byok.modeloLocal', { nome: LOCAIS.lmstudio.nome })}</button>
            <button className="btn btn--sm" onClick={() => escolher({ tipo: 'ollama' })}>{t('configuracoes.byok.modeloLocal', { nome: LOCAIS.ollama.nome })}</button>
          </div>
        </div>
      ) : (
        <form className="device ai-byok__form" onSubmit={(e) => { e.preventDefault(); void salvar(); }}>
          {escolha.tipo === 'chave' ? (
            <>
              <label htmlFor="byok-chave">{t('configuracoes.byok.chaveDe', { nome: prov?.name ?? '' })}{prov?.url && <> <a href={prov.url} target="_blank" rel="noreferrer noopener">{t('configuracoes.byok.criarUma')}</a></>}</label>
              <input id="byok-chave" className="input" type="password" autoComplete="off" spellCheck={false} value={chave} autoFocus onChange={(e) => setChave(e.target.value)} />
              {daChina?.dica && <p className="muted small">{t(daChina.dica)}</p>}
              {daChina && <p className="hint ai-byok__seguro"><Icon name="lock" size={13} /> {t('configuracoes.byok.china.seguro')}</p>}
            </>
          ) : (
            <>
              {escolha.tipo === 'outro' && (
                <>
                  <label htmlFor="byok-nome">{t('configuracoes.byok.nome')}</label>
                  <input id="byok-nome" className="input" maxLength={40} placeholder={t('configuracoes.byok.nomeExemplo')} value={nome} autoFocus onChange={(e) => setNome(e.target.value)} />
                </>
              )}
              <label htmlFor="byok-url">{escolha.tipo === 'outro' ? t('configuracoes.byok.enderecoApi') : t('configuracoes.byok.enderecoLocal', { nome: LOCAIS[escolha.tipo].nome })}</label>
              <input id="byok-url" className="input" type="url" spellCheck={false} placeholder={escolha.tipo === 'outro' ? t('configuracoes.byok.enderecoExemplo') : ''} value={url} autoFocus={escolha.tipo !== 'outro'} onChange={(e) => setUrl(e.target.value)} />
              {escolha.tipo !== 'outro' && <p className="muted small">{t('configuracoes.byok.localDica')} {t(LOCAIS[escolha.tipo].dica)}</p>}
              <label htmlFor="byok-chave">{t('configuracoes.byok.chaveSePedir')}</label>
              <input id="byok-chave" className="input" type="password" autoComplete="off" spellCheck={false} value={chave} onChange={(e) => setChave(e.target.value)} />
            </>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row">
            <button className="btn btn--sm btn--primary" disabled={busy || !pronto}>{busy ? t('configuracoes.comum.conferindo') : t('configuracoes.comum.conectar')}</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => escolher(null)}>{t('configuracoes.comum.cancelar')}</button>
          </div>
          <p className="muted small">{escolha.tipo === 'chave' ? t('configuracoes.byok.notaChave') : t('configuracoes.byok.notaEndereco')}</p>
        </form>
      )}
      {err && !escolha && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/**
 * O grupo "Modelos da China" (rc.44): os provedores chineses que o motor oferece, cada um com a região do endereço.
 * Escolher um abre o mesmo cartão seguro da chave (campo de senha, conferida no provedor, nunca pela conversa).
 */
function ModelosDaChina({ itens, escolher }: { itens: ReadonlyArray<(typeof DA_CHINA)[number] & { b: { id: string; name: string } }>; escolher: (id: string) => void }) {
  const t = useT();
  return (
    <section className="ai-china" aria-labelledby="ai-china-titulo">
      <h5 id="ai-china-titulo" className="ai-alt__label">{t('configuracoes.byok.china.rotulo')}</h5>
      <p className="muted small">{t('configuracoes.byok.china.texto')}</p>
      {itens.length ? (
        <ul className="ai-china__lista">
          {itens.map((c) => (
            <li key={c.id}>
              <button type="button" className="ai-byok__opt ai-china__opt" onClick={() => escolher(c.id)}>
                <BrandLogo kind={c.id} name={c.nome} size={22} />
                <span className="ai-china__nome">{c.nome}</span>
                <span className="badge ai-china__regiao">{t(REGIAO[c.regiao])}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t('configuracoes.byok.china.indisponivel')}</p>}
      <p className="hint ai-byok__seguro"><Icon name="lock" size={13} /> {t('configuracoes.byok.china.seguro')}</p>
    </section>
  );
}

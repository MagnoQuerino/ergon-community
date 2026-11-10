import { useEffect, useRef, useState } from 'react';
import { t, tn, useT, type Chave } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import type { AiStatus, OnboardingOptions, OnboardingResult } from '../lib/types.ts';
import { ErgonLogo, Loading, PhraseLoader } from '../brand/Brand.tsx';
import { AcordandoIa, AiAccounts, sortear } from './AiAccounts.tsx';
import { Icon } from './Icon.tsx';

/**
 * Boas-vindas: depois de criar a conta (senha hoje; login com Google ou Microsoft depois, pelo mesmo caminho), três
 * perguntas rápidas definem em silêncio a equipe de partida — setores e funções para o jeito de trabalhar da
 * pessoa — e a conta de IA é conectada ali mesmo (Nous recomendada; ChatGPT aproveita a assinatura). Tudo continua
 * editável: a tela final convida a personalizar (conversando com a coordenação).
 */

/** as etapas do primeiro uso (as chaves do dicionário; o texto sai na hora de mostrar) */
const SETUP_STEPS = ['ajuda.etapas.conta', 'ajuda.etapas.frase', 'ajuda.etapas.sobre', 'ajuda.etapas.ia', 'ajuda.etapas.equipe'] as const satisfies readonly Chave[];

/** Trilha do primeiro uso (criar a conta → frase → perguntas → equipe). */
export function SetupSteps({ at }: { at: number }) {
  const t = useT();
  return (
    <ol className="setup-steps" aria-label={t('ajuda.etapas.aria')}>
      {SETUP_STEPS.map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-on' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="setup-steps__n">{i < at ? <Icon name="check" size={12} /> : i + 1}</span><span className="setup-steps__t">{t(s)}</span>
        </li>
      ))}
    </ol>
  );
}

const USE_ICON: Record<string, string> = {
  empresario: 'briefcase', publicitario: 'megaphone', escritor: 'pen', projetos: 'layers', pesquisador: 'flask',
  dev: 'code', freelancer: 'coins', pessoal: 'home', outro: 'plus',
};

/** as frases enquanto a equipe é montada (chaves; uma sorteada por visita) */
const BUILDING = [
  'ajuda.montando.pergaminhos', 'ajuda.montando.oficios', 'ajuda.montando.conselho', 'ajuda.montando.lira',
  'ajuda.montando.oraculo', 'ajuda.montando.colunas', 'ajuda.montando.vocabulario', 'ajuda.montando.lamparinas',
] as const satisfies readonly Chave[];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = 'use' | 'niche' | 'more' | 'ia' | 'building' | 'ready';
const STEP_AT: Record<Step, number> = { use: 2, niche: 2, more: 2, ia: 3, building: 4, ready: 4 };

export function Onboarding({ displayName, workspaceName, redo, onFinish, onCancel }: {
  displayName: string;
  /** nome já dado ao workspace (criado pelo seletor): vem preenchido no nome da empresa/casa, editável */
  workspaceName?: string;
  /** refazer pela Ajuda: troca funções e setores; não volta às tarefas de demonstração */
  redo?: boolean;
  onFinish: (r: { tour: boolean; result: OnboardingResult | null; goal: string }) => void;
  onCancel?: () => void;
}) {
  useT();
  const [opts, setOpts] = useState<OnboardingOptions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('use');
  // i18n-ok: 'Ergon Local' é o nome padrão que o servidor dá ao workspace (comparação, não aparece na tela)
  const [f, setF] = useState({ use: '', niche: '', nicheOther: '', company: workspaceName && workspaceName !== 'Ergon Local' ? workspaceName : '', goal: '' });
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const loadAi = () => { api.get<AiStatus>('/api/ai/status').then(setAi).catch(() => setAi(null)); };
  useEffect(() => { api.get<OnboardingOptions>('/api/onboarding').then(setOpts).catch((e) => setErr(errMsg(e))); loadAi(); }, []);
  const aiConnected = !!ai?.accounts.some((a) => a.connected);
  // O fluxo: conta → palavras → (carregamento, só se preciso) → perguntas → conectar a IA → interface. O motor de IA
  // da pessoa nasce com a conta e aquece enquanto ela anota as palavras; se ainda não estiver pronto quando as
  // boas-vindas abrem, um carregamento esconde a espera ANTES das perguntas, para a conexão ter os botões prontos.
  // Uma vez pronto, segue pronto (o carregamento não volta no meio das perguntas).
  const [aiPronta, setAiPronta] = useState(!!redo);
  useEffect(() => { if (ai && (ai.available || !ai.motor)) setAiPronta(true); }, [ai]);
  const aiAcordando = !aiPronta;
  const acordandoDesde = useRef(Date.now());
  // conectou a conta na etapa da IA: monta a equipe e entra. Conectar continua sendo escolha: "Conectar depois" segue.
  useEffect(() => { if (step === 'ia' && aiConnected) void build(); }, [step, aiConnected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!aiAcordando) return;
    const t = window.setTimeout(loadAi, 3000);
    return () => clearTimeout(t);
  }, [aiAcordando, ai]); // eslint-disable-line react-hooks/exhaustive-deps
  // uma frase por etapa, sorteada (nada de frases em roda); guarda a chave: a troca de idioma traduz a mesma frase
  const [fraseEquipe] = useState(() => sortear([...BUILDING]) as (typeof BUILDING)[number]);
  // Esc só ao refazer (no primeiro acesso, as perguntas valem a pena) e nunca no meio da montagem da equipe
  const root = useRef<HTMLDivElement>(null);
  useSurface(root, { onClose: () => onCancel?.(), modal: true, escape: !!redo && step !== 'building', autoFocus: false });

  const build = async () => {
    setErr(null); setStep('building');
    try {
      const body = { use: f.use, niche: f.niche, ...(f.niche === 'outro' && f.nicheOther.trim() ? { nicheOther: f.nicheOther.trim() } : {}),
        ...(f.company.trim() ? { company: f.company.trim() } : {}), ...(f.goal.trim() ? { goal: f.goal.trim() } : {}), aiConnected };
      // um instante de espera mesmo quando é rápido: dá tempo de ler que algo foi feito sob medida
      const [r] = await Promise.all([api.post<OnboardingResult>('/api/onboarding', body), wait(3200)]);
      setResult(r); setStep('ready');
    } catch (e) { setErr(errMsg(e)); setStep(redo && aiConnected ? 'more' : 'ia'); }
  };
  const skip = async () => {
    setErr(null);
    try { await api.post('/api/onboarding/skip'); onFinish({ tour: false, result: null, goal: '' }); } catch (e) { setErr(errMsg(e)); }
  };

  const pickUse = (use: string) => {
    setF((x) => ({ ...x, use, niche: use === 'pessoal' ? 'pessoal' : x.niche === 'pessoal' ? '' : x.niche }));
    setStep('niche');
  };
  const personal = f.use === 'pessoal';
  const bySector = result ? [...new Set(result.team.map((m) => m.sectorName))].map((name) => ({ name, members: result.team.filter((m) => m.sectorName === name) })) : [];

  return (
    <div ref={root} className="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">
      <div className={`onb__card ${step === 'ready' ? 'onb__card--wide' : ''}`}>
        <div className="onb__head">
          <ErgonLogo height={30} animated={step === 'building'} />
          {redo && step !== 'building' && step !== 'ready' && <button className="icon-btn" onClick={onCancel} aria-label={t('ajuda.onb.fechar')} title={t('ajuda.onb.fechar')}><Icon name="x" /></button>}
        </div>
        {!redo && <SetupSteps at={STEP_AT[step]} />}

        {!opts ? <Loading error={err} /> : aiAcordando ? (
          <section className="onb__building"><AcordandoIa desde={acordandoDesde.current} erro={ai?.motor?.error} renovando={ai?.motor?.state === 'renovando'} onRetry={() => { acordandoDesde.current = Date.now(); loadAi(); }} /></section>
        ) : step === 'use' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{redo ? t('ajuda.onb.refazerTitulo') : t('ajuda.onb.boasVindas', { nome: displayName })}</h2>
            <p className="muted">{redo ? t('ajuda.onb.refazerIntro') : t('ajuda.onb.intro')}</p>
            <h3 className="onb__q">{t('ajuda.onb.usoPergunta')}</h3>
            <div className="onb__grid">
              {opts.uses.map((u) => (
                <button key={u.key} className={`onb__opt ${f.use === u.key ? 'is-on' : ''}`} onClick={() => pickUse(u.key)} aria-pressed={f.use === u.key}>
                  <span className="onb__ico"><Icon name={USE_ICON[u.key] ?? 'plus'} size={20} /></span>
                  <span className="onb__opt-txt"><b>{u.label}</b><small>{u.hint}</small></span>
                </button>
              ))}
            </div>
            {err && <p className="error" role="alert">{err}</p>}
            {!redo && <button className="link onb__skip" onClick={skip}>{t('ajuda.onb.pular')}</button>}
          </section>
        ) : step === 'niche' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{personal ? t('ajuda.onb.nichoPessoal') : t('ajuda.onb.nicho')}</h2>
            <p className="muted">{personal ? t('ajuda.onb.nichoPessoalIntro') : t('ajuda.onb.nichoIntro')}</p>
            <div className="onb__chips" role="radiogroup" aria-label={t('ajuda.onb.nichoAria')}>
              {opts.niches.map((n) => (
                <button key={n.key} role="radio" aria-checked={f.niche === n.key} className={`onb__chip ${f.niche === n.key ? 'is-on' : ''}`} onClick={() => { setF({ ...f, niche: n.key }); setErr(null); }}>{n.label}</button>
              ))}
            </div>
            {f.niche === 'outro' && (
              <label className="field">{t('ajuda.onb.nichoOutro')}<input autoFocus maxLength={60} value={f.nicheOther} onChange={(e) => setF({ ...f, nicheOther: e.target.value })} placeholder={t('ajuda.onb.nichoOutroExemplo')} /></label>
            )}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('use')}>{t('ajuda.onb.voltar')}</button>
              <button className="btn btn--primary" onClick={() => { if (!f.niche) { setErr(t('ajuda.onb.nichoFalta')); return; } setErr(null); setStep('more'); }}>{t('ajuda.onb.continuar')}</button>
            </div>
          </section>
        ) : step === 'more' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{t('ajuda.onb.quaseLa')}</h2>
            <p className="muted">{t('ajuda.onb.quaseLaIntro')}</p>
            <label className="field">{personal ? t('ajuda.onb.espacoNome') : t('ajuda.onb.empresaNome')}
              <input maxLength={60} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} placeholder={personal ? t('ajuda.onb.espacoExemplo') : t('ajuda.onb.empresaExemplo')} />
            </label>
            <label className="field">{t('ajuda.onb.objetivo')}
              <textarea rows={2} maxLength={300} value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} placeholder={personal ? t('ajuda.onb.objetivoPessoalExemplo') : t('ajuda.onb.objetivoExemplo')} />
            </label>
            {redo && <p className="hint warn">{t('ajuda.onb.refazerAviso')}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('niche')}>{t('ajuda.onb.voltar')}</button>
              {redo && aiConnected
                ? <button className="btn btn--primary" onClick={build}>{t('ajuda.onb.refazerEquipe')}</button>
                : <button className="btn btn--primary" onClick={() => { setErr(null); setStep('ia'); }}>{t('ajuda.onb.continuar')}</button>}
            </div>
          </section>
        ) : step === 'ia' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{t('ajuda.onb.iaTitulo')}</h2>
            <p className="muted">{tn('ajuda.onb.iaIntro', { nous: <b>{t('ajuda.onb.iaNous')}</b> })}</p>
            <AiAccounts pitch onChanged={loadAi} />
            {!aiConnected && <p className="hint">{t('ajuda.onb.iaSemConta')}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('more')}>{t('ajuda.onb.voltar')}</button>
              {!aiConnected && <button className="btn btn--ghost" onClick={build}>{t('ajuda.onb.conectarDepois')}</button>}
            </div>
          </section>
        ) : step === 'building' ? (
          <section className="onb__building"><PhraseLoader phrases={[t(fraseEquipe)]} every={60_000} /></section>
        ) : result && (
          <section>
            <h2 id="onb-title" className="onb__title">{t('ajuda.onb.prontaTitulo')}</h2>
            <p className="onb__preset"><b>{result.preset.title}</b> · {result.preset.summary}</p>
            <div className="onb__team">
              {bySector.map((s) => (
                <div key={s.name} className="onb__sector">
                  <h4>{s.name}</h4>
                  <ul>{s.members.map((m) => <li key={m.id}><b>{m.name}</b> <span className="muted">{m.role}</span></li>)}</ul>
                </div>
              ))}
            </div>
            <div className="onb__invite">
              <Icon name="palette" size={20} />
              <p>{tn('ajuda.onb.convite', { coord: <b>{result.coordinator}</b>, nome: result.coordinator })}</p>
            </div>
            <div className="onb__nav">
              <button className="btn" onClick={() => onFinish({ tour: false, result, goal: f.goal.trim() })}>{redo ? t('ajuda.onb.fechar') : t('ajuda.onb.irDireto')}</button>
              <button className="btn btn--primary" autoFocus onClick={() => onFinish({ tour: true, result, goal: f.goal.trim() })}><Icon name="compass" size={16} /> {t('ajuda.onb.fazerTour')}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

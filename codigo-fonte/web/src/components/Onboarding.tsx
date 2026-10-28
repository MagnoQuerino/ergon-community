import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import type { AiStatus, OnboardingOptions, OnboardingResult } from '../lib/types.ts';
import { ErgonLogo, Loading, PhraseLoader } from '../brand/Brand.tsx';
import { AiAccounts } from './AiAccounts.tsx';
import { Icon } from './Icon.tsx';

/**
 * Boas-vindas: depois de criar a conta (senha hoje; login com Google ou Microsoft depois, pelo mesmo caminho), três
 * perguntas rápidas definem em silêncio a equipe de partida — setores e funções para o jeito de trabalhar da
 * pessoa — e a conta de IA é conectada ali mesmo (Nous recomendada; ChatGPT aproveita a assinatura). Tudo continua
 * editável: a tela final convida a personalizar (conversando com a coordenação).
 */

const SETUP_STEPS = ['Conta', 'Frase de recuperação', 'Sobre você', 'Conta de IA', 'Sua equipe'];

/** Trilha do primeiro uso (criar a conta → frase → perguntas → equipe). */
export function SetupSteps({ at }: { at: number }) {
  return (
    <ol className="setup-steps" aria-label="Etapas do primeiro uso">
      {SETUP_STEPS.map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-on' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="setup-steps__n">{i < at ? <Icon name="check" size={12} /> : i + 1}</span><span className="setup-steps__t">{s}</span>
        </li>
      ))}
    </ol>
  );
}

const USE_ICON: Record<string, string> = {
  empresario: 'briefcase', publicitario: 'megaphone', escritor: 'pen', projetos: 'layers', pesquisador: 'flask',
  dev: 'code', freelancer: 'coins', pessoal: 'home', outro: 'plus',
};

const BUILDING = [
  'Desenrolando os pergaminhos do seu ofício…', 'Distribuindo os ofícios pela ágora…', 'Escolhendo quem senta à mesa do conselho…',
  'Afinando a lira da coordenação…', 'Consultando o oráculo sobre a sua área…', 'Varrendo a poeira das colunas do templo…',
  'Ensinando o seu vocabulário à equipe…', 'Acendendo as lamparinas da biblioteca…',
];

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
  const [opts, setOpts] = useState<OnboardingOptions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('use');
  const [f, setF] = useState({ use: '', niche: '', nicheOther: '', company: workspaceName && workspaceName !== 'Ergon Local' ? workspaceName : '', goal: '' });
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const loadAi = () => { api.get<AiStatus>('/api/ai/status').then(setAi).catch(() => setAi(null)); };
  useEffect(() => { api.get<OnboardingOptions>('/api/onboarding').then(setOpts).catch((e) => setErr(errMsg(e))); loadAi(); }, []);
  const aiConnected = !!ai?.accounts.some((a) => a.connected);
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
          {redo && step !== 'building' && step !== 'ready' && <button className="icon-btn" onClick={onCancel} aria-label="Fechar" title="Fechar"><Icon name="x" /></button>}
        </div>
        {!redo && <SetupSteps at={STEP_AT[step]} />}

        {!opts ? <Loading error={err} /> : step === 'use' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{redo ? 'Refazer a equipe de partida' : `Boas-vindas, ${displayName}!`}</h2>
            <p className="muted">{redo ? 'Escolha de novo e a equipe recebe as funções e os setores do novo perfil.' : 'Duas perguntas rápidas e a sua equipe fica pronta, com os ofícios certos para o seu trabalho.'}</p>
            <h3 className="onb__q">Como você pretende usar o Ergon?</h3>
            <div className="onb__grid">
              {opts.uses.map((u) => (
                <button key={u.key} className={`onb__opt ${f.use === u.key ? 'is-on' : ''}`} onClick={() => pickUse(u.key)} aria-pressed={f.use === u.key}>
                  <span className="onb__ico"><Icon name={USE_ICON[u.key] ?? 'plus'} size={20} /></span>
                  <span className="onb__opt-txt"><b>{u.label}</b><small>{u.hint}</small></span>
                </button>
              ))}
            </div>
            {err && <p className="error" role="alert">{err}</p>}
            {!redo && <button className="link onb__skip" onClick={skip}>Pular e começar com a equipe geral</button>}
          </section>
        ) : step === 'niche' ? (
          <section>
            <h2 id="onb-title" className="onb__title">{personal ? 'E no dia a dia, o que mais ocupa você?' : 'Em que área você trabalha?'}</h2>
            <p className="muted">{personal ? 'Ajuda a coordenação a falar a sua língua. A equipe pessoal é a mesma para todos; o foco muda.' : 'Cada área tem uma equipe de partida com setores e funções próprios.'}</p>
            <div className="onb__chips" role="radiogroup" aria-label="Área">
              {opts.niches.map((n) => (
                <button key={n.key} role="radio" aria-checked={f.niche === n.key} className={`onb__chip ${f.niche === n.key ? 'is-on' : ''}`} onClick={() => setF({ ...f, niche: n.key })}>{n.label}</button>
              ))}
            </div>
            {f.niche === 'outro' && (
              <label className="field">Qual? (opcional)<input autoFocus maxLength={60} value={f.nicheOther} onChange={(e) => setF({ ...f, nicheOther: e.target.value })} placeholder="Ex.: arquitetura, eventos, agronegócio" /></label>
            )}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('use')}>Voltar</button>
              <button className="btn btn--primary" disabled={!f.niche} onClick={() => setStep('more')}>Continuar</button>
            </div>
          </section>
        ) : step === 'more' ? (
          <section>
            <h2 id="onb-title" className="onb__title">Quase lá</h2>
            <p className="muted">Os dois campos são opcionais e ajudam a equipe a começar pelo que importa.</p>
            <label className="field">{personal ? 'Um nome para o seu espaço' : 'Nome da empresa ou do projeto'}
              <input maxLength={60} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} placeholder={personal ? 'Ex.: Casa da Ana' : 'Ex.: Agência Lume'} />
            </label>
            <label className="field">O que você quer resolver primeiro?
              <textarea rows={2} maxLength={300} value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} placeholder={personal ? 'Ex.: organizar as contas da casa' : 'Ex.: responder os clientes atrasados desta semana'} />
            </label>
            {redo && <p className="hint warn">Refazer troca as funções e os nomes dos setores da equipe de partida. Os nomes que você deu aos agentes continuam, e quem você criou fica como está.</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('niche')}>Voltar</button>
              {redo && aiConnected
                ? <button className="btn btn--primary" onClick={build}>Refazer a equipe</button>
                : <button className="btn btn--primary" onClick={() => { setErr(null); setStep('ia'); }}>Continuar</button>}
            </div>
          </section>
        ) : step === 'ia' ? (
          <section>
            <h2 id="onb-title" className="onb__title">Conecte a inteligência da equipe</h2>
            <p className="muted">Os agentes pensam com a sua conta de IA. Recomendamos a <b>assinatura Nous</b>: é com ela que a equipe tem a melhor experiência, pelo custo e pela versatilidade. O login acontece na página da própria conta: a sua senha não passa pelo sistema.</p>
            <AiAccounts pitch onChanged={loadAi} />
            {!aiConnected && <p className="hint">Sem conta conectada, as respostas ficam simuladas. Dá para conectar depois, em Conexões.</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="onb__nav">
              <button className="btn" onClick={() => setStep('more')}>Voltar</button>
              {aiConnected
                ? <button className="btn btn--primary" onClick={build}>{redo ? 'Refazer a equipe' : 'Montar minha equipe'}</button>
                : <button className="btn btn--ghost" onClick={build}>Conectar depois</button>}
            </div>
          </section>
        ) : step === 'building' ? (
          <section className="onb__building"><PhraseLoader phrases={BUILDING} every={1600} /></section>
        ) : result && (
          <section>
            <h2 id="onb-title" className="onb__title">Sua equipe está pronta</h2>
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
              <p>Isto é só o ponto de partida. <b>{result.coordinator}</b> é o Coordenador, o único cargo fixo; todo o resto é seu — e quantos agentes quiser. Peça a {result.coordinator} para criar, renomear ou trocar funções e ferramentas, criar setores, ou transformar a equipe num tema inteiro, com outros nomes e histórias. Também dá para editar tudo no perfil de cada agente.</p>
            </div>
            <div className="onb__nav">
              <button className="btn" onClick={() => onFinish({ tour: false, result, goal: f.goal.trim() })}>{redo ? 'Fechar' : 'Ir direto'}</button>
              <button className="btn btn--primary" autoFocus onClick={() => onFinish({ tour: true, result, goal: f.goal.trim() })}><Icon name="compass" size={16} /> Fazer o tour (1 minuto)</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

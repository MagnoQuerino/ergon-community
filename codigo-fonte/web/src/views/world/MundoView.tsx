import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, requestId } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { Icon } from '../../components/Icon.tsx';
import { ErgonMarca } from '../../brand/Brand.tsx';
import { fmtData, fmtDracmas, fmtMoeda, useIdioma } from '../../i18n/index.ts';
import { ConnectForm, DeviceLimit, erroConta, type LoginLimit } from './WorldLinkDialog.tsx';
import { linhaDoResumo, type ResumoFora } from './nuvem-cartao.ts';
import { figura, predio, type Imagem, type Personagem } from './arte.ts';
import { tw, twn, useTw } from './textos.ts';
import type { Gesture } from '../../iso/figures.ts';
import { AceitarConvite, CarrinhoPainel, DracmasPainel, EquipeFaixa, ErgonAiPainel, NuvemPainel, PessoasPainel, PlanoPainel, WorkspacesPainel, type BillingWorld, type CatalogoWorld } from './Gestao.tsx';

interface Status { configured: boolean; me: { displayName: string }; deviceLimit: LoginLimit | null; link: { boundWorkspaceId: string | null; boundWorkspaceName: string | null; currentIsBound: boolean; workspaces?: Array<{ workspaceId: string; label?: string | null; role: string; status: string; plan_sku: string | null }> } | null }
interface Item { sku: string; kind: string; name: string; priceCents: string | null; sellable: boolean; tier?: string | null; interval?: 'month' | 'year'; people?: number; jobSlots?: number; monthlyDracmas?: string; seatSku?: string }
interface Catalog { items: Item[] }
interface Billing { workspaceId: string | null; role: string; entitlement: { status: string; plan_sku: string | null; tier: string | null; people: number; job_slots: number; effective_until: string | null }; seatsUsed: number }
interface Wallet { available: string }
interface Policy { available: boolean; rounds?: number }

const TIERS = ['sync', 'pro', 'team'] as const;
const RECOMENDADO = 'pro';
const PROXIMO: Record<string, string | undefined> = { sync: 'pro', pro: 'team' };
const brl = (c: string | number | null | undefined) => (c == null ? tw('preco.aDefinir') : fmtMoeda(Number(c) / 100, 'BRL'));
const dr = (v: string | number) => fmtDracmas(Number(v));
// i18n-ok: o fuso de Salvador (o dos créditos), não é texto de tela
const dia = (iso: string | null) => (iso ? fmtData(iso, { dateStyle: 'short', timeZone: 'America/Bahia' }) : '—');
const calmoRolar = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
/** Leva a uma seção da página (o painel do membro ou os workspaces do visitante conectado). */
const irPara = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: calmoRolar(), block: 'start' });
const calmo = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A página do Ergon World no menu da esquerda: o convite (com a equipe grega a caminho de um mundo novo), os
 * benefícios, os planos do catálogo (preços sempre do World), as perguntas rápidas e o convite final. Sem conta, o
 * botão abre a conexão; conectado sem plano, leva aos planos e ao pagamento de sempre; com plano, recebe a pessoa
 * como membro. O que se configura continua em Configurações › Ergon World ("Gerenciar").
 */
export default function MundoView() {
  const t = useTw();
  useIdioma();
  const st = useResource<Status>('/api/world/status', ['world.changed']);
  const s = st.data;
  const on = !!s?.configured;
  const bound = !!s?.link?.currentIsBound;
  const cat = useResource<Catalog>(on ? '/api/world/catalog' : null, []);
  const bill = useResource<Billing>(bound ? '/api/world/billing' : null, []);
  const wallet = useResource<Wallet>(bound ? '/api/world/wallet' : null, []);
  const resumo = useResource<ResumoFora>(bound ? '/api/world/cards/summary' : null, []);
  const policy = useResource<Policy>(bound ? '/api/world/job-policy' : null, []);
  const [anual, setAnual] = useState(false);
  const [planoCarrinho, setPlanoCarrinho] = useState<string | null>(null);
  const [conectar, setConectar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const raiz = useRef<HTMLDivElement>(null);
  const [anima] = useState(() => !calmo() && typeof IntersectionObserver === 'function');

  // as seções aparecem ao entrar na tela (só com movimento; sem ele, tudo já está à vista)
  useEffect(() => {
    if (!anima || !raiz.current) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    raiz.current.querySelectorAll('.mundo-revela').forEach((el) => io.observe(el));
    return () => io.disconnect();
  });

  const planos = (cat.data?.items ?? []).filter((i) => i.kind === 'plan');
  const plano = (tier: string, intervalo: 'month' | 'year') => planos.find((p) => p.tier === tier && p.interval === intervalo);
  const nomeDe = (p: Item) => plano(p.tier ?? '', 'month')?.name ?? p.name;
  const addon = (sku?: string) => cat.data?.items.find((i) => i.sku === sku);
  const economia = Math.max(0, ...TIERS.map((k) => { const m = plano(k, 'month'); const a = plano(k, 'year'); return m && a && Number(m.priceCents) > 0 ? Math.round((1 - Number(a.priceCents) / (Number(m.priceCents) * 12)) * 100) : 0; }));

  const e = bill.data?.entitlement;
  const membro = !!e && ['active', 'grace'].includes(e.status) && !!e.plan_sku;
  const atual = membro ? planos.find((p) => p.sku === e!.plan_sku) : undefined;
  const dono = bill.data?.role === 'owner';
  const rodadas = policy.data?.rounds ?? 3;

  const checkout = async (sku: string) => {
    setBusy(true); setErro('');
    try { const r = await api.post<{ url: string }>('/api/world/billing/checkout', { sku, idempotencyKey: requestId() }); location.assign(r.url); }
    catch (x) { setErro(erroConta(x, t)); setBusy(false); }
  };
  const verPlanos = () => document.getElementById('mundo-planos')?.scrollIntoView({ behavior: calmo() ? 'auto' : 'smooth', block: 'start' });

  /** O botão principal de cada estado. */
  const principal = (grande = true): ReactNode => {
    const cls = `btn btn--gold mundo-cta${grande ? ' mundo-cta--grande' : ''}`;
    if (!s) return null;
    if (!s.link) return <button className={cls} disabled={!on} onClick={() => setConectar(true)}><Icon name="compass" size={18} /> {t('pagina.entrar')}</button>;
    if (!bound) return <button className={cls} onClick={() => irPara('mundo-workspaces')}><Icon name="layers" size={18} /> {t('pagina.ligarWs')}</button>;
    if (membro) return <button className={cls} onClick={() => irPara('painel-plano')}><Icon name="gear" size={18} /> {t('pagina.gerenciar')}</button>;
    return <button className={cls} onClick={verPlanos}><Icon name="check" size={18} /> {t('pagina.escolher')}</button>;
  };

  /** O botão de cada plano, conforme o estado. */
  const botaoDoPlano = (p: Item, destaque: boolean): ReactNode => {
    const cls = `btn ${destaque ? 'btn--gold' : 'btn--primary'} mundo-plano__cta`;
    const nome = nomeDe(p);
    if (!s?.link) return <button className={cls} disabled={!on} onClick={() => setConectar(true)}>{t('pagina.entrar')}</button>;
    if (!bound) return <button className={cls} onClick={() => irPara('mundo-workspaces')}>{t('pagina.ligarWs')}</button>;
    if (membro) return atual?.sku === p.sku ? <span className="mundo-plano__seu"><Icon name="check" size={16} /> {t('pagina.planos.seu')}</span>
      : <button className={`btn ${destaque ? 'btn--gold' : ''} mundo-plano__cta`} onClick={() => { setPlanoCarrinho(p.sku); irPara('painel-plano'); }}>{t('pagina.planos.mudar', { plano: nome })}</button>;
    if (!dono) return <p className="small mundo-plano__nota">{t('plano.quemCuida')}</p>;
    return <button className={cls} disabled={busy || !p.sellable} onClick={() => void checkout(p.sku)}>{t('pagina.planos.assinar', { plano: nome })}</button>;
  };

  const proximo = atual ? plano(PROXIMO[atual.tier ?? ''] ?? '', atual.interval ?? 'month') : undefined;

  return (
    <div ref={raiz} className={`mundo${anima ? ' mundo--anima' : ''}`} aria-label={t('pagina.aria')}>
      {/* ---------- o convite (ou a chegada do membro) ---------- */}
      <section className="mundo-heroi" aria-labelledby="mundo-titulo">
        <Estrelas n={46} />
        <div className="mundo-heroi__txt">
          <span className="mundo-selo"><ErgonMarca size={18} onDark /> {membro ? t('pagina.membro.selo') : t('pagina.selo')}</span>
          {membro && atual && e ? (
            <>
              <h1 id="mundo-titulo" className="mundo-heroi__titulo">{t('pagina.membro.titulo', { nome: s?.me.displayName ?? '' })}</h1>
              <p className="mundo-heroi__sub">{twn('pagina.membro.sub', { plano: <b>{nomeDe(atual)}</b>, workspace: <b>{s?.link?.boundWorkspaceName ?? ''}</b> })}</p>
              <dl className="mundo-numeros">
                <div><dt>{t('pagina.membro.plano')}</dt><dd>{nomeDe(atual)}<small>{t('plano.pagoAte', { dia: dia(e.effective_until) })}</small></dd></div>
                <div><dt>{t('pagina.membro.creditos')}</dt><dd>{wallet.data ? dr(wallet.data.available) : '…'}</dd></div>
                <div><dt>{t('pagina.membro.pessoas')}</dt><dd>{t('pagina.membro.pessoasValor', { usadas: bill.data?.seatsUsed ?? 0, n: e.people })}</dd></div>
                <div><dt>{t('pagina.membro.jobs')}</dt><dd>{e.job_slots}</dd></div>
                <div className="mundo-numeros__largo"><dt>{t('pagina.membro.nuvem')}</dt><dd>{linhaDoResumo(resumo.data, t) ?? t('pagina.membro.emDia')}</dd></div>
              </dl>
              <EquipeFaixa onGerenciar={() => irPara('painel-pessoas')} />
              <div className="mundo-heroi__acoes">{principal()}</div>
            </>
          ) : (
            <>
              <h1 id="mundo-titulo" className="mundo-heroi__titulo">{t('pagina.titulo')}</h1>
              <p className="mundo-heroi__sub">{t('pagina.subtitulo')}</p>
              <div className="mundo-heroi__acoes">
                {principal()}
                <button className="btn mundo-cta mundo-cta--fantasma" onClick={verPlanos}>{t('pagina.verPlanos')}</button>
              </div>
              {s && !on && <p className="mundo-heroi__nota small">{t('mundo.semEndereco')}</p>}
              {s?.link && !bound && <p className="mundo-heroi__nota small">{t('pagina.ligarTexto')}</p>}
              <ul className="mundo-confia">
                <li><Icon name="lock" size={14} /> {t('pagina.confia.cifrado')}</li>
                <li><Icon name="shield-check" size={14} /> {t('pagina.confia.escolhido')}</li>
                <li><Icon name="check" size={14} /> {t('pagina.confia.cancelar')}</li>
              </ul>
            </>
          )}
          {erro && <p className="error" role="alert">{erro}</p>}
        </div>
        <Viagem />
      </section>

      {membro && <Painel nomeWorkspace={s?.link?.boundWorkspaceName ?? null} planoCarrinho={planoCarrinho} mine={(s?.link?.workspaces ?? []).filter((w) => w.role === 'owner')} />}

      {/* ---------- conectado sem plano: o workspace que vai para o mundo e o convite recebido ---------- */}
      {!membro && s?.link && (
        <section className="mundo-secao mundo-painel__secao mundo-revela" id="mundo-workspaces" aria-labelledby="mundo-workspaces-titulo">
          <header className="mundo-painel__cab"><span className="mundo-painel__icone" aria-hidden="true"><Icon name="layers" size={20} /></span>
            <div><h2 id="mundo-workspaces-titulo">{t('painel.workspaces')}</h2><p>{t('painel.workspaces.texto')}</p></div></header>
          <WorkspacesPainel />
          <AceitarConvite compacto onDone={st.reload} />
        </section>
      )}

      {/* ---------- os benefícios ---------- */}
      {!membro && <section className="mundo-secao" aria-labelledby="mundo-beneficios">
        <header className="mundo-secao__cab mundo-revela">
          <h2 id="mundo-beneficios">{membro ? t('pagina.membro.beneficios') : t('pagina.beneficios.titulo')}</h2>
          {!membro && <p>{t('pagina.beneficios.sub')}</p>}
        </header>
        <div className="mundo-beneficios">
          <Beneficio arte={<ArteNuvem />} titulo={t('pagina.b.nuvem.titulo')} texto={t('pagina.b.nuvem.texto')} />
          <Beneficio arte={<ArteSync />} titulo={t('pagina.b.sync.titulo')} texto={t('pagina.b.sync.texto')} />
          <Beneficio arte={<ArteRecupera />} titulo={t('pagina.b.recuperacao.titulo')} texto={t('pagina.b.recuperacao.texto', { n: rodadas })} />
          <Beneficio arte={<ArteIa />} titulo={t('pagina.b.ia.titulo')} texto={t('pagina.b.ia.texto')} />
          <Beneficio arte={<ArteEquipe />} titulo={t('pagina.b.equipe.titulo')} texto={t('pagina.b.equipe.texto')} />
          <Beneficio arte={<ArteDracmas />} titulo={t('pagina.b.dracmas.titulo')} texto={t('pagina.b.dracmas.texto')} />
        </div>
      </section>}

      {/* ---------- o convite para crescer (membro) ---------- */}
      {membro && proximo && dono && (
        <section className="mundo-upsell mundo-revela" aria-labelledby="mundo-upsell">
          <Fig k="platao" gesture="joy" scale={3} className="mundo-upsell__fig" />
          <div>
            <h2 id="mundo-upsell">{t('pagina.upsell.titulo')}</h2>
            <p>{t('pagina.upsell.texto', { plano: nomeDe(proximo), pessoas: proximo.people ?? 0, dracmas: dr(proximo.monthlyDracmas ?? '0'), jobs: proximo.jobSlots ?? 0 })}</p>
          </div>
          <button className="btn btn--gold" onClick={verPlanos}>{t('pagina.upsell.botao', { plano: nomeDe(proximo) })}</button>
        </section>
      )}

      {/* ---------- os planos (do catálogo do World) ---------- */}
      {on && !membro && (
        <section className="mundo-secao mundo-secao--planos" id="mundo-planos" aria-labelledby="mundo-planos-titulo">
          <header className="mundo-secao__cab mundo-revela">
            <h2 id="mundo-planos-titulo">{t('pagina.planos.titulo')}</h2>
            <p>{t('pagina.planos.sub')}</p>
            <div className="mundo-periodo" role="group" aria-label={t('plano.periodo')}>
              <button aria-pressed={!anual} className={!anual ? 'is-on' : ''} onClick={() => setAnual(false)}>{t('pagina.planos.mensal')}</button>
              <button aria-pressed={anual} className={anual ? 'is-on' : ''} onClick={() => setAnual(true)}>
                {t('pagina.planos.anual')}{economia > 0 && <span className="mundo-periodo__eco">{t('pagina.planos.economia', { pct: economia })}</span>}
              </button>
            </div>
          </header>
          {!cat.data ? <p className="muted center">{cat.error ?? '…'}</p> : (
            <div className="mundo-planos">
              {TIERS.map((tier) => {
                const p = plano(tier, anual ? 'year' : 'month');
                if (!p) return null;
                const destaque = membro ? atual?.tier === tier : tier === RECOMENDADO;
                return (
                  <article key={p.sku} className={`mundo-plano mundo-revela${destaque ? ' mundo-plano--destaque' : ''}`} aria-label={nomeDe(p)}>
                    {destaque && <span className="mundo-plano__fita">{membro ? t('pagina.planos.seu') : t('pagina.planos.recomendado')}</span>}
                    <h3>{nomeDe(p)}</h3>
                    <p className="mundo-plano__tag">{t(`pagina.tier.${tier}`)}</p>
                    <p className="mundo-plano__preco"><b>{brl(p.priceCents)}</b><span>{anual ? t('pagina.planos.porAno') : t('pagina.planos.porMes')}</span></p>
                    <p className="mundo-plano__equiv small">{anual && p.priceCents ? t('pagina.planos.equivale', { valor: brl(Math.round(Number(p.priceCents) / 12)) }) : ' '}</p>
                    <ul>
                      <li><Icon name="users" size={16} /> {t('pagina.planos.pessoas', { n: p.people ?? 1 })}</li>
                      <li><Icon name="coins" size={16} /> {t('pagina.planos.dracmas', { valor: dr(p.monthlyDracmas ?? '0') })}</li>
                      <li><Icon name="cloud" size={16} /> {t('pagina.planos.jobs', { n: p.jobSlots ?? 0 })}</li>
                      <li><Icon name="shield-check" size={16} /> {t('pagina.planos.base')}</li>
                      <li className="mundo-plano__extra"><Icon name="plus" size={16} /> {t('pagina.planos.extra', { preco: brl(addon(p.seatSku)?.priceCents) })}</li>
                    </ul>
                    {botaoDoPlano(p, destaque)}
                  </article>
                );
              })}
            </div>
          )}
          {bound && dono && cat.data && bill.data && (
            <div className="mundo-painel__cartao mundo-carrinho-visitante mundo-revela">
              <h3><Icon name="plus" size={16} /> {t('carrinho.titulo')}</h3>
              <p className="muted small">{t('painel.plano.texto')}</p>
              <CarrinhoPainel cat={cat.data as CatalogoWorld} bill={bill.data as unknown as BillingWorld} onMsg={(m) => setErro(m?.kind === 'error' ? m.text : '')} onDone={() => bill.reload()} />
            </div>
          )}
        </section>
      )}

      {/* ---------- perguntas rápidas ---------- */}
      {!membro && <section className="mundo-secao mundo-faq mundo-revela" aria-labelledby="mundo-faq">
        <h2 id="mundo-faq">{t('pagina.faq.titulo')}</h2>
        {(['privacidade', 'cancelar', 'local', 'dracmas'] as const).map((k) => (
          <details key={k}>
            <summary>{t(`pagina.faq.${k}.p`)}<Icon name="chevron" size={16} /></summary>
            <p>{t(`pagina.faq.${k}.r`)}</p>
          </details>
        ))}
      </section>}

      {/* ---------- o convite final ---------- */}
      <section className="mundo-final mundo-revela" aria-labelledby="mundo-final">
        <Estrelas n={22} />
        <Farol className="mundo-farol mundo-farol--final" />
        <svg className="mundo-nuvem mundo-nuvem--final" viewBox="0 0 120 40" aria-hidden="true"><path d="M10 34h96a14 14 0 0 0-8-26 18 18 0 0 0-33-4A15 15 0 0 0 40 14a12 12 0 0 0-30 20z" /></svg>
        <div className="mundo-final__equipe" aria-hidden="true">
          {(['hipatia', 'aristoteles', 'arquimedes', 'fidias', 'aspasia'] as Personagem[]).map((k, i) => <Fig key={k} k={k} gesture={i % 2 ? 'joy' : 'talk'} scale={3} />)}
        </div>
        <h2 id="mundo-final">{membro ? t('pagina.final.membro') : t('pagina.final.titulo')}</h2>
        {!membro && <p>{t('pagina.final.texto')}</p>}
        <div className="mundo-heroi__acoes mundo-final__acoes">{principal(false)}</div>
      </section>

      {conectar && s && <Conectar s={s} onClose={() => setConectar(false)} onDone={() => { setConectar(false); st.reload(); }} />}
    </div>
  );
}

const SECOES = [
  { id: 'painel-plano', icone: 'check', titulo: 'painel.plano', texto: 'painel.plano.texto' },
  { id: 'painel-pessoas', icone: 'users', titulo: 'painel.pessoas', texto: 'pessoas.texto' },
  { id: 'painel-workspaces', icone: 'layers', titulo: 'painel.workspaces', texto: 'painel.workspaces.texto' },
  { id: 'painel-dracmas', icone: 'coins', titulo: 'painel.dracmas', texto: 'creditos.titulo' },
  { id: 'painel-nuvem', icone: 'cloud', titulo: 'painel.nuvem', texto: 'painel.nuvem.texto' },
  { id: 'painel-ia', icone: 'globe', titulo: 'painel.ia', texto: 'painel.ia.texto' },
] as const;

/**
 * O painel do membro (plano ativo): as seções da gestão do workspace no World, com a mesma cara da página — Plano (com
 * o carrinho), Pessoas e papéis, Workspaces (e a sincronia), Dracmas, Nuvem e Ergon AI. A conta fica em Configurações.
 */
function Painel({ nomeWorkspace, planoCarrinho, mine }: { nomeWorkspace: string | null; planoCarrinho: string | null; mine: Array<{ workspaceId: string; label?: string | null; role: string; status: string; plan_sku: string | null }> }) {
  const t = useTw();
  const corpo: Record<(typeof SECOES)[number]['id'], ReactNode> = {
    'painel-plano': <PlanoComCarrinho plano={planoCarrinho} />,
    'painel-pessoas': <PessoasPainel nomeWorkspace={nomeWorkspace} />,
    'painel-workspaces': <WorkspacesPainel comSync />,
    'painel-dracmas': <DracmasPainel mine={mine} />,
    'painel-nuvem': <NuvemPainel />,
    'painel-ia': <ErgonAiPainel />,
  };
  return (
    <div className="mundo-painel">
      <nav className="mundo-painel__nav" aria-label={t('painel.nav')}>
        {SECOES.map((x) => <a key={x.id} href={`#world`} onClick={(ev) => { ev.preventDefault(); irPara(x.id); }}><Icon name={x.icone} size={15} /> {t(x.titulo)}</a>)}
      </nav>
      {SECOES.map((x) => (
        <section key={x.id} id={x.id} className="mundo-painel__secao mundo-revela" aria-labelledby={`${x.id}-t`}>
          <header className="mundo-painel__cab">
            <span className="mundo-painel__icone" aria-hidden="true">{x.id === 'painel-ia' ? <ErgonMarca size={24} onDark /> : <Icon name={x.icone} size={20} />}</span>
            <div><h2 id={`${x.id}-t`}>{t(x.titulo)}</h2><p>{t(x.texto)}</p></div>
          </header>
          {corpo[x.id]}
        </section>
      ))}
      <p className="muted small center">{t('painel.conta')} <a href="#configuracao?world">{t('pagina.gerenciar')}</a></p>
    </div>
  );
}
/** O plano do painel; o plano escolhido nos cartões ("Mudar para…") entra no carrinho. */
function PlanoComCarrinho({ plano }: { plano: string | null }) {
  return <PlanoPainel planoInicial={plano} />;
}

/** Conectar ao Ergon World, por cima da página: o mesmo formulário de Configurações. */
function Conectar({ s, onClose, onDone }: { s: Status; onClose: () => void; onDone: () => void }) {
  const t = useTw();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="mundo-conectar">
      <div className="auth__card mundo-conectar" ref={ref}>
        <h2 className="auth__title" id="mundo-conectar">{t('pagina.entrar')}</h2>
        <p className="muted">{t('pagina.conectarTexto')}</p>
        {s.deviceLimit ? <DeviceLimit limit={s.deviceLimit} onDone={onDone} /> : <ConnectForm displayName={s.me.displayName} onDone={onDone} onCancel={onClose} />}
      </div>
    </div>
  );
}

function Beneficio({ arte, titulo, texto }: { arte: ReactNode; titulo: string; texto: string }) {
  return (
    <article className="mundo-beneficio mundo-revela">
      <div className="mundo-vinheta" aria-hidden="true">{arte}</div>
      <h3>{titulo}</h3>
      <p>{texto}</p>
    </article>
  );
}

/** Um personagem da equipe, em pixel art (enfeite: sem texto alternativo). */
function Fig({ k, gesture = 'none', scale = 3, className = '', facing = 'front' }: { k: Personagem; gesture?: Gesture; scale?: number; className?: string; facing?: 'front' | 'back' }) {
  const img = useMemo<Imagem | null>(() => figura(k, gesture, facing, scale), [k, gesture, facing, scale]);
  if (!img) return null;
  return <img className={`mundo-fig ${className}`} src={img.url} width={img.w / 2} height={img.h / 2} alt="" draggable={false} />;
}

/** Estrelas espalhadas (posições fixas, sorteadas por uma semente: a mesma tela a cada visita). */
function Estrelas({ n }: { n: number }) {
  const pontos = useMemo(() => {
    let x = 7 * n + 3; const r = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    return Array.from({ length: n }, (_, i) => ({ l: r() * 100, t: r() * 92, s: r() < 0.18 ? 3 : r() < 0.5 ? 2 : 1, d: (r() * 4).toFixed(2), i }));
  }, [n]);
  return (
    <div className="mundo-estrelas" aria-hidden="true">
      {pontos.map((p) => <i key={p.i} className={`mundo-estrela mundo-estrela--${p.s}`} style={{ left: `${p.l}%`, top: `${p.t}%`, animationDelay: `${p.d}s` }} />)}
    </div>
  );
}

/** A cena do convite: o farol, o barco voador com a equipe e a cidade sobre as nuvens (o mundo novo). */
function Viagem() {
  const t = useTw();
  const predios = useMemo(() => ['stoa', 'bouleuterion', 'oikos'].map((k) => predio(k)), []);
  return (
    <div className="mundo-cena" role="img" aria-label={t('pagina.cena')}>
      <div className="mundo-cena__lua" />
      <svg className="mundo-nuvem mundo-nuvem--1" viewBox="0 0 120 40"><path d="M10 34h96a14 14 0 0 0-8-26 18 18 0 0 0-33-4A15 15 0 0 0 40 14a12 12 0 0 0-30 20z" /></svg>
      <svg className="mundo-nuvem mundo-nuvem--2" viewBox="0 0 120 40"><path d="M10 34h96a14 14 0 0 0-8-26 18 18 0 0 0-33-4A15 15 0 0 0 40 14a12 12 0 0 0-30 20z" /></svg>
      {/* o mundo novo: uma ilha sobre as nuvens, com os prédios da cidade */}
      <div className="mundo-ilha">
        <div className="mundo-ilha__aura" />
        <div className="mundo-ilha__predios">
          {predios.map((p, i) => p && <img key={i} src={p.url} width={p.w} height={p.h} alt="" draggable={false} className={`mundo-ilha__predio mundo-ilha__predio--${i}`} />)}
        </div>
        <svg className="mundo-ilha__rocha" viewBox="0 0 260 90" preserveAspectRatio="none">
          <path className="mundo-ilha__grama" d="M0 10 Q130 -6 260 10 L260 22 Q130 8 0 22z" />
          <path className="mundo-ilha__pedra" d="M2 18 Q130 4 258 18 Q250 36 214 48 Q190 70 150 80 Q128 94 104 80 Q66 70 44 48 Q10 36 2 18z" />
          <path className="mundo-ilha__veio" d="M40 34 Q130 46 222 34 Q190 56 150 62 Q120 70 92 60 Q60 52 40 34z" />
        </svg>
      </div>
      {/* o farol de Alexandria, com o facho de luz apontando para o mundo novo */}
      <Farol />
      {/* o barco voador com a equipe a bordo */}
      <div className="mundo-barco">
        <div className="mundo-barco__tripulacao">
          <Fig k="hipatia" gesture="point" scale={3} />
          <Fig k="aristoteles" gesture="joy" scale={3} />
          <Fig k="arquimedes" gesture="talk" scale={3} />
          <Fig k="fidias" gesture="joy" scale={3} />
        </div>
        <svg className="mundo-barco__casco" viewBox="0 0 240 120">
          <path className="mundo-barco__vela" d="M120 4 L120 70 L178 70z" />
          <path className="mundo-barco__vela mundo-barco__vela--2" d="M114 14 L114 70 L74 70z" />
          <rect className="mundo-barco__mastro" x="115" y="0" width="5" height="86" />
          <path className="mundo-barco__madeira" d="M8 78 L232 78 L206 112 L36 112z" />
          <path className="mundo-barco__faixa" d="M14 86 L226 86 L222 92 L18 92z" />
          <path className="mundo-barco__asa" d="M40 92 Q-6 70 -2 106 Q20 98 40 104z" />
          <path className="mundo-barco__asa mundo-barco__asa--2" d="M200 92 Q246 70 242 106 Q220 98 200 104z" />
        </svg>
        <svg className="mundo-barco__rastro" viewBox="0 0 200 30"><path d="M0 18 Q40 4 80 16 T160 14 T200 16" /></svg>
      </div>
    </div>
  );
}

/** O farol de Alexandria (enfeite): torre em três andares, a luz que pulsa e o facho que varre o céu. */
function Farol({ className = 'mundo-farol' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 90 200" aria-hidden="true">
      <defs>
        <linearGradient id="mundo-facho-luz" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" className="mundo-farol__facho-1" /><stop offset="1" className="mundo-farol__facho-2" />
        </linearGradient>
      </defs>
      <polygon className="mundo-farol__facho" fill="url(#mundo-facho-luz)" points="45,28 360,-260 420,-190" />
      <path className="mundo-farol__rocha" d="M-6 200 Q4 172 26 170 L70 168 Q92 172 98 200z" />
      <rect className="mundo-farol__base" x="16" y="140" width="58" height="34" rx="2" />
      <rect className="mundo-farol__corpo" x="25" y="84" width="40" height="58" rx="2" />
      <rect className="mundo-farol__corpo mundo-farol__corpo--alto" x="32" y="40" width="26" height="46" rx="2" />
      <rect className="mundo-farol__janela" x="41" y="100" width="8" height="14" rx="4" />
      <rect className="mundo-farol__janela" x="41" y="54" width="8" height="12" rx="4" />
      <rect className="mundo-farol__friso" x="22" y="82" width="46" height="4" />
      <rect className="mundo-farol__friso" x="13" y="138" width="64" height="4" />
      <circle className="mundo-farol__luz" cx="45" cy="28" r="10" />
      <path className="mundo-farol__teto" d="M31 20 L45 4 L59 20z" />
    </svg>
  );
}

/* ---------- as vinhetas dos benefícios ---------- */

function ArteNuvem() {
  return (
    <>
      <div className="mundo-vinheta__lua" />
      <svg className="v-nuvem v-flutua" viewBox="0 0 120 40"><path d="M10 34h96a14 14 0 0 0-8-26 18 18 0 0 0-33-4A15 15 0 0 0 40 14a12 12 0 0 0-30 20z" /></svg>
      <Fig k="arquimedes" gesture="reach" scale={2} className="v-sobre-nuvem v-flutua" />
      <svg className="v-notebook" viewBox="0 0 80 30"><rect x="10" y="10" width="60" height="10" rx="2" /><rect className="v-notebook__base" x="2" y="20" width="76" height="6" rx="3" /></svg>
    </>
  );
}

function ArteSync() {
  const [parado] = useState(calmo);
  return (
    <>
      <svg className="v-sync" viewBox="0 0 220 120">
        <path className="v-sync__arco" d="M50 64 Q110 -6 170 64" />
        <rect className="v-tela" x="16" y="62" width="68" height="44" rx="5" /><rect className="v-tela__luz" x="22" y="68" width="56" height="30" rx="2" />
        <rect className="v-tela" x="136" y="62" width="68" height="44" rx="5" /><rect className="v-tela__luz" x="142" y="68" width="56" height="30" rx="2" />
        {parado ? <circle className="v-sync__ponto" cx="78" cy="38" r="5" /> : (
          <>
            <circle className="v-sync__ponto" r="5"><animateMotion dur="2.6s" repeatCount="indefinite" path="M50 64 Q110 -6 170 64" /></circle>
            <circle className="v-sync__ponto v-sync__ponto--2" r="4"><animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M170 64 Q110 -6 50 64" /></circle>
          </>
        )}
        <rect className="v-cadeado" x="100" y="20" width="20" height="16" rx="3" /><path className="v-cadeado__alca" d="M104 21 v-5 a6 6 0 0 1 12 0 v5" />
      </svg>
      <Fig k="aspasia" gesture="offer" scale={2} className="v-centro" />
    </>
  );
}

function ArteRecupera() {
  return (
    <>
      <svg className="v-anel v-gira" viewBox="0 0 120 120">
        <circle className="v-anel__trilho" cx="60" cy="60" r="46" />
        <path className="v-anel__seta" d="M60 14 A46 46 0 1 1 18 42" /><path className="v-anel__ponta" d="M10 34 L18 46 L28 36z" />
      </svg>
      <div className="v-tentativas"><i /><i /><i /></div>
      <Fig k="euclides" gesture="think" scale={2} className="v-centro" />
    </>
  );
}

function ArteIa() {
  return (
    <>
      <div className="v-orbe"><ErgonMarca size={64} onDark className="v-orbe__marca" /></div>
      <svg className="v-constelacao" viewBox="0 0 200 110">
        <path d="M20 80 L56 40 L98 58 L140 22 L178 50" /><circle cx="20" cy="80" r="3" /><circle cx="56" cy="40" r="3" /><circle cx="98" cy="58" r="3" /><circle cx="140" cy="22" r="3" /><circle cx="178" cy="50" r="3" />
      </svg>
    </>
  );
}

function ArteEquipe() {
  return (
    <div className="v-fila">
      <Fig k="hesiodo" gesture="talk" scale={2} />
      <Fig k="hipatia" scale={2} />
      <Fig k="aristoteles" gesture="joy" scale={2} />
      <Fig k="aspasia" gesture="talk" scale={2} />
      <Fig k="euclides" scale={2} />
    </div>
  );
}

function ArteDracmas() {
  return (
    <>
      <div className="v-moedas"><i /><i /><i /><i /></div>
      <div className="v-moeda v-gira-y"><span>₯</span></div>
      <Fig k="fidias" gesture="offer" scale={2} className="v-direita" />
    </>
  );
}

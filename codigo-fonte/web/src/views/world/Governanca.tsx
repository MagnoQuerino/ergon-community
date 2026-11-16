import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useResource } from '../../lib/live.ts';
import { Icon } from '../../components/Icon.tsx';
import { ErgonMarca, Loading } from '../../brand/Brand.tsx';
import { fmtDataHora, fmtDracmas, useIdioma } from '../../i18n/index.ts';
import { twn, useTw, type ChaveWorld } from './textos.ts';
import { AutoRecarga, PessoasPainel, RecoveryCard, useMsg } from './Gestao.tsx';
import { inicial, type Membros } from './pessoas.ts';
import { predio } from './arte.ts';
import { Estrelas, Fig } from './Enfeites.tsx';
import { acessoGovernanca, barraDoTeto, iconeDaAtividade, linhaDaAtividade, type Atividade } from './governanca.ts';
import { abrirCompra } from './SeloWorld.tsx';
import { useWorldVivo } from './vivo.ts';
import type { ItemC } from './compra-rapida.ts';

interface Budgets { manager: boolean; members: Array<{ accountId: string; role: string; name: string | null; email: string | null; me: boolean; cap: string | null; used: string }> }
interface Consumo { available: boolean; spent: { ai: string; jobs: string; other: string } }
interface Policy { available: boolean; recovery: boolean; rounds?: number; canEdit: boolean }
interface Registro { available: boolean; allowed: boolean; entries: Atividade[] }
interface Catalog { items: ItemC[] }

const dr = (v: string | number) => fmtDracmas(Math.round(Number(v) * 100) / 100);
const calmo = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const irPara = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: calmo() ? 'auto' : 'smooth', block: 'start' });

const SECOES = [
  { id: 'gov-pessoas', icone: 'users', titulo: 'gov.pessoas', texto: 'gov.pessoas.texto' },
  { id: 'gov-tetos', icone: 'coins', titulo: 'gov.tetos', texto: 'gov.tetos.texto' },
  { id: 'gov-nuvem', icone: 'cloud', titulo: 'gov.nuvem', texto: 'gov.nuvem.texto' },
  { id: 'gov-compras', icone: 'key', titulo: 'gov.compras', texto: 'gov.compras.texto' },
  { id: 'gov-atividade', icone: 'activity', titulo: 'gov.atividade', texto: 'gov.atividade.texto' },
] as const satisfies ReadonlyArray<{ id: string; icone: string; titulo: ChaveWorld; texto: ChaveWorld }>;

/**
 * Governança do workspace no Ergon World (World Team, pago ou cortesia; só para quem administra): num lugar só, as
 * pessoas e os papéis, os tetos de Dracmas de cada um, a política da nuvem, quem pode comprar e o registro do que
 * aconteceu. Nos outros planos, a mesma porta, trancada, com o convite para o Team.
 */
export default function Governanca() {
  const t = useTw();
  useIdioma();
  const { st, bound, bill } = useWorldVivo();
  if (!st.data || (bound && !bill)) return <Loading error={st.error} />;
  const acesso = acessoGovernanca(bound, bill);
  if (!acesso) return <div className="gov"><p className="muted center">{t('gov.atividade.semPermissao')}</p></div>;
  const ws = st.data.link?.boundWorkspaceName ?? '';
  return acesso === 'aberto' ? <GovAberta workspace={ws} /> : <GovTrancada dono={bill!.role === 'owner'} />;
}

function Heroi({ children, trancada }: { children: ReactNode; trancada?: boolean }) {
  const casa = useMemo(() => predio('bouleuterion'), []);
  return (
    <section className={`gov-heroi${trancada ? ' gov-heroi--trancada' : ''}`}>
      <Estrelas n={34} />
      <div className="gov-heroi__txt">{children}</div>
      <div className="gov-heroi__cena" aria-hidden="true">
        <div className="gov-heroi__aura" />
        {casa && <img className="gov-heroi__casa" src={casa.url} width={casa.w} height={casa.h} alt="" draggable={false} />}
        <div className="gov-heroi__conselho">
          <Fig k="aspasia" gesture="talk" scale={3} />
          <Fig k="platao" gesture="think" scale={3} />
          <Fig k="aristoteles" gesture="point" scale={3} />
          <Fig k="hipatia" gesture="joy" scale={3} />
        </div>
        {trancada && <span className="gov-heroi__cadeado"><Icon name="lock" size={30} /></span>}
      </div>
    </section>
  );
}

/** Nos outros planos: a porta trancada, uma linha do que vem com o Team e o botão que abre a compra (no Team). */
function GovTrancada({ dono }: { dono: boolean }) {
  const t = useTw();
  return (
    <div className="gov">
      <Heroi trancada>
        <span className="mundo-selo"><Icon name="lock" size={14} /> {t('gov.selo')}</span>
        <h1 className="gov-heroi__titulo">{t('gov.titulo')}</h1>
        <p className="gov-heroi__sub">{t('gov.trancado.texto')}</p>
        {dono ? <button className="btn btn--gold mundo-cta mundo-cta--grande" data-keep-surface onClick={() => abrirCompra('team')}><ErgonMarca size={18} /> {t('gov.trancado.botao')}</button>
          : <p className="gov-heroi__nota"><Icon name="users" size={14} /> {t('gov.trancado.peca')}</p>}
      </Heroi>
      <div className="gov-previa" aria-hidden="true">
        {SECOES.map((x) => (
          <div key={x.id} className="gov-previa__item"><span className="mundo-painel__icone"><Icon name={x.icone} size={18} /></span><b>{t(x.titulo)}</b><Icon name="lock" size={14} /></div>
        ))}
      </div>
    </div>
  );
}

function GovAberta({ workspace }: { workspace: string }) {
  const t = useTw();
  const m = useResource<Membros>('/api/world/members', ['world.changed']);
  const b = useResource<Budgets>('/api/world/budgets', ['world.changed']);
  const c = useResource<Consumo>('/api/world/consumo', ['world.changed']);
  const pol = useResource<Policy>('/api/world/job-policy', []);
  const raiz = useRef<HTMLDivElement>(null);
  // as seções aparecem ao entrar na tela (só com movimento)
  useEffect(() => {
    if (calmo() || typeof IntersectionObserver !== 'function' || !raiz.current) return;
    raiz.current.classList.add('gov--anima');
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.08 });
    raiz.current.querySelectorAll('.mundo-revela').forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
  const membros = m.data?.members ?? [];
  const admins = membros.filter((p) => p.role === 'owner' || p.role === 'admin').length;
  const gasto = c.data?.available ? Number(c.data.spent.ai) + Number(c.data.spent.jobs) + Number(c.data.spent.other) : null;
  const corpo: Record<(typeof SECOES)[number]['id'], ReactNode> = {
    'gov-pessoas': <PessoasPainel nomeWorkspace={workspace} />,
    'gov-tetos': <Tetos b={b.data} />,
    'gov-nuvem': <Nuvem pol={pol.data} />,
    'gov-compras': <Compras membros={m.data} />,
    'gov-atividade': <Registro />,
  };
  return (
    <div className="gov" ref={raiz}>
      <Heroi>
        <span className="mundo-selo"><ErgonMarca size={16} onDark /> {t('gov.selo')}</span>
        <h1 className="gov-heroi__titulo">{t('gov.titulo')}</h1>
        <p className="gov-heroi__sub">{twn('gov.sub', { workspace: <b>{workspace}</b> })}</p>
        <dl className="mundo-numeros gov-numeros">
          <div><dt>{t('gov.resumo.pessoas')}</dt><dd>{m.data ? t('pagina.membro.pessoasValor', { usadas: membros.length + m.data.invites.length, n: m.data.seats }) : '…'}</dd></div>
          <div><dt>{t('gov.resumo.admins')}</dt><dd>{m.data ? admins : '…'}</dd></div>
          <div><dt>{t('gov.resumo.gasto')}</dt><dd>{gasto === null ? '…' : fmtDracmas(Math.round(gasto))}</dd></div>
          <div><dt>{t('gov.resumo.recuperacao')}</dt><dd>{pol.data?.available ? (pol.data.recovery ? t('gov.ligada') : t('gov.desligada')) : '—'}</dd></div>
        </dl>
      </Heroi>
      <nav className="mundo-painel__nav gov-nav" aria-label={t('gov.nav')}>
        {SECOES.map((x) => <a key={x.id} href="#governanca" onClick={(ev) => { ev.preventDefault(); irPara(x.id); }}><Icon name={x.icone} size={15} /> {t(x.titulo)}</a>)}
      </nav>
      <div className="mundo-painel gov-secoes">
        {SECOES.map((x) => (
          <section key={x.id} id={x.id} className="mundo-painel__secao mundo-revela" aria-labelledby={`${x.id}-t`}>
            <header className="mundo-painel__cab">
              <span className="mundo-painel__icone" aria-hidden="true"><Icon name={x.icone} size={20} /></span>
              <div><h2 id={`${x.id}-t`}>{t(x.titulo)}</h2><p>{t(x.texto)}</p></div>
            </header>
            {corpo[x.id]}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Quanto cada pessoa usou no mês, contra o teto dela (os tetos mudam em Pessoas e papéis). */
function Tetos({ b }: { b: Budgets | null }) {
  const t = useTw();
  if (!b) return <Loading />;
  const maior = Math.max(0, ...b.members.map((x) => Number(x.used)));
  if (!b.members.length) return <p className="muted small">{t('gov.tetos.vazio')}</p>;
  return (
    <ul className="gov-tetos">
      {b.members.map((x) => {
        const usado = Number(x.used); const teto = x.cap === null ? null : Number(x.cap);
        const barra = barraDoTeto(usado, teto, maior);
        return (
          <li key={x.accountId} className="gov-teto">
            <span className={`pessoa__avatar pessoa__avatar--${x.role}`} aria-hidden="true">{inicial(x)}</span>
            <span className="gov-teto__nome">{x.name?.trim() || x.email || t('pessoas.semNome')}</span>
            <span className={`gov-teto__barra gov-teto__barra--${barra.tom}`} aria-hidden="true"><i style={{ width: `${barra.pct}%` }} /></span>
            <small className="gov-teto__valor">{teto === null ? `${t('gov.tetos.usou', { usado: dr(usado) })} · ${t('gov.tetos.livre')}` : t('gov.tetos.de', { usado: dr(usado), teto: dr(teto) })}</small>
          </li>
        );
      })}
    </ul>
  );
}

function Nuvem({ pol }: { pol: Policy | null }) {
  const t = useTw();
  const [onMsg, msgEl] = useMsg();
  return (
    <div className="gov-nuvem">
      {msgEl}
      <RecoveryCard onMsg={onMsg} />
      <p className="small gov-nuvem__rodadas"><Icon name="repeat" size={14} /> {t('gov.nuvem.rodadas', { n: pol?.rounds ?? 3 })}</p>
    </div>
  );
}

const PODE: ReadonlyArray<{ k: Extract<ChaveWorld, `gov.pode.${string}`>; papeis: string[] }> = [
  { k: 'gov.pode.comprar', papeis: ['owner'] },
  { k: 'gov.pode.auto', papeis: ['owner'] },
  { k: 'gov.pode.tetos', papeis: ['owner', 'admin'] },
  { k: 'gov.pode.convidar', papeis: ['owner', 'admin'] },
  { k: 'gov.pode.nuvem', papeis: ['owner', 'admin'] },
  { k: 'gov.pode.usar', papeis: ['owner', 'admin', 'editor'] },
  { k: 'gov.pode.ver', papeis: ['owner', 'admin', 'editor', 'viewer'] },
];
const PAPEIS = ['owner', 'admin', 'editor', 'viewer'] as const;

/** Quem pode comprar e o que cada papel faz (as regras do World), quem paga e a recarga automática do dono. */
function Compras({ membros }: { membros: Membros | null }) {
  const t = useTw();
  const cat = useResource<Catalog>('/api/world/catalog', []);
  const [onMsg, msgEl] = useMsg();
  const dono = membros?.members.find((p) => p.role === 'owner');
  const souDono = membros?.myRole === 'owner';
  return (
    <div className="gov-compras">
      {msgEl}
      <div className="gov-matriz" role="table" aria-label={t('gov.compras')}>
        <div className="gov-matriz__linha gov-matriz__cab" role="row">
          <span role="columnheader" />
          {PAPEIS.map((p) => <span key={p} role="columnheader"><span className={`badge badge--papel-${p}`}>{t(`papel.${p}`)}</span></span>)}
        </div>
        {PODE.map((x) => (
          <div key={x.k} className="gov-matriz__linha" role="row">
            <span role="rowheader">{t(x.k)}</span>
            {PAPEIS.map((p) => (
              <span key={p} role="cell" className={x.papeis.includes(p) ? 'gov-matriz__sim' : 'gov-matriz__nao'}>
                {x.papeis.includes(p) ? <Icon name="check" size={16} /> : <span aria-hidden="true">·</span>}<span className="sr-only">{x.papeis.includes(p) ? t('gov.pode.sim') : t('gov.pode.nao')}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      {dono && <p className="small gov-compras__paga"><Icon name="key" size={14} /> {twn('gov.compras.paga', { nome: <b>{dono.name?.trim() || dono.email || t('pessoas.semNome')}</b> })}</p>}
      <AutoRecarga dono={souDono} topups={(cat.data?.items ?? []).filter((i) => i.kind === 'topup') as Parameters<typeof AutoRecarga>[0]['topups']} onMsg={onMsg} />
    </div>
  );
}

/** O registro do workspace no World (o que mudou e quem fez), do mais novo para o mais velho. */
function Registro() {
  const t = useTw();
  const r = useResource<Registro>('/api/world/activity', ['world.changed']);
  if (!r.data) return <Loading error={r.error} />;
  if (!r.data.available) return <p className="muted small">{t('gov.atividade.indisponivel')}</p>;
  if (!r.data.allowed) return <p className="muted small">{t('gov.atividade.semPermissao')}</p>;
  if (!r.data.entries.length) return <p className="muted small">{t('gov.atividade.vazio')}</p>;
  return (
    <ol className="gov-registro">
      {r.data.entries.map((a) => (
        <li key={a.id} className="gov-registro__item">
          <span className="gov-registro__icone" aria-hidden="true"><Icon name={iconeDaAtividade(a.action)} size={14} /></span>
          <span className="gov-registro__txt">{linhaDaAtividade(a, t, dr)}</span>
          <time className="gov-registro__quando" dateTime={a.at}>{fmtDataHora(a.at)}</time>
        </li>
      ))}
    </ol>
  );
}

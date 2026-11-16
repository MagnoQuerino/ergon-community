import { useEffect, useRef, useState } from 'react';
import { api, ApiError, requestId } from '../../lib/api.ts';
import { emitLocal, useResource } from '../../lib/live.ts';
import { useBalao } from '../../lib/balao.ts';
import { useSurface } from '../../lib/surface.ts';
import { Icon } from '../../components/Icon.tsx';
import { ErgonMarca } from '../../brand/Brand.tsx';
import { fmtData, fmtDracmas, fmtMoeda, useIdioma, useT } from '../../i18n/index.ts';
import { erroConta } from './WorldLinkDialog.tsx';
import { VerifyEmail } from './WorldPanel.tsx';
import { twn, useTw } from './textos.ts';
import { comPlano, ehCortesia, nivelDe, nomeCurto, nomeDoPlano, ofertas, passoDe, precoEm, type Acao, type ItemC, type Moeda, type Nivel } from './compra-rapida.ts';
import { useWorldVivo, type BillingVivo, type StatusVivo, type WalletVivo } from './vivo.ts';
import type { Passo } from './carrinho.ts';

interface Catalog { items: ItemC[] }
interface Preview { upgrade: boolean; prorationDate: number; amountDueCents: string; effective: string; currency?: string }

/** Pede, de qualquer tela do World (a Governança trancada), a compra rápida aberta, já com o plano de destino. */
export const ABRIR_COMPRA = 'ergon:world-compra';
export function abrirCompra(alvo?: Nivel): void { window.dispatchEvent(new CustomEvent(ABRIR_COMPRA, { detail: { alvo } })); }

const preco = (cents: string | null, m: Moeda) => (cents == null ? '—' : fmtMoeda(Number(cents) / 100, m));
const saldoCurto = (v: string | undefined) => fmtDracmas(Math.floor(Number(v ?? 0)));
// i18n-ok: o fuso de Salvador (o dos créditos), não é texto de tela
const dia = (iso: string | null | undefined) => (iso ? fmtData(iso, { dateStyle: 'short', timeZone: 'America/Bahia' }) : '');

/**
 * A etiqueta do plano na barra de cima, ao lado do Estado do Ergon: "Pro | ₯ 4.202" no workspace ligado ao Ergon World
 * ("Sem plano | ₯ 0" sem plano). Num workspace que não está no World, um convite discreto para a página do World; sem o
 * World nesta instalação, nada. Clicar abre a compra em um clique.
 */
export default function SeloWorld() {
  const t = useTw();
  useIdioma();
  const { st, bound, bill, wallet } = useWorldVivo();
  const [aberto, setAberto] = useBalao('mundo');
  const [alvo, setAlvo] = useState<Nivel | undefined>(undefined);
  useEffect(() => {
    const f = (e: Event) => { setAlvo((e as CustomEvent<{ alvo?: Nivel }>).detail?.alvo); setAberto(true); };
    window.addEventListener(ABRIR_COMPRA, f);
    return () => window.removeEventListener(ABRIR_COMPRA, f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st.data?.configured) return null;
  if (!bound) {
    return (
      <a className="tb-world tb-world--chamada" href="#world" title={t('selo.chamadaDica')}>
        <ErgonMarca size={15} onDark /><span className="tb-world__plano">{t('selo.chamada')}</span>
      </a>
    );
  }
  const nivel = bill && comPlano(bill) ? nivelDe(bill.entitlement.plan_sku, bill.entitlement.tier) : null;
  const cortesia = !!bill && ehCortesia(bill);
  const nome = nivel ? nomeCurto(nivel) : t('selo.semPlano');
  const saldo = wallet ? saldoCurto(wallet.available) : '₯ …';
  return (
    <span className="topbar__worldwrap">
      <button type="button" data-keep-surface className={`tb-world${nivel ? ` tb-world--${nivel}` : ' tb-world--sem'}${cortesia ? ' tb-world--cortesia' : ''}${aberto ? ' is-on' : ''}`}
        onClick={() => { setAlvo(undefined); setAberto((v) => !v); }} aria-expanded={aberto} aria-haspopup="dialog"
        aria-label={t('selo.aria', { plano: cortesia ? `${nome} (${t('selo.cortesia')})` : nome, saldo })} title={cortesia ? `${nome} · ${t('selo.cortesia')}` : nome}>
        <span className="tb-world__plano">{nome}{cortesia && <span className="tb-world__cortesia" aria-hidden="true" />}</span>
        <span className="tb-world__sep" aria-hidden="true" />
        <span className="tb-world__saldo">{saldo}</span>
      </button>
      {aberto && bill && <CompraRapida st={st.data} bill={bill} wallet={wallet} alvo={alvo} onClose={() => setAberto(false)} />}
    </span>
  );
}

type Fase = null | { acao: Acao; passo: Passo; pv: Preview; rotulo: string };

/**
 * A compra em um clique: recargas (pagamento à parte no Stripe), mais pessoas e mais Jobs (no período do plano) e o
 * próximo plano, com o preço na moeda da assinatura. Com assinatura, mudanças passam pela prévia do World antes de
 * confirmar; sem ela, vão ao pagamento. Só o dono compra; e-mail sem confirmar abre a caixa do código aqui mesmo.
 */
function CompraRapida({ st, bill, wallet, alvo, onClose }: { st: StatusVivo; bill: BillingVivo; wallet: WalletVivo | null; alvo?: Nivel; onClose: () => void }) {
  const t = useTw(); const tg = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, outside: true });
  const cat = useResource<Catalog>('/api/world/catalog', []);
  const [fase, setFase] = useState<Fase>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [verificar, setVerificar] = useState(false);
  const o = cat.data ? ofertas(cat.data.items, bill, alvo) : null;
  const e = bill.entitlement; const sub = bill.subscription;
  const temPlano = comPlano(bill); const cortesia = ehCortesia(bill);
  const nivel = temPlano ? nivelDe(e.plan_sku, e.tier) : null;
  const verificado = !!st.link?.emailVerified;
  const sufixo = (i: ItemC, m: Moeda) => t(i.interval === 'year' ? 'rapida.porAno' : 'rapida.porMes', { preco: preco(precoEm(i, m), m) });

  const falhou = (x: unknown) => {
    if (x instanceof ApiError && x.code === 'email_unverified') { setVerificar(true); setMsg(null); return; }
    setMsg({ kind: 'error', text: erroConta(x, t) });
  };
  const fazer = async (acao: Acao, rotulo: string) => {
    if (!verificado) { setVerificar(true); return; }
    const p = passoDe(acao, bill);
    if (!p) return;
    setBusy(true); setMsg(null);
    try {
      if (p.tipo === 'mudanca') { setFase({ acao, passo: p, pv: await api.post<Preview>('/api/world/billing/change/preview', p.corpo), rotulo }); return; }
      setMsg({ kind: 'ok', text: t('rapida.indo') });
      const r = await api.post<{ url: string }>('/api/world/billing/checkout', { ...p.corpo, idempotencyKey: requestId() });
      location.assign(r.url);
    } catch (x) { falhou(x); } finally { setBusy(false); }
  };
  const confirmar = async () => {
    if (!fase) return;
    setBusy(true); setMsg(null);
    try {
      await api.post('/api/world/billing/change/confirm', { ...fase.passo.corpo, prorationDate: fase.pv.prorationDate, idempotencyKey: requestId() });
      setMsg({ kind: 'ok', text: fase.pv.upgrade ? t('plano.mudancaEnviada') : t('plano.mudancaAgendada') });
      setFase(null); emitLocal('world.changed');
    } catch (x) { falhou(x); } finally { setBusy(false); }
  };

  const linhaPlano = !temPlano ? t('selo.semPlano')
    : cortesia ? (e.effective_until ? t('plano.cortesiaAte', { dia: dia(e.effective_until) }) : t('plano.cortesia'))
      : sub?.cancelAt ? t('rapida.termina', { dia: dia(sub.cancelAt) })
        : sub?.periodEnd ? t('rapida.renova', { dia: dia(sub.periodEnd) }) : e.effective_until ? t('plano.pagoAte', { dia: dia(e.effective_until) }) : '';
  const pvMoeda = (fase?.pv.currency?.toUpperCase() as Moeda | undefined) ?? o?.moeda ?? 'BRL';

  return (
    <aside ref={ref} className="status-pop compra-pop" role="dialog" aria-labelledby="compra-titulo">
      <div className="drawer__head"><h3 className="drawer__title" id="compra-titulo">{t('rapida.titulo')}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={tg('geral.comum.fechar')} title={tg('geral.comum.fechar')}><Icon name="x" /></button></div>
      <div className={`compra-pop__heroi${nivel ? ` compra-pop__heroi--${nivel}` : ''}`}>
        <span className="compra-pop__plano"><ErgonMarca size={16} onDark /> {nivel ? nomeDoPlano(nivel) : t('selo.semPlano')}
          {cortesia && <span className="badge badge--cortesia">{t('plano.cortesia')}</span>}</span>
        {linhaPlano && temPlano && <span className="compra-pop__renova">{linhaPlano}</span>}
        <span className="compra-pop__saldo"><b>{saldoCurto(wallet?.available)}</b> <small>{t('rapida.disponiveis')}</small></span>
      </div>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {verificar && !verificado && <VerifyEmail onMsg={setMsg} onDone={() => { setVerificar(false); emitLocal('world.changed'); }} pedido={1} />}
      {!o ? <p className="muted small">…</p> : !o.pode ? <p className="hint compra-pop__peca"><Icon name="users" size={14} /> {t('rapida.peca')}</p> : fase ? (
        <div className="compra-pop__previa" role="status">
          <b>{fase.rotulo}</b>
          <p className="small">{fase.pv.upgrade ? twn('plano.cobrancaAgora', { valor: <b>{preco(fase.pv.amountDueCents, pvMoeda)}</b>, quando: fase.pv.effective }) : t('plano.semCobranca', { quando: fase.pv.effective })}</p>
          <div className="row">
            <button className="btn btn--gold" disabled={busy} onClick={() => void confirmar()}>{t('rapida.confirmar')}</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setFase(null)}>{t('rapida.voltar')}</button>
          </div>
        </div>
      ) : (
        <>
          {o.recargas.length > 0 && (
            <section className="compra-pop__bloco" aria-labelledby="compra-recarga">
              <h4 id="compra-recarga">{t('rapida.recarregar')}</h4>
              <div className="compra-pop__recargas">
                {o.recargas.map((r) => (
                  <button key={r.sku} className="compra-pop__pacote" disabled={busy} onClick={() => void fazer({ tipo: 'recarga', sku: r.sku }, r.name)}>
                    <b>{fmtDracmas(Number(r.dracmas ?? 0))}</b><small>{preco(precoEm(r, o.moeda), o.moeda)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {(o.pessoa || o.jobs) && (
            <section className="compra-pop__bloco compra-pop__dois">
              {o.pessoa && (
                <div>
                  <h4>{t('rapida.maisPessoas')}</h4>
                  <button className="compra-pop__pacote compra-pop__pacote--largo" disabled={busy} onClick={() => void fazer({ tipo: 'pessoa' }, t('rapida.pessoa'))}>
                    <b><Icon name="users" size={14} /> {t('rapida.pessoa')}</b><small>{sufixo(o.pessoa, o.moeda)}</small>
                  </button>
                </div>
              )}
              {o.jobs && (
                <div>
                  <h4>{t('rapida.maisJobs')}</h4>
                  <button className="compra-pop__pacote compra-pop__pacote--largo" disabled={busy} onClick={() => void fazer({ tipo: 'jobs' }, t('rapida.jobs'))}>
                    <b><Icon name="cloud" size={14} /> {t('rapida.jobs')}</b><small>{sufixo(o.jobs, o.moeda)}</small>
                  </button>
                </div>
              )}
            </section>
          )}
          <section className="compra-pop__bloco" aria-labelledby="compra-up">
            <h4 id="compra-up">{temPlano ? t('rapida.upgrade') : t('rapida.assinar')}</h4>
            {o.upgrade ? (() => {
              const up = o.upgrade; const n = nivelDe(up.sku, up.tier)!; const nomeUp = nomeDoPlano(n);
              return (
                <div className={`compra-pop__up compra-pop__up--${n}`}>
                  <div className="compra-pop__up-txt">
                    <b>{nomeUp}</b>
                    <span className="compra-pop__up-preco">{sufixo(up, o.moeda)}</span>
                    <small>{t('rapida.inclui', { pessoas: up.people ?? 0, dracmas: fmtDracmas(Number(up.monthlyDracmas ?? 0)), jobs: up.jobSlots ?? 0 })}</small>
                  </div>
                  <button className="btn btn--gold" disabled={busy} onClick={() => void fazer({ tipo: 'upgrade', sku: up.sku }, nomeUp)}>
                    {temPlano ? t('rapida.subirPara', { plano: nomeCurto(n) }) : t('rapida.assinarPlano', { plano: nomeCurto(n) })}
                  </button>
                </div>
              );
            })() : <p className="muted small">{t('rapida.topo')}</p>}
          </section>
        </>
      )}
      <a className="compra-pop__tudo" href="#world" onClick={onClose}><Icon name="globe" size={14} /> {t('rapida.tudo')} <Icon name="chevron-right" size={14} /></a>
    </aside>
  );
}

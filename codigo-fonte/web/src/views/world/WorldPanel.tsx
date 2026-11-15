import { useState } from 'react';
import { api, errMsg, requestId } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { Loading } from '../../brand/Brand.tsx';
import { ConnectForm, DeviceLimit, erroConta, type LoginLimit } from './WorldLinkDialog.tsx';
import { fmtData, fmtDataHora, fmtDracmas, fmtLista, fmtMoeda, fmtNumero } from '../../i18n/index.ts';
import { tw, twn, useTw, type ChaveWorld } from './textos.ts';
import { nomeDoWorkspace } from './nuvem-cartao.ts';

interface WorkspaceRef { workspaceId: string; label?: string | null; role: string; status: string; plan_sku: string | null }
/** o nome do workspace do World; o código curto só quando ele não tem nome */
const nomeWs = (w: WorkspaceRef): string => { const n = nomeDoWorkspace(w); return 'nome' in n ? n.nome : tw('vinculo.existente', { codigo: n.codigo }); };
interface LocalWs { id: string; name: string; current: boolean }
interface Link { accountEmail: string | null; emailVerified: boolean; deviceId: string; workspaces?: WorkspaceRef[]; boundWorkspaceId: string | null; boundWorkspaceName: string | null; currentIsBound: boolean }
interface Status { configured: boolean; service: string | null; me: { displayName: string }; deviceLimit: LoginLimit | null; link: Link | null; localWorkspaces: LocalWs[] }
interface Wallet { available: string; reserved: string; lots: Array<{ id: string; source: string; remaining: string; expiresAt: string | null; status: string }> }
interface Statement { entries: Array<{ id: string; kind: string; delta: string; amount: string; createdAt: string }> }
interface Item { sku: string; kind: string; name: string; priceCents: string | null; sellable: boolean; tier?: string | null; interval?: 'month' | 'year'; people?: number; jobSlots?: number; monthlyDracmas?: string; seatSku?: string; dracmas?: string | null; pending?: string[] }
interface Catalog { dracmaIssue: string; items: Item[] }
interface Ent { status: string; plan_sku: string | null; tier: string | null; people: number; job_slots: number; effective_until: string | null; grace_until: string | null }
interface Billing { workspaceId: string | null; role: string; entitlement: Ent; seatsUsed: number; subscription: { status: string; plan: string | null; periodEnd: string | null; cancelAt: string | null } | null; items: Array<{ sku: string; quantity: number }> }
interface Device { id: string; name: string; status: string; current: boolean; connected: boolean; lastSeenAt: string | null }
interface Preview { upgrade: boolean; prorationDate: number; amountDueCents: string; effective: string }
interface Budgets { manager: boolean; period: string | null; members: Array<{ accountId: string; role: string; name: string | null; email: string | null; me: boolean; cap: string | null; used: string }> }
type Msg = (m: { kind: 'ok' | 'error'; text: string } | null) => void;

const brl = (c: string | null | undefined) => (c == null ? tw('preco.aDefinir') : fmtMoeda(Number(c) / 100, 'BRL'));
const dr = (v: string) => fmtDracmas(Number(v));
const when = (iso: string | null) => (iso ? fmtDataHora(iso) : '—');
// i18n-ok: o nome do fuso de Salvador (o dos créditos), não é texto de tela; o dia do vencimento é o de lá, em qualquer idioma
const day = (iso: string | null) => (iso ? fmtData(iso, { dateStyle: 'short', timeZone: 'America/Bahia' }) : '—');
const LOT: Record<string, Extract<ChaveWorld, `lote.${string}`>> = { monthly: 'lote.monthly', purchased: 'lote.purchased', promo: 'lote.promo', refund: 'lote.refund', adjustment: 'lote.adjustment' };
const KIND: Record<string, Extract<ChaveWorld, `mov.${string}`>> = {
  grant: 'mov.grant', purchase: 'mov.purchase', hold: 'mov.hold', release: 'mov.release', capture: 'mov.capture', expiry: 'mov.expiry', refund: 'mov.refund',
  chargeback: 'mov.chargeback', adjustment: 'mov.adjustment', transfer: 'mov.transfer',
};
const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

/**
 * Configurações › Ergon World. Sem conta, o botão "Conectar ao Ergon World" (desligado, com o motivo, quando a
 * instalação não tem o endereço do World). Com conta: os aparelhos, qual workspace local é o do World (só ele tem o
 * plano e sincroniza) e, nesse workspace, o plano, os créditos, o Ergon AI e a sincronização. Preços e saldo vêm do
 * servidor; o navegador nunca decide valor.
 */
export default function WorldPanel() {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null); setBusy(true);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); st.reload(); } catch (e) { setMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  if (!st.data) return <Loading error={st.error} />;
  const s = st.data;
  if (!s.link) {
    return (
      <section className="card">
        <h3>{t('mundo.titulo')}</h3>
        {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
        <p className="muted">{t('mundo.texto')}</p>
        {s.deviceLimit ? <DeviceLimit limit={s.deviceLimit} onDone={() => { setMsg({ kind: 'ok', text: t('conta.conectada') }); st.reload(); }} />
          : form && s.configured ? <ConnectForm displayName={s.me.displayName} onDone={() => { setForm(false); setMsg({ kind: 'ok', text: t('conta.conectada') }); st.reload(); }} onCancel={() => setForm(false)} />
          : (
            <>
              <button className="btn btn--primary" disabled={!s.configured} onClick={() => setForm(true)}>{t('mundo.conectar')}</button>
              {!s.configured && <p className="muted small">{t('mundo.semEndereco')}</p>}
            </>
          )}
      </section>
    );
  }
  const l = s.link;
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <section className="card">
        <h3>{t('mundo.titulo')}</h3>
        <p>{twn('conta.conectado', { email: <b>{l.accountEmail ?? t('conta.suaConta')}</b> })}</p>
        {!l.emailVerified && <VerifyEmail onMsg={setMsg} onDone={st.reload} />}
        <Devices onMsg={setMsg} />
        <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.post('/api/world/unlink'), t('conta.desconectada'))}>{t('conta.desconectar')}</button>
      </section>
      <BindCard s={s} busy={busy} act={act} />
      {l.currentIsBound && <Linked onMsg={setMsg} mine={(l.workspaces ?? []).filter((w) => w.role === 'owner')} />}
    </>
  );
}

/** Confirmar o e-mail da conta com o código que o World enviou. */
function VerifyEmail({ onMsg, onDone }: { onMsg: Msg; onDone: () => void }) {
  const t = useTw();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (fn: () => Promise<unknown>, ok: string) => {
    onMsg(null); setBusy(true);
    try { await fn(); onMsg({ kind: 'ok', text: ok }); onDone(); } catch (e) { onMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  return (
    <div className="card card--inner">
      <p className="small">{t('email.confirmar')}</p>
      <div className="row row--wrap">
        <label className="field">{t('senha.codigo')}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value)} /></label>
      </div>
      <div className="row row--wrap">
        <button className="btn btn--sm" disabled={busy || !code.trim()} onClick={() => void go(() => api.post('/api/world/account/email/verify', { code: code.trim() }), t('email.confirmado'))}>{t('email.botao')}</button>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void go(() => api.post('/api/world/account/email/resend'), t('email.reenviado'))}>{t('email.reenviar')}</button>
      </div>
    </div>
  );
}

/**
 * Qual workspace local é o do World: um só. Ligado a um workspace novo no World ou a um que a conta já tem (criado em
 * outro computador: a sincronização dele entra depois, com a chave).
 */
function BindCard({ s, busy, act }: { s: Status; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const t = useTw();
  const l = s.link!;
  const cur = s.localWorkspaces.find((w) => w.current) ?? s.localWorkspaces[0];
  const [local, setLocal] = useState(cur?.id ?? '');
  const [remote, setRemote] = useState('');
  const remotes = (l.workspaces ?? []).filter((w) => w.role === 'owner');
  if (l.boundWorkspaceId) {
    return (
      <section className="card">
        <h3>{t('vinculo.titulo')}</h3>
        <p>{twn('vinculo.ligado', { nome: <b>{l.boundWorkspaceName ?? l.boundWorkspaceId}</b> })}</p>
        {!l.currentIsBound && <p className="muted small">{t('vinculo.abrir', { nome: l.boundWorkspaceName ?? l.boundWorkspaceId })}</p>}
        <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.del('/api/world/bind'), t('vinculo.desligado'))}>{t('vinculo.desligar')}</button>
      </section>
    );
  }
  return (
    <section className="card">
      <h3>{t('vinculo.titulo')}</h3>
      <p className="muted small">{t('vinculo.texto')}</p>
      {!s.localWorkspaces.length ? <p className="muted small">{t('vinculo.semWorkspace')}</p> : (
        <>
          <div className="row row--wrap">
            <label className="field">{t('vinculo.local')}
              <select value={local} onChange={(ev) => setLocal(ev.target.value)}>{s.localWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            </label>
            <label className="field">{t('vinculo.world')}
              <select value={remote} onChange={(ev) => setRemote(ev.target.value)}>
                <option value="">{t('vinculo.novo')}</option>
                {remotes.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{nomeWs(w)}{w.plan_sku ? ` · ${w.plan_sku.replace('world_', '')}` : ''}</option>)}
              </select>
            </label>
          </div>
          <button className="btn btn--primary" disabled={busy || !local} onClick={() => void act(() => api.post('/api/world/bind', { workspaceId: local, syncWorkspaceId: remote || null }), t('vinculo.ligadoMsg'))}>{t('vinculo.ligar')}</button>
        </>
      )}
    </section>
  );
}

/** Aparelhos da conta: até 4 cadastrados e 2 com sessão ao mesmo tempo; a sessão de outro pode ser encerrada daqui. */
function Devices({ onMsg }: { onMsg: Msg }) {
  const t = useTw();
  const d = useResource<Device[]>('/api/world/devices', []);
  const [busy, setBusy] = useState(false);
  const list = (d.data ?? []).filter((x) => x.status === 'active');
  if (!list.length) return null;
  const end = async (x: Device) => {
    onMsg(null); setBusy(true);
    try { await api.post(`/api/world/devices/${x.id}/end-sessions`, {}); onMsg({ kind: 'ok', text: t('aparelhos.encerrada', { nome: x.name }) }); d.reload(); }
    catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <details>
      <summary>{t('aparelhos.resumo', { cadastrados: list.length, conectados: list.filter((x) => x.connected).length })}</summary>
      <ul className="sec-rows small">
        {list.map((x) => (
          <li key={x.id}>
            <span>{x.name}{x.current ? ` · ${t('aparelhos.este')}` : ''}<span className="muted"> · {x.connected ? t('aparelhos.usadoEm', { quando: when(x.lastSeenAt) }) : t('aparelhos.semSessao')}</span></span>
            {!x.current && x.connected && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void end(x)}>{t('aparelhos.encerrar')}</button>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Linked({ onMsg, mine }: { onMsg: Msg; mine: WorkspaceRef[] }) {
  const t = useTw();
  const wsw = useResource<Wallet>('/api/world/wallet', []);
  const stmt = useResource<Statement>('/api/world/wallet/statement', []);
  const cat = useResource<Catalog>('/api/world/catalog', []);
  const bill = useResource<Billing>('/api/world/billing', []);
  const [busy, setBusy] = useState(false);
  const [aiDefault, setAiDefault] = useState(false);
  const go = async (fn: () => Promise<unknown>, ok?: string) => {
    onMsg(null); setBusy(true);
    try { await fn(); if (ok) onMsg({ kind: 'ok', text: ok }); wsw.reload(); bill.reload(); stmt.reload(); } catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const checkout = (sku: string) => go(async () => { const r = await api.post<{ url: string }>('/api/world/billing/checkout', { sku, idempotencyKey: requestId() }); location.assign(r.url); });
  const topups = cat.data?.items.filter((i) => i.kind === 'topup') ?? [];
  const owner = bill.data?.role === 'owner';
  const others = mine.filter((w) => w.workspaceId !== bill.data?.workspaceId);
  return (
    <>
      <PlanCard cat={cat.data} bill={bill.data} busy={busy} go={go} checkout={checkout} />
      <section className="card">
        <h3>{t('creditos.titulo')}</h3>
        <p className="muted small">{t('creditos.texto')}</p>
        {wsw.data ? (
          <>
            <p className="big">{dr(wsw.data.available)} <span className="muted small">{t('creditos.disponivel')}{Number(wsw.data.reserved) > 0 ? ` · ${t('creditos.reservadoAgora', { valor: dr(wsw.data.reserved) })}` : ''}</span></p>
            <p className="muted small">{t('creditos.franquia')}</p>
            <ul className="sec-rows">{wsw.data.lots.filter((l) => Number(l.remaining) > 0).map((l) => <li key={l.id}><b>{dr(l.remaining)}</b><span className="muted small">{LOT[l.source] ? t(LOT[l.source]) : l.source} · {l.expiresAt ? t('creditos.valeAte', { dia: day(l.expiresAt) }) : t('creditos.naoVence')}</span></li>)}</ul>
            {owner || !bill.data?.workspaceId
              ? <div className="row row--wrap">{topups.map((x) => <button key={x.sku} className="btn btn--sm" disabled={busy || !x.sellable} title={x.sellable ? '' : t('creditos.semPreco')} onClick={() => void checkout(x.sku)}>{x.name}</button>)}</div>
              : <p className="muted small">{t('creditos.quemRecarrega')}</p>}
            {owner && others.length > 0 && <Transfer others={others} busy={busy} go={go} />}
          </>
        ) : <Loading error={wsw.error} />}
        {stmt.data && stmt.data.entries.length > 0 && (
          <details><summary>{t('creditos.extrato')}</summary>
            <ul className="sec-rows small">{stmt.data.entries.slice(0, 30).map((x) => <li key={x.id}><span>{KIND[x.kind] ? t(KIND[x.kind]) : x.kind}</span><span className="muted">{x.kind === 'capture' ? `-${dr(x.amount)}` : Number(x.delta) !== 0 ? dr(x.delta) : ''} · {when(x.createdAt)}</span></li>)}</ul>
          </details>
        )}
        {bill.data?.workspaceId && <BudgetsCard onMsg={onMsg} />}
      </section>
      <section className="card">
        <h3>{t('ia.titulo')}</h3>
        <p className="muted">{t('ia.texto')}</p>
        <label className="check"><input type="checkbox" checked={aiDefault} onChange={(ev) => setAiDefault(ev.target.checked)} /> {t('ia.padrao')}</label>
        <button className="btn btn--primary" disabled={busy} onClick={() => void go(() => api.post('/api/world/ai/connect', { makeDefault: aiDefault }), t('ia.ligado'))}>{t('ia.usar')}</button>
      </section>
      <SyncCard onMsg={onMsg} />
    </>
  );
}

/** Transferir créditos para outro workspace seu: passa só o disponível, com a mesma origem e o mesmo vencimento. */
function Transfer({ others, busy, go }: { others: WorkspaceRef[]; busy: boolean; go: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const t = useTw();
  const [to, setTo] = useState(others[0]?.workspaceId ?? '');
  const [amount, setAmount] = useState('');
  const valid = /^\d{1,9}([.,]\d{1,2})?$/.test(amount.trim()) && Number(amount.replace(',', '.')) > 0;
  return (
    <details>
      <summary>{t('transferir.titulo')}</summary>
      <div className="row row--wrap">
        <label className="field">{t('transferir.para')}<select value={to} onChange={(ev) => setTo(ev.target.value)}>{others.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{nomeWs(w)}{w.plan_sku ? ` · ${w.plan_sku.replace('world_', '').replace('_annual', ` ${t('transferir.anual')}`)}` : ` · ${t('transferir.semPlano')}`}</option>)}</select></label>
        <label className="field">{t('transferir.dracmas')}<input inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="500" /></label>
      </div>
      <p className="muted small">{t('transferir.texto')}</p>
      <button className="btn" disabled={busy || !valid || !to} onClick={() => void go(() => api.post('/api/world/wallet/transfer', { toWorkspaceId: to, dracmas: amount.trim().replace(',', '.'), idempotencyKey: requestId() }), t('transferir.feito', { valor: dr(amount.replace(',', '.')) }))}>{t('transferir.botao')}</button>
    </details>
  );
}

/** Teto por pessoa: quem gerencia (dono ou admin) define um teto mensal ou deixa livre; cada pessoa vê o seu. */
function BudgetsCard({ onMsg }: { onMsg: Msg }) {
  const t = useTw();
  const b = useResource<Budgets>('/api/world/budgets', []);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!b.data || !b.data.members.length) return null;
  const save = async (accountId: string, cap: string | null) => {
    onMsg(null); setBusy(true);
    try { await api.put(`/api/world/budgets/${accountId}`, { capDracmas: cap }); onMsg({ kind: 'ok', text: cap === null ? t('teto.livreMsg') : t('teto.definido', { valor: dr(cap) }) }); b.reload(); }
    catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <details>
      <summary>{t('teto.resumo', { periodo: b.data.period ?? t('plano.porMesSufixo') })}</summary>
      <ul className="sec-rows small">
        {b.data.members.map((m) => (
          <li key={m.accountId}>
            <span>{m.name ?? m.email ?? t('teto.pessoa')}{m.me ? ` ${t('teto.voce')}` : ''}<span className="muted"> · {t('teto.usou', { valor: dr(m.used) })} · {m.cap === null ? t('teto.livre') : t('teto.teto', { valor: dr(m.cap) })}</span></span>
            {b.data!.manager && (
              <span className="row">
                <input style={{ width: '7em' }} inputMode="decimal" aria-label={t('teto.tetoDe', { nome: m.name ?? t('teto.pessoa') })} placeholder={t('teto.placeholder')} value={edit[m.accountId] ?? ''} onChange={(ev) => setEdit({ ...edit, [m.accountId]: ev.target.value })} />
                <button className="btn btn--sm" disabled={busy || !/^\d{1,9}([.,]\d{1,2})?$/.test((edit[m.accountId] ?? '').trim())} onClick={() => void save(m.accountId, (edit[m.accountId] ?? '').trim().replace(',', '.'))}>{t('teto.definir')}</button>
                {m.cap !== null && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void save(m.accountId, null)}>{t('teto.deixarLivre')}</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Plano do World deste workspace. Sem plano: os três níveis, mensal ou anual (10% de desconto à vista). Com plano: o que
 * ele dá, pessoas adicionais e pacotes de Jobs (sempre mensais), troca de plano com prévia exata e cancelamento.
 */
function PlanCard({ cat, bill, busy, go, checkout }: { cat: Catalog | null; bill: Billing | null; busy: boolean; go: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; checkout: (sku: string) => Promise<void> }) {
  const t = useTw();
  const [annual, setAnnual] = useState(false);
  const [want, setWant] = useState<{ plan?: string; seats?: number; jobPacks?: number }>({});
  const [pv, setPv] = useState<Preview | null>(null);
  if (!cat || !bill) return <section className="card"><h3>{t('plano.titulo')}</h3><Loading /></section>;
  const plans = cat.items.filter((i) => i.kind === 'plan');
  const addon = (sku: string | undefined) => cat.items.find((i) => i.sku === sku);
  const e = bill.entitlement; const sub = bill.subscription;
  const cur = plans.find((p) => p.sku === e.plan_sku);
  const live = !!sub && LIVE.includes(sub.status) && bill.role === 'owner';
  const qty = (pred: (sku: string) => boolean) => bill.items.filter((i) => pred(i.sku)).reduce((n, i) => Math.max(n, i.quantity), 0);
  const seats = qty((s) => s.startsWith('addon_seat_')); const packs = qty((s) => s === 'addon_jobs_5');
  const ask = (x: typeof want) => go(async () => { setWant(x); setPv(await api.post<Preview>('/api/world/billing/change/preview', x)); });
  const confirm = () => go(async () => { await api.post('/api/world/billing/change/confirm', { ...want, prorationDate: pv!.prorationDate, idempotencyKey: requestId() }); setPv(null); setWant({}); },
    pv?.upgrade ? t('plano.mudancaEnviada') : t('plano.mudancaAgendada'));
  return (
    <section className="card">
      <h3>{t('plano.titulo')}</h3>
      {e.status === 'grace' && <p className="error" role="alert">{t('plano.recusado', { dia: day(e.grace_until) })}</p>}
      {cur && ['active', 'grace'].includes(e.status) ? (
        <p><b>{cur.name}</b> · {e.status === 'active' ? t('plano.pagoAte', { dia: day(e.effective_until) }) : t('plano.emTolerancia')} · {t('plano.vagas', { n: e.people, usadas: bill.seatsUsed })} {t('plano.contandoDono')} · {t('plano.jobsAoMesmoTempo', { n: e.job_slots })} · {t('plano.porMes', { valor: dr(cur.monthlyDracmas ?? '0') })}</p>
      ) : e.status === 'expired' ? <p className="muted">{t('plano.terminou')}</p> : null}
      {cur && ['active', 'grace'].includes(e.status) && bill.role === 'owner' && <UpgradeTip ws={bill.workspaceId ?? ''} cur={cur} people={Math.max(e.people, bill.seatsUsed)} plans={plans} addon={addon} />}
      <p className="muted small">{t('plano.texto')}</p>
      {bill.role !== 'owner' && <p className="muted small">{t('plano.quemCuida')}</p>}
      {bill.role === 'owner' && !live && (
        <>
          <div className="row row--wrap" role="group" aria-label={t('plano.periodo')}>
            <button className={`btn btn--sm${annual ? ' btn--ghost' : ''}`} aria-pressed={!annual} onClick={() => setAnnual(false)}>{t('plano.mensal')}</button>
            <button className={`btn btn--sm${annual ? '' : ' btn--ghost'}`} aria-pressed={annual} onClick={() => setAnnual(true)}>{t('plano.anual')}</button>
          </div>
          <div className="row row--wrap">
            {plans.filter((p) => (p.interval === 'year') === annual).map((p) => (
              <div key={p.sku} className="card card--inner">
                <b>{p.name}</b>
                <p className="big">{brl(p.priceCents)}<span className="muted small"> {annual ? t('plano.porAnoSufixo') : t('plano.porMesSufixo')}</span></p>
                <ul className="small">
                  <li>{t('plano.pessoas', { n: p.people ?? 1, preco: brl(addon(p.seatSku)?.priceCents) })}</li>
                  <li>{t('plano.creditoMes', { valor: dr(p.monthlyDracmas ?? '0') })}{annual ? ` ${t('plano.chegamMes')}` : ''}</li>
                  <li>{t('plano.jobsRemotos', { n: p.jobSlots ?? 0 })}</li>
                </ul>
                <button className="btn btn--primary" disabled={busy || !p.sellable} title={p.sellable ? '' : t('creditos.semPreco')} onClick={() => void checkout(p.sku)}>{t('plano.assinar')}</button>
              </div>
            ))}
          </div>
        </>
      )}
      {live && (
        <>
          <div className="row row--wrap">
            <label className="field">{t('plano.pessoasAdicionais', { preco: brl(addon(cur ? `addon_seat_${cur.tier}` : undefined)?.priceCents) })}
              <input type="number" min={0} max={1000} defaultValue={seats} onChange={(ev) => setWant({ seats: Math.max(0, Number(ev.target.value) || 0) })} />
            </label>
            <label className="field">{t('plano.pacotesJobs', { preco: brl(addon('addon_jobs_5')?.priceCents) })}
              <input type="number" min={0} max={1000} defaultValue={packs} onChange={(ev) => setWant({ jobPacks: Math.max(0, Number(ev.target.value) || 0) })} />
            </label>
            <label className="field">{t('plano.trocar')}
              <select defaultValue="" onChange={(ev) => setWant(ev.target.value ? { plan: ev.target.value } : {})}>
                <option value="">—</option>
                {plans.filter((p) => p.sku !== cur?.sku && !(cur?.interval === 'year' && p.interval === 'month')).map((p) => <option key={p.sku} value={p.sku}>{p.interval === 'year' ? t('plano.opcaoAno', { nome: p.name, preco: brl(p.priceCents) }) : t('plano.opcaoMes', { nome: p.name, preco: brl(p.priceCents) })}</option>)}
              </select>
            </label>
          </div>
          <div className="row row--wrap">
            <button className="btn" disabled={busy || !Object.keys(want).length} onClick={() => void ask(want)}>{t('plano.verValor')}</button>
            <button className="btn" disabled={busy} onClick={() => void go(async () => { const r = await api.post<{ url: string }>('/api/world/billing/portal'); location.assign(r.url); })}>{t('plano.cartao')}</button>
            {sub!.cancelAt ? <span className="muted small">{t('plano.terminaEm', { dia: day(sub!.cancelAt) })}</span>
              : <button className="btn btn--ghost" disabled={busy} onClick={() => void go(() => api.post('/api/world/billing/cancel', { idempotencyKey: requestId() }), t('plano.cancelado'))}>{t('plano.cancelar')}</button>}
          </div>
          {pv && (
            <div className="card card--inner" role="status">
              <p>{pv.upgrade ? twn('plano.cobrancaAgora', { valor: <b>{brl(pv.amountDueCents)}</b>, quando: pv.effective }) : t('plano.semCobranca', { quando: pv.effective })}</p>
              <div className="row"><button className="btn btn--primary" disabled={busy} onClick={() => void confirm()}>{t('confirmar')}</button><button className="btn btn--ghost" disabled={busy} onClick={() => setPv(null)}>{t('agoraNao')}</button></div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface SyncStatus { bound: boolean; enabled: boolean; syncWorkspaceId?: string | null; origin?: 'created' | 'joined' | null; lastVersion?: number; conflicts?: number }
interface Side { title: string; column?: string; agent?: string | null; completed?: boolean; dueOn?: string | null }
interface Conflict { id: string; kind: 'task' | 'conversation'; since: string; mine: Side | null; theirs: Side | null }
interface Pulled { preview: { agents?: Array<{ name: string }>; coordinator?: { from: string; to: string } | null } | null; incoming: { tasks: number; conversations: number; messages: number } }

// o prazo é um dia (AAAA-MM-DD), sem hora: ao meio-dia, para nenhum fuso mudar o dia
const side = (x: Side | null) => (!x ? tw('sync.naoExiste') : [x.title, x.column, x.agent ? tw('sync.com', { nome: x.agent }) : null, x.completed ? tw('sync.concluida') : null,
  x.dueOn ? tw('sync.prazo', { data: fmtData(`${x.dueOn}T12:00:00`) }) : null].filter(Boolean).join(' · '));
/** "2 tarefas, 1 conversa e 3 mensagens" (as três sempre, como antes) */
const contagem = (c: { tasks: number; conversations: number; messages: number }) =>
  fmtLista([tw('sync.tarefas', { n: c.tasks }), tw('sync.conversas', { n: c.conversations }), tw('sync.mensagens', { n: c.messages })]);
/** O que muda na equipe com o que chegou: agentes novos e, se for o caso, quem passa a coordenar. */
const equipeLinha = (novos: number, coord: { from: string; to: string } | null) => {
  const resumo = novos ? tw('sync.agentesNovos', { n: novos }) : tw('sync.semAgentesNovos');
  return coord ? tw('sync.equipeCoordenacao', { resumo, de: coord.from, para: coord.to }) : tw('sync.equipe', { resumo });
};

/**
 * Sincronizar aparelhos (World Sync): a equipe, as tarefas dos quadros do Ergon e as conversas da pessoa vão cifradas
 * para os outros computadores dela. Receber mostra antes o que chegou; o que mudou dos dois lados vira uma escolha.
 */
function SyncCard({ onMsg }: { onMsg: (m: { kind: 'ok' | 'error'; text: string } | null) => void }) {
  const t = useTw();
  const st = useResource<SyncStatus>('/api/world/sync', []);
  const cf = useResource<Conflict[]>('/api/world/sync/conflicts', []);
  const [phrase, setPhrase] = useState('');
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (fn: () => Promise<string | void>) => {
    onMsg(null); setBusy(true);
    try { const ok = await fn(); if (ok) onMsg({ kind: 'ok', text: ok }); st.reload(); cf.reload(); } catch (e) { onMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  const withPhrase = () => (phrase.trim().length >= 20 ? { recoveryPhrase: phrase.trim() } : {});
  if (!st.data) return <Loading error={st.error} />;
  const s = st.data;
  const n = pulled?.incoming; const team = pulled?.preview?.agents?.length ?? 0;
  return (
    <section className="card">
      <h3>{t('sync.titulo')}</h3>
      {!s.enabled ? (
        <>
          <p className="muted">{s.origin === 'joined' ? t('sync.entrarTexto') : t('sync.texto')}</p>
          <label className="field">{t('sync.frase')}<input type="password" autoComplete="new-password" value={phrase} onChange={(ev) => setPhrase(ev.target.value)} /></label>
          {s.origin !== 'joined' && <p className="muted small">{t('sync.fraseTexto')}</p>}
          {s.origin === 'joined'
            ? <button className="btn btn--primary" disabled={busy || (phrase.length > 0 && phrase.trim().length < 20)} onClick={() => void go(async () => { await api.post('/api/world/sync/join', withPhrase()); return t('sync.entrou'); })}>{t('sync.entrar')}</button>
            : <button className="btn btn--primary" disabled={busy || (phrase.length > 0 && phrase.trim().length < 20)} onClick={() => void go(async () => { await api.post('/api/world/sync/enable', withPhrase()); return t('sync.ligadaMsg'); })}>{t('sync.ligar')}</button>}
        </>
      ) : (
        <>
          <p>{t('sync.ligada')} <span className="muted small">{twn('sync.codigoVersao', { codigo: <code>{s.syncWorkspaceId}</code>, versao: s.lastVersion ?? 0 })}</span></p>
          <p className="muted small">{t('sync.tarefaChega')}</p>
          <div className="row row--wrap">
            <button className="btn" disabled={busy} onClick={() => void go(async () => { const r = await api.post<Pulled>('/api/world/sync/pull', {}); setPulled(r); if (!r.preview && !r.incoming.tasks && !r.incoming.conversations && !r.incoming.messages) return t('sync.nadaNovo'); })}>{t('sync.verChegou')}</button>
            <button className="btn btn--primary" disabled={busy} onClick={() => void go(async () => {
              const r = await api.post<{ version: number; sent: { tasks: number; conversations: number; messages: number } }>('/api/world/sync/push');
              const total = r.sent.tasks + r.sent.conversations + r.sent.messages;
              return total ? t('sync.enviado', { itens: contagem(r.sent) }) : t('sync.tudoNoWorld');
            })}>{t('sync.enviar')}</button>
            <button className="btn btn--ghost" disabled={busy} title={t('sync.autorizarDica')} onClick={() => void go(async () => { const r = await api.post<{ shared: number }>('/api/world/sync/share'); return r.shared ? t('sync.autorizados', { n: r.shared }) : t('sync.nenhumEsperando'); })}>{t('sync.autorizar')}</button>
          </div>
          {pulled && n && (pulled.preview || n.tasks || n.conversations || n.messages) ? (
            <div className="card card--inner">
              <b>{t('sync.chegou')}</b>
              <ul className="small">
                {pulled.preview && <li>{equipeLinha(team, pulled.preview.coordinator ?? null)}</li>}
                {(n.tasks > 0 || n.conversations > 0 || n.messages > 0) && <li>{contagem(n)}</li>}
              </ul>
              <p className="muted small">{t('sync.nadaMuda')}</p>
              <div className="row row--wrap">
                <button className="btn btn--primary" disabled={busy} onClick={() => void go(async () => {
                  const r = await api.post<{ result?: { added: number; updated: number }; conflicts?: number }>('/api/world/sync/pull', { apply: true }); setPulled(null);
                  const novos = t('sync.novos', { n: r.result?.added ?? 0 }); const atualizados = t('sync.atualizados', { n: r.result?.updated ?? 0 });
                  return r.conflicts ? t('sync.recebidoConflitos', { novos, atualizados, conflitos: fmtNumero(r.conflicts) }) : t('sync.recebido', { novos, atualizados });
                })}>{t('sync.receber')}</button>
                <button className="btn btn--ghost" disabled={busy} onClick={() => setPulled(null)}>{t('agoraNao')}</button>
              </div>
            </div>
          ) : null}
          {cf.data && cf.data.length > 0 && (
            <div className="card card--inner">
              <b>{t('sync.conflitoTitulo')}</b>
              <ul className="sec-rows">
                {cf.data.map((c) => (
                  <li key={c.id}>
                    <span className="small">{c.kind === 'task' ? t('sync.tarefa') : t('sync.conversa')} · <b>{t('sync.aqui')}</b> {side(c.mine)}<br /><b>{t('sync.noOutro')}</b> {side(c.theirs)}</span>
                    <span className="row">
                      <button className="btn btn--sm" disabled={busy} onClick={() => void go(async () => { await api.post(`/api/world/sync/conflicts/${c.id}`, { keep: 'mine' }); return t('sync.ficaDaqui'); })}>{t('sync.manterDaqui')}</button>
                      <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void go(async () => { await api.post(`/api/world/sync/conflicts/${c.id}`, { keep: 'theirs' }); return t('sync.ficouOutro'); })}>{t('sync.ficarOutro')}</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Recomendação de upgrade (decisão do dono): com 2 pessoas no Sync ou 5 no Pro, mostra quanto custaria o nível de
 * cima; só sugere, nunca bloqueia vaga nem uso, e quem dispensa não vê mais (neste navegador, para este workspace).
 */
function UpgradeTip({ ws, cur, people, plans, addon }: { ws: string; cur: Item; people: number; plans: Item[]; addon: (sku: string | undefined) => Item | undefined }) {
  const t = useTw();
  const key = `ergon.world.upgrade.${ws}.${cur.tier}`;
  const [gone, setGone] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const next = cur.tier === 'sync' && people >= 2 ? 'pro' : cur.tier === 'pro' && people >= 5 ? 'team' : null;
  const up = plans.find((p) => p.tier === next && p.interval === cur.interval);
  if (gone || !next || !up) return null;
  const cost = (p: Item) => Number(p.priceCents) + Math.max(0, people - (p.people ?? 0)) * Number(addon(p.seatSku)?.priceCents ?? 0) * (p.interval === 'year' ? 12 : 1);
  const per = cur.interval === 'year' ? t('plano.porAnoSufixo') : t('plano.porMesSufixo');
  const dismiss = () => { setGone(true); try { localStorage.setItem(key, '1'); } catch { /* sem armazenamento: some só agora */ } };
  return (
    <div className="card card--inner" role="note">
      <p className="small">{twn('plano.dica', { pessoas: people, plano: <b>{up.name}</b>, custo: brl(String(cost(up))), periodo: per, incluidas: up.people ?? 0, credito: dr(up.monthlyDracmas ?? '0'), jobs: up.jobSlots ?? 0, custoAtual: brl(String(cost(cur))) })}</p>
      <button className="btn btn--sm btn--ghost" onClick={dismiss}>{t('plano.dispensar')}</button>
    </div>
  );
}

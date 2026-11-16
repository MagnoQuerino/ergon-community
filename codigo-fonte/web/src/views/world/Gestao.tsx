import { useEffect, useState, type ReactNode } from 'react';
import { api, errMsg, requestId } from '../../lib/api.ts';
import { emitLocal, useResource } from '../../lib/live.ts';
import { Loading } from '../../brand/Brand.tsx';
import { Icon } from '../../components/Icon.tsx';
import { erroConta, type LoginLimit } from './WorldLinkDialog.tsx';
import { fmtData, fmtDataHora, fmtDracmas, fmtLista, fmtMoeda, fmtNumero } from '../../i18n/index.ts';
import { tw, twn, useTw, type ChaveWorld } from './textos.ts';
import { detalheDoResumo, linhaDoResumo, nomeDoWorkspace, type ResumoFora } from './nuvem-cartao.ts';
import { WsCard } from '../../components/WsCard.tsx';
import type { AiStatus } from '../../lib/types.ts';
import { administra, codigoValido, inicial, limparCodigo, papeisDoConvite, papeisPara, podeTirar, podeTransferir, vagas, type Membros, type Papel, type Pessoa } from './pessoas.ts';
import { anualDe, atualDe, CHAVE_PENDENTE, jobsDe, passos, somaDoCatalogo, vagaDe, VAZIO, vazio, type Carrinho as Cesta, type Passo } from './carrinho.ts';
import AlaNuvem from './AlaNuvem.tsx';

/*
 * A gestão do workspace do Ergon World, mostrada na página do Ergon World (MundoView): os workspaces (qual fica no
 * World), o plano com o carrinho, as pessoas e os papéis (convites, papéis, tetos, titularidade), os Dracmas (saldo,
 * extrato, recarga e recarga automática), a nuvem (cartões, recuperação, sincronia) e o Ergon AI. A conta e os
 * aparelhos ficam em Configurações › Ergon World (WorldPanel). Preços e saldo vêm do World; o navegador nunca decide valor.
 */

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
export type { Status as StatusWorld, Billing as BillingWorld, Catalog as CatalogoWorld, Item as ItemWorld };

/** A mensagem de cada seção (ok ou erro), no topo dela. */
function useMsg() {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const el = msg ? <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p> : null;
  return [setMsg as Msg, el] as const;
}
/** Executa uma ação com ocupado, mensagem de sucesso e o erro no idioma da tela. */
function useAcao(onMsg: Msg, depois?: () => void) {
  const [busy, setBusy] = useState(false);
  const t = useTw();
  const go = async (fn: () => Promise<unknown>, ok?: string) => {
    onMsg(null); setBusy(true);
    try { await fn(); if (ok) onMsg({ kind: 'ok', text: ok }); depois?.(); } catch (e) { onMsg({ kind: 'error', text: erroConta(e, t) }); } finally { setBusy(false); }
  };
  return [busy, go] as const;
}

// ---------------------------------------------------------------- Workspaces
/**
 * Qual workspace local é o do World: um só, escolhido entre os cartões dos workspaces deste computador (a cidade de
 * cada um, onde está, plano e sincronia). Ligado a um workspace novo no World ou a um que a conta já tem (criado em outro
 * computador: a sincronização dele entra depois, com a chave).
 */
export function BindCard({ s, busy, act }: { s: Status; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const t = useTw();
  const l = s.link!;
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [remote, setRemote] = useState('');
  // os do World em que a pessoa está (dela ou em que entrou por convite), ainda sem workspace deste computador ligado
  const remotes = l.workspaces ?? [];
  const bill = useResource<{ entitlement: { status: string; plan_sku: string | null } }>(l.currentIsBound ? '/api/world/billing' : null, []);
  const sync = useResource<SyncStatus>(l.currentIsBound ? '/api/world/sync' : null, []);
  const cat = useResource<Catalog>(l.currentIsBound ? '/api/world/catalog' : null, []);
  const plano = bill.data?.entitlement.plan_sku && ['active', 'grace'].includes(bill.data.entitlement.status)
    ? cat.data?.items.find((i) => i.sku === bill.data!.entitlement.plan_sku)?.name ?? bill.data.entitlement.plan_sku : null;
  const ligar = (id: string, syncWorkspaceId: string | null) => act(() => api.post('/api/world/bind', { workspaceId: id, syncWorkspaceId }), t('vinculo.ligadoMsg'));
  const abrir = (id: string) => act(async () => { await api.post('/api/session/workspace', { workspaceId: id }); window.location.reload(); });
  return (
    <div className="painel-ws">
      {!l.boundWorkspaceId && <p className="muted small">{t('vinculo.escolher')}</p>}
      {l.boundWorkspaceId && !l.currentIsBound && <p className="muted small">{t('vinculo.abrir', { nome: l.boundWorkspaceName ?? l.boundWorkspaceId })}</p>}
      {!s.localWorkspaces.length ? <p className="muted small">{t('vinculo.semWorkspace')}</p> : (
        <div className="ws-cards">
          {s.localWorkspaces.map((w) => {
            const ligado = l.boundWorkspaceId === w.id;
            return (
              <WsCard key={w.id} id={w.id} nome={w.name} atual={w.current} escolhido={escolhido === w.id}
                selos={<>
                  {w.current && <span className="badge badge--atual">{t('vinculo.aberto')}</span>}
                  {ligado ? <span className="badge badge--world">{t('vinculo.seloWorld')}</span> : <span className="badge">{t('vinculo.seloLocal')}</span>}
                  {ligado && w.current && bill.data && <span className={`badge ${plano ? 'badge--ok' : ''}`}>{plano ?? t('vinculo.semPlano')}</span>}
                  {ligado && w.current && sync.data && <span className="badge">{sync.data.enabled ? t('vinculo.syncLigada') : t('vinculo.syncDesligada')}</span>}
                </>}
                acoes={escolhido === w.id ? null : <>
                  {!w.current && <button className="btn btn--sm" disabled={busy} onClick={() => void abrir(w.id)}>{t('vinculo.abrirWs')}</button>}
                  {ligado && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void act(() => api.del('/api/world/bind'), t('vinculo.desligado'))}>{t('vinculo.desligar')}</button>}
                  {!l.boundWorkspaceId && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => (remotes.length ? (setEscolhido(w.id), setRemote('')) : void ligar(w.id, null))}>{t('vinculo.ligarEste')}</button>}
                </>}>
                {escolhido === w.id && (
                  <div className="ws-card__destino" role="radiogroup" aria-label={t('vinculo.destino')}>
                    <span className="small muted">{t('vinculo.destino')}</span>
                    <label className="ws-card__opcao"><input type="radio" name={`destino-${w.id}`} checked={remote === ''} onChange={() => setRemote('')} /> {t('vinculo.novo')}</label>
                    {remotes.map((r) => (
                      <label key={r.workspaceId} className="ws-card__opcao"><input type="radio" name={`destino-${w.id}`} checked={remote === r.workspaceId} onChange={() => setRemote(r.workspaceId)} />
                        {nomeWs(r)} <span className={`badge ${r.plan_sku ? 'badge--ok' : ''}`}>{r.plan_sku ? r.plan_sku.replace('world_', '') : t('vinculo.semPlano')}</span></label>
                    ))}
                    <div className="ws-card__acoes">
                      <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void ligar(w.id, remote || null).then(() => setEscolhido(null))}>{t('vinculo.ligar')}</button>
                      <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEscolhido(null)}>{t('vinculo.cancelar')}</button>
                    </div>
                  </div>
                )}
              </WsCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Pessoas e papéis
const PAPEIS: Record<Papel, Extract<ChaveWorld, `papel.${string}`>> = { owner: 'papel.owner', admin: 'papel.admin', editor: 'papel.editor', viewer: 'papel.viewer' };
const nomeDe = (p: Pick<Pessoa, 'name' | 'email'>) => p.name?.trim() || p.email || tw('pessoas.semNome');

/**
 * Pessoas no World: cada pessoa num cartão (inicial, nome, papel, "você", desde quando, o teto de Dracmas e o uso do
 * mês), com o seletor de papel e "Tirar" só para quem pode; os convites esperando, com "Cancelar"; criar convite com o
 * papel (o código para mandar, com copiar); e, para o dono, transferir a titularidade com confirmação forte. Quem não
 * administra vê a lista só para ler. O World confere tudo de novo.
 */
export function PessoasPainel({ nomeWorkspace }: { nomeWorkspace?: string | null }) {
  const t = useTw();
  const m = useResource<Membros>('/api/world/members', []);
  const b = useResource<Budgets>('/api/world/budgets', []);
  const sync = useResource<SyncStatus>('/api/world/sync', []);
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, () => { m.reload(); b.reload(); sync.reload(); });
  const [papelNovo, setPapelNovo] = useState<Papel>('editor');
  const [codigo, setCodigo] = useState<{ token: string; expiresAt: string } | null>(null);
  const [tirando, setTirando] = useState<string | null>(null);
  const [saiu, setSaiu] = useState<Tirada | null>(null);
  const [teto, setTeto] = useState<Record<string, string>>({});
  if (!m.data) return <Loading error={m.error} />;
  const d = m.data; const eu = d.myRole;
  const adm = administra(eu);
  const v = vagas(d);
  const conv = papeisDoConvite(eu);
  const budget = (id: string) => b.data?.members.find((x) => x.accountId === id);
  const espera = new Set(d.awaitingKey ?? []);
  const convidar = () => go(async () => { setCodigo(await api.post<{ token: string; expiresAt: string }>('/api/world/members/invites', { role: conv.includes(papelNovo) ? papelNovo : conv[0] })); });
  const copiar = async () => { try { await navigator.clipboard.writeText(codigo!.token); onMsg({ kind: 'ok', text: t('convite.copiado') }); } catch { /* sem área de transferência: o código fica à vista para copiar */ } };
  const salvarTeto = (p: Pessoa, cap: string | null) => go(() => api.put(`/api/world/budgets/${p.accountId}`, { capDracmas: cap }), cap === null ? t('teto.livreMsg') : t('teto.definido', { valor: dr(cap) }));
  return (
    <div className="pessoas">
      {msgEl}
      <div className="pessoas__topo">
        <div className="pessoas__vagas" aria-label={t('pessoas.vagas', { n: v.total, usadas: v.usadas })}>
          <b>{t('pessoas.vagas', { n: v.total, usadas: v.usadas })}</b>
          <span className="pessoas__barra" aria-hidden="true"><i style={{ width: `${v.total ? Math.min(100, (v.usadas / v.total) * 100) : 0}%` }} /></span>
          <small>{t('pessoas.livres', { n: v.livres })}{adm && d.invites.length ? ` · ${t('pessoas.contaConvites')}` : ''}</small>
        </div>
        <p className="muted small pessoas__legenda">{t('pessoas.legenda')}</p>
      </div>
      {!adm && <p className="hint">{t('pessoas.soLeitura')}</p>}
      <ul className="pessoas__lista">
        {d.members.map((p) => {
          const opcoes = papeisPara(eu, p); const bg = budget(p.accountId);
          return (
            <li key={p.accountId} className={`pessoa${p.me ? ' pessoa--eu' : ''}`}>
              <span className={`pessoa__avatar pessoa__avatar--${p.role}`} aria-hidden="true">{inicial(p)}</span>
              <div className="pessoa__corpo">
                <div className="pessoa__linha">
                  <b className="pessoa__nome">{nomeDe(p)}</b>
                  <span className={`badge badge--papel-${p.role}`}>{t(PAPEIS[p.role])}</span>
                  {p.me && <span className="badge badge--atual">{t('pessoas.voce')}</span>}
                  {espera.has(p.accountId) && <span className="badge badge--warn">{t('pessoas.esperaChave')}</span>}
                </div>
                <small className="muted">{[p.email, t('pessoas.desde', { dia: day(p.since) }), bg ? `${t('teto.usou', { valor: dr(bg.used) })} · ${bg.cap === null ? t('teto.livre') : t('teto.teto', { valor: dr(bg.cap) })}` : null].filter(Boolean).join(' · ')}</small>
                {(opcoes.length > 0 || podeTirar(eu, p) || (b.data?.manager && bg) || espera.has(p.accountId)) && (
                  <div className="pessoa__acoes">
                    {opcoes.length > 0 && (
                      <label className="pessoa__campo"><span className="sr-only">{t('pessoas.papelDe', { nome: nomeDe(p) })}</span>
                        <select aria-label={t('pessoas.papelDe', { nome: nomeDe(p) })} value={p.role} disabled={busy}
                          onChange={(ev) => { const r = ev.target.value as Papel; void go(() => api.put(`/api/world/members/${p.accountId}/role`, { role: r }), t('pessoas.papelTrocado', { nome: nomeDe(p), papel: t(PAPEIS[r]) })); }}>
                          {opcoes.map((r) => <option key={r} value={r}>{t(PAPEIS[r])}</option>)}
                        </select>
                      </label>
                    )}
                    {b.data?.manager && bg && (
                      <span className="pessoa__teto">
                        <input inputMode="decimal" aria-label={t('teto.tetoDe', { nome: nomeDe(p) })} placeholder={t('teto.placeholder')} value={teto[p.accountId] ?? ''} onChange={(ev) => setTeto({ ...teto, [p.accountId]: ev.target.value })} />
                        <button className="btn btn--sm" disabled={busy || !/^\d{1,9}([.,]\d{1,2})?$/.test((teto[p.accountId] ?? '').trim())} onClick={() => void salvarTeto(p, (teto[p.accountId] ?? '').trim().replace(',', '.'))}>{t('teto.definir')}</button>
                        {bg.cap !== null && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void salvarTeto(p, null)}>{t('teto.deixarLivre')}</button>}
                      </span>
                    )}
                    {espera.has(p.accountId) && sync.data?.enabled && (
                      <button className="btn btn--sm" title={t('pessoas.chaveDica')} disabled={busy} onClick={() => void go(async () => { const r = await api.post<{ shared: number }>('/api/world/sync/share'); onMsg({ kind: 'ok', text: t('pessoas.chaveEntregue', { n: r.shared }) }); })}><Icon name="key" size={13} /> {t('pessoas.entregarChave')}</button>
                    )}
                    {podeTirar(eu, p) && (tirando === p.accountId ? (
                      <span className="pessoa__confirma" role="group">
                        <small>{t('pessoas.tirarConfirma', { nome: nomeDe(p) })}</small>
                        <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => void go(async () => { setSaiu(await api.del<Tirada>(`/api/world/members/${p.accountId}`)); setTirando(null); }, t('pessoas.tirado', { nome: nomeDe(p) }))}>{t('pessoas.tirarSim')}</button>
                        <button className="btn btn--sm btn--ghost" onClick={() => setTirando(null)}>{t('vinculo.cancelar')}</button>
                      </span>
                    ) : <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setTirando(p.accountId)}><Icon name="trash" size={13} /> {t('pessoas.tirar')}</button>)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {saiu?.rotated && <p className="hint ok"><Icon name="key" size={13} /> {t('pessoas.chaveTrocada')}</p>}
      {(saiu?.rotationRequired || (!saiu?.rotated && sync.data?.rotationPending)) && (
        saiu?.reason === 'no_key'
          ? <p className="hint warn">{t('pessoas.chaveOutroPc')}</p>
          : (
            <p className="hint warn row row--wrap">
              <span>{t('pessoas.chavePendente')}</span>
              {adm && sync.data?.enabled && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void go(async () => { await api.post('/api/world/sync/rotate'); setSaiu({ ok: true, rotated: true }); })}><Icon name="key" size={13} /> {t('pessoas.trocarChave')}</button>}
            </p>
          )
      )}
      {adm && d.invites.length > 0 && (
        <div className="pessoas__convites">
          <b className="small">{t('convite.pendentes')}</b>
          <ul className="sec-rows small">
            {d.invites.map((i) => (
              <li key={i.id}>
                <span><span className="pessoa__avatar pessoa__avatar--convite" aria-hidden="true"><Icon name="send" size={12} /></span> {t('convite.pendente', { papel: t(PAPEIS[i.role]), dia: day(i.expiresAt) })}</span>
                <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void go(() => api.del(`/api/world/members/invites/${i.id}`), t('convite.cancelado'))}>{t('convite.cancelar')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {conv.length > 0 && (
        <div className="pessoas__convidar">
          <b>{t('convite.titulo')}</b>
          <div className="row row--wrap">
            <label className="field">{t('convite.papel')}
              <select value={conv.includes(papelNovo) ? papelNovo : conv[0]} onChange={(ev) => setPapelNovo(ev.target.value as Papel)}>{conv.map((r) => <option key={r} value={r}>{t(PAPEIS[r])}</option>)}</select>
            </label>
            <button className="btn btn--primary" disabled={busy || v.livres <= 0} onClick={() => void convidar()}><Icon name="plus" size={14} /> {t('convite.criar')}</button>
          </div>
          {v.livres <= 0 && <p className="muted small">{t('convite.semVaga')}</p>}
          {codigo && (
            <div className="convite-codigo" role="status">
              <span className="small muted">{t('convite.codigo')}</span>
              <div className="convite-codigo__linha"><code>{codigo.token}</code><button className="btn btn--sm" onClick={() => void copiar()}><Icon name="copy" size={13} /> {t('convite.copiar')}</button></div>
              <p className="small muted">{t('convite.instrucao', { dia: day(codigo.expiresAt) })}</p>
            </div>
          )}
        </div>
      )}
      {eu === 'owner' && d.members.some((p) => podeTransferir(eu, p)) && <Titularidade pessoas={d.members.filter((p) => podeTransferir(eu, p))} nomeWorkspace={nomeWorkspace} go={go} busy={busy} />}
    </div>
  );
}

/** Transferir a titularidade (só o dono): escolher a pessoa e digitar a palavra de confirmação. */
function Titularidade({ pessoas, go, busy }: { pessoas: Pessoa[]; nomeWorkspace?: string | null; go: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; busy: boolean }) {
  const t = useTw();
  const [para, setPara] = useState(pessoas[0]?.accountId ?? '');
  const [palavra, setPalavra] = useState('');
  const alvo = pessoas.find((p) => p.accountId === para) ?? pessoas[0];
  const certo = palavra.trim().toLocaleUpperCase() === t('dono.palavra');
  return (
    <details className="pessoas__dono">
      <summary>{t('dono.titulo')}</summary>
      <p className="small muted">{t('dono.texto')}</p>
      <div className="row row--wrap">
        <label className="field">{t('dono.para')}<select value={alvo?.accountId ?? ''} onChange={(ev) => setPara(ev.target.value)}>{pessoas.map((p) => <option key={p.accountId} value={p.accountId}>{nomeDe(p)}</option>)}</select></label>
        <label className="field">{t('dono.digite', { palavra: t('dono.palavra') })}<input value={palavra} autoComplete="off" onChange={(ev) => setPalavra(ev.target.value)} /></label>
      </div>
      <button className="btn btn--danger" disabled={busy || !certo || !alvo} onClick={() => void go(async () => { await api.post('/api/world/members/transfer', { toAccountId: alvo!.accountId }); setPalavra(''); emitLocal('world.changed'); }, t('dono.feito', { nome: nomeDe(alvo!) }))}>{t('dono.botao', { nome: alvo ? nomeDe(alvo) : '' })}</button>
    </details>
  );
}

/** "Sua equipe no mundo": as iniciais de quem está no workspace, as vagas e o atalho para a gestão. */
export function EquipeFaixa({ onGerenciar }: { onGerenciar: () => void }) {
  const t = useTw();
  const m = useResource<Membros>('/api/world/members', []);
  if (!m.data || !m.data.members.length) return null;
  const v = vagas(m.data); const mostra = m.data.members.slice(0, 6);
  return (
    <div className="mundo-equipe" aria-label={t('equipe.titulo')}>
      <span className="mundo-equipe__rotulo">{t('equipe.titulo')}</span>
      <span className="mundo-equipe__rostos">
        {mostra.map((p) => <span key={p.accountId} className={`pessoa__avatar pessoa__avatar--${p.role}`} title={nomeDe(p)}>{inicial(p)}</span>)}
        {m.data.members.length > mostra.length && <span className="pessoa__avatar pessoa__avatar--mais">{t('equipe.mais', { n: m.data.members.length - mostra.length })}</span>}
      </span>
      <span className="mundo-equipe__vagas">{t('pessoas.vagas', { n: v.total, usadas: v.usadas })}</span>
      <button className="btn btn--sm mundo-cta--fantasma" onClick={onGerenciar}><Icon name="users" size={14} /> {t('equipe.gerenciar')}</button>
    </div>
  );
}

/**
 * "Tenho um convite": a pessoa cola o código; o workspace entra na lista da conta dela no World e ela liga um workspace
 * deste computador a ele (Workspaces, na página do Ergon World). A chave chega depois, entregue por quem administra.
 */
export function AceitarConvite({ onDone, compacto }: { onDone?: () => void; compacto?: boolean }) {
  const t = useTw();
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, onDone);
  const [cod, setCod] = useState('');
  const aceitar = () => go(async () => {
    const r = await api.post<{ workspaceId: string; role: Papel }>('/api/world/invites/accept', { token: limparCodigo(cod) });
    setCod(''); emitLocal('world.changed');
    onMsg({ kind: 'ok', text: t('aceitar.feito', { papel: t(PAPEIS[r.role] ?? 'papel.editor') }) });
  });
  const corpo = (
    <>
      <p className="muted small">{t('aceitar.texto')}</p>
      <div className="row row--wrap">
        <label className="field grow">{t('aceitar.campo')}<input value={cod} autoComplete="off" spellCheck={false} onChange={(ev) => setCod(ev.target.value)} /></label>
        <button className="btn btn--primary" disabled={busy || !codigoValido(cod)} onClick={() => void aceitar()}>{t('aceitar.botao')}</button>
      </div>
      {cod.trim() && !codigoValido(cod) && <p className="muted small">{t('aceitar.invalido')}</p>}
      {msgEl}
    </>
  );
  return compacto ? <details className="aceitar-convite"><summary>{t('aceitar.titulo')}</summary>{corpo}</details> : <div className="aceitar-convite"><b>{t('aceitar.titulo')}</b>{corpo}</div>;
}

// ---------------------------------------------------------------- Plano e carrinho
/**
 * O plano deste workspace: o que ele dá, a dica de upgrade, o carrinho (plano, pessoas, Jobs e recarga, num pagamento
 * só para a assinatura e a recarga como passo à parte), o cartão e as faturas e o cancelamento no fim do período.
 */
export function PlanoPainel({ planoInicial }: { planoInicial?: string | null } = {}) {
  const t = useTw();
  const cat = useResource<Catalog>('/api/world/catalog', []);
  const bill = useResource<Billing>('/api/world/billing', []);
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, () => bill.reload());
  if (!cat.data || !bill.data) return <Loading error={cat.error ?? bill.error} />;
  const e = bill.data.entitlement; const sub = bill.data.subscription;
  const plans = cat.data.items.filter((i) => i.kind === 'plan');
  const addon = (sku: string | undefined) => cat.data!.items.find((i) => i.sku === sku);
  const cur = plans.find((p) => p.sku === e.plan_sku);
  const dono = bill.data.role === 'owner';
  const live = !!sub && LIVE.includes(sub.status) && dono;
  return (
    <div className="painel-plano">
      {msgEl}
      {e.status === 'grace' && <p className="error" role="alert">{t('plano.recusado', { dia: day(e.grace_until) })}</p>}
      {cur && ['active', 'grace'].includes(e.status) ? (
        <div className="painel-plano__atual">
          <span className="mundo-selo mundo-selo--claro"><Icon name="check" size={13} /> {cur.name}</span>
          <ul className="painel-plano__fatos">
            <li><Icon name="clock" size={15} /> {e.status === 'active' ? t('plano.pagoAte', { dia: day(e.effective_until) }) : t('plano.emTolerancia')}</li>
            <li><Icon name="users" size={15} /> {t('plano.vagas', { n: e.people, usadas: bill.data.seatsUsed })} {t('plano.contandoDono')}</li>
            <li><Icon name="cloud" size={15} /> {t('plano.jobsAoMesmoTempo', { n: e.job_slots })}</li>
            <li><Icon name="coins" size={15} /> {t('plano.porMes', { valor: dr(cur.monthlyDracmas ?? '0') })}</li>
          </ul>
        </div>
      ) : e.status === 'expired' ? <p className="muted">{t('plano.terminou')}</p> : null}
      {cur && ['active', 'grace'].includes(e.status) && dono && <UpgradeTip ws={bill.data.workspaceId ?? ''} cur={cur} people={Math.max(e.people, bill.data.seatsUsed)} plans={plans} addon={addon} />}
      {!dono ? <p className="muted small">{t('plano.quemCuida')}</p> : <CarrinhoPainel cat={cat.data} bill={bill.data} onMsg={onMsg} onDone={() => bill.reload()} planoInicial={planoInicial} />}
      {live && (
        <div className="row row--wrap painel-plano__rodape">
          <button className="btn btn--ghost" disabled={busy} onClick={() => void go(async () => { const r = await api.post<{ url: string }>('/api/world/billing/portal'); location.assign(r.url); })}>{t('plano.cartao')}</button>
          {sub!.cancelAt ? <span className="muted small">{t('plano.terminaEm', { dia: day(sub!.cancelAt) })}</span>
            : <button className="btn btn--ghost" disabled={busy} onClick={() => void go(() => api.post('/api/world/billing/cancel', { idempotencyKey: requestId() }), t('plano.cancelado'))}>{t('plano.cancelar')}</button>}
        </div>
      )}
    </div>
  );
}

const ler = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const gravar = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sem armazenamento: o passo 2 aparece só agora */ } };

/**
 * O carrinho: a pessoa escolhe o plano (ou mantém), pessoas adicionais, pacotes de Jobs e uma recarga. Sem assinatura,
 * a assinatura sai num checkout só (plano + pessoas + Jobs); com assinatura, vira uma mudança com a prévia exata do
 * World antes de confirmar. A recarga é pagamento à parte: passo 2 de 2, dito na tela e guardado para depois do retorno
 * do pagamento. Antes da prévia, só a soma do catálogo, rotulada assim.
 */
export function CarrinhoPainel({ cat, bill, onMsg, onDone, planoInicial }: { cat: Catalog; bill: Billing; onMsg: Msg; onDone: () => void; planoInicial?: string | null }) {
  const t = useTw();
  const plans = cat.items.filter((i) => i.kind === 'plan');
  const topups = cat.items.filter((i) => i.kind === 'topup');
  const sub = bill.subscription;
  const a = atualDe(bill.entitlement.plan_sku && ['active', 'grace'].includes(bill.entitlement.status) ? bill.entitlement.plan_sku : null, !!sub && LIVE.includes(sub.status), bill.items);
  const [c, setC] = useState<Cesta>({ ...VAZIO, plano: planoInicial ?? null });
  const [pv, setPv] = useState<Preview | null>(null);
  const [pendente, setPendente] = useState<string | null>(() => ler(CHAVE_PENDENTE));
  const [busy, go] = useAcao(onMsg, onDone);
  useEffect(() => { if (planoInicial) setC((x) => ({ ...x, plano: planoInicial })); }, [planoInicial]);
  const mudar = (x: Partial<Cesta>) => { setC({ ...c, ...x }); setPv(null); };
  const plano = c.plano ?? a.plano;
  const cur = plans.find((p) => p.sku === a.plano);
  const vaga = vagaDe(cat.items, plano);
  const jobs = jobsDe(cat.items, plano);
  const periodo = anualDe(cat.items, plano) ? t('pagina.planos.porAno') : t('pagina.planos.porMes');
  const r = passos(c, a);
  const soma = somaDoCatalogo(cat.items, c, a);
  const nome = (sku: string | null | undefined) => cat.items.find((i) => i.sku === sku)?.name ?? sku ?? '';
  const total = r.passos.length;
  const itens = (p: Passo) => fmtLista([
    ...('sku' in p.corpo && p.tipo === 'checkout' ? [t('carrinho.itemPlano', { nome: nome(p.corpo.sku) })] : []),
    ...(p.tipo === 'mudanca' && p.corpo.plan ? [t('carrinho.itemPlano', { nome: nome(p.corpo.plan) })] : []),
    ...(c.pessoas ? [t('carrinho.itemPessoas', { n: c.pessoas })] : []),
    ...(c.jobs ? [t('carrinho.itemJobs', { n: c.jobs })] : []),
  ]);
  const recarga = (sku: string) => go(async () => { const x = await api.post<{ url: string }>('/api/world/billing/checkout', { sku, idempotencyKey: requestId() }); gravar(CHAVE_PENDENTE, null); location.assign(x.url); });
  const pagar = (p: Passo, i: number) => {
    if (p.tipo === 'checkout') return go(async () => {
      if (c.recarga) gravar(CHAVE_PENDENTE, c.recarga); // o passo 2 espera o retorno do pagamento
      const x = await api.post<{ url: string }>('/api/world/billing/checkout', { ...p.corpo, idempotencyKey: requestId() }); location.assign(x.url);
    });
    if (p.tipo === 'recarga') return recarga(p.corpo.sku);
    if (!pv) return go(async () => setPv(await api.post<Preview>('/api/world/billing/change/preview', p.corpo)));
    return go(async () => {
      await api.post('/api/world/billing/change/confirm', { ...p.corpo, prorationDate: pv.prorationDate, idempotencyKey: requestId() });
      setPv(null); setC({ ...VAZIO, recarga: c.recarga });
      onMsg({ kind: 'ok', text: pv.upgrade ? t('plano.mudancaEnviada') : t('plano.mudancaAgendada') });
      void i;
    });
  };
  const contador = (rot: string, valor: number, set: (n: number) => void, preco: ReactNode, atual: number | null) => (
    <div className="carrinho__linha">
      <span className="carrinho__rotulo">{rot} {atual !== null && atual > 0 && <small className="muted">{t('carrinho.atual', { n: atual })}</small>}<small className="muted">{preco}</small></span>
      <span className="carrinho__contador">
        <button className="btn btn--sm btn--ghost" aria-label={`${t('carrinho.menos')} · ${rot}`} disabled={valor <= 0} onClick={() => set(valor - 1)}>−</button>
        <output aria-live="polite">{valor}</output>
        <button className="btn btn--sm btn--ghost" aria-label={`${t('carrinho.mais')} · ${rot}`} disabled={valor >= 1000} onClick={() => set(valor + 1)}>+</button>
      </span>
    </div>
  );
  return (
    <div className="carrinho" aria-label={t('carrinho.titulo')}>
      {pendente && (
        <div className="carrinho__pendente" role="status">
          <span><b>{t('carrinho.passo', { i: 2, n: 2 })}</b> · {t('carrinho.recargaPendente', { nome: nome(pendente) })}</span>
          <span className="row">
            <button className="btn btn--sm btn--gold" disabled={busy} onClick={() => void recarga(pendente)}>{t('carrinho.pagarRecarga')}</button>
            <button className="btn btn--sm btn--ghost" onClick={() => { gravar(CHAVE_PENDENTE, null); setPendente(null); }}>{t('carrinho.descartar')}</button>
          </span>
        </div>
      )}
      <div className="carrinho__itens">
        <label className="carrinho__linha">
          <span className="carrinho__rotulo">{t('carrinho.plano')}</span>
          <select value={c.plano ?? ''} onChange={(ev) => mudar({ plano: ev.target.value || null })}>
            <option value="">{a.plano ? t('carrinho.manter') : t('carrinho.escolher')}</option>
            {plans.filter((p) => p.sku !== a.plano && p.sellable && !(cur?.interval === 'year' && p.interval === 'month')).map((p) => <option key={p.sku} value={p.sku}>{p.interval === 'year' ? t('plano.opcaoAno', { nome: p.name, preco: brl(p.priceCents) }) : t('plano.opcaoMes', { nome: p.name, preco: brl(p.priceCents) })}</option>)}
          </select>
        </label>
        {contador(t('carrinho.pessoas'), c.pessoas, (n) => mudar({ pessoas: n }), vaga ? ` · ${brl(vaga.priceCents)}${periodo}` : '', a.assinatura ? a.pessoas : null)}
        {contador(t('carrinho.jobs'), c.jobs, (n) => mudar({ jobs: n }), jobs ? ` · ${brl(jobs.priceCents)}${periodo}` : '', a.assinatura ? a.jobs : null)}
        <label className="carrinho__linha">
          <span className="carrinho__rotulo">{t('carrinho.recarga')}</span>
          <select value={c.recarga ?? ''} onChange={(ev) => mudar({ recarga: ev.target.value || null })}>
            <option value="">{t('carrinho.semRecarga')}</option>
            {topups.filter((x) => x.sellable).map((x) => <option key={x.sku} value={x.sku}>{x.name}</option>)}
          </select>
        </label>
      </div>
      {vazio(c) ? <p className="muted small">{t('carrinho.vazio')}</p> : r.erro ? <p className="hint warn">{t('carrinho.semPlano')}</p> : (
        <div className="carrinho__resumo">
          {soma !== null && <p className="carrinho__soma"><b>{t('carrinho.catalogo', { valor: brl(String(soma)) })}</b><small className="muted">{t('carrinho.catalogoNota')}</small></p>}
          <ol className="carrinho__passos">
            {r.passos.map((p, i) => (
              <li key={p.tipo} className="carrinho__passo">
                <span className="small">{total > 1 && <b>{t('carrinho.passo', { i: i + 1, n: total })} · </b>}{p.tipo === 'recarga' ? t('carrinho.passoRecarga', { nome: nome(p.corpo.sku) }) : t('carrinho.passoAssinatura', { itens: itens(p) })}</span>
                {p.tipo === 'mudanca' && pv && <span className="small" role="status">{pv.upgrade ? twn('plano.cobrancaAgora', { valor: <b>{brl(pv.amountDueCents)}</b>, quando: pv.effective }) : t('plano.semCobranca', { quando: pv.effective })}</span>}
                {i === 0 ? (
                  <button className="btn btn--gold" disabled={busy} onClick={() => void pagar(p, i)}>
                    {p.tipo === 'checkout' ? t('carrinho.pagarAssinatura') : p.tipo === 'recarga' ? t('carrinho.pagarRecarga') : pv ? t('carrinho.confirmar') : t('carrinho.verPrevia')}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          <button className="btn btn--sm btn--ghost" onClick={() => { setC(VAZIO); setPv(null); }}>{t('carrinho.limpar')}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Dracmas
/** Saldo, lotes, extrato, recarregar (dono), recarga automática (dono), teto por pessoa (em Pessoas) e transferir. */
export function DracmasPainel({ mine }: { mine: WorkspaceRef[] }) {
  const t = useTw();
  const wsw = useResource<Wallet>('/api/world/wallet', []);
  const stmt = useResource<Statement>('/api/world/wallet/statement', []);
  const cat = useResource<Catalog>('/api/world/catalog', []);
  const bill = useResource<Billing>('/api/world/billing', []);
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, () => { wsw.reload(); stmt.reload(); });
  const topups = cat.data?.items.filter((i) => i.kind === 'topup') ?? [];
  const dono = bill.data?.role === 'owner';
  const others = mine.filter((w) => w.workspaceId !== bill.data?.workspaceId);
  const checkout = (sku: string) => go(async () => { const r = await api.post<{ url: string }>('/api/world/billing/checkout', { sku, idempotencyKey: requestId() }); location.assign(r.url); });
  if (!wsw.data) return <Loading error={wsw.error} />;
  return (
    <div className="painel-dracmas">
      {msgEl}
      <div className="painel-dracmas__saldo">
        <span className="painel-dracmas__moeda" aria-hidden="true">₯</span>
        <div>
          <p className="painel-dracmas__valor">{dr(wsw.data.available)}</p>
          <p className="muted small">{t('creditos.disponivel')}{Number(wsw.data.reserved) > 0 ? ` · ${t('creditos.reservadoAgora', { valor: dr(wsw.data.reserved) })}` : ''}</p>
        </div>
      </div>
      <p className="muted small">{t('creditos.texto')} {t('creditos.franquia')}</p>
      {wsw.data.lots.some((l) => Number(l.remaining) > 0) && <ul className="sec-rows">{wsw.data.lots.filter((l) => Number(l.remaining) > 0).map((l) => <li key={l.id}><b>{dr(l.remaining)}</b><span className="muted small">{LOT[l.source] ? t(LOT[l.source]) : l.source} · {l.expiresAt ? t('creditos.valeAte', { dia: day(l.expiresAt) }) : t('creditos.naoVence')}</span></li>)}</ul>}
      {dono ? (
        <div className="painel-dracmas__recargas">
          <b className="small">{t('dracmas.recarregar')}</b>
          <div className="row row--wrap">{topups.map((x) => <button key={x.sku} className="btn btn--sm" disabled={busy || !x.sellable} title={x.sellable ? '' : t('creditos.semPreco')} onClick={() => void checkout(x.sku)}><Icon name="coins" size={13} /> {x.name}</button>)}</div>
        </div>
      ) : <p className="muted small">{t('creditos.quemRecarrega')}</p>}
      <AutoRecarga dono={dono} topups={topups} onMsg={onMsg} />
      {dono && others.length > 0 && <Transfer others={others} busy={busy} go={go} />}
      {stmt.data && stmt.data.entries.length > 0 && (
        <details><summary>{t('creditos.extrato')}</summary>
          <ul className="sec-rows small">{stmt.data.entries.slice(0, 30).map((x) => <li key={x.id}><span>{KIND[x.kind] ? t(KIND[x.kind]) : x.kind}</span><span className="muted">{x.kind === 'capture' ? `-${dr(x.amount)}` : Number(x.delta) !== 0 ? dr(x.delta) : ''} · {when(x.createdAt)}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

/**
 * Recarga automática (só o dono, é o cartão dele): gatilho em Dracmas, o pacote da recarga e o teto do mês em reais
 * (mínimo R$ 19,90). O World ainda não devolve a regra salva para mostrar aqui: salvar substitui a anterior (dito na tela).
 */
function AutoRecarga({ dono, topups, onMsg }: { dono: boolean; topups: Item[]; onMsg: Msg }) {
  const t = useTw();
  const [busy, go] = useAcao(onMsg);
  const [gatilho, setGatilho] = useState('200');
  const [pacote, setPacote] = useState('');
  const [teto, setTeto] = useState('100');
  const vende = topups.filter((x) => x.sellable);
  const sku = pacote || vende[0]?.sku || '';
  const tetoCents = Math.round(Number(teto.replace(',', '.')) * 100);
  const ok = /^\d{1,7}$/.test(gatilho.trim()) && Number(gatilho) >= 1 && !!sku && Number.isFinite(tetoCents) && tetoCents >= 1990;
  return (
    <details className="auto-recarga">
      <summary><Icon name="repeat" size={14} /> {t('auto.titulo')}</summary>
      <p className="muted small">{t('auto.texto')}</p>
      {!dono ? <p className="muted small">{t('auto.soDono')}</p> : (
        <>
          <div className="row row--wrap">
            <label className="field">{t('auto.gatilho')}<input inputMode="numeric" value={gatilho} onChange={(ev) => setGatilho(ev.target.value)} /></label>
            <label className="field">{t('auto.pacote')}<select value={sku} onChange={(ev) => setPacote(ev.target.value)}>{vende.map((x) => <option key={x.sku} value={x.sku}>{x.name}</option>)}</select></label>
            <label className="field">{t('auto.teto')}<input inputMode="decimal" value={teto} onChange={(ev) => setTeto(ev.target.value)} /></label>
          </div>
          {!ok && tetoCents < 1990 && <p className="muted small">{t('auto.minimo')}</p>}
          <div className="row row--wrap">
            <button className="btn btn--primary" disabled={busy || !ok} onClick={() => void go(() => api.put('/api/world/wallet/autotopup', { enabled: true, thresholdDracmas: Number(gatilho), topupSku: sku, monthlyCapCents: tetoCents }), t('auto.salva'))}>{t('auto.salvar')}</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => void go(() => api.put('/api/world/wallet/autotopup', { enabled: false }), t('auto.desligada'))}>{t('auto.desligar')}</button>
          </div>
          <p className="muted small">{t('auto.estadoNota')}</p>
        </>
      )}
    </details>
  );
}

// ---------------------------------------------------------------- Nuvem
/** O que está na nuvem agora (a mesma ala da Central de Trabalho), o resumo de quando a pessoa esteve fora e a recuperação. */
export function NuvemPainel() {
  const t = useTw();
  const resumo = useResource<ResumoFora>('/api/world/cards/summary', []);
  const [onMsg, msgEl] = useMsg();
  const linha = linhaDoResumo(resumo.data, t);
  return (
    <div className="painel-nuvem">
      {msgEl}
      <AlaNuvem />
      {linha ? (
        <div className="hint" role="status">
          <b>{t('fora.titulo')}</b> · {linha}
          <ul className="small">{resumo.data!.items.slice(0, 8).map((x, i) => <li key={`${x.ref}-${i}`}>{detalheDoResumo(x, t)}</li>)}</ul>
          <button type="button" className="linkish" onClick={() => void api.post('/api/world/cards/summary/seen').then(() => resumo.reload()).catch(() => undefined)}>{t('fora.ok')}</button>
        </div>
      ) : null}
      <RecoveryCard onMsg={onMsg} />
    </div>
  );
}

// ---------------------------------------------------------------- Ergon AI
/** Ergon AI no workspace: ligar na equipe de IA da pessoa (e, se quiser, como padrão). */
export function ErgonAiPainel() {
  const t = useTw();
  const ai = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, () => { ai.reload(); emitLocal('ai.changed'); });
  const [padrao, setPadrao] = useState(false);
  const ligado = (ai.data?.byokCustom ?? []).some((c) => /ergon-ai/i.test(`${c.id} ${c.name}`));
  return (
    <div className="painel-ia">
      {msgEl}
      {ligado && <p className="ok-inline"><Icon name="check" size={14} /> {t('conexoes.ligado')}</p>}
      <div className="row row--wrap">
        <button className="btn btn--gold" disabled={busy} onClick={() => void go(() => api.post('/api/world/ai/connect', { makeDefault: padrao }), t('ia.ligado'))}>{t('ia.usar')}</button>
        <label className="check"><input type="checkbox" checked={padrao} onChange={(ev) => setPadrao(ev.target.checked)} /> {t('ia.padrao')}</label>
        <a className="btn btn--sm btn--ghost" href="#conexoes">{t('painel.ia.conexoes')}</a>
      </div>
    </div>
  );
}

interface Policy { available: boolean; recovery: boolean; rounds?: number; canEdit: boolean }
/** Protocolo de recuperação do workspace na nuvem (vem ligado): quem administra liga e desliga; os outros só veem. */
function RecoveryCard({ onMsg }: { onMsg: Msg }) {
  const t = useTw();
  const p = useResource<Policy>('/api/world/job-policy', []);
  const [busy, setBusy] = useState(false);
  if (!p.data?.available) return null;
  const set = async (on: boolean) => {
    onMsg(null); setBusy(true);
    try { await api.put('/api/world/job-policy', { recovery: on }); onMsg({ kind: 'ok', text: t(on ? 'recuperacao.ligada' : 'recuperacao.desligada') }); } catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); p.reload(); }
  };
  return (
    <div className="painel-recuperacao">
      <label className="check"><input type="checkbox" checked={p.data.recovery} disabled={busy || !p.data.canEdit} onChange={(ev) => void set(ev.target.checked)} /> {t('recuperacao.rotulo')}</label>
      <p className="muted small">{t('recuperacao.texto', { n: p.data.rounds ?? 3 })}{p.data.canEdit ? '' : ` ${t('recuperacao.soAdmin')}`}</p>
    </div>
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


interface SyncStatus { bound: boolean; enabled: boolean; syncWorkspaceId?: string | null; origin?: 'created' | 'joined' | null; lastVersion?: number; conflicts?: number; keyVersion?: number; rotationPending?: boolean; recoveryOutdated?: boolean }
interface Tirada { ok: boolean; rotated?: boolean; rotationRequired?: boolean; reason?: string; shared?: number }
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
export function SyncCard({ onMsg }: { onMsg: (m: { kind: 'ok' | 'error'; text: string } | null) => void }) {
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
          {s.rotationPending && <p className="hint warn row row--wrap"><span>{t('pessoas.chavePendente')}</span><button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void go(async () => { await api.post('/api/world/sync/rotate'); return t('pessoas.chaveTrocada'); })}><Icon name="key" size={13} /> {t('pessoas.trocarChave')}</button></p>}
          {s.recoveryOutdated && (
            <div className="hint warn">
              <span>{t('sync.fraseVelha')}</span>
              <div className="row row--wrap">
                <input type="password" autoComplete="off" aria-label={t('sync.fraseNome')} placeholder={t('sync.fraseNome')} value={phrase} onChange={(ev) => setPhrase(ev.target.value)} />
                <button className="btn btn--sm" disabled={busy || phrase.trim().length < 20} onClick={() => void go(async () => { await api.post('/api/world/sync/recovery', withPhrase()); setPhrase(''); return t('sync.fraseAtualizada'); })}>{t('sync.atualizarFrase')}</button>
              </div>
            </div>
          )}
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


/** Os workspaces deste computador em cartões (qual fica no World) e, no ligado, a sincronia entre aparelhos. */
export function WorkspacesPainel({ comSync }: { comSync?: boolean }) {
  const st = useResource<Status>('/api/world/status', ['world.changed']);
  const [onMsg, msgEl] = useMsg();
  const [busy, go] = useAcao(onMsg, () => { st.reload(); emitLocal('world.changed'); });
  if (!st.data?.link) return null;
  return (
    <>
      {msgEl}
      <BindCard s={st.data} busy={busy} act={go} />
      {comSync && st.data.link.currentIsBound && <SyncCard onMsg={onMsg} />}
    </>
  );
}

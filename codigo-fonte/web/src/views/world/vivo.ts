// O plano e o saldo do workspace no Ergon World, sempre à vista (a etiqueta da barra de cima, o Estado do Ergon e o
// item Governança do menu leem daqui). Uma leitura só para todas as telas abertas, e o saldo se atualiza:
//  - na hora, depois de uma compra ou mudança feita aqui (emitLocal('world.changed'));
//  - quando um trabalho termina (execução ou rotina na nuvem), com no mínimo 20 s entre duas leituras;
//  - e, com a janela à vista, uma leitura a cada 60 s (nunca mais que isso).
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../../lib/api.ts';
import { useLiveEvent, useResource } from '../../lib/live.ts';
import type { EstadoPlano } from './compra-rapida.ts';

export interface StatusVivo {
  configured: boolean;
  link: { accountEmail: string | null; emailVerified: boolean; currentIsBound: boolean; boundWorkspaceName: string | null } | null;
}
export interface BillingVivo extends EstadoPlano {
  workspaceId: string | null;
  entitlement: EstadoPlano['entitlement'] & { people: number; job_slots: number; effective_until: string | null; grace_until: string | null };
  seatsUsed: number;
  subscription: (NonNullable<EstadoPlano['subscription']> & { periodEnd: string | null; cancelAt: string | null }) | null;
}
export interface WalletVivo { available: string; reserved: string }
export interface Vivo { bill: BillingVivo | null; wallet: WalletVivo | null }

export const POLL_MS = 60_000;
const EVENTO_MIN_MS = 20_000;

let dados: Vivo = { bill: null, wallet: null };
const subs = new Set<() => void>();
let ultimo = 0;
let buscando = false;
let timer: number | null = null;

/** Lê o plano e o saldo (uma leitura por vez; `minMs` = intervalo mínimo desde a última). */
function ler(minMs = 0): void {
  if (buscando || Date.now() - ultimo < minMs) return;
  buscando = true; ultimo = Date.now();
  Promise.all([api.get<BillingVivo>('/api/world/billing'), api.get<WalletVivo>('/api/world/wallet')])
    .then(([bill, wallet]) => { dados = { bill, wallet }; subs.forEach((f) => f()); })
    .catch(() => { /* sem rede ou World fora do ar: fica o que se viu por último */ })
    .finally(() => { buscando = false; });
}
function assinar(f: () => void): () => void {
  subs.add(f);
  if (subs.size === 1) {
    if (Date.now() - ultimo > 5_000) ler();
    timer = window.setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') ler(POLL_MS - 1_000); }, POLL_MS);
  }
  return () => { subs.delete(f); if (!subs.size && timer !== null) { window.clearInterval(timer); timer = null; } };
}
const nada = () => () => {};
const vazio: Vivo = { bill: null, wallet: null };

/** Para as telas que já mudam o plano ou o saldo por conta própria (o carrinho, a recarga): relê agora. */
export const relerVivo = (): void => ler();

export function useWorldVivo() {
  const st = useResource<StatusVivo>('/api/world/status', ['world.changed']);
  const bound = !!st.data?.configured && !!st.data.link?.currentIsBound;
  const v = useSyncExternalStore(bound ? assinar : nada, () => (bound ? dados : vazio), () => vazio);
  useLiveEvent('world.changed', () => { if (bound) ler(); });
  useLiveEvent('runs.changed', () => { if (bound) ler(EVENTO_MIN_MS); });
  useLiveEvent('routines.changed', () => { if (bound) ler(EVENTO_MIN_MS); });
  // voltou à janela (outra aba, o pagamento): relê se já faz um tempo
  useEffect(() => {
    if (!bound) return;
    const f = () => { if (document.visibilityState === 'visible') ler(EVENTO_MIN_MS); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [bound]);
  return { st, bound, ...v };
}

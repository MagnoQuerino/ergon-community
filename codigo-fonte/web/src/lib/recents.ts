/**
 * Recentes: os últimos cards, agentes e rotinas que você abriu, para voltar a eles pela busca (Ctrl+K) sem procurar
 * de novo. Ficam só neste navegador (identificador e título, nada do conteúdo) e somem ao sair da conta.
 */
export type RecentKind = 'card' | 'agente' | 'rotina';
export interface Recent {
  kind: RecentKind; id: string; label: string;
  /** onde está ("Fluxos da equipe"), para mostrar; e o endereço para voltar (cards e rotinas; agente abre a janela) */
  where?: string; href?: string; at: number;
}

const KEY = 'ergon.recentes';
const MAX = 8;

export function getRecents(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as Recent[]).filter((r) => r && typeof r.id === 'string' && typeof r.label === 'string').slice(0, MAX) : [];
  } catch { return []; }
}

/** O mais recente primeiro; abrir de novo só sobe na lista (não repete). */
export function addRecent(list: Recent[], item: Omit<Recent, 'at'>, at = Date.now()): Recent[] {
  return [{ ...item, label: item.label.slice(0, 120), at }, ...list.filter((r) => !(r.kind === item.kind && r.id === item.id))].slice(0, MAX);
}

export function pushRecent(item: Omit<Recent, 'at'>): void {
  try { localStorage.setItem(KEY, JSON.stringify(addRecent(getRecents(), item))); } catch { /* sem armazenamento: sem recentes */ }
}

/** Sem aquele item (o resto na mesma ordem). */
export function withoutRecent(list: Recent[], kind: RecentKind, id: string): Recent[] {
  return list.filter((r) => !(r.kind === kind && r.id === id));
}

/** Tira um recente que não abre mais (o agente não existe neste workspace): a busca não oferece de novo. */
export function removeRecent(kind: RecentKind, id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(withoutRecent(getRecents(), kind, id))); } catch { /* sem armazenamento */ }
}

export function clearRecents(): void {
  try { localStorage.removeItem(KEY); } catch { /* sem armazenamento */ }
}

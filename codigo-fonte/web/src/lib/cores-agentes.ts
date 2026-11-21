// A cor de cada agente (shared/cor-agente.ts), a mesma em todas as telas: uma busca leve da equipe inteira por aba
// (/api/team/cores), atualizada quando a equipe muda. Enquanto não chegou (ou fora do Ergon, na galeria), a do sorteio
// pelo id. O par claro/escuro vira uma cor só conforme o tema da tela (o alto contraste usa a do claro).
import { useSyncExternalStore, type CSSProperties } from 'react';
import { corPeloId, type CorDoAgente } from '../../../shared/cor-agente.ts';
import { api } from './api.ts';
import { ouvirEventos } from './live.ts';
import { useTheme } from './theme.ts';

interface Linha { id: string; nome: string; claro: string; escuro: string }
let porId = new Map<string, CorDoAgente>();
let porNome = new Map<string, CorDoAgente>();
let versao = 0; let pedido: Promise<void> | null = null; let ligado = false; let falhou = false;
const ouvintes = new Set<() => void>();

function carregar(): void {
  if (pedido) return;
  pedido = api.get<{ cores: Linha[] }>('/api/team/cores').then((r) => {
    porId = new Map(r.cores.map((c) => [c.id, { claro: c.claro, escuro: c.escuro }]));
    porNome = new Map(r.cores.map((c) => [c.nome, { claro: c.claro, escuro: c.escuro }]));
    falhou = false; versao++; ouvintes.forEach((f) => f());
  }).catch(() => { falhou = true; }).finally(() => { pedido = null; });
}

function assinar(f: () => void): () => void {
  ouvintes.add(f);
  if (!ligado) {
    ligado = true;
    ouvirEventos((t) => { if (t === 'agents.changed' || t === 'resync') carregar(); });
    carregar();
  } else if (falhou && !pedido) carregar();
  return () => { ouvintes.delete(f); };
}

/** A tela está no tema escuro? (o alto contraste é claro) */
export function useEscuro(): boolean { const th = useTheme(); return th.theme === 'noite' && !th.contraste; }
/** O par na cor do tema. */
export const corDoTema = (c: CorDoAgente | null, escuro: boolean): string | null => (c ? (escuro ? c.escuro : c.claro) : null);

/** A cor do agente pelo id (ou, sem id, pelo nome na equipe), já no tema da tela. */
export function useCorDoAgente(id?: string | null, nome?: string | null): string | null {
  useSyncExternalStore(assinar, () => versao, () => versao);
  return corDoTema(parDoAgente(id, nome), useEscuro());
}
export function parDoAgente(id?: string | null, nome?: string | null): CorDoAgente | null {
  if (id) return porId.get(id) ?? corPeloId(id);
  if (nome) return porNome.get(nome) ?? null;
  return null;
}

/** A variável --agente (borda, realce e cursor usam var(--agente)). */
export const varsDaCor = (cor: string | null): CSSProperties | undefined => (cor ? ({ '--agente': cor } as CSSProperties) : undefined);

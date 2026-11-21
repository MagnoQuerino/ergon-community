// A cor de cada agente (shared/cor-agente.ts), a mesma em todas as telas: uma busca leve da equipe inteira por aba
// (/api/team/cores), atualizada quando a equipe muda. Enquanto não chegou (ou fora do Ergon, na galeria), a do sorteio
// pelo id. O par claro/escuro vai em variáveis; o CSS (.cor-agente) escolhe pelo tema.
import { useSyncExternalStore, type CSSProperties } from 'react';
import { corPeloId, type CorDoAgente } from '../../../shared/cor-agente.ts';
import { api } from './api.ts';
import { ouvirEventos } from './live.ts';

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

/** A cor do agente pelo id (ou, sem id, pelo nome na equipe). */
export function useCorDoAgente(id?: string | null, nome?: string | null): CorDoAgente | null {
  useSyncExternalStore(assinar, () => versao, () => versao);
  return corDoAgente(id, nome);
}
export function corDoAgente(id?: string | null, nome?: string | null): CorDoAgente | null {
  if (id) return porId.get(id) ?? corPeloId(id);
  if (nome) return porNome.get(nome) ?? null;
  return null;
}

/** As variáveis da cor (com a classe .cor-agente: --agente fica a do tema). */
export const varsDaCor = (c: CorDoAgente | null): CSSProperties | undefined =>
  c ? ({ '--agente-c': c.claro, '--agente-e': c.escuro } as CSSProperties) : undefined;

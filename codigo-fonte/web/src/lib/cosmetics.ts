import { useMemo } from 'react';
import type { SkinData } from '../../../shared/skin.ts';
import type { ActiveSkin } from '../iso/skin.ts';
import { useResource } from './live.ts';

interface Cosmetics { skin?: { data: SkinData; characters: Array<{ agentId: string; index: number }> } | null }

/** Skin ativa no workspace (ou nenhuma): retratos e listas vestem os mesmos personagens da cidade. */
export function useActiveSkin(): ActiveSkin | null {
  const c = useResource<Cosmetics>('/api/packages/cosmetics', ['agents.changed', 'city.changed']);
  const sk = c.data?.skin ?? null;
  return useMemo(() => (sk ? { data: sk.data, characters: new Map(sk.characters.map((x) => [x.agentId, x.index])) } : null), [sk]);
}

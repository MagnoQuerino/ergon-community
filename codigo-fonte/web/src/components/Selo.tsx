import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

/**
 * O selo de um cartão (rc.28): o tipo ou o estado — Aplicada, Com você, Recusada — com ícone e texto, nunca só pela cor.
 * As cores são as do .badge de sempre (badge--ok, --warn, --err); o tamanho é o do .card-selo (12,5 px, peso 600).
 */
export function Selo({ icone, tom, children, role }: { icone: string; tom?: 'ok' | 'warn' | 'err'; children: ReactNode; role?: 'status' }) {
  return <span className={`badge card-selo${tom ? ` badge--${tom}` : ''}`} role={role}><Icon name={icone} size={13} />{children}</span>;
}

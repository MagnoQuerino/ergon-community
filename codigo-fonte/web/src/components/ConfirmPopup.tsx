import { useRef, type ReactNode } from 'react';
import { useSurface } from '../lib/surface.ts';

/** Confirmação em popup (sobre a tela, Esc ou clique fora cancela). */
export function ConfirmPopup({ title, children, confirmLabel, busy, canConfirm = true, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; busy?: boolean;
  /** false: confirmar fica desabilitado (ex.: falta digitar o nome); cancelar continua livre */
  canConfirm?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: onCancel, modal: true, outside: true });
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card" role="alertdialog" aria-modal="true" aria-labelledby="cpop-title">
        <h3 id="cpop-title">{title}</h3>
        <div className="cpop__body">{children}</div>
        <div className="cpop__acts">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button className="btn btn--primary" onClick={onConfirm} disabled={busy || !canConfirm} autoFocus={canConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

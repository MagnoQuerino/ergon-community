import { useRef, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { RESULT_LABEL, WORK_LABEL, type WorkState } from '../lib/work.ts';
import { Icon } from './Icon.tsx';

export interface TaskFile { id: string; filename: string; mime: string; size: number; role: 'entrada' | 'entregavel'; created_at: string }
export interface Criterion { id: string; label: string; ok: boolean; detail?: string }
export interface WorkInfo {
  state: WorkState; label: string; kind: 'informativo' | 'documental' | 'dados' | 'externo'; kindLabel: string; requiresApproval: boolean;
  result: { id: string; state: string; kind: string; justification: string; criteria: Criterion[]; decidedBy: string; decidedAt: string | null; deliverables: string[]; mode: string | null } | null;
}

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ACCEPT = '.csv,.txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx';

/** Botão só com ícone, maior, com o nome ao passar o mouse (e para quem usa leitor de tela). */
export function IconAction({ icon, label, onClick, primary, pressed, disabled, danger }: {
  icon: string; label: string; onClick: () => void; primary?: boolean; pressed?: boolean; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button type="button" className={`iact ${primary ? 'iact--primary' : ''} ${pressed ? 'iact--on' : ''} ${danger ? 'iact--danger' : ''}`}
      onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={pressed === undefined ? undefined : pressed}>
      <Icon name={icon} size={20} />
    </button>
  );
}

/** Barra de ações do card: ícones lado a lado (antes, botões empilhados com texto). */
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="iact-bar" role="toolbar" aria-label="Ações do card">{children}</div>;
}

/** Arquivos do card, só com ícones: o que o trabalho entregou e o que você anexou (os agentes trabalham com eles). */
export function TaskFiles({ taskId, inputs, deliverables, canAttach, onChanged, hint }: {
  taskId: string; inputs: TaskFile[]; deliverables: TaskFile[]; canAttach: boolean; onChanged: () => void; hint?: string;
}) {
  const limits = useResource<{ uploadBytes: number }>('/api/limits', []);
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const max = limits.data?.uploadBytes ?? 50 * 1024 * 1024;
  const attach = async () => {
    const f = ref.current?.files?.[0];
    if (!f) return;
    setMsg(null);
    if (f.size > max) { setMsg({ ok: false, text: `${f.name} tem ${size(f.size)}; o limite é ${size(max)} por arquivo.` }); return; }
    try { await api.upload(f, taskId); setMsg({ ok: true, text: `Anexado: ${f.name}` }); if (ref.current) ref.current.value = ''; onChanged(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  };
  const row = (f: TaskFile) => (
    <li key={f.id} className="files__row">
      <span className="files__kind" title={f.role === 'entregavel' ? 'Entregue pelo trabalho' : 'Anexado'}><Icon name={f.role === 'entregavel' ? 'check' : 'clip'} size={14} /></span>
      <span className="files__name" title={`${f.filename} · ${size(f.size)}`}>{f.filename}</span>
      <a className="iact iact--sm" href={`/api/artifacts/${f.id}/download`} aria-label={`Baixar ${f.filename}`} title={`Baixar (${size(f.size)})`}><Icon name="download" size={16} /></a>
    </li>
  );
  const files = [...deliverables, ...inputs];
  return (
    <section className="block files-block">
      <div className="block__head">
        <h4>Arquivos</h4>
        {canAttach && (
          <>
            <input ref={ref} type="file" accept={ACCEPT} hidden aria-label="Arquivo para anexar ao card" onChange={() => void attach()} />
            <IconAction icon="clip" label="Anexar um arquivo (os agentes trabalham com ele)" onClick={() => ref.current?.click()} />
          </>
        )}
      </div>
      {files.length ? <ul className="files">{files.map(row)}</ul> : <p className="muted small">Nenhum arquivo.</p>}
      {hint && <p className="hint">{hint}</p>}
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </section>
  );
}

/** Conferência do resultado (critérios ✓/✗, quem decidiu): fica nos detalhes técnicos, recolhida. */
export function TechDetails({ work, queue, extra }: { work: WorkInfo | null; queue?: { position: number; total: number } | null; extra?: ReactNode }) {
  const r = work?.result;
  return (
    <details className="block tech">
      <summary>Detalhes técnicos</summary>
      {work && (
        <div className="kv">
          <span>Estado interno</span><b>{WORK_LABEL[work.state] ?? work.label}</b>
          <span>Tipo de trabalho</span><b>{work.kindLabel}</b>
          {queue && <><span>Fila</span><b>{queue.position}º de {queue.total} em “A fazer”</b></>}
        </div>
      )}
      {r && (
        <div className="work__result">
          <p><strong>Conferência: {RESULT_LABEL[r.state] ?? r.state}.</strong> {r.justification}</p>
          {r.criteria.length > 0 && (
            <ul className="crit">
              {r.criteria.map((c) => (
                <li key={c.id} className={c.ok ? 'crit--ok' : 'crit--no'}>
                  <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.label}{c.detail ? <span className="muted"> — {c.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {r.decidedAt && <p className="muted">{r.decidedBy.startsWith('usr_') ? 'Decidido por você' : 'Decidido pelo sistema'} em {new Date(r.decidedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{r.mode === 'simulated' ? ' · modo simulado' : ''}</p>}
        </div>
      )}
      {extra}
    </details>
  );
}

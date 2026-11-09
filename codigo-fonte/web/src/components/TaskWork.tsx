import { useRef, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { RESULT_LABEL, type WorkState } from '../lib/work.ts';
import { criterioSimples, justificativaSimples, previaDe } from '../lib/tarefa-tela.ts';
import { FileViewer } from './FileViewer.tsx';
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

/**
 * Arquivos do card: o que o trabalho entregou e o que você anexou (os agentes trabalham com eles). "Ver" abre por cima
 * da tarefa (texto, .md, .csv, imagem, PDF); Word, Excel e o resto só baixam.
 */
export function TaskFiles({ taskId, inputs, deliverables, canAttach, onChanged, hint }: {
  taskId: string; inputs: TaskFile[]; deliverables: TaskFile[]; canAttach: boolean; onChanged: () => void; hint?: string;
}) {
  const limits = useResource<{ uploadBytes: number }>('/api/limits', []);
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [vendo, setVendo] = useState<TaskFile | null>(null);
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
      {previaDe(f.filename, f.mime) !== 'baixar' && <button type="button" className="btn btn--sm files__ver" onClick={() => setVendo(f)} aria-label={`Ver ${f.filename}`}><Icon name="eye" size={13} /> Ver</button>}
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
      {vendo && <FileViewer file={vendo} onClose={() => setVendo(null)} />}
    </section>
  );
}

/**
 * "Como foi conferido": o que o sistema conferiu antes de entregar ou concluir, em palavras de todo dia, recolhido no
 * fim da tarefa. O estado interno e o tipo de trabalho não aparecem.
 */
export function TechDetails({ work, extra }: { work: WorkInfo | null; queue?: { position: number; total: number } | null; extra?: ReactNode }) {
  const r = work?.result;
  return (
    <details className="block tech">
      <summary>Como foi conferido</summary>
      {!r && <p className="muted small">Ainda nada para conferir: a conferência acontece quando o trabalho é entregue.</p>}
      {r && (
        <div className="work__result">
          <p><strong>{RESULT_LABEL[r.state] ? RESULT_LABEL[r.state].charAt(0).toUpperCase() + RESULT_LABEL[r.state].slice(1) : 'Conferido'}.</strong> {justificativaSimples(r.justification)}</p>
          {r.criteria.length > 0 && (
            <ul className="crit">
              {r.criteria.map((c) => {
                const x = criterioSimples(c);
                return (
                  <li key={c.id} className={c.ok ? 'crit--ok' : 'crit--no'}>
                    <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {x.texto}{x.detalhe ? <span className="muted"> — {x.detalhe}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {r.decidedAt && <p className="muted small">{r.decidedBy.startsWith('usr_') ? 'Decidido por você' : 'Conferido pelo sistema'} em {new Date(r.decidedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</p>}
        </div>
      )}
      {extra}
    </details>
  );
}

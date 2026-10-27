import { useState } from 'react';
import { Loading } from '../brand/Brand.tsx';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { PainelSaude, Saude } from '../lib/types.ts';

const CLS: Record<Saude, string> = { operacional: 'badge--ok', limitado: 'badge--warn', atencao: 'badge--err', indisponivel: 'badge--err' };
const LABEL: Record<Saude, string> = { operacional: 'Operacional', limitado: 'Com limitações', atencao: 'Necessita atenção', indisponivel: 'Indisponível' };

/** Saúde do Ergon: o estado de cada parte, em linguagem simples, e o pacote de diagnóstico (local: nada é enviado). */
export function SaudePanel() {
  const { data, error, reload, loading } = useResource<PainelSaude>('/api/saude', ['runs.changed', 'routines.changed', 'integrations.changed']);
  const [backup, setBackup] = useState<{ busy: boolean; msg: string | null; err: string | null }>({ busy: false, msg: null, err: null });
  const doBackup = async () => {
    setBackup({ busy: true, msg: null, err: null });
    try {
      const r = await api.post<{ counts: { files: number; secrets: number } }>('/api/admin/backup');
      setBackup({ busy: false, err: null, msg: `Backup feito e conferido: banco, ${r.counts.files} arquivo(s) e ${r.counts.secrets} credencial(is) de conexão. Fica no volume do Ergon; o lançador copia para a pasta de backups do computador.` });
      reload();
    } catch (e) { setBackup({ busy: false, msg: null, err: errMsg(e) }); }
  };
  if (error) return <section className="card"><p className="error">{error}</p></section>;
  if (!data) return <Loading />;
  return (
    <>
      <section className="card">
        <div className="row sec-toggle">
          <h3>Saúde do Ergon</h3>
          <span className={`badge ${CLS[data.estado]}`}>{data.rotulo}</span>
        </div>
        <p className="muted">{data.resumo}</p>
        <ul className="sec-rows" aria-label="Partes do Ergon">
          {data.componentes.map((c) => (
            <li key={c.id}>
              <span className={`badge ${CLS[c.estado]}`}>{LABEL[c.estado]}</span> <strong>{c.nome}</strong> <span className="muted">{c.detalhe}</span>
              {c.id === 'backup' && <button className="btn" onClick={doBackup} disabled={backup.busy}>{backup.busy ? 'Fazendo…' : 'Fazer backup agora'}</button>}
            </li>
          ))}
        </ul>
        {backup.msg && <p className="ok" role="status">{backup.msg}</p>}
        {backup.err && <p className="error" role="alert">{backup.err}</p>}
        <div className="row"><button className="btn" onClick={reload} disabled={loading}>Conferir de novo</button></div>
      </section>
      <section className="card">
        <h3>Pacote de diagnóstico</h3>
        <p className="muted">
          Um arquivo para mandar a quem ajuda a investigar um problema: versões, contagens, tempos, estados e erros limpos.
          Não leva títulos, mensagens, nomes, arquivos, contas nem senhas — e nada é enviado sozinho: você baixa e decide.
        </p>
        <a className="btn" href="/api/saude/diagnostico" download>Baixar diagnóstico</a>
      </section>
    </>
  );
}

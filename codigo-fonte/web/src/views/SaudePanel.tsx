import { useState } from 'react';
import { Loading } from '../brand/Brand.tsx';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { PainelSaude, Saude } from '../lib/types.ts';
import { CONFIRMAR_DADOS_ANTIGOS, ondeLibera, rotuloDoCofre, tamanho, TEXTO_CONFIRMAR_DADOS_ANTIGOS, TEXTO_MANTIDOS_DADOS_ANTIGOS, textoConfirmarLiberar, textoDoLiberado, textoUltimaLimpeza } from '../lib/textos-tela.ts';

const CLS: Record<Saude, string> = { operacional: 'badge--ok', limitado: 'badge--warn', atencao: 'badge--err', indisponivel: 'badge--err' };
const LABEL: Record<Saude, string> = { operacional: 'Operacional', limitado: 'Com limitações', atencao: 'Necessita atenção', indisponivel: 'Indisponível' };

/** Espaço das versões da equipe de cada pessoa (só com uma por pessoa): vem do cache do servidor, a tela nunca espera. */
interface Espaco {
  liberavel: number | null;
  /** liberado: null = não deu para medir */
  ultima: { at: string; liberado: number | null; removidas: number } | null;
  volumes: Array<{ nome: string; conta: string }>;
  /** a cópia antiga dos dados da equipe que o cofre não confirmou ter recebido: só sai se a pessoa decidir */
  dadosAntigos?: { desde: string; porque: string; mantida?: boolean } | null;
}
type Painel = PainelSaude & { espaco?: Espaco | null };
interface Liberado { liberado: number | null; removidas: number; volumes: Espaco['volumes'] }

/** No Windows o Ergon roda num ambiente próprio: o espaço sai de dentro dele (o disco do Windows não encolhe na hora). */
const noWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
const onde = ondeLibera(noWindows);

type Acao = { fazendo: boolean; msg: string | null; err: string | null };
const PARADO: Acao = { fazendo: false, msg: null, err: null };

/** Saúde do Ergon: o estado de cada parte, em linguagem simples, e o pacote de diagnóstico (local: nada é enviado). */
export function SaudePanel() {
  const { data, error, reload, loading } = useResource<Painel>('/api/saude', ['runs.changed', 'routines.changed', 'integrations.changed', 'motor.changed']);
  const [backup, setBackup] = useState<Acao>(PARADO);
  const [espaco, setEspaco] = useState<Acao & { perguntar: boolean }>({ ...PARADO, perguntar: false });
  const [cofre, setCofre] = useState<Acao & { alvo: Espaco['volumes'][number] | null }>({ ...PARADO, alvo: null });
  const [antigos, setAntigos] = useState<Acao & { perguntar: boolean }>({ ...PARADO, perguntar: false });
  const doBackup = async () => {
    if (backup.fazendo) return;
    setBackup({ fazendo: true, msg: null, err: null });
    try {
      const r = await api.post<{ counts: { files: number; secrets: number } }>('/api/admin/backup');
      setBackup({ fazendo: false, err: null, msg: `Backup feito e conferido: banco, ${r.counts.files} arquivo(s) e ${r.counts.secrets} credencial(is) de conexão. Fica guardado no Ergon; o lançador copia para a pasta de backups do computador.` });
      reload();
    } catch (e) { setBackup({ fazendo: false, msg: null, err: errMsg(e) }); }
  };
  const liberar = async () => {
    setEspaco({ fazendo: true, msg: null, err: null, perguntar: false });
    try {
      const r = await api.post<Liberado>('/api/saude/liberar-espaco', { confirmar: true });
      setEspaco({ fazendo: false, err: null, perguntar: false, msg: textoDoLiberado(r, noWindows) });
      reload();
    } catch (e) { setEspaco({ fazendo: false, msg: null, err: errMsg(e), perguntar: false }); }
  };
  const apagarCofre = async (v: Espaco['volumes'][number]) => {
    setCofre({ fazendo: true, msg: null, err: null, alvo: null });
    try {
      await api.del(`/api/saude/volumes/${encodeURIComponent(v.nome)}`, { confirmar: v.nome });
      setCofre({ fazendo: false, err: null, alvo: null, msg: `Cofre apagado (${rotuloDoCofre(v.conta)})${onde}.` });
      reload();
    } catch (e) { setCofre({ fazendo: false, msg: null, err: errMsg(e), alvo: null }); }
  };
  const apagarAntigos = async () => {
    setAntigos({ fazendo: true, msg: null, err: null, perguntar: false });
    try {
      const r = await api.post<{ apagado: boolean }>('/api/saude/dados-antigos', { confirmar: CONFIRMAR_DADOS_ANTIGOS });
      setAntigos({ fazendo: false, err: null, perguntar: false, msg: r.apagado ? `Cópia antiga apagada${onde}.` : 'A cópia antiga já não estava neste computador.' });
      reload();
    } catch (e) { setAntigos({ fazendo: false, msg: null, err: errMsg(e), perguntar: false }); }
  };
  // manter também é decisão: nada é apagado, e o aviso deixa de pesar na Saúde (o botão de apagar segue ali)
  const manterAntigos = async () => {
    setAntigos({ fazendo: true, msg: null, err: null, perguntar: false });
    try {
      await api.post('/api/saude/dados-antigos/manter', {});
      setAntigos({ fazendo: false, err: null, perguntar: false, msg: TEXTO_MANTIDOS_DADOS_ANTIGOS });
      reload();
    } catch (e) { setAntigos({ fazendo: false, msg: null, err: errMsg(e), perguntar: false }); }
  };
  if (error && !data) return <section className="card"><p className="error">{error}</p></section>;
  if (!data) return <Loading />;
  const esp = data.espaco ?? null;
  return (
    <>
      <section className="card">
        <div className="row sec-toggle">
          <h3>Saúde do Ergon</h3>
          <span className={`badge ${CLS[data.estado]}`}>{data.rotulo}</span>
        </div>
        <p className="muted">{data.resumo}</p>
        {error && <p className="error" role="alert">Não deu para conferir agora ({error}); mostrando a última conferência.</p>}
        <ul className="sec-rows" aria-label="Partes do Ergon">
          {data.componentes.map((c) => (
            <li key={c.id}>
              <span className={`badge ${CLS[c.estado]}`}>{LABEL[c.estado]}</span> <strong>{c.nome}</strong> <span className="muted">{c.detalhe}</span>
              {c.id === 'backup' && (backup.fazendo
                ? <span className="muted" role="status"> Fazendo o backup…</span>
                : <button className="btn" onClick={doBackup}>Fazer backup agora</button>)}
              {c.id === 'disco' && esp && (espaco.fazendo
                ? <span className="muted" role="status"> Liberando espaço…</span>
                : <button className="btn" onClick={() => setEspaco({ ...PARADO, perguntar: true })}>Liberar espaço{esp.liberavel ? ` (${tamanho(esp.liberavel)})` : ''}</button>)}
              {c.id === 'dados-antigos' && (antigos.fazendo
                ? <span className="muted" role="status"> Um momento…</span>
                : <>
                  {!esp?.dadosAntigos?.mantida && <button className="btn btn--sm" onClick={() => void manterAntigos()}>Manter a cópia</button>}
                  <button className="btn btn--danger btn--sm" onClick={() => setAntigos({ ...PARADO, perguntar: true })}>Apagar a cópia antiga</button>
                </>)}
            </li>
          ))}
        </ul>
        {esp && esp.volumes.length > 0 && (
          <ul className="sec-rows" aria-label="Cofres de contas removidas">
            {esp.volumes.map((v) => (
              <li key={v.nome}>
                <span className="badge badge--warn">Aviso</span> <strong>Cofre de {rotuloDoCofre(v.conta)}</strong>{' '}
                <span className="muted">guarda a conta de IA, a memória e as competências daquela conta; ocupa espaço neste computador.</span>
                {cofre.fazendo ? <span className="muted" role="status"> Apagando…</span>
                  : <button className="btn btn--danger btn--sm" onClick={() => setCofre({ ...PARADO, alvo: v })}>Apagar este cofre</button>}
              </li>
            ))}
          </ul>
        )}
        {backup.msg && <p className="ok" role="status">{backup.msg}</p>}
        {backup.err && <p className="error" role="alert">{backup.err}</p>}
        {espaco.msg && <p className="ok" role="status">{espaco.msg}</p>}
        {espaco.err && <p className="error" role="alert">{espaco.err}</p>}
        {antigos.msg && <p className="ok" role="status">{antigos.msg}</p>}
        {antigos.err && <p className="error" role="alert">{antigos.err}</p>}
        {cofre.msg && <p className="ok" role="status">{cofre.msg}</p>}
        {cofre.err && <p className="error" role="alert">{cofre.err}</p>}
        {esp?.ultima && !espaco.msg && <p className="muted">{textoUltimaLimpeza(esp.ultima, noWindows)}</p>}
        <div className="row"><button className="btn" onClick={reload}>{loading ? 'Conferindo…' : 'Conferir de novo'}</button></div>
      </section>
      {espaco.perguntar && (
        <ConfirmPopup title="Liberar espaço?" confirmLabel="Liberar" onCancel={() => setEspaco({ ...PARADO, perguntar: false })} onConfirm={() => void liberar()}>
          <p>{textoConfirmarLiberar(noWindows)}</p>
        </ConfirmPopup>
      )}
      {cofre.alvo && (
        <ConfirmPopup title="Apagar este cofre?" confirmLabel="Apagar de vez" onCancel={() => setCofre({ ...PARADO, alvo: null })} onConfirm={() => void apagarCofre(cofre.alvo!)}>
          <p>O cofre de {rotuloDoCofre(cofre.alvo.conta)} guarda a conta de IA, a memória e as competências daquela conta. Ele some de vez, sem volta.</p>
        </ConfirmPopup>
      )}
      {antigos.perguntar && (
        <ConfirmPopup title="Apagar a cópia antiga de vez?" confirmLabel="Apagar de vez" onCancel={() => setAntigos({ ...PARADO, perguntar: false })} onConfirm={() => void apagarAntigos()}>
          <p>{TEXTO_CONFIRMAR_DADOS_ANTIGOS}</p>
        </ConfirmPopup>
      )}
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

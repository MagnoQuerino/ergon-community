import { useState } from 'react';
import { Loading } from '../brand/Brand.tsx';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { PainelSaude, Saude } from '../lib/types.ts';
import { CONFIRMAR_DADOS_ANTIGOS, rotuloDoCofre, tamanho, TEXTO_CONFIRMAR_DADOS_ANTIGOS, TEXTO_MANTIDOS_DADOS_ANTIGOS, textoConfirmarLiberar, textoDoLiberado, textoUltimaLimpeza } from '../lib/textos-tela.ts';
import { useT, type Chave } from '../i18n/index.ts';

const CLS: Record<Saude, string> = { operacional: 'badge--ok', limitado: 'badge--warn', atencao: 'badge--err', indisponivel: 'badge--err' };
const LABEL = { operacional: 'configuracoes.saude.operacional', limitado: 'configuracoes.saude.limitado', atencao: 'configuracoes.saude.atencao', indisponivel: 'configuracoes.saude.indisponivel' } as const satisfies Record<Saude, Chave>;

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

type Acao = { fazendo: boolean; msg: string | null; err: string | null };
const PARADO: Acao = { fazendo: false, msg: null, err: null };

/** Saúde do Ergon: o estado de cada parte, em linguagem simples, e o pacote de diagnóstico (local: nada é enviado). */
export function SaudePanel() {
  const t = useT();
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
      setBackup({ fazendo: false, err: null, msg: t('configuracoes.saude.backupFeito', { arquivos: t('configuracoes.saude.arquivos', { n: r.counts.files }), credenciais: t('configuracoes.saude.credenciais', { n: r.counts.secrets }) }) });
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
      setCofre({ fazendo: false, err: null, alvo: null, msg: t(noWindows ? 'configuracoes.saude.cofreApagadoWindows' : 'configuracoes.saude.cofreApagado', { conta: rotuloDoCofre(v.conta) }) });
      reload();
    } catch (e) { setCofre({ fazendo: false, msg: null, err: errMsg(e), alvo: null }); }
  };
  const apagarAntigos = async () => {
    setAntigos({ fazendo: true, msg: null, err: null, perguntar: false });
    try {
      const r = await api.post<{ apagado: boolean }>('/api/saude/dados-antigos', { confirmar: CONFIRMAR_DADOS_ANTIGOS });
      setAntigos({ fazendo: false, err: null, perguntar: false, msg: r.apagado ? t(noWindows ? 'configuracoes.saude.copiaApagadaWindows' : 'configuracoes.saude.copiaApagada') : t('configuracoes.saude.copiaNaoEstava') });
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
          <h3>{t('configuracoes.saude.titulo')}</h3>
          <span className={`badge ${CLS[data.estado]}`}>{data.rotulo}</span>
        </div>
        <p className="muted">{data.resumo}</p>
        {error && <p className="error" role="alert">{t('configuracoes.saude.erroAoConferir', { erro: error })}</p>}
        <ul className="sec-rows" aria-label={t('configuracoes.saude.partes')}>
          {data.componentes.map((c) => (
            <li key={c.id}>
              <span className={`badge ${CLS[c.estado]}`}>{t(LABEL[c.estado])}</span> <strong>{c.nome}</strong> <span className="muted">{c.detalhe}</span>
              {c.id === 'backup' && (backup.fazendo
                ? <span className="muted" role="status"> {t('configuracoes.saude.fazendoBackup')}</span>
                : <button className="btn" onClick={doBackup}>{t('configuracoes.comum.fazerBackup')}</button>)}
              {c.id === 'disco' && esp && (espaco.fazendo
                ? <span className="muted" role="status"> {t('configuracoes.saude.liberando')}</span>
                : <button className="btn" onClick={() => setEspaco({ ...PARADO, perguntar: true })}>{esp.liberavel ? t('configuracoes.saude.liberarTamanho', { tamanho: tamanho(esp.liberavel) }) : t('configuracoes.saude.liberar')}</button>)}
              {c.id === 'dados-antigos' && (antigos.fazendo
                ? <span className="muted" role="status"> {t('configuracoes.saude.umMomento')}</span>
                : <>
                  {!esp?.dadosAntigos?.mantida && <button className="btn btn--sm" onClick={() => void manterAntigos()}>{t('configuracoes.saude.manterCopia')}</button>}
                  <button className="btn btn--danger btn--sm" onClick={() => setAntigos({ ...PARADO, perguntar: true })}>{t('configuracoes.saude.apagarCopia')}</button>
                </>)}
            </li>
          ))}
        </ul>
        {esp && esp.volumes.length > 0 && (
          <ul className="sec-rows" aria-label={t('configuracoes.saude.cofres')}>
            {esp.volumes.map((v) => (
              <li key={v.nome}>
                <span className="badge badge--warn">{t('configuracoes.saude.aviso')}</span> <strong>{t('configuracoes.saude.cofreDe', { conta: rotuloDoCofre(v.conta) })}</strong>{' '}
                <span className="muted">{t('configuracoes.saude.cofreTexto')}</span>
                {cofre.fazendo ? <span className="muted" role="status"> {t('configuracoes.saude.apagando')}</span>
                  : <button className="btn btn--danger btn--sm" onClick={() => setCofre({ ...PARADO, alvo: v })}>{t('configuracoes.saude.apagarCofre')}</button>}
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
        <div className="row"><button className="btn" onClick={reload}>{loading ? t('configuracoes.comum.conferindo') : t('configuracoes.saude.conferirDeNovo')}</button></div>
      </section>
      {espaco.perguntar && (
        <ConfirmPopup title={t('configuracoes.saude.liberarPergunta')} confirmLabel={t('configuracoes.saude.liberarConfirmar')} onCancel={() => setEspaco({ ...PARADO, perguntar: false })} onConfirm={() => void liberar()}>
          <p>{textoConfirmarLiberar(noWindows)}</p>
        </ConfirmPopup>
      )}
      {cofre.alvo && (
        <ConfirmPopup title={t('configuracoes.saude.apagarCofrePergunta')} confirmLabel={t('configuracoes.comum.apagarDeVez')} onCancel={() => setCofre({ ...PARADO, alvo: null })} onConfirm={() => void apagarCofre(cofre.alvo!)}>
          <p>{t('configuracoes.saude.apagarCofreTexto', { conta: rotuloDoCofre(cofre.alvo.conta) })}</p>
        </ConfirmPopup>
      )}
      {antigos.perguntar && (
        <ConfirmPopup title={t('configuracoes.saude.apagarCopiaPergunta')} confirmLabel={t('configuracoes.comum.apagarDeVez')} onCancel={() => setAntigos({ ...PARADO, perguntar: false })} onConfirm={() => void apagarAntigos()}>
          <p>{TEXTO_CONFIRMAR_DADOS_ANTIGOS}</p>
        </ConfirmPopup>
      )}
      <section className="card">
        <h3>{t('configuracoes.saude.diagTitulo')}</h3>
        <p className="muted">{t('configuracoes.saude.diagTexto')}</p>
        <a className="btn" href="/api/saude/diagnostico" download>{t('configuracoes.saude.diagBaixar')}</a>
      </section>
    </>
  );
}

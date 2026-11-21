import { useState } from 'react';
import { api, errMsg } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { fmtDataHora, useT } from '../../i18n/index.ts';

/** O que o servidor diz (world/sync-conexoes.ts, GET /api/world/nuvem/conexoes). */
type EstadoConta = 'na_nuvem' | 'enviando' | 'desligada' | 'aguardando_aceite' | 'fora' | 'erro';
type Motivo = 'whatsapp' | 'endereco_local' | 'app_proprio' | 'sem_credencial' | 'nao_conectada';
interface ContaNaNuvem { id: string; kind: string; app: string; nome: string; estado: EstadoConta; usar: boolean; motivo: Motivo | null }
interface Tela {
  modo: 'computador' | 'nuvem'; disponivel: boolean; semAparelho?: boolean;
  /** o aparelho-nuvem mudou desde o primeiro visto (world/nuvem-fixa.ts): nada vai até a pessoa dona confirmar */
  trocaNuvem?: { desde: string; aparelho: string } | null; aceite?: { em: string } | null; enviadoEm?: string | null; recebidoEm?: string | null;
  erro: string | null; contas: ContaNaNuvem[];
}
const SELO: Record<EstadoConta, string> = { na_nuvem: 'badge--ok', enviando: 'badge--warn', desligada: '', aguardando_aceite: '', fora: '', erro: 'badge--err' };

/** As conexões na nuvem do workspace: só aparece com a nuvem ativa ("Subir o WS para o World") e para o dono. */
export const useConexoesNuvem = () => useResource<Tela>('/api/world/nuvem/conexoes', ['integrations.changed']);

/**
 * A nuvem do workspace passou a ser outro aparelho (recriada, ou um World mal-intencionado trocando a chave): conexões
 * e a chave da sincronia não vão até a pessoa dona confirmar, com a senha (o pedido de senha é o da sessão: api.ts).
 */
export function TrocaDaNuvem({ d, aoConfirmar }: { d: Tela; aoConfirmar: () => void }) {
  const t = useT();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (!d.trocaNuvem) return null;
  const confirmar = async () => {
    if (ocupado) return;
    setOcupado(true); setErro(null);
    try { await api.post('/api/world/nuvem/conexoes/confirmar-nuvem', {}); aoConfirmar(); } catch (e) { setErro(errMsg(e)); } finally { setOcupado(false); }
  };
  return (
    <div className="hint warn conn-nuvem__troca" role="alert">
      <b>{t('conexoes.nuvem.trocaTitulo')}</b>
      <span className="small">{t('conexoes.nuvem.trocaTexto', { quando: fmtDataHora(d.trocaNuvem.desde) })}</span>
      {erro && <span className="error small">{erro}</span>}
      <p className="row row--wrap"><button className="btn btn--sm btn--primary" disabled={ocupado} onClick={() => void confirmar()}>{t('conexoes.nuvem.trocaConfirmar')}</button></p>
    </div>
  );
}

/**
 * Em Conexões: quais contas vão também para a nuvem do workspace (para a equipe usar com o computador desligado). Nada
 * vai antes do aceite explícito, uma vez por workspace; depois, um interruptor por conta (ligado por padrão: a pessoa
 * acabou de dizer que quer a equipe trabalhando na nuvem, e as permissões de cada conta vão junto). O que não pode ir
 * fica listado com o motivo. Na própria nuvem, só a lista do que veio do computador.
 */
export default function ConexoesNuvem() {
  const t = useT();
  const r = useConexoesNuvem();
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const d = r.data;
  if (!d || !d.disponivel) return null;
  const fazer = async (chave: string, fn: () => Promise<unknown>) => {
    if (ocupado) return; // o clique duplo não manda duas vezes
    setOcupado(chave); setErro(null);
    try { await fn(); r.reload(); } catch (e) { setErro(errMsg(e)); } finally { setOcupado(null); }
  };
  const vao = d.contas.filter((c) => !c.motivo && c.usar).length;
  const nome = (c: ContaNaNuvem) => (c.nome && c.nome !== c.app ? `${c.app} · ${c.nome}` : c.app);
  return (
    <section className="conn-group conn-nuvem" id="conn-nuvem" aria-labelledby="conn-nuvem-titulo">
      <h3 id="conn-nuvem-titulo">{t('conexoes.nuvem.titulo')}</h3>
      {d.modo === 'nuvem' ? (
        <>
          <p className="muted small">{t('conexoes.nuvem.daNuvem')}{d.recebidoEm ? ` ${t('conexoes.nuvem.recebidoEm', { quando: fmtDataHora(d.recebidoEm) })}` : ''}</p>
          {d.contas.length ? (
            <ul className="conn-nuvem__lista">
              {d.contas.map((c) => (
                <li key={`${c.kind}-${c.id}`} className="conn-nuvem__linha"><span className="conn-nuvem__nome">{nome(c)}</span><span className={`badge ${SELO[c.estado]}`}>{t(`conexoes.nuvem.estado.${c.estado}`)}</span></li>
              ))}
            </ul>
          ) : <p className="muted small">{t('conexoes.nuvem.resumoNenhuma')}</p>}
        </>
      ) : (
        <>
          <p className="muted small">{t('conexoes.nuvem.intro')}</p>
          <p className="small conn-nuvem__seguranca">{t('conexoes.nuvem.seguranca')}</p>
          <TrocaDaNuvem d={d} aoConfirmar={r.reload} />
          {d.semAparelho && <p className="muted small" role="status">{t('conexoes.nuvem.semAparelho')}</p>}
          {d.erro && <p className="warn small" role="status">{t('conexoes.nuvem.erro')}</p>}
          {erro && <p className="error" role="alert">{erro}</p>}
          {!d.aceite && (confirmando ? (
            <div className="conn-nuvem__confirma" role="group" aria-labelledby="conn-nuvem-confirma">
              <p id="conn-nuvem-confirma"><b>{t('conexoes.nuvem.confirmarTitulo', { n: vao })}</b></p>
              <p className="small">{t('conexoes.nuvem.confirmarTexto')}</p>
              <p className="row row--wrap">
                <button className="btn btn--primary" disabled={!!ocupado} autoFocus onClick={() => void fazer('aceite', async () => { await api.post('/api/world/nuvem/conexoes/aceite', { ligar: true }); setConfirmando(false); })}>{t('conexoes.nuvem.confirmar')}</button>
                <button className="btn btn--ghost" disabled={!!ocupado} onClick={() => setConfirmando(false)}>{t('conexoes.nuvem.cancelar')}</button>
              </p>
            </div>
          ) : (
            <p><button className="btn btn--primary" disabled={!vao} onClick={() => setConfirmando(true)}>{t('conexoes.nuvem.aceitar')}</button></p>
          ))}
          {d.contas.length ? (
            <ul className="conn-nuvem__lista">
              {d.contas.map((c) => (
                <li key={c.id} className={`conn-nuvem__linha ${c.motivo ? 'conn-nuvem__linha--fora' : ''}`}>
                  <span className="conn-nuvem__nome">{nome(c)}</span>
                  <span className={`badge ${SELO[c.estado]}`}>{t(`conexoes.nuvem.estado.${c.estado}`)}</span>
                  {c.motivo ? <span className="muted small conn-nuvem__motivo">{t(`conexoes.nuvem.motivo.${c.motivo}`)}</span> : (
                    <button role="switch" aria-checked={c.usar} aria-label={t('conexoes.nuvem.usarAria', { app: c.app, conta: c.nome || c.app })} className={`switch ${c.usar ? 'switch--on' : ''}`}
                      disabled={ocupado === c.id} onClick={() => void fazer(c.id, () => api.put(`/api/world/nuvem/conexoes/${c.id}`, { usar: !c.usar }))}>
                      <span className="switch__knob" /><span className="switch__txt">{c.usar ? t('conexoes.nuvem.ligado') : t('conexoes.nuvem.desligado')}</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="muted small">{t('conexoes.nuvem.nenhuma')}</p>}
          {d.aceite && (
            <p className="row row--wrap">
              {d.enviadoEm && <span className="muted small">{t('conexoes.nuvem.enviadoEm', { quando: fmtDataHora(d.enviadoEm) })}</span>}
              <span className="grow" />
              <button className="btn btn--sm btn--ghost" disabled={!!ocupado} onClick={() => void fazer('tirar', () => api.post('/api/world/nuvem/conexoes/aceite', { ligar: false }))}>{ocupado === 'tirar' ? t('conexoes.nuvem.tirando') : t('conexoes.nuvem.tirarTudo')}</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Uma linha no cartão "Subir o WS para o World": quantas conexões estão na nuvem e o caminho para escolher. */
export function ResumoConexoesNuvem() {
  const t = useT();
  const r = useConexoesNuvem(); const d = r.data;
  if (!d || !d.disponivel || d.modo !== 'computador') return null;
  const n = d.aceite ? d.contas.filter((c) => c.estado === 'na_nuvem' || c.estado === 'enviando').length : 0;
  return (
    <>
      <TrocaDaNuvem d={d} aoConfirmar={r.reload} />
      <p className="small conn-nuvem__resumo">
        {n ? t('conexoes.nuvem.resumo', { n }) : t('conexoes.nuvem.resumoNenhuma')} · <a href="#conexoes?nuvem" className="link link--inline">{t('conexoes.nuvem.escolher')}</a>
      </p>
    </>
  );
}

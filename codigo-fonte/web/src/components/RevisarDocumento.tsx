import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import type { EstadoRevisao } from '../lib/documento.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { Icon } from './Icon.tsx';
import { useT } from '../i18n/index.ts';

/**
 * "Revisar com o coordenador" (rc.42): o balão de conversa sobre o documento. A pessoa pede no documento inteiro ou no
 * trecho marcado; os pedidos entram na fila e andam em ordem. Enquanto a equipe edita, o balão mostra quem está em quê
 * (o avatar com a cor dele e a ação). O coordenador delega; ninguém edita daqui.
 */
export function RevisarDocumento({ artId, estado, trecho, onTrecho, onClose }: {
  artId: string; estado: EstadoRevisao | null; trecho: string | null; onTrecho: (t: string | null) => void; onClose: () => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const lista = useRef<HTMLOListElement>(null);
  useEffect(() => { campo.current?.focus(); }, [trecho]);
  useEffect(() => { lista.current?.scrollTo({ top: lista.current.scrollHeight }); }, [estado?.pedidos.length]);

  const pedir = async () => {
    const p = texto.trim();
    if (!p || enviando) return;
    setEnviando(true); setErro(null);
    try { await api.post(`/api/artifacts/${artId}/revisao`, { pedido: p, trecho }); setTexto(''); onTrecho(null); }
    catch (e) { setErro(errMsg(e)); }
    finally { setEnviando(false); }
  };
  // um agente aparece uma vez, com o que ele faz agora (trabalhando > aguardando > feito)
  const ordem = { trabalhando: 0, espera: 1, falhou: 2, feito: 3 } as const;
  const frentes = [...new Map((estado?.ativa?.frentes ?? []).slice().sort((a, b) => ordem[b.estado] - ordem[a.estado]).map((f) => [f.agente.id, f])).values()]
    .sort((a, b) => ordem[a.estado] - ordem[b.estado]);

  return (
    <aside className="rdoc" role="dialog" aria-label={t('documentos.doc.revisar')}>
      <header className="rdoc__topo">
        <b>{t('documentos.doc.revisar')}</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('documentos.doc.fechar')}><Icon name="x" size={16} /></button>
      </header>
      <ol className="rdoc__lista" ref={lista}>
        {(estado?.pedidos ?? []).map((p) => (
          <li key={p.id} className={`rdoc__pedido rdoc__pedido--${p.estado}`}>
            <p className="rdoc__fala">{p.trecho && <q className="rdoc__q">{p.trecho}</q>}{p.pedido}</p>
            <span className="rdoc__estado">
              {t(`documentos.doc.estado.${p.estado}`)}
              {p.estado === 'fila' && <button type="button" className="rdoc__tirar" onClick={() => void api.del(`/api/artifacts/${artId}/revisao/${p.id}`).catch((e) => setErro(errMsg(e)))} aria-label={t('documentos.doc.cancelar')} title={t('documentos.doc.cancelar')}><Icon name="x" size={11} /></button>}
            </span>
            {p.estado === 'editando' && frentes.length > 0 && (
              <ul className="rdoc__equipe">
                {frentes.map((f) => (
                  <li key={f.id} className={`rdoc__frente rdoc__frente--${f.estado}`} style={{ ['--agente' as string]: f.cor }} title={f.agente.name}>
                    <span className="rdoc__av"><AgentAvatar agent={f.agente} size={22} /></span>
                    <span className="rdoc__nome">{f.agente.name}</span>
                    <small>{f.estado === 'trabalhando' ? t(`documentos.doc.acao.${f.acao}`) : f.estado === 'espera' ? t('documentos.doc.acao.espera') : t(`documentos.doc.estado.${f.estado === 'feito' ? 'feito' : 'falhou'}`)}</small>
                  </li>
                ))}
              </ul>
            )}
            {p.erro && <small className="error">{p.erro}</small>}
          </li>
        ))}
      </ol>
      <form className="rdoc__form" onSubmit={(e) => { e.preventDefault(); void pedir(); }}>
        {trecho && (
          <span className="rdoc__chip" title={trecho}>
            <Icon name="pen" size={12} /> <span>{trecho}</span>
            <button type="button" onClick={() => onTrecho(null)} aria-label={t('documentos.doc.tirarTrecho')}><Icon name="x" size={11} /></button>
          </span>
        )}
        <div className="rdoc__campo">
          <textarea ref={campo} value={texto} rows={2} maxLength={2000} placeholder={t('documentos.doc.pedido')} aria-label={t('documentos.doc.pedido')}
            onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void pedir(); } }} />
          <button type="submit" className="btn btn--primary btn--sm" disabled={!texto.trim() || enviando} aria-label={t('documentos.doc.enviar')} title={t('documentos.doc.enviar')}><Icon name="send" size={14} /></button>
        </div>
        {erro && <small className="error">{erro}</small>}
      </form>
    </aside>
  );
}

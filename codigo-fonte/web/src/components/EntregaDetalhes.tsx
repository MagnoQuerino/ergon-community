// A entrega no modelo (server/src/services/modelos-entrega.ts): o topo do card (o tipo e os itens curtos, com os links
// do que foi citado) e o diálogo "Ver detalhes", com o relatório por item e as ações ali mesmo — aprovar o item ou tudo,
// devolver com uma instrução. A pessoa decide sem fechar: o item muda de estado na hora e o card se atualiza por trás.
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { openConversation } from '../lib/open.ts';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { ACAO, FILEIRA } from '../lib/cartoes-acoes.ts';

export type TipoEntrega = 'decisao' | 'entrega' | 'relatorio' | 'pergunta' | 'bloqueio';
export interface Referencia { tipo: string; titulo: string; url: string | null; id: string | null }
interface ItemDecisao { titulo: string; acao: string | null; contexto: string; objeto: string; riscos: { prazo: string | null; inacao: string | null; em_jogo: string }; extras: Record<string, string>; referencias?: Referencia[] }
type Entrega =
  | { tipo: 'decisao'; itens: ItemDecisao[] }
  | { tipo: 'entrega'; resumo: string; arquivos: string[]; atencao: string[]; detalhes: string; extras: Record<string, string>; referencias?: Referencia[] }
  | { tipo: 'relatorio'; resumo: string; pontos: string[]; detalhes: string; extras: Record<string, string>; referencias?: Referencia[] }
  | { tipo: 'pergunta'; pergunta: string; opcoes: string[]; porque: string; extras: Record<string, string>; referencias?: Referencia[] }
  | { tipo: 'bloqueio'; motivo: string; precisa: string; tentado: string[]; detalhes: string; extras: Record<string, string>; referencias?: Referencia[] };
export interface ModeloDaTarefa {
  id: string | null; tipo: TipoEntrega; minimo: boolean; lead: string | null;
  itens: Array<{ titulo: string; decisao: 'aprovado' | 'devolvido' | null }>; entrega: Entrega;
}
/** o que a pessoa pode fazer agora no card (o mesmo critério dos botões grandes) */
export type PodeAgir = 'aprovar' | 'devolver' | 'revisar' | null;

const ICONE_REF: Record<string, string> = { email: 'send', documento: 'file', arquivo: 'file', evento: 'clock', tarefa: 'tasks', pr: 'code', issue: 'code', mensagem: 'chat', conversa: 'chat', card: 'flag', pagina: 'globe' };
/** o estado de uma decisão: a cor do selo e o ícone (nomes de classe e de ícone, não texto de tela) */
const SELO = { aprovado: { tom: 'ok', icone: 'check' }, devolvido: { tom: 'warn', icone: 'undo' } } as const; // i18n-ok: classes e ícones
const DECISAO = { aprovar: 'aprovado', devolver: 'devolvido' } as const; // i18n-ok: os estados que o servidor grava
const TIPO_TOM: Record<TipoEntrega, string> = { decisao: 'decidir', entrega: 'feito', relatorio: 'feito', pergunta: 'precisa', bloqueio: 'falhou' }; // i18n-ok: nomes de classe

/** O destino de uma referência: o link do aplicativo (abre fora), ou o objeto do Ergon (card, conversa, arquivo). */
function destino(r: Referencia): string | null {
  if (r.url && /^https?:\/\//i.test(r.url)) return r.url;
  if (!r.id) return null;
  if (r.id.startsWith('tsk_')) return `#equipe?card=${encodeURIComponent(r.id)}`;
  if (r.id.startsWith('art_')) return `/api/artifacts/${encodeURIComponent(r.id)}/download`;
  return null;
}

/** Os links do que a entrega cita, como chips: um clique abre o e-mail, o documento, o PR, o card. */
export function RefChips({ refs }: { refs?: Referencia[] }) {
  const t = useT();
  if (!refs?.length) return null;
  return (
    <span className="ent-refs">
      {refs.map((r, i) => {
        const href = destino(r);
        const rotulo = t('tarefa.entrega.abrir', { titulo: r.titulo });
        const corpo = <><Icon name={ICONE_REF[r.tipo] ?? 'globe'} size={12} /><span className="ent-ref__t">{r.titulo}</span></>;
        if (r.id?.startsWith('cnv_')) return <button key={i} type="button" className="chip ent-ref" title={rotulo} aria-label={rotulo} onClick={() => openConversation(null, r.id)}>{corpo}</button>;
        return href
          ? <a key={i} className="chip ent-ref" href={href} title={rotulo} aria-label={rotulo} {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{corpo}</a>
          : <span key={i} className="chip ent-ref">{corpo}</span>;
      })}
    </span>
  );
}

/** As referências de cada linha curta do topo (só a decisão tem por item; os outros tipos, no topo). */
const refsDoItem = (e: Entrega, i: number): Referencia[] | undefined => (e.tipo === 'decisao' ? e.itens[i]?.referencias : undefined);

/** O topo do card: o título do tipo, a linha de cima, os itens curtos e "Ver detalhes" logo abaixo. */
export function ModeloTopo({ modelo, onDetalhes }: { modelo: ModeloDaTarefa; onDetalhes: () => void }) {
  const t = useT();
  const e = modelo.entrega;
  return (
    <>
      <p className="tdet__faixa-t">{t(`tarefa.entrega.tipo.${modelo.tipo}`)}</p>
      {modelo.lead && <p className="tdet__frase">{modelo.lead}</p>}
      {modelo.itens.length > 0 && (
        <ul className="ent-itens">
          {modelo.itens.map((x, i) => (
            <li key={i} className={x.decisao ? `is-${x.decisao}` : ''}>
              <span className="ent-itens__t">{x.titulo}</span>
              {x.decisao && <span className={`badge badge--${SELO[x.decisao].tom}`}><Icon name={SELO[x.decisao].icone} size={11} /> {t(`tarefa.entrega.${x.decisao}`)}</span>}
              <RefChips refs={refsDoItem(e, i)} />
            </li>
          ))}
        </ul>
      )}
      {e.tipo !== 'decisao' && <RefChips refs={e.referencias} />}
      <div><button type="button" className="btn btn--sm ent-ver" onClick={onDetalhes} data-keep-surface><Icon name="eye" size={14} /> {t('tarefa.entrega.verDetalhes')}</button></div>
    </>
  );
}

function Bloco({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return <div className="ent-bloco"><h5>{rotulo}</h5>{children}</div>;
}
/** detalhes: Markdown (listas, tabelas e os blocos visuais ```ergon-<tipo>); os campos curtos em parágrafos */
const Paragrafos = ({ texto }: { texto: string }) => <>{texto.split(/\n{2,}/).map((p, i) => <p key={i} className="pre">{p}</p>)}</>;
const Lista = ({ xs }: { xs: string[] }) => (xs.length ? <ul className="ent-lista">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : null);
const Extras = ({ ex }: { ex: Record<string, string> }) => (Object.keys(ex).length ? <dl className="ent-extras">{Object.entries(ex).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>)}</dl> : null);

/**
 * O diálogo "Ver detalhes": o relatório completo para revisar de imediato. Na decisão, cada ponto com o contexto (de onde
 * veio), o objeto e os riscos, e Aprovar / Devolver por item; embaixo, Aprovar tudo e Devolver com instruções.
 */
export function EntregaDetalhes({ taskId, modelo, pode, onClose, onChanged }: { taskId: string; modelo: ModeloDaTarefa; pode: PodeAgir; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [decisoes, setDecisoes] = useState<Record<string, 'aprovado' | 'devolvido'>>(() => Object.fromEntries(modelo.itens.flatMap((x, i) => (x.decisao ? [[String(i), x.decisao]] : []))));
  const [feito, setFeito] = useState<'aprovado' | 'devolvido' | null>(null);
  const [devolvendo, setDevolvendo] = useState<number | 'tudo' | null>(null);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const e = modelo.entrega;
  const fechado = feito !== null || pode === null;

  const agir = async (chave: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(chave); setErr(null);
    try { await fn(); onChanged(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(null); }
  };
  const decidirItem = (i: number, decisao: 'aprovado' | 'devolvido', instrucao?: string) => agir(`${decisao}:${i}`, async () => {
    const r = await api.post<{ decisoes: Record<string, 'aprovado' | 'devolvido'>; result: string | null }>(`/api/tasks/${taskId}/entrega/decidir`, { entregaId: modelo.id, indice: i, decisao, ...(instrucao ? { instrucao } : {}) });
    setDecisoes(r.decisoes);
    if (decisao === 'devolvido') { setFeito(decisao); setDevolvendo(null); setTexto(''); }
    else if (r.result) setFeito(decisao);
  });
  const aprovarTudo = () => agir('tudo', async () => { await api.post(`/api/tasks/${taskId}/respond`, { action: 'approve' }); setFeito(DECISAO.aprovar); });
  const devolverTudo = (txt: string) => agir('devolver', async () => {
    if (pode === 'revisar') await api.post(`/api/tasks/${taskId}/revise`, { text: txt });
    else await api.post(`/api/tasks/${taskId}/respond`, { action: 'return', text: txt });
    setFeito(DECISAO.devolver); setDevolvendo(null); setTexto('');
  });
  const instrucao = (alvo: number | 'tudo', rotulo: string) => (
    <form className="ent-instrucao" onSubmit={(ev) => { ev.preventDefault(); const x = texto.trim(); if (x.length < 3) return; void (alvo === 'tudo' ? devolverTudo(x) : decidirItem(alvo, 'devolvido', x)); }}>
      <label className="field">{rotulo}<textarea data-autofocus rows={2} value={texto} onChange={(ev) => setTexto(ev.target.value)} maxLength={2000} /></label>
      <div className={FILEIRA}>
        <button className={ACAO.principal} disabled={texto.trim().length < 3} aria-busy={busy === 'devolver' || busy === `devolvido:${alvo}`}><Icon name="send" size={14} /> {t('tarefa.entrega.enviar')}</button>
        <button type="button" className={ACAO.secundario} onClick={() => { setDevolvendo(null); setTexto(''); }}>{t('tarefa.voltar')}</button>
      </div>
    </form>
  );

  // no corpo da página: dentro do painel do card, o diálogo ficava preso no empilhamento dele (a bolha das conversas por cima)
  return createPortal(
    <div className="dlg-back ent-back">
      <section ref={ref} className={`dlg ent-dlg ent-dlg--${TIPO_TOM[modelo.tipo]}${feito ? ` is-${feito}` : ''}`} role="dialog" aria-modal="true" aria-labelledby="ent-dlg-t">
        <header className="dlg__head">
          <h3 id="ent-dlg-t">{t(`tarefa.entrega.tipo.${modelo.tipo}`)}</h3>
          <span className="row">
            {feito && <span className={`badge badge--${SELO[feito].tom} ent-feito`} role="status"><Icon name={SELO[feito].icone} size={13} /> {t(`tarefa.entrega.${feito}`)}</span>}
            {modelo.minimo && !feito && <span className="badge">{t('tarefa.entrega.automatico')}</span>}
            <button className="icon-btn" onClick={onClose} aria-label={t('tarefa.entrega.fechar')} title={t('tarefa.entrega.fechar')}><Icon name="x" /></button>
          </span>
        </header>

        {e.tipo === 'decisao' && (
          <ol className="ent-pontos">
            {e.itens.map((x, i) => {
              const d = decisoes[String(i)] ?? null;
              return (
                <li key={i} className={`ent-ponto${d ? ` is-${d}` : ''}`}>
                  <div className="ent-ponto__head">
                    <h4>{x.titulo}</h4>
                    {d && <span className={`badge badge--${SELO[d].tom}`}><Icon name={SELO[d].icone} size={11} /> {t(`tarefa.entrega.${d}`)}</span>}
                  </div>
                  <RefChips refs={x.referencias} />
                  <Bloco rotulo={t('tarefa.entrega.contexto')}><Paragrafos texto={x.contexto} /></Bloco>
                  <Bloco rotulo={t('tarefa.entrega.objeto')}><Paragrafos texto={x.objeto} /></Bloco>
                  <Bloco rotulo={t('tarefa.entrega.riscos')}>
                    <dl className="ent-riscos">
                      {x.riscos.prazo && <div><dt>{t('tarefa.entrega.prazo')}</dt><dd>{x.riscos.prazo}</dd></div>}
                      {x.riscos.inacao && <div><dt>{t('tarefa.entrega.inacao')}</dt><dd>{x.riscos.inacao}</dd></div>}
                      <div><dt>{t('tarefa.entrega.emJogo')}</dt><dd>{x.riscos.em_jogo}</dd></div>
                    </dl>
                  </Bloco>
                  <Extras ex={x.extras} />
                  {pode === 'aprovar' && !fechado && !d && modelo.id && (devolvendo === i ? instrucao(i, t('tarefa.entrega.instrucaoItem', { titulo: x.titulo })) : (
                    <div className={FILEIRA}>
                      <button className={ACAO.principal} aria-busy={busy === `aprovado:${i}`} onClick={() => void decidirItem(i, 'aprovado')}><Icon name="check" size={14} /> {t('tarefa.entrega.aprovarItem')}</button>
                      <button className={ACAO.secundario} onClick={() => { setDevolvendo(i); setTexto(''); }}><Icon name="undo" size={14} /> {t('tarefa.entrega.devolverItem')}</button>
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>
        )}
        {e.tipo === 'entrega' && <>
          <p className="ent-lead">{e.resumo}</p>
          <RefChips refs={e.referencias} />
          {e.arquivos.length > 0 && <Bloco rotulo={t('tarefa.entrega.arquivos')}><Lista xs={e.arquivos} /></Bloco>}
          {e.atencao.length > 0 && <Bloco rotulo={t('tarefa.entrega.atencao')}><Lista xs={e.atencao} /></Bloco>}
          <Bloco rotulo={t('tarefa.entrega.relatorio')}><Markdown className="entrega__md" text={e.detalhes} /></Bloco>
          <Extras ex={e.extras} />
        </>}
        {e.tipo === 'relatorio' && <>
          <p className="ent-lead">{e.resumo}</p>
          <RefChips refs={e.referencias} />
          <Lista xs={e.pontos} />
          <Bloco rotulo={t('tarefa.entrega.relatorio')}><Markdown className="entrega__md" text={e.detalhes} /></Bloco>
          <Extras ex={e.extras} />
        </>}
        {e.tipo === 'pergunta' && <>
          <p className="ent-lead">{e.pergunta}</p>
          <RefChips refs={e.referencias} />
          {e.opcoes.length > 0 && <Bloco rotulo={t('tarefa.entrega.opcoes')}><Lista xs={e.opcoes} /></Bloco>}
          {e.porque && e.porque !== e.pergunta && <Bloco rotulo={t('tarefa.entrega.porque')}><Paragrafos texto={e.porque} /></Bloco>}
          <Extras ex={e.extras} />
        </>}
        {e.tipo === 'bloqueio' && <>
          <p className="ent-lead">{e.motivo}</p>
          <RefChips refs={e.referencias} />
          {e.precisa && <Bloco rotulo={t('tarefa.entrega.precisa')}><p>{e.precisa}</p></Bloco>}
          {e.tentado.length > 0 && <Bloco rotulo={t('tarefa.entrega.tentado')}><Lista xs={e.tentado} /></Bloco>}
          {e.detalhes && e.detalhes !== e.motivo && <Bloco rotulo={t('tarefa.entrega.relatorio')}><Markdown className="entrega__md" text={e.detalhes} /></Bloco>}
          <Extras ex={e.extras} />
        </>}

        {err && <p className="error" role="alert">{err}</p>}
        {!fechado && (devolvendo === 'tudo' ? instrucao('tudo', t('tarefa.entrega.instrucao')) : (
          <footer className="dlg__foot ent-foot">
            {pode === 'aprovar' && <button className={ACAO.principal} aria-busy={busy === 'tudo'} onClick={() => void aprovarTudo()}><Icon name="check" size={14} /> {t('tarefa.entrega.aprovarTudo')}</button>}
            <button className={ACAO.secundario} onClick={() => { setDevolvendo('tudo'); setTexto(''); }}><Icon name="undo" size={14} /> {t('tarefa.entrega.devolver')}</button>
          </footer>
        ))}
      </section>
    </div>,
    document.body,
  );
}

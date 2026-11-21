import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { parseMarkdown, type Block } from '../lib/markdown.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { size } from '../lib/files.ts';
import {
  blocoVisual, estiloDoPapel, presencaPorTrecho, regraDePagina, trechosAoVivo, trechosMudados,
  type EstadoRevisao, type FrenteAoVivo, type Identidade, type ModeloDoc,
} from '../lib/documento.ts';
import { IDENTIDADE_PADRAO, MODELOS_ORIGINAIS, REFERENCIAS, numeracao, preencher, tituloDoDocumento } from '../../../shared/entregaveis.ts';
import { trechosDe } from '../../../shared/revisao.ts';
import { ErgonMarca } from '../brand/Brand.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { useEscuro, varsDaCor } from '../lib/cores-agentes.ts';
import { Icon } from './Icon.tsx';
import { inl } from './Markdown.tsx';
import { RevisarDocumento } from './RevisarDocumento.tsx';
import { fmtData, fmtDataHora, useIdioma, useT } from '../i18n/index.ts';

interface DocResp { texto: string; filename: string; modelo: ModeloDoc; modeloEscolhido: string | null; identidade: Identidade; versao: number }

/**
 * O documento entregue (rc.42): o .md como uma folha bem composta — a identidade do workspace no cabeçalho, o modelo
 * (fonte, entrelinha, margens, capa, títulos numerados, citação e referências ABNT) e, para quem revisa, a equipe
 * editando ao vivo (avatar ao lado do trecho, a cor dele, o rótulo da ação e o cursor escrevendo).
 *
 * Reutilizável: `fonte` é um arquivo de Documentos (com modelo, versões, PDF e revisão) ou um texto solto (o relatório
 * de outro módulo; sem revisão). `modo="dialogo"` abre por cima de tudo; `embutido` vai dentro de outra tela.
 * Blocos ```ergon-<tipo>``` são desenhados por quem registrou o tipo (lib/documento.ts, registrarBlocoVisual).
 */
export function Documento({ fonte, modo = 'dialogo', onClose, revisar = true, modelo: modeloFixo, identidade: idFixa, acoes }: {
  fonte: { artifactId: string; tamanho?: number } | { texto: string; titulo: string };
  modo?: 'dialogo' | 'embutido';
  onClose?: () => void;
  /** o balão "Revisar com o coordenador" (só para arquivo) */
  revisar?: boolean;
  /** prévia (Configurações): modelo e identidade em edição, sem salvar */
  modelo?: ModeloDoc; identidade?: Identidade;
  /** botões a mais na barra (quem embute) */
  acoes?: ReactNode;
}) {
  const t = useT();
  useIdioma();
  const ref = useRef<HTMLElement>(null);
  const artId = 'artifactId' in fonte ? fonte.artifactId : null;
  useSurface(ref, { onClose: onClose ?? (() => undefined), modal: modo === 'dialogo', outside: modo === 'dialogo', active: modo === 'dialogo' && !!onClose });
  const doc = useResource<DocResp>(artId ? `/api/artifacts/${artId}/documento` : null, ['artifacts.changed', 'entregaveis.changed']);
  const idSolta = useResource<Identidade>(!artId && !idFixa ? '/api/entregaveis/identidade' : null, ['entregaveis.changed']);
  const lista = useResource<{ modelos: ModeloDoc[]; padrao: string }>('/api/entregaveis/modelos', ['entregaveis.changed']);
  const rev = useResource<EstadoRevisao>(artId && revisar ? `/api/artifacts/${artId}/revisao` : null, ['docs.revisao', 'runs.live', 'artifacts.changed']);
  const [semLogo, setSemLogo] = useState(() => { try { return localStorage.getItem('ergon.doc.semLogo') === '1'; } catch { return false; } });
  const [balao, setBalao] = useState(false);
  const [trecho, setTrecho] = useState<string | null>(null);
  const [sel, setSel] = useState<{ x: number; y: number; texto: string } | null>(null);
  const [versoes, setVersoes] = useState(false);
  const [imprimindo, setImprimindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const corpoRef = useRef<HTMLDivElement>(null);

  const texto = artId ? doc.data?.texto ?? null : (fonte as { texto: string }).texto;
  const filename = artId ? doc.data?.filename ?? '' : (fonte as { titulo: string }).titulo;
  const identidade = idFixa ?? (artId ? doc.data?.identidade : idSolta.data) ?? IDENTIDADE_PADRAO;
  const padrao = lista.data?.modelos.find((m) => m.id === lista.data?.padrao) ?? MODELOS_ORIGINAIS[0];
  const modelo = modeloFixo ?? (artId ? doc.data?.modelo : padrao) ?? MODELOS_ORIGINAIS[0];
  const titulo = texto !== null ? tituloDoDocumento(texto, filename) : filename;
  const ativa = rev.data?.ativa ?? null;

  // os trechos (durante a edição, os da revisão, com o texto chegando no lugar)
  const trechos = useMemo(() => (ativa ? trechosAoVivo(ativa.trechos, ativa.frentes) : (texto !== null ? trechosDe(texto) : []).map((x) => ({ texto: x, escrevendo: null as FrenteAoVivo | null }))), [ativa, texto]);
  const presenca = useMemo(() => presencaPorTrecho(ativa?.frentes ?? []), [ativa]);

  // realce suave do que mudou entre uma versão e a seguinte
  const versao = rev.data?.versao ?? doc.data?.versao ?? 0;
  const antes = useRef<{ v: number; t: string[] } | null>(null);
  const [novos, setNovos] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (ativa || texto === null) return;
    const agora = trechosDe(texto);
    if (antes.current && antes.current.v !== versao) {
      setNovos(trechosMudados(antes.current.t, agora));
      const tm = setTimeout(() => setNovos(new Set()), 2600);
      antes.current = { v: versao, t: agora };
      return () => clearTimeout(tm);
    }
    antes.current = { v: versao, t: agora };
  }, [versao, texto, ativa]);

  // marcar um trecho: o botão "Revisar trecho" aparece junto da seleção
  useEffect(() => {
    if (!artId || !revisar) return;
    const up = () => setTimeout(() => {
      const s = window.getSelection();
      const txt = s?.toString().trim() ?? '';
      const box = corpoRef.current;
      if (!s || !box || txt.length < 4 || !s.rangeCount || !box.contains(s.anchorNode)) { setSel(null); return; }
      const r = s.getRangeAt(0).getBoundingClientRect();
      const b = box.getBoundingClientRect();
      setSel({ x: Math.min(b.width - 140, Math.max(0, r.left - b.left + r.width / 2 - 60)), y: r.top - b.top + box.scrollTop - 40, texto: txt.slice(0, 4000) });
    }, 0);
    document.addEventListener('mouseup', up); document.addEventListener('keyup', up);
    return () => { document.removeEventListener('mouseup', up); document.removeEventListener('keyup', up); };
  }, [artId, revisar]);

  const trocarModelo = async (m: string) => {
    if (!artId) return;
    try { await api.put(`/api/artifacts/${artId}/modelo`, { modelo: m || null }); doc.reload(); } catch (e) { setErro(errMsg(e)); }
  };
  const imprimir = () => {
    flushSync(() => setImprimindo(true));
    const fim = () => { setImprimindo(false); window.removeEventListener('afterprint', fim); };
    window.addEventListener('afterprint', fim);
    window.print();
  };
  const alternarLogo = () => { setSemLogo((v) => { try { localStorage.setItem('ergon.doc.semLogo', v ? '0' : '1'); } catch { /* sem armazenamento */ } return !v; }); };

  const papel = (impressao: boolean) => (
    <Papel trechos={trechos} modelo={modelo} identidade={identidade} titulo={titulo} semLogo={semLogo} impressao={impressao}
      presenca={impressao ? new Map() : presenca} novos={impressao ? new Set() : novos} />
  );

  const carregando = artId && !doc.data;
  const barra = (
    <div className="doc__barra" role="toolbar" aria-label={titulo}>
      {artId && lista.data && (
        <label className="doc__modelo" title={t('documentos.doc.modelo')}>
          <Icon name="palette" size={14} />
          <select value={doc.data?.modeloEscolhido ?? ''} onChange={(e) => void trocarModelo(e.target.value)} aria-label={t('documentos.doc.modelo')}>
            <option value="">{t('documentos.doc.modeloPadrao')} · {padrao.nome}</option>
            {lista.data.modelos.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </label>
      )}
      <button type="button" className={`iact iact--sm ${semLogo ? '' : 'is-on'}`} onClick={alternarLogo} aria-pressed={!semLogo} title={t('documentos.doc.logo')} aria-label={t('documentos.doc.logo')}><Icon name="image" size={15} /></button>
      {artId && <button type="button" className="iact iact--sm" onClick={() => setVersoes((v) => !v)} aria-expanded={versoes} title={t('documentos.doc.versoes')} aria-label={t('documentos.doc.versoes')}><Icon name="clock" size={15} />{versao > 1 && <span className="doc__vn">{t('documentos.doc.versao', { n: versao })}</span>}</button>}
      <button type="button" className="iact iact--sm" onClick={imprimir} title={t('documentos.doc.imprimir')} aria-label={t('documentos.doc.imprimir')}><Icon name="print" size={15} /></button>
      {artId && <a className="btn btn--sm" href={`/api/artifacts/${artId}/pdf${semLogo ? '?semLogo=1' : ''}`} download><Icon name="download" size={13} /> {t('documentos.doc.pdf')}</a>}
      {artId && <a className="btn btn--sm" href={`/api/artifacts/${artId}/download`} download={filename}>{t('documentos.doc.baixarMd')}{'tamanho' in fonte && fonte.tamanho ? ` · ${size(fonte.tamanho)}` : ''}</a>}
      {artId && revisar && <button type="button" className={`btn btn--sm btn--primary doc__revisar ${ativa ? 'is-vivo' : ''}`} onClick={() => setBalao((b) => !b)} aria-expanded={balao}><Icon name="chat" size={13} /> {t('documentos.doc.revisarCurto')}</button>}
      {acoes}
      {onClose && <button className="icon-btn" onClick={onClose} aria-label={t('documentos.doc.fechar')} title={t('documentos.doc.fechar')}><Icon name="x" /></button>}
    </div>
  );

  const corpo = (
    <div className="doc__mesa" ref={corpoRef}>
      {erro && <p className="error doc__erro" role="alert">{erro}</p>}
      {doc.error ? <p className="error">{t('documentos.doc.naoAbriu')}</p> : carregando ? <p className="muted doc__abrindo">{t('documentos.doc.abrindo')}</p> : papel(false)}
      {sel && !balao && (
        <button type="button" className="btn btn--sm btn--primary doc__selbtn" style={{ left: sel.x, top: sel.y }}
          onMouseDown={(e) => e.preventDefault()} onClick={() => { setTrecho(sel.texto); setBalao(true); setSel(null); }}>
          <Icon name="pen" size={13} /> {t('documentos.doc.revisarTrecho')}
        </button>
      )}
    </div>
  );
  const sobre = (
    <>
      {versoes && artId && <Versoes artId={artId} onClose={() => setVersoes(false)} onErro={setErro} />}
      {balao && artId && <RevisarDocumento artId={artId} estado={rev.data} trecho={trecho} onTrecho={setTrecho} onClose={() => setBalao(false)} />}
    </>
  );

  const impressao = imprimindo && createPortal(
    <div className="doc-impressao">
      <style>{regraDePagina(modelo, preencher(modelo.rodape.texto, { titulo, empresa: identidade.nome, data: fmtData(new Date().toISOString()) }))}</style>
      {papel(true)}
    </div>, document.body);

  if (modo === 'embutido') return <section className="doc--embutido" aria-label={titulo}>{barra}{corpo}{sobre}{impressao}</section>;
  return createPortal(
    <div className="dlg-back doc-back">
      <section ref={ref} className="dlg doc" role="dialog" aria-modal="true" aria-label={titulo}>
        <header className="doc__topo">
          <h3 className="doc__nome" title={filename}>{filename}</h3>
          {barra}
        </header>
        {corpo}
        {sobre}
      </section>
      {impressao}
    </div>,
    document.body,
  );
}

/** A folha: cabeçalho com a identidade, capa (se o modelo pede) e os trechos. */
function Papel({ trechos, modelo, identidade, titulo, semLogo, impressao, presenca, novos }: {
  trechos: Array<{ texto: string; escrevendo: FrenteAoVivo | null }>; modelo: ModeloDoc; identidade: Identidade; titulo: string; semLogo: boolean;
  impressao: boolean; presenca: Map<number, FrenteAoVivo>; novos: Set<number>;
}) {
  const t = useT();
  const escuro = useEscuro();
  const blocos = useMemo(() => trechos.map((x) => parseMarkdown(x.texto)), [trechos]);
  // a numeração dos títulos corre o documento inteiro
  const numeros = useMemo(() => {
    const niveis = blocos.flat().filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h').map((b) => b.level);
    return modelo.numerarTitulos ? numeracao(niveis) : [];
  }, [blocos, modelo.numerarTitulos]);
  const capa = modelo.capa.ligada;
  let hi = 0;
  let refs = false;
  const logoUrl = identidade.logo ? `/api/entregaveis/identidade/logo?v=${identidade.logo.versao}` : null;
  const marca = !semLogo && modelo.cabecalho.logo && (logoUrl ? <img className="doc__logo" src={logoUrl} alt={identidade.nome} /> : identidade.mostrarErgon ? <ErgonMarca size={22} onDark={false} /> : null);
  const cab = modelo.cabecalho.mostrar && (
    <div className="doc__cab">{marca}<span>{preencher(modelo.cabecalho.texto, { titulo, empresa: identidade.nome, data: fmtData(new Date().toISOString()) })}</span></div>
  );
  const vars = { ...estiloDoPapel(modelo, identidade) } as CSSProperties;
  let pularH1 = capa;
  const texto = (
    <div className="doc__texto">
      {trechos.map((x, i) => {
        const quem = presenca.get(i) ?? null;
        const primeiro = quem && quem.blocos.find((b) => trechos[b]?.texto.trim() || b === quem.blocos[0]) === i;
        const els = blocos[i].map((b, k) => {
          if (b.t === 'h') {
            if (pularH1 && b.level === 1) { pularH1 = false; hi++; return null; }
            const txt = b.c.map((c) => (c.t === 'text' ? c.v : '')).join('');
            refs = REFERENCIAS.test(txt.trim());
            const n = refs ? '' : numeros[hi] ?? '';
            hi++;
            const H = `h${Math.min(6, b.level)}` as 'h1';
            return <H key={k} className={refs ? 'doc__refs-titulo' : undefined}>{n && <span className="doc__num">{n}</span>}{inl(b.c, `${i}.${k}`)}</H>;
          }
          return <Fragment key={k}>{bloco(b, `${i}.${k}`, refs)}</Fragment>;
        });
        if (!x.texto.trim() && !quem) return null;
        return (
          <div key={i} data-trecho={i}
            className={`doc__trecho ${quem ? 'doc__trecho--ocupado' : ''} ${x.escrevendo ? 'doc__trecho--escrevendo' : ''} ${novos.has(i) ? 'doc__trecho--novo' : ''}`}
            style={quem ? varsDaCor(escuro ? quem.corEscuro ?? quem.cor : quem.cor) : undefined} title={quem ? quem.agente.name : undefined}>
            {quem && primeiro && (
              <>
                <span className="doc__quem" title={quem.agente.name} aria-label={quem.agente.name}><AgentAvatar agent={quem.agente} size={28} anel={false} /></span>
                <span className="doc__acao" aria-live="polite">{t(`documentos.doc.acao.${quem.acao}`)}</span>
              </>
            )}
            {els}
          </div>
        );
      })}
      </div>
  );
  return (
    <article className={`doc__papel ${modelo.citacaoAbnt ? 'doc__papel--abnt' : ''} ${impressao ? 'doc__papel--impressao' : ''}`} style={vars}>
      {capa && (
        <section className="doc__capa">
          {!semLogo && (logoUrl ? <img className="doc__capa-logo" src={logoUrl} alt="" /> : identidade.mostrarErgon && !modelo.citacaoAbnt ? <ErgonMarca size={52} onDark={false} /> : null)}
          <p className="doc__capa-inst">{modelo.capa.instituicao || identidade.nome}</p>
          {modelo.capa.autor && <p className="doc__capa-autor">{modelo.capa.autor}</p>}
          <h1 className="doc__capa-titulo">{titulo}</h1>
          {modelo.capa.subtitulo && <p className="doc__capa-sub">{modelo.capa.subtitulo}</p>}
          <p className="doc__capa-fim">{[modelo.capa.local, modelo.capa.ano || String(new Date().getFullYear())].filter(Boolean).join('\n')}</p>
        </section>
      )}
      {!impressao && cab}
      {impressao && cab ? (
        // impressão: o cabeçalho no <thead> de uma tabela, que o navegador repete no alto de cada página
        <table className="doc__folhas"><thead><tr><td>{cab}</td></tr></thead><tbody><tr><td>{texto}</td></tr></tbody></table>
      ) : texto}
      {!impressao && modelo.rodape.mostrar && <footer className="doc__rod">{preencher(modelo.rodape.texto, { titulo, empresa: identidade.nome, data: fmtData(new Date().toISOString()) })}</footer>}
    </article>
  );
}

function bloco(b: Block, k: string, refs: boolean): ReactNode {
  switch (b.t) {
    case 'p': return <p className={refs ? 'doc__ref' : undefined}>{inl(b.c, k)}</p>;
    case 'h': return null;
    case 'ul': return <ul>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}{b.subs?.[i]?.map((y, j) => <Fragment key={j}>{bloco(y, `${k}.${i}.${j}`, refs)}</Fragment>)}</li>)}</ul>;
    case 'ol': return <ol start={b.start}>{b.items.map((x, i) => <li key={i}>{inl(x, `${k}.${i}`)}{b.subs?.[i]?.map((y, j) => <Fragment key={j}>{bloco(y, `${k}.${i}.${j}`, refs)}</Fragment>)}</li>)}</ol>;
    case 'code': {
      const v = blocoVisual(b.lang);
      if (v) return <div className="doc__visual"><v.Componente tipo={v.tipo} conteudo={b.v} /></div>;
      return <pre className="doc__codigo"><code>{b.v}</code></pre>;
    }
    case 'quote': return <blockquote>{b.c.map((x, i) => <Fragment key={i}>{bloco(x, `${k}.${i}`, refs)}</Fragment>)}</blockquote>;
    case 'hr': return <hr />;
    case 'table': return (
      <div className="doc__tabela">
        <table>
          <thead><tr>{b.head.map((c, i) => <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>{inl(c, `${k}h${i}`)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, i) => <td key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>{inl(c, `${k}r${j}.${i}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

/** As versões: desfazer a última edição ou voltar a qualquer uma (vira a mais nova; nada se perde). */
function Versoes({ artId, onClose, onErro }: { artId: string; onClose: () => void; onErro: (e: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  const v = useResource<{ atual: number; versoes: Array<{ n: number; tamanho: number; autor: string; nota: string; em: string }> }>(`/api/artifacts/${artId}/versoes`, ['artifacts.changed']);
  const fazer = async (url: string) => { try { await api.post(url); v.reload(); } catch (e) { onErro(errMsg(e)); } };
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} className="doc__versoes" role="dialog" aria-label={t('documentos.doc.versoes')} tabIndex={-1}>
      <div className="row doc__versoes-topo">
        <b>{t('documentos.doc.versoes')}</b>
        <button type="button" className="btn btn--sm" disabled={(v.data?.atual ?? 1) <= 1} onClick={() => void fazer(`/api/artifacts/${artId}/desfazer`)}><Icon name="undo" size={13} /> {t('documentos.doc.desfazer')}</button>
      </div>
      <ol className="doc__versoes-lista">
        {(v.data?.versoes ?? []).map((x) => (
          <li key={x.n} className={x.n === v.data?.atual ? 'is-atual' : ''}>
            <span className="doc__vn">{t('documentos.doc.versao', { n: x.n })}</span>
            <span className="doc__vnota">{x.nota === 'original' ? t('documentos.doc.versaoOriginal') : x.nota}<small>{fmtDataHora(x.em)}</small></span>
            {x.n === v.data?.atual ? <em>{t('documentos.doc.versaoAtual')}</em>
              : <button type="button" className="btn btn--sm btn--ghost" onClick={() => void fazer(`/api/artifacts/${artId}/versoes/${x.n}/restaurar`)}>{t('documentos.doc.voltarA')}</button>}
          </li>
        ))}
      </ol>
    </div>
  );
}

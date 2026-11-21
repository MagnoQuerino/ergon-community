// Um bloco visual na conversa (rc.42): o título, o visual, o resumo ao lado (nos mini visuais), a nota e as fontes no
// rodapé, com o menu do bloco (Baixar PNG, Ver dados, Copiar como texto). O formato e a validação ficam em
// shared/visuais; aqui só se desenha. A cerca ainda chegando (resposta ao vivo) mostra o esqueleto; a que não passa na
// validação aparece como os dados em texto.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TODOS_OS_TIPOS, langDoTipo, type Bloco, type BlocoDe, type Fonte } from '../../../shared/visuais/esquema.ts';
import { cenaDe, GRAFICOS, repeteNoLado, type Cena } from '../../../shared/visuais/cena.ts';
import { visualComoTexto } from '../../../shared/visuais/texto.ts';
import { apurar, blocosDaCerca } from '../../../shared/visuais/cercas.ts';
import { idiomaAtual, useT } from '../i18n/index.ts';
import { openConversation } from '../lib/open.ts';
import { Icon } from '../components/Icon.tsx';
import { CenaSvg, useLargura } from './Cena.tsx';
import { useVisuais } from './contexto.ts';
import { baixarPng } from './png.ts';
import { CorpoHtml } from './blocos.tsx';

const ICONE_FONTE: Record<Fonte['tipo'], string> = { conexao: 'plug', documento: 'file', site: 'globe', calculo: 'chart', conversa: 'chat' };

/** O destino de uma fonte ou referência: o link (fora), o arquivo, o card, a conversa. */
export function destinoDe(x: { url?: string | null; id?: string | null }): { href?: string; abrir?: () => void } {
  if (x.url && /^https?:\/\//i.test(x.url)) return { href: x.url };
  if (!x.id) return {};
  if (x.id.startsWith('art_')) return { href: `/api/artifacts/${encodeURIComponent(x.id)}/download` };
  if (x.id.startsWith('tsk_')) return { href: `#equipe?card=${encodeURIComponent(x.id)}` };
  if (x.id.startsWith('cnv_')) { const id = x.id; return { abrir: () => openConversation(null, id) }; }
  return {};
}

function ChipFonte({ f }: { f: Fonte }) {
  const t = useT();
  const d = destinoDe(f);
  const corpo = <><Icon name={ICONE_FONTE[f.tipo]} size={12} /><span className="vis-fonte__t">{f.titulo}</span>{f.periodo && <span className="vis-fonte__p">{f.periodo}</span>}</>;
  const rotulo = t('visuais.fonte.chip', { tipo: t(`visuais.fonte.tipo.${f.tipo}`), titulo: f.titulo });
  if (d.abrir) return <button type="button" className="vis-fonte" onClick={d.abrir} aria-label={rotulo} title={rotulo}>{corpo}</button>;
  if (d.href) return <a className="vis-fonte" href={d.href} aria-label={rotulo} title={rotulo} {...(d.href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{corpo}{!d.href.startsWith('#') && <Icon name="chevron-right" size={10} />}</a>;
  return <span className="vis-fonte" title={rotulo}>{corpo}</span>;
}

/** O rodapé de fontes: duas à vista e "+N" para as outras; "Estimativa" quando o agente declarou. */
export function Fontes({ fontes, estimativa }: { fontes?: Fonte[]; estimativa?: boolean }) {
  const t = useT();
  const [todas, setTodas] = useState(false);
  const fs = fontes ?? [];
  if (!fs.length && !estimativa) return null;
  const vistas = todas ? fs : fs.slice(0, 2);
  return (
    <footer className="vis__fontes" aria-label={fs.length > 1 ? t('visuais.fonte.titulos') : t('visuais.fonte.titulo')}>
      {estimativa && <span className="vis-estimativa" title={t('visuais.fonte.estimativaDica')}><Icon name="alert" size={12} /> {t('visuais.fonte.estimativa')}</span>}
      {vistas.map((f, i) => <ChipFonte key={i} f={f} />)}
      {fs.length > 2 && !todas && <button type="button" className="vis-fonte vis-fonte--mais" onClick={() => setTodas(true)} aria-label={t('visuais.fonte.maisDica', { n: fs.length - 2 })}>+{fs.length - 2}</button>}
    </footer>
  );
}

/** A tabela de dados por trás do gráfico (o leitor de tela e "Ver dados"). */
function TabelaDados({ cena, visivel, titulo }: { cena: Cena; visivel: boolean; titulo: string }) {
  if (!cena.dados) return null;
  return (
    <div className={visivel ? 'vis-dados md__table' : 'sr-only'}>
      <table>
        <caption className="sr-only">{titulo}</caption>
        <thead><tr>{cena.dados.cab.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{cena.dados.linhas.map((l, i) => <tr key={i}>{l.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Um gráfico (cena), na largura do lugar. */
function Grafico({ b, compacto, verDados }: { b: Bloco; compacto: boolean; verDados: boolean }) {
  const t = useT();
  const [ref, w] = useLargura<HTMLDivElement>();
  const bloco = useMemo<Bloco>(() => (b.tipo === 'matriz' ? { ...b, eixos: b.eixos ?? [t('visuais.matriz.esforco'), t('visuais.matriz.impacto')],
    quadrantes: b.quadrantes ?? [t('visuais.matriz.q1'), t('visuais.matriz.q2'), t('visuais.matriz.q3'), t('visuais.matriz.q4')] } : b), [b, t]);
  // o resumo ao lado já mostra o número grande: o valor do meio não se repete
  const cena = useMemo(() => cenaDe(bloco, { largura: Math.max(200, w), locale: idiomaAtual(), compacto, semValor: repeteNoLado(bloco, idiomaAtual()) }), [bloco, w, compacto]);
  return (
    <div ref={ref} className="vis-grafico">
      {cena && <CenaSvg cena={cena} />}
      {cena && <TabelaDados cena={cena} visivel={verDados} titulo={b.titulo ?? t('visuais.dados.titulo')} />}
    </div>
  );
}

/** O resumo ao lado do mini visual: número grande e até 3 linhas. */
function Lado({ b }: { b: Bloco }) {
  if (!b.lado) return null;
  return (
    <aside className="vis-lado">
      {b.lado.numero && <p className="vis-lado__n">{b.lado.numero}{b.lado.rotulo && <span>{b.lado.rotulo}</span>}</p>}
      {!!b.lado.linhas?.length && <ul>{b.lado.linhas.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </aside>
  );
}

function MenuDoBloco({ b, temDados, verDados, setVerDados }: { b: Bloco; temDados: boolean; verDados: boolean; setVerDados: (v: boolean) => void }) {
  const t = useT();
  const ctx = useVisuais();
  const [aberto, setAberto] = useState(false);
  const [estado, setEstado] = useState<'gerando' | 'na-area' | 'falha' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setAberto(false); } };
    document.addEventListener('pointerdown', fora); document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', fora); document.removeEventListener('keydown', esc, true); };
  }, [aberto]);
  const votos = b.tipo === 'enquete' ? apurar([...(b.votos ?? []).map((v) => ({ enquete: b.id, opcao: v.opcao, quem: v.quem })), ...ctx.votos], b.id, b.opcoes.length).porOpcao.map((x) => x.map(() => 1)) : undefined;
  const png = async () => {
    setAberto(false); setEstado('gerando');
    try { await baixarPng(b, ctx.marca, votos); setEstado(null); } catch { setEstado('falha'); }
  };
  const copiar = async () => {
    setAberto(false);
    try { await navigator.clipboard.writeText(visualComoTexto(b, { locale: idiomaAtual() }).replace(/\*\*|(^|\s)_|_($|\s)/g, '$1$2')); setEstado('na-area'); window.setTimeout(() => setEstado(null), 1500); } catch { setEstado('falha'); }
  };
  return (
    <div className="vis__menu" ref={ref}>
      <button type="button" className="icon-btn vis__baixar" onClick={() => void png()} title={t('visuais.menu.baixarPng')} aria-label={t('visuais.menu.baixarPng')} aria-busy={estado === 'gerando'}><Icon name="download" size={15} /></button>
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={aberto} onClick={() => setAberto((x) => !x)} title={t('visuais.menu.acoes')} aria-label={t('visuais.menu.acoes')}><Icon name="dots" size={15} /></button>
      {aberto && (
        <div className="vis__menulist" role="menu">
          <button type="button" role="menuitem" onClick={() => void png()}><Icon name="image" size={14} /> {t('visuais.menu.baixarPng')}</button>
          {temDados && <button type="button" role="menuitem" onClick={() => { setVerDados(!verDados); setAberto(false); }}><Icon name="grid" size={14} /> {verDados ? t('visuais.menu.esconderDados') : t('visuais.menu.verDados')}</button>}
          <button type="button" role="menuitem" onClick={() => void copiar()}><Icon name="copy" size={14} /> {t('visuais.menu.copiar')}</button>
        </div>
      )}
      {estado && estado !== 'gerando' && <span className="vis__estado" role="status">{estado === 'na-area' ? t('visuais.menu.copiado') : t('visuais.menu.naoGerou')}</span>}
    </div>
  );
}

/** O bloco inteiro, já validado. `grande`: no relatório aberto (mais espaço, sem o resumo ao lado). */
export function BlocoVisual({ b, grande = false, sub = false }: { b: Bloco; grande?: boolean; sub?: boolean }) {
  const t = useT();
  const [verDados, setVerDados] = useState(false);
  const grafico = GRAFICOS.has(b.tipo);
  const compacto = !grande && !!b.lado;
  const corpo: ReactNode = grafico ? <Grafico b={b} compacto={compacto && (b.tipo === 'pizza' || b.tipo === 'medidor')} verDados={verDados} /> : <CorpoHtml b={b} grande={grande} />;
  const titulo = b.titulo ?? (b.tipo === 'relatorio' ? t('visuais.relatorio.semTitulo') : b.tipo === 'fontes' ? t('visuais.fonte.titulos') : null);
  const semCab = b.tipo === 'nota' || b.tipo === 'decisao' || b.tipo === 'aviso';
  return (
    <figure className={`vis vis--${b.tipo.replace(/_/g, '-')}${compacto ? ' vis--mini' : ''}${grande ? ' vis--grande' : ''}${sub ? ' vis--sub' : ''}`} aria-label={titulo ?? undefined}>
      {!sub && <MenuDoBloco b={b} temDados={grafico} verDados={verDados} setVerDados={setVerDados} />}
      {titulo && !semCab && <header className="vis__cab"><h4 className="vis__titulo">{titulo}</h4>{b.subtitulo && <p className="vis__sub">{b.subtitulo}</p>}</header>}
      {semCab && b.titulo && b.tipo !== 'nota' && <h4 className="vis__titulo">{b.titulo}</h4>}
      <div className={`vis__corpo${compacto ? ' vis__corpo--lado' : ''}`}>
        {corpo}
        {compacto && <Lado b={b} />}
      </div>
      {!compacto && b.lado && <Lado b={b} />}
      {b.nota && <p className="vis__nota">{b.nota}</p>}
      {!sub && <Fontes fontes={b.tipo === 'fontes' ? b.itens : b.fontes} estimativa={b.estimativa} />}
    </figure>
  );
}

/** A cerca ```ergon-<tipo> do texto: valida e desenha; aberta (chegando ao vivo), o esqueleto. */
export function VisualDaCerca({ lang, json, fechada = true }: { lang: string; json: string; fechada?: boolean }) {
  const t = useT();
  const blocos = useMemo(() => {
    const rs = blocosDaCerca(lang, json);
    return 'erro' in rs ? [] : rs.flatMap((r) => (r.ok ? [r.bloco] : []));
  }, [lang, json]);
  if (!blocos.length) {
    if (!fechada) return <div className="vis vis--montando" role="status" aria-label={t('visuais.montando')}><span /><span /><span /></div>;
    return <pre className="md__code" title={t('visuais.invalido')}><code>{json}</code></pre>;
  }
  return <>{blocos.map((b, i) => <BlocoVisual key={i} b={b} />)}</>;
}

/** Para o documento dos Entregáveis (lib/documento.ts, registrarBlocoVisual): o desenho de cada tipo, ```ergon-<tipo>. */
export const BlocoDoDocumento = ({ tipo, conteudo, aoVivo = false }: { tipo: string; conteudo: string; aoVivo?: boolean }) => <VisualDaCerca lang={`ergon-${tipo}`} json={conteudo} fechada={!aoVivo} />;
export const TIPOS_DO_DOCUMENTO = TODOS_OS_TIPOS.map((t) => langDoTipo(t).slice('ergon-'.length));

export type { BlocoDe };

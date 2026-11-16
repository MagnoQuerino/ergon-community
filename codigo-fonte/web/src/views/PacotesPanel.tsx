import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { Loading } from '../brand/Brand.tsx';
import { paintFx, paintPet, type FxSpec, type PetSpec } from '../iso/cosmetics.ts';
import { figureSprite, lookFor } from '../iso/figures.ts';
import { RES } from '../iso/projection.ts';
import { THEMES, type Theme } from '../iso/theme.ts';
import { drawCityThumb, defaultLooks } from '../iso/cityThumb.ts';
import { agentSkinLook, comEtiquetasLegiveis, skinTheme } from '../iso/skin.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import type { SkinData } from '../../../shared/skin.ts';
import { useSurface } from '../lib/surface.ts';
import { cardClick } from '../lib/cardClick.ts';
import { Icon } from '../components/Icon.tsx';
import { t, useT, type Chave } from '../i18n/index.ts';

interface Installed { id: string; packageId: string; version: string; kind: string; title: string; verified: boolean; active: boolean; installedAt: string }
interface Preview { packageId: string; version: string; kind: string; title: string; summary: string; verified: boolean; installable: boolean; reason: string | null; changes: string[]; legibilidade?: number }

const KIND: Record<string, Extract<Chave, `documentos.pacotes.tipo.${string}`>> = {
  skin: 'documentos.pacotes.tipo.skin', 'city-theme': 'documentos.pacotes.tipo.cityTheme', fx: 'documentos.pacotes.tipo.fx', pet: 'documentos.pacotes.tipo.pet',
  'character-look': 'documentos.pacotes.tipo.characterLook', 'team-blueprint': 'documentos.pacotes.tipo.teamBlueprint', skill: 'documentos.pacotes.tipo.skill', plugin: 'documentos.pacotes.tipo.plugin',
};
/** O nome do tipo no idioma da tela (um tipo novo, que esta versão não conhece, aparece como veio). */
export const tipoDe = (kind: string): string => (KIND[kind] ? t(KIND[kind]) : kind);

/**
 * A Loja (menu da esquerda) e os pacotes: instalar um .ergon (tema, efeitos, pets, aparências, equipe) com prévia e desfazer.
 * Pacote é só dado: não executa nada, não dá ferramenta nem acesso. Sem assinatura da loja aparece "não verificado".
 */
export type PreviewAgent = { name: string; color: string; role?: string; char_key?: string | null; look_seed?: number | null };
const PW = 44; const PH = 34; // prévia em unidades da pixel art (× RES no canvas), mostrada 4× para ver o detalhe

/** Prévia ao vivo: um agente de verdade com o efeito ou o pet, desenhados pelo mesmo código da cidade, a qualquer hora. */
function Preview({ agent, fx, pet }: { agent: PreviewAgent | null; fx: FxSpec | null; pet: PetSpec | null }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; const g = c?.getContext('2d'); if (!c || !g) return;
    const th = THEMES.dia; const moving = fx?.effect === 'fire_trail';
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const look = lookFor({ name: agent?.name ?? 'Ergon', color: agent?.color ?? '#3a6ea5', role: agent?.role, key: agent?.char_key ?? null, seed: agent?.look_seed ?? null }, th);
    const sprites = [0, 1].map((f) => figureSprite(look, 'front', moving ? 'walk' : 'stand', f, false, th, 'smile'));
    const x = Math.round(c.width / 2); const y = c.height - 7 * RES;
    let raf = 0;
    const draw = (now: number) => {
      const t = reduce ? 0 : now; const s = sprites[moving && !reduce ? Math.floor(now / 160) % 2 : 0];
      g.fillStyle = th.bg; g.fillRect(0, 0, c.width, c.height);
      if (fx) paintFx(g, [fx], x, y, t, moving, false);
      g.drawImage(s.canvas, x - s.ax, y - s.ay);
      if (pet) paintPet(g, pet, x, y, reduce ? 0 : (Math.floor(now / 400) % 2) * RES);
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [agent?.name, agent?.color, agent?.role, agent?.char_key, agent?.look_seed, fx?.effect, fx?.color, fx?.intensity, pet?.species, pet?.color]);
  return <canvas ref={ref} width={PW * RES} height={PH * RES} role="img" aria-label={t('documentos.pacotes.previa.em', { nome: agent?.name ?? t('documentos.pacotes.previa.umAgente') })} style={{ width: PW * 4, height: PH * 4, imageRendering: 'pixelated', borderRadius: 8 }} />;
}

export interface CatalogPreview {
  swatches: string[]; names: string[]; tagline?: string;
  fx?: { effect: string; color: string; intensity: number }; pet?: { species: string; color: string };
  images: number; tags: string[];
  skin?: SkinData; theme?: { base: 'dia' | 'noite'; colors: Record<string, string> };
  agents?: Array<{ name: string; role: string; color: string; charKey: string | null; coordinator: boolean }>; sectors?: string[];
  /** cores do pacote ajustadas para se lerem (o servidor corrige; aqui só o aviso) */
  legibilidade?: number;
}
export interface CatalogItem { id: string; version: string; title: string; summary: string; kind: string; verified: boolean; installed: boolean; author?: string; preview?: CatalogPreview }

const INSTALAVEIS = ['city-theme', 'fx', 'pet', 'character-look', 'team-blueprint', 'skin'];
const CATEGORIAS: Array<{ k: string; l: Extract<Chave, `documentos.pacotes.cat.${string}`> }> = [
  { k: 'todos', l: 'documentos.pacotes.cat.todos' }, { k: 'skin', l: 'documentos.pacotes.cat.skins' }, { k: 'city-theme', l: 'documentos.pacotes.cat.temas' },
  { k: 'fx', l: 'documentos.pacotes.cat.efeitos' }, { k: 'pet', l: 'documentos.pacotes.cat.pets' }, { k: 'team-blueprint', l: 'documentos.pacotes.cat.equipes' },
  { k: 'skill', l: 'documentos.pacotes.cat.competencias' }, { k: 'outros', l: 'documentos.pacotes.cat.outros' },
];
const PRINCIPAIS = new Set(['skin', 'city-theme', 'fx', 'pet', 'team-blueprint', 'skill']);
const POR_PAGINA = 9;

/** "Foto" da cidade com a skin ou o tema do pacote: os mesmos prédios, chão e moradores da cidade. */
function CidadePrevia({ theme, looks, label }: { theme: Theme; looks: ReturnType<typeof defaultLooks>; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const c = ref.current; const b = box.current; if (!c || !b) return;
    const paint = () => { const w = Math.max(160, b.clientWidth); const h = Math.max(110, b.clientHeight); c.style.width = `${w}px`; c.style.height = `${h}px`; drawCityThumb(c, theme, looks, w, h); };
    paint();
    const ro = new ResizeObserver(paint); ro.observe(b);
    return () => ro.disconnect();
  }, [theme, looks]);
  return <span ref={box} className="loja-previa__cidade"><canvas ref={ref} role="img" aria-label={label} /></span>;
}

/** Tema do pacote (cores sobre o dia ou a noite), como a cidade aplica. */
function temaDoPacote(t: { base: 'dia' | 'noite'; colors: Record<string, string> }): Theme {
  const base = THEMES[t.base] ?? THEMES.dia;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(t.colors)) if (typeof out[k] === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
  return comEtiquetasLegiveis(out as unknown as Theme, t.base === 'noite' ? 'noite' : 'dia');
}

/** Equipe do pacote: os setores (o que muda de uma área para outra) e quem vem nela. */
function EquipePrevia({ p }: { p: CatalogPreview }) {
  const t = useT();
  const ag = p.agents ?? [];
  const setores = p.sectors ?? [];
  return (
    <span className="loja-previa__equipe">
      <span className="loja-previa__setores">
        {setores.slice(0, 4).map((x) => <span key={x} className="loja-previa__setor">{x}</span>)}
        {setores.length > 4 && <span className="loja-previa__setor">+{setores.length - 4}</span>}
      </span>
      <span className="loja-previa__rostos">
        {ag.slice(0, 6).map((a, i) => <AgentAvatar key={i} agent={{ name: a.name, color: a.color, role: a.role, char_key: a.charKey, look_seed: null }} size={24} />)}
        <span className="loja-previa__conta">{t('documentos.pacotes.previa.agentes', { n: ag.length })}</span>
      </span>
    </span>
  );
}

/** Prévia de um pacote: a imagem dele; senão, a cidade com a skin/tema, a equipe, ou o efeito/pet num agente. */
export function PreviaPacote({ item, agent }: { item: CatalogItem; agent: PreviewAgent | null }) {
  const t = useT();
  const p = item.preview;
  const cena = useMemo(() => {
    if (p?.skin) {
      const th = skinTheme(THEMES.dia, p.skin, 'dia');
      const chars = new Map(p.skin.characters.map((_, i) => [`c${i}`, i]));
      const looks = p.skin.characters.slice(0, 3).map((c, i) => agentSkinLook({ id: `c${i}`, name: c.name, color: '#3a6ea5' }, { data: p.skin!, characters: chars }, th));
      return { th, looks: looks.length ? looks : defaultLooks(th) };
    }
    if (p?.theme) { const th = temaDoPacote(p.theme); return { th, looks: defaultLooks(th) }; }
    return null;
  }, [p]);
  if (p?.images) return <img className="loja-previa__img" src={`/api/packages/catalog/official/${encodeURIComponent(item.id)}/preview/0`} alt="" loading="lazy" />;
  if (cena) return <CidadePrevia theme={cena.th} looks={cena.looks} label={t('documentos.pacotes.previa.cidade', { titulo: item.title })} />;
  if (p?.agents?.length) return <EquipePrevia p={p} />;
  if (p?.fx || p?.pet) {
    return (
      <span className="loja-previa__vivo">
        <Preview agent={agent} fx={p.fx ? { effect: p.fx.effect, color: p.fx.color, intensity: p.fx.intensity } as FxSpec : null} pet={p.pet ? { species: p.pet.species, color: p.pet.color } as PetSpec : null} />
      </span>
    );
  }
  return <span className="loja-previa__cores"><span className="loja-previa__tipo">{tipoDe(item.kind)}</span></span>;
}

/** O que cada categoria é, em uma frase (as Equipes, principalmente, não são óbvias). */
const SOBRE: Record<string, Extract<Chave, `documentos.pacotes.sobre.${string}`>> = {
  skin: 'documentos.pacotes.sobre.skin', 'city-theme': 'documentos.pacotes.sobre.cityTheme', fx: 'documentos.pacotes.sobre.fx', pet: 'documentos.pacotes.sobre.pet',
  'team-blueprint': 'documentos.pacotes.sobre.teamBlueprint',
};

/** De onde vem cada item: oficial do Ergon (embutido), modelo da comunidade que vem com o Ergon, o catálogo público
 *  do repositório (lido quando a pessoa pede) ou a Loja do Ergon World (colaborativa e grátis). */
type Fonte = 'oficial' | 'embutido' | 'publico' | 'mundo';
export interface ItemVitrine extends CatalogItem { fonte: Fonte; oficial: boolean; itemId?: string }
interface ItemMundo { id: string; packageId: string; kind: string; title: string; summary: string; version: string; creator: string; official: boolean; verified: boolean }

/** O selo de quem fez (Oficial ou Comunidade) e o de confiança (verificado ou não). */
export function Selos({ x }: { x: Pick<ItemVitrine, 'oficial' | 'verified' | 'kind'> }) {
  const t = useT();
  return (
    <span className="loja-card__selos">
      {x.oficial ? <span className="badge badge--oficial">{t('documentos.loja.selo.oficial')}</span> : <span className="badge badge--comunidade">{t('documentos.loja.selo.comunidade')}</span>}
      {x.verified ? <span className="badge">{t('documentos.pacotes.loja.verificado')}</span>
        : <span className="badge badge--warn" title={t('documentos.pacotes.loja.semAssinatura')}>{x.kind === 'skill' ? t('documentos.loja.naoVerificada') : t('documentos.pacotes.loja.naoVerificado')}</span>}
    </span>
  );
}

/**
 * A vitrine da Loja, colaborativa e grátis (sem preço, sem compra): os oficiais vêm com o Ergon (assinados, sem
 * internet), os modelos da comunidade que já vêm junto, a Loja do Ergon World (lida ao abrir, sem conta) e o catálogo
 * público do repositório (só quando a pessoa pede). Busca, categorias, paginação e um detalhe por item; instalar é o
 * mesmo caminho de qualquer pacote (desfazer em Instalados). Competência de terceiros: o texto inteiro antes.
 */
export function Vitrine({ busy, agent, instalados, onInstall, onMudou }: {
  busy: boolean; agent: PreviewAgent | null; instalados: Set<string>;
  onInstall: (url: string, body: object, item: CatalogItem) => Promise<boolean>;
  onMudou: () => void;
}) {
  const t = useT();
  const of = useResource<CatalogItem[]>('/api/packages/catalog/official', []);
  const emb = useResource<CatalogItem[]>('/api/packages/catalog/bundled', []);
  const mundo = useResource<{ disponivel: boolean; erro?: string; itens: ItemMundo[] }>('/api/loja/itens', []);
  const [origem, setOrigem] = useState<'todos' | 'oficiais' | 'comunidade'>('todos');
  const [com, setCom] = useState<CatalogItem[] | null>(null);
  const [aviso, setAviso] = useState('');
  const [lendo, setLendo] = useState(false);
  const [cat, setCat] = useState('todos');
  const [busca, setBusca] = useState('');
  const [soNovos, setSoNovos] = useState(false);
  const [pagina, setPagina] = useState(0);
  const [aberto, setAberto] = useState<ItemVitrine | null>(null);
  useEffect(() => setPagina(0), [origem, cat, busca, soNovos]);
  const carregar = async (forcar: boolean) => {
    setAviso(''); setLendo(true);
    try { setCom(await api.get<CatalogItem[]>(`/api/packages/catalog/community${forcar ? '?atualizar=1' : ''}`)); }
    catch (e) { setAviso(errMsg(e)); } finally { setLendo(false); }
  };
  const todos = useMemo(() => {
    const vistos = new Set<string>(); const out: ItemVitrine[] = [];
    const por = (x: ItemVitrine) => { if (!vistos.has(x.id)) { vistos.add(x.id); out.push({ ...x, installed: x.installed || instalados.has(x.id) }); } };
    for (const x of of.data ?? []) por({ ...x, fonte: 'oficial', oficial: true });
    for (const x of mundo.data?.itens ?? []) por({ id: x.packageId, itemId: x.id, version: x.version, title: x.title, summary: x.summary, kind: x.kind, verified: x.verified, installed: false, author: x.official ? undefined : x.creator, fonte: 'mundo', oficial: x.official });
    for (const x of emb.data ?? []) por({ ...x, fonte: 'embutido', oficial: false });
    for (const x of com ?? []) por({ ...x, fonte: 'publico', oficial: false });
    return out;
  }, [of.data, mundo.data, emb.data, com, instalados]);
  const lista = todos.filter((x) => origem === 'todos' || (origem === 'oficiais') === x.oficial);
  const q = busca.trim().toLowerCase();
  const filtrada = lista.filter((x) => (cat === 'todos' || (cat === 'outros' ? !PRINCIPAIS.has(x.kind) : x.kind === cat))
    && (!soNovos || !x.installed)
    && (!q || `${x.title} ${x.summary} ${x.author ?? ''} ${(x.preview?.tags ?? []).join(' ')} ${(x.preview?.names ?? []).join(' ')}`.toLowerCase().includes(q)));
  const paginas = Math.max(1, Math.ceil(filtrada.length / POR_PAGINA));
  const vista = filtrada.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const contar = (k: string) => lista.filter((x) => (k === 'todos' || (k === 'outros' ? !PRINCIPAIS.has(x.kind) : x.kind === k))).length;
  const URL_DE: Record<Exclude<Fonte, 'mundo'>, string> = { oficial: '/api/packages/catalog/official/install', embutido: '/api/packages/catalog/bundled/install', publico: '/api/packages/catalog/community/install' };
  const instalar = async (item: ItemVitrine) => {
    if (item.fonte === 'mundo') { setAberto(item); return; }
    const ok = await onInstall(URL_DE[item.fonte], { id: item.id }, item);
    if (ok) {
      if (item.fonte === 'oficial') of.reload(); else if (item.fonte === 'embutido') emb.reload(); else setCom((c) => c?.map((x) => (x.id === item.id ? { ...x, installed: true } : x)) ?? null);
      setAberto((a) => (a && a.id === item.id ? { ...a, installed: true } : a));
    }
  };
  const botao = (x: ItemVitrine, grande = false) => (x.installed
    ? <span className="badge badge--ok">{t('documentos.pacotes.loja.instalado')}</span>
    : x.fonte === 'mundo'
      ? <button className={`btn ${grande ? 'btn--primary' : 'btn--sm'}`} disabled={busy} onClick={(e) => { e.stopPropagation(); setAberto(x); }}>{x.kind === 'skill' ? t('documentos.loja.lerEInstalar') : t('documentos.pacotes.loja.instalar')}</button>
      : <button className={`btn ${grande ? 'btn--primary' : 'btn--sm'}`} disabled={busy || !INSTALAVEIS.includes(x.kind)} onClick={(e) => { e.stopPropagation(); void instalar(x); }}>{t('documentos.pacotes.loja.instalar')}</button>);
  const carregando = !of.data || !emb.data;
  return (
    <section className="card loja">
      <div className="loja__topo">
        <div className="loja__origem" role="tablist" aria-label={t('documentos.pacotes.loja.origem')}>
          {(['todos', 'oficiais', 'comunidade'] as const).map((o) => (
            <button key={o} role="tab" aria-selected={origem === o} className={`chip chip--btn ${origem === o ? 'is-on' : ''}`} onClick={() => setOrigem(o)}>
              {o === 'todos' ? t('documentos.pacotes.cat.todos') : o === 'oficiais' ? t('documentos.loja.selo.oficiais') : t('documentos.pacotes.loja.comunidade')}
            </button>
          ))}
        </div>
        <input className="input loja__busca" type="search" placeholder={t('documentos.pacotes.loja.buscar')} value={busca} onChange={(e) => setBusca(e.target.value)} aria-label={t('documentos.pacotes.loja.buscarAria')} />
      </div>
      <div className="loja__cats" role="tablist" aria-label={t('documentos.pacotes.loja.categorias')}>
        {CATEGORIAS.map((c) => {
          const n = contar(c.k);
          return (c.k === 'todos' || n > 0) && (
            <button key={c.k} role="tab" aria-selected={cat === c.k} className={`chip chip--btn ${cat === c.k ? 'is-on' : ''}`} onClick={() => setCat(c.k)}>{t(c.l)} <span className="muted">{n}</span></button>
          );
        })}
        <label className="loja__novos small"><input type="checkbox" checked={soNovos} onChange={(e) => setSoNovos(e.target.checked)} /> {t('documentos.pacotes.loja.soNovos')}</label>
      </div>
      {SOBRE[cat] && <p className="hint loja__sobre">{t(SOBRE[cat])}</p>}
      {mundo.data && !mundo.data.disponivel && origem !== 'oficiais' && <p className="hint">{t('documentos.loja.mundoFora')}</p>}
      {aviso && <p className="muted" role="status">{aviso} <button className="link" disabled={lendo} onClick={() => void carregar(true)}>{t('documentos.pacotes.loja.tentarDeNovo')}</button></p>}
      {(carregando || lendo) && <Loading error={of.error} />}
      {!carregando && lista.length > 0 && !filtrada.length && <p className="muted">{t('documentos.pacotes.loja.nadaFiltros')}</p>}
      {vista.length > 0 && (
        <ul className="loja__grade">
          {vista.map((x) => (
            <li key={x.id}>
              {/* o card inteiro abre a prévia; o título é o botão do teclado (o Instalar continua um botão à parte) */}
              <article className="loja-card" onClick={cardClick(() => setAberto(x))}>
                <div className="loja-previa"><PreviaPacote item={x} agent={agent} /></div>
                <div className="loja-card__txt">
                  <b><button type="button" className="card-open" onClick={() => setAberto(x)} aria-label={t('documentos.pacotes.loja.verDetalhes', { titulo: x.title })}>{x.title}</button></b>
                  <span className="muted small">{tipoDe(x.kind)}{x.author ? ` · ${t('documentos.pacotes.loja.porAutor', { autor: x.author })}` : ''}</span>
                </div>
                <div className="loja-card__pe">
                  <Selos x={x} />
                  {botao(x)}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {paginas > 1 && (
        <nav className="loja__paginas" aria-label={t('documentos.pacotes.loja.paginas')}>
          <button className="btn btn--sm btn--ghost" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>{t('documentos.pacotes.loja.anterior')}</button>
          {Array.from({ length: paginas }, (_, i) => (
            <button key={i} className={`chip chip--btn ${i === pagina ? 'is-on' : ''}`} aria-current={i === pagina ? 'page' : undefined} onClick={() => setPagina(i)}>{i + 1}</button>
          ))}
          <button className="btn btn--sm btn--ghost" disabled={pagina >= paginas - 1} onClick={() => setPagina((p) => p + 1)}>{t('documentos.pacotes.loja.proxima')}</button>
        </nav>
      )}
      {origem !== 'oficiais' && (
        <p className="small muted">{com ? t('documentos.loja.publicoLido', { n: com.length }) : t('documentos.pacotes.loja.comunidadeDica')}{' '}
          <button className="link" disabled={lendo} onClick={() => void carregar(!!com)}>{com ? t('documentos.pacotes.loja.atualizarLista') : t('documentos.loja.lerPublico')}</button></p>
      )}
      {aberto && (aberto.fonte === 'mundo'
        ? <DetalheMundo item={aberto} agent={agent} onClose={() => setAberto(null)} onInstalado={() => { mundo.reload(); onMudou(); setAberto((a) => (a ? { ...a, installed: true } : a)); }} />
        : <DetalhePacote item={aberto} agent={agent} acao={botao(aberto, true)} onClose={() => setAberto(null)} />)}
    </section>
  );
}

interface Aberto {
  id: string; packageId: string; kind: string; title: string; summary: string; version: string; verified: boolean;
  previa?: Preview; preview?: CatalogPreview; competencia?: { nome: string; titulo: string; descricao: string; texto: string };
}
/**
 * Um item da Loja do Ergon World: baixa (licença grátis) e mostra a prévia de verdade. Competência de terceiros: o
 * texto INTEIRO, "não verificada", e só instala depois de a pessoa marcar que leu; fica só neste computador.
 */
function DetalheMundo({ item, agent, onClose, onInstalado }: { item: ItemVitrine; agent: PreviewAgent | null; onClose: () => void; onInstalado: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [d, setD] = useState<Aberto | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [leu, setLeu] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  useEffect(() => {
    let vivo = true;
    api.post<Aberto>(`/api/loja/itens/${item.itemId}/abrir`).then((r) => { if (vivo) setD(r); }).catch((e) => { if (vivo) setErro(errMsg(e)); });
    return () => { vivo = false; };
  }, [item.itemId]);
  const instalar = async () => {
    if (!d) return;
    setIndo(true); setErro(null);
    try {
      if (d.competencia) await api.post('/api/recursos/competencias/instalar', { texto: d.competencia.texto, nomeArquivo: 'SKILL.md', destino: 'equipe', origemLoja: item.itemId });
      else await api.post(`/api/loja/itens/${item.itemId}/instalar`);
      setOk(d.competencia ? t('documentos.loja.competenciaInstalada', { titulo: d.title }) : t('documentos.pacotes.msg.aplicadoLoja', { titulo: d.title }));
      window.dispatchEvent(new Event('ergon:packages'));
      onInstalado();
    } catch (e) { setErro(errMsg(e)); } finally { setIndo(false); }
  };
  const comPrevia: CatalogItem = { ...item, preview: d?.preview ?? item.preview };
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card loja-detalhe" role="dialog" aria-modal="true" aria-labelledby="loja-det-titulo">
        {!d?.competencia && <div className="loja-detalhe__previa loja-previa"><PreviaPacote item={comPrevia} agent={agent} /></div>}
        <h3 id="loja-det-titulo">{item.title}</h3>
        <p className="muted small">{tipoDe(item.kind)} · {t('documentos.pacotes.detalhe.versao', { versao: item.version })}{item.author ? ` · ${t('documentos.pacotes.loja.porAutor', { autor: item.author })}` : ''}</p>
        <Selos x={item} />
        <p>{item.summary}</p>
        {!d && !erro && <Loading />}
        {erro && <p className="error" role="alert">{erro}</p>}
        {ok && <p className="ok" role="status">{ok}</p>}
        {d?.previa && <ul className="small">{d.previa.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
        {d?.competencia && (
          <>
            <p className="hint warn">{t('documentos.loja.competenciaAviso')}</p>
            <pre className="loja-skill__texto" tabIndex={0} aria-label={t('documentos.loja.textoInteiro')}>{d.competencia.texto}</pre>
            <label className="check"><input type="checkbox" checked={leu} onChange={(e) => setLeu(e.target.checked)} /> {t('documentos.loja.liTudo')}</label>
          </>
        )}
        <div className="cpop__acts">
          <button className="btn btn--ghost" onClick={onClose}>{t('documentos.fechar')}</button>
          {item.installed || ok ? <span className="badge badge--ok">{t('documentos.pacotes.loja.instalado')}</span>
            : <button className="btn btn--primary" disabled={!d || indo || (!!d.competencia && !leu) || (!d.competencia && !d.previa?.installable)} onClick={() => void instalar()}>{d?.competencia ? t('documentos.loja.instalarAqui') : t('documentos.pacotes.loja.instalar')}</button>}
        </div>
      </div>
    </div>
  );
}

/** Página de detalhe de um pacote: prévia grande, descrição, o que ele traz e instalar. */
function DetalhePacote({ item, agent, acao, onClose }: { item: CatalogItem; agent: PreviewAgent | null; acao: React.ReactNode; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const p = item.preview;
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card loja-detalhe" role="dialog" aria-modal="true" aria-labelledby="loja-det-titulo">
        <div className="loja-detalhe__previa loja-previa"><PreviaPacote item={item} agent={agent} /></div>
        <h3 id="loja-det-titulo">{item.title}</h3>
        <p className="muted small">{tipoDe(item.kind)} · {t('documentos.pacotes.detalhe.versao', { versao: item.version })}{item.author ? ` · ${t('documentos.pacotes.loja.porAutor', { autor: item.author })}` : ''} · {item.verified ? t('documentos.pacotes.loja.verificado') : t('documentos.pacotes.loja.naoVerificado')}</p>
        {p?.tagline && p.tagline !== item.summary && <p><i>{p.tagline}</i></p>}
        <p>{item.summary}</p>
        {SOBRE[item.kind] && <p className="hint">{t(SOBRE[item.kind])}</p>}
        {item.kind === 'team-blueprint' && p?.sectors?.length ? <p className="small"><b>{t('documentos.pacotes.detalhe.setores')}</b> {p.sectors.join(', ')}</p> : null}
        {p?.names.length ? <p className="small"><b>{item.kind === 'team-blueprint' ? t('documentos.pacotes.detalhe.naEquipe') : t('documentos.pacotes.detalhe.personagens')}</b> {p.names.join(', ')}</p> : null}
        {p?.swatches.length ? <div className="loja-detalhe__cores" aria-label={t('documentos.pacotes.detalhe.cores')}>{p.swatches.map((c) => <span key={c} style={{ background: c }} title={c} />)}</div> : null}
        {p?.tags.length ? <p className="small muted">{p.tags.map((x) => `#${x}`).join(' ')}</p> : null}
        {p?.legibilidade ? <p className="hint loja-legivel">{t('documentos.pacotes.legibilidade', { n: p.legibilidade })}</p> : null}
        {!INSTALAVEIS.includes(item.kind) && <p className="hint">{t('documentos.pacotes.detalhe.naoInstalavel')}</p>}
        <div className="cpop__acts">
          <button className="btn btn--ghost" onClick={onClose}>{t('documentos.fechar')}</button>
          {acao}
        </div>
      </div>
    </div>
  );
}

/** Criar o seu pacote: o guia técnico e o SKILL.md para criar com uma IA. */
export function GuiaCriar() {
  const t = useT();
  return (
    <section className="card">
      <h3>{t('documentos.pacotes.criar.titulo')}</h3>
      <p className="muted">{t('documentos.pacotes.criar.texto')}</p>
      <div className="row row--wrap">
        <a className="btn" href="/guias/criar-pacotes-ergon.md" download="criar-pacotes-ergon.md"><Icon name="download" size={14} /> {t('documentos.pacotes.criar.guia')}</a>
        <a className="btn" href="/guias/SKILL.md" download="SKILL.md"><Icon name="download" size={14} /> {t('documentos.pacotes.criar.skill')}</a>
      </div>
      <p className="hint">{t('documentos.pacotes.criar.dica')}</p>
    </section>
  );
}

/** Instalar um .ergon recebido de alguém: prévia do que muda e aplicar. */
export function InstalarArquivo({ busy, setBusy, onMsg, onMudou }: { busy: boolean; setBusy: (b: boolean) => void; onMsg: (m: { kind: 'ok' | 'error'; text: string } | null) => void; onMudou: () => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const send = (url: string, f: File) => api.post<Preview & { id: string }>(url, new Blob([f], { type: 'application/x-ergon' }));
  const choose = async (f: File | null) => {
    onMsg(null); setPreview(null); setFile(f);
    if (!f) return;
    setBusy(true);
    try { setPreview(await send('/api/packages/preview', f)); } catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const install = async () => {
    if (!file) return; setBusy(true);
    try { await send('/api/packages/install', file); onMsg({ kind: 'ok', text: t('documentos.pacotes.msg.aplicado') }); setPreview(null); setFile(null); onMudou(); window.dispatchEvent(new Event('ergon:packages')); }
    catch (e) { onMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h3>{t('documentos.pacotes.instalar.titulo')}</h3>
      <p className="muted">{t('documentos.pacotes.instalar.texto')}</p>
      <input ref={input} type="file" accept=".ergon" hidden onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>{t('documentos.pacotes.instalar.escolher')}</button>
      {preview && (
        <div className="card card--inner">
          <b>{preview.title}</b> <span className="muted small">{tipoDe(preview.kind)} · {preview.packageId} {preview.version}</span>
          {preview.verified ? <span className="badge">{t('documentos.pacotes.instalar.verificadoLoja')}</span> : <span className="badge badge--warn" title={t('documentos.pacotes.instalar.semAssinatura')}>{t('documentos.pacotes.loja.naoVerificado')}</span>}
          <p className="small">{preview.summary}</p>
          <ul className="small">{preview.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          {preview.legibilidade ? <p className="hint loja-legivel">{t('documentos.pacotes.legibilidade', { n: preview.legibilidade })}</p> : null}
          {preview.installable ? <button className="btn btn--primary" disabled={busy} onClick={() => void install()}>{t('documentos.pacotes.instalar.aplicar')}</button> : <p className="muted small">{preview.reason}</p>}
        </div>
      )}
    </section>
  );
}

export type { Installed as PacoteInstalado };
/** O que está aplicado neste workspace, cada um com desfazer. */
export function Instalados({ lista, busy, onUndo }: { lista: Installed[]; busy: boolean; onUndo: (p: Installed) => void }) {
  const t = useT();
  const ativos = lista.filter((p) => p.active);
  return (
    <section className="card">
      <h3>{t('documentos.pacotes.instalados.titulo')}</h3>
      {!ativos.length && <p className="muted">{t('documentos.pacotes.instalados.nenhum')}</p>}
      <ul className="sec-rows">
        {ativos.map((p) => (
          <li key={p.id}>
            <b>{p.title}</b><span className="muted small">{tipoDe(p.kind)} · {p.version} · {p.verified ? t('documentos.pacotes.loja.verificado') : t('documentos.pacotes.loja.naoVerificado')}</span>
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => onUndo(p)}>{t('documentos.desfazer')}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

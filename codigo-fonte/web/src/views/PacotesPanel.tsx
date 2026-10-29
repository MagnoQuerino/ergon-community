import { useEffect, useRef, useState } from 'react';
import { api, errMsg, postForBlob } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { Loading } from '../brand/Brand.tsx';
import { paintFx, paintPet, type FxSpec, type PetSpec } from '../iso/cosmetics.ts';
import { figureSprite, lookFor } from '../iso/figures.ts';
import { RES } from '../iso/projection.ts';
import { THEMES } from '../iso/theme.ts';
import { useSurface } from '../lib/surface.ts';

interface Installed { id: string; packageId: string; version: string; kind: string; title: string; verified: boolean; active: boolean; installedAt: string }
interface Preview { packageId: string; version: string; kind: string; title: string; summary: string; verified: boolean; installable: boolean; reason: string | null; changes: string[] }

const KIND: Record<string, string> = { skin: 'Skin da cidade', 'city-theme': 'Tema da cidade', fx: 'Efeito', pet: 'Pet', 'character-look': 'Aparência', 'team-blueprint': 'Equipe', skill: 'Skill', plugin: 'Plugin' };

/**
 * Configurações › Pacotes: instalar um .ergon (tema, efeitos, pets, aparências, equipe) com prévia e desfazer.
 * Pacote é só dado: não executa nada, não dá ferramenta nem acesso. Sem assinatura da loja aparece "não verificado".
 */
/** Editor simples: monta um efeito, um pet ou um tema da cidade; ver na cidade (aplica com desfazer) ou baixar o .ergon. */
type PreviewAgent = { name: string; color: string; role?: string; char_key?: string | null; look_seed?: number | null };
const PW = 44; const PH = 34; // prévia em unidades da pixel art (× RES no canvas), mostrada 4× para ver o detalhe

/** Prévia ao vivo: um agente de verdade com o efeito ou o pet, desenhados pelo mesmo código da cidade, a qualquer hora. */
function Preview({ agent, fx, pet }: { agent: PreviewAgent | null; fx: FxSpec | null; pet: PetSpec | null }) {
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
  return <canvas ref={ref} width={PW * RES} height={PH * RES} role="img" aria-label={`Prévia em ${agent?.name ?? 'um agente'}`} style={{ width: PW * 4, height: PH * 4, imageRendering: 'pixelated', borderRadius: 8 }} />;
}

function Editor({ agents, busy, onBuilt, onError }: { agents: PreviewAgent[]; busy: boolean; onBuilt: (b: Blob, title: string, how: 'ver' | 'baixar') => Promise<void>; onError: (t: string) => void }) {
  const [kind, setKind] = useState<'fx' | 'pet' | 'city-theme'>('fx');
  const [title, setTitle] = useState('Minha aura');
  const [target, setTarget] = useState('all');
  const [effect, setEffect] = useState('aura');
  const [color, setColor] = useState('#66ccff');
  const [intensity, setIntensity] = useState(0.7);
  const [species, setSpecies] = useState('gato');
  const [base, setBase] = useState<'dia' | 'noite'>('dia');
  const [bg, setBg] = useState('#d8c8a0');
  const [gold, setGold] = useState('#e0b040');
  const tgt = target === 'all' ? { all: true } : { agentName: target };
  const data = kind === 'fx' ? { effects: [{ target: tgt, effect, color, intensity }] } : kind === 'pet' ? { pets: [{ target: tgt, species, color }] } : { theme: { base, colors: { bg, gold } } };
  const go = async (how: 'ver' | 'baixar') => { try { await onBuilt(await postForBlob('/api/packages/build', { kind, title, data }), title, how); } catch (e) { onError(errMsg(e)); } };
  return (
    <section className="card">
      <h3>Criar</h3>
      <p className="muted">Monte um efeito, um pet ou as cores da cidade, veja aplicado e baixe o .ergon para guardar ou compartilhar.</p>
      <div className="row row--wrap">
        <label className="field">Tipo<select value={kind} onChange={(e) => setKind(e.target.value as 'fx')}><option value="fx">Efeito</option><option value="pet">Pet</option><option value="city-theme">Cores da cidade</option></select></label>
        <label className="field">Nome<input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} /></label>
        {kind !== 'city-theme' && <label className="field">Em quem<select value={target} onChange={(e) => setTarget(e.target.value)}><option value="all">Todos</option>{agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}</select></label>}
        {kind === 'fx' && <label className="field">Efeito<select value={effect} onChange={(e) => setEffect(e.target.value)}><option value="aura">Aura</option><option value="fire_circle">Círculo de fogo</option><option value="celestial_glow">Brilho celeste</option><option value="fire_trail">Rastro de fogo</option></select></label>}
        {kind === 'pet' && <label className="field">Pet<select value={species} onChange={(e) => setSpecies(e.target.value)}><option value="gato">Gato</option><option value="coruja">Coruja</option><option value="cao">Cão</option><option value="tartaruga">Tartaruga</option></select></label>}
        {kind !== 'city-theme' && <label className="field">Cor<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>}
        {kind === 'fx' && <label className="field">Intensidade<input type="range" min={0} max={1} step={0.1} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} /></label>}
        {kind === 'city-theme' && <>
          <label className="field">Base<select value={base} onChange={(e) => setBase(e.target.value as 'dia')}><option value="dia">Dia</option><option value="noite">Noite</option></select></label>
          <label className="field">Chão<input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /></label>
          <label className="field">Dourado<input type="color" value={gold} onChange={(e) => setGold(e.target.value)} /></label>
        </>}
      </div>
      {kind !== 'city-theme' && <Preview agent={agents.find((a) => a.name === target) ?? agents[0] ?? null} fx={kind === 'fx' ? { effect, color, intensity } : null} pet={kind === 'pet' ? { species, color } : null} />}
      <div className="row row--wrap">
        <button className="btn btn--primary" disabled={busy || title.trim().length < 2} onClick={() => void go('ver')}>Ver na cidade</button>
        <button className="btn" disabled={busy || title.trim().length < 2} onClick={() => void go('baixar')}>Baixar .ergon</button>
      </div>
    </section>
  );
}

interface CatalogPreview {
  swatches: string[]; names: string[]; tagline?: string;
  fx?: { effect: string; color: string; intensity: number }; pet?: { species: string; color: string };
  images: number; tags: string[];
}
interface CatalogItem { id: string; version: string; title: string; summary: string; kind: string; verified: boolean; installed: boolean; author?: string; preview?: CatalogPreview }

const INSTALAVEIS = ['city-theme', 'fx', 'pet', 'character-look', 'team-blueprint', 'skin'];
const CATEGORIAS: Array<{ k: string; l: string }> = [
  { k: 'todos', l: 'Todos' }, { k: 'skin', l: 'Skins' }, { k: 'city-theme', l: 'Temas' }, { k: 'fx', l: 'Efeitos' },
  { k: 'pet', l: 'Pets' }, { k: 'team-blueprint', l: 'Equipes' }, { k: 'outros', l: 'Outros' },
];
const PRINCIPAIS = new Set(['skin', 'city-theme', 'fx', 'pet', 'team-blueprint']);
const POR_PAGINA = 9;

/** Prévia de um pacote na galeria: a imagem dele; senão, efeito e pet desenhados num agente; senão, as cores e os nomes. */
function PreviaPacote({ item, agents }: { item: CatalogItem; agents: PreviewAgent[] }) {
  const p = item.preview;
  if (p?.images) return <img className="loja-previa__img" src={`/api/packages/catalog/official/${encodeURIComponent(item.id)}/preview/0`} alt="" loading="lazy" />;
  if (p?.fx || p?.pet) {
    return (
      <span className="loja-previa__vivo">
        <Preview agent={agents[0] ?? null} fx={p.fx ? { effect: p.fx.effect, color: p.fx.color, intensity: p.fx.intensity } as FxSpec : null} pet={p.pet ? { species: p.pet.species, color: p.pet.color } as PetSpec : null} />
      </span>
    );
  }
  const cores = p?.swatches.length ? p.swatches : ['#d8c8a0', '#b88b5b', '#1d184b'];
  return (
    <span className="loja-previa__cores" style={{ background: `linear-gradient(135deg, ${cores.map((c, i) => `${c} ${Math.round((i / cores.length) * 100)}% ${Math.round(((i + 1) / cores.length) * 100)}%`).join(', ')})` }}>
      {p?.names.length ? <span className="loja-previa__nomes">{p.names.slice(0, 4).join(' · ')}{p.names.length > 4 ? ` +${p.names.length - 4}` : ''}</span> : <span className="loja-previa__tipo">{KIND[item.kind] ?? item.kind}</span>}
    </span>
  );
}

/**
 * Loja em galeria, sem conta e sem pagamento: os oficiais vêm com o Ergon (assinados, funcionam sem internet) e os
 * modelos da comunidade vêm de um catálogo público, lido só quando a pessoa escolhe "Comunidade". Busca, categorias,
 * paginação e uma página de detalhe por pacote; instalar é o mesmo caminho de qualquer pacote (desfazer em Instalados).
 */
function Loja({ busy, agents, onInstall }: { busy: boolean; agents: PreviewAgent[]; onInstall: (url: string, item: CatalogItem) => Promise<boolean> }) {
  const of = useResource<CatalogItem[]>('/api/packages/catalog/official', []);
  const [origem, setOrigem] = useState<'oficiais' | 'comunidade'>('oficiais');
  const [com, setCom] = useState<CatalogItem[] | null>(null);
  const [aviso, setAviso] = useState('');
  const [lendo, setLendo] = useState(false);
  const [cat, setCat] = useState('todos');
  const [busca, setBusca] = useState('');
  const [soNovos, setSoNovos] = useState(false);
  const [pagina, setPagina] = useState(0);
  const [aberto, setAberto] = useState<CatalogItem | null>(null);
  useEffect(() => setPagina(0), [origem, cat, busca, soNovos]);
  const carregar = async (forcar: boolean) => {
    setAviso(''); setLendo(true);
    try { setCom(await api.get<CatalogItem[]>(`/api/packages/catalog/community${forcar ? '?atualizar=1' : ''}`)); }
    catch (e) { setAviso(errMsg(e)); } finally { setLendo(false); }
  };
  const lista = (origem === 'oficiais' ? of.data : com) ?? [];
  const q = busca.trim().toLowerCase();
  const filtrada = lista.filter((x) => (cat === 'todos' || (cat === 'outros' ? !PRINCIPAIS.has(x.kind) : x.kind === cat))
    && (!soNovos || !x.installed)
    && (!q || `${x.title} ${x.summary} ${x.author ?? ''} ${(x.preview?.tags ?? []).join(' ')} ${(x.preview?.names ?? []).join(' ')}`.toLowerCase().includes(q)));
  const paginas = Math.max(1, Math.ceil(filtrada.length / POR_PAGINA));
  const vista = filtrada.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const contar = (k: string) => lista.filter((x) => (k === 'todos' || (k === 'outros' ? !PRINCIPAIS.has(x.kind) : x.kind === k))).length;
  const instalar = async (item: CatalogItem) => {
    const ok = await onInstall(origem === 'oficiais' ? '/api/packages/catalog/official/install' : '/api/packages/catalog/community/install', item);
    if (ok) {
      if (origem === 'oficiais') of.reload(); else setCom((c) => c?.map((x) => (x.id === item.id ? { ...x, installed: true } : x)) ?? null);
      setAberto((a) => (a && a.id === item.id ? { ...a, installed: true } : a));
    }
  };
  const botao = (x: CatalogItem, grande = false) => (x.installed
    ? <span className="badge badge--ok">instalado</span>
    : <button className={`btn ${grande ? 'btn--primary' : 'btn--sm'}`} disabled={busy || !INSTALAVEIS.includes(x.kind)} onClick={(e) => { e.stopPropagation(); void instalar(x); }}>Instalar</button>);
  return (
    <section className="card loja">
      <div className="loja__topo">
        <h3>Loja</h3>
        <div className="loja__origem" role="tablist" aria-label="Origem">
          <button role="tab" aria-selected={origem === 'oficiais'} className={`chip chip--btn ${origem === 'oficiais' ? 'is-on' : ''}`} onClick={() => setOrigem('oficiais')}>Oficiais</button>
          <button role="tab" aria-selected={origem === 'comunidade'} className={`chip chip--btn ${origem === 'comunidade' ? 'is-on' : ''}`} onClick={() => { setOrigem('comunidade'); if (!com && !lendo) void carregar(false); }}>Comunidade</button>
        </div>
        <input className="input loja__busca" type="search" placeholder="Buscar pacotes…" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar pacotes" />
      </div>
      <p className="muted small">{origem === 'oficiais'
        ? 'Vêm com o Ergon, verificados, e funcionam sem internet.'
        : 'Feitos por quem usa o Ergon, num catálogo público lido só agora, porque você pediu. Não são verificados: instale o que fizer sentido para você.'}</p>
      <div className="loja__cats" role="tablist" aria-label="Categorias">
        {CATEGORIAS.map((c) => {
          const n = contar(c.k);
          return (c.k === 'todos' || n > 0) && (
            <button key={c.k} role="tab" aria-selected={cat === c.k} className={`chip chip--btn ${cat === c.k ? 'is-on' : ''}`} onClick={() => setCat(c.k)}>{c.l} <span className="muted">{n}</span></button>
          );
        })}
        <label className="loja__novos small"><input type="checkbox" checked={soNovos} onChange={(e) => setSoNovos(e.target.checked)} /> Só os que não tenho</label>
      </div>
      {origem === 'comunidade' && aviso && <p className="muted" role="status">{aviso} <button className="link" disabled={lendo} onClick={() => void carregar(true)}>Tentar de novo</button></p>}
      {((origem === 'comunidade' && lendo) || (origem === 'oficiais' && !of.data)) && <Loading error={origem === 'oficiais' ? of.error : null} />}
      {!lendo && lista.length > 0 && !filtrada.length && <p className="muted">Nada com esses filtros.</p>}
      {origem === 'comunidade' && com && !com.length && <p className="muted">O catálogo da comunidade ainda está vazio.</p>}
      {vista.length > 0 && (
        <ul className="loja__grade">
          {vista.map((x) => (
            <li key={x.id}>
              <article className="loja-card" tabIndex={0} role="button" aria-label={`${x.title}: ver detalhes`} onClick={() => setAberto(x)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAberto(x); } }}>
                <div className="loja-previa"><PreviaPacote item={x} agents={agents} /></div>
                <div className="loja-card__txt">
                  <b>{x.title}</b>
                  <span className="muted small">{KIND[x.kind] ?? x.kind}{x.author ? ` · por ${x.author}` : ''}</span>
                </div>
                <div className="loja-card__pe">
                  {x.verified ? <span className="badge">verificado</span> : <span className="badge badge--warn" title="Sem a assinatura do Ergon: instale só se confiar em quem fez.">não verificado</span>}
                  {botao(x)}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {paginas > 1 && (
        <nav className="loja__paginas" aria-label="Páginas">
          <button className="btn btn--sm btn--ghost" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
          {Array.from({ length: paginas }, (_, i) => (
            <button key={i} className={`chip chip--btn ${i === pagina ? 'is-on' : ''}`} aria-current={i === pagina ? 'page' : undefined} onClick={() => setPagina(i)}>{i + 1}</button>
          ))}
          <button className="btn btn--sm btn--ghost" disabled={pagina >= paginas - 1} onClick={() => setPagina((p) => p + 1)}>Próxima</button>
        </nav>
      )}
      {origem === 'comunidade' && com && <button className="link" disabled={lendo} onClick={() => void carregar(true)}>Atualizar a lista</button>}
      {aberto && <DetalhePacote item={aberto} agents={agents} acao={botao(aberto, true)} onClose={() => setAberto(null)} />}
    </section>
  );
}

/** Página de detalhe de um pacote: prévia grande, descrição, o que ele traz e instalar. */
function DetalhePacote({ item, agents, acao, onClose }: { item: CatalogItem; agents: PreviewAgent[]; acao: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const p = item.preview;
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card loja-detalhe" role="dialog" aria-modal="true" aria-labelledby="loja-det-titulo">
        <div className="loja-detalhe__previa loja-previa"><PreviaPacote item={item} agents={agents} /></div>
        <h3 id="loja-det-titulo">{item.title}</h3>
        <p className="muted small">{KIND[item.kind] ?? item.kind} · versão {item.version}{item.author ? ` · por ${item.author}` : ''} · {item.verified ? 'verificado' : 'não verificado'}</p>
        {p?.tagline && p.tagline !== item.summary && <p><i>{p.tagline}</i></p>}
        <p>{item.summary}</p>
        {p?.names.length ? <p className="small"><b>{item.kind === 'team-blueprint' ? 'Na equipe' : 'Personagens'}:</b> {p.names.join(', ')}</p> : null}
        {p?.swatches.length ? <div className="loja-detalhe__cores" aria-label="Cores">{p.swatches.map((c) => <span key={c} style={{ background: c }} title={c} />)}</div> : null}
        {p?.tags.length ? <p className="small muted">{p.tags.map((t) => `#${t}`).join(' ')}</p> : null}
        {!INSTALAVEIS.includes(item.kind) && <p className="hint">Este tipo de pacote ainda não pode ser instalado nesta versão.</p>}
        <div className="cpop__acts">
          <button className="btn btn--ghost" onClick={onClose}>Fechar</button>
          {acao}
        </div>
      </div>
    </div>
  );
}

export function PacotesPanel({ agents = [] }: { agents?: PreviewAgent[] }) {
  const res = useResource<Installed[]>('/api/packages', []);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = (url: string, f: File) => api.post<Preview & { id: string }>(url, new Blob([f], { type: 'application/x-ergon' }));
  const choose = async (f: File | null) => {
    setMsg(null); setPreview(null); setFile(f);
    if (!f) return;
    setBusy(true);
    try { setPreview(await send('/api/packages/preview', f)); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const install = async () => {
    if (!file) return; setBusy(true);
    try { await send('/api/packages/install', file); setMsg({ kind: 'ok', text: 'Pacote aplicado. Dá para desfazer quando quiser.' }); setPreview(null); setFile(null); res.reload(); window.dispatchEvent(new Event('ergon:packages')); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const undo = async (p: Installed) => {
    setBusy(true);
    try { await api.del(`/api/packages/${p.id}`); setMsg({ kind: 'ok', text: `"${p.title}" desfeito: voltou como estava.` }); res.reload(); window.dispatchEvent(new Event('ergon:packages')); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  if (!res.data) return <Loading error={res.error} />;
  const ativos = res.data.filter((p) => p.active);
  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      <Loja busy={busy} agents={agents} onInstall={async (url, item) => {
        setMsg(null); setBusy(true);
        try { await api.post(url, { id: item.id }); setMsg({ kind: 'ok', text: `"${item.title}" aplicado. Dá para desfazer em Instalados.` }); res.reload(); window.dispatchEvent(new Event('ergon:packages')); return true; }
        catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); return false; } finally { setBusy(false); }
      }} />
      <Editor agents={agents} busy={busy} onBuilt={async (blob, title, how) => {
        if (how === 'baixar') { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}.ergon`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return; }
        setBusy(true);
        try { await api.post('/api/packages/install', blob); setMsg({ kind: 'ok', text: `"${title}" aplicado: veja na cidade. Dá para desfazer abaixo.` }); res.reload(); window.dispatchEvent(new Event('ergon:packages')); }
        catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
      }} onError={(t) => setMsg({ kind: 'error', text: t })} />
      <section className="card">
        <h3>Instalar um pacote .ergon</h3>
        <p className="muted">Temas da cidade, efeitos (aura, círculo de fogo, brilho, rastro), pets, aparências e equipes. Um pacote só traz aparência e textos: nunca ferramentas, contas ou acesso aos seus dados.</p>
        <input ref={input} type="file" accept=".ergon" hidden onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Escolher arquivo .ergon</button>
        {preview && (
          <div className="card card--inner">
            <b>{preview.title}</b> <span className="muted small">{KIND[preview.kind] ?? preview.kind} · {preview.packageId} {preview.version}</span>
            {preview.verified ? <span className="badge">verificado pela loja</span> : <span className="badge badge--warn" title="Sem a assinatura da loja do Ergon: instale só se confiar em quem fez.">não verificado</span>}
            <p className="small">{preview.summary}</p>
            <ul className="small">{preview.changes.map((c) => <li key={c}>{c}</li>)}</ul>
            {preview.installable ? <button className="btn btn--primary" disabled={busy} onClick={() => void install()}>Aplicar</button> : <p className="muted small">{preview.reason}</p>}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Instalados</h3>
        {!ativos.length && <p className="muted">Nenhum pacote aplicado: a cidade está como veio.</p>}
        <ul className="sec-rows">
          {ativos.map((p) => (
            <li key={p.id}>
              <b>{p.title}</b><span className="muted small">{KIND[p.kind] ?? p.kind} · {p.version}{p.verified ? ' · verificado' : ' · não verificado'}</span>
              <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void undo(p)}>Desfazer</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

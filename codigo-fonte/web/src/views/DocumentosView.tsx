import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api, errMsg, uploadFile } from '../lib/api.ts';
import { dragHasFiles, inlinePreview, isImage, kindOf, size } from '../lib/files.ts';
import { useResource } from '../lib/live.ts';
import { useHashParam } from '../lib/route.ts';
import { cardClick } from '../lib/cardClick.ts';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { Icon } from '../components/Icon.tsx';
import { fmtData, useIdioma, useT } from '../i18n/index.ts';

interface Folder { id: string; parent_id: string | null; name: string; system_key: string | null }
interface FileItem { id: string; filename: string; mime: string; size: number; created_at: string; deleted_at?: string | null }
interface Listing {
  folder: { id: string; name: string; system_key: string | null }; path: Array<{ id: string; name: string }>;
  folders: Array<Folder & { items?: number; deleted_at?: string | null }>; files: FileItem[]; trashDays?: number;
}
interface Preview { kind: 'inline' | 'text' | 'sheet' | 'none'; mime: string; text?: string; pages?: number | null; detail?: string | null; sheets?: Array<{ name: string; rows: string[][] }> }

/** pastas automáticas da raiz: ficam onde estão */
const FIXED = new Set(['cards', 'conversas', 'rotinas']);
const DRAG_TYPE = 'application/x-ergon-doc';
const date = (iso: string) => fmtData(iso, { day: '2-digit', month: '2-digit', year: '2-digit' });

/** Árvore de pastas (à esquerda): abre e fecha; soltar um item em cima move para lá. */
function Tree({ all, at, onOpen, onDropTo }: { all: Folder[]; at: string; onOpen: (id: string) => void; onDropTo: (target: string, data: string) => void }) {
  const t = useT();
  const idioma = useIdioma();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [over, setOver] = useState<string | null>(null);
  // a pasta aberta sempre aparece (os pais dela ficam abertos)
  useEffect(() => {
    const ids = new Set(open);
    for (let p = all.find((f) => f.id === at); p?.parent_id; p = all.find((f) => f.id === p!.parent_id)) ids.add(p.parent_id);
    if (ids.size !== open.size) setOpen(ids);
  }, [at, all]); // eslint-disable-line react-hooks/exhaustive-deps
  const drop = (id: string) => ({
    onDragOver: (e: DragEvent) => { if ([...e.dataTransfer.types].includes(DRAG_TYPE)) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: DragEvent) => { const d = e.dataTransfer.getData(DRAG_TYPE); setOver(null); if (d) { e.preventDefault(); onDropTo(id, d); } },
  });
  const node = (f: Folder, depth: number): ReactNode => {
    const kids = all.filter((x) => x.parent_id === f.id).sort((a, b) => a.name.localeCompare(b.name, idioma));
    const isOpen = open.has(f.id);
    return (
      <li key={f.id}>
        <div className={`dtree__row ${at === f.id ? 'is-on' : ''} ${over === f.id ? 'is-over' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} {...drop(f.id)}>
          <button type="button" className="dtree__toggle" aria-label={isOpen ? t('documentos.fechar') : t('documentos.abrir')} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} style={{ visibility: kids.length ? 'visible' : 'hidden' }}>
            <Icon name={isOpen ? 'chevron' : 'chevron-right'} size={12} />
          </button>
          <button type="button" className="dtree__name" onClick={() => onOpen(f.id)} title={f.name}><Icon name="folder" size={14} /><span>{f.name}</span></button>
        </div>
        {isOpen && kids.length > 0 && <ul>{kids.map((k) => node(k, depth + 1))}</ul>}
      </li>
    );
  };
  const roots = all.filter((f) => !f.parent_id).sort((a, b) => Number(!!b.system_key && FIXED.has(b.system_key)) - Number(!!a.system_key && FIXED.has(a.system_key)) || a.name.localeCompare(b.name, idioma));
  return (
    <nav className="dtree" aria-label={t('documentos.arvore.pastas')}>
      <div className={`dtree__row dtree__root ${at === 'root' ? 'is-on' : ''} ${over === 'root' ? 'is-over' : ''}`} {...drop('root')}>
        <button type="button" className="dtree__name" onClick={() => onOpen('root')}><Icon name="home" size={14} /><span>{t('documentos.titulo')}</span></button>
      </div>
      <ul>{roots.map((f) => node(f, 0))}</ul>
      <div className={`dtree__row dtree__trash ${at === 'trash' ? 'is-on' : ''}`}>
        <button type="button" className="dtree__name" onClick={() => onOpen('trash')}><Icon name="trash" size={14} /><span>{t('documentos.lixeira')}</span></button>
      </div>
    </nav>
  );
}

/** Prévia do arquivo: imagem e PDF direto; documento e planilha pelo texto lido pelo sistema. */
function PreviewPane({ f, onClose, onRename, onMove, onTrash, folders }: {
  f: FileItem; onClose: () => void; onRename: (name: string) => void; onMove: (target: string) => void; onTrash: () => void; folders: Array<{ id: string; label: string }>;
}) {
  const t = useT();
  const pv = useResource<Preview>(inlinePreview(f.mime) ? null : `/api/artifacts/${f.id}/preview`, []);
  const [name, setName] = useState<string | null>(null);
  const url = `/api/artifacts/${f.id}/download`;
  return (
    <aside className="dpreview" aria-label={t('documentos.previa.de', { nome: f.filename })}>
      <header className="dpreview__head">
        {name === null ? <b title={f.filename}>{f.filename}</b> : (
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onRename(name.trim()); setName(null); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t('documentos.previa.novoNome')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setName(null); } }} />
            <button className="btn btn--sm btn--primary">{t('documentos.renomear')}</button>
          </form>
        )}
        <button className="icon-btn" onClick={onClose} aria-label={t('documentos.previa.fechar')}><Icon name="x" /></button>
      </header>
      <p className="muted small">{kindOf(f.filename, f.mime)} · {size(f.size)} · {date(f.created_at)}</p>
      <div className="dpreview__body">
        {isImage(f.mime) ? <img src={`${url}?inline=1`} alt={f.filename} />
          : f.mime === 'application/pdf' ? <iframe src={`${url}?inline=1`} title={f.filename} />
          : !pv.data ? <p className="muted">{t('documentos.previa.lendo')}</p>
          : pv.data.kind === 'sheet' ? pv.data.sheets?.map((s) => (
            <div key={s.name} className="md__table"><b className="small">{s.name}</b>
              <table><tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody></table>
            </div>))
          : pv.data.kind === 'text' ? <pre className="dpreview__text">{pv.data.text}</pre>
          : <p className="muted">{pv.data.detail ? t('documentos.previa.semPreviaDetalhe', { detalhe: pv.data.detail }) : t('documentos.previa.semPrevia')}</p>}
      </div>
      <div className="dpreview__acts">
        <a className="btn btn--sm btn--primary" href={url} download={f.filename}><Icon name="download" size={13} /> {t('documentos.previa.baixar')}</a>
        <button type="button" className="btn btn--sm" onClick={() => setName(f.filename.replace(/\.[^.]+$/, ''))}><Icon name="pen" size={13} /> {t('documentos.renomear')}</button>
        <select className="dpreview__move" value="" onChange={(e) => e.target.value && onMove(e.target.value)} aria-label={t('documentos.moverPara')}>
          <option value="">{t('documentos.moverParaOpcao')}</option>
          {folders.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onTrash}><Icon name="trash" size={13} /> {t('documentos.lixeira')}</button>
      </div>
    </aside>
  );
}

/**
 * Documentos: os arquivos do workspace, como num explorador — pastas, arrastar do computador, mover arrastando,
 * renomear, prévia e lixeira. Tudo cifrado no Ergon. Cards, Conversas e Rotinas recebem sozinhos o que chega por lá.
 * E dá para pedir à coordenação: "cria a pasta Clientes e põe lá os contratos".
 */
export function DocumentosView({ coord }: { coord: string }) {
  const t = useT();
  const idioma = useIdioma();
  const [hashFolder, setHashFolder] = useHashParam('pasta');
  const at = hashFolder && /^(trash|entregas|fld_[a-f0-9]{32})$/.test(hashFolder) ? hashFolder : 'root';
  const go = (id: string) => { setHashFolder(id === 'root' ? null : id); setSel(new Set()); setOpenFile(null); };
  const tree = useResource<Folder[]>('/api/documents/tree', ['artifacts.changed']);
  const listing = useResource<Listing>(`/api/documents?folder=${at}`, ['artifacts.changed']);
  const [q, setQ] = useState('');
  const search = useResource<Array<FileItem & { path: string }>>(q.trim().length >= 2 ? `/api/documents/search?q=${encodeURIComponent(q.trim())}` : null, ['artifacts.changed']);
  const [mode, setMode] = useState<'grade' | 'lista'>(() => { try { return (localStorage.getItem('ergon.docs.modo') as 'grade' | 'lista') || 'grade'; } catch { return 'grade'; } });
  useEffect(() => { try { localStorage.setItem('ergon.docs.modo', mode); } catch { /* sem armazenamento: fica só nesta visita */ } }, [mode]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<FileItem | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // o clique que encerra a renomeação (o campo perde o foco já no pressionar) não entra na pasta: guardado no pointerdown
  const leftRename = useRef<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [emptyAsk, setEmptyAsk] = useState(false);
  const [ups, setUps] = useState<Array<{ key: string; name: string; progress: number; error: string | null }>>([]);
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const trash = at === 'trash';
  const all = tree.data ?? [];
  const data = listing.data;
  const fixedHere = (f: { system_key: string | null }) => !!f.system_key && FIXED.has(f.system_key);
  const pathOf = (id: string) => { const n: string[] = []; for (let p = all.find((f) => f.id === id); p; p = all.find((f) => f.id === p!.parent_id)) n.unshift(p.name); return n.join(' / '); };
  const targets = useMemo(() => [{ id: 'root', label: t('documentos.raizAlvo') }, ...all.map((f) => ({ id: f.id, label: pathOf(f.id) })).sort((a, b) => a.label.localeCompare(b.label, idioma))], [all, idioma]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (text: string, undo: string | null = null) => { setToast({ text, undo }); window.setTimeout(() => setToast((x) => (x?.text === text ? null : x)), 7000); };
  const act = async (fn: () => Promise<{ undo?: string } | unknown>, text: string) => {
    setErr(null);
    try { const r = await fn() as { undo?: string } | undefined; done(text, r?.undo ?? null); listing.reload(); tree.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const moveTo = (target: string, ids: string[]) => {
    const files = ids.filter((x) => x.startsWith('art_')); const folders = ids.filter((x) => x.startsWith('fld_') && x !== target);
    void act(async () => {
      let last: { undo?: string } = {};
      for (const id of files) last = await api.patch(`/api/artifacts/${id}`, { folderId: target });
      for (const id of folders) last = await api.patch(`/api/documents/folders/${id}`, { parentId: target });
      return last;
    }, t('documentos.feito.movido', { n: ids.length, destino: target === 'root' ? t('documentos.titulo') : pathOf(target) }));
    setSel(new Set());
  };
  const toTrash = (ids: string[]) => void act(async () => {
    let last: { undo?: string } = {};
    for (const id of ids) last = await api.post('/api/documents/trash', id.startsWith('art_') ? { artifactId: id } : { folderId: id });
    return ids.length === 1 ? last : {};
  }, t('documentos.feito.lixeira', { n: ids.length })).then(() => { setSel(new Set()); setOpenFile(null); });
  const restore = (id: string) => void act(() => api.post('/api/documents/restore', id.startsWith('art_') ? { artifactId: id } : { folderId: id }), t('documentos.feito.restaurado'));

  const upload = async (files: FileList | File[]) => {
    if (trash) return;
    for (const file of [...files].filter((f) => f.size > 0)) {
      const key = crypto.randomUUID();
      setUps((u) => [...u, { key, name: file.name, progress: 0, error: null }]);
      const upd = (p: Partial<{ progress: number; error: string | null }>) => setUps((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      uploadFile(file, at === 'root' ? {} : { folderId: at }, (v) => upd({ progress: v }))
        .then(() => { setUps((u) => u.filter((x) => x.key !== key)); listing.reload(); })
        .catch((e) => upd({ error: errMsg(e) }));
    }
  };

  const items = q.trim().length >= 2 ? null : data;
  const startDrag = (e: DragEvent, id: string) => {
    const ids = sel.has(id) ? [...sel] : [id];
    e.dataTransfer.setData(DRAG_TYPE, ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropOnFolder = (target: string) => ({
    onDragOver: (e: DragEvent) => { if ([...e.dataTransfer.types].includes(DRAG_TYPE)) { e.preventDefault(); e.currentTarget.classList.add('is-over'); } },
    onDragLeave: (e: DragEvent) => e.currentTarget.classList.remove('is-over'),
    onDrop: (e: DragEvent) => { e.currentTarget.classList.remove('is-over'); const d = e.dataTransfer.getData(DRAG_TYPE); if (d) { e.preventDefault(); e.stopPropagation(); moveTo(target, d.split(',')); } },
  });
  const toggle = (id: string, on?: boolean) => setSel((s) => { const n = new Set(s); if (on ?? !n.has(id)) n.add(id); else n.delete(id); return n; });

  return (
    <div className="docs">
      <Tree all={all} at={at} onOpen={go} onDropTo={(target, d) => moveTo(target, d.split(','))} />
      <section className={`docs__main ${drag ? 'is-drag' : ''}`}
        onDragEnter={(e) => { if (dragHasFiles(e) && !trash) { e.preventDefault(); depth.current++; setDrag(true); } }}
        onDragOver={(e) => { if (dragHasFiles(e) && !trash) e.preventDefault(); }}
        onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDrag(false); }}
        onDrop={(e) => { if (!dragHasFiles(e)) return; e.preventDefault(); depth.current = 0; setDrag(false); void upload(e.dataTransfer.files); }}
        onKeyDown={(e) => { if (e.key === 'Delete' && sel.size && !trash && !(e.target as HTMLElement).closest('input, textarea, select')) toTrash([...sel]); }}>
        <header className="docs__bar">
          <nav className="docs__crumbs" aria-label={t('documentos.barra.caminho')}>
            <button type="button" className="linkish" onClick={() => go('root')}>{t('documentos.titulo')}</button>
            {trash ? <><span>›</span><b>{t('documentos.lixeira')}</b></> : data?.path.map((p, i) => (
              <span key={p.id} className="docs__crumb"><span>›</span>{i === data.path.length - 1 ? <b>{p.name}</b> : <button type="button" className="linkish" onClick={() => go(p.id)} {...dropOnFolder(p.id)}>{p.name}</button>}</span>
            ))}
          </nav>
          <span className="grow" />
          <label className="foco__search docs__search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('documentos.barra.buscar')} aria-label={t('documentos.barra.buscar')} /></label>
          {!trash && <>
            <button type="button" className="btn btn--sm" onClick={() => setNewFolder('')}><Icon name="folder-plus" size={14} /> {t('documentos.barra.novaPasta')}</button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => picker.current?.click()}><Icon name="download" size={14} /> {t('documentos.barra.enviar')}</button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
          </>}
          {trash && !!data?.files.length && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEmptyAsk(true)}><Icon name="trash" size={14} /> {t('documentos.barra.esvaziar')}</button>}
          <div className="seg" role="group" aria-label={t('documentos.barra.exibicao')}>
            <button type="button" className={mode === 'grade' ? 'is-on' : ''} onClick={() => setMode('grade')} aria-label={t('documentos.barra.grade')} title={t('documentos.barra.grade')}><Icon name="grid" size={14} /></button>
            <button type="button" className={mode === 'lista' ? 'is-on' : ''} onClick={() => setMode('lista')} aria-label={t('documentos.barra.lista')} title={t('documentos.barra.lista')}><Icon name="list" size={14} /></button>
          </div>
        </header>
        {sel.size > 0 && !trash && (
          <div className="docs__selbar">
            <span>{t('documentos.sel.contagem', { n: sel.size })}</span>
            <select value="" onChange={(e) => e.target.value && moveTo(e.target.value, [...sel])} aria-label={t('documentos.sel.moverSelecionados')}>
              <option value="">{t('documentos.moverParaOpcao')}</option>{targets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => toTrash([...sel])}><Icon name="trash" size={13} /> {t('documentos.lixeira')}</button>
            <button type="button" className="linkish" onClick={() => setSel(new Set())}>{t('documentos.sel.limpar')}</button>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        {trash && <p className="hint">{t('documentos.dica.lixeira', { n: data?.trashDays ?? 30 })}</p>}
        {!trash && at === 'root' && <p className="hint docs__tip">{t('documentos.dica.raiz', { nome: coord })}</p>}
        {newFolder !== null && (
          <form className="docs__newfolder" onSubmit={(e) => { e.preventDefault(); const n = newFolder.trim(); if (!n) return; setNewFolder(null); void act(() => api.post('/api/documents/folders', { name: n, parentId: at === 'root' ? null : at }), t('documentos.feito.pastaCriada', { nome: n })); }}>
            <Icon name="folder" size={16} /><input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder={t('documentos.novaPasta.placeholder')} aria-label={t('documentos.novaPasta.aria')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNewFolder(null); } }} />
            <button className="btn btn--sm btn--primary">{t('documentos.novaPasta.criar')}</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => setNewFolder(null)}>{t('documentos.novaPasta.cancelar')}</button>
          </form>
        )}
        {ups.length > 0 && <div className="docs__ups">{ups.map((u) => (
          <span key={u.key} className={`fchip ${u.error ? 'fchip--err' : ''}`}><span className="fchip__main"><span className="fchip__icon"><Icon name="file" size={14} /></span><span className="fchip__txt"><b>{u.name}</b><small>{u.error ?? t('documentos.envio.subindo', { pct: Math.round(u.progress * 100) })}</small></span>{!u.error && <span className="fchip__bar" style={{ width: `${Math.round(u.progress * 100)}%` }} />}</span>
            {u.error && <button type="button" className="fchip__x" onClick={() => setUps((x) => x.filter((y) => y.key !== u.key))} aria-label={t('documentos.fechar')}><Icon name="x" size={12} /></button>}</span>
        ))}</div>}

        {search.data && q.trim().length >= 2 ? (
          <ul className="docs__list docs__list--lista">
            {search.data.map((f) => (
              // antes só o mouse abria (a linha não recebia o foco): agora a linha é um botão, e o resto dela também abre
              <li key={f.id} className={`ditem card-click ${openFile?.id === f.id ? 'is-open' : ''}`} onClick={cardClick(() => setOpenFile(f))}>
                <button type="button" className="ditem__open" onClick={() => setOpenFile(f)} aria-label={t('documentos.busca.abrirPrevia', { nome: f.filename })}>
                  <span className="ditem__icon"><Icon name="file" size={18} /></span>
                  <span className="ditem__name"><b>{f.filename}</b><small className="muted">{f.path || t('documentos.titulo')}</small></span>
                  <span className="ditem__meta">{kindOf(f.filename, f.mime)} · {size(f.size)}</span>
                </button>
              </li>
            ))}
            {!search.data.length && <li className="muted">{t('documentos.busca.nada')}</li>}
          </ul>
        ) : items && (
          <ul className={`docs__list docs__list--${mode}`}>
            {items.folders.map((f) => (
              <li key={f.id} className={`ditem ditem--folder ${sel.has(f.id) ? 'is-sel' : ''} ${trash ? '' : 'card-click'}`} draggable={!trash && !fixedHere(f)} onDragStart={(e) => startDrag(e, f.id)}
                onPointerDown={() => { leftRename.current = renaming?.id === f.id ? f.id : null; }}
                onClick={trash ? undefined : (e) => { if (leftRename.current === f.id) { leftRename.current = null; return; } cardClick(() => go(f.id))(e); }} {...(!trash ? dropOnFolder(f.id) : {})}>
                {!trash && !fixedHere(f) && <input type="checkbox" className="ditem__check" checked={sel.has(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} aria-label={t('documentos.pasta.selecionar', { nome: f.name })} onClick={(e) => e.stopPropagation()} />}
                <button type="button" className="ditem__open" onClick={() => (trash ? undefined : go(f.id))}>
                  <span className="ditem__icon ditem__icon--folder"><Icon name="folder" size={mode === 'grade' ? 34 : 18} /></span>
                  {renaming?.id === f.id ? null : <span className="ditem__name"><b title={f.name}>{f.name}</b><small className="muted">{fixedHere(f) ? t('documentos.pasta.automatica') : t('documentos.pasta.itens', { n: f.items ?? 0 })}</small></span>}
                </button>
                {renaming?.id === f.id && (
                  <form className="ditem__rename" onSubmit={(e) => { e.preventDefault(); const n = renaming.name.trim(); setRenaming(null); if (n && n !== f.name) void act(() => api.patch(`/api/documents/folders/${f.id}`, { name: n }), t('documentos.feito.pastaRenomeada')); }}>
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: f.id, name: e.target.value })} onBlur={() => setRenaming(null)} aria-label={t('documentos.pasta.novoNome')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} />
                  </form>
                )}
                {trash ? <button type="button" className="btn btn--sm" onClick={() => restore(f.id)}>{t('documentos.restaurar')}</button>
                  : <span className="ditem__acts">
                    <button type="button" className="icon-btn" onClick={() => setRenaming({ id: f.id, name: f.name })} aria-label={t('documentos.pasta.renomearAria', { nome: f.name })} title={fixedHere(f) ? t('documentos.pasta.renomearFixa') : t('documentos.renomear')}><Icon name="pen" size={13} /></button>
                    {!fixedHere(f) && <button type="button" className="icon-btn" onClick={() => toTrash([f.id])} aria-label={t('documentos.pasta.lixeiraAria', { nome: f.name })} title={t('documentos.lixeira')}><Icon name="trash" size={13} /></button>}
                  </span>}
              </li>
            ))}
            {items.files.map((f) => (
              <li key={f.id} className={`ditem ${sel.has(f.id) ? 'is-sel' : ''} ${openFile?.id === f.id ? 'is-open' : ''} ${trash ? '' : 'card-click'}`} draggable={!trash} onDragStart={(e) => startDrag(e, f.id)}
                onClick={trash ? undefined : cardClick(() => setOpenFile(f))}>
                {!trash && <input type="checkbox" className="ditem__check" checked={sel.has(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} aria-label={t('documentos.pasta.selecionar', { nome: f.filename })} onClick={(e) => e.stopPropagation()} />}
                <button type="button" className="ditem__open" onClick={() => (trash ? undefined : setOpenFile(f))}>
                  <span className="ditem__icon">{isImage(f.mime) ? <img src={`/api/artifacts/${f.id}/download?inline=1`} alt="" loading="lazy" /> : <Icon name={f.mime.startsWith('image/') ? 'image' : 'file'} size={mode === 'grade' ? 32 : 18} />}</span>
                  <span className="ditem__name"><b title={f.filename}>{f.filename}</b><small className="muted">{kindOf(f.filename, f.mime)} · {size(f.size)} · {date(f.deleted_at ?? f.created_at)}</small></span>
                </button>
                {trash && <button type="button" className="btn btn--sm" onClick={() => restore(f.id)}>{t('documentos.restaurar')}</button>}
              </li>
            ))}
            {!items.folders.length && !items.files.length && (
              <li className="docs__empty muted">{trash ? t('documentos.vazio.lixeira') : t('documentos.vazio.pasta')}</li>
            )}
          </ul>
        )}
        {drag && <div className="docs__drop" aria-hidden="true"><Icon name="download" size={28} /><b>{at === 'root' ? t('documentos.soltar.raiz') : data?.folder.name ? t('documentos.soltar.pasta', { pasta: data.folder.name }) : t('documentos.soltar.estaPasta')}</b></div>}
        {toast && (
          <div className="docs__toast" role="status">
            {toast.text}
            {toast.undo && <button type="button" className="linkish" onClick={() => { const u = toast.undo!; setToast(null); void act(() => api.post(`/api/documents/undo/${u}`), t('documentos.feito.desfeito')); }}><Icon name="undo" size={12} /> {t('documentos.desfazer')}</button>}
          </div>
        )}
      </section>
      {openFile && !trash && (
        <PreviewPane key={openFile.id} f={openFile} folders={targets} onClose={() => setOpenFile(null)}
          onRename={(n) => void act(() => api.patch(`/api/artifacts/${openFile.id}`, { filename: n }), t('documentos.feito.arquivoRenomeado')).then(() => setOpenFile(null))}
          onMove={(alvo) => { moveTo(alvo, [openFile.id]); setOpenFile(null); }}
          onTrash={() => toTrash([openFile.id])} />
      )}
      {emptyAsk && (
        <ConfirmPopup title={t('documentos.esvaziar.titulo')} confirmLabel={t('documentos.esvaziar.confirmar')} onCancel={() => setEmptyAsk(false)}
          onConfirm={() => { setEmptyAsk(false); void act(() => api.post('/api/documents/trash/empty'), t('documentos.feito.esvaziada')); }}>
          <p>{t('documentos.esvaziar.texto', { n: data?.files.length ?? 0 })}</p>
        </ConfirmPopup>
      )}
    </div>
  );
}

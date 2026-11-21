/**
 * O que vai dentro do cartão de uma tarefa da pessoa (rc.41): etiquetas e pessoas à vista (o essencial) e, em seções
 * que recolhem, subtarefas, os outros campos do quadro, links, arquivos de Documentos e comentários (de pessoas e de
 * agentes, até 240 caracteres). Cada seção lembra se a pessoa a deixou aberta; vazia, nasce recolhida — o detalhe não
 * vira um formulário comprido. Num quadro espelhado, tudo aqui fica só no Ergon (a Ajuda explica; a tela não repete).
 * No card da equipe aparece só a seção de comentários, e só quando há algum.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { fmtDataHora, fmtNumero, useT } from '../i18n/index.ts';
import { COMENTARIO_MAX, contarLetras, corDaPaleta, iniciais, lerNumero, linkSeguro, nomeDoLink } from '../lib/cartao-tela.ts';
import { haQuantoTempo } from '../lib/work.ts';
import { previaDe } from '../lib/tarefa-tela.ts';
import type { CampoQuadro, Cartao, ValorCampo } from '../lib/types.ts';
import { FileViewer } from './FileViewer.tsx';
import { Icon } from './Icon.tsx';

type Secao = 'sub' | 'campos' | 'links' | 'anexos' | 'coment';
const lembrado = (k: Secao): boolean | null => { try { const v = localStorage.getItem(`ergon.cartao.${k}`); return v === null ? null : v === '1'; } catch { return null; } };
const lembrar = (k: Secao, aberto: boolean) => { try { localStorage.setItem(`ergon.cartao.${k}`, aberto ? '1' : '0'); } catch { /* sem armazenamento */ } };

/** Uma seção que recolhe: o título com a contagem fica sempre à vista. */
function Recolhe({ id, titulo, conta, temAlgo, children }: { id: Secao; titulo: string; conta?: string; temAlgo: boolean; children: ReactNode }) {
  // a escolha da pessoa vale; sem escolha, abre só o que tem algo dentro
  const [aberto, setAberto] = useState(() => lembrado(id) ?? temAlgo);
  return (
    <details className="block cx" open={aberto} onToggle={(e) => { const a = (e.currentTarget as HTMLDetailsElement).open; if (a !== aberto) { setAberto(a); lembrar(id, a); } }}>
      <summary><span className="cx__t">{titulo}</span>{conta && <span className="cx__n">{conta}</span>}</summary>
      {aberto && <div className="cx__body">{children}</div>}
    </details>
  );
}

/** O campo de um valor, pelo tipo; salva ao sair do campo (texto e número) ou ao escolher. */
function CampoValor({ campo, valor, membros, salvar }: { campo: CampoQuadro; valor: ValorCampo | undefined; membros: Cartao['members']; salvar: (v: ValorCampo) => void }) {
  const t = useT();
  const inicial = campo.type === 'number' ? (typeof valor === 'number' ? fmtNumero(valor, { useGrouping: false, maximumFractionDigits: 6 }) : '') : typeof valor === 'string' ? valor : '';
  const [txt, setTxt] = useState(inicial);
  const [ruim, setRuim] = useState(false);
  useEffect(() => { setTxt(inicial); setRuim(false); }, [inicial]);
  const fid = `cx-campo-${campo.id}`;
  let controle: ReactNode;
  if (campo.type === 'text') controle = <input id={fid} className="input" value={txt} maxLength={500} onChange={(e) => setTxt(e.target.value)} onBlur={() => { if (txt.trim() !== inicial) salvar(txt.trim() || null); }} />;
  else if (campo.type === 'number') controle = (
    <input id={fid} className="input" inputMode="decimal" value={txt} aria-invalid={ruim} onChange={(e) => { setTxt(e.target.value); setRuim(false); }}
      onBlur={() => { if (txt.trim() === inicial) return; if (!txt.trim()) return salvar(null); const n = lerNumero(txt); if (n === null) setRuim(true); else salvar(n); }} />
  );
  else if (campo.type === 'date') controle = <input id={fid} className="input" type="date" value={typeof valor === 'string' ? valor : ''} onChange={(e) => salvar(e.target.value || null)} />;
  else if (campo.type === 'select') controle = (
    <select id={fid} value={typeof valor === 'string' && campo.options.some((o) => o.id === valor) ? valor : ''} onChange={(e) => salvar(e.target.value || null)}>
      <option value="">{t('tarefa.cartao.semValor')}</option>{campo.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
  else controle = (
    <select id={fid} value={typeof valor === 'string' && membros.some((m) => m.id === valor) ? valor : ''} onChange={(e) => salvar(e.target.value || null)}>
      <option value="">{t('tarefa.cartao.ninguem')}</option>{membros.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
  return <div className="cx__campo"><label htmlFor={fid}>{campo.name}</label>{controle}{ruim && <small className="error" role="alert">{t('tarefa.cartao.numeroInvalido')}</small>}</div>;
}

/** Escolher um arquivo que já está em Documentos: procurar pelo nome ou andar pelas pastas. Nada é enviado de novo. */
function SeletorDeDocumento({ jaTem, onEscolher, onFechar }: { jaTem: Set<string>; onEscolher: (artifactId: string) => void; onFechar: () => void }) {
  const t = useT();
  const [pasta, setPasta] = useState('root');
  const [q, setQ] = useState('');
  type Arq = { id: string; filename: string; path?: string };
  const lista = useResource<{ path: Array<{ id: string; name: string }>; folders: Array<{ id: string; name: string; items: number }>; files: Arq[] }>(q.trim().length < 2 ? `/api/documents?folder=${pasta}` : null, ['artifacts.changed']);
  const busca = useResource<Arq[]>(q.trim().length >= 2 ? `/api/documents/search?q=${encodeURIComponent(q.trim())}` : null, []);
  const arquivos = q.trim().length >= 2 ? busca.data ?? [] : lista.data?.files ?? [];
  const carregando = q.trim().length >= 2 ? !busca.data && !busca.error : !lista.data && !lista.error;
  return (
    <div className="cx__seletor" role="group" aria-label={t('tarefa.cartao.anexos.escolher')}>
      <div className="row">
        <input className="input grow" type="search" value={q} autoFocus placeholder={t('tarefa.cartao.anexos.procurar')} aria-label={t('tarefa.cartao.anexos.procurar')} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn--sm btn--ghost" onClick={onFechar}>{t('tarefa.cartao.fechar')}</button>
      </div>
      {q.trim().length < 2 && lista.data && (
        <nav className="cx__caminho" aria-label={t('tarefa.cartao.anexos.pasta')}>
          <button type="button" className="linkish" onClick={() => setPasta('root')}>{t('tarefa.cartao.anexos.documentos')}</button>
          {lista.data.path.map((p) => <span key={p.id}> › <button type="button" className="linkish" onClick={() => setPasta(p.id)}>{p.name}</button></span>)}
        </nav>
      )}
      <ul className="cx__docs">
        {q.trim().length < 2 && lista.data?.folders.map((f) => (
          <li key={f.id}><button type="button" className="cx__doc" onClick={() => setPasta(f.id)}><Icon name="folder" size={14} /> <span className="cx__docnome">{f.name}</span><span className="muted small">{f.items}</span></button></li>
        ))}
        {arquivos.map((f) => (
          <li key={f.id}><button type="button" className="cx__doc" disabled={jaTem.has(f.id)} onClick={() => onEscolher(f.id)} title={f.path ? `${f.path} / ${f.filename}` : f.filename}>
            <Icon name="file" size={14} /> <span className="cx__docnome">{f.filename}</span>{jaTem.has(f.id) && <span className="muted small">{t('tarefa.cartao.anexos.jaAnexado')}</span>}</button></li>
        ))}
      </ul>
      {carregando && <p className="muted small">{t('tarefa.cartao.carregando')}</p>}
      {(lista.error || busca.error) && <p className="error small" role="alert">{lista.error ?? busca.error}</p>}
      {!carregando && !arquivos.length && !(q.trim().length < 2 && lista.data?.folders.length) && <p className="muted small">{q.trim().length >= 2 ? t('tarefa.cartao.anexos.nadaAchado') : t('tarefa.cartao.anexos.pastaVazia')}</p>}
    </div>
  );
}

export function CartaoExtras({ taskId, modo }: { taskId: string; modo: 'user' | 'mirror' | 'team' }) {
  const t = useT();
  const c = useResource<Cartao>(`/api/tasks/${taskId}/card`, ['tasks.changed']);
  const [err, setErr] = useState<string | null>(null);
  const [novaSub, setNovaSub] = useState('');
  const [editando, setEditando] = useState<{ id: string; title: string } | null>(null);
  const [link, setLink] = useState({ url: '', title: '' });
  const [coment, setComent] = useState('');
  const [escolhendo, setEscolhendo] = useState(false);
  const [pessoasAberto, setPessoasAberto] = useState(false);
  const [vendo, setVendo] = useState<{ id: string; filename: string; mime: string; size: number } | null>(null);
  const fimComent = useRef<HTMLLIElement>(null);
  const fazer = async (f: () => Promise<unknown>): Promise<boolean> => { setErr(null); try { await f(); c.reload(); return true; } catch (e) { setErr(errMsg(e)); return false; } };
  const d = c.data;
  if (!d) return c.error ? <p className="error small" role="alert">{c.error}</p> : null;

  const letras = contarLetras(coment);
  const comentarios = (
    <Recolhe id="coment" titulo={t('tarefa.cartao.comentarios.titulo')} conta={d.comments.length ? String(d.comments.length) : undefined} temAlgo={d.comments.length > 0}>
      {!d.comments.length && <p className="muted small">{t('tarefa.cartao.comentarios.nenhum')}</p>}
      <ul className="cx__coments">
        {d.comments.map((m, i) => (
          <li key={m.id} className="cx__coment" ref={i === d.comments.length - 1 ? fimComent : undefined}>
            <span className={`avatar avatar--sm ${m.authorType === 'agent' ? 'cx__avatar-ia' : ''}`} aria-hidden="true">{iniciais(m.authorName)}</span>
            <div className="cx__coment-corpo">
              <p className="cx__coment-quem"><b>{m.authorName}</b>{m.authorType === 'agent' && <span className="badge" title={t('tarefa.cartao.comentarios.iaDica')}>{t('tarefa.cartao.comentarios.ia')}</span>}
                <time className="muted small" dateTime={m.createdAt} title={fmtDataHora(m.createdAt)}>{haQuantoTempo(m.createdAt)}</time>
                {m.mine && <button type="button" className="icon-btn cx__x" aria-label={t('tarefa.cartao.comentarios.apagar')} title={t('tarefa.cartao.comentarios.apagar')} onClick={() => void fazer(() => api.del(`/api/tasks/${taskId}/comments/${m.id}`))}><Icon name="trash" size={13} /></button>}
              </p>
              <p className="pre cx__coment-txt">{m.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <form className="cx__comentar" onSubmit={(e) => { e.preventDefault(); if (letras && letras <= COMENTARIO_MAX) void fazer(() => api.post(`/api/tasks/${taskId}/comments`, { body: coment })).then((ok) => { if (ok) setComent(''); }); }}>
        <textarea value={coment} rows={2} placeholder={t('tarefa.cartao.comentarios.escreva')} aria-label={t('tarefa.cartao.comentarios.escreva')} aria-describedby={`cx-conta-${taskId}`} aria-invalid={letras > COMENTARIO_MAX}
          onChange={(e) => setComent(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <div className="row">
          <span id={`cx-conta-${taskId}`} className={`cx__conta ${letras > COMENTARIO_MAX ? 'cx__conta--passou' : ''}`} role="status">{t('tarefa.cartao.comentarios.conta', { atual: letras, max: COMENTARIO_MAX })}</span>
          <span className="grow" />
          <button className="btn btn--sm btn--primary" disabled={!letras || letras > COMENTARIO_MAX}>{t('tarefa.cartao.comentarios.comentar')}</button>
        </div>
      </form>
    </Recolhe>
  );
  // card da equipe: só os comentários, e só quando alguém (pessoa ou agente) comentou
  if (modo === 'team') return d.comments.length ? <>{err && <p className="error small" role="alert">{err}</p>}{comentarios}</> : null;

  const etiquetas = d.fields.filter((f) => f.type === 'labels');
  const outros = d.fields.filter((f) => f.type !== 'labels');
  const preenchidos = outros.filter((f) => d.values[f.id] !== undefined && d.values[f.id] !== null).length;
  const feitas = d.subtasks.filter((s) => s.done).length;
  const salvarValor = (f: CampoQuadro, v: ValorCampo) => void fazer(() => api.put(`/api/tasks/${taskId}/fields/${f.id}`, { value: v }));
  const alternarEtiqueta = (f: CampoQuadro, oid: string) => { const atual = Array.isArray(d.values[f.id]) ? d.values[f.id] as string[] : []; salvarValor(f, atual.includes(oid) ? atual.filter((x) => x !== oid) : [...atual, oid]); };
  const alternarPessoa = (uid: string) => { const ids = d.people.map((p) => p.id); void fazer(() => api.put(`/api/tasks/${taskId}/people`, { userIds: ids.includes(uid) ? ids.filter((x) => x !== uid) : [...ids, uid] })); };

  return (
    <div className="cx-wrap">
      {err && <p className="error small" role="alert">{err}</p>}

      {/* o essencial, sempre à vista: etiquetas e pessoas */}
      {etiquetas.map((f) => (
        <div key={f.id} className="cx__linha" role="group" aria-label={f.name}>
          <span className="cx__rotulo">{f.name}</span>
          <div className="cx__tags">
            {f.options.map((o) => { const on = Array.isArray(d.values[f.id]) && (d.values[f.id] as string[]).includes(o.id); return (
              <button key={o.id} type="button" className={`tag tag--${corDaPaleta(o.color)} ${on ? 'is-on' : 'tag--off'}`} aria-pressed={on} onClick={() => alternarEtiqueta(f, o.id)}>{on && <Icon name="check" size={11} />}{o.name}</button>
            ); })}
            {!f.options.length && <span className="muted small">{t('tarefa.cartao.semOpcoes')}</span>}
          </div>
        </div>
      ))}
      <div className="cx__linha" role="group" aria-label={t('tarefa.cartao.pessoas.titulo')}>
        <span className="cx__rotulo">{t('tarefa.cartao.pessoas.titulo')}</span>
        <div className="cx__tags">
          {d.people.map((p) => <span key={p.id} className="who" title={p.name}><span className="avatar avatar--xs" aria-hidden="true">{iniciais(p.name)[0]}</span>{p.name}</span>)}
          {!d.people.length && <span className="muted small">{t('tarefa.cartao.pessoas.ninguem')}</span>}
          <button type="button" className="btn btn--sm btn--ghost" aria-expanded={pessoasAberto} onClick={() => setPessoasAberto((v) => !v)}><Icon name="users" size={13} /> {t('tarefa.cartao.pessoas.atribuir')}</button>
        </div>
      </div>
      {pessoasAberto && (
        <ul className="cx__membros" aria-label={t('tarefa.cartao.pessoas.doWorkspace')}>
          {d.members.map((m) => <li key={m.id}><label className="check"><input type="checkbox" checked={d.people.some((p) => p.id === m.id)} onChange={() => alternarPessoa(m.id)} /> {m.name}</label></li>)}
        </ul>
      )}

      <Recolhe id="sub" titulo={t('tarefa.cartao.subtarefas.titulo')} conta={d.subtasks.length ? `${feitas}/${d.subtasks.length}` : undefined} temAlgo>
        {d.subtasks.length > 0 && <div className="cx__barra" role="progressbar" aria-valuemin={0} aria-valuemax={d.subtasks.length} aria-valuenow={feitas} aria-label={t('tarefa.cartao.subtarefas.progresso', { feitas, total: d.subtasks.length })}><span style={{ width: `${(feitas / d.subtasks.length) * 100}%` }} /></div>}
        <ul className="cx__subs">
          {d.subtasks.map((s) => (
            <li key={s.id} className={s.done ? 'is-done' : ''}>
              <input type="checkbox" checked={s.done} aria-label={t('tarefa.cartao.subtarefas.marcar', { nome: s.title })} onChange={(e) => void fazer(() => api.patch(`/api/subtasks/${s.id}`, { done: e.target.checked }))} />
              {editando?.id === s.id
                ? <input className="input grow" value={editando.title} maxLength={200} autoFocus aria-label={t('tarefa.cartao.subtarefas.renomear')} onChange={(e) => setEditando({ id: s.id, title: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); setEditando(null); } }}
                  onBlur={() => { const v = editando.title.trim(); setEditando(null); if (v && v !== s.title) void fazer(() => api.patch(`/api/subtasks/${s.id}`, { title: v })); }} />
                : <button type="button" className="cx__subnome" title={t('tarefa.cartao.subtarefas.renomear')} onClick={() => setEditando({ id: s.id, title: s.title })}>{s.title}</button>}
              <button type="button" className="icon-btn cx__x" aria-label={t('tarefa.cartao.subtarefas.apagar', { nome: s.title })} title={t('tarefa.cartao.subtarefas.apagar', { nome: s.title })} onClick={() => void fazer(() => api.del(`/api/subtasks/${s.id}`))}><Icon name="x" size={13} /></button>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); const v = novaSub.trim(); if (v) void fazer(() => api.post(`/api/tasks/${taskId}/subtasks`, { title: v })).then((ok) => { if (ok) setNovaSub(''); }); }}>
          <input className="input grow" value={novaSub} maxLength={200} placeholder={t('tarefa.cartao.subtarefas.nova')} aria-label={t('tarefa.cartao.subtarefas.nova')} onChange={(e) => setNovaSub(e.target.value)} />
          <button className="btn btn--sm" disabled={!novaSub.trim()}>{t('tarefa.cartao.adicionar')}</button>
        </form>
      </Recolhe>

      {outros.length > 0 && (
        <Recolhe id="campos" titulo={t('tarefa.cartao.campos.titulo')} conta={`${preenchidos}/${outros.length}`} temAlgo={preenchidos > 0}>
          <div className="cx__campos">{outros.map((f) => <CampoValor key={f.id} campo={f} valor={d.values[f.id]} membros={d.members} salvar={(v) => salvarValor(f, v)} />)}</div>
        </Recolhe>
      )}

      <Recolhe id="links" titulo={t('tarefa.cartao.links.titulo')} conta={d.links.length ? String(d.links.length) : undefined} temAlgo={d.links.length > 0}>
        <ul className="cx__links">
          {d.links.map((l) => { const href = linkSeguro(l.url); return (
            <li key={l.id}>
              <Icon name="globe" size={14} />
              {/* nova aba sem dar à página de lá acesso a esta (noopener) nem dizer de onde veio (noreferrer) */}
              {href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={l.url}>{nomeDoLink(l.url, l.title)}</a> : <span className="muted" title={l.url}>{nomeDoLink(l.url, l.title)}</span>}
              <button type="button" className="icon-btn cx__x" aria-label={t('tarefa.cartao.links.tirar', { nome: nomeDoLink(l.url, l.title) })} title={t('tarefa.cartao.links.tirar', { nome: nomeDoLink(l.url, l.title) })} onClick={() => void fazer(() => api.del(`/api/tasks/${taskId}/links/${l.id}`))}><Icon name="x" size={13} /></button>
            </li>
          ); })}
        </ul>
        <form className="cx__novolink" onSubmit={(e) => { e.preventDefault(); if (link.url.trim()) void fazer(() => api.post(`/api/tasks/${taskId}/links`, { url: link.url.trim(), ...(link.title.trim() ? { title: link.title.trim() } : {}) })).then((ok) => { if (ok) setLink({ url: '', title: '' }); }); }}>
          <input className="input" type="url" inputMode="url" value={link.url} maxLength={2000} placeholder={t('tarefa.cartao.links.endereco')} aria-label={t('tarefa.cartao.links.endereco')} onChange={(e) => setLink({ ...link, url: e.target.value })} />
          <input className="input" value={link.title} maxLength={120} placeholder={t('tarefa.cartao.links.nome')} aria-label={t('tarefa.cartao.links.nome')} onChange={(e) => setLink({ ...link, title: e.target.value })} />
          <button className="btn btn--sm" disabled={!link.url.trim()}>{t('tarefa.cartao.adicionar')}</button>
        </form>
      </Recolhe>

      <Recolhe id="anexos" titulo={t('tarefa.cartao.anexos.titulo')} conta={d.attachments.length ? String(d.attachments.length) : undefined} temAlgo={d.attachments.length > 0}>
        <ul className="cx__links">
          {d.attachments.map((a) => (
            <li key={a.id}>
              <Icon name="file" size={14} />
              {a.available
                ? (previaDe(a.filename, a.mime ?? '') !== 'baixar'
                  ? <button type="button" className="linkish cx__arq" onClick={() => setVendo({ id: a.artifactId, filename: a.filename, mime: a.mime ?? '', size: a.size ?? 0 })}>{a.filename}</button>
                  : <a className="cx__arq" href={`/api/artifacts/${a.artifactId}/download`} download={a.filename}>{a.filename}</a>)
                : <span className="muted cx__arq" title={t('tarefa.cartao.anexos.foraDica')}>{a.filename} <span className="badge">{t('tarefa.cartao.anexos.fora')}</span></span>}
              <button type="button" className="icon-btn cx__x" aria-label={t('tarefa.cartao.anexos.tirar', { nome: a.filename })} title={t('tarefa.cartao.anexos.tirar', { nome: a.filename })} onClick={() => void fazer(() => api.del(`/api/tasks/${taskId}/attachments/${a.id}`))}><Icon name="x" size={13} /></button>
            </li>
          ))}
        </ul>
        {escolhendo
          ? <SeletorDeDocumento jaTem={new Set(d.attachments.map((a) => a.artifactId))} onFechar={() => setEscolhendo(false)} onEscolher={(aid) => void fazer(() => api.post(`/api/tasks/${taskId}/attachments`, { artifactId: aid }))} />
          : <button type="button" className="btn btn--sm" onClick={() => setEscolhendo(true)}><Icon name="clip" size={13} /> {t('tarefa.cartao.anexos.escolher')}</button>}
      </Recolhe>

      {comentarios}
      {vendo && <FileViewer file={vendo} onClose={() => setVendo(null)} />}
    </div>
  );
}

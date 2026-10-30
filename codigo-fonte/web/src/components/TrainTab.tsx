import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Agent, AgentSkill, ArtifactRow, Training, TrainingList, TrainingSources } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const TRAINING_STATUS: Record<Training['status'], { label: string; cls: string }> = {
  executando: { label: 'aprendendo…', cls: 'badge--warn' }, em_revisao: { label: 'aguarda sua revisão', cls: 'badge--warn' },
  falhou: { label: 'falhou', cls: 'badge--err' }, aprovado: { label: 'aprovado', cls: 'badge--ok' }, descartado: { label: 'descartado', cls: '' },
};
const SKILL_STATUS: Record<AgentSkill['status'], { label: string; cls: string }> = {
  ativa: { label: 'ativa', cls: 'badge--ok' }, desativada: { label: 'desativada', cls: 'badge--warn' }, removida: { label: 'removida', cls: 'badge--err' },
};

/**
 * Treinar: a pessoa ensina uma competência ao agente (texto, arquivos, links); o agente estuda só esse material e
 * escreve uma proposta; nada vale até a pessoa revisar e aprovar. Aprovada, é só deste agente, com versões.
 */
export function TrainTab({ agent }: { agent: Agent }) {
  const d = useResource<TrainingList>(`/api/agents/${agent.id}/trainings`, ['agents.changed']);
  const running = d.data?.trainings.some((t) => t.status === 'executando') ?? false;
  useEffect(() => { // os avisos ao vivo já atualizam; a consulta periódica é a rede de segurança enquanto aprende
    if (!running) return;
    const t = window.setInterval(d.reload, 4000);
    return () => clearInterval(t);
  }, [running, d.reload]);
  const [target, setTarget] = useState<string>(''); // '' = competência nova
  const [seen, setSeen] = useState<string[]>([]); // falhas que a pessoa já leu (somem do topo; ficam no histórico)
  const formRef = useRef<HTMLDivElement>(null);
  if (!d.data) return <Loading error={d.error} />;
  const { skills, trainings } = d.data;
  // a última tentativa que falhou fica à vista até a pessoa dar ciência: falha escondida pareceria sucesso
  const lastFailed = trainings[0]?.status === 'falhou' && !seen.includes(trainings[0].id) ? trainings[0] : null;
  const review = [...trainings.filter((t) => t.status === 'em_revisao' || t.status === 'executando'), ...(lastFailed ? [lastFailed] : [])];
  const history = trainings.filter((t) => !review.includes(t)).slice(0, 8);
  const teachMore = (id: string) => { setTarget(id); formRef.current?.closest('.awin__body')?.scrollTo({ top: 0, behavior: 'smooth' }); };
  return (
    <div className="train">
      <p className="hint">Ensine {agent.name} com um texto, arquivos ou links. Ele estuda só o material que você der e escreve uma proposta de competência; nada muda até você revisar e aprovar. A competência aprovada é só dele e vale nas próximas conversas e tarefas.</p>
      <div ref={formRef}><TrainForm agent={agent} skills={skills} target={target} setTarget={setTarget} onStarted={d.reload} /></div>
      {review.length > 0 && <div className="block"><h4>Treinamentos</h4>{review.map((t) => <TrainingCard key={t.id} t={t} skills={skills} reload={d.reload} onSeen={() => setSeen([...seen, t.id])} />)}</div>}
      <div className="block">
        <h4>Competências aprendidas {skills.length ? <span className="muted small">({skills.filter((s) => s.status === 'ativa').length} ativa{skills.filter((s) => s.status === 'ativa').length === 1 ? '' : 's'})</span> : null}</h4>
        {skills.length ? skills.map((s) => <SkillCard key={s.id} s={s} reload={d.reload} onTeachMore={() => teachMore(s.id)} />)
          : <p className="hint">Nenhuma ainda. A primeira aparece aqui depois que você aprovar um treinamento.</p>}
      </div>
      {history.length > 0 && (
        <details className="block">
          <summary className="muted">Histórico de treinamentos ({history.length})</summary>
          <ul className="plain train__hist">{history.map((t) => (
            <li key={t.id}><span className={`badge ${TRAINING_STATUS[t.status].cls}`}>{TRAINING_STATUS[t.status].label}</span> <b>{t.title}</b> <span className="muted small">{when(t.decidedAt ?? t.createdAt)}</span>
              {t.error && <div className="small error-inline">{t.error}</div>}</li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

function TrainForm({ agent, skills, target, setTarget, onStarted }: { agent: Agent; skills: AgentSkill[]; target: string; setTarget: (id: string) => void; onStarted: () => void }) {
  const [request, setRequest] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { // o aviso de "começou" sai sozinho; o andamento fica no cartão do treinamento
    if (!msg?.ok) return;
    const t = window.setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);
  const updatable = skills.filter((s) => s.status !== 'removida');
  const current = updatable.find((s) => s.id === target) ?? null;
  const addLink = () => {
    const v = link.trim();
    if (!v) return;
    if (!/^https?:\/\/[^\s]+$/i.test(v)) { setMsg({ ok: false, text: 'Use um endereço completo, começando com https://' }); return; }
    if (!links.includes(v)) setLinks([...links, v]);
    setLink(''); setMsg(null);
  };
  const train = async () => {
    setBusy(true); setMsg(null);
    try {
      const t = await api.post<Training>(`/api/agents/${agent.id}/trainings`, {
        request: request.trim(), ...(current ? { skillId: current.id } : title.trim() ? { title: title.trim() } : {}),
        fileIds: files.map((f) => f.id), links,
      });
      if (t.status === 'falhou') setMsg({ ok: false, text: t.error ?? 'O treinamento não começou.' });
      else { setMsg({ ok: true, text: `${agent.name} começou a estudar. Acompanhe em "Treinamentos", logo abaixo: a proposta aparece lá para você revisar.` }); setRequest(''); setTitle(''); setFiles([]); setLinks([]); setTarget(''); }
      onStarted();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const ready = request.trim().length > 0 || files.length > 0 || links.length > 0;
  return (
    <div className="train__form">
      <div className="editor__grid">
        <label className="field">Competência
          <select value={current?.id ?? ''} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Nova competência</option>
            {updatable.map((s) => <option key={s.id} value={s.id}>Atualizar: {s.title} (versão {s.version})</option>)}
          </select>
        </label>
        {current ? <p className="hint">Atualiza "{current.title}" sem criar outra; a versão {current.version} fica guardada e pode ser restaurada.</p> : (
          <label className="field">Nome (opcional)<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="ex.: Capa de proposta da empresa" /></label>
        )}
      </div>
      <label className="field">O que deseja ensinar?
        <textarea rows={4} value={request} onChange={(e) => setRequest(e.target.value)}
          placeholder="ex.: Aprenda a montar a capa das nossas propostas: logo à esquerda, título em azul-carvão, data no rodapé. Use o modelo anexo." />
      </label>
      <div className="editor__grid">
        <div className="field">Arquivos <span className="muted small">({files.length})</span>
          <FilePick value={files} onChange={setFiles} />
        </div>
        <div className="field">Links <span className="muted small">({links.length})</span>
          {links.length > 0 && <ul className="rt-files__sel">{links.map((l) => <li key={l}><Icon name="compass" size={12} /> <span className="train__url">{l}</span>
            <button className="icon-btn" aria-label={`Tirar ${l}`} onClick={() => setLinks(links.filter((x) => x !== l))}><Icon name="x" size={12} /></button></li>)}</ul>}
          <div className="row">
              <input className="rt-files__q" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" aria-label="Novo link"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }} />
              <button type="button" className="btn btn--sm" onClick={addLink} disabled={!link.trim()}>Adicionar</button>
          </div>
          <span className="hint">Só estas páginas são abertas — nada de busca na web nem outros sites.</span>
        </div>
      </div>
      <div className="row">
        <button className="btn btn--primary" onClick={train} disabled={busy || !ready}><Icon name="book" size={14} /> {busy ? 'Preparando…' : 'Treinar'}</button>
        <span className="hint">Durante o treino o agente só lê o material escolhido e escreve a proposta: sem terminal, sem outros arquivos do computador.</span>
      </div>
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </div>
  );
}

/** Arquivos do Ergon (procurados pelo nome) ou um novo, enviado agora. */
function FilePick({ value, onChange }: { value: Array<{ id: string; name: string }>; onChange: (v: Array<{ id: string; name: string }>) => void }) {
  const mine = useResource<ArtifactRow[]>('/api/artifacts', ['artifacts.changed']);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const add = (f: { id: string; name: string }) => { if (!value.some((v) => v.id === f.id)) onChange([...value, f]); };
  const local = (mine.data ?? []).filter((a) => !value.some((v) => v.id === a.id) && (!q.trim() || a.filename.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 6);
  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try { const a = await api.upload<{ id: string; filename: string }>(file); add({ id: a.id, name: a.filename }); mine.reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="rt-files">
      {value.length > 0 && <ul className="rt-files__sel">{value.map((f) => <li key={f.id}><Icon name="folder" size={12} /> {f.name}
        <button className="icon-btn" aria-label={`Tirar ${f.name}`} onClick={() => onChange(value.filter((v) => v.id !== f.id))}><Icon name="x" size={12} /></button></li>)}</ul>}
      <>
          <div className="row">
            <input className="rt-files__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar nos arquivos do Ergon" aria-label="Procurar arquivo" />
            <label className="btn btn--sm">{busy ? 'Enviando…' : 'Enviar arquivo'}<input type="file" hidden disabled={busy} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          {local.length > 0 && <ul className="rt-files__list">{local.map((a) => <li key={a.id}><button type="button" className="linkish" onClick={() => add({ id: a.id, name: a.filename })}>+ {a.filename}</button> <span className="muted small">{when(a.created_at)}</span></li>)}</ul>}
          <span className="hint">Word, PDF com texto, Excel, PowerPoint, CSV e texto. O que não der para ler aparece na revisão.</span>
      </>
      {msg && <p className="hint warn">{msg}</p>}
    </div>
  );
}

const FILE_STATUS: Record<TrainingSources['files'][number]['status'], string> = { lido: 'lido', sem_texto: 'sem texto', nao_suportado: 'formato não lido', erro: 'não lido' };

function Sources({ s }: { s: TrainingSources }) {
  if (!s.files.length && !s.links.length) return <p className="muted small">Só o texto do pedido.</p>;
  return (
    <ul className="plain train__src">
      {s.files.map((f) => <li key={f.id}><Icon name="folder" size={12} /> {f.name} <span className={`badge ${f.status === 'lido' ? 'badge--ok' : 'badge--warn'}`}>{FILE_STATUS[f.status] ?? f.status}</span>{f.detail && <span className="muted small"> {f.detail}</span>}</li>)}
      {s.links.map((l) => <li key={l.url}><Icon name="compass" size={12} /> <span className="train__url">{l.url}</span> <span className={`badge ${l.status === 'lido' ? 'badge--ok' : l.status === 'falhou' ? 'badge--err' : 'badge--warn'}`}>{l.status === 'pendente' ? 'não aberto' : l.status}</span>{l.detail && <span className="muted small"> {l.detail}</span>}</li>)}
    </ul>
  );
}

/** o cabeçalho técnico do arquivo principal (nome interno, versão, marcas do motor) não interessa a quem revisa */
const body = (name: string, text: string) => (name === 'SKILL.md' ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart() : text);

function Files({ files }: { files: Record<string, string> }) {
  const names = Object.keys(files).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  return <>{names.map((n, i) => (
    <details key={n} open={i === 0}>
      <summary className="muted small">{n === 'SKILL.md' ? 'Conteúdo principal' : n}</summary>
      <pre className="pre train__pre">{body(n, files[n])}</pre>
    </details>
  ))}</>;
}

function TrainingCard({ t, skills, reload, onSeen }: { t: Training; skills: AgentSkill[]; reload: () => void; onSeen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const updating = t.skillId ? skills.find((s) => s.id === t.skillId) : null;
  const decide = async (decision: 'aprovar' | 'descartar') => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/trainings/${t.id}/decision`, { decision }); reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const st = TRAINING_STATUS[t.status];
  return (
    <div className="train__card">
      <div className="row"><b>{t.title}</b> <span className={`badge ${st.cls}`}>{st.label}</span><span className="grow" /><span className="muted small">{when(t.createdAt)}</span></div>
      {updating && <p className="hint">Atualiza "{updating.title}" (versão {updating.version} → {updating.version + 1}).</p>}
      {t.status === 'executando' ? <p className="hint">Estudando o material e escrevendo a proposta. Pode fechar a janela: a proposta fica aqui.</p> : t.status === 'falhou' ? (
        <>
          <p className="error">{t.error ?? 'O treinamento falhou.'}{/Nada foi/.test(t.error ?? '') ? '' : ' Nada foi gravado.'}</p>
          <h5>Fontes</h5><Sources s={t.sources} />
          <div className="row"><button className="btn btn--sm" onClick={onSeen}>Entendi</button><span className="hint">Fica no histórico. Ajuste o pedido ou o material e treine de novo.</span></div>
        </>
      ) : (
        <>
          {t.summary && <div className="train__sum">{t.summary}</div>}
          <h5>Fontes</h5><Sources s={t.sources} />
          {t.problems.length > 0 && <><h5>Limitações</h5><ul className="plain">{t.problems.map((p) => <li key={p} className="small warn">{p}</li>)}</ul></>}
          <h5>Conteúdo proposto <span className="muted small">— identificador {t.skillName}</span></h5>
          {t.draft ? <Files files={t.draft} /> : <p className="muted small">Sem conteúdo.</p>}
          {updating && <details><summary className="muted small">Comparar com a versão atual ({updating.version})</summary><Files files={updating.files} /></details>}
          <div className="row">
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void decide('aprovar')}><Icon name="check" size={13} /> Aprovar e ativar</button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void decide('descartar')}>Descartar</button>
            <span className="hint">Aprovar grava a competência só para este agente{updating ? ' e guarda a versão anterior' : ''}.</span>
          </div>
        </>
      )}
      {msg && <p className="error" role="status">{msg}</p>}
    </div>
  );
}

function SkillCard({ s, reload, onTeachMore }: { s: AgentSkill; reload: () => void; onTeachMore: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const older = s.versions.filter((v) => v.version !== s.version || s.status === 'removida');
  const [picked, setVer] = useState<number>(0);
  const ver = older.some((v) => v.version === picked) ? picked : older[0]?.version ?? 0; // a lista muda a cada versão nova
  const act = async (action: 'desativar' | 'ativar' | 'remover' | 'restaurar', version?: number) => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/agent-skills/${s.id}`, { action, ...(version ? { version } : {}) }); setConfirmRemove(false); reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const st = SKILL_STATUS[s.status];
  return (
    <div className={`train__card ${s.status !== 'ativa' ? 'train__card--off' : ''}`}>
      <div className="row"><b>{s.title}</b> <span className={`badge ${st.cls}`}>{st.label}</span> <span className="muted small">versão {s.version} · {when(s.updatedAt)}</span></div>
      {s.description && <p className="small">{s.description}</p>}
      <p className="muted small" title="Conta quando o agente carrega esta competência numa conversa ou tarefa">
        {s.uses ? `Usada ${s.uses} ${s.uses === 1 ? 'vez' : 'vezes'} · última em ${when(s.lastUsedAt)}` : 'Ainda não usada numa conversa ou tarefa.'}
      </p>
      <details>
        <summary className="muted small">Ver conteúdo e fontes</summary>
        {s.versions[0] && <><h5>Fontes da versão {s.versions[0].version}</h5><Sources s={s.versions[0].sources} /></>}
        <Files files={s.files} />
      </details>
      <div className="row row--wrap">
        {s.status !== 'removida' && <button className="btn btn--sm" disabled={busy} onClick={onTeachMore}><Icon name="book" size={13} /> Ensinar mais</button>}
        {s.status === 'ativa' && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void act('desativar')}>Desativar</button>}
        {s.status === 'desativada' && <button className="btn btn--sm" disabled={busy} onClick={() => void act('ativar')}>Ativar</button>}
        {s.status !== 'removida' && (confirmRemove ? (
          <span className="confirm">Remover tira a competência do agente. O histórico de versões fica guardado e pode ser restaurado.
            <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void act('remover')}>Remover</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmRemove(false)}>Cancelar</button></span>
        ) : <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setConfirmRemove(true)}><Icon name="trash" size={13} /> Remover</button>)}
        {older.length > 0 && (
          <span className="row">
            <select value={ver} onChange={(e) => setVer(Number(e.target.value))} aria-label="Versão para restaurar">
              {older.map((v) => <option key={v.version} value={v.version}>versão {v.version} · {when(v.createdAt)}</option>)}
            </select>
            <button className="btn btn--sm" disabled={busy || !ver} onClick={() => void act('restaurar', ver)}><Icon name="repeat" size={13} /> Restaurar</button>
          </span>
        )}
      </div>
      {msg && <p className="error" role="status">{msg}</p>}
    </div>
  );
}

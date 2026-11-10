import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Agent, AgentSkill, ArtifactRow, Training, TrainingList, TrainingSources } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';
import { fmtDataHora, useT, type Chave, type ValoresDe } from '../i18n/index.ts';
/** chave de texto sem valores a preencher (os rótulos das tabelas abaixo) */
type Rotulo = { [K in Chave]: keyof ValoresDe<K> extends never ? K : never }[Chave];

const when = (iso: string | null) => (iso ? fmtDataHora(iso) : '—');
const TRAINING_STATUS: Record<Training['status'], { rotulo: Rotulo; cls: string }> = {
  executando: { rotulo: 'agente.treino.status.executando', cls: 'badge--warn' }, em_revisao: { rotulo: 'agente.treino.status.emRevisao', cls: 'badge--warn' },
  falhou: { rotulo: 'agente.treino.status.falhou', cls: 'badge--err' }, aprovado: { rotulo: 'agente.treino.status.aprovado', cls: 'badge--ok' },
  descartado: { rotulo: 'agente.treino.status.descartado', cls: '' },
};
const SKILL_STATUS: Record<AgentSkill['status'], { rotulo: Rotulo; cls: string }> = {
  ativa: { rotulo: 'agente.treino.competencia.ativa', cls: 'badge--ok' }, desativada: { rotulo: 'agente.treino.competencia.desativada', cls: 'badge--warn' },
  removida: { rotulo: 'agente.treino.competencia.removida', cls: 'badge--err' },
};

/**
 * Treinar: a pessoa ensina uma competência ao agente (texto, arquivos, links); o agente estuda só esse material e
 * escreve uma proposta; nada vale até a pessoa revisar e aprovar. Aprovada, é só deste agente, com versões.
 */
export function TrainTab({ agent }: { agent: Pick<Agent, 'id' | 'name'> }) {
  const t = useT();
  const d = useResource<TrainingList>(`/api/agents/${agent.id}/trainings`, ['agents.changed']);
  const running = d.data?.trainings.some((x) => x.status === 'executando') ?? false;
  useEffect(() => { // os avisos ao vivo já atualizam; a consulta periódica é a rede de segurança enquanto aprende
    if (!running) return;
    const timer = window.setInterval(d.reload, 4000);
    return () => clearInterval(timer);
  }, [running, d.reload]);
  const [target, setTarget] = useState<string>(''); // '' = competência nova
  const [seen, setSeen] = useState<string[]>([]); // falhas que a pessoa já leu (somem do topo; ficam no histórico)
  const formRef = useRef<HTMLDivElement>(null);
  if (!d.data) return <Loading error={d.error} />;
  const { skills, trainings } = d.data;
  // a última tentativa que falhou fica à vista até a pessoa dar ciência: falha escondida pareceria sucesso
  const lastFailed = trainings[0]?.status === 'falhou' && !seen.includes(trainings[0].id) ? trainings[0] : null;
  const review = [...trainings.filter((x) => x.status === 'em_revisao' || x.status === 'executando'), ...(lastFailed ? [lastFailed] : [])];
  const history = trainings.filter((x) => !review.includes(x)).slice(0, 8);
  const ativas = skills.filter((s) => s.status === 'ativa').length;
  const teachMore = (id: string) => { setTarget(id); formRef.current?.closest('.awin__body')?.scrollTo({ top: 0, behavior: 'smooth' }); };
  return (
    <div className="train">
      <p className="hint">{t('agente.treino.intro', { nome: agent.name })}</p>
      <div ref={formRef}><TrainForm agent={agent} skills={skills} target={target} setTarget={setTarget} onStarted={d.reload} /></div>
      {review.length > 0 && <div className="block"><h4>{t('agente.treino.treinamentos')}</h4>{review.map((x) => <TrainingCard key={x.id} t={x} skills={skills} reload={d.reload} onSeen={() => setSeen([...seen, x.id])} />)}</div>}
      <div className="block">
        <h4>{t('agente.treino.aprendidas')} {skills.length ? <span className="muted small">{t('agente.treino.ativas', { n: ativas })}</span> : null}</h4>
        {skills.length ? skills.map((s) => <SkillCard key={s.id} s={s} reload={d.reload} onTeachMore={() => teachMore(s.id)} />)
          : <p className="hint">{t('agente.treino.nenhuma')}</p>}
      </div>
      {history.length > 0 && (
        <details className="block">
          <summary className="muted">{t('agente.treino.historico', { n: history.length })}</summary>
          <ul className="plain train__hist">{history.map((x) => (
            <li key={x.id}><span className={`badge ${TRAINING_STATUS[x.status].cls}`}>{t(TRAINING_STATUS[x.status].rotulo)}</span> <b>{x.title}</b> <span className="muted small">{when(x.decidedAt ?? x.createdAt)}</span>
              {x.error && <div className="small error-inline">{x.error}</div>}</li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

function TrainForm({ agent, skills, target, setTarget, onStarted }: { agent: Pick<Agent, 'id' | 'name'>; skills: AgentSkill[]; target: string; setTarget: (id: string) => void; onStarted: () => void }) {
  const t = useT();
  const [request, setRequest] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { // o aviso de "começou" sai sozinho; o andamento fica no cartão do treinamento
    if (!msg?.ok) return;
    const timer = window.setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(timer);
  }, [msg]);
  const updatable = skills.filter((s) => s.status !== 'removida');
  const current = updatable.find((s) => s.id === target) ?? null;
  const addLink = () => {
    const v = link.trim();
    if (!v) return;
    if (!/^https?:\/\/[^\s]+$/i.test(v)) { setMsg({ ok: false, text: t('agente.treino.linkInvalido') }); return; }
    if (!links.includes(v)) setLinks([...links, v]);
    setLink(''); setMsg(null);
  };
  const train = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<Training>(`/api/agents/${agent.id}/trainings`, {
        request: request.trim(), ...(current ? { skillId: current.id } : title.trim() ? { title: title.trim() } : {}),
        fileIds: files.map((f) => f.id), links,
      });
      if (r.status === 'falhou') setMsg({ ok: false, text: r.error ?? t('agente.treino.naoComecou') });
      else { setMsg({ ok: true, text: t('agente.treino.comecou', { nome: agent.name }) }); setRequest(''); setTitle(''); setFiles([]); setLinks([]); setTarget(''); }
      onStarted();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const ready = request.trim().length > 0 || files.length > 0 || links.length > 0;
  return (
    <div className="train__form">
      <div className="editor__grid">
        <label className="field">{t('agente.treino.competencia')}
          <select value={current?.id ?? ''} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t('agente.treino.nova')}</option>
            {updatable.map((s) => <option key={s.id} value={s.id}>{t('agente.treino.atualizarOpcao', { titulo: s.title, versao: s.version })}</option>)}
          </select>
        </label>
        {current ? <p className="hint">{t('agente.treino.atualizaDica', { titulo: current.title, versao: current.version })}</p> : (
          <label className="field">{t('agente.treino.nomeOpcional')}<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={t('agente.treino.nomeExemplo')} /></label>
        )}
      </div>
      <label className="field">{t('agente.treino.oQueEnsinar')}
        <textarea rows={4} value={request} onChange={(e) => setRequest(e.target.value)}
          placeholder={t('agente.treino.pedidoExemplo')} />
      </label>
      <div className="editor__grid">
        <div className="field">{t('agente.treino.arquivos')} <span className="muted small">({files.length})</span>
          <FilePick value={files} onChange={setFiles} />
        </div>
        <div className="field">{t('agente.treino.links')} <span className="muted small">({links.length})</span>
          {links.length > 0 && <ul className="rt-files__sel">{links.map((l) => <li key={l}><Icon name="compass" size={12} /> <span className="train__url">{l}</span>
            <button className="icon-btn" aria-label={t('agente.tirar', { nome: l })} onClick={() => setLinks(links.filter((x) => x !== l))}><Icon name="x" size={12} /></button></li>)}</ul>}
          <div className="row">
              <input className="rt-files__q" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" aria-label={t('agente.treino.novoLink')}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }} />
              <button type="button" className="btn btn--sm" onClick={addLink} disabled={!link.trim()}>{t('agente.treino.adicionar')}</button>
          </div>
          <span className="hint">{t('agente.treino.soEstasPaginas')}</span>
        </div>
      </div>
      <div className="row">
        <button className="btn btn--primary" onClick={train} disabled={busy || !ready}><Icon name="book" size={14} /> {t(busy ? 'agente.treino.preparando' : 'agente.treinar')}</button>
        <span className="hint">{t('agente.treino.seguranca')}</span>
      </div>
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </div>
  );
}

/** Arquivos do Ergon (procurados pelo nome) ou um novo, enviado agora. */
function FilePick({ value, onChange }: { value: Array<{ id: string; name: string }>; onChange: (v: Array<{ id: string; name: string }>) => void }) {
  const t = useT();
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
        <button className="icon-btn" aria-label={t('agente.tirar', { nome: f.name })} onClick={() => onChange(value.filter((v) => v.id !== f.id))}><Icon name="x" size={12} /></button></li>)}</ul>}
      <>
          <div className="row">
            <input className="rt-files__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('agente.treino.procurarExemplo')} aria-label={t('agente.treino.procurarArquivo')} />
            <label className="btn btn--sm">{t(busy ? 'agente.treino.enviando' : 'agente.treino.enviarArquivo')}<input type="file" hidden disabled={busy} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          {local.length > 0 && <ul className="rt-files__list">{local.map((a) => <li key={a.id}><button type="button" className="linkish" onClick={() => add({ id: a.id, name: a.filename })}>+ {a.filename}</button> <span className="muted small">{when(a.created_at)}</span></li>)}</ul>}
          <span className="hint">{t('agente.treino.formatos')}</span>
      </>
      {msg && <p className="hint warn">{msg}</p>}
    </div>
  );
}

const FILE_STATUS: Record<TrainingSources['files'][number]['status'], Rotulo> = {
  lido: 'agente.treino.fonte.lido', sem_texto: 'agente.treino.fonte.semTexto', nao_suportado: 'agente.treino.fonte.naoSuportado', erro: 'agente.treino.fonte.erro',
};
const LINK_STATUS: Record<TrainingSources['links'][number]['status'], Rotulo> = {
  pendente: 'agente.treino.fonte.naoAberto', lido: 'agente.treino.fonte.lido', falhou: 'agente.treino.fonte.falhou',
};

function Sources({ s }: { s: TrainingSources }) {
  const t = useT();
  if (!s.files.length && !s.links.length) return <p className="muted small">{t('agente.treino.soTexto')}</p>;
  return (
    <ul className="plain train__src">
      {s.files.map((f) => <li key={f.id}><Icon name="folder" size={12} /> {f.name} <span className={`badge ${f.status === 'lido' ? 'badge--ok' : 'badge--warn'}`}>{FILE_STATUS[f.status] ? t(FILE_STATUS[f.status]) : f.status}</span>{f.detail && <span className="muted small"> {f.detail}</span>}</li>)}
      {s.links.map((l) => <li key={l.url}><Icon name="compass" size={12} /> <span className="train__url">{l.url}</span> <span className={`badge ${l.status === 'lido' ? 'badge--ok' : l.status === 'falhou' ? 'badge--err' : 'badge--warn'}`}>{LINK_STATUS[l.status] ? t(LINK_STATUS[l.status]) : l.status}</span>{l.detail && <span className="muted small"> {l.detail}</span>}</li>)}
    </ul>
  );
}

/** o cabeçalho técnico do arquivo principal (nome interno, versão, marcas do motor) não interessa a quem revisa */
const body = (name: string, text: string) => (name === 'SKILL.md' ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart() : text);

function Files({ files }: { files: Record<string, string> }) {
  const t = useT();
  const names = Object.keys(files).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  return <>{names.map((n, i) => (
    <details key={n} open={i === 0}>
      <summary className="muted small">{n === 'SKILL.md' ? t('agente.treino.conteudoPrincipal') : n}</summary>
      <pre className="pre train__pre">{body(n, files[n])}</pre>
    </details>
  ))}</>;
}

function TrainingCard({ t: tr, skills, reload, onSeen }: { t: Training; skills: AgentSkill[]; reload: () => void; onSeen: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const updating = tr.skillId ? skills.find((s) => s.id === tr.skillId) : null;
  const decide = async (decision: 'aprovar' | 'descartar') => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/trainings/${tr.id}/decision`, { decision }); reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const st = TRAINING_STATUS[tr.status];
  // o servidor já diz "Nada foi gravado" em algumas falhas: a tela não repete
  const jaDisse = /Nada foi/.test(tr.error ?? ''); // i18n-ok: reconhece o português que o servidor manda
  return (
    <div className="train__card">
      <div className="row"><b>{tr.title}</b> <span className={`badge ${st.cls}`}>{t(st.rotulo)}</span><span className="grow" /><span className="muted small">{when(tr.createdAt)}</span></div>
      {updating && <p className="hint">{t('agente.treino.atualizaVersao', { titulo: updating.title, de: updating.version, para: updating.version + 1 })}</p>}
      {tr.status === 'executando' ? <p className="hint">{t('agente.treino.estudando')}</p> : tr.status === 'falhou' ? (
        <>
          <p className="error">{tr.error ?? t('agente.treino.falhouGeral')}{jaDisse ? '' : ` ${t('agente.treino.nadaGravado')}`}</p>
          <h5>{t('agente.treino.fontes')}</h5><Sources s={tr.sources} />
          <div className="row"><button className="btn btn--sm" onClick={onSeen}>{t('agente.treino.entendi')}</button><span className="hint">{t('agente.treino.ficaHistorico')}</span></div>
        </>
      ) : (
        <>
          {tr.summary && <div className="train__sum">{tr.summary}</div>}
          <h5>{t('agente.treino.fontes')}</h5><Sources s={tr.sources} />
          {tr.problems.length > 0 && <><h5>{t('agente.treino.limitacoes')}</h5><ul className="plain">{tr.problems.map((p) => <li key={p} className="small warn">{p}</li>)}</ul></>}
          <h5>{t('agente.treino.conteudoProposto')} <span className="muted small">{t('agente.treino.identificador', { nome: tr.skillName })}</span></h5>
          {tr.draft ? <Files files={tr.draft} /> : <p className="muted small">{t('agente.treino.semConteudo')}</p>}
          {updating && <details><summary className="muted small">{t('agente.treino.comparar', { versao: updating.version })}</summary><Files files={updating.files} /></details>}
          <div className="row">
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void decide('aprovar')}><Icon name="check" size={13} /> {t('agente.treino.aprovar')}</button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void decide('descartar')}>{t('agente.treino.descartar')}</button>
            <span className="hint">{t(updating ? 'agente.treino.aprovarDicaVersao' : 'agente.treino.aprovarDica')}</span>
          </div>
        </>
      )}
      {msg && <p className="error" role="status">{msg}</p>}
    </div>
  );
}

function SkillCard({ s, reload, onTeachMore }: { s: AgentSkill; reload: () => void; onTeachMore: () => void }) {
  const t = useT();
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
      <div className="row"><b>{s.title}</b> <span className={`badge ${st.cls}`}>{t(st.rotulo)}</span> <span className="muted small">{t('agente.treino.versaoData', { versao: s.version, quando: when(s.updatedAt) })}</span></div>
      {s.description && <p className="small">{s.description}</p>}
      <p className="muted small" title={t('agente.treino.usosDica')}>
        {s.uses ? t('agente.treino.usos', { n: s.uses, quando: when(s.lastUsedAt) }) : t('agente.treino.naoUsada')}
      </p>
      <details>
        <summary className="muted small">{t('agente.treino.verConteudo')}</summary>
        {s.versions[0] && <><h5>{t('agente.treino.fontesVersao', { versao: s.versions[0].version })}</h5><Sources s={s.versions[0].sources} /></>}
        <Files files={s.files} />
      </details>
      <div className="row row--wrap">
        {s.status !== 'removida' && <button className="btn btn--sm" disabled={busy} onClick={onTeachMore}><Icon name="book" size={13} /> {t('agente.treino.ensinarMais')}</button>}
        {s.status === 'ativa' && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void act('desativar')}>{t('agente.desativar')}</button>}
        {s.status === 'desativada' && <button className="btn btn--sm" disabled={busy} onClick={() => void act('ativar')}>{t('agente.treino.ativar')}</button>}
        {s.status !== 'removida' && (confirmRemove ? (
          <span className="confirm">{t('agente.treino.confirmarRemover')}
            <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void act('remover')}>{t('agente.treino.remover')}</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmRemove(false)}>{t('agente.cancelar')}</button></span>
        ) : <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setConfirmRemove(true)}><Icon name="trash" size={13} /> {t('agente.treino.remover')}</button>)}
        {older.length > 0 && (
          <span className="row">
            <select value={ver} onChange={(e) => setVer(Number(e.target.value))} aria-label={t('agente.treino.versaoRestaurar')}>
              {older.map((v) => <option key={v.version} value={v.version}>{t('agente.treino.versaoData', { versao: v.version, quando: when(v.createdAt) })}</option>)}
            </select>
            <button className="btn btn--sm" disabled={busy || !ver} onClick={() => void act('restaurar', ver)}><Icon name="repeat" size={13} /> {t('agente.treino.restaurar')}</button>
          </span>
        )}
      </div>
      {msg && <p className="error" role="status">{msg}</p>}
    </div>
  );
}

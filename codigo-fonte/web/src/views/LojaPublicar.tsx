import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Skill } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from '../components/Icon.tsx';
import { Fig } from '../arte/Cena.tsx';
import { PreviaPacote, tipoDe, type CatalogPreview, type PreviewAgent } from './PacotesPanel.tsx';
import { fmtData, useT, type Chave, type ValoresDe } from '../i18n/index.ts';

type Rotulo = { [K in Chave]: keyof ValoresDe<K> extends never ? K : never }[Chave];

type FonteP = 'arquivo' | 'equipe' | 'competencia';
/** o que volta para o formulário ao pedir uma versão nova de uma publicação */
export interface Rascunho { nome: string; titulo: string; resumo: string; versao: string; fonte: FonteP }
interface WorldStatus { configured: boolean; link: object | null }
interface Pub { id: string; packageId: string; kind: string; title: string; summary: string; status: string; latestVersion: string | null; versions: Array<{ version: string; status: string; verified: boolean; createdAt: string; reason?: string }> }
interface Minhas { disponivel: boolean; creator: { namespace: string; displayName: string } | null; items: Pub[] }
interface Previa { packageId: string; kind: string; title: string; summary: string; version: string; preview?: CatalogPreview; competencia?: { nome: string; texto: string } }

const FONTES: Array<{ k: FonteP; icon: string; titulo: Rotulo; texto: Rotulo }> = [
  { k: 'arquivo', icon: 'palette', titulo: 'documentos.loja.pub.fonte.arquivo', texto: 'documentos.loja.pub.fonte.arquivoTexto' },
  { k: 'equipe', icon: 'users', titulo: 'documentos.loja.pub.fonte.equipe', texto: 'documentos.loja.pub.fonte.equipeTexto' },
  { k: 'competencia', icon: 'book', titulo: 'documentos.loja.pub.fonte.competencia', texto: 'documentos.loja.pub.fonte.competenciaTexto' },
];
const ESTADO: Record<string, Rotulo> = {
  draft: 'documentos.loja.estado.rascunho', in_review: 'documentos.loja.estado.revisao', published: 'documentos.loja.estado.publicado', rejected: 'documentos.loja.estado.recusado',
  suspended: 'documentos.loja.estado.suspenso', withdrawn: 'documentos.loja.estado.retirado', approved: 'documentos.loja.estado.aprovada', pending: 'documentos.loja.estado.esperando',
};
const proxima = (v: string | null | undefined) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? ''); return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0'; };
const lerBase64 = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(r.error); r.readAsDataURL(f); });

/** A conta do Ergon World para publicar (grátis): sem ela, um convite; sem o World nesta instalação, uma linha. */
function useConta() {
  const st = useResource<WorldStatus>('/api/world/status', ['world.changed']);
  const ligado = !!st.data?.configured && !!st.data.link;
  const minhas = useResource<Minhas>(ligado ? '/api/loja/minhas' : null, []);
  return { st, ligado, minhas };
}
function SemConta({ st }: { st: { data?: WorldStatus | null; error?: string | null } }) {
  const t = useT();
  if (!st.data) return st.error ? <p className="hint">{t('documentos.loja.pub.semWorld')}</p> : <Loading />;
  if (!st.data.configured) return <p className="hint">{t('documentos.loja.pub.semWorld')}</p>;
  return (
    <div className="cena-vazio">
      <div className="cena-vazio__figs"><Fig k="fidias" gesture="offer" scale={3} /><Fig k="aspasia" gesture="talk" scale={3} /></div>
      <p>{t('documentos.loja.pub.entrarTexto')}</p>
      {/* o pedido pede a conta: a janela de conectar ao Ergon World abre sozinha */}
      <button className="btn btn--primary" onClick={() => void api.get('/api/loja/minhas').catch(() => undefined)}><Icon name="globe" size={14} /> {t('documentos.loja.pub.entrar')}</button>
    </div>
  );
}

/** O perfil de quem publica: o nome curto (vai no id dos pacotes) e o nome que aparece na Loja. */
function Perfil({ onFeito }: { onFeito: () => void }) {
  const t = useT();
  const [ns, setNs] = useState(''); const [nome, setNome] = useState(''); const [erro, setErro] = useState<string | null>(null);
  return (
    <section className="card">
      <h3>{t('documentos.loja.pub.perfilTitulo')}</h3>
      <p className="muted">{t('documentos.loja.pub.perfilTexto')}</p>
      <div className="row row--wrap">
        <label className="field">{t('documentos.loja.pub.namespace')}<input value={ns} maxLength={31} onChange={(e) => setNs(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder={t('documentos.loja.pub.namespaceExemplo')} /></label>
        <label className="field">{t('documentos.loja.pub.nomeNaLoja')}<input value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} /></label>
      </div>
      {erro && <p className="error" role="alert">{erro}</p>}
      <button className="btn btn--primary" disabled={ns.length < 2 || !nome.trim()} onClick={() => void api.post('/api/loja/criador', { namespace: ns, nome }).then(onFeito).catch((e) => setErro(errMsg(e)))}>{t('documentos.loja.pub.criarPerfil')}</button>
    </section>
  );
}

/**
 * Publicar de graça: escolher o que (um visual em .ergon, a equipe deste workspace ou uma competência), título, resumo,
 * versão; ver a prévia exatamente como vai para a Loja; publicar manda para a revisão. Nunca há preço.
 */
export function Publicar({ rascunho, agent, onPublicado }: { rascunho: Rascunho | null; agent: PreviewAgent | null; onPublicado: (msg: string) => void }) {
  const t = useT();
  const { st, ligado, minhas } = useConta();
  const skills = useResource<Array<Skill & { terceiro?: boolean }>>(ligado ? '/api/ai/skills' : null, []);
  const [fonte, setFonte] = useState<FonteP>(rascunho?.fonte ?? 'arquivo');
  const [arquivo, setArquivo] = useState<{ nome: string; b64: string } | null>(null);
  const [skill, setSkill] = useState(''); const [texto, setTexto] = useState('');
  const [titulo, setTitulo] = useState(rascunho?.titulo ?? ''); const [resumo, setResumo] = useState(rascunho?.resumo ?? '');
  const [versao, setVersao] = useState(rascunho?.versao ?? '1.0.0'); const [nome, setNome] = useState(rascunho?.nome ?? '');
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [erro, setErro] = useState<string | null>(null); const [indo, setIndo] = useState(false);
  useEffect(() => { setPrevia(null); }, [fonte, arquivo, skill, texto, titulo, resumo, versao, nome]);
  useEffect(() => { // a competência escolhida da biblioteca: o texto dela vai no pacote
    if (!skill) return;
    let vivo = true;
    api.get<{ texto: string }>(`/api/recursos/competencias/conteudo?nome=${encodeURIComponent(skill)}`).then((r) => { if (vivo) setTexto(r.texto); }).catch((e) => { if (vivo) setErro(errMsg(e)); });
    return () => { vivo = false; };
  }, [skill]);
  if (!ligado) return <section className="card"><h3>{t('documentos.loja.aba.publicar')}</h3><SemConta st={st} /></section>;
  if (!minhas.data) return <Loading error={minhas.error} />;
  if (!minhas.data.creator) return <Perfil onFeito={minhas.reload} />;
  const ns = minhas.data.creator.namespace;
  const minhasSkills = (skills.data ?? []).filter((s) => (s.origem === 'enviada' || s.origem === 'criada') && !s.terceiro);
  const corpo = () => ({ fonte, namespace: ns, titulo, resumo, versao, nome: nome || undefined, ...(fonte === 'arquivo' ? { arquivo: arquivo?.b64 } : fonte === 'competencia' ? { texto } : {}) });
  const pronto = titulo.trim() && resumo.trim().length >= 10 && (fonte !== 'arquivo' || arquivo) && (fonte !== 'competencia' || texto.trim());
  const agir = async (fn: () => Promise<void>) => { setErro(null); setIndo(true); try { await fn(); } catch (e) { setErro(errMsg(e)); } finally { setIndo(false); } };
  return (
    <section className="card">
      <h3>{t('documentos.loja.pub.titulo')}</h3>
      <p className="muted small">{t('documentos.loja.pub.texto', { nome: minhas.data.creator.displayName })}</p>
      <div className="loja-fonte" role="radiogroup" aria-label={t('documentos.loja.pub.oQue')}>
        {FONTES.map((f) => (
          <label key={f.k}>
            <input type="radio" name="loja-fonte" checked={fonte === f.k} onChange={() => setFonte(f.k)} />
            <b><Icon name={f.icon} size={15} /> {t(f.titulo)}</b>
            <span className="muted small">{t(f.texto)}</span>
          </label>
        ))}
      </div>
      {fonte === 'arquivo' && (
        <label className="field">{t('documentos.loja.pub.arquivo')}
          <input type="file" accept=".ergon" onChange={(e) => { const f = e.target.files?.[0]; if (f) void lerBase64(f).then((b64) => setArquivo({ nome: f.name, b64 })); }} />
        </label>
      )}
      {fonte === 'competencia' && (
        <>
          {minhasSkills.length > 0 && (
            <label className="field">{t('documentos.loja.pub.daBiblioteca')}
              <select value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">{t('documentos.loja.pub.colarEmVez')}</option>
                {minhasSkills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">{t('documentos.loja.pub.textoSkill')}<textarea rows={6} value={texto} maxLength={400_000} onChange={(e) => { setTexto(e.target.value); setSkill(''); }} /></label>
        </>
      )}
      <label className="field">{t('documentos.loja.pub.campoTitulo')}<input value={titulo} maxLength={80} onChange={(e) => setTitulo(e.target.value)} /></label>
      <label className="field">{t('documentos.loja.pub.campoResumo')}<textarea rows={2} value={resumo} maxLength={600} onChange={(e) => setResumo(e.target.value)} /></label>
      <div className="row row--wrap">
        <label className="field">{t('documentos.loja.pub.campoVersao')}<input value={versao} maxLength={14} onChange={(e) => setVersao(e.target.value)} inputMode="decimal" /></label>
        <label className="field">{t('documentos.loja.pub.campoNome')}<input value={nome} maxLength={40} placeholder={t('documentos.loja.pub.campoNomeDica')} onChange={(e) => setNome(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></label>
      </div>
      {erro && <p className="error" role="alert">{erro}</p>}
      {previa && (
        <div className="card card--inner">
          <p className="small"><b>{previa.title}</b> · {tipoDe(previa.kind)} · {previa.version} · <code>{previa.packageId}</code></p>
          {previa.competencia
            ? <pre className="loja-skill__texto" tabIndex={0}>{previa.competencia.texto}</pre>
            : <div className="loja-detalhe__previa loja-previa"><PreviaPacote item={{ id: previa.packageId, version: previa.version, title: previa.title, summary: previa.summary, kind: previa.kind, verified: false, installed: false, preview: previa.preview }} agent={agent} /></div>}
          <p className="small">{previa.summary}</p>
        </div>
      )}
      <div className="row row--wrap">
        <button className="btn" disabled={!pronto || indo} onClick={() => void agir(async () => setPrevia(await api.post<Previa>('/api/loja/publicar/previa', corpo())))}><Icon name="eye" size={14} /> {t('documentos.loja.pub.verPrevia')}</button>
        <button className="btn btn--primary" disabled={!pronto || !previa || indo} onClick={() => void agir(async () => {
          const r = await api.post<{ title: string; version: string }>('/api/loja/publicar', corpo());
          onPublicado(t('documentos.loja.pub.enviado', { titulo: r.title, versao: r.version }));
        })}><Icon name="send" size={14} /> {t('documentos.loja.pub.publicar')}</button>
      </div>
      <p className="hint">{t('documentos.loja.pub.revisao')}</p>
    </section>
  );
}

/** As publicações da pessoa: o estado de cada uma, as versões e "Nova versão". */
export function MinhasPublicacoes({ onNovaVersao, onPublicar }: { onNovaVersao: (r: Rascunho) => void; onPublicar: () => void }) {
  const t = useT();
  const { st, ligado, minhas } = useConta();
  if (!ligado) return <section className="card"><h3>{t('documentos.loja.aba.minhas')}</h3><SemConta st={st} /></section>;
  if (!minhas.data) return <Loading error={minhas.error} />;
  const m = minhas.data;
  return (
    <section className="card">
      <h3>{t('documentos.loja.aba.minhas')}</h3>
      {!m.disponivel && <p className="hint">{t('documentos.loja.minhas.indisponivel')}</p>}
      {m.disponivel && !m.items.length && (
        <div className="cena-vazio">
          <div className="cena-vazio__figs"><Fig k="hipatia" gesture="think" scale={3} /><Fig k="arquimedes" gesture="offer" scale={3} /></div>
          <p>{t('documentos.loja.minhas.vazio')}</p>
          <button className="btn btn--primary" onClick={onPublicar}><Icon name="send" size={14} /> {t('documentos.loja.aba.publicar')}</button>
        </div>
      )}
      <ul className="loja-pub">
        {m.items.map((i) => (
          <li key={i.id}>
            <div className="loja-pub__topo">
              <b>{i.title}</b>
              <span className="badge">{tipoDe(i.kind)}</span>
              <span className={`badge ${i.status === 'published' ? 'badge--ok' : i.status === 'rejected' || i.status === 'suspended' ? 'badge--err' : 'badge--warn'}`}>{ESTADO[i.status] ? t(ESTADO[i.status]) : i.status}</span>
              <button className="btn btn--sm" onClick={() => onNovaVersao({ nome: i.packageId.split('.').pop() ?? '', titulo: i.title, resumo: i.summary, versao: proxima(i.versions.map((v) => v.version).sort().at(-1)), fonte: i.kind === 'skill' ? 'competencia' : i.kind === 'team-blueprint' ? 'equipe' : 'arquivo' })}>
                <Icon name="plus" size={13} /> {t('documentos.loja.minhas.novaVersao')}
              </button>
            </div>
            <p className="muted small">{i.summary}</p>
            <ul className="loja-pub__versoes" aria-label={t('documentos.loja.minhas.versoes')}>
              {[...i.versions].reverse().map((v) => (
                <li key={v.version}>
                  <b>{v.version}</b>
                  <span className={`badge ${v.status === 'approved' ? 'badge--ok' : v.status === 'rejected' ? 'badge--err' : ''}`}>{ESTADO[v.status] ? t(ESTADO[v.status]) : v.status}</span>
                  <span className="muted">{fmtData(v.createdAt)}</span>
                  {v.reason && <span className="muted">· {v.reason}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

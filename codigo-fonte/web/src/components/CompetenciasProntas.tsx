import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Agent, Skill } from '../lib/types.ts';
import { RECURSOS, type CompetenciaLoja, type Varredura } from '../lib/recursos.ts';
import { Icon } from './Icon.tsx';
import { useT } from '../i18n/index.ts';

/** As que a pessoa costuma procurar primeiro (documentos de escritório, atas, revisão semanal). */
const DESTAQUE = ['docx', 'xlsx', 'pdf', 'powerpoint', 'meeting-action-items', 'weekly-review-planning', 'document-to-action-items', 'excel-author', 'pptx-author'];

/**
 * Treinar › Competências prontas: as que já vêm com a equipe, para ligar neste agente, e a loja (busca, prévia,
 * varredura de segurança e a aprovação da pessoa antes de instalar).
 */
export function CompetenciasProntas({ agent, reload }: { agent: Agent; reload: () => void }) {
  const t = useT();
  const prontas = useResource<Skill[]>('/api/ai/skills', ['agents.changed']);
  const [erro, setErro] = useState<string | null>(null);
  const minhas = new Set(agent.hermes_skills);
  const ferramentas = agent.tools.map((x) => x.id);
  const lista = [...(prontas.data ?? [])].sort((a, b) => Number(DESTAQUE.includes(b.name)) - Number(DESTAQUE.includes(a.name)) || a.name.localeCompare(b.name));
  const alternar = async (nome: string) => {
    const novas = minhas.has(nome) ? agent.hermes_skills.filter((s) => s !== nome) : [...agent.hermes_skills, nome];
    // para usar a competência, o agente precisa da ferramenta das competências: vai junto
    const tools = novas.length && !ferramentas.includes('habilidades') ? [...ferramentas, 'habilidades'] : ferramentas;
    try { await api.patch(`/api/agents/${agent.id}`, { hermesSkills: novas, tools }); setErro(null); reload(); }
    catch (x) { setErro(errMsg(x)); }
  };
  return (
    <div className="block">
      <h4><Icon name="book" size={14} /> {t('agente.prontas.titulo')}</h4>
      <p className="hint">{t('agente.prontas.texto', { nome: agent.name })}</p>
      {erro && <p className="error" role="status">{erro}</p>}
      {!prontas.data ? <p className="muted small">{prontas.error ?? t('agente.prontas.lendo')}</p> : !lista.length ? <p className="hint">{t('agente.prontas.vazio')}</p> : (
        <div className="skill-list">
          {lista.slice(0, 80).map((s) => (
            <button key={s.name} className={`skill-item ${minhas.has(s.name) ? 'skill-item--on' : ''}`} onClick={() => void alternar(s.name)} aria-pressed={minhas.has(s.name)} title={s.description}>
              <b>{s.name}</b><small>{s.description}</small>
            </button>
          ))}
        </div>
      )}
      <Loja />
    </div>
  );
}

function Loja() {
  const t = useT();
  const [busca, setBusca] = useState('');
  const [termo, setTermo] = useState('');
  const loja = useResource<{ competencias: CompetenciaLoja[] }>(`${RECURSOS}/loja${termo ? `?q=${encodeURIComponent(termo)}` : ''}`, []);
  const [aberta, setAberta] = useState<{ c: CompetenciaLoja; v: Varredura | null; texto: string | null; erro: string | null } | null>(null);
  const [instalando, setInstalando] = useState(false);
  const [feito, setFeito] = useState<string | null>(null);
  const abrir = async (c: CompetenciaLoja) => {
    setAberta({ c, v: null, texto: null, erro: null }); setFeito(null);
    try {
      const [v, p] = await Promise.all([
        api.get<Varredura>(`${RECURSOS}/loja/varredura?id=${encodeURIComponent(c.id)}`),
        api.get<{ texto: string }>(`${RECURSOS}/loja/previa?id=${encodeURIComponent(c.id)}`),
      ]);
      setAberta({ c, v, texto: p.texto, erro: null });
    } catch (x) { setAberta({ c, v: null, texto: null, erro: errMsg(x) }); }
  };
  const instalar = async () => {
    if (!aberta?.v) return;
    setInstalando(true);
    try { await api.post(`${RECURSOS}/loja/instalar`, { id: aberta.c.id, vi: true }); setFeito(aberta.c.id); setAberta(null); loja.reload(); }
    catch (x) { setAberta({ ...aberta, erro: errMsg(x) }); }
    finally { setInstalando(false); }
  };
  const barrada = aberta?.v?.politica === 'block';
  return (
    <div className="block">
      <h4><Icon name="store" size={14} /> {t('agente.loja.titulo')}</h4>
      <p className="hint">{t('agente.loja.texto')}</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setTermo(busca.trim()); }}>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={t('agente.loja.buscar')} aria-label={t('agente.loja.buscar')} maxLength={80} />
        <button className="btn btn--sm" type="submit"><Icon name="search" size={12} /> {t('agente.loja.procurar')}</button>
      </form>
      <p className="muted small">{termo ? t('agente.loja.naInternet') : t('agente.loja.oficiais')}</p>
      {feito && <p className="ok" role="status">{t('agente.loja.instalada')}</p>}
      {!loja.data ? <p className="muted small">{loja.error ?? t('agente.prontas.lendo')}</p> : !loja.data.competencias.length ? <p className="hint">{t('agente.loja.nada')}</p> : (
        <ul className="plain small">
          {loja.data.competencias.slice(0, 40).map((c) => (
            <li key={c.id}>
              <b>{c.nome}</b> <span className="muted">{c.categoria ? `${c.categoria} · ` : ''}{c.descricao}</span>{' '}
              {c.instalada ? <span className="badge badge--ok">{t('agente.loja.jaInstalada')}</span>
                : <button className="btn btn--sm" onClick={() => void abrir(c)}>{t('agente.loja.ver')}</button>}
              {aberta?.c.id === c.id && (
                <div className="card card--inset">
                  {aberta.erro && <p className="error" role="status">{aberta.erro}</p>}
                  {!aberta.v && !aberta.erro && <p className="muted small">{t('agente.loja.varrendo')}</p>}
                  {aberta.v && (
                    <>
                      <p><b>{t('agente.loja.varredura')}</b> {aberta.v.veredito === 'safe' ? t('agente.loja.segura') : aberta.v.veredito === 'caution' ? t('agente.loja.atencao') : t('agente.loja.perigosa')}
                        {' · '}{aberta.v.confianca === 'builtin' ? t('agente.loja.fonteOficial') : aberta.v.confianca === 'trusted' ? t('agente.loja.fonteConfiavel') : t('agente.loja.fonteComunidade')}</p>
                      {aberta.v.achados.length > 0 && <ul className="plain small">{aberta.v.achados.slice(0, 8).map((x, i) => <li key={i}><span className="badge badge--warn">{x.gravidade}</span> {x.descricao} <span className="muted">{x.arquivo}{x.linha ? `:${x.linha}` : ''}</span></li>)}</ul>}
                      {aberta.texto && <details><summary className="muted small">{t('agente.loja.verTexto')}</summary><pre className="small pre-wrap">{aberta.texto.slice(0, 6000)}</pre></details>}
                      {barrada ? <p className="hint warn">{t('agente.loja.barrada')}</p> : (
                        <div className="row">
                          <button className="btn btn--primary btn--sm" onClick={() => void instalar()} disabled={instalando}>{instalando ? t('agente.loja.instalando') : t('agente.loja.aprovar')}</button>
                          <button className="btn btn--sm" onClick={() => setAberta(null)}>{t('agente.loja.fechar')}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

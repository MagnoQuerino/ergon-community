import { useRef, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Agent, AgentSkill, Skill } from '../lib/types.ts';
import { RECURSOS, type CompetenciaLoja, type Varredura } from '../lib/recursos.ts';
import {
  ORIGENS, categoriasDaLoja, contarOrigens, destaques, filtrarInstaladas, gradeDaLoja, filtrarLoja, iconeDaCategoria, instaladas, nomeLegivel, removivel, verificada,
  type Instalada, type Origem,
} from '../lib/competencias-tela.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';
import { useT, type Chave, type ValoresDe } from '../i18n/index.ts';

type Rotulo = { [K in Chave]: keyof ValoresDe<K> extends never ? K : never }[Chave];
export const SKILLS = '/api/ai/skills';
const ORIGEM: Record<Origem, Rotulo> = {
  equipe: 'agente.comp.origem.equipe', loja: 'agente.comp.origem.loja', enviada: 'agente.comp.origem.enviada', criada: 'agente.comp.origem.criada', treinar: 'agente.comp.origem.treinar',
};
/** A gravidade de cada ponto da varredura, no idioma da tela. */
const GRAVIDADE: Record<string, Rotulo> = { critical: 'agente.loja.grav.critical', high: 'agente.loja.grav.high', medium: 'agente.loja.grav.medium', low: 'agente.loja.grav.low' };
/** Quantas aparecem de cada vez (o resto vem com "Mostrar mais"). */
const PAGINA = 24;

/** Liga ou desliga uma competência da biblioteca neste agente (com a ferramenta das competências junto). */
export async function ligarNoAgente(agent: Pick<Agent, 'id'>, nome: string, ligar: boolean): Promise<void> {
  // a conta é do servidor, sobre a lista gravada: dois cliques seguidos (antes de a tela recarregar) não se apagam, e a
  // ferramenta das competências vai junto quando liga
  await api.post(`${RECURSOS}/competencias/ligar`, { agente: agent.id, nome, ligar });
}

/** O resultado da varredura de segurança, igual na loja e no envio da pessoa. */
export function VarreduraResumo({ v }: { v: Varredura }) {
  const t = useT();
  const cls = v.veredito === 'safe' ? 'badge--ok' : v.veredito === 'caution' ? 'badge--warn' : 'badge--err';
  return (
    <div className="comp-varredura">
      <p><Icon name="shield-check" size={14} /> <b>{t('agente.loja.varredura')}</b>{' '}
        <span className={`badge ${cls}`}>{v.veredito === 'safe' ? t('agente.loja.segura') : v.veredito === 'caution' ? t('agente.loja.atencao') : t('agente.loja.perigosa')}</span></p>
      {v.achados.length > 0 && (
        <ul className="plain small comp-varredura__achados">
          {v.achados.slice(0, 8).map((x, i) => <li key={i}><span className={`badge ${x.gravidade === 'critical' ? 'badge--err' : 'badge--warn'}`}>{GRAVIDADE[x.gravidade] ? t(GRAVIDADE[x.gravidade]) : x.gravidade}</span> {x.descricao} <span className="muted">{x.arquivo}{x.linha ? `:${x.linha}` : ''}</span></li>)}
          {v.achados.length > 8 && <li className="muted">{t('agente.comp.maisAchados', { n: v.achados.length - 8 })}</li>}
        </ul>
      )}
    </div>
  );
}

/** Botão que não fica desligado esperando: mostra que está indo e não manda duas vezes. */
export function useUmaVez() {
  const indo = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const rodar = async (fn: () => Promise<void>) => {
    if (indo.current) return;
    indo.current = true; setOcupado(true);
    try { await fn(); } finally { indo.current = false; setOcupado(false); }
  };
  return { ocupado, rodar };
}

// ---------------------------------------------------------------- competências instaladas
/**
 * As competências deste agente e da equipe numa lista só, com busca e filtros (de quem, de onde veio). Cada uma diz de
 * onde veio e se está ligada neste agente; "Ver" abre o texto e as ações (ligar, desligar, atualizar, remover).
 */
export function CompetenciasInstaladas({ agent, treinadas, reload, onAtualizar, detalheTreino }: {
  agent: Agent; treinadas: AgentSkill[]; reload: () => void;
  /** enviar uma versão nova de uma competência enviada (abre "Adicionar uma competência pronta") */
  onAtualizar: () => void;
  /** o cartão completo de uma competência do Treinar (versões, ensinar mais, remover) */
  detalheTreino: (s: AgentSkill) => ReactNode;
}) {
  const t = useT();
  const lib = useResource<Skill[]>(SKILLS, ['agents.changed']);
  const [busca, setBusca] = useState('');
  const [de, setDe] = useState<'agente' | 'equipe'>('agente');
  const [origem, setOrigem] = useState<Origem | 'todas'>('todas');
  const [ver, setVer] = useState<string | null>(null);
  const [mostrar, setMostrar] = useState(PAGINA);
  const [erro, setErro] = useState<string | null>(null);
  const todas = instaladas(lib.data ?? [], agent.hermes_skills, treinadas);
  const contas = contarOrigens(todas);
  const lista = filtrarInstaladas(todas, { busca, de, origem });
  const aberta = todas.find((i) => i.chave === ver) ?? null;
  const ligadas = todas.filter((i) => i.ligada).length;
  const alternar = async (i: Instalada) => {
    try {
      if (i.treino) await api.post(`/api/agent-skills/${i.treino.id}`, { action: i.ligada ? 'desativar' : 'ativar' });
      else await ligarNoAgente(agent, i.nome, !i.ligada);
      setErro(null); reload();
    } catch (x) { setErro(errMsg(x)); }
  };
  return (
    <section className="block comp-instaladas" aria-labelledby="comp-inst-titulo">
      <div className="comp-instaladas__topo">
        <h4 id="comp-inst-titulo"><Icon name="book" size={14} /> {t('agente.comp.instaladas')} <span className="muted small">{t('agente.comp.ligadasN', { n: ligadas, nome: agent.name })}</span></h4>
        <input className="comp-busca" type="search" value={busca} onChange={(e) => { setBusca(e.target.value); setMostrar(PAGINA); }}
          placeholder={t('agente.comp.buscar')} aria-label={t('agente.comp.buscar')} maxLength={80} />
      </div>
      <div className="comp-filtros" role="group" aria-label={t('agente.comp.filtros')}>
        <span className="comp-filtros__grupo">
          <button className={`chip ${de === 'agente' ? 'chip--on' : ''}`} aria-pressed={de === 'agente'} onClick={() => setDe('agente')}>{t('agente.comp.deste', { nome: agent.name })}</button>
          <button className={`chip ${de === 'equipe' ? 'chip--on' : ''}`} aria-pressed={de === 'equipe'} onClick={() => setDe('equipe')}>{t('agente.comp.daEquipe')}</button>
        </span>
        <span className="comp-filtros__grupo">
          <button className={`chip ${origem === 'todas' ? 'chip--on' : ''}`} aria-pressed={origem === 'todas'} onClick={() => setOrigem('todas')}>{t('agente.comp.todasOrigens')}</button>
          {ORIGENS.filter((o) => contas[o]).map((o) => (
            <button key={o} className={`chip ${origem === o ? 'chip--on' : ''}`} aria-pressed={origem === o} onClick={() => setOrigem(o)}>{t(ORIGEM[o])} <span className="muted">{contas[o]}</span></button>
          ))}
        </span>
      </div>
      {erro && <p className="error" role="status">{erro}</p>}
      {!lib.data && !treinadas.length ? <p className="muted small">{lib.error ?? t('agente.prontas.lendo')}</p> : !lista.length ? (
        <p className="hint">{busca.trim() ? t('agente.comp.nadaBusca') : de === 'agente' ? t('agente.comp.nenhumaDeste', { nome: agent.name }) : t('agente.comp.nenhuma')}</p>
      ) : (
        <>
          <ul className="comp-grade">
            {lista.slice(0, mostrar).map((i) => (
              <li key={i.chave} className={`comp-card ${i.ligada ? 'comp-card--on' : ''} ${ver === i.chave ? 'comp-card--aberto' : ''}`}>
                <div className="comp-card__topo">
                  <b className="comp-card__nome">{i.titulo}</b>
                  {i.ligada ? <span className="badge badge--ok">{i.treino ? t('agente.treino.competencia.ativa') : t('agente.comp.ligada')}</span> : i.treino ? <span className="badge badge--warn">{t('agente.treino.competencia.desativada')}</span> : null}
                </div>
                {i.descricao && <p className="comp-card__desc">{i.descricao}</p>}
                <div className="comp-card__pe">
                  <span className="comp-origem">{t(ORIGEM[i.origem])}</span>
                  <span className="grow" />
                  <button className="btn btn--sm btn--ghost" aria-expanded={ver === i.chave} onClick={() => setVer(ver === i.chave ? null : i.chave)}>{t('agente.comp.ver')}</button>
                  <button className={`btn btn--sm ${i.ligada ? '' : 'btn--primary'}`} onClick={() => void alternar(i)}>
                    {i.ligada ? t('agente.comp.desligar') : t('agente.comp.ligar')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {lista.length > mostrar && <p className="comp-mais"><button className="btn btn--sm" onClick={() => setMostrar(mostrar + PAGINA)}>{t('agente.comp.mostrarMais', { n: lista.length - mostrar })}</button></p>}
        </>
      )}
      {aberta && (aberta.treino ? <div className="comp-detalhe">{detalheTreino(aberta.treino)}</div>
        : <DetalheDaBiblioteca key={aberta.chave} i={aberta} agent={agent} reload={reload} onAtualizar={onAtualizar} onFechar={() => setVer(null)} onAlternar={() => void alternar(aberta)} />)}
    </section>
  );
}

function DetalheDaBiblioteca({ i, agent, reload, onAtualizar, onFechar, onAlternar }: {
  i: Instalada; agent: Agent; reload: () => void; onAtualizar: () => void; onFechar: () => void; onAlternar: () => void;
}) {
  const t = useT();
  const c = useResource<{ texto: string; arquivos: string[] }>(`${RECURSOS}/competencias/conteudo?nome=${encodeURIComponent(i.nome)}`, []);
  const [confirmar, setConfirmar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const { ocupado, rodar } = useUmaVez();
  const remover = () => rodar(async () => {
    try { await api.del(`${RECURSOS}/competencias/${encodeURIComponent(i.nome)}`); onFechar(); reload(); }
    catch (x) { setErro(errMsg(x)); }
  });
  return (
    <div className="comp-detalhe train__card">
      <div className="row"><b>{i.titulo}</b> <span className="comp-origem">{t(ORIGEM[i.origem])}</span><span className="grow" />
        <button className="icon-btn" aria-label={t('agente.loja.fechar')} onClick={onFechar}><Icon name="x" size={14} /></button></div>
      {i.descricao && <p className="small">{i.descricao}</p>}
      <p className="muted small">{i.ligada ? t('agente.comp.ligadaEm', { nome: agent.name }) : t('agente.comp.naoLigadaEm', { nome: agent.name })} {t('agente.comp.custoDica')}</p>
      {c.data ? (
        <details>
          <summary className="muted small">{t('agente.loja.verTexto')}{c.data.arquivos.length > 1 ? ` · ${t('agente.comp.arquivosN', { n: c.data.arquivos.length })}` : ''}</summary>
          <pre className="pre train__pre">{c.data.texto.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')}</pre>
        </details>
      ) : c.error ? <p className="muted small">{c.error}</p> : null}
      <div className="row row--wrap">
        <button className={`btn btn--sm ${i.ligada ? '' : 'btn--primary'}`} onClick={onAlternar}>{i.ligada ? t('agente.comp.desligarEm', { nome: agent.name }) : t('agente.comp.ligarEm', { nome: agent.name })}</button>
        {i.origem === 'enviada' && <button className="btn btn--sm" onClick={onAtualizar}><Icon name="repeat" size={13} /> {t('agente.comp.enviarVersao')}</button>}
        {removivel(i) && (confirmar ? (
          <span className="confirm">{t('agente.comp.confirmarRemover')}
            <button className="btn btn--sm btn--primary" onClick={() => void remover()}>{ocupado ? t('agente.comp.removendo') : t('agente.treino.remover')}</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmar(false)}>{t('agente.cancelar')}</button></span>
        ) : <button className="btn btn--sm btn--ghost" onClick={() => setConfirmar(true)}><Icon name="trash" size={13} /> {t('agente.comp.removerDaEquipe')}</button>)}
        {i.origem === 'equipe' && <span className="hint">{t('agente.comp.naoRemove')}</span>}
      </div>
      {erro && <p className="error" role="status">{erro}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- loja
/** Nome de cada categoria no idioma da tela (as que a equipe de IA traz); as outras aparecem como vêm. */
const CATEGORIA: Record<string, Rotulo> = {
  productivity: 'agente.loja.cat.productivity', research: 'agente.loja.cat.research', creative: 'agente.loja.cat.creative', finance: 'agente.loja.cat.finance',
  'data-science': 'agente.loja.cat.dataScience', 'software-development': 'agente.loja.cat.softwareDevelopment', devops: 'agente.loja.cat.devops', mlops: 'agente.loja.cat.mlops',
  security: 'agente.loja.cat.security', communication: 'agente.loja.cat.communication', marketing: 'agente.loja.cat.marketing', media: 'agente.loja.cat.media',
  education: 'agente.loja.cat.education', health: 'agente.loja.cat.health', legal: 'agente.loja.cat.legal', email: 'agente.loja.cat.email', 'social-media': 'agente.loja.cat.socialMedia',
  'note-taking': 'agente.loja.cat.noteTaking', github: 'agente.loja.cat.github', business: 'agente.loja.cat.business', design: 'agente.loja.cat.design',
};
function useCategoria() {
  const t = useT();
  return (c: string) => (CATEGORIA[c] ? t(CATEGORIA[c]) : nomeLegivel(c));
}

/**
 * A loja: vitrine em cartões com busca, categorias e destaques. Instalar abre a ficha da competência com a varredura de
 * segurança e o texto; só depois da aprovação ela entra na equipe (e, se a pessoa quiser, já liga neste agente).
 */
export function LojaCompetencias({ agent, reload }: { agent: Agent; reload: () => void }) {
  const t = useT();
  const nomeCat = useCategoria();
  const [busca, setBusca] = useState('');
  const [termo, setTermo] = useState('');
  const [categoria, setCategoria] = useState<string | null>(null);
  const [mostrar, setMostrar] = useState(PAGINA);
  const loja = useResource<{ competencias: CompetenciaLoja[] }>(`${RECURSOS}/loja${termo ? `?q=${encodeURIComponent(termo)}` : ''}`, []);
  const [aberta, setAberta] = useState<CompetenciaLoja | null>(null);
  const [feito, setFeito] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const base = loja.data?.competencias ?? [];
  const cats = categoriasDaLoja(base);
  // enquanto digita, a busca filtra o que está na tela; "Procurar na internet" busca nas fontes públicas
  const lista = filtrarLoja(base, { busca: termo ? '' : busca, categoria });
  const emDestaque = !busca.trim() && !termo && !categoria ? destaques(base) : [];
  // a grade é a lista sem os destaques (que aparecem à parte): o "Mostrar mais" conta só o que falta nela
  const grade = gradeDaLoja(lista, emDestaque);
  const ligadas = new Set(agent.hermes_skills);
  const procurarFora = () => { setTermo(busca.trim()); setCategoria(null); setMostrar(PAGINA); };
  const ligarJa = async (c: CompetenciaLoja) => {
    try { await ligarNoAgente(agent, c.nome, true); setErro(null); reload(); } catch (x) { setErro(errMsg(x)); }
  };
  const cartao = (c: CompetenciaLoja, grande = false) => (
    <li key={`${grande ? 'd' : 'g'}:${c.id}`} className={`loja-comp ${grande ? 'loja-comp--destaque' : ''} ${c.instalada ? 'loja-comp--instalada' : ''}`}>
      <span className="loja-comp__icone" aria-hidden="true"><Icon name={iconeDaCategoria(c.categoria)} size={grande ? 26 : 22} /></span>
      <div className="loja-comp__txt">
        <b className="loja-comp__nome">{nomeLegivel(c.nome)}</b>
        <span className="loja-comp__cat">{c.categoria ? nomeCat(c.categoria) : t('agente.loja.semCategoria')}</span>
        <p className="loja-comp__desc">{c.descricao}</p>
      </div>
      <div className="loja-comp__pe">
        <span className="loja-comp__selos">
          {verificada(c) ? <span className="badge badge--ok"><Icon name="shield-check" size={11} /> {t('agente.loja.verificada')}</span> : <span className="badge">{t('agente.loja.comunidade')}</span>}
          {c.instalada && <span className="badge badge--ok"><Icon name="check" size={11} /> {t('agente.loja.jaInstalada')}</span>}
        </span>
        {c.instalada ? (
          ligadas.has(c.nome) ? <span className="muted small">{t('agente.loja.ligadaNele', { nome: agent.name })}</span>
            : <button className="btn btn--sm" onClick={() => void ligarJa(c)}>{t('agente.comp.ligarEm', { nome: agent.name })}</button>
        ) : <button className="btn btn--primary loja-comp__instalar" onClick={() => { setFeito(null); setAberta(c); }}><Icon name="download" size={14} /> {t('agente.loja.instalar')}</button>}
      </div>
    </li>
  );
  return (
    <section className="block loja-comps" aria-labelledby="loja-comps-titulo">
      <div className="comp-instaladas__topo">
        <h4 id="loja-comps-titulo"><Icon name="store" size={14} /> {t('agente.loja.titulo')}</h4>
        <form className="loja-comps__busca" role="search" onSubmit={(e) => { e.preventDefault(); procurarFora(); }}>
          <input type="search" value={busca} onChange={(e) => { setBusca(e.target.value); setMostrar(PAGINA); if (!e.target.value.trim()) setTermo(''); }}
            placeholder={t('agente.loja.buscar')} aria-label={t('agente.loja.buscar')} maxLength={80} />
          <button className="btn btn--sm" type="submit"><Icon name="search" size={12} /> {t('agente.loja.procurarFora')}</button>
        </form>
      </div>
      <p className="hint">{t('agente.loja.texto')}</p>
      {cats.length > 1 && (
        <div className="comp-filtros" role="group" aria-label={t('agente.loja.categorias')}>
          <button className={`chip ${!categoria ? 'chip--on' : ''}`} aria-pressed={!categoria} onClick={() => setCategoria(null)}>{t('agente.loja.todas')}</button>
          {cats.slice(0, 14).map((c) => (
            <button key={c.categoria} className={`chip ${categoria === c.categoria ? 'chip--on' : ''}`} aria-pressed={categoria === c.categoria} onClick={() => { setCategoria(c.categoria); setMostrar(PAGINA); }}>
              {nomeCat(c.categoria)} <span className="muted">{c.n}</span>
            </button>
          ))}
        </div>
      )}
      <p className="muted small">{termo ? t('agente.loja.naInternet') : t('agente.loja.oficiais')}</p>
      {feito && <p className="ok" role="status">{feito}</p>}
      {erro && <p className="error" role="status">{erro}</p>}
      {!loja.data ? <p className="muted small">{loja.error ?? t('agente.loja.abrindo')}</p> : (
        <>
          {emDestaque.length > 0 && (
            <>
              <h5 className="loja-comps__sub">{t('agente.loja.destaques')}</h5>
              <ul className="loja-comps__grade loja-comps__grade--destaque">{emDestaque.map((c) => cartao(c, true))}</ul>
              <h5 className="loja-comps__sub">{t('agente.loja.todasAs', { n: lista.length - emDestaque.length })}</h5>
            </>
          )}
          {!lista.length ? <p className="hint">{t('agente.loja.nada')}</p> : <ul className="loja-comps__grade">{grade.slice(0, mostrar).map((c) => cartao(c))}</ul>}
          {grade.length > mostrar && <p className="comp-mais"><button className="btn btn--sm" onClick={() => setMostrar(mostrar + PAGINA)}>{t('agente.comp.mostrarMais', { n: grade.length - mostrar })}</button></p>}
        </>
      )}
      {aberta && <FichaDaLoja c={aberta} agent={agent} onClose={() => setAberta(null)}
        onInstalada={(msg) => { setAberta(null); setFeito(msg); loja.reload(); reload(); }} />}
    </section>
  );
}

/** A ficha de uma competência da loja: a varredura de segurança, o texto e a aprovação. */
function FichaDaLoja({ c, agent, onClose, onInstalada }: { c: CompetenciaLoja; agent: Agent; onClose: () => void; onInstalada: (msg: string) => void }) {
  const t = useT();
  const nomeCat = useCategoria();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const v = useResource<Varredura>(`${RECURSOS}/loja/varredura?id=${encodeURIComponent(c.id)}`, []);
  const p = useResource<{ texto: string; arquivos: string[] }>(`${RECURSOS}/loja/previa?id=${encodeURIComponent(c.id)}`, []);
  const [ligar, setLigar] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const { ocupado, rodar } = useUmaVez();
  const barrada = v.data?.politica === 'block';
  const instalar = () => rodar(async () => {
    // a varredura falhou: tenta de novo e diz isso (esperar não adiantaria: nada mais viria)
    if (!v.data) { if (v.error) { v.reload(); setErro(t('agente.loja.varreduraFalhou')); } else setErro(t('agente.loja.esperandoVarredura')); return; }
    if (barrada) return;
    try {
      await api.post(`${RECURSOS}/loja/instalar`, { id: c.id, vi: true });
      let ligou = false;
      if (ligar) {
        // o nome na equipe é o da loja; confere na biblioteca antes de ligar
        const lib = await api.get<Skill[]>(SKILLS).catch(() => [] as Skill[]);
        if (lib.some((s) => s.name === c.nome)) { await ligarNoAgente(agent, c.nome, true); ligou = true; }
      }
      onInstalada(ligou ? t('agente.loja.instaladaLigada', { nome: agent.name }) : t('agente.loja.instalada'));
    } catch (x) { setErro(errMsg(x)); }
  });
  return (
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card loja-ficha" role="dialog" aria-modal="true" aria-labelledby="loja-ficha-titulo">
        <div className="loja-ficha__topo">
          <span className="loja-comp__icone" aria-hidden="true"><Icon name={iconeDaCategoria(c.categoria)} size={28} /></span>
          <div>
            <h3 id="loja-ficha-titulo">{nomeLegivel(c.nome)}</h3>
            <p className="muted small">{c.categoria ? `${nomeCat(c.categoria)} · ` : ''}{c.confianca === 'builtin' ? t('agente.loja.fonteOficial') : c.confianca === 'trusted' ? t('agente.loja.fonteConfiavel') : t('agente.loja.fonteComunidade')}</p>
          </div>
        </div>
        <p>{c.descricao}</p>
        {v.data ? <VarreduraResumo v={v.data} /> : <p className="muted small">{v.error ?? t('agente.loja.varrendo')}</p>}
        {p.data?.texto && <details><summary className="muted small">{t('agente.loja.verTexto')}</summary><pre className="small pre-wrap loja-ficha__texto">{p.data.texto.slice(0, 8000)}</pre></details>}
        {barrada ? <p className="hint warn">{t('agente.loja.barrada')}</p> : (
          <label className="check"><input type="checkbox" checked={ligar} onChange={(e) => setLigar(e.target.checked)} /> {t('agente.loja.ligarDepois', { nome: agent.name })}</label>
        )}
        {erro && <p className="error" role="status">{erro}</p>}
        <div className="cpop__acts">
          <button className="btn btn--ghost" onClick={onClose}>{t('agente.loja.fechar')}</button>
          {!barrada && <button className="btn btn--primary" onClick={() => void instalar()}>{ocupado ? t('agente.loja.instalando') : t('agente.loja.aprovar')}</button>}
        </div>
      </div>
    </div>
  );
}

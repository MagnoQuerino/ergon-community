import { Suspense, lazy, useRef, useState, type ComponentType } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { cloudOn, elapsed, OPS_URL, type AmbientOps, type Distribution, type OpsCategory, type OpsItem } from '../lib/ambient.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation, openDecisions } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { Icon } from './Icon.tsx';

/** Ala da nuvem (só na edição com o World; a Community não traz o arquivo e a ala simplesmente não aparece). */
const nuvemMod = Object.values(import.meta.glob<{ default: ComponentType }>('../views/world/AlaNuvem.tsx'))[0];
const AlaNuvem = nuvemMod ? lazy(nuvemMod) : null;

export type CentralSection = 'trabalho' | 'espera' | 'voce' | 'entregas';
const SECTION_LABEL: Record<CentralSection, string> = { trabalho: 'Trabalho', espera: 'Espera', voce: 'Para você', entregas: 'Entregas' };
const SECTION_TITLE: Record<CentralSection, string> = { trabalho: 'Trabalho em andamento', espera: 'Na espera e parados', voce: 'Precisa de você', entregas: 'Entregas recentes' };

/**
 * Central de Trabalho: o que a equipe está fazendo, o que espera e por quê, o que precisa de você e o que ficou
 * pronto — a mesma leitura das placas da cidade, em lista (teclado e leitor de tela). Cada linha abre o card de
 * sempre, onde estão priorizar, responder, parar e cancelar. Nada aqui executa trabalho por conta própria.
 */
export function CentralTrabalho({ ops, error, section, onSection, onClose, onBoard, onFiles, embedded }: {
  ops: AmbientOps | null; error: string | null; section: CentralSection; onSection: (s: CentralSection) => void;
  onClose?: () => void; onBoard: () => void; onFiles: () => void; embedded?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: () => onClose?.(), active: !embedded && !!onClose, autoFocus: !embedded });

  return (
    <aside ref={ref} className={`central ${embedded ? 'central--embedded' : ''}`} aria-labelledby="central-titulo">
      <header className="central__head">
        <h2 id="central-titulo" className="central__title"><Icon name="layers" size={17} /> Central de Trabalho</h2>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Fechar a Central (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>}
      </header>
      <nav className="central__tabs" role="tablist" aria-label="Partes da Central">
        {(Object.keys(SECTION_LABEL) as CentralSection[]).map((k) => (
          <button key={k} role="tab" aria-selected={section === k} className={`central__tab ${section === k ? 'is-on' : ''}`} onClick={() => onSection(k)} title={SECTION_TITLE[k]}>
            {SECTION_LABEL[k]}{ops ? <span className="central__n">{countOf(ops, k)}</span> : null}
          </button>
        ))}
      </nav>
      <div className="central__body" role="tabpanel" aria-label={SECTION_TITLE[section]}>
        {!ops ? (error ? <p className="error" role="alert">Não deu para ler o trabalho agora: {error}. A cidade e o quadro seguem funcionando.</p>
          : <p className="muted">Lendo o trabalho da equipe…</p>) : <>
          {error && <p className="hint warn" role="status">Sem atualização no momento ({error}). Mostrando a última leitura, de {new Date(ops.at).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}.</p>}
          {section === 'trabalho' && <Trabalho ops={ops} onBoard={onBoard} />}
          {section === 'espera' && <Espera ops={ops} />}
          {section === 'voce' && <Voce ops={ops} />}
          {section === 'entregas' && <Entregas ops={ops} onFiles={onFiles} />}
        </>}
      </div>
    </aside>
  );
}

function countOf(o: AmbientOps, k: CentralSection): number {
  if (k === 'trabalho') return o.totals.ativo;
  if (k === 'espera') return o.totals.pronto + o.totals.bloqueado + o.totals.impedido + o.totals.falhou;
  if (k === 'voce') return o.decisions.total;
  return o.deliveries.total;
}

/** Postos de trabalho: um por vaga, até 12; acima disso, o número. */
function Postos({ busy, limit }: { busy: number; limit: number | null }) {
  const shown = limit !== null && limit <= 12;
  return (
    <div className="postos">
      <div className="postos__txt">
        <b>{limit === null ? `${busy} em andamento` : `${busy} de ${limit} vagas ocupadas`}</b>
        <span className="muted small">Neste computador{limit === null ? ' · sem teto configurado' : ''}</span>
      </div>
      {shown && (
        <div className="postos__pips" aria-hidden="true">
          {Array.from({ length: limit! }, (_, i) => <span key={i} className={`posto ${i < busy ? 'posto--on' : ''}`} />)}
        </div>
      )}
    </div>
  );
}

/** Uma linha: o retrato vem no próprio item (o agente leve do servidor), sem a lista da equipe. */
function Linha({ it }: { it: OpsItem }) {
  const ag = it.agent;
  const go = () => { if (it.taskId) openCard(it.taskId); else if (it.actions.includes('conversa') && it.agentId) openConversation(it.agentId, null); };
  const clickable = !!it.taskId || it.actions.includes('conversa');
  const body = (
    <>
      {ag ? <AgentAvatar agent={ag} size={30} /> : <span className="avatar avatar--sm" aria-hidden="true">?</span>}
      <span className="op-row__txt">
        <span className="op-row__title" title={it.title}>{it.number ? <span className="muted">#{it.number} </span> : null}{it.title}</span>
        <span className="op-row__why">{it.reason}{it.since ? <span className="muted"> · {elapsed(it.since)}</span> : null}</span>
        {(it.priority || it.simulated) && (
          <span className="op-row__tags">
            {it.priority && <span className="badge">prioridade</span>}
            {it.simulated && <span className="badge badge--warn">simulação</span>}
          </span>
        )}
      </span>
    </>
  );
  return clickable
    ? <li><button className="op-row" onClick={go} title={it.taskId ? 'Abrir o card: priorizar, responder, parar ou cancelar' : 'Abrir a conversa'}>{body}</button></li>
    : <li><div className="op-row op-row--static">{body}</div></li>;
}

/** Lista de uma categoria, com "ver mais" (pede a página seguinte ao servidor; os totais não mudam). */
function Lista({ ops, cat, empty }: { ops: AmbientOps; cat: OpsCategory; empty?: string }) {
  const [extra, setExtra] = useState<OpsItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = [...ops.items[cat], ...extra.filter((x) => !ops.items[cat].some((y) => y.key === x.key))];
  const left = ops.totals[cat] - items.length;
  const more = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.get<AmbientOps>(`${OPS_URL}?category=${cat}&offset=${items.length}&limit=50`); setExtra((e) => [...e, ...r.items[cat]]); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (!ops.totals[cat]) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <>
      <ul className="op-list">{items.map((it) => <Linha key={it.key} it={it} />)}</ul>
      {left > 0 && <button className="link" disabled={busy} onClick={() => void more()}>{busy ? 'Carregando…' : `Ver mais ${left}`}</button>}
      {err && <p className="error small" role="alert">{err}</p>}
    </>
  );
}

function Trabalho({ ops, onBoard }: { ops: AmbientOps; onBoard: () => void }) {
  return (
    <>
      <Postos busy={ops.local.busy} limit={ops.local.limit} />
      {ops.local.mode === 'simulated' && <p className="hint">Sem conta de IA: os trabalhos rodam em simulação, identificados assim.</p>}
      {ops.local.conversations > 0 && <p className="muted small">Também {ops.local.conversations === 1 ? 'há 1 conversa' : `há ${ops.local.conversations} conversas`} acontecendo agora: conversa não ocupa vaga.</p>}
      <h3 className="central__sub">Em andamento</h3>
      <Lista ops={ops} cat="ativo" empty="Nenhum trabalho em execução agora. Peça algo à coordenação ou ponha um card para trabalhar no quadro." />
      <Nuvem />
      <p className="central__foot"><button className="link" onClick={onBoard}>Abrir o quadro da equipe</button><br />Quantos trabalhos andam ao mesmo tempo: Configurações › Andamento da equipe.</p>
    </>
  );
}

/**
 * Ala da nuvem: com o trabalho na nuvem ligado, a leitura dos Jobs (edição com o World); sem ele, o posto aparece
 * coberto com lona — está lá, reservado, mas sem uso nesta versão (nada para clicar, nada prometido).
 */
function Nuvem() {
  const d = useResource<Distribution>('/api/distribution', []);
  if (!d.data) return null;
  if (cloudOn(d.data) && AlaNuvem) return <Suspense fallback={null}><AlaNuvem /></Suspense>;
  return (
    <div className="nuvem-coberta" aria-label="Posto da nuvem, coberto: sem uso nesta versão">
      <span className="nuvem-coberta__lona" aria-hidden="true" />
      <span className="nuvem-coberta__txt"><b>Posto da nuvem</b><span className="muted small">Coberto com lona: reservado para trabalhos na nuvem, ainda sem uso nesta versão.</span></span>
    </div>
  );
}

function Espera({ ops }: { ops: AmbientOps }) {
  const nada = !ops.totals.pronto && !ops.totals.bloqueado && !ops.totals.impedido && !ops.totals.falhou;
  return (
    <>
      {nada && <p className="muted small">Nada esperando: tudo o que foi pedido está em andamento ou pronto.</p>}
      {ops.totals.pronto > 0 && <>
        <h3 className="central__sub">Prontos, na vez <span className="muted">{ops.totals.pronto}</span></h3>
        <p className="muted small">A equipe pega de cima para baixo quando abre uma vaga. Para passar um à frente, abra o card e use “Prioridade”: vale na próxima vaga, sem tirar ninguém do que está fazendo.</p>
        <Lista ops={ops} cat="pronto" />
      </>}
      {ops.totals.bloqueado > 0 && <><h3 className="central__sub">Esperando outro trabalho <span className="muted">{ops.totals.bloqueado}</span></h3><Lista ops={ops} cat="bloqueado" /></>}
      {ops.totals.impedido > 0 && <><h3 className="central__sub">Parados por um motivo <span className="muted">{ops.totals.impedido}</span></h3><Lista ops={ops} cat="impedido" /></>}
      {ops.totals.falhou > 0 && <><h3 className="central__sub">Falharam <span className="muted">{ops.totals.falhou}</span></h3><Lista ops={ops} cat="falhou" /></>}
    </>
  );
}

function Voce({ ops }: { ops: AmbientOps }) {
  return (
    <>
      <div className="central__cta">
        <span><b>{ops.decisions.total}</b> {ops.decisions.total === 1 ? 'decisão espera' : 'decisões esperam'} por você (perguntas, aprovações, propostas e regras).</span>
        {ops.decisions.total > 0 && <button className="btn btn--primary btn--sm" onClick={openDecisions} title="O mesmo painel do sino, “Aguardando você”">Responder agora</button>}
      </div>
      {ops.totals.precisa_de_voce > 0 && <>
        <h3 className="central__sub">Trabalhos parados esperando você <span className="muted">{ops.totals.precisa_de_voce}</span></h3>
        <Lista ops={ops} cat="precisa_de_voce" />
      </>}
      {!ops.decisions.total && !ops.totals.precisa_de_voce && <p className="muted small">Nada esperando a sua decisão.</p>}
    </>
  );
}

function Entregas({ ops, onFiles }: { ops: AmbientOps; onFiles: () => void }) {
  const d = ops.deliveries;
  return (
    <>
      <p className="muted small">Concluídos nos últimos {d.days} dias: {d.total}. Conclusão vem do contrato de resultado (ou de você), não só do fim da execução.</p>
      {!d.items.length ? <p className="muted small">Nenhuma entrega nos últimos {d.days} dias.</p> : (
        <ul className="op-list">
          {d.items.map((e) => (
            <li key={e.taskId}>
              <button className="op-row" onClick={() => openCard(e.taskId)} title="Abrir o card com o resultado, as evidências e os arquivos">
                <span className="op-row__ico" aria-hidden="true"><Icon name={e.deliverables ? 'folder' : 'check'} size={16} /></span>
                <span className="op-row__txt">
                  <span className="op-row__title" title={e.title}><span className="muted">#{e.number} </span>{e.title}</span>
                  <span className="op-row__why">{e.by === 'human' ? 'Concluído por você' : e.by === 'external' ? 'Concluído no outro aplicativo' : `Entregue${e.agentName ? ` por ${e.agentName}` : ''}`}
                    {e.deliverables ? ` · ${e.deliverables} ${e.deliverables === 1 ? 'arquivo' : 'arquivos'}` : ' · resposta no card'}<span className="muted"> · {elapsed(e.completedAt)}</span></span>
                  {e.simulated && <span className="op-row__tags"><span className="badge badge--warn">simulação</span></span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {d.total > d.items.length && <p className="muted small">Mostrando as {d.items.length} mais recentes.</p>}
      <p className="central__foot"><button className="link" onClick={onFiles}>Todos os arquivos</button></p>
    </>
  );
}

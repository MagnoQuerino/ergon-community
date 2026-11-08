import { Fragment, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Integration } from '../lib/types.ts';
import { AiAccounts } from '../components/AiAccounts.tsx';
import { ModeloPadrao } from '../components/ModeloPadrao.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { Icon } from '../components/Icon.tsx';

const STATE: Record<Integration['state'], [string, string]> = {
  off: ['não conectado', ''], pending: ['conectando…', 'badge--warn'], connected: ['conectado', 'badge--ok'], error: ['com problema', 'badge--err'],
};

/** Os aplicativos conectados por token ou chave, por tipo. */
const SECOES: Array<{ titulo: string; texto: string; grupos: string[] }> = [
  { titulo: 'Tarefas e quadros', grupos: ['tarefas'], texto: 'Depois de conectar, escolha a lista ou o quadro em Tarefas: fica ligado nos dois sentidos, e os agentes também criam e movem tarefas lá. O token precisa ter permissão de escrita.' },
  { titulo: 'Conversas e equipes', grupos: ['conversas'], texto: 'Os agentes leem o que a conta ou o bot conectado alcança (cada aplicativo diz qual é o alcance) e respondem quando você pede.' },
  { titulo: 'Vendas e atendimento', grupos: ['vendas', 'suporte'], texto: 'Os agentes consultam clientes, negócios e chamados, registram o que combinarem com você e respondem quando você pede.' },
  { titulo: 'Documentos, código e agenda', grupos: ['documentos'], texto: 'Os agentes procuram, leem e escrevem nas páginas, repositórios e compromissos que a credencial alcança.' },
  { titulo: 'Financeiro', grupos: ['financeiro'], texto: 'Só leitura: os agentes consultam cobranças e contas para os seus relatórios. Nada é pago, cobrado ou alterado.' },
];

const badgeOf = (i: Integration): [string, string] => (i.auth === 'soon' ? ['em breve', 'badge--soon'] : STATE[i.state]);

/** O que os agentes fazem em cada conexão ligada, o ajuste da pessoa e a escolha de liberar tudo (GET /api/conexoes). */
interface Permissoes { tipos: Record<string, string>; acoes: Record<string, string> }
interface EstadoConexao { kind: string; faltam: string[]; comErro: string | null; permissoes: Permissoes; acoes: Array<{ id: string; rotulo: string; risco: string }> }
interface EstadoConexoes { liberarTudo: boolean; ligadas: EstadoConexao[] }
/** O estado de uma conexão; pronto = a resposta já chegou (antes disso, as seções guardam o lugar). */
interface EstadoDe { eu: EstadoConexao | null; pronto: boolean; reload: () => void }

/**
 * Conexões, nesta ordem: as contas de IA (recomendando a Nous), o WhatsApp e as contas Microsoft 365 e Google em
 * destaque, e depois os aplicativos de tarefas e quadros, na ordem de fama no Brasil. "Conectado" só depois de
 * conferir com o serviço; "em breve" diz o que falta.
 */
export function ConexoesView() {
  const list = useResource<Integration[]>('/api/integrations', ['integrations.changed']);
  // já buscado por baixo ao abrir o app (App.tsx): as seções que dependem dele abrem prontas
  const cx = useResource<EstadoConexoes>('/api/conexoes', ['integrations.changed']);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [risks, setRisks] = useState(false);
  useEffect(() => {
    const m = location.hash.match(/(microsoft|google)=([a-z]+)/);
    if (m) {
      const who = m[1] === 'google' ? 'Google' : 'Microsoft';
      setNotice(m[2] === 'conectado' ? `Conta ${who} conectada.` : m[2] === 'parcial' ? `Conta ${who} conectada, mas a segunda autorização (Teams) não terminou: e-mail, agenda, arquivos e tarefas funcionam. Se a empresa exige aprovação do administrador, peça a ele.` : m[2] === 'recusado' ? `Login ${m[1] === 'google' ? 'do' : 'da'} ${who} cancelado.` : `Não deu para concluir o login ${m[1] === 'google' ? 'do' : 'da'} ${who}. Tente de novo.`);
      setOpen(m[1]);
      history.replaceState(null, '', '#conexoes');
    }
  }, []);
  const all = list.data ?? [];
  const term = q.trim().toLowerCase();
  const casa = (i: Integration) => (!onlyOn || i.state === 'connected') && (!term || `${i.name} ${i.about}`.toLowerCase().includes(term));
  // WhatsApp tem o próprio destaque
  const apps = all.filter((i) => i.kind !== 'whatsapp' && SECOES.some((x) => x.grupos.includes(i.group)));
  // a ordem do servidor já é a de fama no Brasil; conectadas primeiro, "em breve" por último
  const shown = apps.filter(casa)
    .sort((a, b) => Number(b.state === 'connected') - Number(a.state === 'connected') || Number(a.auth === 'soon') - Number(b.auth === 'soon'));
  const wa = all.find((i) => i.kind === 'whatsapp');
  const accounts = all.filter((i) => i.group === 'contas');
  // os destaques (WhatsApp, Microsoft, Google) entram na conta e na busca: achou, dá para ir até eles
  const destaques = [...(wa ? [wa] : []), ...accounts];
  const achadosNoDestaque = term || onlyOn ? destaques.filter(casa) : [];
  const connected = [...apps, ...destaques].filter((i) => i.state === 'connected').length;
  const ready = [...apps, ...destaques].filter((i) => i.auth !== 'soon').length;
  const irAte = (kind: string) => document.getElementById(`conn-${kind}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const estadoDe = (kind: string): EstadoDe => ({ eu: cx.data?.ligadas.find((x) => x.kind === kind) ?? null, pronto: !!cx.data, reload: cx.reload });
  return (
    <div className="page">
      <header className="page__head">
        <h2>Conexões</h2>
        <p className="muted">A conta de IA que move os agentes e os aplicativos e canais que a equipe usa por você. Credenciais ficam só neste computador, cifradas; nunca no navegador.</p>
      </header>
      {notice && <p className="ok" role="status">{notice}</p>}
      {list.error && <p className="error">{list.error}</p>}

      <section className="conn-group conn-group--feature">
        <h3>Contas de IA</h3>
        <p className="muted small">A conta que paga os modelos que os agentes usam.</p>
        <ModeloPadrao />
        <AiAccounts />
      </section>

      {wa && (
        <section className="conn-group conn-group--feature">
          <h3>WhatsApp <span className="badge badge--exp">Experimental</span></h3>
          <p className="muted small">As conversas que você permitir viram pedidos e tarefas para a equipe, e você pode pedir a um agente que responda. Nada é enviado sem você pedir ou confirmar, a menos que você ligue "Liberar tudo". <button className="link link--inline" onClick={() => setRisks(true)}>Ver informações e riscos</button></p>
          <Detail i={wa} reload={list.reload} estado={estadoDe(wa.kind)} feature />
          {risks && <WhatsAppRisks onClose={() => setRisks(false)} />}
        </section>
      )}

      {accounts.length > 0 && (
        <section className="conn-group conn-group--feature">
          <h3>Microsoft 365 e Google</h3>
          <p className="muted small">Entre com a conta, sem digitar senha no Ergon. Microsoft: Planner, To Do, Teams, e-mail, agenda e arquivos. Google: Tasks, Agenda, Gmail e Drive. Os agentes consultam e agem por você, com a regra de confirmação abaixo.</p>
          <div className="feature-grid">{accounts.map((i) => <Detail key={i.kind} i={i} reload={list.reload} estado={estadoDe(i.kind)} feature />)}</div>
        </section>
      )}

      <LiberarTudo estado={cx} />

      <div className="row row--wrap conn-tools">
        <label className="conn-search"><Icon name="focus" size={14} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar (ex.: Slack, Trello, HubSpot)" aria-label="Procurar aplicativo" /></label>
        <button className={`chip ${!onlyOn ? 'chip--on' : ''}`} aria-pressed={!onlyOn} onClick={() => setOnlyOn(false)}>Todos ({ready})</button>
        <button className={`chip ${onlyOn ? 'chip--on' : ''}`} aria-pressed={onlyOn} onClick={() => setOnlyOn(true)}>Conectados ({connected})</button>
      </div>
      {SECOES.map((sec) => {
        const nela = shown.filter((i) => sec.grupos.includes(i.group));
        if (!nela.length) return null;
        return (
          <section className="conn-group" key={sec.titulo}>
            <h3>{sec.titulo}</h3>
            <p className="muted small">{sec.texto}</p>
            <div className="conn-tiles">
              {nela.map((i) => {
                const [label, cls] = badgeOf(i);
                return (
                  <Fragment key={i.kind}>
                    <button className={`conn-tile ${open === i.kind ? 'conn-tile--on' : ''} ${i.auth === 'soon' ? 'conn-tile--soon' : ''}`} onClick={() => setOpen(open === i.kind ? null : i.kind)} aria-expanded={open === i.kind}>
                      <BrandLogo kind={i.kind} name={i.name} />
                      <span className="conn-tile__txt"><b>{i.name}</b><span className={`badge ${cls}`}>{label}</span></span>
                    </button>
                    {open === i.kind && <Detail i={i} reload={list.reload} estado={estadoDe(i.kind)} onClose={() => setOpen(null)} />}
                  </Fragment>
                );
              })}
            </div>
          </section>
        );
      })}
      {achadosNoDestaque.length > 0 && (
        <p className="muted">Em destaque, acima: {achadosNoDestaque.map((i, n) => <Fragment key={i.kind}>{n ? ', ' : ''}<button className="link link--inline" onClick={() => irAte(i.kind)}>{i.name}</button></Fragment>)}.</p>
      )}
      {list.data && !shown.length && !achadosNoDestaque.length && <p className="muted">Nada encontrado{term ? ` para "${q}"` : ''}.</p>}
    </div>
  );
}

/** Cartão de uma conexão: aberto ao clicar num bloco, ou sempre aberto em destaque (WhatsApp, Microsoft, Google). */
/** Autorização com prazo (Google com o app em teste): avisa a data e, perto do fim, pede para renovar. */
function RenewBy({ at }: { at: string }) {
  const days = Math.ceil((Date.parse(at) - Date.now()) / 86_400_000);
  const date = new Date(at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (days <= 2) return <p className="warn">A autorização vence {days <= 0 ? 'hoje' : `em ${days} dia${days > 1 ? 's' : ''}`} ({date}): clique em Desconectar e entre de novo com o Google para renovar.</p>;
  return <p className="hint">Autorização válida até {date} (app do Google em modo de teste: renove a cada 7 dias; o Briefing avisa antes).</p>;
}

function Detail({ i, reload, estado, onClose, feature }: { i: Integration; reload: () => void; estado: EstadoDe; onClose?: () => void; feature?: boolean }) {
  const [label, cls] = badgeOf(i);
  // o teste apontou permissão que falta ("use o botão Autorizar de novo, acima"): o botão aparece, mesmo sem problema gravado
  const [faltouNoTeste, setFaltouNoTeste] = useState(false);
  // conectou de novo (outra credencial ou outro login): vale o próximo teste
  useEffect(() => { setFaltouNoTeste(false); }, [i.connectedAt]);
  return (
    <article id={`conn-${i.kind}`} className={`card conn ${feature ? 'feature' : 'conn-detail'} ${feature && i.state === 'connected' ? 'feature--on' : ''}`}>
      <header className="row">
        <BrandLogo kind={i.kind} name={i.name} size={feature ? 36 : 32} />
        <strong>{i.name}</strong><span className={`badge ${cls}`}>{label}</span>
        {onClose && <button className="icon-btn conn-detail__x" onClick={onClose} aria-label="Fechar"><Icon name="x" size={16} /></button>}
      </header>
      <p className="muted">{i.about}</p>
      {i.state === 'connected' && i.sharedFrom && <p className="hint">Esta conta vem do workspace <b>{i.sharedFrom}</b>. As permissões e os quadros abaixo são só deste workspace.</p>}
      {i.state !== 'connected' && i.auth !== 'soon' && <UsarDeOutroWorkspace i={i} reload={reload} />}
      {i.state === 'connected' && i.account && <p>Conta: <strong>{i.account}</strong>{i.lastSyncAt ? <span className="muted small"> · última leitura {new Date(i.lastSyncAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span> : null}</p>}
      {/* conectada também: o último problema (ex.: a credencial sem permissão de escrita) fica à vista até a próxima ação dar certo */}
      {i.error && <p className="error">{i.error}</p>}
      {i.state === 'connected' && i.renewBy && <RenewBy at={i.renewBy} />}
      {i.auth === 'soon' ? <p className="hint">{i.soon ?? 'Em preparo.'}</p>
        : i.kind === 'whatsapp' ? <WhatsApp i={i} reload={reload} />
        : i.auth === 'token' ? <TokenConnect i={i} reload={reload} autorizar={faltouNoTeste} />
        : <Sso i={i} reload={reload} faltam={estado.eu?.faltam ?? []} autorizar={faltouNoTeste} />}
      {i.state === 'connected' && i.tasks && <p className="hint">Próximo passo: em <a href="#tarefas">Tarefas</a>, escolha a lista ou o quadro. Dar check ou mover por lá reflete aqui e vice-versa.</p>}
      {i.state === 'connected' && <AcoesDaConexao i={i} estado={estado} />}
      {i.state === 'connected' && <TestarConexao i={i} reload={reload} onFaltou={setFaltouNoTeste} />}
    </article>
  );
}

/**
 * Prova com a conta real: cada capacidade diz se funcionou e, se não, o motivo. A escrita de teste só com o clique, e só
 * onde existe uma escrita inofensiva para testar (os quadros de tarefas; em Microsoft e Google, também um rascunho).
 */
function TestarConexao({ i, reload, onFaltou }: { i: Integration; reload: () => void; onFaltou: (faltou: boolean) => void }) {
  const [itens, setItens] = useState<Array<{ nome: string; ok: boolean; detalhe: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quadros, setQuadros] = useState<Array<{ externalId: string; name: string }> | null>(null);
  const [quadro, setQuadro] = useState('');
  const rodar = async (corpo: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    // o resultado pode ter gravado um problema da conexão (ou apagado o antigo): a tela relê. Permissão que falta (o texto
    // fixo do servidor, FALTA_AUTORIZAR) mostra o "Autorizar de novo" acima
    try {
      const r = await api.post<{ itens: Array<{ nome: string; ok: boolean; detalhe: string }> }>(`/api/conexoes/${i.kind}/testar`, corpo);
      setItens(r.itens); onFaltou(r.itens.some((x) => !x.ok && x.detalhe.startsWith('falta autorizar de novo'))); reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const escrita = async () => {
    if (quadros?.length && quadro) return rodar({ escrita: true, quadro });
    try {
      const r = await api.get<{ lists: Array<{ externalId: string; name: string }> }>(`/api/integrations/${i.kind}/lists`);
      setQuadros(r.lists); setQuadro(r.lists[0]?.externalId ?? '');
      // Microsoft sem lista nem plano: o rascunho de teste roda assim mesmo
      if (!r.lists.length && i.kind === 'microsoft') await rodar({ escrita: true });
    } catch (e) { setErr(errMsg(e)); }
  };
  const semQuadro = !!quadros && !quadros.length;
  return (
    <div className="conn-teste">
      <p className="row row--wrap">
        <button className="btn btn--sm" disabled={busy} onClick={() => void rodar({})}>{busy ? 'Testando…' : 'Testar conexão'}</button>
        {i.tasks && !(semQuadro && i.kind !== 'microsoft') && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void escrita()}>{quadros?.length && quadro ? 'Criar a tarefa de teste' : 'Testar escrita'}</button>}
      </p>
      {!i.tasks && <p className="hint">Aqui o teste só lê; a escrita aparece no primeiro uso.</p>}
      {quadros && (quadros.length
        ? <label className="field">Onde criar a tarefa de teste (fica concluída, pode apagar depois)<select value={quadro} onChange={(e) => setQuadro(e.target.value)}>{quadros.map((q) => <option key={q.externalId} value={q.externalId}>{q.name}</option>)}</select></label>
        : <p className="hint">{i.kind === 'microsoft' ? 'Esta conta não tem lista do To Do nem plano do Planner: o teste de escrita deixa só o rascunho.' : 'Esta conta não tem quadro ou lista para o teste de escrita.'}</p>)}
      {err && <p className="error">{err}</p>}
      {itens && <ul className="conn-teste__lista">{itens.map((x) => <li key={x.nome}><span className={`badge ${x.ok ? 'badge--ok' : 'badge--err'}`}>{x.ok ? 'ok' : 'falhou'}</span> {x.nome}{x.ok ? '' : <span className="muted small"> — {x.detalhe}</span>}</li>)}</ul>}
    </div>
  );
}

const RISCO_ROTULO: Record<string, [string, string]> = {
  ler: ['Ler', 'consultar e buscar'], organizar: ['Escrever', 'criar, mudar e deixar rascunhos nas suas ferramentas'], enviar: ['Enviar', 'mandar algo a outras pessoas'], apagar: ['Apagar', 'apagar ou cancelar'],
};
const AJUSTE_ROTULO: Array<[string, string]> = [['regra', 'Seguir a regra'], ['confirmar', 'Sempre pedir confirmação'], ['desligado', 'Desligado']];

/** O que os agentes podem fazer nesta conexão: por tipo de ação e, abrindo a lista, ação por ação. */
function AcoesDaConexao({ i, estado }: { i: Integration; estado: EstadoDe }) {
  const [err, setErr] = useState<string | null>(null);
  const eu = estado.eu;
  // ainda chegando: o título já ocupa o lugar, para nada abaixo pular quando a lista chegar
  if (!eu) return estado.pronto ? null : <details className="conn-acoes"><summary>O que os agentes podem fazer aqui</summary></details>;
  const salvar = async (p: Permissoes) => { setErr(null); try { await api.put(`/api/conexoes/${i.kind}/permissoes`, { permissoes: p }); estado.reload(); } catch (e) { setErr(errMsg(e)); } };
  const tipos = Object.keys(RISCO_ROTULO).filter((r) => eu.acoes.some((a) => a.risco === r));
  return (
    <details className="conn-acoes">
      <summary>O que os agentes podem fazer aqui ({eu.acoes.length})</summary>
      {/* o envio dos quadros ligados confere o mesmo ajuste: só o desligado o barra */}
      {i.tasks && <p className="hint">Desligar uma ação também impede que o que você faz nos quadros ligados chegue ao aplicativo. "Sempre pedir confirmação" vale só para os agentes.</p>}
      <div className="conn-acoes__tipos">
        {tipos.map((r) => (
          <label key={r} className="field field--inline" title={RISCO_ROTULO[r][1]}>{RISCO_ROTULO[r][0]}
            <select value={eu.permissoes.tipos[r] ?? 'regra'} onChange={(e) => void salvar({ ...eu.permissoes, tipos: { ...eu.permissoes.tipos, [r]: e.target.value } })}>{AJUSTE_ROTULO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        ))}
      </div>
      <ul className="conn-acoes__lista">
        {eu.acoes.map((a) => (
          <li key={a.id}>
            <span>{a.rotulo} <span className="muted small">({RISCO_ROTULO[a.risco]?.[0] ?? a.risco})</span></span>
            <select aria-label={`Ajuste de ${a.rotulo}`} value={eu.permissoes.acoes[a.id] ?? eu.permissoes.tipos[a.risco] ?? 'regra'} onChange={(e) => void salvar({ ...eu.permissoes, acoes: { ...eu.permissoes.acoes, [a.id]: e.target.value } })}>{AJUSTE_ROTULO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </li>
        ))}
      </ul>
      {err && <p className="error">{err}</p>}
    </details>
  );
}

/** Conexão é por workspace: conectar uma conta nova aqui, ou usar a que já está em outro workspace seu. */
function UsarDeOutroWorkspace({ i, reload }: { i: Integration; reload: () => void }) {
  // vem junto da lista de conexões: o bloco abre já com a opção, sem empurrar o formulário depois
  const contas = i.reutilizaveis ?? [];
  const [err, setErr] = useState<string | null>(null);
  if (!contas.length) return null;
  return (
    <div className="conn-reusar">
      <p className="hint">Já conectada em outro workspace seu. Use a mesma conta aqui, sem conectar de novo:</p>
      <p className="row row--wrap">{contas.map((c) => (
        <button key={c.workspaceId} className="btn btn--sm" onClick={async () => { setErr(null); try { await api.post(`/api/conexoes/${i.kind}/usar-de`, { workspaceId: c.workspaceId }); reload(); } catch (e) { setErr(errMsg(e)); } }}>Usar {c.conta ?? 'a conta'} de {c.workspace}</button>
      ))}</p>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** A escolha consciente de tirar as confirmações (desligada por padrão). */
function LiberarTudo({ estado: st }: { estado: { data: EstadoConexoes | null; reload: () => void } }) {
  const [err, setErr] = useState<string | null>(null);
  // a seção fica sempre no lugar; enquanto a escolha não chega (quase nunca: vem na pré-carga), a linha só guarda o espaço
  return (
    <section className="conn-group">
      <h3>O que pede a sua confirmação</h3>
      <p className="muted small">O que você clica vai direto. O que você pede na conversa também, e o agente pergunta se não estiver claro. Pede confirmação: o que não partiu de você (rotina, mensagem recebida, iniciativa do agente), envio a outra pessoa depois de o agente ler conteúdo de fora, e apagar.</p>
      {st.data
        ? <label className="check"><input type="checkbox" checked={st.data.liberarTudo} onChange={async (e) => { setErr(null); try { await api.put('/api/conexoes/liberar-tudo', { on: e.target.checked }); st.reload(); } catch (x) { setErr(errMsg(x)); } }} /> Liberar tudo, por minha conta</label>
        : <span className="check" aria-hidden="true" style={{ visibility: 'hidden' }}><input type="checkbox" tabIndex={-1} readOnly /> Liberar tudo, por minha conta</span>}
      {st.data?.liberarTudo && <p className="warn">Sem confirmações: um e-mail ou mensagem malicioso que um agente leia pode levá-lo a enviar, apagar ou mandar dados seus para fora sem você ver antes.</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Disconnect({ i, reload, label = 'Desconectar' }: { i: Integration; reload: () => void; label?: string }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ask) return <button className="btn btn--sm btn--ghost" onClick={() => setAsk(true)}>{label}</button>;
  // o que acontece de verdade: conta emprestada só deixa de ser usada aqui; a que outros workspaces usam continua com eles
  const outros = i.usadaEm ?? [];
  const efeito = i.sharedFrom ? `Este workspace deixa de usar a conta; ela segue conectada em ${i.sharedFrom}.`
    : outros.length ? `Sai deste workspace, mas ${outros.length === 1 ? `o workspace ${outros[0]} continua` : `os workspaces ${outros.join(', ')} continuam`} usando esta conta. Para cortar o acesso de vez, desconecte lá também.`
    : 'As credenciais guardadas neste computador são apagadas.';
  return (
    <div className="confirm">
      {i.sharedFrom ? 'Deixar de usar' : 'Desconectar'} {i.name}? {efeito} O que já foi lido continua aqui.
      <button className="btn btn--sm btn--primary" onClick={async () => { try { await api.del(`/api/integrations/${i.kind}`); setAsk(false); reload(); } catch (e) { setErr(errMsg(e)); } }}>{i.sharedFrom ? 'Deixar de usar' : 'Desconectar'}</button>
      <button className="btn btn--sm btn--ghost" onClick={() => setAsk(false)}>Cancelar</button>
      {err && <span className="error">{err}</span>}
    </div>
  );
}

/** Credencial colada: um ou mais campos (token, chave, endereço, e-mail), conferidos no serviço antes de conectar. */
function TokenConnect({ i, reload, autorizar }: { i: Integration; reload: () => void; autorizar: boolean }) {
  const [trocar, setTrocar] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  if (i.state === 'connected' && !trocar) return (
    <>
      {ok && <p className="ok" role="status">{ok}</p>}
      {/* o agente ou o teste diz à pessoa "autorizar de novo": aqui isso é colar uma credencial com a permissão que faltou */}
      {(i.error || autorizar) && (
        <div className="conn-reautorizar">
          <p className="warn">Se faltou permissão, gere no {i.name} uma credencial com permissão de escrita e cole aqui.</p>
          <button className="btn btn--primary" onClick={() => { setOk(null); setTrocar(true); }}>Autorizar de novo</button>
        </div>
      )}
      <button className="btn btn--sm btn--ghost" onClick={() => { setOk(null); setTrocar(true); }}>Conectar outra conta neste workspace</button>{' '}
      <Disconnect i={i} reload={reload} label={i.sharedFrom ? 'Deixar de usar neste workspace' : 'Desconectar deste workspace'} />
    </>
  );
  const fields = i.fields.length ? i.fields : [{ name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui', opcional: false }];
  // Trello: com a chave digitada, o link já abre a autorização (leitura e escrita, sem validade) para gerar o token
  const trelloKey = i.kind === 'trello' && /^[a-f0-9]{32}$/i.test((v.key ?? '').trim()) ? v.key.trim() : null;
  return (
    <form className="token-form" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      // o botão nunca fica apagado esperando: faltou um campo, a tela diz qual
      const faltam = fields.filter((f) => !f.opcional && !(v[f.name] ?? '').trim());
      if (faltam.length) { setErr(`Preencha: ${faltam.map((f) => f.label).join(', ')}.`); return; }
      setBusy(true);
      try {
        // campo opcional em branco não vai (ex.: o endereço do GitLab, em branco para gitlab.com)
        const credentials = Object.fromEntries(fields.filter((f) => (v[f.name] ?? '').trim()).map((f) => [f.name, (v[f.name] ?? '').trim()]));
        const r = await api.post<{ account: string }>(`/api/integrations/${i.kind}/token`, { credentials });
        setV({}); setTrocar(false); setOk(`Conectada: ${r.account}.`); reload();
      } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
    }}>
      {i.help && <p className="hint">{i.help.steps} <a href={i.help.url} target="_blank" rel="noreferrer noopener">Abrir a página</a></p>}
      {!!i.help?.extras?.length && <p className="row row--wrap">{i.help.extras.map((x) => ('url' in x
        ? <a key={x.rotulo} className="btn btn--sm btn--ghost" href={x.url} target="_blank" rel="noreferrer noopener">{x.rotulo}</a>
        : <CopiarTexto key={x.rotulo} rotulo={x.rotulo} texto={x.copiar} />))}</p>}
      {trelloKey && <p className="hint"><a href={`https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Ergon&key=${trelloKey}`} target="_blank" rel="noreferrer noopener">Gerar o token (leitura e escrita, sem prazo de validade)</a> e cole abaixo.</p>}
      {fields.map((f) => (
        <label key={f.name} className="field">{f.label}
          <input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={v[f.name] ?? ''} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
        </label>
      ))}
      <p className="row row--wrap">
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Conferindo…' : 'Conectar'}</button>
        {trocar && <button type="button" className="btn btn--ghost" onClick={() => { setTrocar(false); setV({}); setErr(null); }}>Cancelar</button>}
      </p>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

/** Texto longo para colar noutro lugar (ex.: o texto do app do Slack): um botão, em vez do texto no meio dos passos. */
function CopiarTexto({ rotulo, texto }: { rotulo: string; texto: string }) {
  const [feito, setFeito] = useState<'copiado' | 'mostrar' | null>(null);
  useEffect(() => { if (feito !== 'copiado') return; const t = window.setTimeout(() => setFeito(null), 2500); return () => window.clearTimeout(t); }, [feito]);
  return (
    <>
      <button type="button" className="btn btn--sm btn--ghost" onClick={async () => { try { await navigator.clipboard.writeText(texto); setFeito('copiado'); } catch { setFeito('mostrar'); } }}>{feito === 'copiado' ? 'Copiado' : rotulo}</button>
      {/* sem acesso à área de transferência: o texto aparece selecionado, para copiar com Ctrl+C */}
      {feito === 'mostrar' && <textarea className="conn-copiar" readOnly rows={3} value={texto} aria-label={rotulo} ref={(el) => el?.select()} />}
    </>
  );
}

/** Textos de cada login com a conta (o mecanismo é um só no servidor: sso.ts). */
const SSO_TEXT: Record<string, { button: string; what: string; connected: string }> = {
  microsoft: {
    button: 'Entrar com a Microsoft',
    what: 'Você entra na página da Microsoft e autoriza o aplicativo Ergon a usar, em seu nome: tarefas (Planner e To Do), e-mail, agenda, arquivos e, em conta de trabalho, o Teams. Os agentes consultam e agem quando você pede; o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões. Em empresas, o administrador pode precisar aprovar o aplicativo.',
    connected: 'Tarefas: escolha um plano do Planner ou uma lista do To Do em Tarefas. Em conta de trabalho, os agentes também leem e respondem conversas do Teams.',
  },
  google: {
    button: 'Entrar com o Google',
    what: 'Você entra na página do Google e autoriza o aplicativo Ergon a usar, em seu nome: Google Tasks, Agenda, Gmail e Drive. Os agentes consultam e agem quando você pede; o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões.',
    connected: 'Tarefas: escolha uma lista do Google Tasks em Tarefas. Ela fica ligada nos dois sentidos: dar check, mover ou editar aqui muda lá.',
  },
};

function Sso({ i, reload, faltam, autorizar }: { i: Integration; reload: () => void; faltam: string[]; autorizar: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const t = SSO_TEXT[i.kind] ?? { button: `Entrar com ${i.name}`, what: '', connected: '' };
  const entrar = async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); } };
  if (i.state === 'connected') return (
    <>
      {t.connected && <p className="hint">{t.connected}</p>}
      <p><button className="btn btn--sm btn--ghost" onClick={() => void entrar()}>Conectar outra conta neste workspace</button></p>
      {/* faltou permissão (conta antiga, ou o serviço recusou uma ação): o botão que o agente e o teste apontam */}
      {(faltam.length > 0 || !!i.error || autorizar) && (
        <div className="conn-reautorizar">
          {faltam.length > 0 && <p className="warn">Esta conta foi conectada antes de os agentes poderem agir nela. Autorize de novo para liberar as ações novas (a conexão atual continua funcionando enquanto isso).</p>}
          <button className="btn btn--primary" onClick={() => void entrar()}>Autorizar de novo</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <Disconnect i={i} reload={reload} />
    </>
  );
  if (!i.ready) return <p className="hint">Para entrar com a conta, o aplicativo Ergon precisa estar registrado {i.setup?.place ?? 'no provedor'} (passo único de quem instala o Ergon; veja {i.setup?.doc ?? 'a documentação'}). Depois, é só clicar em "{t.button}".</p>;
  return (
    <>
      <button className="btn btn--primary" onClick={async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); reload(); } }}>{t.button}</button>
      {t.what && <p className="hint">{t.what}</p>}
      {err && <p className="error">{err}</p>}
    </>
  );
}

interface WaState { status: string; experimental?: boolean; riscosAceitos?: boolean; qr: string | null; me: string | null; error: string | null; read: number; seen: number; filters: { direct: boolean; groups: boolean; cards: boolean; labels: string[]; exceptions: string[] }; chats: Array<{ id: string; name: string; group: boolean }>; labels: string[] }

function WhatsApp({ i, reload }: { i: Integration; reload: () => void }) {
  const st = useResource<WaState>('/api/integrations/whatsapp', ['integrations.changed', 'events.changed']);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = st.data?.status ?? 'off';
  const [ask, setAsk] = useState(false);
  const [aceite, setAceite] = useState(false);
  const start = async (aceitoRiscos = false) => {
    if (!aceitoRiscos && !st.data?.riscosAceitos) { setAsk(true); return; }
    setErr(null); setBusy(true); setAsk(false);
    try { await api.post('/api/integrations/whatsapp/start', aceitoRiscos ? { aceitoRiscos: true } : {}); st.reload(); reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const stop = async () => { try { await api.post('/api/integrations/whatsapp/stop'); st.reload(); reload(); } catch (e) { setErr(errMsg(e)); } };
  const setF = async (patch: Partial<WaState['filters']>) => { setErr(null); try { await api.put('/api/integrations/whatsapp/filters', patch); st.reload(); } catch (e) { setErr(errMsg(e)); } };
  const f = st.data?.filters;
  return (
    <>
      {i.state !== 'connected' && live !== 'qr' && live !== 'starting' && (
        <>
          <button className="btn btn--primary" onClick={() => void start()} disabled={busy}>Conectar com QR code</button>
          <p className="hint">Experimental: lê as conversas que você permitir e, só quando você pedir ou confirmar, responde por você (com "Liberar tudo" ligado, sem confirmar). Nada é marcado como lido e você não aparece "online". Enviar por um cliente não oficial aumenta o risco de o WhatsApp limitar o número. Usa uma biblioteca de código aberto, não oficial do WhatsApp. Prefira um número de trabalho.</p>
        </>
      )}
      {live === 'starting' && <p className="muted">Preparando o QR code…</p>}
      {live === 'qr' && st.data?.qr && (
        <div className="qr">
          <img src={st.data.qr} alt="QR code para conectar o WhatsApp" width={240} height={240} />
          <ol className="small">
            <li>No celular, abra o WhatsApp.</li>
            <li>Toque em <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b>.</li>
            <li>Aponte a câmera para este código.</li>
          </ol>
          <button className="btn btn--sm btn--ghost" onClick={stop}>Cancelar</button>
        </div>
      )}
      {st.data?.error && <p className="error">{st.data.error}</p>}
      {i.state === 'connected' && f && (
        <div className="wa-filters">
          <p className="small">{live === 'connected' ? <span className="badge badge--ok">lendo agora</span> : <span className="badge badge--warn">{live === 'starting' ? 'reconectando' : 'parado'}</span>} {st.data!.read} mensagens lidas nesta sessão{st.data!.seen > st.data!.read ? ` · ${st.data!.seen - st.data!.read} ignoradas pelos filtros` : ''}</p>
          {live !== 'connected' && live !== 'starting' && <button className="btn btn--sm" onClick={() => void start()}>Retomar leitura</button>}
          <h4>O que é lido</h4>
          <label className="check"><input type="checkbox" checked={f.direct} onChange={(e) => void setF({ direct: e.target.checked })} /> Conversas individuais</label>
          <label className="check"><input type="checkbox" checked={f.groups} onChange={(e) => void setF({ groups: e.target.checked })} /> Grupos</label>
          <label className="check"><input type="checkbox" checked={f.cards} onChange={(e) => void setF({ cards: e.target.checked })} /> Pedidos identificados viram card para a equipe (triagem)</label>
          <ListEditor label="Só conversas com estas etiquetas (WhatsApp Business; vazio = todas)" values={f.labels} suggestions={st.data!.labels} onChange={(labels) => void setF({ labels })} placeholder="ex.: Clientes" />
          <ListEditor label="Nunca ler (exceções: nome ou número)" values={f.exceptions} suggestions={st.data!.chats.map((c) => c.name)} onChange={(exceptions) => void setF({ exceptions })} placeholder="ex.: Família" />
          <Disconnect i={i} reload={() => { st.reload(); reload(); }} label="Desconectar (sai do aparelho)" />
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {i.state === 'connected' && st.data && !st.data.riscosAceitos && (
        <div className="conn-reautorizar">
          <p className="warn">Os agentes agora podem responder pelo WhatsApp quando você pede. Antes do primeiro envio, leia as informações e os riscos.</p>
          <button className="btn btn--primary" onClick={() => setAceite(true)}>Ver e aceitar</button>
        </div>
      )}
      {aceite && <WhatsAppRisks onClose={() => setAceite(false)} onAccept={async () => { setAceite(false); try { await api.post('/api/integrations/whatsapp/aceitar-riscos'); st.reload(); } catch (e) { setErr(errMsg(e)); } }} />}
      {ask && <WhatsAppRisks onClose={() => setAsk(false)} onAccept={() => void start(true)} />}
    </>
  );
}

/** Informações e riscos do WhatsApp experimental. Com onAccept, conectar só depois do "li e entendi". Mudou o texto
 *  em algo que importa? Suba WA_RISKS_VERSION (server/src/services/whatsapp.ts) para pedir o aceite de novo. */
function WhatsAppRisks({ onClose, onAccept }: { onClose: () => void; onAccept?: () => void }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="wa-risks-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="auth__card wa-risks">
        <h2 className="auth__title" id="wa-risks-title">WhatsApp (experimental): informações e riscos</h2>
        <h4>Como funciona</h4>
        <ul className="small">
          <li>Você lê um QR code com o celular e este computador vira um <b>aparelho conectado</b> da sua conta, como o WhatsApp Web.</li>
          <li>A conexão usa uma biblioteca de código aberto (Baileys) que <b>não é oficial</b> nem aprovada pelo WhatsApp ou pela Meta.</li>
          <li><b>Envio só quando pedido:</b> os agentes enviam da sua conta quando você pede ou confirma num cartão. Se você ligar "Liberar tudo" em Conexões, o que não partiu de você (uma rotina, uma mensagem recebida) também pode sair sem cartão. Ler não marca como lido e você não aparece "online".</li>
          <li>Só entram as conversas que os filtros permitem (grupos começam desligados), e dá para pôr exceções, como "Família".</li>
        </ul>
        <h4>Riscos</h4>
        <ul className="small">
          <li><b>Enviar aumenta o risco:</b> mensagens automáticas e denúncias de quem recebe podem levar a restrição ou banimento. Evite escrever a quem nunca falou com você.</li>
          <li><b>O número pode ser restringido ou banido.</b> Os termos do WhatsApp não permitem clientes não oficiais. Use um número de trabalho ou secundário, nunca um número do qual você não pode abrir mão.</li>
          <li><b>Pode parar de funcionar sem aviso</b> quando o WhatsApp muda a forma de conectar. Nesse caso, a leitura para até uma versão nova corrigir.</li>
          <li><b>A sessão fica neste computador</b>, cifrada junto com os seus dados. Quem tiver acesso a ela consegue ler as suas conversas como aparelho conectado. Mantenha o computador com senha e guarde os backups com cuidado.</li>
          <li><b>As mensagens lidas vão para o modelo de IA</b> que você configurou, para identificar pedidos. Se o modelo é de um serviço na internet, o texto passa por esse serviço. Respeite a privacidade de quem fala com você (LGPD).</li>
          <li><b>Licença diferente:</b> a biblioteca usa um componente sob GPL-3.0 (libsignal), distribuído junto com este recurso. Detalhes no arquivo NOTICE.</li>
        </ul>
        <h4>Para parar</h4>
        <p className="small">Em Conexões, "Desconectar (sai do aparelho)" encerra a sessão e apaga a cópia local. Você também pode remover o aparelho no celular, em <b>Aparelhos conectados</b>.</p>
        {onAccept ? (
          <>
            <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Li e entendi os riscos. Quero conectar mesmo assim.</label>
            <button className="btn btn--primary btn--block" disabled={!ok} onClick={onAccept}>Aceitar e mostrar o QR code</button>
            <button className="btn btn--block auth__alt" onClick={onClose}>Agora não</button>
          </>
        ) : (
          <button className="btn btn--block" onClick={onClose}>Fechar</button>
        )}
      </div>
    </div>
  );
}

function ListEditor({ label, values, suggestions, onChange, placeholder }: { label: string; values: string[]; suggestions: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [v, setV] = useState('');
  const add = (x: string) => { const s = x.trim(); if (s && !values.includes(s)) onChange([...values, s]); setV(''); };
  const sugg = suggestions.filter((s) => !values.includes(s) && (!v || s.toLowerCase().includes(v.toLowerCase()))).slice(0, 6);
  return (
    <div className="field">
      {label}
      <div className="row row--wrap">
        {values.map((x) => <span key={x} className="skill">{x} <button className="x" onClick={() => onChange(values.filter((y) => y !== x))} aria-label={`Tirar ${x}`}>×</button></span>)}
        <form className="row" onSubmit={(e) => { e.preventDefault(); add(v); }}><input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={label} /></form>
      </div>
      {sugg.length > 0 && v && <div className="row row--wrap">{sugg.map((s) => <button key={s} className="chip" onClick={() => add(s)}>+ {s}</button>)}</div>}
    </div>
  );
}

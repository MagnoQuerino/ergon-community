import { Fragment, useEffect, useState, type ChangeEvent } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { ESCOLHA_CONSCIENTE, NOME_ESCOLHIDO, PROBLEMA_TEAMS, SO_O_SEU_CODIGO, linhaDoEstado, previaDaConta, type ContaDoTeams } from '../lib/teams-app.ts';
import type { EtapaConsentimento, Integration } from '../lib/types.ts';
import { AVISO_APROVAR_SEM_CARTAO, ROTULO_APROVAR_DEPOIS_DE_LER, ROTULO_CONFIRMAR_ORGANIZAR, erroDaConexao, motivoDoLogin, oQuePedirAoAdministrador, proximoPassoTarefas, textoDaVolta } from '../lib/textos-tela.ts';
import { AiAccounts } from '../components/AiAccounts.tsx';
import { ModeloPadrao } from '../components/ModeloPadrao.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { TextoLongo } from '../components/TextoLongo.tsx';
import { BotoesRegra, type Alcance } from '../components/CartaoRegra.tsx';

const STATE: Record<Integration['state'], [string, string]> = {
  off: ['não conectado', ''], pending: ['conectando…', 'badge--warn'], connected: ['conectado', 'badge--ok'], error: ['com problema', 'badge--err'],
};

/** Os aplicativos conectados por token ou chave, por tipo. */
const SECOES: Array<{ titulo: string; texto: string; grupos: string[] }> = [
  { titulo: 'Tarefas e quadros', grupos: ['tarefas'], texto: 'Depois de conectar, escolha a lista ou o quadro em Tarefas: fica ligado nos dois sentidos, e os agentes também criam e movem tarefas lá. A conta precisa ter permissão para alterar as tarefas.' },
  { titulo: 'Conversas e equipes', grupos: ['conversas'], texto: 'Os agentes leem o que a conta ou o bot conectado alcança (cada aplicativo diz qual é o alcance) e respondem quando você pede.' },
  { titulo: 'Vendas e atendimento', grupos: ['vendas', 'suporte'], texto: 'Os agentes consultam clientes, negócios e chamados, registram o que combinarem com você e respondem quando você pede.' },
  { titulo: 'Documentos, código e agenda', grupos: ['documentos'], texto: 'Os agentes procuram, leem e escrevem nas páginas, repositórios e compromissos que a credencial alcança.' },
  { titulo: 'Financeiro', grupos: ['financeiro'], texto: 'Os agentes consultam cobranças e contas e, quando você pede, cadastram clientes e criam cobranças e contas a receber. Nada é pago, transferido, estornado ou cancelado por aqui. Para só consultar, marque "Só leitura" na conexão.' },
];

const badgeOf = (i: Integration): [string, string] => (i.auth === 'soon' ? ['em breve', 'badge--soon'] : STATE[i.state]);

/** O que os agentes fazem em cada conexão ligada, o ajuste da pessoa e a escolha de liberar tudo (GET /api/conexoes). */
interface Permissoes { tipos: Record<string, string>; acoes: Record<string, string> }
/** etapas: só na Microsoft (o que a conta já liberou, etapa por etapa) */
/** soLeitura: tudo o que escreve está desligado; escreve: a conexão tem alguma ação que escreve (o atalho só aparece aí) */
interface EstadoConexao { kind: string; faltam: string[]; comErro: string | null; permissoes: Permissoes; acoes: Array<{ id: string; rotulo: string; risco: string }>; soLeitura?: boolean; escreve?: boolean; etapas?: EtapaConsentimento[] }
interface EstadoConexoes { liberarTudo: boolean; aprovarDepoisDeLer?: boolean; aprovarDepoisDeLerBarra?: boolean; confirmarOrganizar?: boolean; ligadas: EstadoConexao[] }
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
  // a volta do login: o aviso depende de a conta já estar conectada (o botão que ele cita é outro), por isso sai na hora de mostrar
  const [volta, setVolta] = useState<{ kind: 'microsoft' | 'google'; status: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [risks, setRisks] = useState(false);
  useEffect(() => {
    const m = location.hash.match(/(microsoft|google)=([a-z-]+)/);
    if (m) {
      setVolta({ kind: m[1] === 'google' ? 'google' : 'microsoft', status: m[2] });
      setOpen(m[1]);
      history.replaceState(null, '', '#conexoes');
    }
    // "#conexoes?regras" (de "Aguardando você", do endereço antigo de Atividade): vai direto às Regras
    let t = 0;
    const irRegras = () => { if (/[?&]regras\b/.test(location.hash)) t = window.setTimeout(() => document.getElementById('conn-regras')?.scrollIntoView({ block: 'start' })); };
    irRegras();
    window.addEventListener('hashchange', irRegras);
    return () => { window.clearTimeout(t); window.removeEventListener('hashchange', irRegras); };
  }, []);
  // vinda da Atividade (#conexoes?app=trello): abre o bloco daquela conexão e rola até ele, quando a lista chega
  const [alvo] = useState(() => { const k = new URLSearchParams(location.hash.split('?')[1] ?? '').get('app'); return k && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(k) ? k : null; });
  useEffect(() => {
    if (!alvo || !list.data) return;
    history.replaceState(null, '', '#conexoes');
    if (!list.data.some((i) => i.kind === alvo)) return;
    setOpen(alvo);
    const t = window.setTimeout(() => document.getElementById(`conn-${alvo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return () => window.clearTimeout(t);
  }, [alvo, !!list.data]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {volta && list.data && <p className="ok" role="status">{textoDaVolta(volta.kind, volta.status, all.find((i) => i.kind === volta.kind)?.state === 'connected')}</p>}
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
          {/* duas coisas diferentes que o nome "Teams" junta: a conta (agora) e conversar com o coordenador por lá (depois) */}
          <ul className="conn-explica small">
            <li><b>Microsoft 365: a equipe age na sua conta.</b> Com o seu login, os agentes leem e respondem por você no e-mail, na agenda, nos arquivos, nas tarefas e no Teams, quando você pede ou numa rotina. Ninguém fica olhando a conta o tempo todo.</li>
            <li><b>Conversar com a equipe pelo Teams: é outra coisa.</b> Você manda pedidos à equipe de dentro do Teams, como se ela fosse um colega lá, e recebe as respostas ali. Fica logo abaixo, em Teams (em breve).</li>
          </ul>
          <div className="feature-grid">{accounts.map((i) => <Detail key={i.kind} i={i} reload={list.reload} estado={estadoDe(i.kind)} feature />)}</div>
        </section>
      )}

      <section className="conn-group conn-group--feature" id="conn-teams-app">
        <h3>Teams</h3>
        <TeamsConversa />
      </section>

      <LiberarTudo estado={cx} />
      <Regras />

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

/** O texto com a palavra "Tarefas" virando o link para a tela de Tarefas. */
function ComLinkTarefas({ texto }: { texto: string }) {
  const [antes, ...depois] = texto.split('Tarefas');
  return <>{antes}{depois.length > 0 && <><a href="#tarefas">Tarefas</a>{depois.join('Tarefas')}</>}</>;
}

function Detail({ i, reload, estado, onClose, feature }: { i: Integration; reload: () => void; estado: EstadoDe; onClose?: () => void; feature?: boolean }) {
  const [label, cls] = badgeOf(i);
  // o teste apontou permissão que falta ("use o botão Autorizar de novo, acima"): o botão aparece, mesmo sem problema gravado
  const [faltouNoTeste, setFaltouNoTeste] = useState(false);
  // conectou de novo (outra credencial ou outro login): vale o próximo teste
  useEffect(() => { setFaltouNoTeste(false); }, [i.connectedAt]);
  const erro = erroDaConexao(i);
  // na Microsoft, escolher a lista depende da leitura: o passo só depois de saber o que a conta liberou (sem trocar de texto na tela)
  const passo = i.state === 'connected' && i.tasks && (i.kind !== 'microsoft' || estado.pronto) ? proximoPassoTarefas(i.kind, estado.eu?.etapas ?? []) : null;
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
      {/* conectada também: o último problema (ex.: a credencial sem permissão de escrita) fica à vista até a próxima ação dar
          certo; o pedido ao administrador no primeiro acesso não é falha (o cartão explica), e o erro cru do login não aparece */}
      {erro && <p className="error">{erro}</p>}
      {i.state === 'connected' && i.renewBy && <RenewBy at={i.renewBy} />}
      {i.auth === 'soon' ? <p className="hint">{i.soon ?? 'Em preparo.'}</p>
        : i.kind === 'whatsapp' ? <WhatsApp i={i} reload={reload} />
        : i.auth === 'token' ? <TokenConnect i={i} reload={reload} autorizar={faltouNoTeste} />
        : <Sso i={i} reload={reload} faltam={estado.eu?.faltam ?? []} etapas={estado.eu?.etapas ?? []} recarregar={estado.reload} autorizar={faltouNoTeste} />}
      {passo && <p className="hint">{passo.link ? <ComLinkTarefas texto={passo.texto} /> : passo.texto}</p>}
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
  // o erro do atalho fica junto da caixa: a lista abaixo vem fechada, e o erro lá dentro ninguém veria
  const [errSoLeitura, setErrSoLeitura] = useState<string | null>(null);
  const eu = estado.eu;
  // ainda chegando: o título já ocupa o lugar, para nada abaixo pular quando a lista chegar
  if (!eu) return estado.pronto ? null : <details className="conn-acoes"><summary>O que os agentes podem fazer aqui</summary></details>;
  const salvar = async (p: Permissoes) => { setErr(null); try { await api.put(`/api/conexoes/${i.kind}/permissoes`, { permissoes: p }); estado.reload(); } catch (e) { setErr(errMsg(e)); } };
  const tipos = Object.keys(RISCO_ROTULO).filter((r) => eu.acoes.some((a) => a.risco === r));
  const soLeitura = async (on: boolean) => { setErrSoLeitura(null); try { await api.put(`/api/conexoes/${i.kind}/so-leitura`, { on }); estado.reload(); } catch (e) { setErrSoLeitura(errMsg(e)); } };
  return (
    <>
    {/* um clique: tudo o que escreve nesta conexão fica desligado; desmarcar devolve o ajuste de escrita de antes */}
    {eu.escreve && (
      <div className="conn-so-leitura">
        <label className="check"><input type="checkbox" checked={!!eu.soLeitura} onChange={(e) => void soLeitura(e.target.checked)} /> Só leitura</label>
        <span className="muted small"> {eu.soLeitura ? 'Os agentes só consultam aqui: nada é criado, mudado, enviado ou apagado. Desmarcar devolve o ajuste de antes.' : 'Marque para os agentes só consultarem aqui, sem criar, mudar, enviar ou apagar nada.'}</span>
        {errSoLeitura && <p className="error" role="alert">{errSoLeitura}</p>}
      </div>
    )}
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
    </>
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

/**
 * As escolhas de cuidado, todas desligadas por padrão: pedir confirmação antes de organizar, pedir aprovação antes de abrir
 * sites ou rodar programas depois de ler as contas, e (escolha consciente) tirar as confirmações.
 */
/** GET /api/conexoes/regras (server/src/services/conexoes/regras.ts, tela) */
interface TelaRegras {
  regras: Array<{ id: string; tipo: 'acao' | 'depois_de_ler'; texto: string; alcance: 'pedido' | '24h' | 'sempre'; alcanceTexto: string; criadaEm: string; apagar: boolean; usos: number }>;
  texto: Array<{ id: string; text: string; created_at: string }>;
  propostas: { texto: Array<{ id: string; text: string; created_at: string }>; cartoes: Array<{ id: string; summary: string; alcance: Alcance; agent_name: string | null; created_at: string }> };
}
const dia = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
/**
 * Conexões › Regras, o lugar único das regras: o que você liberou para a equipe fazer sem pedir a sua confirmação (com
 * desfazer), as regras de texto que valem nas conversas (com desligar) e o que foi proposto e espera você.
 */
function Regras() {
  const r = useResource<TelaRegras>('/api/conexoes/regras', ['rules.changed', 'proposals.changed']);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [indo, setIndo] = useState<string | null>(null);
  const fazer = async (id: string, fn: () => Promise<unknown>, feito: string) => {
    setErr(null); setOk(null); setIndo(id);
    try { const x = await fn() as { result?: string } | undefined; setOk(x?.result ?? feito); } catch (e) { setErr(errMsg(e)); } finally { setIndo(null); r.reload(); }
  };
  const d = r.data;
  const vazio = d && !d.regras.length && !d.texto.length && !d.propostas.texto.length && !d.propostas.cartoes.length;
  return (
    <section className="conn-group" id="conn-regras">
      <h3>Regras</h3>
      <p className="muted small">Para dar mais autonomia à equipe, peça na conversa, por exemplo: “podem mandar os e-mails sem me pedir aprovação”. Aparece um cartão para você escolher até quando vale: só naquele pedido, por 24 h ou sempre. Apagar só entra quando você fala em apagar. A segurança fica por sua conta: o que você libera aqui vale também quando a equipe trabalha sozinha e depois de ler mensagens de outras pessoas. Desfazer vale na hora.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}
      {!d && r.error && <p className="error">{r.error}</p>}
      {vazio && <p className="muted">Nenhuma regra por enquanto: tudo segue o que está acima.</p>}

      {!!d?.propostas.cartoes.length && <h4 className="rt-sub">Esperando você</h4>}
      {d?.propostas.cartoes.map((c) => (
        <article key={c.id} className="dec-card">
          <div className="dec-card__top"><span className="badge">regra proposta{c.agent_name ? ` · ${c.agent_name}` : ''}</span></div>
          <div className="dec-card__txt"><TextoLongo texto={c.summary} /></div>
          <div className="row row--wrap dec-card__acts">
            {indo === c.id ? <span className="badge" role="status">Aplicando…</span>
              : <BotoesRegra sugerido={c.alcance} ocupado={!!indo} onEscolher={(alcance) => void fazer(c.id, () => api.post(`/api/proposals/${c.id}`, { decision: 'apply', alcance }), 'Regra aplicada.')}
                onRecusar={() => void fazer(c.id, () => api.post(`/api/proposals/${c.id}`, { decision: 'reject' }), 'Recusada.')} />}
          </div>
        </article>
      ))}
      {d?.propostas.texto.map((t) => (
        <article key={t.id} className="dec-card">
          <div className="dec-card__top"><span className="badge">regra de conversa proposta</span></div>
          <div className="dec-card__txt">{t.text}</div>
          <div className="row row--wrap dec-card__acts">
            <button className="btn btn--sm btn--primary" disabled={!!indo} onClick={() => void fazer(t.id, () => api.post(`/api/rules/${t.id}`, { decision: 'active' }), 'Regra ativada.')}>Ativar</button>
            <button className="btn btn--sm btn--ghost" disabled={!!indo} onClick={() => void fazer(t.id, () => api.post(`/api/rules/${t.id}`, { decision: 'rejected' }), 'Recusada.')}>Recusar</button>
          </div>
        </article>
      ))}

      {!!d?.regras.length && <h4 className="rt-sub">Liberado sem pedir a sua confirmação</h4>}
      {d?.regras.map((x) => (
        <div key={x.id} className="regra-linha">
          <span className="regra-linha__txt"><b>{x.texto.charAt(0).toUpperCase() + x.texto.slice(1)}</b>
            <span className="muted small"> · {x.alcanceTexto} · desde {dia(x.criadaEm)}{x.tipo === 'acao' ? ` · ${!x.usos ? 'ainda não usada' : x.usos === 1 ? 'usada 1 vez' : `usada ${x.usos} vezes`}` : ''}</span></span>
          <button className="btn btn--sm" disabled={!!indo} onClick={() => void fazer(x.id, () => api.post(`/api/conexoes/regras/${x.id}/desfazer`), 'Desfeita: volta a pedir a sua confirmação.')}>{indo === x.id ? 'Desfazendo…' : 'Desfazer'}</button>
        </div>
      ))}

      {!!d?.texto.length && <h4 className="rt-sub">Combinado nas conversas</h4>}
      {d?.texto.map((t) => (
        <div key={t.id} className="regra-linha">
          <span className="regra-linha__txt">{t.text}<span className="muted small"> · desde {dia(t.created_at)}</span></span>
          <button className="btn btn--sm" disabled={!!indo} onClick={() => void fazer(t.id, () => api.post(`/api/rules/${t.id}`, { decision: 'rejected' }), 'Desligada.')}>{indo === t.id ? 'Desligando…' : 'Desligar'}</button>
        </div>
      ))}
    </section>
  );
}

function LiberarTudo({ estado: st }: { estado: { data: EstadoConexoes | null; reload: () => void } }) {
  const [err, setErr] = useState<string | null>(null);
  const trocar = (rota: string) => async (e: ChangeEvent<HTMLInputElement>) => { setErr(null); try { await api.put(rota, { on: e.target.checked }); st.reload(); } catch (x) { setErr(errMsg(x)); } };
  // a seção fica sempre no lugar; enquanto a escolha não chega (quase nunca: vem na pré-carga), a linha só guarda o espaço
  const opcao = (ligada: boolean | undefined, rota: string, rotulo: string) => st.data
    ? <label className="check"><input type="checkbox" checked={!!ligada} onChange={trocar(rota)} /> {rotulo}</label>
    : <span className="check" aria-hidden="true" style={{ visibility: 'hidden' }}><input type="checkbox" tabIndex={-1} readOnly /> {rotulo}</span>;
  return (
    <section className="conn-group">
      <h3>O que pede a sua confirmação</h3>
      <p className="muted small">O que você clica vai direto. O que você pede na conversa também, e o agente pergunta se não estiver claro. Pede confirmação: o que não partiu de você (rotina, mensagem recebida, iniciativa do agente), envio a outra pessoa depois de o agente ler conteúdo de fora, e apagar. Criar cobrança no Asaas também pede sempre, mesmo pedida por você e com "Liberar tudo" ligado, porque o cliente é avisado na hora.</p>
      {opcao(st.data?.confirmarOrganizar, '/api/conexoes/confirmar-organizar', ROTULO_CONFIRMAR_ORGANIZAR)}
      <p className="muted small">Organizar é criar, mudar e deixar rascunhos nas suas ferramentas. Sem esta opção, o que você pede na conversa vai direto, mesmo que o agente tenha lido e-mails antes.</p>
      {opcao(st.data?.aprovarDepoisDeLer, '/api/conexoes/aprovar-depois-de-ler', ROTULO_APROVAR_DEPOIS_DE_LER)}
      <p className="muted small">Os agentes tratam o que leem como informação, nunca como ordem. Com esta opção, depois de ler e-mails, mensagens ou arquivos das suas contas, abrir um site ou rodar um programa espera o seu clique num cartão. No cartão, você escolhe por quanto tempo vale: 1 h, 8 h ou 72 h naquela conversa ou card, ou sempre (em todas, até você desfazer em Regras, abaixo). Aprovar libera o grupo inteiro: qualquer site, ou qualquer programa. A busca na internet segue valendo.</p>
      {st.data?.aprovarDepoisDeLerBarra && <p className="warn">{AVISO_APROVAR_SEM_CARTAO}</p>}
      {opcao(st.data?.liberarTudo, '/api/conexoes/liberar-tudo', 'Liberar tudo, por minha conta')}
      {st.data?.liberarTudo && <p className="warn">Sem confirmações: um e-mail ou mensagem malicioso que um agente leia pode levá-lo a enviar, apagar ou mandar dados seus para fora sem você ver antes. A aprovação para abrir sites e rodar programas também sai. O que você ajustou em cada conexão, "sempre pedir confirmação antes de organizar" e o cartão de criar cobrança no Asaas continuam valendo.</p>}
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
      {/* conectada do jeito antigo (ex.: Pipefy com o código pessoal): funciona, e o botão leva ao jeito novo */}
      {i.aviso && (
        <div className="conn-reautorizar">
          <p className="warn">{i.aviso}</p>
          <button className="btn btn--primary" onClick={() => { setOk(null); setTrocar(true); }}>Reconectar do novo jeito</button>
        </div>
      )}
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
      {i.help?.antes && <p className="warn conn-antes" role="note">{i.help.antes}</p>}
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
    what: 'Você entra na página da Microsoft e autoriza o aplicativo Ergon a usar, em seu nome: tarefas (Planner e To Do), e-mail, agenda, arquivos e, em conta de trabalho, o Teams. Os agentes consultam e agem quando você pede; o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões. A autorização vem em partes: primeiro enviar e-mail, criar arquivos e o Teams, que qualquer conta autoriza; depois a leitura (e-mail, agenda, arquivos, tarefas), que numa empresa costuma precisar da aprovação do administrador. Se precisar, a tela mostra o pedido pronto para você enviar a ele.',
    connected: 'Tarefas: escolha um plano do Planner ou uma lista do To Do em Tarefas (depois de liberada a leitura). Em conta de trabalho, os agentes também mandam mensagens no Teams e, com a leitura liberada, leem as conversas.',
  },
  google: {
    button: 'Entrar com o Google',
    what: 'Você entra na página do Google e autoriza o aplicativo Ergon a usar, em seu nome: Google Tasks, Agenda, Gmail e Drive. Os agentes consultam e agem quando você pede; o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões.',
    connected: 'Tarefas: escolha uma lista do Google Tasks em Tarefas. Ela fica ligada nos dois sentidos: dar check, mover ou editar aqui muda lá.',
  },
};

function Sso({ i, reload, faltam, etapas, recarregar, autorizar }: { i: Integration; reload: () => void; faltam: string[]; etapas: EtapaConsentimento[]; recarregar: () => void; autorizar: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const t = SSO_TEXT[i.kind] ?? { button: `Entrar com ${i.name}`, what: '', connected: '' };
  const entrar = async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); } };
  if (i.state === 'connected') return (
    <>
      {t.connected && <p className="hint">{t.connected}</p>}
      {i.kind === 'microsoft' && etapas.length > 0 && <EtapasMicrosoft etapas={etapas} recarregar={recarregar} />}
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
  const comecar = async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); reload(); } };
  // a empresa exige o administrador já no primeiro login: o pedido vem pronto aqui, antes de haver conta conectada
  if (i.adminBase) return (
    <>
      <div className="conn-etapas conn-reautorizar">
        <h4>A sua empresa precisa aprovar o Ergon</h4>
        <p className="small">A conta Microsoft da sua empresa não deixa ninguém autorizar o Ergon sozinho: quem administra a conta aprova uma vez, e depois você entra normalmente.</p>
        {/* o primeiro acesso pede tudo de uma vez: a mensagem ao administrador diz tudo o que o link pede */}
        <PedirAoAdministrador link={i.adminBase.link} etapa="base" depois="Já aprovaram? Entrar de novo" />
        <p className="row row--wrap"><button className="btn btn--primary" onClick={() => void comecar()}>Já aprovaram? Entrar de novo</button></p>
      </div>
      {err && <p className="error">{err}</p>}
    </>
  );
  return (
    <>
      <button className="btn btn--primary" onClick={() => void comecar()}>{t.button}</button>
      {t.what && <p className="hint">{t.what}</p>}
      {err && <p className="error">{err}</p>}
    </>
  );
}

/** O que cada etapa da Microsoft libera, dito para a pessoa (sso.ts tem as permissões de cada uma). */
const ETAPA_TEXTO: Record<EtapaConsentimento['id'], { titulo: string; oQue: string }> = {
  base: { titulo: 'Enviar e-mail e criar arquivos', oQue: 'enviar e-mail em seu nome e criar arquivos no OneDrive' },
  trabalho: { titulo: 'Teams: conversas e mensagens', oQue: 'ver as suas conversas e times e mandar mensagens no Teams' },
  leitura: { titulo: 'Ler e organizar', oQue: 'ler e-mail, agenda, arquivos, tarefas (Planner e To Do), contatos e o conteúdo das conversas do Teams' },
  canais: { titulo: 'Ler os canais do Teams (opcional)', oQue: 'ler as mensagens dos canais dos times' },
};

/**
 * O que a conta Microsoft já liberou, etapa por etapa, e o próximo passo de cada uma: liberar (a própria pessoa), pedir ao
 * administrador (o link pronto, que ela mesma copia e envia) ou entrar de novo depois que ele aprovou.
 */
function EtapasMicrosoft({ etapas, recarregar }: { etapas: EtapaConsentimento[]; recarregar: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const pedir = async (etapa: EtapaConsentimento['id']) => {
    setErr(null);
    // a etapa base é o login inteiro (escolhe a conta e segue sozinho pelas outras)
    try { const r = await api.post<{ url: string }>('/api/integrations/microsoft/start', etapa === 'base' ? {} : { etapa }); location.href = r.url; } catch (e) { setErr(errMsg(e)); recarregar(); }
  };
  return (
    <div className="conn-etapas conn-reautorizar">
      <h4>O que esta conta já liberou</h4>
      <ul className="conn-teste__lista conn-etapas__lista">{etapas.map((e) => <EtapaLinha key={e.id} e={e} pedir={() => void pedir(e.id)} />)}</ul>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function EtapaLinha({ e, pedir }: { e: EtapaConsentimento; pedir: () => void }) {
  const t = ETAPA_TEXTO[e.id];
  // o motivo gravado na etapa, em português (o erro da Microsoft fica só no registro)
  const motivo = motivoDoLogin(e.erro);
  const titulo = <><b>{t.titulo}</b> <span className="muted small">({t.oQue})</span></>;
  if (e.estado === 'ok') return <li><span className="badge badge--ok">liberado</span> {titulo}</li>;
  if (e.estado === 'aprovado') return (
    <li><span className="badge badge--ok">aprovado pelo administrador</span> {titulo}
      <p className="row row--wrap"><button className="btn btn--sm btn--primary" onClick={pedir}>Autorizar agora</button><span className="muted small">Falta só você entrar de novo para a aprovação valer aqui.</span></p>
    </li>
  );
  if (e.estado === 'pedido') return (
    <li><span className="badge badge--warn">esperando a Microsoft</span> {titulo}
      <p className="row row--wrap"><span className="muted small">A página da Microsoft está aberta. Se você a fechou, abra de novo.</span><button className="btn btn--sm btn--ghost" onClick={pedir}>Abrir de novo</button></p>
    </li>
  );
  // na empresa, leitura e canais costumam ser do administrador (e o Teams, quando a empresa exige): o pedido vem pronto, e quem
  // envia é a pessoa. Os canais são opcionais e o login segue até eles sozinho: voltar sem eles é esperado, nada em vermelho
  if (e.administrador && e.link && (e.estado === 'bloqueado' || e.opcional)) return (
    <li><span className={`badge ${e.estado === 'bloqueado' && !e.opcional ? 'badge--err' : ''}`}>precisa do administrador</span> {titulo}
      <p className="small">{e.opcional ? 'Opcional. Ler os canais sempre precisa da aprovação do administrador da empresa.' : 'Precisa da aprovação do administrador da empresa.'}{motivo ? <span className="muted"> {motivo}</span> : null}</p>
      <PedirAoAdministrador link={e.link} etapa={e.id} />
      <p className="row row--wrap"><button className="btn btn--sm btn--primary" onClick={pedir}>Já aprovaram? Conectar de novo</button></p>
    </li>
  );
  return (
    <li><span className="badge">{e.estado === 'bloqueado' ? 'não liberado' : 'falta liberar'}</span> {titulo}
      {motivo && <p className="muted small">{motivo}</p>}
      <p className="row row--wrap">
        <button className="btn btn--sm btn--primary" onClick={pedir}>{e.estado === 'bloqueado' ? 'Tentar de novo' : e.id === 'leitura' ? 'Liberar leitura' : e.id === 'base' ? 'Autorizar de novo' : 'Liberar'}</button>
        {e.administrador && <span className="muted small">Numa empresa, isto costuma precisar da aprovação do administrador.</span>}
      </p>
      {/* quem já sabe que a empresa exige o administrador vai direto ao pedido, sem passar pela página da Microsoft */}
      {e.administrador && e.link && <details><summary className="small">Pedir ao administrador</summary><PedirAoAdministrador link={e.link} etapa={e.id} /></details>}
    </li>
  );
}

/**
 * O pedido ao administrador: o link (escopos explícitos, para ele ver exatamente o que aprova) e uma mensagem pronta. A pessoa
 * copia e envia ela mesma; nada sai daqui sozinho. Quem aprova abre noutro computador, e a página final tenta voltar para este:
 * lá ela pode mostrar um erro, e isso é esperado.
 */
function PedirAoAdministrador({ link, etapa, depois = 'Já aprovaram? Conectar de novo' }: { link: string; etapa: EtapaConsentimento['id']; depois?: string }) {
  const oQue = oQuePedirAoAdministrador(etapa);
  const mensagem = `Olá! Uso o Ergon com a minha conta Microsoft da empresa e preciso que você aprove o aplicativo Ergon para ${oQue} em meu nome. É só abrir este link com a sua conta de administrador e aceitar: ${link}\nNo fim, a página pode mostrar um erro de conexão: é esperado, porque ela tenta voltar para o meu computador. Obrigado!`;
  return (
    <div className="conn-admin conn-reautorizar">
      <p className="small"><b>Pedir ao administrador</b></p>
      <p className="hint">Copie o link e envie você mesmo a quem administra a conta Microsoft da sua empresa: nada sai daqui sozinho. A pessoa abre o link, entra com a conta de administrador e aprova. No fim, a página pode mostrar um erro de "não foi possível acessar": é esperado, porque ela tenta voltar para este computador. Depois que aprovarem, clique em "{depois}".</p>
      <p className="row row--wrap"><CopiarTexto rotulo="Copiar o link do pedido" texto={link} /><CopiarTexto rotulo="Copiar uma mensagem pronta" texto={mensagem} /></p>
    </div>
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

/** GET /api/teams-app: conversar com a equipe pelo Teams (o app público, ligado por código). */
interface TeamsVinculo { id: string; teamsName: string | null; linkedAt: string; notices: boolean; status: 'active' | 'paused' | 'revoked'; revokedBy?: string }
interface EstadoTeams {
  available: boolean; reason?: string; connection: 'connected' | 'connecting' | 'offline'; enabled: boolean; bindings: TeamsVinculo[];
  teamsAppUrl?: string; problem?: string; relay?: { fromEnv: boolean; url: string | null };
}
interface PreviaTeams { claimId: string; teamsName: string; conta?: ContaDoTeams; organizacao?: string | null }
const DESLIGADA_POR: Record<string, string> = {
  teams: 'desligada pelo Teams', uninstall: 'o app foi removido do Teams', blocked: 'o Teams bloqueou as mensagens do app', relay: 'precisa ser ligada de novo',
};
const dataCurta = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Conexões › Teams › "Conversar com a equipe pelo Teams": a pessoa fala com o app no Teams, o app mostra um código, ela
 * digita aqui, vê de quem é a conta e confirma com a senha. Daí em diante, o que ela escreve lá vai para a equipe e a
 * resposta volta lá; o que precisa dela também avisa lá (ligado por padrão).
 */
function TeamsConversa() {
  const st = useResource<EstadoTeams>('/api/teams-app', ['teams.changed']);
  const [codigo, setCodigo] = useState('');
  const [previa, setPrevia] = useState<PreviaTeams | null>(null);
  const [senha, setSenha] = useState('');
  const [ciente, setCiente] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pronto, setPronto] = useState<string | null>(null);
  const [desligar, setDesligar] = useState<string | null>(null);
  // o serviço ainda prepara esta instalação (acabou de se registrar): a tela tenta de novo sozinha, sem erro
  const [preparando, setPreparando] = useState<number>(0);
  const d = st.data;
  const agir = async (fn: () => Promise<unknown>) => {
    setErr(null); setBusy(true);
    try { await fn(); st.reload(); } catch (x) { setErr(x instanceof ApiError && x.code === 'invalid_login' ? 'Senha incorreta.' : errMsg(x)); } finally { setBusy(false); }
  };
  const pedirPrevia = async (tentativa = 0): Promise<void> => {
    setErr(null); setBusy(true); setPronto(null);
    try {
      setPrevia(await api.post<PreviaTeams>('/api/teams-app/claim', { code: codigo })); setCiente(false); setPreparando(0);
    } catch (x) {
      // até uns 3 minutos esperando o serviço ficar pronto; depois, o aviso normal
      if (x instanceof ApiError && x.code === 'not_ready' && tentativa < 18) { setPreparando(tentativa + 1); setTimeout(() => void pedirPrevia(tentativa + 1), 10_000); return; }
      setPreparando(0); setErr(errMsg(x));
    } finally { setBusy(false); }
  };
  // enquanto a resposta não chega (quase nunca: vem na pré-carga), a seção só guarda o lugar
  if (!d) return <article className="card conn feature" aria-hidden="true" style={{ visibility: 'hidden' }}><strong>Conversar com a equipe pelo Teams</strong><p className="muted">…</p></article>;
  const ligados = d.bindings.filter((b) => b.status !== 'revoked');
  const caidos = d.bindings.filter((b) => b.status === 'revoked');
  return (
    <article className={`card conn feature ${ligados.length ? 'feature--on' : ''}`}>
      <header className="row"><BrandLogo kind="teams" name="Teams" size={36} /><strong>Conversar com a equipe pelo Teams</strong>
        {d.available ? <span className={`badge ${d.connection === 'connected' ? 'badge--ok' : 'badge--warn'}`}>{d.connection === 'connected' ? 'conectado' : 'sem conexão'}</span> : <span className="badge badge--soon">em breve</span>}</header>
      <p className="muted">Mande pedidos à sua equipe numa conversa com o app Ergon no Teams e receba as respostas ali mesmo. As confirmações chegam como cartões com Aprovar e Recusar, e o que precisa de você também avisa no Teams.</p>
      {!d.available ? <p className="hint">Em breve: conversar com a equipe pelo Teams, pelo WhatsApp e por outros aplicativos de conversa.</p> : <>
        {d.problem && PROBLEMA_TEAMS[d.problem] && <p className="warn">{PROBLEMA_TEAMS[d.problem]}</p>}
        {linhaDoEstado(d.connection, d.problem) && <p className="small">{linhaDoEstado(d.connection, d.problem)}</p>}
        {(ligados.length > 0 || caidos.length > 0) && (
          <label className="check"><input type="checkbox" checked={d.enabled} disabled={busy} onChange={(e) => void agir(() => api.post('/api/teams-app/enabled', { enabled: e.target.checked }))} /> Conversar pelo Teams</label>
        )}
        {ligados.length > 0 && (
          <ul className="conn-teams-lista">
            {ligados.map((b) => (
              <li key={b.id}>
                <div><b>{b.teamsName ?? 'Conta do Teams'}</b> · ligado em {dataCurta(b.linkedAt)}{b.status === 'paused' ? <span className="muted small"> (conversa desligada)</span> : null}</div>
                <label className="check"><input type="checkbox" checked={b.notices} disabled={busy} onChange={(e) => void agir(() => api.patch(`/api/teams-app/bindings/${b.id}`, { notices: e.target.checked }))} /> Avisar no Teams o que precisa de você</label>
                {desligar === b.id
                  ? <div className="confirm">Desligar esta conta do Teams? Os pedidos que ainda esperam no serviço são apagados, e o Teams avisa que a conta foi desligada.
                      <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void agir(async () => { await api.del(`/api/teams-app/bindings/${b.id}`); setDesligar(null); })}>Desligar</button>
                      <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(null)}>Cancelar</button></div>
                  : <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(b.id)}>Desligar</button>}
              </li>
            ))}
          </ul>
        )}
        {caidos.map((b) => (
          <p key={b.id} className="warn">{b.teamsName ?? 'Conta do Teams'}: {DESLIGADA_POR[b.revokedBy ?? ''] ?? 'desligada'}. Para ligar de novo, mande uma mensagem ao app no Teams e digite o código abaixo.{' '}
            <button className="link link--inline" disabled={busy} onClick={() => void agir(() => api.del(`/api/teams-app/bindings/${b.id}`))}>Tirar da lista</button></p>
        ))}
        {pronto && <p className="ok" role="status">{pronto}</p>}
        {previa ? (() => {
          // o nome não prova nada (é a própria conta do Teams que escolhe): a prévia diz de quem a conta é, conferida com a
          // conta Microsoft ligada a este Ergon, e o que não é a dela pede a escolha consciente antes do Ligar
          const pv = previaDaConta(previa.conta, previa.teamsName, previa.organizacao);
          return (
            <form className="confirm" onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                await api.post('/api/teams-app/confirm', { claimId: previa.claimId, password: senha, ...(pv.exigeEscolha ? { ciente } : {}) });
                setPronto(`Pronto: a conta do Teams "${previa.teamsName}" está ligada. Escreva no Teams, e o pedido vai para a sua equipe.`);
                setPrevia(null); setSenha(''); setCodigo(''); setCiente(false);
              });
            }}>
              <p><b>{pv.pergunta}</b></p>
              <p className="hint">{NOME_ESCOLHIDO} {SO_O_SEU_CODIGO}</p>
              {pv.aviso && <p className={pv.forte ? 'error' : 'warn'} role="alert">{pv.aviso}</p>}
              {pv.exigeEscolha && <label className="check"><input type="checkbox" checked={ciente} disabled={busy} onChange={(e) => setCiente(e.target.checked)} /> {ESCOLHA_CONSCIENTE}</label>}
              <p className="hint">Quem escreve por essa conta fala com a equipe como você. Confirme com a sua senha.</p>
              <div className="row row--wrap">
                <input type="password" autoComplete="current-password" required placeholder="Sua senha" aria-label="Sua senha" value={senha} onChange={(e) => setSenha(e.target.value)} />
                <button className="btn btn--sm btn--primary" disabled={busy || !senha || (pv.exigeEscolha && !ciente)}>{busy ? 'Conferindo…' : 'Ligar'}</button>
                <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => { const c = previa; setPrevia(null); setSenha(''); setCiente(false); void api.post('/api/teams-app/cancel', { claimId: c.claimId }).catch(() => undefined); }}>Cancelar</button>
              </div>
            </form>
          );
        })() : (
          <form onSubmit={(e) => { e.preventDefault(); if (!preparando) void pedirPrevia(); }}>
            <ol className="small conn-passos">
              <li>No Teams, procure o app <b>Ergon</b> e abra uma conversa.{d.teamsAppUrl && <> <a href={d.teamsAppUrl} target="_blank" rel="noreferrer noopener">Abrir no Teams</a></>}</li>
              <li>O app mostra um código.</li>
              <li>Digite o código aqui.</li>
            </ol>
            <p className="hint">{SO_O_SEU_CODIGO}</p>
            <div className="row row--wrap">
              <label className="field">Código<input value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} maxLength={20} /></label>
              <button className="btn btn--sm btn--primary" disabled={busy || preparando > 0 || codigo.replace(/[\s-]/g, '').length < 8}>{busy || preparando ? 'Conferindo…' : 'Confirmar'}</button>
            </div>
            {preparando > 0 && <p className="small" role="status">Preparando a conexão com o Teams…</p>}
          </form>
        )}
        <p className="hint">Só a conversa direta com o app funciona por enquanto (grupos, canais e arquivos ainda não). Com o Ergon fechado, o app responde na hora que recebeu e guarda o pedido, cifrado, por até 7 dias.</p>
      </>}
      {err && <p className="error" role="alert">{err}</p>}
      {d.relay && !d.relay.fromEnv && <EnderecoTeams atual={d.relay.url} reload={st.reload} />}
    </article>
  );
}

/** Ajuste da instalação (quem administra o Ergon neste computador): o endereço do serviço do Teams. */
function EnderecoTeams({ atual, reload }: { atual: string | null; reload: () => void }) {
  const [url, setUrl] = useState(atual ?? '');
  const [err, setErr] = useState<string | null>(null);
  return (
    <details className="small">
      <summary>Ajuste da instalação</summary>
      <form className="row row--wrap" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { await api.put('/api/teams-app/relay-url', { url: url.trim() || null }); reload(); } catch (x) { setErr(errMsg(x)); }
      }}>
        <label className="field">Endereço do serviço do Teams<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} /></label>
        <button className="btn btn--sm">Salvar</button>
      </form>
      {err && <p className="error">{err}</p>}
    </details>
  );
}

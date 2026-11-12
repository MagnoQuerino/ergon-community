import { ConectoresProntos } from '../components/ConectoresProntos.tsx';
import { Fragment, useEffect, useState, type ChangeEvent } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { escolhaConsciente, linhaDoEstado, nomeEscolhido, previaDaConta, problemaDoTeams, soOSeuCodigo, type ContaDoTeams } from '../lib/teams-app.ts';
import type { EtapaConsentimento, Integration } from '../lib/types.ts';
import { AVISO_APROVAR_SEM_CARTAO, ROTULO_APROVAR_DEPOIS_DE_LER, ROTULO_CONFIRMAR_ORGANIZAR, erroDaConexao, motivoDoLogin, oQuePedirAoAdministrador, proximoPassoTarefas, textoDaVolta } from '../lib/textos-tela.ts';
import { fmtData, fmtDataHora, fmtLista, t as tr, tn, useT } from '../i18n/index.ts';
import { AiAccounts } from '../components/AiAccounts.tsx';
import { ModeloPadrao } from '../components/ModeloPadrao.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { TextoLongo } from '../components/TextoLongo.tsx';
import { BotoesRegra, type Alcance } from '../components/CartaoRegra.tsx';

/** O selo de cada estado: a chave do texto (traduzida na hora de mostrar) e a classe. */
const STATE: Record<Integration['state'], [`conexoes.estado.${Integration['state']}`, string]> = {
  off: ['conexoes.estado.off', ''], pending: ['conexoes.estado.pending', 'badge--warn'], connected: ['conexoes.estado.connected', 'badge--ok'], error: ['conexoes.estado.error', 'badge--err'],
};

/** Os aplicativos conectados por token ou chave, por tipo (o título e o texto são chaves do dicionário). */
type Secao = 'tarefas' | 'conversas' | 'vendas' | 'documentos' | 'financeiro';
const SECOES: Array<{ titulo: `conexoes.secao.${Secao}.titulo`; texto: `conexoes.secao.${Secao}.texto`; grupos: string[] }> = [
  { titulo: 'conexoes.secao.tarefas.titulo', grupos: ['tarefas'], texto: 'conexoes.secao.tarefas.texto' },
  { titulo: 'conexoes.secao.conversas.titulo', grupos: ['conversas'], texto: 'conexoes.secao.conversas.texto' },
  { titulo: 'conexoes.secao.vendas.titulo', grupos: ['vendas', 'suporte'], texto: 'conexoes.secao.vendas.texto' },
  { titulo: 'conexoes.secao.documentos.titulo', grupos: ['documentos'], texto: 'conexoes.secao.documentos.texto' },
  { titulo: 'conexoes.secao.financeiro.titulo', grupos: ['financeiro'], texto: 'conexoes.secao.financeiro.texto' },
];

const badgeOf = (i: Integration): [string, string] => {
  const [chave, cls] = i.auth === 'soon' ? ['conexoes.estado.soon' as const, 'badge--soon'] : STATE[i.state];
  return [tr(chave), cls];
};

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
  const t = useT();
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
        <h2>{t('conexoes.titulo')}</h2>
        <p className="muted">{t('conexoes.intro')}</p>
      </header>
      {volta && list.data && <p className="ok" role="status">{textoDaVolta(volta.kind, volta.status, all.find((i) => i.kind === volta.kind)?.state === 'connected')}</p>}
      {list.error && <p className="error">{list.error}</p>}

      <section className="conn-group conn-group--feature">
        <h3>{t('conexoes.ia.titulo')}</h3>
        <p className="muted small">{t('conexoes.ia.texto')}</p>
        <ModeloPadrao />
        <AiAccounts />
      </section>

      {wa && (
        <section className="conn-group conn-group--feature">
          <h3>WhatsApp <span className="badge badge--exp">{t('conexoes.wa.experimental')}</span></h3>
          <p className="muted small">{t('conexoes.wa.intro')} <button className="link link--inline" onClick={() => setRisks(true)}>{t('conexoes.wa.verRiscos')}</button></p>
          <Detail i={wa} reload={list.reload} estado={estadoDe(wa.kind)} feature />
          {risks && <WhatsAppRisks onClose={() => setRisks(false)} />}
        </section>
      )}

      {accounts.length > 0 && (
        <section className="conn-group conn-group--feature">
          <h3>{t('conexoes.contas.titulo')}</h3>
          <p className="muted small">{t('conexoes.contas.texto')}</p>
          {/* duas coisas diferentes que o nome "Teams" junta: a conta (agora) e conversar com o coordenador por lá (depois) */}
          <ul className="conn-explica small">
            <li><b>{t('conexoes.contas.m365Titulo')}</b> {t('conexoes.contas.m365Texto')}</li>
            <li><b>{t('conexoes.contas.teamsTitulo')}</b> {t('conexoes.contas.teamsTexto')}</li>
          </ul>
          <div className="feature-grid">{accounts.map((i) => <Detail key={i.kind} i={i} reload={list.reload} estado={estadoDe(i.kind)} feature />)}</div>
        </section>
      )}

      <section className="conn-group conn-group--feature" id="conn-teams-app">
        <h3>Teams</h3>
        <TeamsConversa />
      </section>

      <ConversaPorCanais />

      <LiberarTudo estado={cx} />
      <Regras />

      <div className="row row--wrap conn-tools">
        <label className="conn-search"><Icon name="focus" size={14} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('conexoes.busca.placeholder')} aria-label={t('conexoes.busca.aria')} /></label>
        <button className={`chip ${!onlyOn ? 'chip--on' : ''}`} aria-pressed={!onlyOn} onClick={() => setOnlyOn(false)}>{t('conexoes.busca.todos', { n: ready })}</button>
        <button className={`chip ${onlyOn ? 'chip--on' : ''}`} aria-pressed={onlyOn} onClick={() => setOnlyOn(true)}>{t('conexoes.busca.conectados', { n: connected })}</button>
      </div>
      {SECOES.map((sec) => {
        const nela = shown.filter((i) => sec.grupos.includes(i.group));
        if (!nela.length) return null;
        return (
          <section className="conn-group" key={sec.titulo}>
            <h3>{t(sec.titulo)}</h3>
            <p className="muted small">{t(sec.texto)}</p>
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
      <ConectoresProntos dono />
      {achadosNoDestaque.length > 0 && (
        <p className="muted">{tn('conexoes.busca.emDestaque', { lista: achadosNoDestaque.map((i, n) => <Fragment key={i.kind}>{n ? ', ' : ''}<button className="link link--inline" onClick={() => irAte(i.kind)}>{i.name}</button></Fragment>) })}</p>
      )}
      {list.data && !shown.length && !achadosNoDestaque.length && <p className="muted">{term ? t('conexoes.busca.nadaPara', { q }) : t('conexoes.busca.nada')}</p>}
    </div>
  );
}

/** Cartão de uma conexão: aberto ao clicar num bloco, ou sempre aberto em destaque (WhatsApp, Microsoft, Google). */
/** Autorização com prazo (Google com o app em teste): avisa a data e, perto do fim, pede para renovar. */
function RenewBy({ at }: { at: string }) {
  const t = useT();
  const days = Math.ceil((Date.parse(at) - Date.now()) / 86_400_000);
  const date = fmtData(at, { day: '2-digit', month: '2-digit' });
  if (days <= 2) return <p className="warn">{days <= 0 ? t('conexoes.prazo.venceHoje', { data: date }) : t('conexoes.prazo.venceEm', { n: days, data: date })}</p>;
  return <p className="hint">{t('conexoes.prazo.valida', { data: date })}</p>;
}

/** O texto com a palavra "Tarefas" (no idioma da tela) virando o link para a tela de Tarefas. */
function ComLinkTarefas({ texto }: { texto: string }) {
  const t = useT();
  const palavra = t('conexoes.tarefas.link');
  const [antes, ...depois] = texto.split(palavra);
  return <>{antes}{depois.length > 0 && <><a href="#tarefas">{palavra}</a>{depois.join(palavra)}</>}</>;
}

function Detail({ i, reload, estado, onClose, feature }: { i: Integration; reload: () => void; estado: EstadoDe; onClose?: () => void; feature?: boolean }) {
  const t = useT();
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
        {onClose && <button className="icon-btn conn-detail__x" onClick={onClose} aria-label={t('conexoes.acao.fechar')}><Icon name="x" size={16} /></button>}
      </header>
      <p className="muted">{i.about}</p>
      {i.state === 'connected' && i.sharedFrom && <p className="hint">{tn('conexoes.detalhe.compartilhada', { workspace: <b>{i.sharedFrom}</b> })}</p>}
      {i.state !== 'connected' && i.auth !== 'soon' && <UsarDeOutroWorkspace i={i} reload={reload} />}
      {i.state === 'connected' && i.account && <p>{tn('conexoes.detalhe.conta', { conta: <strong>{i.account}</strong> })}{i.lastSyncAt ? <span className="muted small"> {t('conexoes.detalhe.ultimaLeitura', { quando: fmtDataHora(i.lastSyncAt) })}</span> : null}</p>}
      {/* conectada também: o último problema (ex.: a credencial sem permissão de escrita) fica à vista até a próxima ação dar
          certo; o pedido ao administrador no primeiro acesso não é falha (o cartão explica), e o erro cru do login não aparece */}
      {erro && <p className="error">{erro}</p>}
      {i.state === 'connected' && i.renewBy && <RenewBy at={i.renewBy} />}
      {i.auth === 'soon' ? <p className="hint">{i.soon ?? t('conexoes.detalhe.emPreparo')}</p>
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
  const t = useT();
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
      // i18n-ok: reconhece o texto fixo que o servidor manda (FALTA_AUTORIZAR), não é texto de tela
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
        <button className="btn btn--sm" disabled={busy} onClick={() => void rodar({})}>{busy ? t('conexoes.teste.testando') : t('conexoes.teste.testar')}</button>
        {i.tasks && !(semQuadro && i.kind !== 'microsoft') && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void escrita()}>{quadros?.length && quadro ? t('conexoes.teste.criarTarefa') : t('conexoes.teste.testarEscrita')}</button>}
      </p>
      {!i.tasks && <p className="hint">{t('conexoes.teste.soLe')}</p>}
      {quadros && (quadros.length
        ? <label className="field">{t('conexoes.teste.ondeCriar')}<select value={quadro} onChange={(e) => setQuadro(e.target.value)}>{quadros.map((q) => <option key={q.externalId} value={q.externalId}>{q.name}</option>)}</select></label>
        : <p className="hint">{i.kind === 'microsoft' ? t('conexoes.teste.semListaMicrosoft') : t('conexoes.teste.semQuadro')}</p>)}
      {err && <p className="error">{err}</p>}
      {itens && <ul className="conn-teste__lista">{itens.map((x) => <li key={x.nome}><span className={`badge ${x.ok ? 'badge--ok' : 'badge--err'}`}>{x.ok ? t('conexoes.teste.ok') : t('conexoes.teste.falhou')}</span> {x.nome}{x.ok ? '' : <span className="muted small"> — {x.detalhe}</span>}</li>)}</ul>}
    </div>
  );
}

/** Cada tipo de ação: as chaves do rótulo e da dica. */
type Risco = 'ler' | 'organizar' | 'enviar' | 'apagar';
const RISCO_ROTULO: Record<string, [`conexoes.risco.${Risco}`, `conexoes.risco.${Risco}Dica`]> = {
  ler: ['conexoes.risco.ler', 'conexoes.risco.lerDica'], organizar: ['conexoes.risco.organizar', 'conexoes.risco.organizarDica'],
  enviar: ['conexoes.risco.enviar', 'conexoes.risco.enviarDica'], apagar: ['conexoes.risco.apagar', 'conexoes.risco.apagarDica'],
};
const AJUSTE_ROTULO: Array<[string, `conexoes.ajuste.${'regra' | 'confirmar' | 'desligado'}`]> = [['regra', 'conexoes.ajuste.regra'], ['confirmar', 'conexoes.ajuste.confirmar'], ['desligado', 'conexoes.ajuste.desligado']];

/** O que os agentes podem fazer nesta conexão: por tipo de ação e, abrindo a lista, ação por ação. */
function AcoesDaConexao({ i, estado }: { i: Integration; estado: EstadoDe }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  // o erro do atalho fica junto da caixa: a lista abaixo vem fechada, e o erro lá dentro ninguém veria
  const [errSoLeitura, setErrSoLeitura] = useState<string | null>(null);
  const eu = estado.eu;
  // ainda chegando: o título já ocupa o lugar, para nada abaixo pular quando a lista chegar
  if (!eu) return estado.pronto ? null : <details className="conn-acoes"><summary>{t('conexoes.acoes.titulo')}</summary></details>;
  const salvar = async (p: Permissoes) => { setErr(null); try { await api.put(`/api/conexoes/${i.kind}/permissoes`, { permissoes: p }); estado.reload(); } catch (e) { setErr(errMsg(e)); } };
  const tipos = Object.keys(RISCO_ROTULO).filter((r) => eu.acoes.some((a) => a.risco === r));
  const soLeitura = async (on: boolean) => { setErrSoLeitura(null); try { await api.put(`/api/conexoes/${i.kind}/so-leitura`, { on }); estado.reload(); } catch (e) { setErrSoLeitura(errMsg(e)); } };
  const opcoes = AJUSTE_ROTULO.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>);
  return (
    <>
    {/* um clique: tudo o que escreve nesta conexão fica desligado; desmarcar devolve o ajuste de escrita de antes */}
    {eu.escreve && (
      <div className="conn-so-leitura">
        <label className="check"><input type="checkbox" checked={!!eu.soLeitura} onChange={(e) => void soLeitura(e.target.checked)} /> {t('conexoes.soLeitura.rotulo')}</label>
        <span className="muted small"> {eu.soLeitura ? t('conexoes.soLeitura.ligada') : t('conexoes.soLeitura.desligada')}</span>
        {errSoLeitura && <p className="error" role="alert">{errSoLeitura}</p>}
      </div>
    )}
    <details className="conn-acoes">
      <summary>{t('conexoes.acoes.tituloN', { n: eu.acoes.length })}</summary>
      {/* o envio dos quadros ligados confere o mesmo ajuste: só o desligado o barra */}
      {i.tasks && <p className="hint">{t('conexoes.acoes.quadrosLigados')}</p>}
      <div className="conn-acoes__tipos">
        {tipos.map((r) => (
          <label key={r} className="field field--inline" title={t(RISCO_ROTULO[r][1])}>{t(RISCO_ROTULO[r][0])}
            <select value={eu.permissoes.tipos[r] ?? 'regra'} onChange={(e) => void salvar({ ...eu.permissoes, tipos: { ...eu.permissoes.tipos, [r]: e.target.value } })}>{opcoes}</select>
          </label>
        ))}
      </div>
      <ul className="conn-acoes__lista">
        {eu.acoes.map((a) => (
          <li key={a.id}>
            <span>{a.rotulo} <span className="muted small">({RISCO_ROTULO[a.risco] ? t(RISCO_ROTULO[a.risco][0]) : a.risco})</span></span>
            <select aria-label={t('conexoes.acoes.ajusteDe', { acao: a.rotulo })} value={eu.permissoes.acoes[a.id] ?? eu.permissoes.tipos[a.risco] ?? 'regra'} onChange={(e) => void salvar({ ...eu.permissoes, acoes: { ...eu.permissoes.acoes, [a.id]: e.target.value } })}>{opcoes}</select>
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
  const t = useT();
  // vem junto da lista de conexões: o bloco abre já com a opção, sem empurrar o formulário depois
  const contas = i.reutilizaveis ?? [];
  const [err, setErr] = useState<string | null>(null);
  if (!contas.length) return null;
  return (
    <div className="conn-reusar">
      <p className="hint">{t('conexoes.reusar.texto')}</p>
      <p className="row row--wrap">{contas.map((c) => (
        <button key={c.workspaceId} className="btn btn--sm" onClick={async () => { setErr(null); try { await api.post(`/api/conexoes/${i.kind}/usar-de`, { workspaceId: c.workspaceId }); reload(); } catch (e) { setErr(errMsg(e)); } }}>{c.conta ? t('conexoes.reusar.usar', { conta: c.conta, workspace: c.workspace }) : t('conexoes.reusar.usarSemNome', { workspace: c.workspace })}</button>
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
const dia = (iso: string) => fmtData(iso, { day: '2-digit', month: '2-digit' });
/**
 * Conexões › Regras, o lugar único das regras: o que você liberou para a equipe fazer sem pedir a sua confirmação (com
 * desfazer), as regras de texto que valem nas conversas (com desligar) e o que foi proposto e espera você.
 */
function Regras() {
  const t = useT();
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
      <h3>{t('conexoes.regras.titulo')}</h3>
      <p className="muted small">{t('conexoes.regras.texto')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}
      {!d && r.error && <p className="error">{r.error}</p>}
      {vazio && <p className="muted">{t('conexoes.regras.vazio')}</p>}

      {!!d?.propostas.cartoes.length && <h4 className="rt-sub">{t('conexoes.regras.esperando')}</h4>}
      {d?.propostas.cartoes.map((c) => (
        <article key={c.id} className="dec-card">
          <div className="dec-card__top"><span className="badge">{c.agent_name ? t('conexoes.regras.propostaDe', { agente: c.agent_name }) : t('conexoes.regras.proposta')}</span></div>
          <div className="dec-card__txt"><TextoLongo texto={c.summary} /></div>
          <div className="row row--wrap dec-card__acts">
            {indo === c.id ? <span className="badge" role="status">{t('conexoes.regras.aplicando')}</span>
              : <BotoesRegra sugerido={c.alcance} ocupado={!!indo} onEscolher={(alcance) => void fazer(c.id, () => api.post(`/api/proposals/${c.id}`, { decision: 'apply', alcance }), t('conexoes.regras.aplicada'))}
                onRecusar={() => void fazer(c.id, () => api.post(`/api/proposals/${c.id}`, { decision: 'reject' }), t('conexoes.regras.recusada'))} />}
          </div>
        </article>
      ))}
      {d?.propostas.texto.map((x) => (
        <article key={x.id} className="dec-card">
          <div className="dec-card__top"><span className="badge">{t('conexoes.regras.conversaProposta')}</span></div>
          <div className="dec-card__txt">{x.text}</div>
          <div className="row row--wrap dec-card__acts">
            <button className="btn btn--sm btn--primary" disabled={!!indo} onClick={() => void fazer(x.id, () => api.post(`/api/rules/${x.id}`, { decision: 'active' }), t('conexoes.regras.ativada'))}>{t('conexoes.regras.ativar')}</button>
            <button className="btn btn--sm btn--ghost" disabled={!!indo} onClick={() => void fazer(x.id, () => api.post(`/api/rules/${x.id}`, { decision: 'rejected' }), t('conexoes.regras.recusada'))}>{t('conexoes.regras.recusar')}</button>
          </div>
        </article>
      ))}

      {!!d?.regras.length && <h4 className="rt-sub">{t('conexoes.regras.liberado')}</h4>}
      {d?.regras.map((x) => (
        <div key={x.id} className="regra-linha">
          <span className="regra-linha__txt"><b>{x.texto.charAt(0).toUpperCase() + x.texto.slice(1)}</b>
            <span className="muted small"> · {x.alcanceTexto} · {t('conexoes.regras.desde', { data: dia(x.criadaEm) })}{x.tipo === 'acao' ? ` · ${t('conexoes.regras.usos', { n: x.usos })}` : ''}</span></span>
          <button className="btn btn--sm" disabled={!!indo} onClick={() => void fazer(x.id, () => api.post(`/api/conexoes/regras/${x.id}/desfazer`), t('conexoes.regras.desfeita'))}>{indo === x.id ? t('conexoes.regras.desfazendo') : t('conexoes.regras.desfazer')}</button>
        </div>
      ))}

      {!!d?.texto.length && <h4 className="rt-sub">{t('conexoes.regras.combinado')}</h4>}
      {d?.texto.map((x) => (
        <div key={x.id} className="regra-linha">
          <span className="regra-linha__txt">{x.text}<span className="muted small"> · {t('conexoes.regras.desde', { data: dia(x.created_at) })}</span></span>
          <button className="btn btn--sm" disabled={!!indo} onClick={() => void fazer(x.id, () => api.post(`/api/rules/${x.id}`, { decision: 'rejected' }), t('conexoes.regras.desligada'))}>{indo === x.id ? t('conexoes.regras.desligando') : t('conexoes.acao.desligar')}</button>
        </div>
      ))}
    </section>
  );
}

function LiberarTudo({ estado: st }: { estado: { data: EstadoConexoes | null; reload: () => void } }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const trocar = (rota: string) => async (e: ChangeEvent<HTMLInputElement>) => { setErr(null); try { await api.put(rota, { on: e.target.checked }); st.reload(); } catch (x) { setErr(errMsg(x)); } };
  // a seção fica sempre no lugar; enquanto a escolha não chega (quase nunca: vem na pré-carga), a linha só guarda o espaço
  const opcao = (ligada: boolean | undefined, rota: string, rotulo: string) => st.data
    ? <label className="check"><input type="checkbox" checked={!!ligada} onChange={trocar(rota)} /> {rotulo}</label>
    : <span className="check" aria-hidden="true" style={{ visibility: 'hidden' }}><input type="checkbox" tabIndex={-1} readOnly /> {rotulo}</span>;
  return (
    <section className="conn-group">
      <h3>{t('conexoes.cuidado.titulo')}</h3>
      <p className="muted small">{t('conexoes.cuidado.texto')}</p>
      {opcao(st.data?.confirmarOrganizar, '/api/conexoes/confirmar-organizar', ROTULO_CONFIRMAR_ORGANIZAR)}
      <p className="muted small">{t('conexoes.cuidado.organizar')}</p>
      {opcao(st.data?.aprovarDepoisDeLer, '/api/conexoes/aprovar-depois-de-ler', ROTULO_APROVAR_DEPOIS_DE_LER)}
      <p className="muted small">{t('conexoes.cuidado.depoisDeLer')}</p>
      {st.data?.aprovarDepoisDeLerBarra && <p className="warn">{AVISO_APROVAR_SEM_CARTAO}</p>}
      {opcao(st.data?.liberarTudo, '/api/conexoes/liberar-tudo', t('conexoes.cuidado.liberarTudo'))}
      {st.data?.liberarTudo && <p className="warn">{t('conexoes.cuidado.liberarTudoAviso')}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}


function Disconnect({ i, reload, label }: { i: Integration; reload: () => void; label?: string }) {
  const t = useT();
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ask) return <button className="btn btn--sm btn--ghost" onClick={() => setAsk(true)}>{label ?? t('conexoes.desconectar.botao')}</button>;
  // o que acontece de verdade: conta emprestada só deixa de ser usada aqui; a que outros workspaces usam continua com eles
  const outros = i.usadaEm ?? [];
  const efeito = i.sharedFrom ? t('conexoes.desconectar.emprestada', { workspace: i.sharedFrom })
    : outros.length ? (outros.length === 1 ? t('conexoes.desconectar.outroUm', { workspace: outros[0] }) : t('conexoes.desconectar.outrosVarios', { lista: fmtLista(outros) }))
    : t('conexoes.desconectar.apaga');
  return (
    <div className="confirm">
      {i.sharedFrom ? t('conexoes.desconectar.perguntaEmprestada', { nome: i.name, efeito }) : t('conexoes.desconectar.pergunta', { nome: i.name, efeito })}
      <button className="btn btn--sm btn--primary" onClick={async () => { try { await api.del(`/api/integrations/${i.kind}`); setAsk(false); reload(); } catch (e) { setErr(errMsg(e)); } }}>{i.sharedFrom ? t('conexoes.desconectar.deixarDeUsar') : t('conexoes.desconectar.botao')}</button>
      <button className="btn btn--sm btn--ghost" onClick={() => setAsk(false)}>{t('conexoes.acao.cancelar')}</button>
      {err && <span className="error">{err}</span>}
    </div>
  );
}

/** Credencial colada: um ou mais campos (token, chave, endereço, e-mail), conferidos no serviço antes de conectar. */
function TokenConnect({ i, reload, autorizar }: { i: Integration; reload: () => void; autorizar: boolean }) {
  const t = useT();
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
          <button className="btn btn--primary" onClick={() => { setOk(null); setTrocar(true); }}>{t('conexoes.token.reconectarNovo')}</button>
        </div>
      )}
      {/* o agente ou o teste diz à pessoa "autorizar de novo": aqui isso é colar uma credencial com a permissão que faltou */}
      {(i.error || autorizar) && (
        <div className="conn-reautorizar">
          <p className="warn">{t('conexoes.token.faltouPermissao', { app: i.name })}</p>
          <button className="btn btn--primary" onClick={() => { setOk(null); setTrocar(true); }}>{t('conexoes.acao.autorizarDeNovo')}</button>
        </div>
      )}
      <button className="btn btn--sm btn--ghost" onClick={() => { setOk(null); setTrocar(true); }}>{t('conexoes.acao.outraConta')}</button>{' '}
      <Disconnect i={i} reload={reload} label={i.sharedFrom ? t('conexoes.desconectar.deixarAqui') : t('conexoes.desconectar.desteWorkspace')} />
    </>
  );
  // i18n-ok: 'token' é o nome do campo que a API espera; o rótulo e o exemplo vêm do dicionário
  const fields = i.fields.length ? i.fields : [{ name: 'token', label: t('conexoes.token.campo'), secret: true, placeholder: t('conexoes.token.campoExemplo'), opcional: false }];
  // Trello: com a chave digitada, o link já abre a autorização (leitura e escrita, sem validade) para gerar o token
  const trelloKey = i.kind === 'trello' && /^[a-f0-9]{32}$/i.test((v.key ?? '').trim()) ? v.key.trim() : null;
  return (
    <form className="token-form" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      // o botão nunca fica apagado esperando: faltou um campo, a tela diz qual
      const faltam = fields.filter((f) => !f.opcional && !(v[f.name] ?? '').trim());
      if (faltam.length) { setErr(t('conexoes.token.preencha', { campos: fmtLista(faltam.map((f) => f.label)) })); return; }
      setBusy(true);
      try {
        // campo opcional em branco não vai (ex.: o endereço do GitLab, em branco para gitlab.com)
        const credentials = Object.fromEntries(fields.filter((f) => (v[f.name] ?? '').trim()).map((f) => [f.name, (v[f.name] ?? '').trim()]));
        const r = await api.post<{ account: string }>(`/api/integrations/${i.kind}/token`, { credentials });
        setV({}); setTrocar(false); setOk(t('conexoes.token.conectada', { conta: r.account })); reload();
      } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
    }}>
      {i.help?.antes && <p className="warn conn-antes" role="note">{i.help.antes}</p>}
      {i.help && <p className="hint">{i.help.steps} <a href={i.help.url} target="_blank" rel="noreferrer noopener">{t('conexoes.token.abrirPagina')}</a></p>}
      {!!i.help?.extras?.length && <p className="row row--wrap">{i.help.extras.map((x) => ('url' in x
        ? <a key={x.rotulo} className="btn btn--sm btn--ghost" href={x.url} target="_blank" rel="noreferrer noopener">{x.rotulo}</a>
        : <CopiarTexto key={x.rotulo} rotulo={x.rotulo} texto={x.copiar} />))}</p>}
      {trelloKey && <p className="hint">{tn('conexoes.token.trello', { link: <a href={`https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Ergon&key=${trelloKey}`} target="_blank" rel="noreferrer noopener">{t('conexoes.token.trelloLink')}</a> })}</p>}
      {fields.map((f) => (
        <label key={f.name} className="field">{f.label}
          <input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={v[f.name] ?? ''} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
        </label>
      ))}
      <p className="row row--wrap">
        <button className="btn btn--primary" disabled={busy}>{busy ? t('conexoes.acao.conferindo') : t('conexoes.token.conectar')}</button>
        {trocar && <button type="button" className="btn btn--ghost" onClick={() => { setTrocar(false); setV({}); setErr(null); }}>{t('conexoes.acao.cancelar')}</button>}
      </p>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

/** Texto longo para colar noutro lugar (ex.: o texto do app do Slack): um botão, em vez do texto no meio dos passos. */
function CopiarTexto({ rotulo, texto }: { rotulo: string; texto: string }) {
  const t = useT();
  const [feito, setFeito] = useState<'copiado' | 'mostrar' | null>(null);
  useEffect(() => { if (feito !== 'copiado') return; const t = window.setTimeout(() => setFeito(null), 2500); return () => window.clearTimeout(t); }, [feito]);
  return (
    <>
      {/* i18n-ok: "copiado" e "mostrar" são estados internos do botão; o texto vem do dicionário */}
      <button type="button" className="btn btn--sm btn--ghost" onClick={async () => { try { await navigator.clipboard.writeText(texto); setFeito('copiado'); } catch { setFeito('mostrar'); } }}>{feito === 'copiado' ? t('conexoes.copiar.copiado') : rotulo}</button>
      {/* sem acesso à área de transferência: o texto aparece selecionado, para copiar com Ctrl+C */}
      {feito === 'mostrar' && <textarea className="conn-copiar" readOnly rows={3} value={texto} aria-label={rotulo} ref={(el) => el?.select()} />}
    </>
  );
}

/** Textos de cada login com a conta (o mecanismo é um só no servidor: sso.ts): as chaves do dicionário. */
type Provedor = 'microsoft' | 'google';
const SSO_TEXT: Record<string, { button: `conexoes.sso.${Provedor}.botao`; what: `conexoes.sso.${Provedor}.oQue`; connected: `conexoes.sso.${Provedor}.conectado` }> = {
  microsoft: { button: 'conexoes.sso.microsoft.botao', what: 'conexoes.sso.microsoft.oQue', connected: 'conexoes.sso.microsoft.conectado' },
  google: { button: 'conexoes.sso.google.botao', what: 'conexoes.sso.google.oQue', connected: 'conexoes.sso.google.conectado' },
};

function Sso({ i, reload, faltam, etapas, recarregar, autorizar }: { i: Integration; reload: () => void; faltam: string[]; etapas: EtapaConsentimento[]; recarregar: () => void; autorizar: boolean }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const chaves = SSO_TEXT[i.kind];
  const txt = chaves ? { button: t(chaves.button), what: t(chaves.what), connected: t(chaves.connected) } : { button: t('conexoes.sso.entrarCom', { nome: i.name }), what: '', connected: '' };
  const entrar = async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); } };
  if (i.state === 'connected') return (
    <>
      {txt.connected && <p className="hint">{txt.connected}</p>}
      {i.kind === 'microsoft' && etapas.length > 0 && <EtapasMicrosoft etapas={etapas} recarregar={recarregar} />}
      <p><button className="btn btn--sm btn--ghost" onClick={() => void entrar()}>{t('conexoes.acao.outraConta')}</button></p>
      {/* faltou permissão (conta antiga, ou o serviço recusou uma ação): o botão que o agente e o teste apontam */}
      {(faltam.length > 0 || !!i.error || autorizar) && (
        <div className="conn-reautorizar">
          {faltam.length > 0 && <p className="warn">{t('conexoes.sso.antesDasAcoes')}</p>}
          <button className="btn btn--primary" onClick={() => void entrar()}>{t('conexoes.acao.autorizarDeNovo')}</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <Disconnect i={i} reload={reload} />
    </>
  );
  if (!i.ready) return <p className="hint">{t('conexoes.sso.naoRegistrado', { lugar: i.setup?.place ?? t('conexoes.sso.noProvedor'), doc: i.setup?.doc ?? t('conexoes.sso.aDocumentacao'), botao: txt.button })}</p>;
  const comecar = async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/api/integrations/${i.kind}/start`); location.href = r.url; } catch (e) { setErr(errMsg(e)); reload(); } };
  // a empresa exige o administrador já no primeiro login: o pedido vem pronto aqui, antes de haver conta conectada
  if (i.adminBase) return (
    <>
      <div className="conn-etapas conn-reautorizar">
        <h4>{t('conexoes.admin.empresaPrecisa')}</h4>
        <p className="small">{t('conexoes.admin.empresaTexto')}</p>
        {/* o primeiro acesso pede tudo de uma vez: a mensagem ao administrador diz tudo o que o link pede */}
        <PedirAoAdministrador link={i.adminBase.link} etapa="base" depois={t('conexoes.admin.jaAprovaramEntrar')} />
        <p className="row row--wrap"><button className="btn btn--primary" onClick={() => void comecar()}>{t('conexoes.admin.jaAprovaramEntrar')}</button></p>
      </div>
      {err && <p className="error">{err}</p>}
    </>
  );
  return (
    <>
      <button className="btn btn--primary" onClick={() => void comecar()}>{txt.button}</button>
      {txt.what && <p className="hint">{txt.what}</p>}
      {err && <p className="error">{err}</p>}
    </>
  );
}

/** O que cada etapa da Microsoft libera, dito para a pessoa (sso.ts tem as permissões de cada uma): as chaves do dicionário. */
const ETAPA_TEXTO: Record<EtapaConsentimento['id'], { titulo: `conexoes.etapa.${EtapaConsentimento['id']}.titulo`; oQue: `conexoes.etapa.${EtapaConsentimento['id']}.oQue` }> = {
  base: { titulo: 'conexoes.etapa.base.titulo', oQue: 'conexoes.etapa.base.oQue' },
  trabalho: { titulo: 'conexoes.etapa.trabalho.titulo', oQue: 'conexoes.etapa.trabalho.oQue' },
  leitura: { titulo: 'conexoes.etapa.leitura.titulo', oQue: 'conexoes.etapa.leitura.oQue' },
  canais: { titulo: 'conexoes.etapa.canais.titulo', oQue: 'conexoes.etapa.canais.oQue' },
};

/**
 * O que a conta Microsoft já liberou, etapa por etapa, e o próximo passo de cada uma: liberar (a própria pessoa), pedir ao
 * administrador (o link pronto, que ela mesma copia e envia) ou entrar de novo depois que ele aprovou.
 */
function EtapasMicrosoft({ etapas, recarregar }: { etapas: EtapaConsentimento[]; recarregar: () => void }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const pedir = async (etapa: EtapaConsentimento['id']) => {
    setErr(null);
    // a etapa base é o login inteiro (escolhe a conta e segue sozinho pelas outras)
    try { const r = await api.post<{ url: string }>('/api/integrations/microsoft/start', etapa === 'base' ? {} : { etapa }); location.href = r.url; } catch (e) { setErr(errMsg(e)); recarregar(); }
  };
  return (
    <div className="conn-etapas conn-reautorizar">
      <h4>{t('conexoes.etapas.titulo')}</h4>
      <ul className="conn-teste__lista conn-etapas__lista">{etapas.map((e) => <EtapaLinha key={e.id} e={e} pedir={() => void pedir(e.id)} />)}</ul>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function EtapaLinha({ e, pedir }: { e: EtapaConsentimento; pedir: () => void }) {
  const t = useT();
  const txt = ETAPA_TEXTO[e.id];
  // o motivo gravado na etapa, em português (o erro da Microsoft fica só no registro)
  const motivo = motivoDoLogin(e.erro);
  const titulo = <><b>{t(txt.titulo)}</b> <span className="muted small">({t(txt.oQue)})</span></>;
  if (e.estado === 'ok') return <li><span className="badge badge--ok">{t('conexoes.etapa.liberado')}</span> {titulo}</li>;
  if (e.estado === 'aprovado') return (
    <li><span className="badge badge--ok">{t('conexoes.etapa.aprovado')}</span> {titulo}
      <p className="row row--wrap"><button className="btn btn--sm btn--primary" onClick={pedir}>{t('conexoes.etapa.autorizarAgora')}</button><span className="muted small">{t('conexoes.etapa.faltaEntrar')}</span></p>
    </li>
  );
  if (e.estado === 'pedido') return (
    <li><span className="badge badge--warn">{t('conexoes.etapa.esperando')}</span> {titulo}
      <p className="row row--wrap"><span className="muted small">{t('conexoes.etapa.paginaAberta')}</span><button className="btn btn--sm btn--ghost" onClick={pedir}>{t('conexoes.etapa.abrirDeNovo')}</button></p>
    </li>
  );
  // na empresa, leitura e canais costumam ser do administrador (e o Teams, quando a empresa exige): o pedido vem pronto, e quem
  // envia é a pessoa. Os canais são opcionais e o login segue até eles sozinho: voltar sem eles é esperado, nada em vermelho
  if (e.administrador && e.link && (e.estado === 'bloqueado' || e.opcional)) return (
    <li><span className={`badge ${e.estado === 'bloqueado' && !e.opcional ? 'badge--err' : ''}`}>{t('conexoes.etapa.precisaAdmin')}</span> {titulo}
      <p className="small">{e.opcional ? t('conexoes.etapa.opcionalCanais') : t('conexoes.etapa.precisaAprovacao')}{motivo ? <span className="muted"> {motivo}</span> : null}</p>
      <PedirAoAdministrador link={e.link} etapa={e.id} />
      <p className="row row--wrap"><button className="btn btn--sm btn--primary" onClick={pedir}>{t('conexoes.admin.jaAprovaramConectar')}</button></p>
    </li>
  );
  return (
    <li><span className="badge">{e.estado === 'bloqueado' ? t('conexoes.etapa.naoLiberado') : t('conexoes.etapa.faltaLiberar')}</span> {titulo}
      {motivo && <p className="muted small">{motivo}</p>}
      <p className="row row--wrap">
        <button className="btn btn--sm btn--primary" onClick={pedir}>{e.estado === 'bloqueado' ? t('conexoes.etapa.tentarDeNovo') : e.id === 'leitura' ? t('conexoes.etapa.liberarLeitura') : e.id === 'base' ? t('conexoes.acao.autorizarDeNovo') : t('conexoes.etapa.liberar')}</button>
        {e.administrador && <span className="muted small">{t('conexoes.etapa.costumaAdmin')}</span>}
      </p>
      {/* quem já sabe que a empresa exige o administrador vai direto ao pedido, sem passar pela página da Microsoft */}
      {e.administrador && e.link && <details><summary className="small">{t('conexoes.admin.pedir')}</summary><PedirAoAdministrador link={e.link} etapa={e.id} /></details>}
    </li>
  );
}

/**
 * O pedido ao administrador: o link (escopos explícitos, para ele ver exatamente o que aprova) e uma mensagem pronta. A pessoa
 * copia e envia ela mesma; nada sai daqui sozinho. Quem aprova abre noutro computador, e a página final tenta voltar para este:
 * lá ela pode mostrar um erro, e isso é esperado.
 */
function PedirAoAdministrador({ link, etapa, depois }: { link: string; etapa: EtapaConsentimento['id']; depois?: string }) {
  const t = useT();
  const oQue = oQuePedirAoAdministrador(etapa);
  const mensagem = t('conexoes.admin.mensagem', { oQue, link });
  return (
    <div className="conn-admin conn-reautorizar">
      <p className="small"><b>{t('conexoes.admin.pedir')}</b></p>
      <p className="hint">{t('conexoes.admin.instrucoes', { depois: depois ?? t('conexoes.admin.jaAprovaramConectar') })}</p>
      <p className="row row--wrap"><CopiarTexto rotulo={t('conexoes.admin.copiarLink')} texto={link} /><CopiarTexto rotulo={t('conexoes.admin.copiarMensagem')} texto={mensagem} /></p>
    </div>
  );
}

interface WaState { status: string; experimental?: boolean; riscosAceitos?: boolean; qr: string | null; me: string | null; error: string | null; read: number; seen: number; filters: { direct: boolean; groups: boolean; cards: boolean; labels: string[]; exceptions: string[] }; chats: Array<{ id: string; name: string; group: boolean }>; labels: string[] }

function WhatsApp({ i, reload }: { i: Integration; reload: () => void }) {
  const t = useT();
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
          <button className="btn btn--primary" onClick={() => void start()} disabled={busy}>{t('conexoes.wa.conectarQr')}</button>
          <p className="hint">{t('conexoes.wa.experimentalTexto')}</p>
        </>
      )}
      {live === 'starting' && <p className="muted">{t('conexoes.wa.preparandoQr')}</p>}
      {live === 'qr' && st.data?.qr && (
        <div className="qr">
          <img src={st.data.qr} alt={t('conexoes.wa.qrAlt')} width={240} height={240} />
          <ol className="small">
            <li>{t('conexoes.wa.passo1')}</li>
            <li>{tn('conexoes.wa.passo2', { aparelhos: <b>{t('conexoes.wa.aparelhosConectados')}</b>, conectar: <b>{t('conexoes.wa.conectarAparelho')}</b> })}</li>
            <li>{t('conexoes.wa.passo3')}</li>
          </ol>
          <button className="btn btn--sm btn--ghost" onClick={stop}>{t('conexoes.acao.cancelar')}</button>
        </div>
      )}
      {st.data?.error && <p className="error">{st.data.error}</p>}
      {i.state === 'connected' && f && (
        <div className="wa-filters">
          <p className="small">{live === 'connected' ? <span className="badge badge--ok">{t('conexoes.wa.lendo')}</span> : <span className="badge badge--warn">{live === 'starting' ? t('conexoes.wa.reconectando') : t('conexoes.wa.parado')}</span>} {t('conexoes.wa.lidas', { n: st.data!.read })}{st.data!.seen > st.data!.read ? ` ${t('conexoes.wa.ignoradas', { n: st.data!.seen - st.data!.read })}` : ''}</p>
          {live !== 'connected' && live !== 'starting' && <button className="btn btn--sm" onClick={() => void start()}>{t('conexoes.wa.retomar')}</button>}
          <h4>{t('conexoes.wa.oQueELido')}</h4>
          <label className="check"><input type="checkbox" checked={f.direct} onChange={(e) => void setF({ direct: e.target.checked })} /> {t('conexoes.wa.individuais')}</label>
          <label className="check"><input type="checkbox" checked={f.groups} onChange={(e) => void setF({ groups: e.target.checked })} /> {t('conexoes.wa.grupos')}</label>
          <label className="check"><input type="checkbox" checked={f.cards} onChange={(e) => void setF({ cards: e.target.checked })} /> {t('conexoes.wa.cards')}</label>
          <ListEditor label={t('conexoes.wa.etiquetas')} values={f.labels} suggestions={st.data!.labels} onChange={(labels) => void setF({ labels })} placeholder={t('conexoes.wa.etiquetasExemplo')} />
          <ListEditor label={t('conexoes.wa.nuncaLer')} values={f.exceptions} suggestions={st.data!.chats.map((c) => c.name)} onChange={(exceptions) => void setF({ exceptions })} placeholder={t('conexoes.wa.nuncaLerExemplo')} />
          <Disconnect i={i} reload={() => { st.reload(); reload(); }} label={t('conexoes.wa.desconectar')} />
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {i.state === 'connected' && st.data && !st.data.riscosAceitos && (
        <div className="conn-reautorizar">
          <p className="warn">{t('conexoes.wa.podemResponder')}</p>
          <button className="btn btn--primary" onClick={() => setAceite(true)}>{t('conexoes.wa.verEAceitar')}</button>
        </div>
      )}
      {aceite && <WhatsAppRisks onClose={() => setAceite(false)} onAccept={async () => { setAceite(false); try { await api.post('/api/integrations/whatsapp/aceitar-riscos'); st.reload(); } catch (e) { setErr(errMsg(e)); } }} />}
      {ask && <WhatsAppRisks onClose={() => setAsk(false)} onAccept={() => void start(true)} />}
    </>
  );
}

/** Informações e riscos do WhatsApp experimental. Com onAccept, conectar só depois do "li e entendi". Mudou o texto
 *  em algo que importa? Suba WA_RISKS_VERSION (server/src/services/whatsapp.ts) para pedir o aceite de novo. */
type ItemDeRisco = 'c1' | 'c2' | 'c3' | 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6';
function WhatsAppRisks({ onClose, onAccept }: { onClose: () => void; onAccept?: () => void }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  /** um item da lista: a frase inteira, com o trecho em negrito no lugar de {destaque} */
  const item = (frase: `conexoes.riscos.${ItemDeRisco}`, destaque: `conexoes.riscos.${ItemDeRisco}Destaque`) => <li>{tn(frase, { destaque: <b>{t(destaque)}</b> })}</li>;
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="wa-risks-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="auth__card wa-risks">
        <h2 className="auth__title" id="wa-risks-title">{t('conexoes.riscos.titulo')}</h2>
        <h4>{t('conexoes.riscos.comoFunciona')}</h4>
        <ul className="small">
          {item('conexoes.riscos.c1', 'conexoes.riscos.c1Destaque')}
          {item('conexoes.riscos.c2', 'conexoes.riscos.c2Destaque')}
          {item('conexoes.riscos.c3', 'conexoes.riscos.c3Destaque')}
          <li>{t('conexoes.riscos.c4')}</li>
        </ul>
        <h4>{t('conexoes.riscos.riscos')}</h4>
        <ul className="small">
          {item('conexoes.riscos.r1', 'conexoes.riscos.r1Destaque')}
          {item('conexoes.riscos.r2', 'conexoes.riscos.r2Destaque')}
          {item('conexoes.riscos.r3', 'conexoes.riscos.r3Destaque')}
          {item('conexoes.riscos.r4', 'conexoes.riscos.r4Destaque')}
          {item('conexoes.riscos.r5', 'conexoes.riscos.r5Destaque')}
          {item('conexoes.riscos.r6', 'conexoes.riscos.r6Destaque')}
        </ul>
        <h4>{t('conexoes.riscos.parar')}</h4>
        <p className="small">{tn('conexoes.riscos.pararTexto', { aparelhos: <b>{t('conexoes.wa.aparelhosConectados')}</b> })}</p>
        {onAccept ? (
          <>
            <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {t('conexoes.riscos.li')}</label>
            <button className="btn btn--primary btn--block" disabled={!ok} onClick={onAccept}>{t('conexoes.riscos.aceitar')}</button>
            <button className="btn btn--block auth__alt" onClick={onClose}>{t('conexoes.riscos.agoraNao')}</button>
          </>
        ) : (
          <button className="btn btn--block" onClick={onClose}>{t('conexoes.acao.fechar')}</button>
        )}
      </div>
    </div>
  );
}

function ListEditor({ label, values, suggestions, onChange, placeholder }: { label: string; values: string[]; suggestions: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const t = useT();
  const [v, setV] = useState('');
  const add = (x: string) => { const s = x.trim(); if (s && !values.includes(s)) onChange([...values, s]); setV(''); };
  const sugg = suggestions.filter((s) => !values.includes(s) && (!v || s.toLowerCase().includes(v.toLowerCase()))).slice(0, 6);
  return (
    <div className="field">
      {label}
      <div className="row row--wrap">
        {values.map((x) => <span key={x} className="skill">{x} <button className="x" onClick={() => onChange(values.filter((y) => y !== x))} aria-label={t('conexoes.lista.tirar', { item: x })}>×</button></span>)}
        <form className="row" onSubmit={(e) => { e.preventDefault(); add(v); }}><input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={label} /></form>
      </div>
      {sugg.length > 0 && v && <div className="row row--wrap">{sugg.map((s) => <button key={s} className="chip" onClick={() => add(s)}>+ {s}</button>)}</div>}
    </div>
  );
}

/** GET /api/canais: conversar com a equipe pelo Telegram e pelo Discord (o bot da própria pessoa). */
type NomeCanal = 'telegram' | 'discord';
interface EstadoCanal {
  disponivel: boolean; motivo?: 'motor' | 'versao'; bot: boolean; conexao: 'conectado' | 'conectando' | 'sem_conexao' | null; codigoRecusado?: boolean;
  ligado: { nome: string | null; desde: string; avisos: boolean } | null;
}
const ERRO_CANAL: Record<string, `conexoes.canal.erro.${'formato' | 'codigo' | 'tentativas' | 'motor'}`> = {
  formato: 'conexoes.canal.erro.formato', codigo: 'conexoes.canal.erro.codigo', tentativas: 'conexoes.canal.erro.tentativas', motor: 'conexoes.canal.erro.motor',
};

/**
 * Conexões › "Conversar com a equipe pelo Telegram / pelo Discord": a pessoa cria o bot dela, cola o código (fica com a
 * equipe dela, protegido), manda uma mensagem ao bot, digita o código que ele responde e confirma com a senha. Daí em
 * diante, o que ela escreve ao bot vai para a equipe, e as respostas, os cartões e os avisos voltam por lá.
 */
function ConversaPorCanal({ canal, estado, reload }: { canal: NomeCanal; estado: EstadoCanal; reload: () => void }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [codigo, setCodigo] = useState('');
  const [senha, setSenha] = useState('');
  const [trocar, setTrocar] = useState(false);
  const [desligar, setDesligar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const nome = canal === 'telegram' ? 'Telegram' : 'Discord';
  const agir = async (fn: () => Promise<unknown>, depois?: () => void) => {
    setErr(null); setBusy(true);
    try { await fn(); depois?.(); reload(); } catch (x) {
      if (x instanceof ApiError && x.code === 'invalid_login') setErr(t('conexoes.canal.senhaIncorreta'));
      else if (x instanceof ApiError && ERRO_CANAL[x.code]) setErr(t(ERRO_CANAL[x.code]));
      else setErr(errMsg(x));
    } finally { setBusy(false); }
  };
  const e = estado;
  const titulo = canal === 'telegram' ? t('conexoes.canal.titulo.telegram') : t('conexoes.canal.titulo.discord');
  const conexao = e.conexao === 'conectado' ? t('conexoes.canal.conexao.conectado') : e.conexao === 'sem_conexao' ? t('conexoes.canal.conexao.semConexao') : e.conexao === 'conectando' ? t('conexoes.canal.conexao.conectando') : null;
  const passos = canal === 'telegram'
    ? <ol className="small">
        <li>{tn('conexoes.canal.tg.passo1', { botfather: <a href="https://t.me/BotFather" target="_blank" rel="noreferrer noopener">@BotFather</a> })}</li>
        <li>{t('conexoes.canal.tg.passo2')}</li>
        <li>{t('conexoes.canal.tg.passo3')}</li>
      </ol>
    : <ol className="small">
        <li>{tn('conexoes.canal.dc.passo1', { portal: <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer noopener">{t('conexoes.canal.dc.portal')}</a> })}</li>
        <li>{t('conexoes.canal.dc.passo2')}</li>
        <li>{t('conexoes.canal.dc.passo3')}</li>
        <li>{t('conexoes.canal.dc.passo4')}</li>
      </ol>;
  const formBot = (
    <form className="row row--wrap" onSubmit={(ev) => { ev.preventDefault(); void agir(() => api.put(`/api/canais/${canal}/bot`, { token: token.trim() }), () => { setToken(''); setTrocar(false); }); }}>
      <label className="field">{t('conexoes.canal.codigoDoBot')}<input type="password" value={token} onChange={(ev) => setToken(ev.target.value)} autoComplete="off" spellCheck={false} maxLength={200} /></label>
      <button className="btn btn--sm btn--primary" disabled={busy || token.trim().length < 20}>{busy ? t('conexoes.acao.conferindo') : t('conexoes.canal.guardar')}</button>
      {trocar && <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setTrocar(false); setToken(''); }}>{t('conexoes.canal.cancelar')}</button>}
    </form>
  );
  return (
    <article className={`card conn feature ${e.ligado ? 'feature--on' : ''}`}>
      <header className="row"><BrandLogo kind={canal} name={nome} size={36} /><strong>{titulo}</strong></header>
      <p className="muted">{t('conexoes.canal.intro')}</p>
      {!e.disponivel ? <p className="hint">{e.motivo === 'versao' ? t('conexoes.canal.indisponivel.versao') : t('conexoes.canal.indisponivel.motor')}</p> : <>
        {e.ligado ? <>
          <p>{tn('conexoes.canal.ligadoComo', { nome: <b>{e.ligado.nome || t('conexoes.canal.contaSemNome')}</b>, data: fmtData(e.ligado.desde) })}</p>
          {conexao && <p className="small" role="status">{conexao}</p>}
          {e.codigoRecusado && <p className="warn">{t('conexoes.canal.codigoRecusado', { canal: nome })}</p>}
          <label className="check"><input type="checkbox" checked={e.ligado.avisos} disabled={busy} onChange={(ev) => void agir(() => api.patch(`/api/canais/${canal}`, { avisos: ev.target.checked }))} /> {t('conexoes.canal.avisar')}</label>
          {pronto && <p className="ok" role="status">{t('conexoes.canal.pronto')}</p>}
        </> : !e.bot || trocar ? <>
          {passos}
          {formBot}
          <p className="hint">{t('conexoes.canal.guardado')}</p>
        </> : <>
          {conexao && <p className="small" role="status">{conexao}</p>}
          {e.codigoRecusado && <p className="warn">{t('conexoes.canal.codigoRecusado', { canal: nome })}</p>}
          <p>{t('conexoes.canal.parear.passo')}</p>
          <form className="row row--wrap" onSubmit={(ev) => { ev.preventDefault(); void agir(() => api.post(`/api/canais/${canal}/parear`, { codigo, password: senha }), () => { setCodigo(''); setSenha(''); setPronto(true); }); }}>
            <label className="field">{t('conexoes.canal.parear.codigo')}<input value={codigo} onChange={(ev) => setCodigo(ev.target.value)} placeholder="ABCD2345" autoComplete="off" spellCheck={false} maxLength={20} /></label>
            <input type="password" autoComplete="current-password" placeholder={t('conexoes.canal.suaSenha')} aria-label={t('conexoes.canal.suaSenha')} value={senha} onChange={(ev) => setSenha(ev.target.value)} />
            <button className="btn btn--sm btn--primary" disabled={busy || !senha || codigo.replace(/[\s-]/g, '').length < 8}>{busy ? t('conexoes.acao.conferindo') : t('conexoes.canal.parear.ligar')}</button>
          </form>
          <p className="hint">{t('conexoes.canal.parear.quemEscreve')}</p>
        </>}
        {err && <p className="err" role="alert">{err}</p>}
        {(e.bot || e.ligado) && !trocar && <div className="row row--wrap">
          {!e.ligado && <button className="btn btn--sm btn--ghost" onClick={() => setTrocar(true)}>{t('conexoes.canal.trocarBot')}</button>}
          {desligar
            ? <div className="confirm">{t('conexoes.canal.desligarPergunta')}
                <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void agir(() => api.del(`/api/canais/${canal}`), () => { setDesligar(false); setPronto(false); })}>{t('conexoes.canal.desligar')}</button>
                <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(false)}>{t('conexoes.canal.cancelar')}</button></div>
            : <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(true)}>{t('conexoes.canal.desligar')}</button>}
        </div>}
        <p className="hint">{canal === 'telegram' ? t('conexoes.canal.fechado.telegram') : t('conexoes.canal.fechado.discord')} {t('conexoes.canal.soDireta')}</p>
      </>}
    </article>
  );
}

/** A seção dos dois canais (o lugar fica reservado até a resposta, que vem na pré-carga). */
function ConversaPorCanais() {
  const t = useT();
  const st = useResource<Record<NomeCanal, EstadoCanal>>('/api/canais', ['canais.changed']);
  return (
    <section className="conn-group conn-group--feature" id="conn-canais">
      <h3>{t('conexoes.canal.secaoTitulo')}</h3>
      <p className="muted small">{t('conexoes.canal.secaoTexto')}</p>
      <div className="feature-grid">
        {st.data
          ? (['telegram', 'discord'] as const).map((c) => <ConversaPorCanal key={c} canal={c} estado={st.data![c]} reload={st.reload} />)
          : <article className="card conn feature" aria-hidden="true" style={{ visibility: 'hidden' }}><p className="muted">…</p></article>}
      </div>
    </section>
  );
}

/** GET /api/teams-app: conversar com a equipe pelo Teams (o app público, ligado por código). */
interface TeamsVinculo { id: string; teamsName: string | null; linkedAt: string; notices: boolean; status: 'active' | 'paused' | 'revoked'; revokedBy?: string }
interface EstadoTeams {
  available: boolean; reason?: string; connection: 'connected' | 'connecting' | 'offline'; enabled: boolean; bindings: TeamsVinculo[];
  teamsAppUrl?: string; problem?: string; relay?: { fromEnv: boolean; url: string | null };
}
interface PreviaTeams { claimId: string; teamsName: string; conta?: ContaDoTeams; organizacao?: string | null }
/** Por que a conta do Teams caiu: o código que vem do servidor → a chave do texto. */
const DESLIGADA_POR: Record<string, `conexoes.teams.desligadaPor.${'teams' | 'uninstall' | 'blocked' | 'relay'}`> = {
  teams: 'conexoes.teams.desligadaPor.teams', uninstall: 'conexoes.teams.desligadaPor.uninstall', blocked: 'conexoes.teams.desligadaPor.blocked', relay: 'conexoes.teams.desligadaPor.relay',
};
const dataCurta = (iso: string) => fmtData(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Conexões › Teams › "Conversar com a equipe pelo Teams": a pessoa fala com o app no Teams, o app mostra um código, ela
 * digita aqui, vê de quem é a conta e confirma com a senha. Daí em diante, o que ela escreve lá vai para a equipe e a
 * resposta volta lá; o que precisa dela também avisa lá (ligado por padrão).
 */
function TeamsConversa() {
  const t = useT();
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
    try { await fn(); st.reload(); } catch (x) { setErr(x instanceof ApiError && x.code === 'invalid_login' ? t('conexoes.teams.senhaIncorreta') : errMsg(x)); } finally { setBusy(false); }
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
  if (!d) return <article className="card conn feature" aria-hidden="true" style={{ visibility: 'hidden' }}><strong>{t('conexoes.teams.titulo')}</strong><p className="muted">…</p></article>;
  const ligados = d.bindings.filter((b) => b.status !== 'revoked');
  const caidos = d.bindings.filter((b) => b.status === 'revoked');
  const problema = problemaDoTeams(d.problem);
  const linha = linhaDoEstado(d.connection, d.problem);
  return (
    <article className={`card conn feature ${ligados.length ? 'feature--on' : ''}`}>
      <header className="row"><BrandLogo kind="teams" name="Teams" size={36} /><strong>{t('conexoes.teams.titulo')}</strong>
        {d.available ? <span className={`badge ${d.connection === 'connected' ? 'badge--ok' : 'badge--warn'}`}>{d.connection === 'connected' ? t('conexoes.estado.connected') : t('conexoes.estado.semConexao')}</span> : <span className="badge badge--soon">{t('conexoes.estado.soon')}</span>}</header>
      <p className="muted">{t('conexoes.teams.intro')}</p>
      {!d.available ? <p className="hint">{t('conexoes.teams.emBreve')}</p> : <>
        {problema && <p className="warn">{problema}</p>}
        {linha && <p className="small">{linha}</p>}
        {(ligados.length > 0 || caidos.length > 0) && (
          <label className="check"><input type="checkbox" checked={d.enabled} disabled={busy} onChange={(e) => void agir(() => api.post('/api/teams-app/enabled', { enabled: e.target.checked }))} /> {t('conexoes.teams.conversarPeloTeams')}</label>
        )}
        {ligados.length > 0 && (
          <ul className="conn-teams-lista">
            {ligados.map((b) => (
              <li key={b.id}>
                <div>{tn('conexoes.teams.ligadoEm', { nome: <b>{b.teamsName ?? t('conexoes.teams.contaDoTeams')}</b>, data: dataCurta(b.linkedAt) })}{b.status === 'paused' ? <span className="muted small"> {t('conexoes.teams.conversaDesligada')}</span> : null}</div>
                <label className="check"><input type="checkbox" checked={b.notices} disabled={busy} onChange={(e) => void agir(() => api.patch(`/api/teams-app/bindings/${b.id}`, { notices: e.target.checked }))} /> {t('conexoes.teams.avisar')}</label>
                {desligar === b.id
                  ? <div className="confirm">{t('conexoes.teams.desligarPergunta')}
                      <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void agir(async () => { await api.del(`/api/teams-app/bindings/${b.id}`); setDesligar(null); })}>{t('conexoes.teams.desligar')}</button>
                      <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(null)}>{t('conexoes.acao.cancelar')}</button></div>
                  : <button className="btn btn--sm btn--ghost" onClick={() => setDesligar(b.id)}>{t('conexoes.teams.desligar')}</button>}
              </li>
            ))}
          </ul>
        )}
        {caidos.map((b) => (
          <p key={b.id} className="warn">{t('conexoes.teams.caida', { nome: b.teamsName ?? t('conexoes.teams.contaDoTeams'), motivo: DESLIGADA_POR[b.revokedBy ?? ''] ? t(DESLIGADA_POR[b.revokedBy ?? '']) : t('conexoes.teams.desligada') })}{' '}
            <button className="link link--inline" disabled={busy} onClick={() => void agir(() => api.del(`/api/teams-app/bindings/${b.id}`))}>{t('conexoes.teams.tirarDaLista')}</button></p>
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
                setPronto(t('conexoes.teams.pronto', { nome: previa.teamsName }));
                setPrevia(null); setSenha(''); setCodigo(''); setCiente(false);
              });
            }}>
              <p><b>{pv.pergunta}</b></p>
              <p className="hint">{nomeEscolhido()} {soOSeuCodigo()}</p>
              {pv.aviso && <p className={pv.forte ? 'error' : 'warn'} role="alert">{pv.aviso}</p>}
              {pv.exigeEscolha && <label className="check"><input type="checkbox" checked={ciente} disabled={busy} onChange={(e) => setCiente(e.target.checked)} /> {escolhaConsciente()}</label>}
              <p className="hint">{t('conexoes.teams.quemEscreve')}</p>
              <div className="row row--wrap">
                <input type="password" autoComplete="current-password" required placeholder={t('conexoes.teams.suaSenha')} aria-label={t('conexoes.teams.suaSenha')} value={senha} onChange={(e) => setSenha(e.target.value)} />
                <button className="btn btn--sm btn--primary" disabled={busy || !senha || (pv.exigeEscolha && !ciente)}>{busy ? t('conexoes.acao.conferindo') : t('conexoes.teams.ligar')}</button>
                <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => { const c = previa; setPrevia(null); setSenha(''); setCiente(false); void api.post('/api/teams-app/cancel', { claimId: c.claimId }).catch(() => undefined); }}>{t('conexoes.acao.cancelar')}</button>
              </div>
            </form>
          );
        })() : (
          <form onSubmit={(e) => { e.preventDefault(); if (!preparando) void pedirPrevia(); }}>
            <ol className="small conn-passos">
              <li>{tn('conexoes.teams.passo1', { ergon: <b>Ergon</b> })}{d.teamsAppUrl && <> <a href={d.teamsAppUrl} target="_blank" rel="noreferrer noopener">{t('conexoes.teams.abrirNoTeams')}</a></>}</li>
              <li>{t('conexoes.teams.passo2')}</li>
              <li>{t('conexoes.teams.passo3')}</li>
            </ol>
            <p className="hint">{soOSeuCodigo()}</p>
            <div className="row row--wrap">
              <label className="field">{t('conexoes.teams.codigo')}<input value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder={t('conexoes.teams.codigoExemplo')} autoComplete="off" spellCheck={false} maxLength={20} /></label>
              <button className="btn btn--sm btn--primary" disabled={busy || preparando > 0 || codigo.replace(/[\s-]/g, '').length < 8}>{busy || preparando ? t('conexoes.acao.conferindo') : t('conexoes.teams.confirmar')}</button>
            </div>
            {preparando > 0 && <p className="small" role="status">{t('conexoes.teams.preparando')}</p>}
          </form>
        )}
        <p className="hint">{t('conexoes.teams.soDireta')}</p>
      </>}
      {err && <p className="error" role="alert">{err}</p>}
      {d.relay && !d.relay.fromEnv && <EnderecoTeams atual={d.relay.url} reload={st.reload} />}
    </article>
  );
}

/** Ajuste da instalação (quem administra o Ergon neste computador): o endereço do serviço do Teams. */
function EnderecoTeams({ atual, reload }: { atual: string | null; reload: () => void }) {
  const t = useT();
  const [url, setUrl] = useState(atual ?? '');
  const [err, setErr] = useState<string | null>(null);
  return (
    <details className="small">
      <summary>{t('conexoes.teams.ajusteInstalacao')}</summary>
      <form className="row row--wrap" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { await api.put('/api/teams-app/relay-url', { url: url.trim() || null }); reload(); } catch (x) { setErr(errMsg(x)); }
      }}>
        <label className="field">{t('conexoes.teams.endereco')}<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} /></label>
        <button className="btn btn--sm">{t('conexoes.acao.salvar')}</button>
      </form>
      {err && <p className="error">{err}</p>}
    </details>
  );
}

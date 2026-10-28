import { Fragment, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { Integration } from '../lib/types.ts';
import { AiAccounts } from '../components/AiAccounts.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { Icon } from '../components/Icon.tsx';

const STATE: Record<Integration['state'], [string, string]> = {
  off: ['não conectado', ''], pending: ['conectando…', 'badge--warn'], connected: ['conectado', 'badge--ok'], error: ['com problema', 'badge--err'],
};

const badgeOf = (i: Integration): [string, string] => (i.auth === 'soon' ? ['em breve', 'badge--soon'] : STATE[i.state]);

/**
 * Conexões, nesta ordem: as contas de IA (recomendando a Nous), o WhatsApp e as contas Microsoft 365 e Google em
 * destaque, e depois os aplicativos de tarefas e quadros, na ordem de fama no Brasil. "Conectado" só depois de
 * conferir com o serviço; "em breve" diz o que falta.
 */
export function ConexoesView() {
  const list = useResource<Integration[]>('/api/integrations', ['integrations.changed']);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [risks, setRisks] = useState(false);
  useEffect(() => {
    const m = location.hash.match(/(microsoft|google)=([a-z]+)/);
    if (m) {
      const who = m[1] === 'google' ? 'Google' : 'Microsoft';
      setNotice(m[2] === 'conectado' ? `Conta ${who} conectada.` : m[2] === 'recusado' ? `Login ${m[1] === 'google' ? 'do' : 'da'} ${who} cancelado.` : `Não deu para concluir o login ${m[1] === 'google' ? 'do' : 'da'} ${who}. Tente de novo.`);
      setOpen(m[1]);
      history.replaceState(null, '', '#conexoes');
    }
  }, []);
  const all = list.data ?? [];
  const term = q.trim().toLowerCase();
  const apps = all.filter((i) => i.group === 'tarefas');
  // a ordem do servidor já é a de fama no Brasil; conectadas primeiro, "em breve" por último
  const shown = apps.filter((i) => (!onlyOn || i.state === 'connected') && (!term || `${i.name} ${i.about}`.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.state === 'connected') - Number(a.state === 'connected') || Number(a.auth === 'soon') - Number(b.auth === 'soon'));
  const connected = apps.filter((i) => i.state === 'connected').length;
  const ready = apps.filter((i) => i.auth !== 'soon').length;
  const wa = all.find((i) => i.kind === 'whatsapp');
  const accounts = all.filter((i) => i.group === 'contas');
  return (
    <div className="page">
      <header className="page__head">
        <h2>Conexões</h2>
        <p className="muted">A conta de IA que move os agentes e os aplicativos e canais que a equipe lê para você. Credenciais ficam só neste computador, cifradas; nunca no navegador.</p>
      </header>
      {notice && <p className="ok" role="status">{notice}</p>}
      {list.error && <p className="error">{list.error}</p>}

      <section className="conn-group conn-group--feature">
        <h3>Contas de IA</h3>
        <p className="muted small">A conta que paga os modelos que os agentes usam.</p>
        <AiAccounts />
      </section>

      {wa && (
        <section className="conn-group conn-group--feature">
          <h3>WhatsApp <span className="badge badge--exp">Experimental</span></h3>
          <p className="muted small">As conversas que você permitir viram pedidos e tarefas para a equipe. Somente leitura. <button className="link link--inline" onClick={() => setRisks(true)}>Ver informações e riscos</button></p>
          <Detail i={wa} reload={list.reload} feature />
          {risks && <WhatsAppRisks onClose={() => setRisks(false)} />}
        </section>
      )}

      {accounts.length > 0 && (
        <section className="conn-group conn-group--feature">
          <h3>Microsoft 365 e Google</h3>
          <p className="muted small">Entre com a conta, sem digitar senha no Ergon. Microsoft: Planner, To Do, Teams, e-mail, agenda e arquivos (só leitura). Google: Tasks, Agenda, Gmail e Drive (só leitura).</p>
          <div className="feature-grid">{accounts.map((i) => <Detail key={i.kind} i={i} reload={list.reload} feature />)}</div>
        </section>
      )}

      <section className="conn-group">
        <h3>Tarefas e quadros</h3>
        <p className="muted small">Depois de conectar, escolha a lista ou o quadro em Tarefas: o espelho traz título, descrição, situação e responsável, só leitura.</p>
        <div className="row row--wrap conn-tools">
          <label className="conn-search"><Icon name="focus" size={14} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar (ex.: Trello, Jira, Notion)" aria-label="Procurar aplicativo" /></label>
          <button className={`chip ${!onlyOn ? 'chip--on' : ''}`} aria-pressed={!onlyOn} onClick={() => setOnlyOn(false)}>Todos ({ready})</button>
          <button className={`chip ${onlyOn ? 'chip--on' : ''}`} aria-pressed={onlyOn} onClick={() => setOnlyOn(true)}>Conectados ({connected})</button>
        </div>
        <div className="conn-tiles">
          {shown.map((i) => {
            const [label, cls] = badgeOf(i);
            return (
              <Fragment key={i.kind}>
                <button className={`conn-tile ${open === i.kind ? 'conn-tile--on' : ''} ${i.auth === 'soon' ? 'conn-tile--soon' : ''}`} onClick={() => setOpen(open === i.kind ? null : i.kind)} aria-expanded={open === i.kind}>
                  <BrandLogo kind={i.kind} name={i.name} />
                  <span className="conn-tile__txt"><b>{i.name}</b><span className={`badge ${cls}`}>{label}</span></span>
                </button>
                {open === i.kind && <Detail i={i} reload={list.reload} onClose={() => setOpen(null)} />}
              </Fragment>
            );
          })}
        </div>
        {list.data && !shown.length && <p className="muted">Nada encontrado{term ? ` para "${q}"` : ''}.</p>}
      </section>
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

function Detail({ i, reload, onClose, feature }: { i: Integration; reload: () => void; onClose?: () => void; feature?: boolean }) {
  const [label, cls] = badgeOf(i);
  return (
    <article className={`card conn ${feature ? 'feature' : 'conn-detail'} ${feature && i.state === 'connected' ? 'feature--on' : ''}`}>
      <header className="row">
        <BrandLogo kind={i.kind} name={i.name} size={feature ? 36 : 32} />
        <strong>{i.name}</strong><span className={`badge ${cls}`}>{label}</span>
        {onClose && <button className="icon-btn conn-detail__x" onClick={onClose} aria-label="Fechar"><Icon name="x" size={16} /></button>}
      </header>
      <p className="muted">{i.about}</p>
      {i.state === 'connected' && i.account && <p>Conta: <strong>{i.account}</strong>{i.lastSyncAt ? <span className="muted small"> · última leitura {new Date(i.lastSyncAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span> : null}</p>}
      {i.error && i.state !== 'connected' && <p className="error">{i.error}</p>}
      {i.state === 'connected' && i.renewBy && <RenewBy at={i.renewBy} />}
      {i.auth === 'soon' ? <p className="hint">{i.soon ?? 'Em preparo.'}</p>
        : i.kind === 'whatsapp' ? <WhatsApp i={i} reload={reload} />
        : i.auth === 'token' ? <TokenConnect i={i} reload={reload} />
        : <Sso i={i} reload={reload} />}
      {i.state === 'connected' && i.tasks && <p className="hint">Próximo passo: em <a href="#tarefas">Tarefas</a>, escolha a lista ou o quadro para espelhar.</p>}
    </article>
  );
}

function Disconnect({ i, reload, label = 'Desconectar' }: { i: Integration; reload: () => void; label?: string }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ask) return <button className="btn btn--sm btn--ghost" onClick={() => setAsk(true)}>{label}</button>;
  return (
    <div className="confirm">
      Desconectar {i.name}? As credenciais guardadas neste computador são apagadas; o que já foi lido continua no Ergon.
      <button className="btn btn--sm btn--primary" onClick={async () => { try { await api.del(`/api/integrations/${i.kind}`); setAsk(false); reload(); } catch (e) { setErr(errMsg(e)); } }}>Desconectar</button>
      <button className="btn btn--sm btn--ghost" onClick={() => setAsk(false)}>Cancelar</button>
      {err && <span className="error">{err}</span>}
    </div>
  );
}

/** Credencial colada: um ou mais campos (token, chave, endereço, e-mail), conferidos no serviço antes de conectar. */
function TokenConnect({ i, reload }: { i: Integration; reload: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (i.state === 'connected') return <Disconnect i={i} reload={reload} />;
  const fields = i.fields.length ? i.fields : [{ name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui' }];
  const filled = fields.every((f) => (v[f.name] ?? '').trim().length > 0);
  // Trello: com a chave digitada, o link já abre a autorização (só leitura, sem validade) para gerar o token
  const trelloKey = i.kind === 'trello' && /^[a-f0-9]{32}$/i.test((v.key ?? '').trim()) ? v.key.trim() : null;
  return (
    <form className="token-form" onSubmit={async (e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      try { await api.post(`/api/integrations/${i.kind}/token`, { credentials: Object.fromEntries(fields.map((f) => [f.name, (v[f.name] ?? '').trim()])) }); setV({}); reload(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
    }}>
      {i.help && <p className="hint">{i.help.steps} <a href={i.help.url} target="_blank" rel="noreferrer noopener">Abrir a página</a></p>}
      {trelloKey && <p className="hint"><a href={`https://trello.com/1/authorize?expiration=never&scope=read&response_type=token&name=Ergon&key=${trelloKey}`} target="_blank" rel="noreferrer noopener">Gerar o token (só leitura)</a> e cole abaixo.</p>}
      {fields.map((f) => (
        <label key={f.name} className="field">{f.label}
          <input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={v[f.name] ?? ''} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
        </label>
      ))}
      <button className="btn btn--primary" disabled={busy || !filled}>{busy ? 'Conferindo…' : 'Conectar'}</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

/** Textos de cada login com a conta (o mecanismo é um só no servidor: sso.ts). */
const SSO_TEXT: Record<string, { button: string; what: string; connected: string }> = {
  microsoft: {
    button: 'Entrar com a Microsoft',
    what: 'Você entra na página da Microsoft e autoriza o aplicativo Ergon a ler suas tarefas (Planner e To Do), conversas do Teams, e-mail, agenda e arquivos, para as rotinas. Só leitura: nada é enviado, apagado ou alterado em seu nome.',
    connected: 'Tarefas: escolha um plano do Planner ou uma lista do To Do em Tarefas. Teams: as conversas chegam quando o app do Ergon estiver instalado no seu Teams (pela loja de apps do Teams).',
  },
  google: {
    button: 'Entrar com o Google',
    what: 'Você entra na página do Google e autoriza o aplicativo Ergon a ler suas listas do Google Tasks, agenda, Gmail e Drive, para as rotinas. Só leitura: nada é enviado, apagado ou alterado em seu nome.',
    connected: 'Tarefas: escolha uma lista do Google Tasks em Tarefas; o espelho atualiza sozinho.',
  },
};

function Sso({ i, reload }: { i: Integration; reload: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const t = SSO_TEXT[i.kind] ?? { button: `Entrar com ${i.name}`, what: '', connected: '' };
  if (i.state === 'connected') return (
    <>
      {t.connected && <p className="hint">{t.connected}</p>}
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
          <p className="hint">Experimental e somente leitura: nada é enviado, nada é marcado como lido e você não aparece "online". Usa uma biblioteca de código aberto, não oficial do WhatsApp. Prefira um número de trabalho.</p>
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
          <li><b>Somente leitura:</b> nada é enviado, nada é marcado como lido e você não aparece "online".</li>
          <li>Só entram as conversas que os filtros permitem (grupos começam desligados), e dá para pôr exceções, como "Família".</li>
        </ul>
        <h4>Riscos</h4>
        <ul className="small">
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

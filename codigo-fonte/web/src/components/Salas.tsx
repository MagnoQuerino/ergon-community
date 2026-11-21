// Salas (rc.42): conversa em grupo com pessoas do workspace e agentes como colegas. A lista na navegação das conversas
// (com não lidas e o destaque de menção e de pedido de conexões), a sala aberta (o campo com @ e #, as respostas dos
// agentes, o cartão de cessão de quem foi marcado), membros, e os pedaços que outras telas usam (o sino, Conexões e a
// Governança). Tela limpa: o visual guia (borda que pulsa, brilho), os textos são curtos.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtData, fmtHora, useT } from '../i18n/index.ts';
import { api, errMsg, requestId, uploadFile } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openSala } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { aoEnviar, backspace, editar, escolher, esquecerRecem, pedacos, sugestoes, tokenAtivo, vazio, type Campo, type Candidato } from '../lib/mencoes.ts';
import type { Attachment, Message } from '../lib/types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { GravadorDeVoz } from './GravadorDeVoz.tsx';
import { ConversaPorVoz } from './ConversaPorVoz.tsx';
import { RECURSOS, type RecursosEstado } from '../lib/recursos.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { NavegadorAoVivo } from './NavegadorAoVivo.tsx';

type Prazo = 'vez' | '24h' | '7d' | '30d' | 'sempre';
const PRAZOS: Prazo[] = ['vez', '24h', '7d', '30d', 'sempre']; // i18n-ok: os códigos dos prazos (o servidor), não texto de tela
interface SalaLinha { id: string; nome: string; arquivada: boolean; ultimaEm: string | null; naoLidas: number; mencao: boolean; cessao: boolean; ultima: { nome: string | null; texto: string } | null }
interface ListaSalas { salas: SalaLinha[]; podeCriar: boolean; avisos: number }
interface Membro { tipo: 'pessoa' | 'agente'; chave: string; nome: string; admin: boolean }
interface Detalhe { id: string; nome: string; arquivada: boolean; eu: string; admin: boolean; papel: string | null; membros: Membro[];
  /** é um tópico: a sala-mãe e a visibilidade */ topico?: { pai: string; paiNome: string; visibilidade: 'privado' | 'compartilhado'; origem: string | null } }
interface TopicoLinha { id: string; nome: string; arquivado: boolean; privado: boolean; origem: string | null; respostas: number; ultimaEm: string | null; naoLidas: number }
interface AgenteDisp { chave: string; nome: string; id: string; role: string; color: string; char_key: string | null }
interface Disponiveis { pessoas: Array<{ chave: string; nome: string; papel: string; eu: boolean }>; agentes: AgenteDisp[] }
interface Evento { evento: string; nome?: string; alvo?: string; prazo?: Prazo; agente?: string }
interface Msg { id: string; role: 'user' | 'agent' | 'system'; content: string; created_at: string; autor: { chave: string | null; nome: string | null }; marcas: unknown; pedinte: string | null; attachments?: Attachment[];
  /** o tópico que nasceu desta mensagem (só se a pessoa o vê) */ topico?: { id: string; nome: string; respostas: number; arquivado: boolean; privado: boolean };
  /** anexos que nasceram em outro computador: a ficha, até alguém baixar */ remotos?: Array<{ ref: string; filename: string; mime: string; size: number; estado: 'remoto' | 'baixando' | 'grande' }> }
interface Mensagens { mensagens: Msg[]; respondendo: Array<{ agentId: string; nome: string; status: string }> }
export interface AvisoSala { id: string; conversation_id: string; message_id: string; tipo: 'mencao' | 'cessao'; de_nome: string; agente: string | null; created_at: string; sala: string; texto: string | null }

const EVENTOS = ['salas.changed', 'messages.changed'];
const inicial = (n: string) => (n.trim()[0] ?? '?').toUpperCase();

/** O rosto de uma pessoa (a inicial; a cor vem do nome, da paleta de sempre). */
function Rosto({ nome, size = 30 }: { nome: string; size?: number }) {
  const cor = ['agua', 'marca', 'dourado', 'info', 'sucesso'][[...nome].reduce((n, c) => n + c.charCodeAt(0), 0) % 5];
  return <span className={`sala-rosto sala-rosto--${cor}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden="true">{inicial(nome)}</span>;
}

// ------------------------------------------------------------------------------------------------ a lista na navegação
/** As salas, no topo da lista das conversas: não lidas, menção (borda que pulsa) e pedido de conexões (brilho dourado). */
export function SalasSecao({ atual, onAbrir }: { atual: string | null; onAbrir: (id: string) => void }) {
  const t = useT();
  const l = useResource<ListaSalas>('/api/salas', EVENTOS);
  const [criando, setCriando] = useState(false);
  const salas = (l.data?.salas ?? []).filter((s) => !s.arquivada || s.id === atual);
  if (!l.data) return null;
  return (
    <div className="convs__section sala-secao">
      <span className="convs__section-name sala-secao__head">
        {t('conversas.sala.secao')}
        {l.data.podeCriar && <button type="button" className="icon-btn sala-secao__nova" onClick={() => setCriando(true)} aria-label={t('conversas.sala.nova')} title={t('conversas.sala.nova')}><Icon name="plus" size={14} /></button>}
      </span>
      <ul>
        {salas.map((s) => (
          <li key={s.id}>
            <button type="button" className={`convs__item sala-item ${s.id === atual ? 'is-on' : ''} ${s.naoLidas ? 'is-unread' : ''} ${s.mencao ? 'sala-item--mencao' : ''} ${s.cessao ? 'sala-item--cessao' : ''}`}
              aria-current={s.id === atual ? 'true' : undefined} onClick={() => onAbrir(s.id)}
              aria-label={[s.nome, s.mencao ? t('conversas.sala.mencionouVoce') : '', s.cessao ? t('conversas.sala.pedeConexoes') : '', s.naoLidas ? t('conversas.marca.naoLidas', { n: s.naoLidas }) : ''].filter(Boolean).join(', ')}>
              <span className="sala-item__icone" aria-hidden="true"><Icon name={s.cessao ? 'key' : 'users'} size={16} /></span>
              <span className="convs__txt">
                <span className="convs__line"><b>{s.nome}</b>{s.ultimaEm && <time className="muted small">{fmtHora(new Date(s.ultimaEm))}</time>}</span>
                <span className="convs__line">
                  <small>{s.arquivada ? t('conversas.sala.arquivada') : s.ultima ? `${s.ultima.nome ?? ''}: ${s.ultima.texto}` : ' '}</small>
                  {s.mencao && <span className="sala-item__arroba" aria-hidden="true">@</span>}
                  {s.naoLidas > 0 && <span className="unread">{s.naoLidas > 9 ? '9+' : s.naoLidas}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {criando && <NovaSala onClose={() => setCriando(false)} onCriada={(id) => { setCriando(false); l.reload(); onAbrir(id); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ nova sala
function NovaSala({ onClose, onCriada }: { onClose: () => void; onCriada: (id: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLFormElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const d = useResource<Disponiveis>('/api/salas/disponiveis', []);
  const [nome, setNome] = useState('');
  const [pessoas, setPessoas] = useState<Set<string>>(new Set());
  const [agentes, setAgentes] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  const alterna = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const outros = (d.data?.pessoas ?? []).filter((p) => !p.eu);
  return (
    <div className="awin-back">
      <form ref={ref} className="awin sala-dialogo" role="dialog" aria-modal="true" aria-label={t('conversas.sala.criar.titulo')}
        onSubmit={async (e) => { e.preventDefault(); if (!nome.trim() || indo) return; setIndo(true); setErr(null);
          try { const r = await api.post<{ id: string }>('/api/salas', { nome: nome.trim(), pessoas: [...pessoas], agentes: [...agentes] }); onCriada(r.id); } catch (x) { setErr(errMsg(x)); setIndo(false); } }}>
        <header className="sala-dialogo__head"><b>{t('conversas.sala.criar.titulo')}</b><button type="button" className="icon-btn" onClick={onClose} aria-label={t('conversas.sala.criar.cancelar')}><Icon name="x" /></button></header>
        <label className="field"><span>{t('conversas.sala.criar.nome')}</span><input autoFocus value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} placeholder={t('conversas.sala.criar.nomeExemplo')} /></label>
        <fieldset className="sala-escolha"><legend>{t('conversas.sala.criar.pessoas')}</legend>
          {outros.length ? outros.map((p) => (
            <button key={p.chave} type="button" className={`chip ${pessoas.has(p.chave) ? 'chip--on' : ''}`} aria-pressed={pessoas.has(p.chave)} onClick={() => setPessoas((x) => alterna(x, p.chave))}><Rosto nome={p.nome} size={18} />{p.nome}</button>
          )) : <span className="muted small">{t('conversas.sala.criar.soVoce')}</span>}
        </fieldset>
        <fieldset className="sala-escolha"><legend>{t('conversas.sala.criar.agentes')}</legend>
          {(d.data?.agentes ?? []).map((a) => (
            <button key={a.chave} type="button" className={`chip ${agentes.has(a.chave) ? 'chip--on' : ''}`} aria-pressed={agentes.has(a.chave)} onClick={() => setAgentes((x) => alterna(x, a.chave))}><AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={18} />{a.nome}</button>
          ))}
        </fieldset>
        {err && <p className="error small" role="alert">{err}</p>}
        <footer className="sala-dialogo__acoes">
          <button type="button" className="btn btn--ghost" onClick={onClose}>{t('conversas.sala.criar.cancelar')}</button>
          <button type="submit" className="btn btn--primary" disabled={!nome.trim() || indo}>{t('conversas.sala.criar.botao')}</button>
        </footer>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ o campo com @ e #
/** O campo da sala: a marca só se forma por nome exato ou Tab (lib/mencoes.ts); o espelho atrás pinta as marcas. */
export function CampoSala({ candidatos, desligado, onEnviar, extra }: { candidatos: Candidato[]; desligado?: boolean; onEnviar: (x: { texto: string; marcas: unknown[] }) => Promise<boolean>; extra?: React.ReactNode }) {
  const t = useT();
  const [campo, setCampo] = useState<Campo>(vazio());
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [fechado, setFechado] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const espelho = useRef<HTMLDivElement>(null);
  const token = tokenAtivo(campo, cursor);
  const sug = token && token.inicio !== fechado ? sugestoes(token, candidatos) : [];
  useEffect(() => setSel(0), [token?.inicio, token?.consulta]);
  const colocar = (c: Campo, pos: number) => { setCampo(c); setCursor(pos); requestAnimationFrame(() => { ref.current?.setSelectionRange(pos, pos); }); };
  const pegar = (x: Candidato) => { if (!token) return; const r = escolher(campo, token, cursor, x); colocar(r.campo, r.cursor); };
  const enviar = async () => {
    const x = aoEnviar(campo, candidatos);
    if (!x.texto && !extra) return;
    if (await onEnviar(x)) colocar(vazio(), 0);
  };
  const tecla = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const pos = e.currentTarget.selectionStart; const fim = e.currentTarget.selectionEnd;
    if (sug.length) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pegar(sug[Math.min(sel, sug.length - 1)]); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => (i + 1) % sug.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => (i - 1 + sug.length) % sug.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFechado(token!.inicio); return; }
    }
    if (e.key === 'Backspace' && pos === fim) {
      const b = backspace(campo, pos);
      if (b) { e.preventDefault(); setCampo(b); return; } // a marca vira texto cru; nenhuma letra some
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void enviar(); return; }
    if (campo.recem !== null && e.key.length === 1) setCampo((c) => esquecerRecem(c));
  };
  return (
    <div className="scampo">
      {sug.length > 0 && (
        <ul className="scampo__sugestoes" role="listbox" aria-label={t('conversas.sala.sugestoes')}>
          {sug.map((x, i) => (
            <li key={`${x.tipo}:${x.chave}`} role="option" aria-selected={i === sel}>
              <button type="button" className={i === sel ? 'is-on' : ''} onMouseDown={(e) => { e.preventDefault(); pegar(x); }}>
                {x.tipo === 'agente' ? <Icon name="chat" size={13} /> : <Rosto nome={x.nome} size={18} />}
                <b>{x.nome}</b>{x.tipo === 'agente' && <small className="muted">{t('conversas.sala.agente')}</small>}
                {i === sel && <kbd className="scampo__tab">Tab</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="scampo__caixa">
        <div className="scampo__espelho" ref={espelho} aria-hidden="true">
          {pedacos(campo.texto, campo.marcas).map((p, i) => (p.marca ? <mark key={i} className={`mchip mchip--${p.marca.tipo}`}>{p.texto}</mark> : <span key={i}>{p.texto}</span>))}{'​'}
        </div>
        <textarea ref={ref} rows={2} value={campo.texto} disabled={desligado} placeholder={t('conversas.sala.campo')} aria-label={t('conversas.sala.campoAria')}
          aria-autocomplete="list" aria-expanded={sug.length > 0} data-esc-own={sug.length ? '' : undefined}
          onChange={(e) => { setFechado(null); setCampo(editar(campo, e.target.value, e.target.selectionStart, candidatos)); setCursor(e.target.selectionStart); }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)} onKeyDown={tecla}
          onScroll={(e) => { if (espelho.current) espelho.current.scrollTop = e.currentTarget.scrollTop; }} />
      </div>
      <button type="button" className="btn btn--primary scampo__enviar" onClick={() => void enviar()} disabled={desligado} aria-label={t('conversas.sala.enviar')} title={t('conversas.sala.enviar')}><Icon name="send" size={16} /></button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ cartão de cessão
/** O pedido de cessão para quem foi marcado com #: um clique escolhe por quanto tempo; "Agora não" recusa. */
/** `onAbrir`: fora da sala (o sino), o cartão leva à sala com ele em foco. `foco`: aberto por esse caminho (brilha e recebe o foco). */
export function CartaoCessao({ aviso, onFeito, onAbrir, foco }: { aviso: AvisoSala; onFeito?: () => void; onAbrir?: () => void; foco?: boolean }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // veio pelo sino: o cartão aparece à vista e o foco vai ao primeiro prazo (teclado pronto para escolher)
  useEffect(() => {
    if (!foco) return;
    const el = ref.current; if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.querySelector<HTMLButtonElement>('.sala-cessao__prazos button')?.focus({ preventScroll: true });
  }, [foco]);
  const decidir = async (decisao: Prazo | 'recusar') => {
    setIndo(true); setErr(null);
    try { await api.post(`/api/salas/avisos/${aviso.id}`, { decisao }); onFeito?.(); } catch (e) { setErr(errMsg(e)); setIndo(false); }
  };
  return (
    <article ref={ref} id={`cessao-${aviso.id}`} tabIndex={-1} className={`sala-cessao ${foco ? 'sala-cessao--foco' : ''}`} aria-label={t('conversas.sala.cessao.titulo', { nome: aviso.de_nome })}>
      <div className="sala-cessao__topo"><Icon name="key" size={16} /><b>{t('conversas.sala.cessao.titulo', { nome: aviso.de_nome })}</b>
        {onAbrir && <button type="button" className="btn btn--sm btn--ghost sala-cessao__abrir" onClick={onAbrir}>{t('conversas.sala.aviso.abrir')}<Icon name="chevron-right" size={13} /></button>}</div>
      {aviso.agente && <small className="muted">{t('conversas.sala.cessao.para', { agente: aviso.agente, sala: aviso.sala })}</small>}
      {aviso.texto && <p className="sala-cessao__texto">{aviso.texto}</p>}
      <div className="sala-cessao__prazos" role="group">
        {PRAZOS.map((p) => <button key={p} type="button" className={`btn btn--sm ${p === '24h' ? 'btn--primary' : ''}`} disabled={indo} onClick={() => void decidir(p)}>{t(`conversas.sala.prazo.${p}`)}</button>)}
        <button type="button" className="btn btn--sm btn--ghost" disabled={indo} onClick={() => void decidir('recusar')}>{t('conversas.sala.cessao.recusar')}</button>
      </div>
      {err && <p className="error small" role="alert">{err}</p>}
    </article>
  );
}

// ------------------------------------------------------------------------------------------------ membros
function Membros({ sala, onClose }: { sala: Detalhe; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const d = useResource<Disponiveis>(sala.admin ? '/api/salas/disponiveis' : null, []);
  const [err, setErr] = useState<string | null>(null);
  const dentro = new Set(sala.membros.map((m) => `${m.tipo}:${m.chave}`));
  const fazer = async (url: string, body: unknown) => { setErr(null); try { await api.post(url, body); } catch (e) { setErr(errMsg(e)); } };
  const agenteDe = (nome: string) => d.data?.agentes.find((a) => a.nome === nome);
  return (
    <div className="awin-back">
      <section ref={ref} className="awin sala-dialogo" role="dialog" aria-modal="true" aria-label={t('conversas.sala.membros.titulo', { sala: sala.nome })}>
        <header className="sala-dialogo__head"><b>{t('conversas.sala.membros.titulo', { sala: sala.nome })}</b><button type="button" className="icon-btn" onClick={onClose} aria-label={t('conversas.sala.membros.fechar')}><Icon name="x" /></button></header>
        <ul className="sala-membros">
          {sala.membros.map((m) => {
            const a = m.tipo === 'agente' ? agenteDe(m.nome) : undefined;
            return (
              <li key={`${m.tipo}:${m.chave}`}>
                {m.tipo === 'agente' ? (a ? <AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={28} /> : <span className="sala-rosto sala-rosto--marca" style={{ width: 28, height: 28 }}><Icon name="chat" size={14} /></span>) : <Rosto nome={m.nome} size={28} />}
                <span className="sala-membros__nome"><b>{m.nome}</b>{m.chave === sala.eu && <small className="muted"> · {t('conversas.sala.voce')}</small>}{m.tipo === 'agente' && <small className="muted"> · {t('conversas.sala.agente')}</small>}{m.admin && <small className="sala-membros__admin">{t('conversas.sala.membros.admin')}</small>}</span>
                {sala.admin && m.chave !== sala.eu && <button type="button" className="icon-btn" onClick={() => void fazer(`/api/salas/${sala.id}/membros/remover`, { tipo: m.tipo, chave: m.chave })} aria-label={t('conversas.sala.membros.tirar', { nome: m.nome })} title={t('conversas.sala.membros.tirar', { nome: m.nome })}><Icon name="x" size={14} /></button>}
              </li>
            );
          })}
        </ul>
        {sala.admin && d.data && (
          <>
            {d.data.pessoas.some((p) => !dentro.has(`pessoa:${p.chave}`)) && <fieldset className="sala-escolha"><legend>{t('conversas.sala.membros.foraPessoas')}</legend>
              {d.data.pessoas.filter((p) => !dentro.has(`pessoa:${p.chave}`)).map((p) => <button key={p.chave} type="button" className="chip" onClick={() => void fazer(`/api/salas/${sala.id}/membros`, { tipo: 'pessoa', chave: p.chave })}><Icon name="plus" size={12} /><Rosto nome={p.nome} size={18} />{p.nome}</button>)}
            </fieldset>}
            <fieldset className="sala-escolha"><legend>{t('conversas.sala.membros.foraAgentes')}</legend>
              {d.data.agentes.filter((a) => !dentro.has(`agente:${a.chave}`)).map((a) => <button key={a.chave} type="button" className="chip" onClick={() => void fazer(`/api/salas/${sala.id}/membros`, { tipo: 'agente', chave: a.chave })}><Icon name="plus" size={12} /><AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={18} />{a.nome}</button>)}
            </fieldset>
          </>
        )}
        {err && <p className="error small" role="alert">{err}</p>}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ a sala aberta
function textoDoEvento(t: ReturnType<typeof useT>, e: Evento, fallback: string): string {
  const v = { nome: e.nome ?? '', alvo: e.alvo ?? '', agente: e.agente ?? '', prazo: e.prazo ? t(`conversas.sala.prazo.${e.prazo}`) : '' };
  switch (e.evento) {
    case 'criou': return t('conversas.sala.evento.criou', v);
    case 'entrou': return t('conversas.sala.evento.entrou', v);
    case 'saiu': return t('conversas.sala.evento.saiu', v);
    case 'tirou': return t('conversas.sala.evento.tirou', v);
    case 'renomeou': return t('conversas.sala.evento.renomeou', v);
    case 'cedeu': return t('conversas.sala.evento.cedeu', v);
    case 'revogou': return t('conversas.sala.evento.revogou', v);
    case 'recusou': return t('conversas.sala.evento.recusou', v);
    case 'falta': return t('conversas.sala.evento.falta', v);
    case 'sem_acesso': return t('conversas.sala.evento.sem_acesso', v);
    case 'topico': return t('conversas.sala.evento.topico', v);
    case 'arquivou': return t('conversas.sala.evento.arquivou', v);
    case 'reabriu': return t('conversas.sala.evento.reabriu', v);
    default: return fallback;
  }
}

interface Pendente { key: string; nome: string; art: Attachment | null; erro: boolean }

/**
 * A sala aberta e, ao lado, o tópico aberto (no celular, o tópico ocupa a tela). `painelTopico`: este painel é o tópico ao
 * lado da sala (fecha com `onFechar`). Um tópico aberto direto (pelo sino) vira a sala-mãe com o tópico ao lado.
 */
export function SalaPanel({ salaId, onSaiu, foco, painelTopico, onFechar, topicoInicial, onIrPara }: { salaId: string; onSaiu: () => void; /** o pedido de cessão (sav_) ou a mensagem (msg_) em destaque */ foco?: string | null;
  painelTopico?: boolean; onFechar?: () => void; topicoInicial?: string | null; /** abrir outra sala (a sala-mãe de um tópico) com este tópico ao lado */ onIrPara?: (salaId: string, topico: string, foco?: string | null) => void }) {
  const t = useT();
  const det = useResource<Detalhe>(`/api/salas/${salaId}`, ['salas.changed']);
  const msgs = useResource<Mensagens>(`/api/salas/${salaId}/mensagens`, EVENTOS);
  const avisos = useResource<AvisoSala[]>('/api/salas/avisos', ['salas.changed']);
  const disp = useResource<Disponiveis>('/api/salas/disponiveis', []);
  const [membros, setMembros] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dica, setDica] = useState<string | null>(null);
  const [anexos, setAnexos] = useState<Pendente[]>([]);
  // o canal de voz (rc.41) na sala: fala com um agente da sala, escolhido aqui; manda e recebe pela própria sala
  const rec = useResource<RecursosEstado>(RECURSOS, []);
  const [voz, setVoz] = useState<AgenteDisp | null>(null);
  const [escolhendoVoz, setEscolhendoVoz] = useState(false);
  // tópicos: o aberto ao lado, a lista e o diálogo de abrir um (do zero ou de uma mensagem)
  const [topico, setTopico] = useState<string | null>(topicoInicial ?? null);
  useEffect(() => { if (topicoInicial) setTopico(topicoInicial); }, [topicoInicial]);
  const [listaTopicos, setListaTopicos] = useState(false);
  const [novoTopico, setNovoTopico] = useState<{ origem: Msg | null } | null>(null);
  const topicos = useResource<TopicoLinha[]>(painelTopico ? null : `/api/salas/${salaId}/topicos`, EVENTOS);
  const fim = useRef<HTMLDivElement>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const lista = msgs.data?.mensagens ?? [];
  // abriu (e a cada mensagem nova à vista): lida
  useEffect(() => { if (det.data) void api.post(`/api/salas/${salaId}/lido`).catch(() => undefined); }, [salaId, lista.length, !!det.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // a mensagem em foco (veio do sino): à vista e marcada; senão, o fim da conversa
  const focoMsg = foco?.startsWith('msg_') ? foco : null;
  useEffect(() => {
    const alvo = focoMsg ? document.getElementById(`smsg-${focoMsg}`) : null;
    if (alvo) alvo.scrollIntoView({ block: 'center' }); else fim.current?.scrollIntoView({ block: 'end' });
  }, [lista.length, salaId, focoMsg]);
  const s = det.data;
  const candidatos: Candidato[] = useMemo(() => (s?.membros ?? []).filter((m) => m.chave !== s?.eu).map((m) => ({ tipo: m.tipo, chave: m.chave, nome: m.nome })), [s]);
  const agenteDe = (nome: string | null) => disp.data?.agentes.find((a) => a.nome === nome);
  const meusPedidos = (avisos.data ?? []).filter((a) => a.conversation_id === salaId && a.tipo === 'cessao');
  useEffect(() => { if (s?.topico && !painelTopico) onIrPara?.(s.topico.pai, s.id, foco ?? null); }, [s?.topico?.pai, painelTopico]); // eslint-disable-line react-hooks/exhaustive-deps
  if (det.error) return <p className="muted center">{det.error}</p>;
  if (!s) return <p className="muted center">{t('conversas.sala.carregando')}</p>;
  const pronto = anexos.filter((a) => a.art).map((a) => a.art!.id);
  const subindo = anexos.some((a) => !a.art && !a.erro);
  const enviar = async (x: { texto: string; marcas: unknown[] }) => {
    if ((!x.texto && !pronto.length) || subindo) return false;
    setErr(null);
    try { await api.post(`/api/salas/${salaId}/mensagens`, { texto: x.texto, marcas: x.marcas, clientRequestId: requestId(), ...(pronto.length ? { attachments: pronto } : {}) }); setAnexos([]); msgs.reload(); return true; }
    catch (e) { setErr(errMsg(e)); return false; }
  };
  const subir = (f: File) => {
    const key = requestId();
    setAnexos((l) => [...l, { key, nome: f.name, art: null, erro: false }]);
    uploadFile<Attachment>(f, { conversationId: salaId }).then((art) => setAnexos((l) => l.map((x) => (x.key === key ? { ...x, art } : x)))).catch((e) => { setErr(errMsg(e)); setAnexos((l) => l.map((x) => (x.key === key ? { ...x, erro: true } : x))); });
  };
  const patch = async (body: Record<string, unknown>) => { setErr(null); setMenu(false); try { await api.patch(`/api/salas/${salaId}`, body); det.reload(); } catch (e) { setErr(errMsg(e)); } };
  const baixar = async (ref: string) => { setErr(null); try { await api.post(`/api/salas/${salaId}/anexos/${ref}/baixar`); msgs.reload(); } catch (e) { setErr(errMsg(e)); } };
  const tarefa = async (m: Msg) => { setErr(null); try { const r = await api.post<{ number: number }>(`/api/salas/${salaId}/mensagens/${m.id}/tarefa`); setDica(t('conversas.sala.tarefaCriada', { numero: r.number })); } catch (e) { setErr(errMsg(e)); } };
  const agentesNaSala = s.membros.filter((m) => m.tipo === 'agente');
  const agentesDaSala = agentesNaSala.map((m) => agenteDe(m.nome)).filter((a): a is AgenteDisp => !!a);
  const pessoasNaSala = s.membros.filter((m) => m.tipo === 'pessoa');
  const vez = msgs.data?.respondendo ?? [];
  const leitura = s.papel === 'viewer';
  const corpo = (
    <div className={`sala ${painelTopico ? 'sala--topico' : ''}`}>
      <header className="foco__chat-head sala__head">
        <span className="sala-item__icone sala__icone" aria-hidden="true"><Icon name={s.topico ? (s.topico.visibilidade === 'privado' ? 'lock' : 'chat') : 'users'} size={18} /></span>
        <div className="foco__chat-who">
          {renomeando !== null ? (
            <form onSubmit={(e) => { e.preventDefault(); const n = renomeando.trim(); setRenomeando(null); if (n && n !== s.nome) void patch({ nome: n }); }}>
              <input autoFocus value={renomeando} maxLength={80} onChange={(e) => setRenomeando(e.target.value)} onBlur={() => setRenomeando(null)} aria-label={t('conversas.sala.novoNome')}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenomeando(null); } }} />
            </form>
          ) : <b>{s.nome}</b>}
          <small>{s.topico ? `${s.topico.visibilidade === 'privado' ? t('conversas.sala.topico.privado') : t('conversas.sala.topico.compartilhado')} · ${t('conversas.sala.topico.de', { sala: s.topico.paiNome })}` : t('conversas.sala.membrosN', { n: s.membros.length })}</small>
        </div>
        {!painelTopico && (
          <span className="sala-topicos">
            <button type="button" className={`btn btn--sm btn--ghost sala-topicos__botao ${(topicos.data ?? []).some((x) => x.naoLidas) ? 'is-unread' : ''}`} aria-expanded={listaTopicos} onClick={() => setListaTopicos((x) => !x)}>
              <Icon name="chat" size={14} /> <span className="sala-topicos__rotulo">{t('conversas.sala.topico.titulo')}</span>{!!topicos.data?.filter((x) => !x.arquivado).length && <span className="sala-topicos__n">{topicos.data.filter((x) => !x.arquivado).length}</span>}
            </button>
            {listaTopicos && (
              <div className="scampo__sugestoes sala-topicos__lista" role="menu" aria-label={t('conversas.sala.topico.titulo')}>
                {!s.arquivada && <button type="button" role="menuitem" className="sala-topicos__novo" onClick={() => { setListaTopicos(false); setNovoTopico({ origem: null }); }}><Icon name="plus" size={13} /><b>{t('conversas.sala.topico.novo')}</b></button>}
                {!topicos.data?.length && <span className="muted small sala-topicos__vazio">{t('conversas.sala.topico.vazio')}</span>}
                {(topicos.data ?? []).filter((x) => !x.arquivado).map((x) => <LinhaTopico key={x.id} x={x} on={x.id === topico} onAbrir={() => { setListaTopicos(false); setTopico(x.id); }} />)}
                {(topicos.data ?? []).some((x) => x.arquivado) && <span className="sala-topicos__sep small muted">{t('conversas.sala.topico.arquivados')}</span>}
                {(topicos.data ?? []).filter((x) => x.arquivado).map((x) => <LinhaTopico key={x.id} x={x} on={x.id === topico} onAbrir={() => { setListaTopicos(false); setTopico(x.id); }} />)}
              </div>
            )}
          </span>
        )}
        <button type="button" className="sala__rostos" onClick={() => setMembros(true)} aria-label={t('conversas.sala.membros')} title={t('conversas.sala.membros')}>
          {agentesNaSala.slice(0, 3).map((m) => { const a = agenteDe(m.nome); return a ? <AgentAvatar key={m.chave} agent={{ ...a, name: a.nome, look_seed: null }} size={26} /> : null; })}
          {pessoasNaSala.slice(0, 3).map((m) => <Rosto key={m.chave} nome={m.nome} size={26} />)}
          {s.membros.length > 6 && <span className="sala__mais">+{s.membros.length - 6}</span>}
        </button>
        <div className="convs__menu">
          <button type="button" className="icon-btn" onClick={() => setMenu((o) => !o)} aria-label={t('conversas.sala.menu.opcoes')} aria-expanded={menu}><Icon name="dots" size={15} /></button>
          {menu && (
            <div className="convs__menu-list" role="menu">
              {s.admin && <button role="menuitem" onClick={() => { setMenu(false); setRenomeando(s.nome); }}><Icon name="pen" size={13} /> {t('conversas.sala.menu.renomear')}</button>}
              <button role="menuitem" onClick={() => { setMenu(false); setMembros(true); }}><Icon name="users" size={13} /> {t('conversas.sala.membros')}</button>
              {s.admin && <button role="menuitem" onClick={() => void patch({ arquivada: !s.arquivada })}><Icon name="folder" size={13} /> {s.topico ? (s.arquivada ? t('conversas.sala.topico.reabrir') : t('conversas.sala.topico.arquivar')) : s.arquivada ? t('conversas.sala.menu.desarquivar') : t('conversas.sala.menu.arquivar')}</button>}
              {s.topico?.visibilidade !== 'compartilhado' && <button role="menuitem" onClick={async () => { setMenu(false); try { await api.post(`/api/salas/${salaId}/sair`); onSaiu(); } catch (e) { setErr(errMsg(e)); } }}><Icon name="logout" size={13} /> {t('conversas.sala.menu.sair')}</button>}
            </div>
          )}
        </div>
        {painelTopico && onFechar && <button type="button" className="icon-btn" onClick={onFechar} aria-label={t('conversas.sala.topico.fechar')} title={t('conversas.sala.topico.fechar')}><Icon name="x" /></button>}
      </header>
      <div className="chat__msgs sala__msgs" aria-live="polite">
        {!lista.some((m) => m.role !== 'system') && <p className="muted center sala__vazia">{t('conversas.sala.vazia')}</p>}
        {lista.map((m, i) => {
          if (m.role === 'system') {
            const e = m.marcas && typeof m.marcas === 'object' && !Array.isArray(m.marcas) ? m.marcas as Evento : null;
            return <p key={m.id} className={`sala-evento ${e?.evento === 'cedeu' ? 'sala-evento--cedeu' : ''}`}>{e ? textoDoEvento(t, e, m.content) : m.content}</p>;
          }
          const anterior = lista[i - 1];
          const junto = anterior && anterior.role !== 'system' && anterior.autor.chave === m.autor.chave && Date.parse(m.created_at) - Date.parse(anterior.created_at) < 5 * 60_000;
          const a = m.role === 'agent' ? agenteDe(m.autor.nome) : undefined;
          const meu = m.autor.chave === s.eu;
          return (
            <article key={m.id} id={`smsg-${m.id}`} className={`smsg ${m.id === focoMsg ? 'smsg--foco' : ''} ${junto ? 'smsg--junto' : ''} ${meu ? 'smsg--meu' : ''} ${m.role === 'agent' ? 'smsg--agente' : ''}`}>
              <span className="smsg__rosto">{!junto && (a ? <AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={32} /> : <Rosto nome={m.autor.nome ?? '?'} size={32} />)}</span>
              <div className="smsg__corpo">
                {!junto && <div className="smsg__quem"><b>{m.autor.nome}</b>{m.role === 'agent' && <small className="smsg__tag">{t('conversas.sala.agente')}</small>}<time className="muted small">{fmtHora(new Date(m.created_at))}</time></div>}
                {m.role === 'agent' ? <Markdown text={m.content} className="msg__body" /> : (
                  <p className="msg__body">{pedacos(m.content, m.marcas).map((p, k) => (p.marca ? <span key={k} className={`mchip mchip--${p.marca.tipo} mchip--fixo`}>{p.texto}</span> : <span key={k}>{p.texto}</span>))}</p>
                )}
                {!!m.remotos?.length && <div className="smsg__anexos">{m.remotos.map((f) => (
                  <button key={f.ref} type="button" className={`fchip sala-remoto sala-remoto--${f.estado}`} disabled={f.estado !== 'remoto'} onClick={() => void baixar(f.ref)}
                    aria-label={t('conversas.sala.anexo.baixar', { nome: f.filename })} title={f.estado === 'grande' ? t('conversas.sala.anexo.grande') : f.estado === 'baixando' ? t('conversas.sala.anexo.baixando') : t('conversas.sala.anexo.baixar', { nome: f.filename })}>
                    <Icon name={f.estado === 'remoto' ? 'download' : f.estado === 'baixando' ? 'clock' : 'file'} size={14} />{f.filename}{f.estado !== 'remoto' && <small className="muted">{f.estado === 'grande' ? t('conversas.sala.anexo.grande') : t('conversas.sala.anexo.baixando')}</small>}
                  </button>))}</div>}
                {!!m.attachments?.length && <div className="smsg__anexos">{m.attachments.map((f) => <a key={f.id} className="fchip" href={`/api/artifacts/${f.id}/download`} target="_blank" rel="noreferrer"><Icon name="file" size={14} />{f.filename}</a>)}</div>}
                {m.topico && <button type="button" className={`sala-topico-chip ${m.topico.arquivado ? 'is-arquivado' : ''}`} onClick={() => setTopico(m.topico!.id)}><Icon name={m.topico.privado ? 'lock' : 'chat'} size={13} />{t('conversas.sala.topico.chip', { nome: m.topico.nome, n: m.topico.respostas })}</button>}
                <span className="smsg__acoes">
                  {!painelTopico && !s.topico && !m.topico && !s.arquivada && <button type="button" className="linkish small" onClick={() => setNovoTopico({ origem: m })}><Icon name="chat" size={12} /> {t('conversas.sala.topico.deMensagem')}</button>}
                  {!leitura && <button type="button" className="linkish small" onClick={() => void tarefa(m)} title={t('conversas.sala.tarefa')}><Icon name="tasks" size={12} /> {t('conversas.sala.tarefa')}</button>}
                </span>
              </div>
            </article>
          );
        })}
        {vez.map((v) => {
          const a = disp.data?.agentes.find((x) => x.id === v.agentId);
          return <div key={v.agentId + v.status} className={`sala-vez ${v.status === 'rodando' ? 'sala-vez--agora' : ''}`}>{a && <AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={22} />}<span>{v.status === 'rodando' ? t('conversas.sala.pensando', { nome: v.nome }) : t('conversas.sala.emSeguida', { nome: v.nome })}</span></div>;
        })}
        <div ref={fim} />
      </div>
      {vez.find((v) => v.status === 'rodando') && <NavegadorAoVivo conversa={salaId} agente={vez.find((v) => v.status === 'rodando')!.nome} />}
      {meusPedidos.map((p) => <CartaoCessao key={p.id} aviso={p} foco={p.id === foco} onFeito={() => { avisos.reload(); msgs.reload(); }} />)}
      {dica && <p className="chat__hint" role="status" onAnimationEnd={() => setDica(null)}>{dica}</p>}
      {err && <p className="error small sala__erro" role="alert">{err}</p>}
      {!!anexos.length && <div className="sala__anexos">{anexos.map((f) => <span key={f.key} className={`fchip ${f.erro ? 'fchip--err' : ''} ${!f.art && !f.erro ? 'fchip--subindo' : ''}`}><Icon name="file" size={13} />{f.nome}<button type="button" className="icon-btn" onClick={() => setAnexos((l) => l.filter((x) => x.key !== f.key))} aria-label={t('conversas.sala.criar.cancelar')}><Icon name="x" size={11} /></button></span>)}</div>}
      {s.arquivada ? <p className="muted center small sala__arquivada">{t('conversas.sala.soLeitura')}</p> : (
        <div className="sala__barra">
          <button type="button" className="icon-btn" onClick={() => arquivo.current?.click()} aria-label={t('conversas.sala.anexar')} title={t('conversas.sala.anexar')}><Icon name="clip" size={17} /></button>
          <input ref={arquivo} type="file" hidden multiple onChange={(e) => { for (const f of e.target.files ?? []) subir(f); e.target.value = ''; }} />
          {!voz && <GravadorDeVoz onGravado={(f) => subir(f)} />}
          {voz ? (
            <ConversaPorVoz agente={{ id: voz.id, name: voz.nome }} mensagens={lista as unknown as Message[]} podeFalar={!!rec.data?.voz.falar} preparaVoz={!!rec.data?.voz.preparar?.falar}
              garantirConversa={async () => salaId} recarregar={() => msgs.reload()} onFechar={() => setVoz(null)}
              enviarFala={async (arq) => (await api.post<{ messageId: string }>(`/api/salas/${salaId}/mensagens`, { texto: '', clientRequestId: requestId(), attachments: [arq], vozAgente: voz.nome })).messageId} />
          ) : agentesDaSala.length > 0 && (
            <span className="sala-voz">
              <button type="button" className="icon-btn chat__mic chat__voz" aria-pressed="false" aria-expanded={agentesDaSala.length > 1 ? escolhendoVoz : undefined}
                onClick={() => { if (agentesDaSala.length === 1) setVoz(agentesDaSala[0]); else setEscolhendoVoz((x) => !x); }}
                aria-label={t('conversas.voz.abrir')} title={agentesDaSala.length === 1 ? t('conversas.voz.abrirDica', { nome: agentesDaSala[0].nome }) : t('conversas.voz.abrir')}><Icon name="voz" /></button>
              {escolhendoVoz && (
                <span className="scampo__sugestoes sala-voz__lista" role="menu">
                  {agentesDaSala.map((a) => <button key={a.chave} type="button" role="menuitem" onClick={() => { setEscolhendoVoz(false); setVoz(a); }}><AgentAvatar agent={{ ...a, name: a.nome, look_seed: null }} size={20} /><b>{a.nome}</b></button>)}
                </span>
              )}
            </span>
          )}
          <CampoSala candidatos={candidatos} onEnviar={enviar} extra={pronto.length ? true : undefined} />
        </div>
      )}
      {membros && <Membros sala={s} onClose={() => { setMembros(false); det.reload(); }} />}
      {novoTopico && <NovoTopico sala={s} origem={novoTopico.origem} onClose={() => setNovoTopico(null)} onCriado={(id) => { setNovoTopico(null); topicos.reload(); msgs.reload(); setTopico(id); }} />}
    </div>
  );
  if (painelTopico || !topico) return corpo;
  return (
    <div className="sala-dupla">
      {corpo}
      <aside className="sala-dupla__topico" aria-label={t('conversas.sala.topico.titulo')}>
        <SalaPanel key={topico} salaId={topico} painelTopico foco={foco} onFechar={() => setTopico(null)} onSaiu={() => setTopico(null)} />
      </aside>
    </div>
  );
}

function LinhaTopico({ x, on, onAbrir }: { x: TopicoLinha; on: boolean; onAbrir: () => void }) {
  const t = useT();
  return (
    <button type="button" role="menuitem" className={`${on ? 'is-on' : ''} ${x.arquivado ? 'is-arquivado' : ''}`} onClick={onAbrir}>
      <Icon name={x.privado ? 'lock' : 'chat'} size={13} /><b>{x.nome}</b>
      <small className="muted">{t('conversas.sala.topico.respostas', { n: x.respostas })}</small>
      {x.naoLidas > 0 && <span className="unread">{x.naoLidas > 9 ? '9+' : x.naoLidas}</span>}
    </button>
  );
}

/** Abrir um tópico: o nome (da mensagem, se veio dela), compartilhado ou privado, e quem entra no privado. */
function NovoTopico({ sala, origem, onClose, onCriado }: { sala: Detalhe; origem: Msg | null; onClose: () => void; onCriado: (id: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLFormElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [nome, setNome] = useState(() => (origem ? origem.content.replace(/\s+/g, ' ').trim().slice(0, 60) : ''));
  const [vis, setVis] = useState<'compartilhado' | 'privado'>('compartilhado');
  const [quem, setQuem] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  const outros = sala.membros.filter((m) => m.chave !== sala.eu);
  return (
    <div className="awin-back">
      <form ref={ref} className="awin sala-dialogo" role="dialog" aria-modal="true" aria-label={t('conversas.sala.topico.novo')}
        onSubmit={async (e) => { e.preventDefault(); if (indo || !nome.trim()) return; setIndo(true); setErr(null);
          const sel = outros.filter((m) => quem.has(`${m.tipo}:${m.chave}`));
          try { const r = await api.post<{ id: string }>(`/api/salas/${sala.id}/topicos`, { nome: nome.trim(), visibilidade: vis, ...(origem ? { origem: origem.id } : {}),
            ...(vis === 'privado' ? { pessoas: sel.filter((m) => m.tipo === 'pessoa').map((m) => m.chave), agentes: sel.filter((m) => m.tipo === 'agente').map((m) => m.chave) } : {}) }); onCriado(r.id); }
          catch (x) { setErr(errMsg(x)); setIndo(false); } }}>
        <header className="sala-dialogo__head"><b>{t('conversas.sala.topico.novo')}</b><button type="button" className="icon-btn" onClick={onClose} aria-label={t('conversas.sala.criar.cancelar')}><Icon name="x" /></button></header>
        {origem && <blockquote className="sala-topico__origem"><b>{origem.autor.nome}</b> {origem.content.replace(/\s+/g, ' ').slice(0, 160)}</blockquote>}
        <label className="field"><span>{t('conversas.sala.topico.nome')}</span><input autoFocus value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} /></label>
        <div className="sala-gov__opcoes" role="radiogroup" aria-label={t('conversas.sala.topico.titulo')}>
          {(['compartilhado', 'privado'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={vis === k} className={`chip ${vis === k ? 'chip--on' : ''}`} onClick={() => setVis(k)}><Icon name={k === 'privado' ? 'lock' : 'users'} size={13} />{k === 'privado' ? t('conversas.sala.topico.privado') : t('conversas.sala.topico.compartilhado')}</button>)}
        </div>
        {vis === 'privado' && (
          <fieldset className="sala-escolha"><legend>{t('conversas.sala.topico.quem')}</legend>
            {outros.map((m) => { const k = `${m.tipo}:${m.chave}`; return (
              <button key={k} type="button" className={`chip ${quem.has(k) ? 'chip--on' : ''}`} aria-pressed={quem.has(k)} onClick={() => setQuem((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
                {m.tipo === 'agente' ? <Icon name="chat" size={12} /> : <Rosto nome={m.nome} size={18} />}{m.nome}</button>); })}
          </fieldset>
        )}
        {err && <p className="error small" role="alert">{err}</p>}
        <footer className="sala-dialogo__acoes">
          <button type="button" className="btn btn--ghost" onClick={onClose}>{t('conversas.sala.criar.cancelar')}</button>
          <button type="submit" className="btn btn--primary" disabled={!nome.trim() || indo}>{t('conversas.sala.topico.criar')}</button>
        </footer>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ o sino, Conexões, Governança
/** As menções e os pedidos de cessão no "Aguardando você". */
export function AvisosDeSalas() {
  const t = useT();
  const a = useResource<AvisoSala[]>('/api/salas/avisos', ['salas.changed']);
  if (!a.data?.length) return null;
  return (
    <div className="sala-avisos">
      {a.data.map((v) => v.tipo === 'cessao' ? <CartaoCessao key={v.id} aviso={v} onFeito={a.reload} onAbrir={() => openSala(v.conversation_id, v.id)} /> : (
        <button key={v.id} type="button" className="sala-aviso" onClick={() => openSala(v.conversation_id, v.message_id)}>
          <span className="sala-item__arroba" aria-hidden="true">@</span>
          <span className="sala-aviso__txt"><b>{t('conversas.sala.aviso.mencao', { nome: v.de_nome, sala: v.sala })}</b>{v.texto && <small className="muted">{v.texto}</small>}</span>
          <Icon name="chevron-right" size={14} />
        </button>
      ))}
    </div>
  );
}

/** As conexões que a pessoa cedeu nas salas, com "Retirar" (Conexões e a própria sala). */
export function CessoesNasSalas() {
  const t = useT();
  const c = useResource<Array<{ id: string; salaId: string; sala: string; pedinte: string; prazo: Prazo; expiraEm: string | null }>>('/api/salas/cessoes', ['salas.changed']);
  const [err, setErr] = useState<string | null>(null);
  if (!c.data?.length) return null;
  return (
    <section className="sala-cessoes" aria-label={t('conversas.sala.cessoes.titulo')}>
      <h4>{t('conversas.sala.cessoes.titulo')}</h4>
      <ul>
        {c.data.map((x) => (
          <li key={x.id}>
            <Icon name="key" size={14} />
            <span><b>{t('conversas.sala.cessoes.item', { sala: x.sala, pessoa: x.pedinte })}</b> <small className="muted">{x.expiraEm ? t('conversas.sala.cessoes.ate', { data: fmtData(new Date(x.expiraEm), { day: '2-digit', month: '2-digit' }) }) : t(`conversas.sala.prazo.${x.prazo}`)}</small></span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={async () => { setErr(null); try { await api.del(`/api/salas/cessoes/${x.id}`); c.reload(); } catch (e) { setErr(errMsg(e)); } }}>{t('conversas.sala.cessoes.retirar')}</button>
          </li>
        ))}
      </ul>
      {err && <p className="error small" role="alert">{err}</p>}
    </section>
  );
}

/** Governança: o interruptor da cessão de conexões nas salas e quem cria salas (quem administra o workspace). */
export function SalasGovernanca() {
  const t = useT();
  const g = useResource<{ cessao: boolean; criar: 'admins' | 'todos' }>('/api/salas/governanca', ['salas.changed']);
  const [err, setErr] = useState<string | null>(null);
  const mudar = async (b: Record<string, unknown>) => { setErr(null); try { await api.put('/api/salas/governanca', b); g.reload(); } catch (e) { setErr(errMsg(e)); } };
  if (!g.data) return null;
  return (
    <div className="sala-gov">
      <div className="sala-gov__linha">
        <span id="sala-gov-cessao">{t('conversas.sala.gov.cessao')}</span>
        <button type="button" role="switch" aria-checked={g.data.cessao} aria-labelledby="sala-gov-cessao" className={`switch ${g.data.cessao ? 'switch--on' : ''}`} onClick={() => void mudar({ cessao: !g.data!.cessao })}>
          <span className="switch__knob" /><span className="switch__txt">{g.data.cessao ? t('conta.estado.ligado') : t('conta.estado.desligado')}</span>
        </button>
      </div>
      <div className="sala-gov__linha" role="radiogroup" aria-label={t('conversas.sala.gov.criar')}>
        <span>{t('conversas.sala.gov.criar')}</span>
        <span className="sala-gov__opcoes">
          {(['todos', 'admins'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={g.data!.criar === k} className={`chip ${g.data!.criar === k ? 'chip--on' : ''}`} onClick={() => void mudar({ criar: k })}>{k === 'todos' ? t('conversas.sala.gov.todos') : t('conversas.sala.gov.admins')}</button>)}
        </span>
      </div>
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
  );
}

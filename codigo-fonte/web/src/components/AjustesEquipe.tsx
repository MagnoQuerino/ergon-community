// rc.27: os ajustes da equipe de IA que a pessoa escolhe — plano B (modelos reserva), privacidade (não treinar com os
// dados, busca privada), arrumar competências sem uso, pausar a equipe, os limites da conta de IA e orientar um trabalho
// em andamento. Cada peça grava na hora e mostra o que vale de fato (o servidor responde com o estado). Nada de botão
// esperando: as telas abrem com o que já se sabe e o valor chega por cima.
import { useEffect, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { RESERVA_MAX, linhasDaConta, listaDeReserva, mover, nomeDaConta, nomeDoModelo, textoDaPausa } from '../lib/ajustes.ts';
import type { AjustesDaEquipe, ContaDeIa, ModeloReserva, Raciocinio } from '../lib/types.ts';
import { fmtDataHora, tn, useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

type Salvar = (corpo: Record<string, unknown>) => Promise<void>;

/** O estado dos ajustes (GET /api/team/ajustes) e o gravar (PUT), com o aviso do que ainda não chegou à equipe. */
export function useAjustes(onError: (texto: string) => void): { a: AjustesDaEquipe | null; salvar: Salvar; aviso: string } {
  const t = useT();
  const r = useResource<AjustesDaEquipe>('/api/team/ajustes', ['agents.changed', 'ai.changed']);
  const [local, setLocal] = useState<AjustesDaEquipe | null>(null);
  useEffect(() => { if (r.data) setLocal((cur) => ({ ...r.data!, opcoes: r.data!.opcoes ?? cur?.opcoes })); }, [r.data]);
  const salvar: Salvar = async (corpo) => {
    try {
      const novo = await api.put<AjustesDaEquipe>('/api/team/ajustes', corpo);
      setLocal((cur) => ({ ...novo, opcoes: cur?.opcoes }));
    } catch (e) { onError(errMsg(e)); r.reload(); }
  };
  const a = local;
  const aviso = !a ? '' : a.atualizacao ? t('configuracoes.ajustes.atualizacao') : a.pendente ? t('configuracoes.ajustes.depois') : '';
  return { a, salvar, aviso };
}

/** Plano B: quais modelos assumem quando o principal falha. Automático (as outras contas conectadas), uma lista ou nada. */
export function ReservaCard({ a, salvar, aviso }: { a: AjustesDaEquipe | null; salvar: Salvar; aviso: string }) {
  const t = useT();
  const contas = a?.opcoes?.contas ?? [];
  const [conta, setConta] = useState('');
  const [modelo, setModelo] = useState('');
  const modo = a?.reserva.modo ?? 'auto';
  const lista = a?.reserva.lista ?? [];
  const contaAtual = contas.find((c) => c.id === conta) ?? contas[0];
  const modelos = contaAtual?.models ?? [];
  const modeloAtual = modelos.find((m) => m.id === modelo) ?? modelos[0];
  const rotulo = (m: ModeloReserva) => {
    const c = contas.find((x) => x.id === m.provider);
    return t('configuracoes.ajustes.reserva.item', { modelo: nomeDoModelo(m.model, c?.models.find((x) => x.id === m.model)?.label), conta: nomeDaConta(m.provider, c?.name) });
  };
  const gravarLista = (nova: ModeloReserva[]) => void salvar({ reserva: { modo: 'lista', lista: nova } });
  const conexoes = <a href="#conexoes">{t('configuracoes.ajustes.reserva.conexoes')}</a>;
  const emUso = a?.reserva.emUso ?? [];
  return (
    <section className="card">
      <h3>{t('configuracoes.ajustes.reserva.titulo')}</h3>
      <p className="muted small">{t('configuracoes.ajustes.reserva.texto')}</p>
      <div className="field field--limit">
        <label htmlFor="reserva-modo">{t('configuracoes.ajustes.reserva.modo')}</label>
        <select id="reserva-modo" value={modo} onChange={(e) => void salvar({ reserva: e.target.value === 'lista' ? { modo: 'lista', lista } : { modo: e.target.value } })} aria-describedby="reserva-aviso">
          <option value="auto">{t('configuracoes.ajustes.reserva.auto')}</option>
          <option value="lista">{t('configuracoes.ajustes.reserva.lista')}</option>
          <option value="desligado">{t('configuracoes.ajustes.reserva.desligado')}</option>
        </select>
      </div>
      {modo === 'lista' && (
        <div className="reserva">
          {lista.length === 0 && <p className="hint">{t('configuracoes.ajustes.reserva.vazia')}</p>}
          <ol className="reserva__lista">
            {lista.map((m, i) => (
              <li key={`${m.provider}:${m.model}`} className="reserva__item">
                <span className="reserva__nome">{rotulo(m)}</span>
                <span className="reserva__acoes">
                  {i > 0 && <button type="button" className="icon-btn" onClick={() => gravarLista(mover(lista, i, -1))} aria-label={t('configuracoes.ajustes.reserva.subir', { modelo: nomeDoModelo(m.model) })} title={t('configuracoes.ajustes.reserva.subir', { modelo: nomeDoModelo(m.model) })}><Icon name="chevron-up" size={14} /></button>}
                  {i < lista.length - 1 && <button type="button" className="icon-btn" onClick={() => gravarLista(mover(lista, i, 1))} aria-label={t('configuracoes.ajustes.reserva.descer', { modelo: nomeDoModelo(m.model) })} title={t('configuracoes.ajustes.reserva.descer', { modelo: nomeDoModelo(m.model) })}><Icon name="chevron" size={14} /></button>}
                  <button type="button" className="icon-btn" onClick={() => gravarLista(lista.filter((_, j) => j !== i))} aria-label={t('configuracoes.ajustes.reserva.tirar', { modelo: nomeDoModelo(m.model) })} title={t('configuracoes.ajustes.reserva.tirar', { modelo: nomeDoModelo(m.model) })}><Icon name="x" size={14} /></button>
                </span>
              </li>
            ))}
          </ol>
          {!contas.length ? <p className="hint">{tn('configuracoes.ajustes.reserva.semContas', { conexoes })}</p>
            : lista.length >= RESERVA_MAX ? <p className="hint">{t('configuracoes.ajustes.reserva.cheia')}</p> : (
              <form className="row row--wrap reserva__novo" onSubmit={(e) => {
                e.preventDefault();
                if (!contaAtual || !modeloAtual) return;
                const novo = { provider: contaAtual.id, model: modeloAtual.id };
                if (!lista.some((x) => x.provider === novo.provider && x.model === novo.model)) gravarLista([...lista, novo]);
              }}>
                <select value={contaAtual?.id ?? ''} onChange={(e) => { setConta(e.target.value); setModelo(''); }} aria-label={t('configuracoes.ajustes.reserva.conta')}>
                  {contas.map((c) => <option key={c.id} value={c.id}>{nomeDaConta(c.id, c.name)}</option>)}
                </select>
                <select value={modeloAtual?.id ?? ''} onChange={(e) => setModelo(e.target.value)} aria-label={t('configuracoes.ajustes.reserva.modelo')}>
                  {modelos.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <button className="btn btn--sm"><Icon name="plus" size={13} /> {t('configuracoes.ajustes.reserva.adicionar')}</button>
              </form>
            )}
        </div>
      )}
      {modo !== 'desligado' && (emUso.length > 0
        ? <p className="hint">{t('configuracoes.ajustes.reserva.emUso', { modelos: listaDeReserva(emUso, rotulo) })}</p>
        : modo === 'auto' && a && !a.atualizacao && <p className="hint">{tn('configuracoes.ajustes.reserva.nenhumEmUso', { conexoes })}</p>)}
      {modo !== 'desligado' && <p id="reserva-aviso" className="hint"><Icon name="alert" size={12} /> {t('configuracoes.ajustes.reserva.aviso')}</p>}
      {aviso && <p className="hint" role="status">{aviso}</p>}
    </section>
  );
}

function Caixa({ id, ligada, rotulo, ajuda, extra, onMudar }: { id: string; ligada: boolean; rotulo: string; ajuda: string; extra?: ReactNode; onMudar: (v: boolean) => void }) {
  return (
    <div className="compactar">
      <label className="check"><input type="checkbox" checked={ligada} onChange={(e) => onMudar(e.target.checked)} aria-describedby={`${id}-hint`} /> {rotulo}</label>
      <p id={`${id}-hint`} className="hint">{ajuda}</p>
      {extra}
    </div>
  );
}

/** Configurações › Segurança: não treinar com os meus dados (ligado por padrão) e a busca privada (desligada por padrão). */
export function PrivacidadeCard() {
  const t = useT();
  const [erro, setErro] = useState<string | null>(null);
  const { a, salvar, aviso } = useAjustes(setErro);
  return (
    <section className="card">
      <h3>{t('configuracoes.ajustes.privacidade.titulo')}</h3>
      {erro && <p className="error" role="alert">{erro}</p>}
      <Caixa id="nao-treinar" ligada={a ? a.naoTreinar : true} rotulo={t('configuracoes.ajustes.naoTreinar.rotulo')} ajuda={t('configuracoes.ajustes.naoTreinar.ajuda')}
        onMudar={(v) => { setErro(null); void salvar({ naoTreinar: v }); }} />
      <Caixa id="busca-privada" ligada={a ? a.buscaPrivada : false} rotulo={t('configuracoes.ajustes.buscaPrivada.rotulo')} ajuda={t('configuracoes.ajustes.buscaPrivada.ajuda')}
        extra={a?.buscaPrivada && a.buscaPrivadaAguarda ? <p className="hint" role="status">{t('configuracoes.ajustes.buscaPrivada.aguarda')}</p> : null}
        onMudar={(v) => { setErro(null); void salvar({ buscaPrivada: v }); }} />
      {aviso && <p className="hint" role="status">{aviso}</p>}
    </section>
  );
}

/** Andamento da equipe: "Anotar na memória depois da conversa" (ligado por padrão; a pessoa desliga para economizar). */
export function MemoriaField({ a, salvar }: { a: AjustesDaEquipe | null; salvar: Salvar }) {
  const t = useT();
  return <Caixa id="anotar-memoria" ligada={a ? a.anotarMemoria !== false : true} rotulo={t('configuracoes.ajustes.memoria.rotulo')} ajuda={t('configuracoes.ajustes.memoria.ajuda')}
    onMudar={(v) => void salvar({ anotarMemoria: v })} />;
}

const RACIOCINIOS: Raciocinio[] = ['high', 'medium', 'low', 'modelo'];
const ROTULO_DO_RACIOCINIO = { high: 'configuracoes.ajustes.raciocinio.high', medium: 'configuracoes.ajustes.raciocinio.medium', low: 'configuracoes.ajustes.raciocinio.low', modelo: 'configuracoes.ajustes.raciocinio.modelo' } as const;
/** Andamento da equipe: a profundidade do raciocínio (alta por padrão; a pessoa diminui para economizar). */
export function RaciocinioField({ a, salvar }: { a: AjustesDaEquipe | null; salvar: Salvar }) {
  const t = useT();
  const valor: Raciocinio = a && RACIOCINIOS.includes(a.raciocinio) ? a.raciocinio : 'high';
  return (
    <div className="field field--limit">
      <label htmlFor="raciocinio">{t('configuracoes.ajustes.raciocinio.rotulo')}</label>
      <select id="raciocinio" value={valor} onChange={(e) => void salvar({ raciocinio: e.target.value })} aria-describedby="raciocinio-hint">
        {RACIOCINIOS.map((r) => <option key={r} value={r}>{t(ROTULO_DO_RACIOCINIO[r])}</option>)}
      </select>
      <small id="raciocinio-hint" className="muted">{t('configuracoes.ajustes.raciocinio.ajuda')}</small>
    </div>
  );
}

/** Andamento da equipe: "Arrumar competências sem uso" (desligado por padrão: é economia, não benefício). */
export function ArrumarField({ a, salvar }: { a: AjustesDaEquipe | null; salvar: Salvar }) {
  const t = useT();
  return <Caixa id="arrumar-competencias" ligada={a ? a.arrumarCompetencias : false} rotulo={t('configuracoes.ajustes.arrumar.rotulo')} ajuda={t('configuracoes.ajustes.arrumar.ajuda')}
    onMudar={(v) => void salvar({ arrumarCompetencias: v })} />;
}

/** Pausar e retomar a equipe: o botão diz o que ele faz; o estado e a explicação ficam ao lado. */
export function PausaControle({ pausa, onMudou, onError, compacto }: { pausa: { pausada: boolean; desde: string | null } | null | undefined; onMudou: () => void; onError: (texto: string) => void; compacto?: boolean }) {
  const t = useT();
  const [local, setLocal] = useState(pausa ?? null);
  useEffect(() => { setLocal(pausa ?? null); }, [pausa?.pausada, pausa?.desde]); // eslint-disable-line react-hooks/exhaustive-deps
  const pausada = local?.pausada === true;
  const mudar = async () => {
    const antes = local;
    setLocal({ pausada: !pausada, desde: pausada ? null : new Date().toISOString() });
    try { const r = await api.put<{ pausada: boolean; desde: string | null }>('/api/team/pausa', { pausada: !pausada }); setLocal({ pausada: r.pausada, desde: r.desde }); onMudou(); }
    catch (e) { setLocal(antes); onError(errMsg(e)); }
  };
  return (
    <div className={`pausa ${pausada ? 'pausa--on' : ''} ${compacto ? 'pausa--compacto' : ''}`}>
      <div className="row row--wrap pausa__linha">
        <button type="button" className={`btn btn--sm ${pausada ? 'btn--primary' : ''}`} onClick={() => void mudar()}>
          <Icon name={pausada ? 'play' : 'pause'} size={13} /> {pausada ? t('configuracoes.ajustes.pausa.retomar') : t('configuracoes.ajustes.pausa.pausar')}
        </button>
        <span className={pausada ? 'pausa__estado' : 'muted small'} role="status">{textoDaPausa(local)}</span>
      </div>
      {!compacto && <p className="hint">{t('configuracoes.ajustes.pausa.ajuda')}</p>}
    </div>
  );
}

/** Os limites e o saldo de cada conta de IA, como o provedor informou ("restam 39% da cota semanal, renova em …"). */
export function CotaLinhas({ contas, onAtualizar }: { contas: ContaDeIa[] | null | undefined; onAtualizar?: () => Promise<void> | void }) {
  const t = useT();
  const [indo, setIndo] = useState(false);
  if (!contas?.length) return null;
  const lido = contas.map((c) => c.readAt).filter(Boolean).sort().at(-1);
  return (
    <div className="cota">
      <h4 className="cota__titulo">{t('configuracoes.ajustes.cota.titulo')}</h4>
      {contas.map((c) => {
        const l = linhasDaConta(c);
        return (
          <div key={c.provider} className="cota__conta">
            <b>{l.titulo}</b>
            {l.resta !== null && <div className="cota__barra" role="img" aria-label={l.frases[0]}><span style={{ width: `${l.resta}%` }} className={l.resta <= 15 ? 'cota__resta cota__resta--pouco' : 'cota__resta'} /></div>}
            <ul className="cota__frases">{l.frases.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        );
      })}
      <p className="hint">
        {lido ? `${t('configuracoes.ajustes.cota.lido', { quando: fmtDataHora(lido) })} ` : ''}
        {onAtualizar && <button type="button" className="btn btn--sm btn--ghost" aria-busy={indo} onClick={async () => { setIndo(true); try { await onAtualizar(); } finally { setIndo(false); } }}>
          <Icon name="repeat" size={12} /> {indo ? t('configuracoes.ajustes.cota.atualizando') : t('configuracoes.ajustes.cota.atualizar')}</button>}
      </p>
    </div>
  );
}

/**
 * "Orientar sem interromper": um recado para o trabalho em andamento. O agente lê no próximo passo e segue de onde está
 * (não recomeça, não perde o que já fez). `rota`: a do card (/api/tasks/…/steer) ou a da resposta em andamento na conversa.
 */
export function OrientarCampo({ rota, nome, compacto }: { rota: string; nome: string; compacto?: boolean }) {
  const t = useT();
  const [texto, setTexto] = useState('');
  const [indo, setIndo] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const enviar = async () => {
    const recado = texto.trim();
    if (!recado || indo) return;
    setIndo(true); setMsg(null);
    try { await api.post(rota, { text: recado }); setTexto(''); setMsg({ kind: 'ok', text: t('configuracoes.ajustes.orientar.enviada', { nome }) }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
    finally { setIndo(false); }
  };
  return (
    <form className={`orientar ${compacto ? 'orientar--compacto' : ''}`} onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
      <label className="orientar__rotulo" htmlFor={`orientar-${rota}`}><Icon name="compass" size={13} /> {t('configuracoes.ajustes.orientar.rotulo')}</label>
      <div className="row orientar__linha">
        <input id={`orientar-${rota}`} className="input" value={texto} maxLength={4000} onChange={(e) => { setTexto(e.target.value); setMsg(null); }} placeholder={t('configuracoes.ajustes.orientar.exemplo')} aria-describedby={`orientar-${rota}-hint`} />
        <button className="btn btn--sm" aria-busy={indo}>{indo ? t('configuracoes.ajustes.orientar.enviando') : t('configuracoes.ajustes.orientar.enviar')}</button>
      </div>
      {msg ? <p id={`orientar-${rota}-hint`} className={msg.kind === 'error' ? 'error' : 'hint'} role="status">{msg.text}</p>
        : <p id={`orientar-${rota}-hint`} className="hint">{t('configuracoes.ajustes.orientar.ajuda')}</p>}
    </form>
  );
}

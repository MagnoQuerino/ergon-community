import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { ModelCatalog } from '../lib/types.ts';
import { RECURSOS, type Conquista, type Conselho, type PontoDeVolta, type RecursosEstado, type Vaga } from '../lib/recursos.ts';
import { Icon } from './Icon.tsx';
import { fmtDataHora, useT } from '../i18n/index.ts';

/**
 * Configurações › Capacidades da equipe: tudo o que a equipe de IA sabe fazer além das ferramentas, num lugar só. O que é
 * benefício vem ligado (regra do dono, 12/11), com o aviso de custo ou risco de cada coisa; a pessoa desliga para economizar. As ferramentas novas (navegador, vídeo, busca no X, leitura
 * de arquivos, responder em áudio, conectores prontos) ligam e desligam no quadro de Ferramentas, como as outras.
 */
export function CapacidadesPanel({ dono }: { dono: boolean }) {
  const t = useT();
  const e = useResource<RecursosEstado>(RECURSOS, ['agents.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const salvar = async (p: Partial<Pick<RecursosEstado, 'checkpoints' | 'codigoInseguro' | 'limpeza'>>) => {
    try {
      const r = await api.put<{ reiniciar?: boolean }>(RECURSOS, p);
      setMsg(r.reiniciar ? { kind: 'ok', text: t('configuracoes.cap.reiniciar') } : null);
      e.reload();
    } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); }
  };
  // motor fechado ou de antes: a seção diz por quê, sem botão esperando
  if (!e.data) return (
    <section className="card" id="capacidades">
      <h3>{t('configuracoes.cap.titulo')}</h3>
      <p className="muted small">{e.error ?? t('configuracoes.cap.lendo')}</p>
    </section>
  );
  const s = e.data;
  return (
    <>
      <section className="card" id="capacidades">
        <h3>{t('configuracoes.cap.titulo')}</h3>
        <p className="muted small">{t('configuracoes.cap.texto')}</p>
        {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

        <h4><Icon name="shield" size={14} /> {t('configuracoes.cap.protecoes.titulo')}</h4>
        <p className="muted small">{t('configuracoes.cap.protecoes.texto')}</p>
        <label className="check"><input type="checkbox" checked={s.checkpoints} disabled={!dono} onChange={(x) => void salvar({ checkpoints: x.target.checked })} />
          <span><b>{t('configuracoes.cap.protecoes.checkpoints')}</b> <small className="muted">{t('configuracoes.cap.protecoes.checkpointsDica')}</small></span></label>
        <label className="check"><input type="checkbox" checked={s.codigoInseguro} disabled={!dono} onChange={(x) => void salvar({ codigoInseguro: x.target.checked })} />
          <span><b>{t('configuracoes.cap.protecoes.inseguro')}</b> <small className="muted">{t('configuracoes.cap.protecoes.inseguroDica')}</small></span></label>
        <label className="check"><input type="checkbox" checked={s.limpeza} disabled={!dono} onChange={(x) => void salvar({ limpeza: x.target.checked })} />
          <span><b>{t('configuracoes.cap.protecoes.limpeza')}</b> <small className="muted">{t('configuracoes.cap.protecoes.limpezaDica')}</small></span></label>
        <p className="hint">{t('configuracoes.cap.protecoes.rede')}</p>
        {dono && s.checkpoints && <Voltar />}

        <h4><Icon name="compass" size={14} /> {t('configuracoes.cap.navegador.titulo')}</h4>
        <p className="muted small">{s.navegador.pronto ? t('configuracoes.cap.navegador.pronto') : s.navegador.chromium ? t('configuracoes.cap.navegador.semPrograma') : t('configuracoes.cap.navegador.semChromium')}</p>
        <p className="hint warn"><Icon name="alert" size={12} /> {t('configuracoes.cap.navegador.risco')}</p>
        <p className="muted small">{t('configuracoes.cap.navegador.cofre')}</p>

        <h4><Icon name="music" size={14} /> {t('configuracoes.cap.voz.titulo')}</h4>
        <ul className="plain small">
          <li>{s.voz.transcrever ? t('configuracoes.cap.voz.transcreverPronto') : t('configuracoes.cap.voz.transcreverFalta')}</li>
          <li>{s.voz.falar ? t('configuracoes.cap.voz.falarPronto') : t('configuracoes.cap.voz.falarFalta')}</li>
        </ul>

        <h4><Icon name="plug" size={14} /> {t('configuracoes.cap.conectores.titulo')}</h4>
        <p className="muted small">{s.conectores.length ? t('configuracoes.cap.conectores.ligados', { n: s.conectores.length }) : t('configuracoes.cap.conectores.nenhum')}{' '}
          <a href="#conexoes">{t('configuracoes.cap.conectores.ir')}</a></p>
        {s.conectores.length > 0 && <p className="hint">{t('configuracoes.cap.conectores.busca')}</p>}

        <h4><Icon name="book" size={14} /> {t('configuracoes.cap.competencias.titulo')}</h4>
        <p className="muted small">{t('configuracoes.cap.competencias.texto')}</p>

        <h4><Icon name="layers" size={14} /> {t('configuracoes.cap.lote.titulo')}</h4>
        <p className="muted small">{t('configuracoes.cap.lote.texto')}</p>
      </section>
      <ConselhoCard dono={dono} />
      <ConquistasCard />
    </>
  );
}

function Voltar() {
  const t = useT();
  const pts = useResource<{ pontos: PontoDeVolta[] }>(`${RECURSOS}/checkpoints`, []);
  const [feito, setFeito] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<PontoDeVolta | null>(null);
  const lista = pts.data?.pontos ?? [];
  const voltar = async (p: PontoDeVolta) => {
    setConfirmar(null);
    try {
      const r = await api.post<{ ok: boolean }>(`${RECURSOS}/checkpoints/voltar`, { pasta: p.pasta, id: p.id });
      if (r.ok) { setFeito(p.id); setErro(null); } else setErro(t('configuracoes.cap.voltar.naoVoltou'));
      pts.reload();
    } catch (x) { setErro(errMsg(x)); }
  };
  return (
    <div className="block">
      <b className="small">{t('configuracoes.cap.voltar.titulo')}</b>
      {!lista.length ? <p className="muted small">{t('configuracoes.cap.voltar.vazio')}</p> : (
        <ul className="plain small">
          {lista.slice(0, 12).map((p) => (
            <li key={`${p.pasta}-${p.id}`}>
              {fmtDataHora(p.quando)} · <code>{p.pasta}</code> · {p.motivo}
              {confirmar?.id === p.id ? (
                <> · <span className="warn">{t('configuracoes.cap.voltar.confirmar')}</span>{' '}
                  <button className="btn btn--sm btn--danger" onClick={() => void voltar(p)}>{t('configuracoes.cap.voltar.sim')}</button>{' '}
                  <button className="btn btn--sm" onClick={() => setConfirmar(null)}>{t('configuracoes.comum.cancelar')}</button></>
              ) : (
                <> · <button className="btn btn--sm" onClick={() => setConfirmar(p)}><Icon name="undo" size={12} /> {t('configuracoes.cap.voltar.botao')}</button></>
              )}
              {feito === p.id && <span className="ok"> {t('configuracoes.cap.voltar.feito')}</span>}
            </li>
          ))}
        </ul>
      )}
      {erro && <p className="error" role="status">{erro}</p>}
    </div>
  );
}

function ConselhoCard({ dono }: { dono: boolean }) {
  const t = useT();
  const c = useResource<Conselho>(`${RECURSOS}/conselho`, []);
  const catalog = useResource<ModelCatalog>('/api/ai/models', ['ai.changed']);
  const [rascunho, setRascunho] = useState<{ opinam: Vaga[]; agrega: Vaga } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const opcoes = (catalog.data?.providers ?? []).flatMap((p) => p.models.map((m) => ({ chave: `${p.id}|${m.id}`, rotulo: `${m.label} · ${p.name}`, vaga: { provider: p.id, model: m.id } })));
  const atual = rascunho ?? (c.data ? { opinam: c.data.opinam, agrega: c.data.agrega } : null);
  const chave = (v: Vaga) => `${v.provider}|${v.model}`;
  const rotulo = (v: Vaga) => opcoes.find((o) => o.chave === chave(v))?.rotulo ?? v.model;
  const salvar = async () => {
    if (!rascunho) return;
    try { await api.put(`${RECURSOS}/conselho`, rascunho); setRascunho(null); c.reload(); setMsg({ kind: 'ok', text: t('configuracoes.cap.conselho.salvo') }); }
    catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); }
  };
  const escolher = (valor: string) => opcoes.find((o) => o.chave === valor)?.vaga;
  return (
    <section className="card">
      <h3>{t('configuracoes.cap.conselho.titulo')}</h3>
      <p className="muted small">{t('configuracoes.cap.conselho.texto')}</p>
      <p className="hint warn"><Icon name="coins" size={12} /> {t('configuracoes.cap.conselho.custo')}</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {!atual ? <p className="muted small">{c.error ?? t('configuracoes.cap.lendo')}</p> : !dono || !opcoes.length ? (
        <p className="small">{t('configuracoes.cap.conselho.resumo', { opinam: atual.opinam.map(rotulo).join(', ') || '—', agrega: rotulo(atual.agrega) })}
          {dono && !opcoes.length && <> <span className="muted">{t('configuracoes.cap.conselho.semModelos')}</span></>}</p>
      ) : (
        <div className="stack">
          <b className="small">{t('configuracoes.cap.conselho.opinam')}</b>
          {atual.opinam.map((v, i) => (
            <div key={i} className="row">
              <select value={chave(v)} onChange={(x) => { const n = escolher(x.target.value); if (n) setRascunho({ ...atual, opinam: atual.opinam.map((o, j) => (j === i ? n : o)) }); }} aria-label={t('configuracoes.cap.conselho.modeloN', { n: i + 1 })}>
                {!opcoes.some((o) => o.chave === chave(v)) && <option value={chave(v)}>{v.model}</option>}
                {opcoes.map((o) => <option key={o.chave} value={o.chave}>{o.rotulo}</option>)}
              </select>
              {atual.opinam.length > 2 && <button className="btn btn--sm" onClick={() => setRascunho({ ...atual, opinam: atual.opinam.filter((_, j) => j !== i) })} aria-label={t('configuracoes.cap.conselho.tirar')}><Icon name="x" size={12} /></button>}
            </div>
          ))}
          {atual.opinam.length < 6 && <button className="btn btn--sm" onClick={() => setRascunho({ ...atual, opinam: [...atual.opinam, opcoes[0].vaga] })}><Icon name="plus" size={12} /> {t('configuracoes.cap.conselho.mais')}</button>}
          <b className="small">{t('configuracoes.cap.conselho.agrega')}</b>
          <select value={chave(atual.agrega)} onChange={(x) => { const n = escolher(x.target.value); if (n) setRascunho({ ...atual, agrega: n }); }} aria-label={t('configuracoes.cap.conselho.agrega')}>
            {!opcoes.some((o) => o.chave === chave(atual.agrega)) && <option value={chave(atual.agrega)}>{atual.agrega.model || '—'}</option>}
            {opcoes.map((o) => <option key={o.chave} value={o.chave}>{o.rotulo}</option>)}
          </select>
          {rascunho && <div className="row"><button className="btn btn--primary btn--sm" onClick={() => void salvar()}>{t('configuracoes.cap.conselho.salvar')}</button>
            <button className="btn btn--sm" onClick={() => setRascunho(null)}>{t('configuracoes.comum.cancelar')}</button></div>}
        </div>
      )}
      <p className="hint">{t('configuracoes.cap.conselho.como')}</p>
    </section>
  );
}

function ConquistasCard() {
  const t = useT();
  const q = useResource<{ conquistas: Conquista[] }>(`${RECURSOS}/conquistas`, ['runs.changed']);
  const lista = q.data?.conquistas ?? [];
  const feitas = lista.filter((c) => c.conquistada);
  return (
    <section className="card">
      <h3>{t('configuracoes.cap.conquistas.titulo')}</h3>
      <p className="muted small">{t('configuracoes.cap.conquistas.texto')}</p>
      {!q.data ? <p className="muted small">{q.error ?? t('configuracoes.cap.lendo')}</p> : !lista.length ? <p className="muted small">{t('configuracoes.cap.conquistas.vazio')}</p> : (
        <>
          <p className="small">{t('configuracoes.cap.conquistas.contagem', { n: feitas.length, total: lista.length })}</p>
          <ul className="plain small">
            {[...feitas, ...lista.filter((c) => !c.conquistada && c.progresso > 0)].slice(0, 12).map((c) => (
              <li key={c.id}>{c.conquistada ? <Icon name="check" size={12} /> : <span className="muted">{c.progresso}%</span>} <b>{c.nome}</b>{c.nivel ? ` · ${c.nivel}` : ''} <span className="muted">{c.descricao}</span></li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">{t('configuracoes.cap.conquistas.mascotes')}</p>
    </section>
  );
}

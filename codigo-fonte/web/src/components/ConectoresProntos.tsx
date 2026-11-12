import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { RECURSOS, type ConectorCatalogo, type Conectores } from '../lib/recursos.ts';
import { Icon } from './Icon.tsx';
import { useT } from '../i18n/index.ts';

/**
 * Conexões › Mais aplicativos: os conectores prontos da equipe (dezenas de aplicativos). Instalar, entrar na conta do
 * aplicativo (quando ele pede), ligar ou desligar e liberar a escrita, um por um. Sem a escrita liberada, a equipe só
 * consulta; o agente precisa da ferramenta "Conectores prontos" (na janela dele) para usar qualquer um.
 */
export function ConectoresProntos({ dono }: { dono: boolean }) {
  const t = useT();
  const c = useResource<Conectores>(`${RECURSOS}/conectores`, ['agents.changed']);
  const [filtro, setFiltro] = useState('');
  const [aberto, setAberto] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const instalados = new Map((c.data?.servidores ?? []).map((s) => [s.nome, s]));
  const escrita = new Set(c.data?.escrita ?? []);
  const termo = filtro.trim().toLowerCase();
  const lista = (c.data?.catalogo ?? []).filter((x) => !termo || x.nome.includes(termo) || x.descricao.toLowerCase().includes(termo));
  const fazer = async (f: () => Promise<unknown>, ok?: string) => {
    try { await f(); setMsg(ok ? { kind: 'ok', text: ok } : null); c.reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); }
  };
  const entrar = async (nome: string) => {
    try {
      const r = await api.post<{ fluxo: string; endereco: string; erro: string }>(`${RECURSOS}/conectores/${nome}/entrar`);
      if (!r.endereco) { setMsg({ kind: 'error', text: r.erro || t('conexoes.prontos.entrarFalhou') }); return; }
      window.open(r.endereco, '_blank', 'noopener');
      setMsg({ kind: 'ok', text: t('conexoes.prontos.entrarAberto') });
    } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); }
  };
  return (
    <section className="conn-group" id="conn-prontos">
      <h3>{t('conexoes.prontos.titulo')}</h3>
      <p className="muted small">{t('conexoes.prontos.texto')}</p>
      <p className="hint"><Icon name="lock" size={12} /> {t('conexoes.prontos.trava')}</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {!c.data ? <p className="muted small">{c.error ?? t('conexoes.prontos.lendo')}</p> : (
        <>
          <input className="conn-search" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder={t('conexoes.prontos.filtrar')} aria-label={t('conexoes.prontos.filtrar')} />
          <ul className="plain conn-prontos">
            {lista.slice(0, 120).map((x) => {
              const s = instalados.get(x.nome);
              return (
                <li key={x.nome}>
                  <button className="linkish" onClick={() => setAberto(aberto === x.nome ? null : x.nome)} aria-expanded={aberto === x.nome}>
                    <b>{x.nome}</b></button>{' '}
                  {s ? <span className={`badge ${s.ligado ? 'badge--ok' : ''}`}>{s.ligado ? (escrita.has(x.nome) ? t('conexoes.prontos.ligadoEscrita') : t('conexoes.prontos.ligadoConsulta')) : t('conexoes.prontos.desligado')}</span> : null}
                  <span className="muted small"> {x.descricao}</span>
                  {aberto === x.nome && <Detalhe x={x} instalado={!!s} ligado={!!s?.ligado} escrita={escrita.has(x.nome)} dono={dono}
                    onInstalar={(campos) => fazer(() => api.post(`${RECURSOS}/conectores/instalar`, { nome: x.nome, ...(Object.keys(campos).length ? { campos } : {}) }), x.entrada === 'oauth' ? t('conexoes.prontos.instaladoEntrar') : t('conexoes.prontos.instalado'))}
                    onEntrar={() => void entrar(x.nome)}
                    onLigar={(v) => fazer(() => api.put(`${RECURSOS}/conectores/${x.nome}`, { ligado: v }))}
                    onEscrita={(v) => fazer(() => api.put(`${RECURSOS}/conectores/${x.nome}/escrita`, { liberada: v }))}
                    onRemover={() => fazer(() => api.del(`${RECURSOS}/conectores/${x.nome}`))} />}
                </li>
              );
            })}
          </ul>
          {!lista.length && <p className="muted small">{t('conexoes.prontos.nada')}</p>}
          {c.data.busca_ferramentas && <p className="hint">{t('conexoes.prontos.busca')}</p>}
        </>
      )}
    </section>
  );
}

function Detalhe({ x, instalado, ligado, escrita, dono, onInstalar, onEntrar, onLigar, onEscrita, onRemover }: {
  x: ConectorCatalogo; instalado: boolean; ligado: boolean; escrita: boolean; dono: boolean;
  onInstalar: (campos: Record<string, string>) => void; onEntrar: () => void; onLigar: (v: boolean) => void; onEscrita: (v: boolean) => void; onRemover: () => void;
}) {
  const t = useT();
  const [campos, setCampos] = useState<Record<string, string>>({});
  if (!dono) return <p className="muted small">{t('conexoes.prontos.soDono')}</p>;
  return (
    <div className="card card--inset">
      {!instalado ? (
        <form onSubmit={(e) => { e.preventDefault(); onInstalar(Object.fromEntries(Object.entries(campos).filter(([, v]) => v.trim()))); }}>
          {x.entrada === 'oauth' && <p className="muted small">{t('conexoes.prontos.pedeConta')}</p>}
          {x.campos.map((f) => (
            <label key={f.nome} className="field">{f.pergunta || f.nome}
              <input type="password" autoComplete="off" value={campos[f.nome] ?? ''} required={f.obrigatorio} onChange={(e) => setCampos({ ...campos, [f.nome]: e.target.value })} />
            </label>
          ))}
          <button className="btn btn--primary btn--sm" type="submit">{t('conexoes.prontos.instalar')}</button>
        </form>
      ) : (
        <div className="stack">
          {x.entrada === 'oauth' && <button className="btn btn--sm" onClick={onEntrar}><Icon name="key" size={12} /> {t('conexoes.prontos.entrar')}</button>}
          <label className="check"><input type="checkbox" checked={ligado} onChange={(e) => onLigar(e.target.checked)} /> {t('conexoes.prontos.ligar')}</label>
          <label className="check"><input type="checkbox" checked={escrita} onChange={(e) => onEscrita(e.target.checked)} />
            <span>{t('conexoes.prontos.escrita')} <small className="muted">{t('conexoes.prontos.escritaDica')}</small></span></label>
          <button className="btn btn--sm btn--danger" onClick={onRemover}><Icon name="trash" size={12} /> {t('conexoes.prontos.remover')}</button>
        </div>
      )}
    </div>
  );
}

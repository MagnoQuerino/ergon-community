import { useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { RECURSOS, type Varredura } from '../lib/recursos.ts';
import { tipoDoArquivo } from '../lib/competencias-tela.ts';
import type { Agent, Skill } from '../lib/types.ts';
import { SKILLS, VarreduraResumo, useUmaVez } from './CompetenciasProntas.tsx';
import { Icon } from './Icon.tsx';
import { useT } from '../i18n/index.ts';

/** O que vai ao servidor: o texto (colado ou lido do SKILL.md aqui no navegador) ou a pasta compactada em base64. */
type Pacote = { texto: string; nomeArquivo?: string } | { zip: string; nomeArquivo: string };
interface Previa { nome: string; titulo: string; descricao: string; arquivos: string[]; ignorados: string[]; texto: string; varredura: Varredura }

/** O que o servidor aceita: a pasta compactada em base64 até 6 milhões de caracteres (~4 MB) e o texto até 400 mil caracteres. */
const LIMITE_ZIP = 4 * 1024 * 1024;
const LIMITE_TEXTO = 390 * 1024;
const lerTexto = (f: File) => f.text();
const lerBase64 = (f: File) => new Promise<string>((ok, falha) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => falha(r.error ?? new Error('read'));
  r.readAsDataURL(f);
});

/**
 * Adicionar uma competência pronta: enviar o arquivo SKILL.md (ou a pasta compactada .zip) ou colar o texto. Antes de
 * aprovar, a prévia mostra o que ela faz, os arquivos e a mesma varredura de segurança da loja; aprovar grava na
 * biblioteca da equipe e liga neste agente ou em todos.
 */
export function AdicionarCompetencia({ agent, reload }: { agent: Agent; reload: () => void }) {
  const t = useT();
  const lib = useResource<Skill[]>(SKILLS, ['agents.changed']);
  const [forma, setForma] = useState<'arquivo' | 'colar'>('arquivo');
  const [colado, setColado] = useState('');
  const [pacote, setPacote] = useState<Pacote | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [destino, setDestino] = useState<'agente' | 'equipe'>('agente');
  const [aceito, setAceito] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const lendo = useUmaVez();
  const enviando = useUmaVez();
  const input = useRef<HTMLInputElement>(null);

  const verPrevia = (p: Pacote) => lendo.rodar(async () => {
    setMsg(null); setPrevia(null); setAceito(false); setPacote(p);
    try { setPrevia(await api.post<Previa>(`${RECURSOS}/competencias/previa`, p)); }
    catch (x) { setMsg({ ok: false, texto: errMsg(x) }); }
  });
  const escolher = async (f: File | undefined) => {
    if (!f) return;
    const tipo = tipoDoArquivo(f.name);
    if (!tipo) { setMsg({ ok: false, texto: t('agente.add.formatoErrado', { arquivo: f.name }) }); return; }
    // os mesmos limites do servidor, ditos aqui antes de mandar (lá a recusa viria sem explicação)
    const limite = tipo === 'zip' ? LIMITE_ZIP : LIMITE_TEXTO;
    if (f.size > limite) { setMsg({ ok: false, texto: t('agente.add.grandeDemais', { arquivo: f.name, limite: tipo === 'zip' ? '4 MB' : '390 KB' }) }); return; }
    try { await verPrevia(tipo === 'zip' ? { zip: await lerBase64(f), nomeArquivo: f.name } : { texto: await lerTexto(f), nomeArquivo: f.name }); }
    catch (x) { setMsg({ ok: false, texto: errMsg(x) }); }
  };
  const recomecar = () => { setPrevia(null); setPacote(null); setAceito(false); setColado(''); };
  const existente = previa ? (lib.data ?? []).find((s) => s.name === previa.nome) ?? null : null;
  const atencao = previa?.varredura.politica === 'ask';
  const barrada = previa?.varredura.politica === 'block';
  const outraComMesmoNome = !!existente && existente.origem !== 'enviada';
  const aprovar = () => enviando.rodar(async () => {
    if (!pacote || !previa || barrada) return;
    if (atencao && !aceito) { setMsg({ ok: false, texto: t('agente.add.marqueRisco') }); return; }
    try {
      const r = await api.post<{ agentes: number; atualizada: boolean }>(`${RECURSOS}/competencias/instalar`, {
        ...pacote, destino, ...(destino === 'agente' ? { agente: agent.id } : {}), ...(atencao ? { riscoAceito: true } : {}),
      });
      setMsg({ ok: true, texto: destino === 'agente' ? t('agente.add.prontoAgente', { titulo: previa.titulo, nome: agent.name }) : t('agente.add.prontoEquipe', { titulo: previa.titulo, n: r.agentes }) });
      recomecar(); reload(); lib.reload();
    } catch (x) { setMsg({ ok: false, texto: errMsg(x) }); }
  });

  return (
    <section className="block comp-add" aria-labelledby="comp-add-titulo">
      <h4 id="comp-add-titulo"><Icon name="plus" size={14} /> {t('agente.add.titulo')}</h4>
      <p className="hint">{t('agente.add.texto')}</p>
      {!previa && (
        <>
          <div className="comp-filtros" role="tablist" aria-label={t('agente.add.como')}>
            <button role="tab" aria-selected={forma === 'arquivo'} className={`chip ${forma === 'arquivo' ? 'chip--on' : ''}`} onClick={() => setForma('arquivo')}><Icon name="file" size={12} /> {t('agente.add.enviarArquivo')}</button>
            <button role="tab" aria-selected={forma === 'colar'} className={`chip ${forma === 'colar' ? 'chip--on' : ''}`} onClick={() => setForma('colar')}><Icon name="edit" size={12} /> {t('agente.add.colarTexto')}</button>
          </div>
          {forma === 'arquivo' ? (
            <label className={`comp-solta ${arrastando ? 'comp-solta--sobre' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setArrastando(true); }} onDragLeave={() => setArrastando(false)}
              onDrop={(e) => { e.preventDefault(); setArrastando(false); void escolher(e.dataTransfer.files?.[0]); }}>
              <Icon name="download" size={22} />
              <b>{lendo.ocupado ? t('agente.add.lendo') : t('agente.add.soltar')}</b>
              <span className="muted small">{t('agente.add.aceita')}</span>
              <input ref={input} type="file" className="sr-only" accept=".md,.markdown,.txt,.zip" onChange={(e) => { void escolher(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          ) : (
            <div className="comp-colar">
              <textarea rows={8} value={colado} onChange={(e) => setColado(e.target.value)} placeholder={t('agente.add.colarExemplo')} aria-label={t('agente.add.colarTexto')} maxLength={400_000} />
              <div className="row">
                <button className="btn btn--primary" onClick={() => { if (colado.trim()) void verPrevia({ texto: colado }); else setMsg({ ok: false, texto: t('agente.add.colarVazio') }); }}>
                  {lendo.ocupado ? t('agente.add.lendo') : t('agente.add.verPrevia')}
                </button>
              </div>
            </div>
          )}
          <details className="comp-formato">
            <summary className="muted small">{t('agente.add.formatoTitulo')}</summary>
            <p className="small">{t('agente.add.formatoTexto')}</p>
            <pre className="pre small">{t('agente.add.formatoExemplo')}</pre>
          </details>
        </>
      )}
      {previa && (
        <div className="train__card comp-previa">
          <div className="row"><b>{previa.titulo}</b> <span className="muted small">{t('agente.add.identificador', { nome: previa.nome })}</span><span className="grow" />
            <button className="btn btn--sm btn--ghost" onClick={recomecar}>{t('agente.add.outra')}</button></div>
          <p>{previa.descricao}</p>
          <p className="muted small">{t('agente.add.arquivos', { n: previa.arquivos.length })}: {previa.arquivos.join(', ')}</p>
          {previa.ignorados.length > 0 && <p className="hint warn">{t('agente.add.ignorados', { lista: previa.ignorados.slice(0, 10).join(', ') })}</p>}
          {existente && <p className={outraComMesmoNome ? 'hint warn' : 'hint'}>{outraComMesmoNome ? t('agente.add.nomeOcupado') : t('agente.add.substitui')}</p>}
          <VarreduraResumo v={previa.varredura} />
          <details><summary className="muted small">{t('agente.loja.verTexto')}</summary><pre className="pre train__pre">{previa.texto.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')}</pre></details>
          {barrada ? <p className="hint warn">{t('agente.loja.barrada')}</p> : (
            <>
              <fieldset className="comp-destino">
                <legend className="small">{t('agente.add.paraQuem')}</legend>
                <label className="check"><input type="radio" name="comp-destino" checked={destino === 'agente'} onChange={() => setDestino('agente')} /> {t('agente.add.soEste', { nome: agent.name })}</label>
                <label className="check"><input type="radio" name="comp-destino" checked={destino === 'equipe'} onChange={() => setDestino('equipe')} /> {t('agente.add.equipeToda')}</label>
              </fieldset>
              {atencao && <label className="check comp-risco"><input type="checkbox" checked={aceito} onChange={(e) => setAceito(e.target.checked)} /> {t('agente.add.aceitoRisco')}</label>}
              <div className="row">
                <button className="btn btn--primary" onClick={() => void aprovar()}><Icon name="check" size={14} /> {enviando.ocupado ? t('agente.add.adicionando') : t('agente.add.aprovar')}</button>
                <span className="hint">{t('agente.add.aprovarDica')}</span>
              </div>
            </>
          )}
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.texto}</p>}
    </section>
  );
}

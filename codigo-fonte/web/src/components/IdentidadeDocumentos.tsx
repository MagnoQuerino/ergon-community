import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { MODELOS_ORIGINAIS, normalizarModelo, type Identidade, type ModeloDoc } from '../../../shared/entregaveis.ts';
import { Documento } from './Documento.tsx';
import { Icon } from './Icon.tsx';
import { useIdioma, useT } from '../i18n/index.ts';

/**
 * Configurações › Documentos (rc.42): a identidade das entregas (nome, cores, logo, o emblema do Ergon) e os modelos de
 * documento, com a folha de amostra ao lado mudando junto. Os originais (Ergon, ABNT) não mudam: "Copiar" cria um
 * modelo próprio a partir deles.
 */
export function IdentidadeDocumentos({ dono }: { dono: boolean }) {
  const t = useT();
  const idioma = useIdioma();
  const ident = useResource<Identidade>('/api/entregaveis/identidade', ['entregaveis.changed']);
  const lista = useResource<{ modelos: ModeloDoc[]; padrao: string }>('/api/entregaveis/modelos', ['entregaveis.changed']);
  const [rasc, setRasc] = useState<Identidade | null>(null);
  const [sel, setSel] = useState<string>('ergon');
  const [edit, setEdit] = useState<ModeloDoc | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ident.data) setRasc(ident.data); }, [ident.data]);
  const atual = lista.data?.modelos.find((m) => m.id === sel) ?? MODELOS_ORIGINAIS[0];
  useEffect(() => { setEdit(atual.original ? null : atual); }, [atual]);
  const modelo = edit ?? atual;
  const amostra = useMemo(() => t('configuracoes.entregas.amostra'), [t, idioma]); // eslint-disable-line react-hooks/exhaustive-deps

  const falha = (e: unknown) => setMsg({ kind: 'error', text: errMsg(e) });
  const salvarId = async () => {
    if (!rasc) return;
    try { await api.put('/api/entregaveis/identidade', { nome: rasc.nome, corPrimaria: rasc.corPrimaria, corDestaque: rasc.corDestaque, mostrarErgon: rasc.mostrarErgon }); setMsg({ kind: 'ok', text: t('configuracoes.entregas.salvo') }); ident.reload(); }
    catch (e) { falha(e); }
  };
  const enviarLogo = async (f: File) => {
    try {
      const png = await paraPng(f);
      if (!png) { setMsg({ kind: 'error', text: t('configuracoes.entregas.logoErro') }); return; }
      await api.putBytes('/api/entregaveis/identidade/logo', png);
      ident.reload();
    } catch (e) { falha(e); }
  };
  const copiar = async () => {
    try {
      const { id: _id, original: _o, ...resto } = modelo;
      const novo = await api.post<ModeloDoc>('/api/entregaveis/modelos', { ...resto, nome: `${modelo.nome} (2)` });
      await lista.reload(); setSel(novo.id);
    } catch (e) { falha(e); }
  };
  const salvarModelo = async (padrao = false) => {
    try { await api.put(`/api/entregaveis/modelos/${modelo.id}`, { ...modelo, ...(padrao ? { padrao: true } : {}) }); setMsg({ kind: 'ok', text: t('configuracoes.entregas.salvo') }); lista.reload(); }
    catch (e) { falha(e); }
  };
  const apagar = async () => { try { await api.del(`/api/entregaveis/modelos/${modelo.id}`); setSel('ergon'); lista.reload(); } catch (e) { falha(e); } };
  const verPdf = async () => {
    try {
      const blob = await api.postBlob('/api/entregaveis/previa.pdf', { modelo: modelo.original ? { id: modelo.id } : modelo, texto: amostra });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { falha(e); }
  };
  const muda = (p: Partial<ModeloDoc>) => setEdit((m) => normalizarModelo({ ...(m ?? modelo), ...p }, modelo.id));

  if (!rasc) return null;
  const travado = !dono;
  const ed = !!edit && dono;
  return (
    <div className="ident">
      <div className="ident__lado">
        <section className="card ident__card">
          <h3>{t('configuracoes.entregas.identidade')}</h3>
          <label className="field">{t('configuracoes.entregas.nome')}
            <input value={rasc.nome} maxLength={80} disabled={travado} onChange={(e) => setRasc({ ...rasc, nome: e.target.value })} />
          </label>
          <div className="ident__cores">
            <label className="ident__cor">{t('configuracoes.entregas.corPrimaria')}<input type="color" value={rasc.corPrimaria} disabled={travado} onChange={(e) => setRasc({ ...rasc, corPrimaria: e.target.value })} /></label>
            <label className="ident__cor">{t('configuracoes.entregas.corDestaque')}<input type="color" value={rasc.corDestaque} disabled={travado} onChange={(e) => setRasc({ ...rasc, corDestaque: e.target.value })} /></label>
          </div>
          <div className="ident__logo">
            <span className="ident__logo-caixa">{rasc.logo ? <img src={`/api/entregaveis/identidade/logo?v=${rasc.logo.versao}`} alt={t('configuracoes.entregas.logo')} /> : <Icon name="image" size={22} />}</span>
            <input ref={arquivo} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void enviarLogo(f); }} />
            <button type="button" className="btn btn--sm" disabled={travado} onClick={() => arquivo.current?.click()}>{t('configuracoes.entregas.enviarLogo')}</button>
            {rasc.logo && <button type="button" className="btn btn--sm btn--ghost" disabled={travado} onClick={() => void api.del('/api/entregaveis/identidade/logo').then(() => ident.reload(), falha)}>{t('configuracoes.entregas.tirarLogo')}</button>}
          </div>
          <label className="check"><input type="checkbox" checked={rasc.mostrarErgon} disabled={travado} onChange={(e) => setRasc({ ...rasc, mostrarErgon: e.target.checked })} /> {t('configuracoes.entregas.ergon')}</label>
          {dono && <div className="row ident__salvar"><button type="button" className="btn btn--primary btn--sm" onClick={() => void salvarId()}>{t('configuracoes.entregas.salvar')}</button></div>}
        </section>

        <section className="card ident__card">
          <h3>{t('configuracoes.entregas.modelos')}</h3>
          <div className="ident__modelos" role="tablist">
            {(lista.data?.modelos ?? MODELOS_ORIGINAIS).map((m) => (
              <button key={m.id} type="button" role="tab" aria-selected={m.id === sel} className={`chip ${m.id === sel ? 'chip--on' : ''}`} onClick={() => setSel(m.id)}>
                {m.nome}{m.id === lista.data?.padrao && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
          <div className="row wrap">
            {dono && <button type="button" className="btn btn--sm" onClick={() => void copiar()}><Icon name="copy" size={13} /> {modelo.original ? t('configuracoes.entregas.novo') : t('configuracoes.entregas.copiar')}</button>}
            {dono && modelo.id !== lista.data?.padrao && <button type="button" className="btn btn--sm" onClick={() => void (modelo.original ? api.put(`/api/entregaveis/modelos/${modelo.id}`, { padrao: true }).then(() => lista.reload(), falha) : salvarModelo(true))}>{t('configuracoes.entregas.tornarPadrao')}</button>}
            <button type="button" className="btn btn--sm" onClick={() => void verPdf()}><Icon name="file" size={13} /> {t('configuracoes.entregas.verPdf')}</button>
            {modelo.original && <span className="pill">{t('configuracoes.entregas.original')}</span>}
          </div>
          {ed && edit && (
            <div className="ident__form">
              <label className="field">{t('configuracoes.entregas.campo.nome')}<input value={edit.nome} maxLength={60} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} /></label>
              <div className="ident__linha">
                <label className="field">{t('configuracoes.entregas.campo.fonte')}
                  <select value={edit.fonte} onChange={(e) => muda({ fonte: e.target.value as ModeloDoc['fonte'] })}><option value="sans">{t('configuracoes.entregas.fonte.sans')}</option><option value="serif">{t('configuracoes.entregas.fonte.serif')}</option></select>
                </label>
                <label className="field">{t('configuracoes.entregas.campo.tamanho')}<input type="number" min={9} max={16} step={0.5} value={edit.tamanho} onChange={(e) => muda({ tamanho: Number(e.target.value) })} /></label>
                <label className="field">{t('configuracoes.entregas.campo.entrelinha')}
                  <select value={edit.entrelinha} onChange={(e) => muda({ entrelinha: Number(e.target.value) })}>{[1, 1.15, 1.45, 1.5, 2].map((x) => <option key={x} value={x}>{x}</option>)}</select>
                </label>
              </div>
              <fieldset className="ident__margens"><legend>{t('configuracoes.entregas.campo.margens')}</legend>
                {(['topo', 'direita', 'base', 'esquerda'] as const).map((k) => (
                  <label key={k} className="field">{t(`configuracoes.entregas.margem.${k}`)}<input type="number" min={1} max={5} step={0.5} value={edit.margens[k]} onChange={(e) => muda({ margens: { ...edit.margens, [k]: Number(e.target.value) } })} /></label>
                ))}
              </fieldset>
              <label className="check"><input type="checkbox" checked={edit.cabecalho.mostrar} onChange={(e) => muda({ cabecalho: { ...edit.cabecalho, mostrar: e.target.checked } })} /> {t('configuracoes.entregas.campo.cabecalho')}</label>
              {edit.cabecalho.mostrar && <>
                <input value={edit.cabecalho.texto} maxLength={120} placeholder={t('configuracoes.entregas.campo.variaveis', { empresa: '{empresa}', titulo: '{titulo}', data: '{data}' })} aria-label={t('configuracoes.entregas.campo.cabecalho')} onChange={(e) => muda({ cabecalho: { ...edit.cabecalho, texto: e.target.value } })} />
                <label className="check"><input type="checkbox" checked={edit.cabecalho.logo} onChange={(e) => muda({ cabecalho: { ...edit.cabecalho, logo: e.target.checked } })} /> {t('configuracoes.entregas.campo.logoNoCabecalho')}</label>
              </>}
              <label className="check"><input type="checkbox" checked={edit.rodape.mostrar} onChange={(e) => muda({ rodape: { ...edit.rodape, mostrar: e.target.checked } })} /> {t('configuracoes.entregas.campo.rodape')}</label>
              {edit.rodape.mostrar && <input value={edit.rodape.texto} maxLength={120} aria-label={t('configuracoes.entregas.campo.rodape')} placeholder={t('configuracoes.entregas.campo.variaveis', { empresa: '{empresa}', titulo: '{titulo}', data: '{data}' })} onChange={(e) => muda({ rodape: { ...edit.rodape, texto: e.target.value } })} />}
              <label className="field">{t('configuracoes.entregas.campo.paginacao')}
                <select value={edit.paginacao} onChange={(e) => muda({ paginacao: e.target.value as ModeloDoc['paginacao'] })}>
                  {/* i18n-ok: valores do modelo (o rótulo vem do dicionário) */}
                  {(['nenhuma', 'rodape', 'topo'] as const).map((p) => <option key={p} value={p}>{t(`configuracoes.entregas.pag.${p}`)}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={edit.capa.ligada} onChange={(e) => muda({ capa: { ...edit.capa, ligada: e.target.checked } })} /> {t('configuracoes.entregas.campo.capa')}</label>
              {edit.capa.ligada && (
                <div className="ident__linha">
                  {(['instituicao', 'autor', 'subtitulo', 'local', 'ano'] as const).map((k) => (
                    <label key={k} className="field">{t(`configuracoes.entregas.capa.${k}`)}<input value={edit.capa[k]} maxLength={k === 'ano' ? 10 : 160} onChange={(e) => muda({ capa: { ...edit.capa, [k]: e.target.value } })} /></label>
                  ))}
                </div>
              )}
              <div className="ident__checks">
                {(['numerarTitulos', 'recuo', 'justificar', 'citacaoAbnt'] as const).map((k) => (
                  <label key={k} className="check"><input type="checkbox" checked={edit[k]} onChange={(e) => muda({ [k]: e.target.checked })} /> {t(`configuracoes.entregas.campo.${k === 'numerarTitulos' ? 'numerar' : k === 'citacaoAbnt' ? 'citacao' : k}`)}</label>
                ))}
              </div>
              <div className="row">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => void salvarModelo()}>{t('configuracoes.entregas.salvar')}</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void apagar()}><Icon name="trash" size={13} /> {t('configuracoes.entregas.apagar')}</button>
              </div>
            </div>
          )}
        </section>
        {msg && <p className={msg.kind === 'error' ? 'error' : 'ok-msg'} role="status">{msg.text}</p>}
      </div>
      <div className="ident__previa" aria-hidden="true">
        <Documento fonte={{ texto: amostra, titulo: 'amostra.md' }} modo="embutido" revisar={false} modelo={modelo} identidade={rasc} />
      </div>
    </div>
  );
}

/**
 * Logo → PNG ou JPEG que o servidor aceita: PNG/JPEG pequenos vão como estão; SVG, WebP e imagens grandes são desenhados
 * num canvas (o SVG como imagem não roda script) e saem em PNG, com no máximo 800 px de largura.
 */
async function paraPng(f: File): Promise<Blob | null> {
  const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!ok.includes(f.type) || f.size > 2 * 1024 * 1024) return null;
  if ((f.type === 'image/png' || f.type === 'image/jpeg') && f.size <= 400 * 1024) return f;
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img')); img.src = url; });
    const w0 = img.naturalWidth || 600; const h0 = img.naturalHeight || 200;
    const k = Math.min(1, 800 / w0);
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(w0 * k)); c.height = Math.max(8, Math.round(h0 * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

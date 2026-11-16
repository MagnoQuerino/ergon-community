import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { ApiError, api } from '../lib/api.ts';
import {
  CATEGORIAS, DADOS_TECNICOS, FORM_VAZIO, LIMITES, ROTULO_CATEGORIA, falhaDoEnvio, faltaNoRelato, pedidoDoRelato, sistemaDoNavegador, textoDoRelato,
  type Categoria, type FormRelato,
} from '../lib/relato.ts';

/**
 * "Relatar um problema" (Ajuda): formulário → prévia (o JSON exato, já limpo pelo servidor local) → "Enviar relato".
 * Nada sai antes do clique. Sem conta e sem o World: o servidor local manda para o receptor público.
 */
type Fase = { f: 'form' } | { f: 'previa'; relato: unknown } | { f: 'enviado'; id: string };

export function RelatarProblema({ categoria }: { categoria: Categoria | '' }) {
  const t = useT();
  const [form, setForm] = useState<FormRelato>({ ...FORM_VAZIO, categoria });
  const [fase, setFase] = useState<Fase>({ f: 'form' });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [copia, setCopia] = useState<'copiado' | 'falhou' | null>(null);
  const [disponivel, setDisponivel] = useState<boolean | null>(null);
  useEffect(() => { api.get<{ disponivel: boolean }>('/api/relatos').then((r) => setDisponivel(r.disponivel)).catch(() => {}); }, []);
  useEffect(() => { if (categoria) setForm((f) => ({ ...f, categoria })); }, [categoria]);

  const sistema = sistemaDoNavegador(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  // o mesmo corpo na prévia e no envio: quem monta e limpa é o servidor, com a mesma função nos dois
  const [corpo, setCorpo] = useState<ReturnType<typeof pedidoDoRelato> | null>(null);
  const muda = <K extends keyof FormRelato>(k: K, v: FormRelato[K]) => { setForm((f) => ({ ...f, [k]: v })); setErro(null); };
  const falta = faltaNoRelato(form);

  const previa = async () => {
    if (falta || ocupado) return;
    const c = pedidoDoRelato(form, sistema);
    setOcupado(true); setErro(null); setCopia(null);
    try { const r = await api.post<{ relato: unknown }>('/api/relatos/previa', c); setCorpo(c); setFase({ f: 'previa', relato: r.relato }); }
    catch (e) { setErro(t(e instanceof ApiError && e.code === 'relato_curto' ? 'ajuda.relato.erro.curto' : 'ajuda.relato.erro.naoEnviado')); }
    finally { setOcupado(false); }
  };
  const enviar = async () => {
    if (!corpo || ocupado || disponivel === false) return;
    setOcupado(true); setErro(null);
    // i18n-ok: a fase é código interno, não texto de tela
    try { const r = await api.post<{ id: string }>('/api/relatos/enviar', corpo); setFase({ f: 'enviado', id: r.id }); }
    catch (e) { setErro(t(falhaDoEnvio(e instanceof ApiError ? e.code : ''))); }
    finally { setOcupado(false); }
  };
  const copiar = async (texto: string) => {
    // i18n-ok: estado interno da cópia, não texto de tela
    try { await navigator.clipboard.writeText(texto); setCopia('copiado'); } catch { setCopia('falhou'); }
  };
  const recomecar = () => { setForm({ ...FORM_VAZIO }); setCorpo(null); setFase({ f: 'form' }); setErro(null); setCopia(null); };

  if (fase.f === 'enviado') return (
    <div className="relato">
      <p role="status"><b>{t('ajuda.relato.enviado', { id: fase.id })}</b></p>
      <button className="btn" onClick={recomecar}>{t('ajuda.relato.novo')}</button>
    </div>
  );

  if (fase.f === 'previa') {
    const texto = textoDoRelato(fase.relato);
    return (
      <div className="relato">
        <h4>{t('ajuda.relato.previaTitulo')}</h4>
        <p className="muted">{t('ajuda.relato.limpo')}</p>
        <pre className="pre" aria-label={t('ajuda.relato.previaTitulo')}>{texto}</pre>
        <div className="row">
          <button className="btn btn--primary" onClick={() => void enviar()} disabled={ocupado || disponivel === false}>{ocupado ? t('ajuda.relato.enviando') : t('ajuda.relato.enviar')}</button>
          <button className="btn btn--ghost" onClick={() => { setFase({ f: 'form' }); setErro(null); }} disabled={ocupado}>{t('ajuda.relato.editar')}</button>
          {(erro || disponivel === false) && <button className="btn btn--ghost" onClick={() => void copiar(texto)}>{t('ajuda.relato.copiar')}</button>}
        </div>
        {disponivel === false && <p className="hint">{t('ajuda.relato.indisponivel')}</p>}
        {erro && <p className="error" role="alert">{erro}</p>}
        {copia && <p className="hint" role="status">{t(copia === 'copiado' ? 'ajuda.relato.copiado' : 'ajuda.relato.naoCopiou')}</p>}
      </div>
    );
  }

  return (
    <div className="relato">
      <p className="muted">{t('ajuda.relato.intro')}</p>
      <label className="field">{t('ajuda.relato.categoria')}
        <select value={form.categoria} onChange={(e) => muda('categoria', e.target.value as Categoria | '')}>
          <option value="" disabled>{t('ajuda.relato.escolha')}</option>
          {CATEGORIAS.map((c) => <option key={c} value={c}>{t(ROTULO_CATEGORIA[c])}</option>)}
        </select>
      </label>
      <label className="field">{t('ajuda.relato.campoTitulo')}<input value={form.titulo} maxLength={LIMITES.titulo[1]} onChange={(e) => muda('titulo', e.target.value)} /></label>
      <label className="field">{t('ajuda.relato.descricao')}<textarea rows={5} value={form.descricao} maxLength={LIMITES.descricao[1]} onChange={(e) => muda('descricao', e.target.value)} /></label>
      <label className="field">{t('ajuda.relato.passos')}<textarea rows={3} value={form.passos} maxLength={LIMITES.passos[1]} onChange={(e) => muda('passos', e.target.value)} /></label>
      <label className="field">{t('ajuda.relato.esperado')}<textarea rows={2} value={form.esperado} maxLength={LIMITES.esperado[1]} onChange={(e) => muda('esperado', e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={form.dadosTecnicos} onChange={(e) => muda('dadosTecnicos', e.target.checked)} /> {t('ajuda.relato.dadosTecnicos')}</label>
      <div className="hint">{t('ajuda.relato.dadosLista')}
        <ul>{DADOS_TECNICOS.map((k) => <li key={k}>{t(k)}</li>)}</ul>
      </div>
      <div className="row">
        <button className="btn btn--primary" onClick={() => void previa()} disabled={!!falta || ocupado}>{ocupado ? t('ajuda.relato.preparando') : t('ajuda.relato.verPrevia')}</button>
        {falta && <span className="hint">{t(falta)}</span>}
      </div>
      {disponivel === false && <p className="hint">{t('ajuda.relato.indisponivel')}</p>}
      {erro && <p className="error" role="alert">{erro}</p>}
    </div>
  );
}

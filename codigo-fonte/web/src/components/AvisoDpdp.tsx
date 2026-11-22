/**
 * rc.47: a Lei DPDP da Índia na tela (server/src/services/dpdp.ts). O aviso de consentimento aparece uma vez por versão
 * quando o dono do workspace liga a DPDP (o texto: legal/aviso-dpdp.ts, no idioma da tela); em Minha conta › Privacidade,
 * a pessoa revê o aviso, retira o consentimento (o mesmo esforço de dar) e nomeia um representante; em Segurança, o dono
 * preenche quem responde pelos dados, o Grievance Officer, o Consent Manager (opcional) e o prazo de resposta.
 */
import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { fmtData, useIdioma, useT } from '../i18n/index.ts';
import { avisoDpdp } from '../legal/aviso-dpdp.ts';
import type { ConfigDpdp, EstadoDpdp } from '../lib/types.ts';

export function TextoDoAvisoDpdp({ config }: { config: ConfigDpdp }) {
  const aviso = avisoDpdp(useIdioma(), config);
  return (
    <div className="termos aviso-dpdp">
      <p className="termos__resumo">{aviso.intro}</p>
      {aviso.secoes.map((s) => (
        <section key={s.titulo}>
          <h3>{s.titulo}</h3>
          {s.paragrafos.length > 1 ? <ul>{s.paragrafos.map((p, i) => <li key={i}>{p}</li>)}</ul> : <p>{s.paragrafos[0]}</p>}
        </section>
      ))}
    </div>
  );
}

/** O aviso, uma vez por versão: "Concordo" grava o consentimento; "Agora não" fecha até a próxima vez que o Ergon abrir. */
export function AceiteDpdp({ estado, onDone }: { estado: EstadoDpdp; onDone: () => void }) {
  const t = useT();
  const idioma = useIdioma();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fechado, setFechado] = useState(false);
  if (fechado || !estado.config) return null;
  const aviso = avisoDpdp(idioma, estado.config);
  const concordar = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/api/me/consentimento', { versao: estado.versao, idioma }); onDone(); } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="aviso-dpdp-titulo">
      <div className="auth__card termos__card">
        <h2 className="auth__title" id="aviso-dpdp-titulo">{aviso.titulo}</h2>
        <p className="hint">{t('conta.dpdp.sub')}</p>
        <TextoDoAvisoDpdp config={estado.config} />
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row row--wrap aviso-dpdp__acoes">
          <button className="btn btn--primary" disabled={busy} onClick={() => void concordar()}>{t('conta.dpdp.concordo')}</button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => setFechado(true)}>{t('conta.dpdp.agoraNao')}</button>
        </div>
        <p className="small muted">{t('conta.dpdp.agoraNaoDica')}</p>
      </div>
    </div>
  );
}

interface Representante { nome: string; contato: string; relacao: string; atualizadoEm: string }

/** Minha conta › Privacidade: o consentimento (dado em…, retirar, dar de novo), rever o aviso e o representante. */
export function PrivacidadeDpdp({ estado, onChanged }: { estado: EstadoDpdp; onChanged: () => void }) {
  const t = useT();
  const idioma = useIdioma();
  const [ver, setVer] = useState(false);
  const [retirar, setRetirar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rep, setRep] = useState<Representante | null>(null);
  const [form, setForm] = useState({ nome: '', contato: '', relacao: '' });
  const [editando, setEditando] = useState(false);
  useEffect(() => { void api.get<{ representante: Representante | null }>('/api/me/representante').then((r) => setRep(r.representante)).catch(() => undefined); }, []);
  const agir = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); onChanged(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } };
  if (!estado.ligado || !estado.config) return null;
  return (
    <div className="conta__dados conta__dpdp">
      <h4>{t('conta.dpdp.titulo')}</h4>
      <p className="small" role="status">{estado.aceito && estado.aceitoEm ? t('conta.dpdp.dadoEm', { data: fmtData(estado.aceitoEm) })
        : estado.retiradoEm ? t('conta.dpdp.retiradoEm', { data: fmtData(estado.retiradoEm) }) : t('conta.dpdp.semConsentimento')}</p>
      <div className="row row--wrap">
        <button className="btn btn--sm btn--ghost" onClick={() => setVer((v) => !v)}>{ver ? t('conta.dpdp.esconder') : t('conta.dpdp.verAviso')}</button>
        {estado.aceito
          ? (retirar
            ? <span className="confirm">{t('conta.dpdp.retirarPergunta')}
                <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void agir(async () => { await api.del('/api/me/consentimento'); setRetirar(false); })}>{t('conta.dpdp.retirar')}</button>
                <button className="btn btn--sm btn--ghost" onClick={() => setRetirar(false)}>{t('conta.acao.cancelar')}</button></span>
            : <button className="btn btn--sm btn--ghost" onClick={() => setRetirar(true)}>{t('conta.dpdp.retirar')}</button>)
          : <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void agir(() => api.post('/api/me/consentimento', { versao: estado.versao, idioma }))}>{t('conta.dpdp.concordo')}</button>}
      </div>
      {ver && <TextoDoAvisoDpdp config={estado.config} />}
      <h4>{t('conta.dpdp.repTitulo')}</h4>
      <p className="small muted">{t('conta.dpdp.repDica')}</p>
      {rep && !editando
        ? <div className="row row--wrap"><span className="small"><b>{rep.nome}</b> · {rep.contato}{rep.relacao ? ` · ${rep.relacao}` : ''}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => { setForm({ nome: rep.nome, contato: rep.contato, relacao: rep.relacao }); setEditando(true); }}>{t('conta.dpdp.repTrocar')}</button>
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void agir(async () => { await api.del('/api/me/representante'); setRep(null); })}>{t('conta.dpdp.repRemover')}</button></div>
        : <form className="conn-wac__campos" onSubmit={(e) => { e.preventDefault(); void agir(async () => { const r = await api.put<{ representante: Representante }>('/api/me/representante', form); setRep(r.representante); setEditando(false); }); }}>
            <label className="field">{t('conta.dpdp.repNome')}<input value={form.nome} maxLength={120} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></label>
            <label className="field">{t('conta.dpdp.repContato')}<input value={form.contato} maxLength={200} onChange={(e) => setForm({ ...form, contato: e.target.value })} /></label>
            <label className="field">{t('conta.dpdp.repRelacao')}<input value={form.relacao} maxLength={80} onChange={(e) => setForm({ ...form, relacao: e.target.value })} /></label>
            <div className="row"><button className="btn btn--sm btn--primary" disabled={busy || form.nome.trim().length < 2 || form.contato.trim().length < 5}>{t('conta.dpdp.repNomear')}</button>
              {editando && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditando(false)}>{t('conta.acao.cancelar')}</button>}</div>
          </form>}
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
  );
}

/** Segurança (dono do workspace): ligar o aviso da DPDP e o que ele mostra. */
export function DpdpConfigCard({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [c, setC] = useState<(ConfigDpdp & { ligado: boolean }) | null>(null);
  const [cm, setCm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  useEffect(() => { void api.get<ConfigDpdp & { ligado: boolean }>('/api/privacidade/dpdp').then((x) => { setC(x); setCm(!!x.consentManager); }).catch(() => undefined); }, []);
  if (!c) return null;
  const g = (k: keyof ConfigDpdp['grievance'], v: string) => setC({ ...c, grievance: { ...c.grievance, [k]: v } });
  const salvar = async (ligado: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.put<ConfigDpdp & { ligado: boolean }>('/api/privacidade/dpdp', { ...c, ligado, consentManager: cm && c.consentManager?.nome ? c.consentManager : null });
      setC(r); setMsg({ ok: true, texto: t(r.ligado ? 'conta.dpdp.cfg.salvoLigado' : 'conta.dpdp.cfg.salvo') }); onChanged();
    } catch (x) { setMsg({ ok: false, texto: errMsg(x) }); } finally { setBusy(false); }
  };
  const cmv = c.consentManager ?? { nome: '', registro: '', url: '' };
  return (
    <section className="card dpdp-cfg">
      <h3>{t('conta.dpdp.cfg.titulo')}</h3>
      <p className="muted small">{t('conta.dpdp.cfg.intro')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void salvar(true); }}>
        <div className="conn-wac__campos">
          <label className="field">{t('conta.dpdp.cfg.responsavel')}<input value={c.responsavel} maxLength={160} onChange={(e) => setC({ ...c, responsavel: e.target.value })} /></label>
          <label className="field">{t('conta.dpdp.cfg.prazo')}<input type="number" min={1} max={90} value={c.prazoDias} onChange={(e) => setC({ ...c, prazoDias: Number(e.target.value) })} /></label>
        </div>
        <h4>{t('conta.dpdp.cfg.grievance')}</h4>
        <div className="conn-wac__campos">
          <label className="field">{t('conta.dpdp.cfg.nome')}<input value={c.grievance.nome} maxLength={120} onChange={(e) => g('nome', e.target.value)} /></label>
          <label className="field">{t('conta.dpdp.cfg.email')}<input type="email" value={c.grievance.email} maxLength={200} onChange={(e) => g('email', e.target.value)} /></label>
          <label className="field">{t('conta.dpdp.cfg.telefone')}<input value={c.grievance.telefone} maxLength={40} onChange={(e) => g('telefone', e.target.value)} /></label>
          <label className="field">{t('conta.dpdp.cfg.endereco')}<input value={c.grievance.endereco} maxLength={300} onChange={(e) => g('endereco', e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={cm} onChange={(e) => setCm(e.target.checked)} /> {t('conta.dpdp.cfg.usaCm')}</label>
        {cm && <div className="conn-wac__campos">
          <label className="field">{t('conta.dpdp.cfg.cmNome')}<input value={cmv.nome} maxLength={120} onChange={(e) => setC({ ...c, consentManager: { ...cmv, nome: e.target.value } })} /></label>
          <label className="field">{t('conta.dpdp.cfg.cmRegistro')}<input value={cmv.registro} maxLength={80} onChange={(e) => setC({ ...c, consentManager: { ...cmv, registro: e.target.value } })} /></label>
          <label className="field">{t('conta.dpdp.cfg.cmUrl')}<input type="url" value={cmv.url} maxLength={300} placeholder="https://" onChange={(e) => setC({ ...c, consentManager: { ...cmv, url: e.target.value } })} /></label>
        </div>}
        <p className="hint small">{t('conta.dpdp.cfg.prazoDica')}</p>
        <div className="row row--wrap">
          <button className="btn btn--primary" disabled={busy}>{c.ligado ? t('conta.acao.salvar') : t('conta.dpdp.cfg.ligar')}</button>
          {c.ligado && <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void salvar(false)}>{t('conta.dpdp.cfg.desligar')}</button>}
        </div>
        {msg && <p className={msg.ok ? 'ok small' : 'error small'} role="status">{msg.texto}</p>}
      </form>
    </section>
  );
}

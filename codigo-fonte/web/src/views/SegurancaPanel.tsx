import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { passkeyRegister, passkeysHere } from '../lib/passkey.ts';
import type { Me, SecurityStatus } from '../lib/types.ts';
import { RecoveryReveal } from '../components/AuthFlow.tsx';
import { Loading } from '../brand/Brand.tsx';
import { BaixarMeusDados } from '../components/BaixarMeusDados.tsx';
import { PrivacidadeCard } from '../components/AjustesEquipe.tsx';
import { Icon } from '../components/Icon.tsx';
import { ConfirmPopup } from '../components/ConfirmPopup.tsx';
import { TEXTO_ANTES_DE_EXCLUIR, TEXTO_EXCLUIR_CONTA } from '../lib/textos-tela.ts';
import { fmtDataHora, t as tr, tn, useT } from '../i18n/index.ts';

const when = (iso: string | null) => (iso ? fmtDataHora(iso) : '—');
/** "Chrome · Windows" a partir do user agent (só para reconhecer a sessão). */
function device(ua: string | null): string {
  const s = ua ?? '';
  const b = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : tr('conta.seg.navegador');
  const o = /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}

/** Botão liga/desliga do destrancar sozinho (precisa do ajudante do computador para ligar). */
function AutoUnlockSwitch({ s, busy, onOn, onOff }: { s: SecurityStatus; busy: boolean; onOn: () => void; onOff: () => void }) {
  const t = useT();
  const on = s.autoUnlock.length > 0;
  const pending = !on && s.autoUnlockPending;
  return (
    <button role="switch" aria-checked={on || pending} aria-label={t('conta.seg.destrancarSozinho')} className={`switch ${on || pending ? 'switch--on' : ''}`}
      disabled={busy || pending || (!on && !s.agentConfigured)} onClick={on ? onOff : onOn}>
      <span className="switch__knob" /><span className="switch__txt">{on ? t('conta.estado.ligado') : pending ? t('conta.estado.ligando') : t('conta.estado.desligado')}</span>
    </button>
  );
}

/**
 * Trancamento: ligado, o Ergon pede a senha ao reiniciar; desligado (padrão no computador), abre sozinho e a proteção
 * passa a ser a do computador. Desligar mostra antes um aviso curto dos riscos.
 */
function LockCard({ s, busy, onSet }: { s: SecurityStatus; busy: boolean; onSet: (on: boolean) => void }) {
  const t = useT();
  const [ask, setAsk] = useState(false);
  const on = s.lock.enabled;
  return (
    <section className="card">
      <div className="row sec-toggle">
        <h3>{t('conta.seg.trancamento')}</h3>
        <button role="switch" aria-checked={on} aria-label={t('conta.seg.trancamentoAria')} className={`switch ${on ? 'switch--on' : ''}`}
          disabled={busy || ask} onClick={() => (on ? setAsk(true) : onSet(true))}>
          <span className="switch__knob" /><span className="switch__txt">{on ? t('conta.estado.ligado') : t('conta.estado.desligado')}</span>
        </button>
      </div>
      {on
        ? <p>{t('conta.seg.trancamentoLigadoTexto', { n: s.lock.sessionDays })}</p>
        : <p>{t('conta.seg.trancamentoDesligadoTexto', { n: s.lock.sessionDays })}</p>}
      {ask && (
        <div className="lock-warn" role="alertdialog" aria-label={t('conta.seg.desligarAria')}>
          <p>{tn('conta.seg.desligarAviso', { antes: <b>{t('conta.seg.antesDeDesligar')}</b> })}</p>
          <p>{tn('conta.seg.desligarAlternativa', { destrancar: <b>{t('conta.seg.destrancarSozinhoCurto')}</b> })}</p>
          <div className="row">
            <button className="btn btn--primary" disabled={busy} onClick={() => { setAsk(false); onSet(false); }}>{t('conta.seg.desligarMesmoAssim')}</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setAsk(false)}>{t('conta.seg.manterLigado')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Configurações › Segurança: senha, trava, frase, autenticador, passkeys, destrancar sozinho e sessões. */
export function SegurancaPanel({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const t = useT();
  const st = useResource<SecurityStatus>('/api/security/status', []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [rec, setRec] = useState<{ phrase: string; ask: number[] } | null>(null);
  const [totp, setTotp] = useState<{ secret: string; qr: string; code: string } | null>(null);
  const [pkName, setPkName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const s = st.data;
  // ajustes da instalação (trancamento): quem administra; frase, trava, abrir sozinho: cada pessoa a sua
  const admin = me.admin;
  const isolated = !!s?.people?.isolated;
  const [leaving, setLeaving] = useState<string | null>(null);
  // ligando: o ajudante do computador busca a chave em poucos segundos; a tela acompanha
  useEffect(() => {
    if (!s?.autoUnlockPending) return;
    const timer = window.setInterval(() => st.reload(), 2000);
    return () => clearInterval(timer);
  }, [s?.autoUnlockPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null); setBusy(label);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); st.reload(); onChanged(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(null); }
  };
  if (!s) return <Loading error={st.error} />;
  const here = passkeysHere(s.rpId);

  return (
    <>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>{t('conta.seg.protecao')}</h3>
        <ul className="sec-list">
          <li><span className="badge badge--ok">{t('conta.seg.cifrado')}</span> {t('conta.seg.cifradoBanco')}</li>
          <li><span className="badge badge--ok">{t('conta.seg.cifrado')}</span> {t('conta.seg.cifradoConteudo')}</li>
          {isolated && <li><span className="badge badge--ok">{t('conta.seg.soSeu')}</span> {t('conta.seg.isolado', { n: s.people!.count })}</li>}
          {s.motorVault
            ? <li><span className="badge badge--ok">{t('conta.seg.cifrado')}</span> {t('conta.seg.cifradoEquipe')}</li>
            : <li><span className="badge">{t('conta.seg.semEquipe')}</span> {t('conta.seg.semEquipeTexto')}</li>}
        </ul>
        <p className="hint">{s.lock.enabled ? t('conta.seg.chaveNaMemoria') : t('conta.seg.chaveAoLado')} {t('conta.seg.discoRecomendado')}</p>
      </section>

      {admin && s.mode === 'local' && s.protected && (
        <LockCard s={s} busy={busy === 'lock'} onSet={(on) => void act('lock', () => api.put('/api/security/lock', { enabled: on }),
          on ? t('conta.seg.trancamentoLigadoOk') : t('conta.seg.trancamentoDesligadoOk'))} />
      )}

      {/* rc.27: o que a equipe de IA faz com os seus dados (não treinar; busca privada) */}
      <PrivacidadeCard />

      <section className="card">
        <h3>{t('conta.senha.rotulo')}</h3>
        <form className="row row--wrap" onSubmit={(e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) return setMsg({ kind: 'error', text: t('conta.senha.novasDiferentes') });
          void act('senha', async () => { await api.post('/api/security/password', { current: pw.current, next: pw.next }); setPw({ current: '', next: '', confirm: '' }); }, t('conta.seg.senhaAlterada'));
        }}>
          <label className="field">{t('conta.senha.atual')}<input required type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
          <label className="field">{t('conta.senha.nova')}<input required type="password" autoComplete="new-password" minLength={s.minPassword} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
          <label className="field">{t('conta.seg.repita')}<input required type="password" autoComplete="new-password" minLength={s.minPassword} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
          <button className="btn btn--primary" disabled={busy === 'senha'}>{busy === 'senha' ? t('conta.acao.salvando') : t('conta.seg.trocarSenha')}</button>
        </form>
        <p className="hint">{t('conta.seg.senhaDica', { min: s.minPassword })}</p>
      </section>

      <IdleLock minutes={s.idleMinutes} owner busy={busy === 'idle'} onSave={(m, label) => void act('idle', () => api.put('/api/security/idle', { minutes: m }), label)} />

      <section className="card">
        {!rec && <h3>{isolated ? t('conta.seg.suaFrase') : t('conta.frase.titulo')}</h3>}
        {rec ? (
          <div className="sec-reveal"><RecoveryReveal r={rec} onDone={() => { setRec(null); setMsg({ kind: 'ok', text: t('conta.seg.fraseConfirmada') }); st.reload(); onChanged(); }} onCancel={() => setRec(null)} /></div>
        ) : (
          <>
            <p>{s.recovery ? <><span className="badge badge--ok">{t('conta.seg.confirmada')}</span> {t('conta.seg.comFrase')}</> : <><span className="badge badge--warn">{t('conta.seg.semFrase')}</span> {t('conta.seg.semFraseTexto')}</>}</p>
            <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('frase', async () => setRec(await api.post('/api/security/recovery/new')))}>{s.recovery ? t('conta.seg.gerarNova') : t('conta.seg.gerar')}</button>
            <p className="hint">{t('conta.seg.gerarDica')}</p>
          </>
        )}
      </section>

      <section className="card">
        <h3>{t('conta.seg.autenticador')}</h3>
        {s.totp ? (
          <>
            <p><span className="badge badge--ok">{t('conta.seg.ligadoSelo')}</span> {t('conta.seg.totpLigadoTexto')}</p>
            <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('totp-off', () => api.del('/api/security/totp'), t('conta.seg.totpDesligadoOk'))}>{t('conta.seg.desligar')}</button>
          </>
        ) : totp ? (
          <form className="totp" onSubmit={(e) => { e.preventDefault(); void act('totp', async () => { await api.post('/api/security/totp/confirm', { code: totp.code.replace(/\s/g, '') }); setTotp(null); }, t('conta.seg.totpLigadoOk')); }}>
            <img src={totp.qr} alt={t('conta.seg.qrAlt')} width={180} height={180} />
            <div>
              <p>{t('conta.seg.totpPasso1')}</p>
              <p className="muted small">{tn('conta.seg.semCamera', { chave: <code className="totp__secret">{totp.secret.replace(/(.{4})/g, '$1 ').trim()}</code> })}</p>
              <label className="field">{t('conta.seg.totpPasso2')}<input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={totp.code} onChange={(e) => setTotp({ ...totp, code: e.target.value })} /></label>
              <div className="row"><button className="btn btn--primary btn--sm" disabled={!!busy}>{t('conta.seg.ligar')}</button><button type="button" className="btn btn--ghost btn--sm" onClick={() => setTotp(null)}>{t('conta.acao.cancelar')}</button></div>
            </div>
          </form>
        ) : (
          <>
            <p className="muted">{t('conta.seg.totpOpcional')}</p>
            <button className="btn btn--sm" disabled={!!busy} onClick={() => void act('totp-start', async () => { const r = await api.post<{ secret: string; qr: string }>('/api/security/totp/start'); setTotp({ secret: r.secret, qr: r.qr, code: '' }); })}>{t('conta.seg.configurar')}</button>
          </>
        )}
      </section>

      <section className="card">
        <h3>{t('conta.seg.passkeys')}</h3>
        <p className="muted small">{t('conta.seg.passkeysTexto')}</p>
        {s.passkeys.length > 0 && (
          <ul className="sec-rows">
            {s.passkeys.map((p) => (
              <li key={p.id}><b>{p.name}</b><span className="muted small">{t('conta.seg.passkeyLinha', { criada: when(p.created_at), uso: when(p.last_used_at) })}</span>
                <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('pk-del', () => api.del(`/api/security/passkeys/${p.id}`), t('conta.seg.passkeyRemovida'))}>{t('conta.acao.remover')}</button></li>
            ))}
          </ul>
        )}
        {here ? (
          <form className="row row--wrap" onSubmit={(e) => { e.preventDefault(); void act('pk', async () => { await passkeyRegister(pkName.trim() || t('conta.seg.passkeyNomePadrao')); setPkName(''); }, t('conta.seg.passkeyCadastrada')); }}>
            <label className="field">{t('conta.seg.passkeyNome')}<input value={pkName} maxLength={60} placeholder={t('conta.seg.passkeyNomeExemplo')} onChange={(e) => setPkName(e.target.value)} /></label>
            <button className="btn btn--primary" disabled={!!busy}>{busy === 'pk' ? t('conta.seg.esperandoAparelho') : t('conta.seg.adicionarPasskey')}</button>
          </form>
        ) : <p className="hint warn">{tn('conta.seg.passkeysSoPor', { endereco: <a href={s.publicUrl}>{s.publicUrl}</a> })}</p>}
      </section>

      <ChavesDaEquipe />

      {s.mode === 'local' && (s.lock.enabled || isolated) && (
        <section className="card">
          <div className="row sec-toggle">
            <h3>{isolated ? t('conta.seg.abrirMeusDadosSozinho') : t('conta.seg.destrancarSozinho')}</h3>
            <AutoUnlockSwitch s={s} busy={!!busy} onOn={() => void act('auto-on', () => api.post('/api/security/auto-unlock'))}
              onOff={() => void act('auto-off', () => api.del('/api/security/auto-unlock'), t('conta.seg.autoDesligadoOk'))} />
          </div>
          {s.autoUnlock.length
            ? <p>{tn('conta.seg.autoLigadoEm', { onde: <b>{s.autoUnlock[0].label || t('conta.seg.esteComputador')}</b>, desde: when(s.autoUnlock[0].createdAt) })}</p>
            : s.autoUnlockPending ? <p className="muted">{s.agent ? t('conta.seg.autoLigandoAjudante') : t('conta.seg.autoLigandoEsperando')}</p>
            : <p>{t('conta.seg.autoDesligadoTexto')}</p>}
          {!s.autoUnlock.length && !s.agentConfigured && <p className="hint warn">{t('conta.seg.semAjudante')}</p>}
          <p className="hint">{t('conta.seg.cofreDica')}</p>
          {isolated && <p className="hint warn">{t('conta.seg.variasPessoas')}</p>}
        </section>
      )}

      {!admin && s.mode === 'local' && (
        <section className="card">
          <h3>{t('conta.seg.excluirTitulo')}</h3>
          <p className="muted">{TEXTO_EXCLUIR_CONTA}</p>
          <div className="sec-passo">
            <p><b>1. {TEXTO_ANTES_DE_EXCLUIR}</b></p>
            <BaixarMeusDados />
          </div>
          <p><b>{t('conta.seg.excluirPasso')}</b></p>
          {leaving === null
            ? <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => setLeaving('')}>{t('conta.seg.excluirComecar')}</button>
            : (
              <form className="lock-warn" onSubmit={(e) => { e.preventDefault(); void act('leave', async () => { await api.del('/api/me/account', { confirm: leaving }); location.hash = ''; location.reload(); }); }}>
                <label className="field">{t('conta.seg.excluirConfirmar', { usuario: me.user.username })}<input required autoFocus value={leaving} onChange={(e) => setLeaving(e.target.value)} /></label>
                <div className="row">
                  <button className="btn btn--danger btn--sm" disabled={busy === 'leave' || leaving !== me.user.username}>{busy === 'leave' ? t('conta.acao.excluindo') : t('conta.acao.excluirDeVez')}</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLeaving(null)}>{t('conta.acao.cancelar')}</button>
                </div>
              </form>
            )}
        </section>
      )}

      <section className="card">
        <h3>{t('conta.seg.sessoes')}</h3>
        <ul className="sec-rows">
          {s.sessions.map((x) => (
            <li key={x.id}><b>{device(x.user_agent)}</b><span className="muted small">{t(x.current ? 'conta.seg.sessaoAtual' : 'conta.seg.sessaoOutra', { desde: when(x.created_at), uso: when(x.last_seen_at) })}</span>
              {!x.current && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => void act('sess', () => api.del(`/api/security/sessions/${x.id}`), t('conta.seg.sessaoEncerrada'))}>{t('conta.seg.encerrar')}</button>}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * Trava por inatividade: desligada por padrão. Ligada, você diz depois de quanto tempo sem usar (minutos ou horas,
 * até 24 h). Só mouse e teclado contam; com a tela trancada, os agentes continuam trabalhando.
 */
function IdleLock({ minutes, owner, busy, onSave }: { minutes: number; owner: boolean; busy: boolean; onSave: (minutes: number, label: string) => void }) {
  const t = useT();
  const on = minutes > 0;
  const initUnit = minutes > 0 && minutes % 60 === 0 ? 'h' : 'min';
  const [unit, setUnit] = useState<'min' | 'h'>(initUnit);
  const [value, setValue] = useState(String(minutes > 0 ? (initUnit === 'h' ? minutes / 60 : minutes) : 15));
  useEffect(() => { if (minutes > 0) { const u = minutes % 60 === 0 ? 'h' : 'min'; setUnit(u); setValue(String(u === 'h' ? minutes / 60 : minutes)); } }, [minutes]);
  const n = Math.round(Number(value.replace(',', '.')) * (unit === 'h' ? 60 : 1));
  const valid = Number.isFinite(n) && n >= 1 && n <= 24 * 60;
  const text = (m: number) => (m % 60 === 0 ? t('conta.trava.h', { h: m / 60 }) : m > 60 ? t('conta.trava.hMin', { h: Math.floor(m / 60), min: m % 60 }) : t('conta.trava.min', { min: m }));
  return (
    <section className="card">
      <header className="row">
        <h3>{t('conta.trava.titulo')}</h3>
        <button role="switch" aria-checked={on} aria-label={t('conta.trava.aria')} className={`switch ${on ? 'switch--on' : ''}`} disabled={!owner || busy}
          onClick={() => onSave(on ? 0 : (valid ? n : 15), on ? t('conta.trava.desligadaOk') : t('conta.trava.ligadaOk', { tempo: text(valid ? n : 15) }))}>
          <span className="switch__knob" /><span className="switch__txt">{on ? t('conta.trava.ligada') : t('conta.trava.desligada')}</span>
        </button>
      </header>
      {on ? (
        <div className="row row--wrap">
          <label className="field field--inline">{tn('conta.trava.depoisDe', {
            campo: (
              <>
                <input type="number" min={1} max={unit === 'h' ? 24 : 1440} step={unit === 'h' ? 0.5 : 1} value={value} disabled={!owner} onChange={(e) => setValue(e.target.value)} style={{ width: 80 }} />
                <select value={unit} disabled={!owner} onChange={(e) => setUnit(e.target.value as 'min' | 'h')}>
                  <option value="min">{t('conta.trava.minutos')}</option><option value="h">{t('conta.trava.horas')}</option>
                </select>
              </>
            ),
          })}</label>
          <button className="btn btn--sm" disabled={!owner || busy || !valid || n === minutes} onClick={() => onSave(n, t('conta.trava.ajustadaOk', { tempo: text(n) }))}>{t('conta.acao.salvar')}</button>
          {!valid && <span className="hint warn">{t('conta.trava.limites')}</span>}
        </div>
      ) : (
        <p className="muted">{t('conta.trava.desligadaTexto')}</p>
      )}
      <p className="hint">{t('conta.trava.dica')}</p>
    </section>
  );
}

/**
 * Chaves, senhas e tokens que a equipe pediu e você informou num cartão protegido: só os nomes (o valor nunca volta à
 * tela), para quê e quando; apagar tira do cofre da equipe. A senha de administrador guardada aparece aqui também.
 */
function ChavesDaEquipe() {
  const t = useT();
  const r = useResource<{ disponivel: boolean; sudo: boolean; chaves: Array<{ nome: string; motivo: string; quando: string; agente: string }> }>('/api/seguranca/chaves', ['audit.created']);
  const [apagar, setApagar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const x = r.data;
  const confirmar = async () => {
    const nome = apagar; if (!nome) return;
    setBusy(true); setErr(null);
    try { await api.del(`/api/seguranca/chaves/${nome}`); setApagar(null); r.reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h3>{t('conta.chaves.titulo')}</h3>
      <p className="muted small">{t('conta.chaves.texto')}</p>
      {!x ? <p className="muted small">{r.error ?? t('conta.chaves.lendo')}</p>
        : !x.disponivel ? <p className="hint small">{t('conta.chaves.indisponivel')}</p>
        : !x.chaves.length && !x.sudo ? <p className="muted small">{t('conta.chaves.nenhuma')}</p>
        : (
          <ul className="sec-rows">
            {x.chaves.map((c) => (
              <li key={c.nome}><b className="mono">{c.nome}</b>
                <span className="muted small">{[c.motivo, c.agente && t('conta.chaves.pedidaPor', { nome: c.agente }), c.quando && fmtDataHora(c.quando)].filter(Boolean).join(' · ')}</span>
                <button className="btn btn--sm btn--ghost" onClick={() => setApagar(c.nome)}><Icon name="trash" size={13} /> {t('conta.chaves.apagar')}</button>
              </li>
            ))}
            {x.sudo && (
              <li><b>{t('conta.chaves.sudo')}</b><span className="muted small">{t('conta.chaves.sudoTexto')}</span>
                <button className="btn btn--sm btn--ghost" onClick={() => setApagar('SUDO_PASSWORD')}><Icon name="trash" size={13} /> {t('conta.chaves.apagar')}</button>
              </li>
            )}
          </ul>
        )}
      {apagar && (
        <ConfirmPopup title={apagar === 'SUDO_PASSWORD' ? t('conta.chaves.apagarSudoTitulo') : t('conta.chaves.apagarTitulo', { nome: apagar })} confirmLabel={busy ? t('conta.chaves.apagando') : t('conta.chaves.apagar')}
          onConfirm={() => void confirmar()} onCancel={() => setApagar(null)}>
          <p>{t('conta.chaves.apagarCorpo')}</p>
        </ConfirmPopup>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

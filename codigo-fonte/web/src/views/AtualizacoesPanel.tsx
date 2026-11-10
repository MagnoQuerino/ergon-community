import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { inDesktopApp, rollbackInDesktopApp } from '../lib/desktop.ts';
import { anteriores, textoVersoesAnteriores, voltaNaLista } from '../lib/atualizacoes.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import type { VersionInfo } from '../lib/types.ts';
import { fmtData, fmtDataHora, tn, useT } from '../i18n/index.ts';

const dia = (iso: string | null) => (iso ? fmtData(iso, { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * Configurações › Atualizações: a versão instalada, "Verificar agora", atualizar (no Ergon Desktop, a tela do aplicativo
 * que atualiza com backup e volta sozinha se der errado; fora dele, a página da versão), o aviso ao abrir o Ergon
 * (ligado por padrão) e as versões anteriores (no Ergon Desktop, só as duas publicadas logo antes da instalada), com o aviso de que voltar
 * pode estragar dados criados na mais nova. No
 * Ergon Desktop do Windows (com o ambiente próprio), para quem administra, cada versão anterior com o pacote assinado
 * ganha "Voltar para esta versão" (a tela do aplicativo confere, avisa, pede a confirmação e faz o backup antes); nos
 * outros casos, a página da versão.
 */
export function AtualizacoesPanel({ admin }: { admin: boolean }) {
  const t = useT();
  const v = useResource<VersionInfo>('/api/version', []);
  const prefs = usePrefs();
  const desktop = inDesktopApp();
  const voltaPeloApp = rollbackInDesktopApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [backup, setBackup] = useState<{ busy: boolean; text: string | null; err: boolean }>({ busy: false, text: null, err: false });
  const [voltar, setVoltar] = useState(false);
  if (!v.data) return null;
  const d = v.data;

  const verificar = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.get<VersionInfo>('/api/version?verificar=1');
      setMsg(r.updateAvailable && r.latest ? null : r.latest ? { kind: 'ok', text: t('configuracoes.atual.maisRecente') }
        : { kind: 'error', text: r.configured ? t('configuracoes.atual.semConsulta') : t('configuracoes.atual.naoConsulta') });
      v.reload();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const fazerBackup = async () => {
    setBackup({ busy: true, text: null, err: false });
    try {
      await api.post('/api/admin/backup');
      setBackup({ busy: false, err: false, text: t('configuracoes.atual.backupFeito') });
    } catch (e) { setBackup({ busy: false, err: true, text: errMsg(e) }); }
  };
  const nova = d.updateAvailable && d.latest ? d.latest : null;
  const teste = d.version.includes('-');
  const canal = teste ? t('configuracoes.atual.canalTeste') : t('configuracoes.atual.canalEstavel');

  return (
    <>
      <section className="card">
        <h3>{t('configuracoes.atual.titulo')}</h3>
        <p>{d.build !== 'dev'
          ? tn('configuracoes.atual.linhaBuild', { versao: <b>{d.version}</b>, build: d.build, canal })
          : tn('configuracoes.atual.linha', { versao: <b>{d.version}</b>, canal })}
          {d.checkedAt ? <span className="muted"> · {t('configuracoes.atual.consultado', { quando: fmtDataHora(d.checkedAt) })}</span> : null}</p>
        {nova ? (
          <div className="upd-new">
            <p><b>{t('configuracoes.atual.novaDisponivel', { versao: nova.version })}</b> {desktop ? t('configuracoes.atual.novaDesktop') : t('configuracoes.atual.novaWeb')}</p>
            {nova.notes && <details><summary>{t('configuracoes.atual.oQueMudou')}</summary><pre className="upd-notes">{nova.notes}</pre></details>}
            <div className="row">
              {desktop
                ? <button className="btn btn--primary" onClick={() => { location.href = '/__desktop/atualizacoes'; }}>{t('configuracoes.atual.atualizarAgora')}</button>
                : nova.url && <a className="btn btn--primary" href={nova.url} target="_blank" rel="noreferrer noopener">{t('configuracoes.atual.baixarVersao', { versao: nova.version })}</a>}
            </div>
          </div>
        ) : null}
        <div className="row">
          <button className="btn" onClick={() => void verificar()}>{busy ? t('configuracoes.atual.verificando') : t('configuracoes.atual.verificar')}</button>
        </div>
        {msg && <p className={msg.kind === 'ok' ? 'ok' : 'error'} role="status">{msg.text}</p>}
      </section>

      <section className="card">
        <div className="row sec-toggle">
          <h3>{t('configuracoes.atual.avisoTitulo')}</h3>
          <button role="switch" aria-checked={prefs.updateNotice} aria-label={t('configuracoes.atual.avisoAria')} className={`switch ${prefs.updateNotice ? 'switch--on' : ''}`}
            onClick={() => savePrefs({ updateNotice: !prefs.updateNotice })}>
            <span className="switch__knob" /><span className="switch__txt">{prefs.updateNotice ? t('configuracoes.comum.ligado') : t('configuracoes.comum.desligado')}</span>
          </button>
        </div>
        {prefs.updateNotice
          ? <p>{t('configuracoes.atual.avisoLigado')}</p>
          : <p>{t('configuracoes.atual.avisoDesligado')}</p>}
      </section>

      <section className="card">
        <h3>{t('configuracoes.atual.voltarTitulo')}</h3>
        <p>{tn('configuracoes.atual.voltarTexto', { atencao: <b>{t('configuracoes.atual.atencao')}</b> })}</p>
        {admin && (
          <div className="row">
            <button className="btn" onClick={() => void fazerBackup()}>{backup.busy ? t('configuracoes.atual.fazendoBackup') : t('configuracoes.comum.fazerBackup')}</button>
          </div>
        )}
        {backup.text && <p className={backup.err ? 'error' : 'ok'} role="status">{backup.text}</p>}
        {!voltar ? (
          <div className="row"><button className="btn" onClick={() => { setVoltar(true); if (!d.previous?.length) void verificar(); }}>{t('configuracoes.atual.verAnteriores')}</button></div>
        ) : d.previous && d.previous.length > 0 ? (
          <>
            <p className="muted small">{textoVersoesAnteriores({ app: voltaPeloApp, admin })}</p>
            <ul className="upd-list">
              {anteriores(d.previous, voltaPeloApp).map((r) => {
                const volta = voltaNaLista(r, { app: voltaPeloApp, admin });
                return (
                  <li key={r.version}>
                    <span><b>{r.version}</b>{r.prerelease ? ` · ${t('configuracoes.atual.preVersao')}` : ''}{r.publishedAt ? <span className="muted"> · {dia(r.publishedAt)}</span> : null}
                      {volta.nota && <span className="muted small upd-nota">{volta.nota}</span>}</span>
                    <span className="row upd-acoes">
                      {volta.voltar && <button className="btn btn--sm" onClick={() => { location.href = volta.voltar!; }}>{t('configuracoes.atual.voltarBotao')}</button>}
                      {r.url && <a className="btn btn--sm" href={r.url} target="_blank" rel="noreferrer noopener">{t('configuracoes.atual.paginaDaVersao')}</a>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : <p className="muted">{busy ? t('configuracoes.atual.consultando') : t('configuracoes.atual.semLista')}</p>}
      </section>
    </>
  );
}

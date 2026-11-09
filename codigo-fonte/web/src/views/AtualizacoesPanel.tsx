import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { inDesktopApp, rollbackInDesktopApp } from '../lib/desktop.ts';
import { anteriores, textoVersoesAnteriores, voltaNaLista } from '../lib/atualizacoes.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import type { VersionInfo } from '../lib/types.ts';

const dia = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

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
      setMsg(r.updateAvailable && r.latest ? null : r.latest ? { kind: 'ok', text: 'Você está na versão mais recente.' }
        : { kind: 'error', text: r.configured ? 'Não deu para consultar as versões agora (sem internet?). Tente de novo daqui a pouco.' : 'Esta instalação não consulta versões novas (cópia do código: atualiza pelo próprio código).' });
      v.reload();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const fazerBackup = async () => {
    setBackup({ busy: true, text: null, err: false });
    try {
      await api.post('/api/admin/backup');
      setBackup({ busy: false, err: false, text: 'Backup feito e conferido. Ele fica com a instalação e o lançador copia para a pasta de backups do computador.' });
    } catch (e) { setBackup({ busy: false, err: true, text: errMsg(e) }); }
  };
  const nova = d.updateAvailable && d.latest ? d.latest : null;
  const teste = d.version.includes('-');

  return (
    <>
      <section className="card">
        <h3>Versão instalada</h3>
        <p>Ergon <b>{d.version}</b>{d.build !== 'dev' ? ` (${d.build})` : ''} · {teste ? 'canal de teste (pré-versões)' : 'canal estável'}
          {d.checkedAt ? <span className="muted"> · consultado em {new Date(d.checkedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span> : null}</p>
        {nova ? (
          <div className="upd-new">
            <p><b>Versão {nova.version} disponível.</b> {desktop ? 'A atualização faz um backup dos dados antes e, se a versão nova não responder, volta sozinha para esta.' : 'Baixe o instalador na página da versão e instale por cima desta; seus dados ficam.'}</p>
            {nova.notes && <details><summary>O que mudou</summary><pre className="upd-notes">{nova.notes}</pre></details>}
            <div className="row">
              {desktop
                ? <button className="btn btn--primary" onClick={() => { location.href = '/__desktop/atualizacoes'; }}>Atualizar agora</button>
                : nova.url && <a className="btn btn--primary" href={nova.url} target="_blank" rel="noreferrer noopener">Baixar a versão {nova.version}</a>}
            </div>
          </div>
        ) : null}
        <div className="row">
          <button className="btn" onClick={() => void verificar()}>{busy ? 'Verificando…' : 'Verificar agora'}</button>
        </div>
        {msg && <p className={msg.kind === 'ok' ? 'ok' : 'error'} role="status">{msg.text}</p>}
      </section>

      <section className="card">
        <div className="row sec-toggle">
          <h3>Avisar quando sair versão nova</h3>
          <button role="switch" aria-checked={prefs.updateNotice} aria-label="Procurar versão nova ao abrir o Ergon" className={`switch ${prefs.updateNotice ? 'switch--on' : ''}`}
            onClick={() => savePrefs({ updateNotice: !prefs.updateNotice })}>
            <span className="switch__knob" /><span className="switch__txt">{prefs.updateNotice ? 'Ligado' : 'Desligado'}</span>
          </button>
        </div>
        {prefs.updateNotice
          ? <p>Ligado: ao abrir, o aplicativo consulta a página de versões e, se houver uma nova, mostra “Atualização disponível” no alto da tela. Nenhum dado seu vai junto.</p>
          : <p>Desligado: versão nova só é procurada quando você clica em “Verificar agora”.</p>}
      </section>

      <section className="card">
        <h3>Voltar para uma versão anterior</h3>
        <p>Use só se a versão nova trouxe um problema que atrapalha o seu trabalho. <b>Atenção:</b> o que foi criado ou mudado na versão
          mais nova pode não abrir, ou abrir com defeito, na anterior. Faça um backup antes.</p>
        {admin && (
          <div className="row">
            <button className="btn" onClick={() => void fazerBackup()}>{backup.busy ? 'Fazendo backup…' : 'Fazer backup agora'}</button>
          </div>
        )}
        {backup.text && <p className={backup.err ? 'error' : 'ok'} role="status">{backup.text}</p>}
        {!voltar ? (
          <div className="row"><button className="btn" onClick={() => { setVoltar(true); if (!d.previous?.length) void verificar(); }}>Ver versões anteriores</button></div>
        ) : d.previous && d.previous.length > 0 ? (
          <>
            <p className="muted small">{textoVersoesAnteriores({ app: voltaPeloApp, admin })}</p>
            <ul className="upd-list">
              {anteriores(d.previous, voltaPeloApp).map((r) => {
                const volta = voltaNaLista(r, { app: voltaPeloApp, admin });
                return (
                  <li key={r.version}>
                    <span><b>{r.version}</b>{r.prerelease ? ' · pré-versão' : ''}{r.publishedAt ? <span className="muted"> · {dia(r.publishedAt)}</span> : null}
                      {volta.nota && <span className="muted small upd-nota">{volta.nota}</span>}</span>
                    <span className="row upd-acoes">
                      {volta.voltar && <button className="btn btn--sm" onClick={() => { location.href = volta.voltar!; }}>Voltar para esta versão</button>}
                      {r.url && <a className="btn btn--sm" href={r.url} target="_blank" rel="noreferrer noopener">Página da versão</a>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : <p className="muted">{busy ? 'Consultando…' : 'A lista de versões ainda não veio. Clique em “Verificar agora”.'}</p>}
      </section>
    </>
  );
}

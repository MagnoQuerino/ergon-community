/**
 * Termos de uso: o texto (legal/termos.ts), aberto pelo link na criação da conta, e o aviso que aparece uma vez para quem
 * já usava o Ergon quando a versão muda (aceitar grava a versão no servidor; com o aceite, Executar código e Terminal
 * vêm ligados na equipe).
 */
import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useIdioma, useT } from '../i18n/index.ts';
import { termosEm } from '../legal/termos.ts';

export function TextoDosTermos() {
  const termos = termosEm(useIdioma());
  return (
    <div className="termos">
      <p className="termos__resumo">{termos.resumo}</p>
      {termos.secoes.map((s) => (
        <section key={s.titulo}>
          <h3>{s.titulo}</h3>
          {s.paragrafos.map((p, i) => <p key={i}>{p}</p>)}
        </section>
      ))}
    </div>
  );
}

/** Só leitura (o link "Termos de uso" na conta nova e na Ajuda). */
export function TermosDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const termos = termosEm(useIdioma());
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="termos-titulo" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="auth__card termos__card">
        <h2 className="auth__title" id="termos-titulo">{termos.titulo}</h2>
        <TextoDosTermos />
        <button className="btn btn--primary btn--block" autoFocus onClick={onClose}>{t('conta.termos.fechar')}</button>
      </div>
    </div>
  );
}

/** Quem já usava: a versão nova dos termos, uma vez, antes de seguir. */
export function AceiteDosTermos({ versao, onDone }: { versao: string; onDone: () => void }) {
  const t = useT();
  const termos = termosEm(useIdioma());
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const aceitar = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/api/me/termos', { versao }); onDone(); } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  return (
    <div className="lock lock--dialog" role="dialog" aria-modal="true" aria-labelledby="termos-aceite">
      <div className="auth__card termos__card">
        <h2 className="auth__title" id="termos-aceite">{t('conta.termos.novosTitulo')}</h2>
        <p className="hint">{t('conta.termos.novosSub')}</p>
        <h3>{termos.titulo}</h3>
        <TextoDosTermos />
        <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {t('conta.termos.liAceito')}</label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--block" disabled={!ok || busy} onClick={() => void aceitar()}>{t('conta.termos.aceitar')}</button>
      </div>
    </div>
  );
}

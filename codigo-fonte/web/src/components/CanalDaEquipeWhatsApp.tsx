/**
 * Conexões › WhatsApp (o cartão aberto de um número) › "Usar este número como canal da equipe": o número pareado vira o
 * canal da equipe. Cada membro do workspace pode ter o seu WhatsApp ligado: digita-se o número, confirma-se com a senha, e o
 * membro manda, do próprio telefone, o código que aparece aqui. Daí em diante ele conversa com esse número como com
 * qualquer contato, como ele mesmo, com o papel dele no workspace (server/src/services/canais/whatsapp.ts e externo.ts).
 */
import { useState } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { comConta } from '../lib/contas.ts';
import { fmtDataHora, useT } from '../i18n/index.ts';

interface Remetente { telefone: string; membro: string; pausado: boolean; estado: 'ok' | 'pendente' | 'vencido'; desde: string; codigo?: string; expira?: string; link?: string | null; ultimaMensagem?: string }
interface Membro { userId: string; nome: string; papel: 'owner' | 'admin' | 'editor' | 'viewer' }
interface EstadoEquipe { disponivel: boolean; motivo?: string; ligado: boolean; numero: string | null; respondeDesconhecidos: boolean; membros: Membro[]; remetentes: Remetente[] }

export function CanalDaEquipeWhatsApp({ conta = '' }: { conta?: string }) {
  const t = useT();
  const st = useResource<EstadoEquipe>(comConta('/api/integrations/whatsapp/equipe', conta), ['canais.changed', 'integrations.changed']);
  const [tel, setTel] = useState('');
  const [membro, setMembro] = useState<string | null>(null);
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const e = st.data;
  if (!e) return null;
  const agir = async (fn: () => Promise<unknown>, depois?: () => void) => {
    setErr(null); setBusy(true);
    try { await fn(); depois?.(); st.reload(); } catch (x) {
      setErr(x instanceof ApiError && x.code === 'invalid_login' ? t('conexoes.canal.senhaIncorreta') : errMsg(x));
    } finally { setBusy(false); }
  };
  const base = conta ? { conta } : {};
  return (
    <div className="wa-equipe">
      <h4>{t('conexoes.wa.equipe.titulo')}</h4>
      <label className="check">
        <input type="checkbox" checked={e.ligado} disabled={busy || (!e.disponivel && !e.ligado)}
          onChange={(ev) => void agir(() => api.put('/api/integrations/whatsapp/equipe', { ...base, ligado: ev.target.checked }))} /> {t('conexoes.wa.equipe.usar')}
      </label>
      <p className="hint">{t('conexoes.wa.equipe.comoFunciona')}</p>
      {!e.disponivel && !e.ligado && e.motivo === 'riscos' && <p className="hint">{t('conexoes.wa.equipe.antesRiscos')}</p>}
      {e.ligado && <>
        <p className="small">{t('conexoes.wa.equipe.liberados')}</p>
        <ul className="wa-equipe__lista small">
          {e.membros.map((m) => {
            const dele = e.remetentes.filter((r) => r.membro === m.userId);
            return (
              <li key={m.userId}>
                <b>{m.nome}</b> <span className="muted">· {t(`conexoes.wa.equipe.papel.${m.papel}`)}</span>
                {dele.map((r) => (
                  <div key={r.telefone}>
                    {t('conexoes.wa.equipe.whatsapp')} {r.telefone}{' '}
                    {r.pausado ? <span className="badge badge--warn">{t('conexoes.wa.equipe.pausado')}</span>
                      : r.estado === 'ok' ? <span className="badge badge--ok">{t('conexoes.wa.equipe.confirmado')}</span>
                      : r.estado === 'pendente' ? <span className="badge badge--warn">{t('conexoes.wa.equipe.aguardando')}</span>
                      : <span className="badge">{t('conexoes.wa.equipe.vencido')}</span>}
                    {r.ultimaMensagem && <span className="muted"> {t('conexoes.wa.equipe.ultima', { quando: fmtDataHora(r.ultimaMensagem) })}</span>}
                    {' '}<button className="link link--inline" disabled={busy} onClick={() => void agir(() => api.post('/api/integrations/whatsapp/equipe/remetentes/tirar', { ...base, telefone: r.telefone }))}>{t('conexoes.wa.equipe.revogar')}</button>
                    {r.estado === 'pendente' && r.codigo && (
                      <p className="hint">
                        {t('conexoes.wa.equipe.mandeCodigo', { numero: e.numero ?? '' })} <b>{r.codigo}</b>
                        {r.link && <> · <a href={r.link} target="_blank" rel="noreferrer noopener">{t('conexoes.wa.equipe.abrirNoWhatsApp')}</a></>}
                      </p>
                    )}
                  </div>
                ))}
                {membro === m.userId
                  ? <form className="row row--wrap" onSubmit={(ev) => { ev.preventDefault(); void agir(() => api.post('/api/integrations/whatsapp/equipe/remetentes', { ...base, telefone: tel, membro: m.userId, password: senha }), () => { setTel(''); setSenha(''); setMembro(null); }); }}>
                      <input value={tel} onChange={(ev) => setTel(ev.target.value)} placeholder={t('conexoes.wa.equipe.telefoneExemplo')} aria-label={t('conexoes.wa.equipe.telefone')} inputMode="tel" maxLength={40} />
                      <input type="password" autoComplete="current-password" placeholder={t('conexoes.canal.suaSenha')} aria-label={t('conexoes.canal.suaSenha')} value={senha} onChange={(ev) => setSenha(ev.target.value)} />
                      <button className="btn btn--sm" disabled={busy || !senha || tel.replace(/\D/g, '').length < 8}>{t('conexoes.wa.equipe.liberar')}</button>
                    </form>
                  : <> <button className="link link--inline" onClick={() => { setMembro(m.userId); setTel(''); setSenha(''); }}>{t('conexoes.wa.equipe.adicionar')}</button></>}
              </li>
            );
          })}
        </ul>
        <p className="hint">{t('conexoes.wa.equipe.travas')}</p>
        <label className="check">
          <input type="checkbox" checked={e.respondeDesconhecidos} disabled={busy}
            onChange={(ev) => void agir(() => api.put('/api/integrations/whatsapp/equipe', { ...base, ligado: true, respondeDesconhecidos: ev.target.checked }))} /> {t('conexoes.wa.equipe.responderOutros')}
        </label>
      </>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

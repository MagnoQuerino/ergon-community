import { useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

export type PrazoAcesso = '24h' | '7d' | 'sempre';
const PRAZOS: PrazoAcesso[] = ['24h', '7d', 'sempre']; // i18n-ok: códigos do prazo (o texto vem do dicionário)
/** GET /api/acesso-total */
export interface EstadoAcesso { ativo: boolean; ate: string | null; proibido: boolean; administra: boolean }
export const useAcessoTotal = () => useResource<EstadoAcesso>('/api/acesso-total', ['agents.changed', 'integrations.changed']);

/**
 * "Ativar acesso total?" (rc.49): um cartão só, em todo lugar que liga o acesso total (Controle do computador, Liberar tudo,
 * o pedido de um agente, o perfil do agente). A senha uma vez e o prazo (24 horas, 7 dias ou sempre): a equipe toda passa
 * a usar Terminal, código, computador e Discord, e o computador de quem ativou fica em acesso total pelo mesmo prazo.
 * Quem não administra o workspace liga só o próprio computador, também com a senha.
 */
export function AtivarAcessoTotal({ agente, administra = true, semAviso: jaSemAviso = false, onCancelar, onFeito }: {
  /** o agente que pediu (o texto diz quem quer) */ agente?: string | null;
  administra?: boolean; semAviso?: boolean; onCancelar: () => void; onFeito: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: onCancelar, modal: true, outside: true });
  const [senha, setSenha] = useState('');
  const [prazo, setPrazo] = useState<PrazoAcesso>('24h');
  const [semAviso, setSemAviso] = useState(jaSemAviso);
  const [ocupado, setOcupado] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ativar = async () => {
    if (ocupado || !senha) return;
    setOcupado(true); setErr(null);
    try {
      await api.post('/api/session/unlock', { password: senha });
      if (administra) await api.post('/api/acesso-total', { prazo, ...(semAviso ? { semAviso: true } : {}) });
      else await api.put('/api/computador/modo', { modo: 'total' });
      onFeito();
    } catch (x) { setErr(errMsg(x)); setOcupado(false); }
  };
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg liberar-dlg pc-cartao" role="alertdialog" aria-modal="true" aria-labelledby="acesso-t" aria-describedby="acesso-d">
        <div className="pc-cartao__arte" aria-hidden="true"><span className="pc-cartao__tela"><Icon name="monitor" size={34} /></span></div>
        <h3 id="acesso-t">{t('conexoes.acesso.titulo')}</h3>
        <form className="acesso" onSubmit={(x) => { x.preventDefault(); void ativar(); }}>
          <p id="acesso-d">{agente ? t('geral.computador.ativarTexto', { nome: agente }) : t('conexoes.acesso.equipe')}</p>
          <p className="pc-cartao__garantia"><Icon name="shield-check" size={14} /> {t('geral.computador.ativarGarantia')}</p>
          {administra && (
            <fieldset className="acesso__prazo">
              <legend>{t('conexoes.acesso.prazo')}</legend>
              <div className="seg" role="radiogroup" aria-label={t('conexoes.acesso.prazo')}>
                {PRAZOS.map((p) => <button key={p} type="button" role="radio" aria-checked={prazo === p} className={prazo === p ? 'is-on' : ''} onClick={() => setPrazo(p)}>{t(`conexoes.acesso.prazo.${p}`)}</button>)}
              </div>
            </fieldset>
          )}
          <label className="field"><span>{t('conexoes.acesso.senha')}</span>
            <input type="password" autoComplete="current-password" data-autofocus autoFocus value={senha} onChange={(x) => setSenha(x.target.value)} /></label>
          {administra && <label className="check"><input type="checkbox" checked={semAviso} onChange={(x) => setSemAviso(x.target.checked)} /> {t('conexoes.liberar.naoPerguntar')}</label>}
          {err && <p className="error" role="alert">{err}</p>}
          <footer className="dlg__foot">
            <button type="button" className="btn btn--ghost" onClick={onCancelar}>{t('conexoes.acao.cancelar')}</button>
            <button type="submit" className="btn btn--gold" aria-busy={ocupado} disabled={ocupado || !senha}>{t('conexoes.acesso.ativar')}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

/** O botão "Ativar acesso total" com o cartão (perfil do agente, Ferramentas da equipe); ligado, mostra até quando vale. */
export function BotaoAcessoTotal() {
  const t = useT();
  const e = useAcessoTotal();
  const [aberto, setAberto] = useState(false);
  const x = e.data;
  if (!x || x.proibido || !x.administra) return null;
  if (x.ativo) {
    return (
      <span className="acesso-selo" role="status"><Icon name="shield-check" size={14} />
        {x.ate ? t('conexoes.acesso.ate', { quando: new Date(x.ate).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) }) : t('conexoes.acesso.ligado')}
        <button type="button" className="linkish small" onClick={() => void api.del('/api/acesso-total').then(() => e.reload())}>{t('conexoes.acesso.desligar')}</button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="btn btn--sm btn--gold" onClick={() => setAberto(true)}><Icon name="key" size={13} /> {t('conexoes.acesso.botao')}</button>
      {aberto && <AtivarAcessoTotal onCancelar={() => setAberto(false)} onFeito={() => { setAberto(false); e.reload(); }} />}
    </>
  );
}

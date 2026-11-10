import { useState } from 'react';
import { errMsg, nomeDoAnexo, postForFile, salvarArquivo } from '../lib/api.ts';
import { TEXTO_BAIXAR_DADOS, textoBaixado } from '../lib/textos-tela.ts';
import { useT } from '../i18n/index.ts';

/**
 * "Baixar meus dados": o ZIP legível com o que é da pessoa. Se a identidade não foi confirmada há pouco, a tela pede a
 * senha (ou a passkey) e o pedido segue sozinho depois, como na exclusão da conta.
 */
export function BaixarMeusDados({ texto = true }: { texto?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const baixar = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const { blob, headers } = await postForFile('/api/me/export', {});
      salvarArquivo(blob, nomeDoAnexo(headers.get('content-disposition'), 'meus-dados-ergon.zip'));
      setMsg({ kind: 'ok', text: textoBaixado(Number(headers.get('x-ergon-de-fora') ?? 0) || 0) });
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="baixar-dados">
      {texto && <p className="muted small">{TEXTO_BAIXAR_DADOS}</p>}
      <button type="button" className="btn btn--sm" aria-busy={busy} onClick={() => void baixar()}>{busy ? t('conta.baixar.montando') : t('conta.baixar.botao')}</button>
      {msg && <p className={`small ${msg.kind === 'error' ? 'error' : 'ok'}`} role="status">{msg.text}</p>}
    </div>
  );
}

import { useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { AtivarAcessoTotal } from './AcessoTotal.tsx';

/** GET /api/conexoes (o que esta peça usa) */
export interface EstadoLiberar { liberarTudo: boolean; liberarTudoMeu?: boolean; liberarTudoProibido?: boolean; liberarTudoSemAviso?: boolean; administra?: boolean }

/**
 * "Liberar tudo" (rc.42), em Conexões › Regras: o interruptor da pessoa (vale nos pedidos dela) e, para quem administra,
 * valer para o workspace inteiro e proibir o modo. Ligar pede uma confirmação de uma linha, com "Não perguntar novamente";
 * as sempre-protegidas (apagar de vez, apagar repositório, segredos, pagamentos) continuam pedindo — os detalhes ficam na
 * Ajuda. O interruptor brilha em alerta enquanto ligado (o visual diz o estado; respeita prefers-reduced-motion).
 */
export function ModoLiberarTudo({ estado, onMudou }: { estado: EstadoLiberar | null; onMudou: () => void }) {
  const t = useT();
  const [pergunta, setPergunta] = useState<null | 'meu' | 'workspace'>(null);
  const [ocupado, setOcupado] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const e = estado;
  const proibido = !!e?.liberarTudoProibido;
  const meu = !!e?.liberarTudoMeu || !!e?.liberarTudo;
  const enviar = async (rota: string, on: boolean, semAviso?: boolean) => {
    setOcupado(true); setErr(null);
    try { await api.put(rota, { on, ...(semAviso ? { semAviso: true } : {}) }); onMudou(); } catch (x) { setErr(errMsg(x)); } finally { setOcupado(false); }
  };
  // quem administra liga pelo cartão "Ativar acesso total?" (a senha uma vez libera o Terminal e o resto à equipe
  // inteira); quem não administra liga só o "Liberar tudo" dos próprios pedidos
  const ligar = (qual: 'meu' | 'workspace') => (e?.liberarTudoSemAviso && !(qual === 'meu' && e?.administra) ? void enviar(qual === 'meu' ? '/api/conexoes/liberar-tudo/meu' : '/api/conexoes/liberar-tudo', true) : setPergunta(qual));
  // desligar o interruptor desliga o meu; o do workspace (quando quem administra ligou) sai pela caixa dele
  const desligarMeu = async () => {
    // quem administra ligou pelo "Ativar acesso total?": desligar o interruptor desliga também o acesso total da equipe
    if (e?.administra) { try { await api.del('/api/acesso-total'); } catch { /* o estado relido mostra como ficou */ } }
    await enviar(e?.liberarTudoMeu ? '/api/conexoes/liberar-tudo/meu' : '/api/conexoes/liberar-tudo', false);
  };
  const trocarMeu = () => (meu ? void desligarMeu() : ligar('meu'));
  return (
    <div className={`liberar${meu ? ' liberar--on' : ''}`}>
      <div className="row sec-toggle">
        <strong id="liberar-t">{t('conexoes.liberar.titulo')}</strong>
        <button role="switch" aria-checked={meu} aria-labelledby="liberar-t" className={`switch ${meu ? 'switch--on switch--alerta' : ''}`} disabled={!e || ocupado || proibido || (!!e.liberarTudo && !e.administra)} onClick={trocarMeu}>
          <span className="switch__knob" /><span className="switch__txt">{meu ? t('conexoes.liberar.ligado') : t('conexoes.liberar.desligado')}</span>
        </button>
      </div>
      {meu && <p className="warn small" role="status">{t('conexoes.liberar.aviso')}</p>}
      {proibido && <p className="muted small">{t('conexoes.liberar.proibidoTexto')}</p>}
      {e?.administra && (
        <div className="liberar__adm">
          <label className="check"><input type="checkbox" checked={!!e.liberarTudo} disabled={ocupado || proibido}
            onChange={(x) => (x.target.checked ? ligar('workspace') : void enviar('/api/conexoes/liberar-tudo', false))} /> {t('conexoes.liberar.todos')}</label>
          <label className="check"><input type="checkbox" checked={proibido} disabled={ocupado} onChange={(x) => void enviar('/api/conexoes/liberar-tudo/proibir', x.target.checked)} /> {t('conexoes.liberar.proibir')}</label>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {pergunta === 'meu' && e?.administra && <AtivarAcessoTotal semAviso={!!e.liberarTudoSemAviso} onCancelar={() => setPergunta(null)} onFeito={() => { setPergunta(null); onMudou(); }} />}
      {pergunta && !(pergunta === 'meu' && e?.administra) && <ConfirmarLiberar ocupado={ocupado} onCancelar={() => setPergunta(null)}
        onLigar={async (semAviso) => { await enviar(pergunta === 'meu' ? '/api/conexoes/liberar-tudo/meu' : '/api/conexoes/liberar-tudo', true, semAviso); setPergunta(null); }} />}
    </div>
  );
}

function ConfirmarLiberar({ ocupado, onCancelar, onLigar }: { ocupado: boolean; onCancelar: () => void; onLigar: (semAviso: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: onCancelar, modal: true, outside: true });
  const [semAviso, setSemAviso] = useState(false);
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg liberar-dlg" role="alertdialog" aria-modal="true" aria-labelledby="liberar-dlg-t" aria-describedby="liberar-dlg-d">
        <header className="dlg__head"><h3 id="liberar-dlg-t">{t('conexoes.liberar.perguntaTitulo')}</h3></header>
        <p id="liberar-dlg-d">{t('conexoes.liberar.aviso')}</p>
        <p className="muted small">{t('conexoes.liberar.sempre')}</p>
        <label className="check"><input type="checkbox" checked={semAviso} onChange={(x) => setSemAviso(x.target.checked)} /> {t('conexoes.liberar.naoPerguntar')}</label>
        <footer className="dlg__foot">
          <button type="button" className="btn btn--ghost" onClick={onCancelar}>{t('conexoes.acao.cancelar')}</button>
          <button type="button" className="btn btn--danger" data-autofocus autoFocus aria-busy={ocupado} disabled={ocupado} onClick={() => onLigar(semAviso)}>{t('conexoes.liberar.confirmar')}</button>
        </footer>
      </section>
    </div>
  );
}

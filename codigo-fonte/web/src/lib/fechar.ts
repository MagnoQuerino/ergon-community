/**
 * Fechar a janela do Ergon Desktop (rc.40). O aplicativo não fecha direto quando a página do Ergon está aberta: chama
 * `window.__ergonFechar()`, e a página responde por endereços que o aplicativo atende sem sair da tela:
 *  - "/__desktop/fechar/espera": a página mostrou um aviso (a pessoa decide; o aplicativo espera);
 *  - "/__desktop/fechar/encerrando": a tela "Encerrando" está pondo tudo num ponto seguro (o aplicativo espera até 60 s);
 *  - "/__desktop/fechar/cancelar": a pessoa ficou no Ergon;
 *  - "/__desktop/fechar/sair": pode fechar.
 * Quem precisa segurar o fechamento (a sincronia com o Ergon World) se registra com `guardarFechar()` e ouve
 * EVENTO_FECHAR; sem ninguém registrado, fecha na hora. Página que não responde em 4 s: o aplicativo fecha mesmo assim.
 */
import { fecharInDesktopApp } from './desktop.ts';

export const FECHAR = {
  espera: '/__desktop/fechar/espera',
  encerrando: '/__desktop/fechar/encerrando',
  cancelar: '/__desktop/fechar/cancelar',
  sair: '/__desktop/fechar/sair',
} as const;
export const EVENTO_FECHAR = 'ergon:fechar';

let guardas = 0;

/** Registra quem decide o fechamento (devolve o "sair do registro"). */
export function guardarFechar(): () => void {
  guardas++;
  let feito = false;
  return () => { if (!feito) { feito = true; guardas--; } };
}

/** Pede ao aplicativo (o endereço nunca chega ao servidor e a página continua onde está). */
export function avisarApp(pedido: (typeof FECHAR)[keyof typeof FECHAR]): void {
  location.href = pedido;
}

export function instalarFechar(): void {
  if (!fecharInDesktopApp()) return;
  (window as unknown as { __ergonFechar?: () => void }).__ergonFechar = () => {
    if (guardas > 0) window.dispatchEvent(new CustomEvent(EVENTO_FECHAR));
    else avisarApp(FECHAR.sair);
  };
}

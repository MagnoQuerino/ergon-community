/**
 * O Ergon aberto dentro do Ergon Desktop: o aplicativo carrega a página com "?app=desktop" (e "&volta=1" quando voltar
 * de versão pelo próprio aplicativo vale ali: Windows com o ambiente próprio). Guardado na sessão da aba (a navegação
 * interna troca o endereço). Só muda caminhos que levam às telas do aplicativo (atualizações, voltar de versão);
 * nenhuma permissão nativa vem com isso.
 */
const KEY = 'ergon.desktop';
const KEY_VOLTA = 'ergon.desktop.volta';
const KEY_DOWNLOADS = 'ergon.desktop.downloads';
const KEY_FECHAR = 'ergon.desktop.fechar';
const KEY_PASTAS = 'ergon.desktop.pastas';

export function rememberDesktopApp(): void {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('app') !== 'desktop') return;
    sessionStorage.setItem(KEY, '1');
    if (u.searchParams.get('volta') === '1') sessionStorage.setItem(KEY_VOLTA, '1');
    else sessionStorage.removeItem(KEY_VOLTA);
    if (u.searchParams.get('downloads') === '1') sessionStorage.setItem(KEY_DOWNLOADS, '1');
    else sessionStorage.removeItem(KEY_DOWNLOADS);
    if (u.searchParams.get('fechar') === '1') sessionStorage.setItem(KEY_FECHAR, '1');
    else sessionStorage.removeItem(KEY_FECHAR);
    if (u.searchParams.get('pastas') === '1') sessionStorage.setItem(KEY_PASTAS, '1');
    else sessionStorage.removeItem(KEY_PASTAS);
    u.searchParams.delete('app');
    u.searchParams.delete('volta');
    u.searchParams.delete('downloads');
    u.searchParams.delete('fechar');
    u.searchParams.delete('pastas');
    history.replaceState(history.state, '', u.pathname + (u.search === '?' ? '' : u.search) + u.hash);
  } catch { /* sem armazenamento: segue como navegador */ }
}

export function inDesktopApp(): boolean {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** No Ergon Desktop, voltar de versão é feito pelo próprio aplicativo aqui (o aplicativo disse, com "volta=1"). */
export function rollbackInDesktopApp(): boolean {
  try { return inDesktopApp() && sessionStorage.getItem(KEY_VOLTA) === '1'; } catch { return false; }
}

/**
 * rc.33: o aplicativo atende os pedidos de downloads (a pasta de downloads do Ergon, "Abrir pasta", "Mostrar arquivo"):
 * ele disse, com "downloads=1". Aplicativo de antes: a página não pede (o pedido sairia da tela para uma página que não existe).
 */
export function downloadsInDesktopApp(): boolean {
  try { return inDesktopApp() && sessionStorage.getItem(KEY_DOWNLOADS) === '1'; } catch { return false; }
}

/**
 * rc.40: o aplicativo pergunta à página antes de fechar a janela (lib/fechar.ts): ele disse, com "fechar=1". Aplicativo
 * de antes: fecha direto, como sempre.
 */
export function fecharInDesktopApp(): boolean {
  try { return inDesktopApp() && sessionStorage.getItem(KEY_FECHAR) === '1'; } catch { return false; }
}

/** rc.42: o aplicativo abre o seletor de pastas do sistema para Conexões › Pastas do computador ("pastas=1"). */
export function pastasInDesktopApp(): boolean {
  try { return inDesktopApp() && sessionStorage.getItem(KEY_PASTAS) === '1'; } catch { return false; }
}
export const PEDIDO_ESCOLHER_PASTA = '/__desktop/pastas/escolher';
export const EVENTO_PASTA_ESCOLHIDA = 'ergon:pasta-escolhida';

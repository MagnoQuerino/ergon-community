/**
 * O Ergon aberto dentro do Ergon Desktop: o aplicativo carrega a página com "?app=desktop". Guardado na sessão da aba
 * (a navegação interna troca o endereço). Só muda caminhos que levam às telas do aplicativo (atualizações); nenhuma
 * permissão nativa vem com isso.
 */
const KEY = 'ergon.desktop';

export function rememberDesktopApp(): void {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('app') !== 'desktop') return;
    sessionStorage.setItem(KEY, '1');
    u.searchParams.delete('app');
    history.replaceState(history.state, '', u.pathname + (u.search === '?' ? '' : u.search) + u.hash);
  } catch { /* sem armazenamento: segue como navegador */ }
}

export function inDesktopApp(): boolean {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

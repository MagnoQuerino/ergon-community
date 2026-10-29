import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { installElastic } from './lib/elastic.ts';
import { rememberDesktopApp } from './lib/desktop.ts';

// Ergon atualizado com a aba aberta: as partes antigas da interface somem do servidor. Recarrega uma vez para
// pegar a versão nova (sem laço: se falhar de novo em 30 s, deixa o erro aparecer).
addEventListener('vite:preloadError', (ev) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('ergon-reload') ?? 0); } catch { /* sem armazenamento */ }
  if (Date.now() - last < 30_000) return;
  try { sessionStorage.setItem('ergon-reload', String(Date.now())); } catch { /* sem armazenamento */ }
  ev.preventDefault();
  location.reload();
});

rememberDesktopApp();
installElastic();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

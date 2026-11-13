// Galeria dos cartões: página só de desenvolvimento (web/galeria.html, servida pelo vite; o build publica só o
// index.html). Mostra os cartões de verdade — a conversa, "Aguardando você" e o card aberto — com dados de exemplo.
//   /galeria.html?tema=escuro&largura=380&posts=pendentes&lang=en
//   tema: claro (padrão) | escuro · largura: ambas (padrão) | 380 | larga · posts: ok (padrão) | pendentes
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './galeria.css';
import { prepararIdioma, setIdioma } from '../i18n/index.ts';
import { simularServidor, type Registro } from './simular.ts';
import { Galeria } from './Galeria.tsx';

declare global { interface Window { __galeria?: Registro & { pronta: boolean } } }

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('tema') === 'escuro' ? 'dark' : 'light';
const registro = simularServidor(q.get('posts') === 'pendentes');
window.__galeria = Object.assign(registro, { pronta: false });
const largura = q.get('largura');

void prepararIdioma()
  .then(() => (q.get('lang') === 'en' ? setIdioma('en', { guardar: false }) : setIdioma('pt-BR', { guardar: false })))
  .then(() => createRoot(document.getElementById('root')!).render(<Galeria larguras={largura === '380' ? ['380'] : largura === 'larga' ? ['larga'] : ['larga', '380']} />));

// Galeria dos blocos visuais: página só de desenvolvimento (web/visuais.html, servida pelo vite).
//   /visuais.html?cena=galeria|hipatia|aspasia|relatorio|sala|discord&tema=claro|escuro&lang=en
import { createRoot } from 'react-dom/client';
import '../../styles.css';
import '../../visuais/visuais.css';
import './visuais-galeria.css';
import { prepararIdioma, setIdioma } from '../../i18n/index.ts';
import { ENVIOS, RESPOSTAS } from './dados.ts';
import { Pagina } from './Pagina.tsx';

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('tema') === 'escuro' ? 'dark' : q.get('tema') === 'contraste' ? 'contraste' : 'light';
const cena = q.get('cena') ?? 'galeria';
document.body.dataset.cena = cena;

// as respostas do servidor, de exemplo (o envio responde em 150 ms)
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const original = window.fetch.bind(window);
window.fetch = async (alvo: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(typeof alvo === 'string' || alvo instanceof URL ? alvo : alvo.url).replace(location.origin, '');
  if (!url.startsWith('/api/')) return original(alvo, init);
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') { await new Promise((r) => setTimeout(r, 150)); const e = ENVIOS.find(([re]) => re.test(url)); return json(e ? e[1]() : { ok: true }); }
  for (const [re, f] of RESPOSTAS) { const m = url.match(re); if (m) return json(f(m)); }
  return json({});
};

void prepararIdioma()
  .then(() => (q.get('lang') === 'en' ? setIdioma('en', { guardar: false }) : setIdioma('pt-BR', { guardar: false })))
  .then(() => createRoot(document.getElementById('root')!).render(<Pagina cena={cena} />));

#!/usr/bin/env node
// Ponta a ponta da inicialização assistida contra um projeto Docker de TESTE (outro nome, outra porta, outro volume —
// nunca a instalação real): a tela de abertura mostra o estado, o clique em "Iniciar Ergon" roda o lançador
// ("subir"), a fase acompanha o que ele faz e, pronto, a janela abre o Ergon. Com --so-estado, só confere o estado
// mostrado (ex.: "pronto" ao reabrir) sem clicar em nada.
//   Windows: node iniciar.mjs --driver cdp --cdp http://127.0.0.1:9333 --ergon http://localhost:18792 --saida pasta
//   Linux:   node iniciar.mjs --driver webdriver --webdriver http://127.0.0.1:4444 --app /usr/bin/ergon-desktop …
import fs from 'node:fs';
import { cdp, sleep, webdriver } from './motoristas.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] ?? '1']] : a), []));
const ERGON = new URL(args.ergon);
const pref = args.prefixo ?? '';
fs.mkdirSync(args.saida, { recursive: true });
const m = args.driver === 'cdp' ? await cdp({ base: args.cdp, saida: args.saida }) : await webdriver({ base: args.webdriver, app: args.app, saida: args.saida });
const tela = () => m.eval(`({ origem: location.origin, fase: document.getElementById('fase')?.textContent ?? null, titulo: document.getElementById('titulo')?.textContent ?? null, linha: document.getElementById('frase')?.textContent ?? null, botoes: [...document.querySelectorAll('#acoes button')].map((b) => b.textContent) })`).catch(() => null);
const fim = async (codigo, texto) => { console.log(texto); await m.fim(); process.exit(codigo); };

// 1. o estado da tela de abertura (ou a janela já no Ergon)
let t;
for (let i = 0; i < 120; i++) {
  t = await tela();
  if (t?.origem === ERGON.origin || t?.botoes?.length) break;
  await sleep(500);
}
console.log('tela:', JSON.stringify(t));
if (args['so-estado']) {
  // pronto e confirmado, a abertura abre o Ergon sozinha logo em seguida: dá esse tempo antes de concluir
  for (let i = 0; i < 20 && t?.titulo?.startsWith('Pronto') && t?.origem !== ERGON.origin; i++) { await sleep(250); t = (await tela()) ?? t; }
  if (t?.origem === ERGON.origin) { await sleep(1500); await m.shot(`${pref}aberto.png`); await fim(0, `ok: abriu ${ERGON.origin} sozinho (pronto e confirmado)`); }
  await m.shot(`${pref}estado.png`);
  await fim(0, `estado: ${t?.titulo ?? '?'} [${(t?.botoes ?? []).join(' | ')}]`);
}
if (!t?.botoes?.includes('Iniciar Ergon')) await fim(1, 'FALHA: a tela não ofereceu "Iniciar Ergon"');
await m.shot(`${pref}01-desligado.png`);

// 2. iniciar: acompanha as fases até a janela sair para o Ergon
await m.eval(`([...document.querySelectorAll('#acoes button')].find((b) => b.textContent === 'Iniciar Ergon').click(), true)`);
const fases = new Set(); const linhas = []; const t0 = Date.now(); let fotoProgresso = false;
while (Date.now() - t0 < 8 * 60_000) {
  t = await tela();
  if (t?.origem === ERGON.origin) break;
  if (t?.fase) fases.add(t.fase);
  if (t?.linha && linhas.at(-1) !== t.linha) linhas.push(t.linha);
  if (!fotoProgresso && t?.linha) { await m.shot(`${pref}02-iniciando.png`); fotoProgresso = true; }
  if (t?.fase === 'Necessita atenção' && !t?.botoes?.includes('Iniciar Ergon')) await fim(1, `FALHA: ${JSON.stringify(t)}`);
  await sleep(400);
}
const segundos = Math.round((Date.now() - t0) / 1000);
console.log('fases vistas:', [...fases].join(' → '));
console.log('linhas do lançador:', linhas.slice(0, 10).join(' | '));
if (t?.origem !== ERGON.origin) await fim(1, `FALHA: não abriu o Ergon em ${segundos}s`);
await sleep(2000);
await m.shot(`${pref}03-aberto.png`);
await fim(0, `ok: iniciou e abriu ${ERGON.origin} em ${segundos}s`);

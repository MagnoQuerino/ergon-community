#!/usr/bin/env node
// Testes do Ergon Desktop DENTRO do WebView de verdade — WebView2 no Windows (via CDP) e WebKitGTK no Linux (via
// WebDriver/tauri-driver) — contra uma instância DESCARTÁVEL do Ergon (nunca a instalação real).
// Cobre: senha, sessão/cookies, CSRF, upload, download, isolamento das funções nativas, política de navegação,
// trava por inatividade, autenticador (TOTP), passkey e recuperação pela frase.
//
//   Windows: node autenticacao.mjs --driver cdp --cdp http://127.0.0.1:9333 --ergon http://localhost:18791 \
//              --conta conta.json --saida pasta --downloads <pasta de downloads de teste> --registro <pasta de logs>
//   Linux:   node autenticacao.mjs --driver webdriver --webdriver http://127.0.0.1:4444 --app /usr/bin/ergon-desktop \
//              --ergon http://localhost:8787 --conta conta.json --saida pasta --downloads … --registro …
// A conta (usuário, senha, frase) vem de um arquivo local da instância descartável; nada é impresso.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdp, sleep, webdriver } from './motoristas.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const ERGON = new URL(args.ergon);
const conta = JSON.parse(fs.readFileSync(args.conta, 'utf8'));
const saida = args.saida;
fs.mkdirSync(saida, { recursive: true });
const resultados = [];

// ---------------------------------------------------------------------------------------------------------------
// ajudas

async function esperar(m, js, ms = 20000, passo = 400) {
  const fim = Date.now() + ms; let ultimo;
  while (Date.now() < fim) { try { ultimo = await m.eval(js); if (ultimo) return ultimo; } catch (e) { ultimo = String(e.message ?? e); } await sleep(passo); }
  throw new Error(`não aconteceu em ${ms / 1000}s: ${js.slice(0, 120)}${typeof ultimo === 'string' ? ` (${ultimo.slice(0, 120)})` : ''}`);
}
const clicarTexto = (m, texto, tag = 'button') => m.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(tag)})].find((x) => x.textContent.trim().includes(${JSON.stringify(texto)}) && !x.disabled); if (!b) throw new Error('sem ' + ${JSON.stringify(texto)}); b.click(); return true })()`);
const enviar = (m, sel) => m.eval(`(() => { const f = document.querySelector(${JSON.stringify(sel)}).closest('form'); f.requestSubmit(); return true })()`);
// chamada à API como a própria interface faz: cookie da sessão + cabeçalho CSRF lido de /api/me
const api = (m, metodo, url, corpo) => m.eval(`(async () => {
  const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
  const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(metodo)}, credentials: 'same-origin', headers: { ${corpo ? "'content-type': 'application/json', " : ''}'X-CSRF-Token': me.csrf }, body: ${corpo ? JSON.stringify(JSON.stringify(corpo)) : 'undefined'} });
  return { status: r.status, corpo: await r.json().catch(() => null) };
})()`);

function totp(segredo, t = Date.now()) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const c of segredo.replace(/=+$/, '').toUpperCase()) bits += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  const chave = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8); contador.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', chave).update(contador).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

async function passo(nome, fn) {
  const t0 = Date.now();
  try { const detalhe = await fn(); resultados.push({ nome, ok: true, detalhe: detalhe ?? '', ms: Date.now() - t0 }); console.log(`ok   ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
  catch (e) { resultados.push({ nome, ok: false, detalhe: String(e.message ?? e), ms: Date.now() - t0 }); console.log(`FALHA ${nome} — ${e.message ?? e}`); }
}

const naTelaDeLogin = (m) => esperar(m, `!!document.querySelector('input[autocomplete="current-password"]') && !!document.querySelector('input[autocomplete="username"]')`);
const logado = (m) => esperar(m, `!!document.querySelector('.topbar')`, 30000);
async function entrarComSenha(m) {
  await naTelaDeLogin(m);
  await m.type('input[autocomplete="username"]', conta.username);
  await m.type('input[autocomplete="current-password"]', conta.password);
  await enviar(m, 'input[autocomplete="current-password"]');
}
async function sair(m) {
  await api(m, 'POST', '/api/auth/logout');
  await m.eval('(location.reload(), true)').catch(() => {});
  await naTelaDeLogin(m);
}
function logMaisNovo(pasta) {
  try {
    const fs2 = fs.readdirSync(pasta).filter((f) => f.endsWith('.log')).map((f) => path.join(pasta, f));
    return fs2.length ? fs.readFileSync(fs2.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0], 'utf8') : '';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------------------------------------------

const m = args.driver === 'cdp' ? await cdp({ base: args.cdp, origem: ERGON.origin, saida }) : await webdriver({ base: args.webdriver, app: args.app, origem: ERGON.origin, saida });
console.log(`motor: ${m.nome}`);

await passo('a janela abre o Ergon (tela de login, sem sessão)', async () => { await naTelaDeLogin(m); await m.shot('01-login.png'); return await m.eval('location.origin'); });

await passo('entrar com senha (sessão por cookie)', async () => {
  await entrarComSenha(m); await logado(m); await m.shot('02-logado.png');
  const me = await m.eval(`fetch('/api/me').then((r) => r.status)`);
  if (me !== 200) throw new Error(`/api/me respondeu ${me}`);
  return 'cookie de sessão aceito';
});

await passo('CSRF: com o cabeçalho a escrita passa; sem ele, é recusada', async () => {
  const com = await api(m, 'PUT', '/api/me/prefs', { tips: true });
  const sem = await m.eval(`fetch('/api/me/prefs', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"tips":true}' }).then((r) => r.status)`);
  if (com.status !== 200 || sem !== 403) throw new Error(`com=${com.status} sem=${sem}`);
  return 'com=200, sem=403';
});

const titulo = `Teste do aplicativo ${Date.now().toString(36)}`;
await passo('criar tarefa pela interface', async () => {
  await m.eval(`(location.hash = '#tarefas', true)`);
  // o quadro termina de carregar depois do campo aparecer e pode redesenhar o formulário (o texto digitado some):
  // espera as colunas, confere que o texto ficou no campo e tenta de novo uma vez
  const campo = 'input[aria-label="Título da nova tarefa"]';
  const criada = `[...document.querySelectorAll('.task')].some((t) => t.textContent.includes(${JSON.stringify(titulo)}))`;
  await esperar(m, `!!document.querySelector(${JSON.stringify(campo)}) && document.querySelectorAll('.board h3').length > 0`);
  for (let tentativa = 1; ; tentativa++) {
    await m.type(campo, titulo);
    await esperar(m, `document.querySelector(${JSON.stringify(campo)})?.value === ${JSON.stringify(titulo)}`, 3000);
    await enviar(m, campo);
    try { await esperar(m, criada, tentativa === 1 ? 8000 : 20000); return tentativa === 1 ? '' : 'criada na 2ª tentativa (o quadro redesenhou o formulário)'; } catch (e) { if (tentativa === 2) throw e; }
  }
});

const arquivo = path.join(os.tmpdir(), `teste-desktop-${process.pid}.csv`);
fs.writeFileSync(arquivo, 'mes,valor\n2026-09,10\n2026-10,12\n');
await passo('upload: anexar um arquivo ao card', async () => {
  await m.eval(`([...document.querySelectorAll('.task')].find((t) => t.textContent.includes(${JSON.stringify(titulo)})).click(), true)`);
  await esperar(m, `!!document.querySelector('input[aria-label="Arquivo para anexar ao card"]')`);
  await m.setFiles('input[aria-label="Arquivo para anexar ao card"]', [arquivo]);
  await clicarTexto(m, 'Anexar');
  await esperar(m, `document.body.textContent.includes(${JSON.stringify(`Anexado: ${path.basename(arquivo)}`)})`);
  await m.shot('03-anexado.png');
  return path.basename(arquivo);
});

await passo('download: baixar o arquivo do card', async () => {
  const antes = new Set(fs.existsSync(args.downloads) ? fs.readdirSync(args.downloads) : []);
  await clicarTexto(m, 'Baixar', 'a');
  const fim = Date.now() + 20000; let novo;
  while (Date.now() < fim && !novo) { novo = (fs.existsSync(args.downloads) ? fs.readdirSync(args.downloads) : []).find((f) => !antes.has(f) && !f.endsWith('.crdownload') && !f.endsWith('.part')); if (!novo) await sleep(500); }
  if (!novo) throw new Error(`nada chegou em ${args.downloads}`);
  await sleep(500);
  const igual = fs.readFileSync(path.join(args.downloads, novo)).equals(fs.readFileSync(arquivo));
  if (!igual) throw new Error('o arquivo baixado é diferente do enviado');
  return `${novo} (igual ao enviado)`;
});

await passo('a interface do Ergon não chama funções nativas do aplicativo', async () => {
  const r = await m.eval(`(async () => {
    const t = window.__TAURI__ ?? null;
    if (!t?.core?.invoke) return 'sem ponte nativa na página';
    try { await t.core.invoke('diagnosticar'); return 'PERMITIU'; } catch (e) { return 'recusou: ' + String(e).slice(0, 120); }
  })()`);
  if (r === 'PERMITIU') throw new Error('a página do Ergon conseguiu chamar um comando nativo');
  return r;
});

await passo('links externos vão para o navegador; file: e outras portas são recusados', async () => {
  const antes = await m.eval('location.href');
  const links = { novaAba: 'https://example.com/?teste=desktop', login: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=teste', arquivo: 'file:///etc/hosts', outraPorta: 'http://localhost:9/' };
  await m.eval(`(() => { const box = document.createElement('div'); box.id = 'links-teste'; box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#fff;display:flex;gap:8px;padding:4px';
    for (const [id, href] of Object.entries(${JSON.stringify(links)})) { const a = document.createElement('a'); a.id = 'l-' + id; a.href = href; a.textContent = id; if (id === 'novaAba') a.target = '_blank'; box.append(a); }
    document.body.append(box); return true })()`);
  for (const id of Object.keys(links)) {
    await m.click('#l-' + id).catch(() => {});
    await sleep(1500);
    if ((await m.eval('location.origin').catch(() => '')) !== ERGON.origin) break;
  }
  const depois = await m.eval('location.href');
  await m.eval(`(document.getElementById('links-teste')?.remove(), true)`).catch(() => {});
  if (new URL(depois).origin !== ERGON.origin) throw new Error(`a janela saiu do Ergon: ${new URL(depois).origin}`);
  const log = logMaisNovo(args.registro);
  const fora = new Set(log.match(/abriria no navegador: https:\/\/(example\.com|login\.microsoftonline\.com)/g) ?? []);
  const recusadas = new Set(log.match(/navegação recusada: (file:\/\/|http:\/\/localhost)/g) ?? []);
  if (fora.size < 2) throw new Error(`o registro não mostra os dois endereços externos (achou: ${[...fora].join(', ') || 'nenhum'})`);
  return `ficou em ${new URL(depois).origin}; no navegador: ${[...fora].map((f) => f.split(': ')[1]).join(', ')}; recusadas: ${[...recusadas].map((f) => f.split(': ')[1]).join(', ') || 'nenhuma registrada (o próprio motor bloqueou)'}; ${antes === depois ? 'mesma página' : 'página mudou dentro do Ergon'}`;
});

await passo('trava por inatividade (1 min) e destrancar com senha', async () => {
  const r = await api(m, 'PUT', '/api/security/idle', { minutes: 1 });
  if (r.status !== 200) throw new Error(`ligar a trava: ${r.status}`);
  await m.eval('(location.reload(), true)');
  await logado(m);
  await esperar(m, `!!document.querySelector('.lock[role="dialog"]')`, 100000, 2000);
  await m.shot('04-trancado.png');
  await m.type('.lock input[type="password"]', conta.password);
  await enviar(m, '.lock input[type="password"]');
  await esperar(m, `!document.querySelector('.lock[role="dialog"]')`);
  await api(m, 'PUT', '/api/security/idle', { minutes: 0 });
  return 'trancou sozinha e abriu com a senha';
});

let segredo = null;
await passo('autenticador (TOTP): cadastrar e entrar com o código', async () => {
  const ini = await api(m, 'POST', '/api/security/totp/start');
  if (ini.status !== 200) throw new Error(`começar: ${ini.status}`);
  segredo = ini.corpo.secret;
  const conf = await api(m, 'POST', '/api/security/totp/confirm', { code: totp(segredo) });
  if (conf.status !== 200) throw new Error(`confirmar: ${conf.status}`);
  // o mesmo código não vale duas vezes: espera a janela seguinte
  await sleep(30000 - (Date.now() % 30000) + 1500);
  await sair(m);
  await entrarComSenha(m);
  await esperar(m, `!!document.querySelector('input[autocomplete="one-time-code"]')`);
  await m.shot('05-pede-codigo.png');
  await m.type('input[autocomplete="one-time-code"]', totp(segredo));
  await enviar(m, 'input[autocomplete="one-time-code"]');
  await logado(m);
  return 'senha + código';
});

await passo('passkey: cadastrar e entrar sem senha', async () => {
  const suporte = await m.eval(`typeof window.PublicKeyCredential === 'function'`);
  if (!suporte) return 'SEM SUPORTE neste motor (WebAuthn indisponível): a tela não oferece passkey; senha e autenticador seguem valendo';
  if (!(await m.passkeyVirtual())) return 'motor sem autenticador virtual para teste automático';
  await m.eval(`(location.hash = '#configuracao?seguranca', true)`);
  await esperar(m, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Adicionar passkey'))`);
  await clicarTexto(m, 'Adicionar passkey');
  // confirmação recente com a senha, se a tela pedir
  try {
    await esperar(m, `!!document.querySelector('[role="dialog"] input[type="password"]') || document.body.textContent.includes('Passkey adicionada')`, 8000);
    if (await m.eval(`!!document.querySelector('[role="dialog"] input[type="password"]')`)) {
      await m.type('[role="dialog"] input[type="password"]', conta.password);
      await enviar(m, '[role="dialog"] input[type="password"]');
      await sleep(800);
      if (!(await m.eval(`document.body.textContent.includes('Passkey adicionada')`))) await clicarTexto(m, 'Adicionar passkey');
    }
  } catch { /* segue para a conferência */ }
  await esperar(m, `fetch('/api/security/status').then((r) => r.json()).then((s) => (s.passkeys ?? []).length > 0)`, 20000);
  await m.shot('06-passkey.png');
  await sair(m);
  await clicarTexto(m, 'Entrar com passkey');
  await logado(m);
  return 'cadastrada (autenticador virtual do WebView2) e usada para entrar';
});

await passo('recuperar a conta com a frase (senha nova)', async () => {
  if (!conta.phrase) return 'sem a frase desta instância: pulado';
  await sair(m);
  await clicarTexto(m, 'Esqueci a senha');
  await esperar(m, `!!document.querySelector('textarea')`);
  const nova = `Nova-${crypto.randomBytes(9).toString('base64url')}`;
  await m.type('input[autocomplete="username"]', conta.username);
  await m.type('textarea', conta.phrase);
  const campos = await m.eval(`document.querySelectorAll('input[autocomplete="new-password"]').length`);
  if (campos !== 2) throw new Error('campos de senha nova não apareceram');
  await m.type('input[autocomplete="new-password"]', nova);
  await m.eval(`(() => { const c = document.querySelectorAll('input[autocomplete="new-password"]')[1]; c.focus(); c.select(); return true })()`);
  if (args.driver === 'cdp') await m.send('Input.insertText', { text: nova });
  else await m.eval(`(() => { const c = document.querySelectorAll('input[autocomplete="new-password"]')[1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(c, ${JSON.stringify(nova)}); c.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
  await enviar(m, 'textarea');
  // com autenticador ligado, a recuperação ainda pede o código
  await esperar(m, `!!document.querySelector('.topbar') || !!document.querySelector('input[autocomplete="one-time-code"]')`, 30000);
  if (await m.eval(`!!document.querySelector('input[autocomplete="one-time-code"]')`)) {
    await sleep(30000 - (Date.now() % 30000) + 1500);
    await m.type('input[autocomplete="one-time-code"]', totp(segredo));
    await enviar(m, 'input[autocomplete="one-time-code"]');
  }
  await logado(m);
  conta.password = nova;
  fs.writeFileSync(args.conta, JSON.stringify(conta));
  return 'senha trocada pela frase e sessão aberta';
});

await m.fim();
fs.rmSync(arquivo, { force: true });
fs.writeFileSync(path.join(saida, 'resultados.json'), JSON.stringify({ motor: m.nome, quando: new Date().toISOString(), resultados }, null, 2));
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passos ok (${m.nome})`);
process.exit(falhas ? 1 : 0);

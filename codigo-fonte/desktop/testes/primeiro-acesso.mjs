#!/usr/bin/env node
// Primeiro acesso pela janela: num Ergon NOVO (descartável, sem conta), a janela mostra "Crie a sua conta" e a conta é
// criada por ali, como uma pessoa faria. Os dados são de teste, gerados aqui, e não são impressos.
//   node primeiro-acesso.mjs --driver cdp --cdp http://127.0.0.1:9333 --ergon http://localhost:18791 --saida pasta
import crypto from 'node:crypto';
import fs from 'node:fs';
import { cdp, sleep, webdriver } from './motoristas.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] ?? '1']] : a), []));
const ERGON = new URL(args.ergon);
fs.mkdirSync(args.saida, { recursive: true });
const m = args.driver === 'cdp' ? await cdp({ base: args.cdp, saida: args.saida }) : await webdriver({ base: args.webdriver, app: args.app, saida: args.saida });
const fim = async (codigo, texto) => { console.log(texto); await m.fim(); process.exit(codigo); };
const esperar = async (js, ms = 30000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await m.eval(js).catch(() => false)) return true; await sleep(400); } return false; };
// valor num campo controlado pelo React (o setter nativo + evento "input")
const preencher = (sel, i, valor) => m.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}];
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(valor)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);

if (!(await esperar(`location.origin === ${JSON.stringify(ERGON.origin)}`, 60000))) await fim(1, 'FALHA: a janela não abriu o Ergon');
if (!(await esperar(`document.body.innerText.includes('Crie a sua conta')`))) await fim(1, `FALHA: sem "Crie a sua conta" (${(await m.eval('document.body.innerText.slice(0, 160)').catch(() => '?')).replace(/\s+/g, ' ')})`);
await m.shot('primeiro-acesso-1-crie-a-sua-conta.png');

const senha = crypto.randomBytes(18).toString('base64url');
await preencher('label.field input:not([autocomplete])', 0, 'Pessoa de Teste');
await preencher('input[autocomplete="username"]', 0, 'teste-janela');
await preencher('input[autocomplete="new-password"]', 0, senha);
await preencher('input[autocomplete="new-password"]', 1, senha);
await m.eval(`(document.querySelector('input[autocomplete="username"]').closest('form').requestSubmit(), true)`);

// depois de criar: a frase de recuperação (passo seguinte do primeiro uso) e a sessão aberta
// (a dica de senha também fala em "frase": espera o passo da frase em si)
if (!(await esperar(`document.body.innerText.includes('Anote estas')`, 60000))) await fim(1, `FALHA: a conta não foi criada (${(await m.eval('document.body.innerText.slice(0, 200)').catch(() => '?')).replace(/\s+/g, ' ')})`);
await m.shot('primeiro-acesso-2-frase.png');
const estado = await m.eval(`fetch('/api/auth/state', { credentials: 'same-origin' }).then((r) => r.json())`);
await fim(estado.authenticated && !estado.needsSetup ? 0 : 1, `${estado.authenticated && !estado.needsSetup ? 'ok' : 'FALHA'}: conta criada pela janela, sessão aberta (needsSetup=${estado.needsSetup}, autenticado=${estado.authenticated})`);

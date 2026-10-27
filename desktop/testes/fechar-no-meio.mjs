#!/usr/bin/env node
// Fechar o aplicativo não interrompe o trabalho em andamento: a execução é do Ergon (no Docker), não da janela. Em
// duas fases, numa instância DESCARTÁVEL com o executor simulado lento (ERGON_SIMULATED_DELAY_MS=30000): "disparar"
// entra com a conta de teste pela própria janela e pede algo ao coordenador (uma execução, a mesma unidade que as
// rotinas usam com o motor real); quem orquestra fecha o aplicativo logo depois e o abre de novo; "conferir" lê, pela
// janela reaberta e com a mesma sessão, a execução até ela terminar — e exige que tenha terminado depois do fechamento.
// (No modo simulado as rotinas fecham na hora, montadas sem modelo: por isso a prova usa uma execução de agente.)
//   node fechar-no-meio.mjs --fase disparar --driver cdp --cdp http://127.0.0.1:9334 --ergon http://localhost:18792 --conta conta.json --estado trabalho.json --saida pasta
//   node fechar-no-meio.mjs --fase conferir --fechado-em <ISO> … (mesmos argumentos)
import fs from 'node:fs';
import { cdp, sleep, webdriver } from './motoristas.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] ?? '1']] : a), []));
const ERGON = new URL(args.ergon);
fs.mkdirSync(args.saida, { recursive: true });
const m = args.driver === 'cdp' ? await cdp({ base: args.cdp, saida: args.saida }) : await webdriver({ base: args.webdriver, app: args.app, saida: args.saida });
const fim = async (codigo, texto) => { console.log(texto); await m.fim(); process.exit(codigo); };
const api = (metodo, url, corpo) => m.eval(`(async () => {
  const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
  const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(metodo)}, credentials: 'same-origin', headers: { ${corpo ? "'content-type': 'application/json', " : ''}'X-CSRF-Token': me.csrf ?? '' }, body: ${corpo ? JSON.stringify(JSON.stringify(corpo)) : 'undefined'} });
  return { status: r.status, corpo: await r.json().catch(() => null) };
})()`);

// a janela abre o Ergon sozinha quando ele está pronto e confirmado
for (let i = 0; i < 120; i++) {
  if ((await m.eval('location.origin').catch(() => null)) === ERGON.origin) break;
  await sleep(500);
}
if ((await m.eval('location.origin').catch(() => null)) !== ERGON.origin) await fim(1, 'FALHA: a janela não abriu o Ergon');

if (args.fase === 'disparar') {
  const conta = JSON.parse(fs.readFileSync(args.conta, 'utf8'));
  const login = await m.eval(`fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ username: conta.username, password: conta.password }))} }).then((r) => r.status)`);
  if (login !== 200) await fim(1, `FALHA: login ${login}`);
  const estado = await api('GET', '/api/state');
  const coordenador = (estado.corpo?.agents ?? []).find((a) => a.lead) ?? estado.corpo?.agents?.[0];
  if (!coordenador) await fim(1, `FALHA: sem equipe (${estado.status})`);
  const conversa = await api('POST', '/api/conversations', { agentId: coordenador.id, title: 'Teste do aplicativo' });
  if (conversa.status !== 201) await fim(1, `FALHA: abrir a conversa ${conversa.status}`);
  const msg = await api('POST', `/api/conversations/${conversa.corpo.id}/messages`, { text: 'Resuma o que está atrasado (teste do aplicativo).', clientRequestId: `desktop-${Date.now()}` });
  if (msg.status !== 201 || !msg.corpo?.runId) await fim(1, `FALHA: mandar a mensagem ${msg.status}`);
  const exec = await api('GET', `/api/runs/${msg.corpo.runId}`);
  fs.writeFileSync(args.estado, JSON.stringify({ execucao: msg.corpo.runId }));
  await m.shot('trabalho-1-disparado.png');
  await fim(0, `disparada: ${msg.corpo.runId} (${exec.corpo?.status}, ${exec.corpo?.mode})`);
}

if (args.fase === 'conferir') {
  const { execucao } = JSON.parse(fs.readFileSync(args.estado, 'utf8'));
  const fechado = Date.parse(args['fechado-em']);
  let r; const t0 = Date.now();
  while (Date.now() - t0 < 3 * 60_000) {
    r = await api('GET', `/api/runs/${execucao}`);
    if (r.status !== 200) await fim(1, `FALHA: ler a execução ${r.status} (a sessão da janela sobreviveu ao fechar?)`);
    if (!['queued', 'running'].includes(r.corpo.status)) break;
    await sleep(2000);
  }
  await m.shot('trabalho-2-depois-de-reabrir.png');
  const terminou = Date.parse(r.corpo.finished_at ?? '');
  const ok = r.corpo.status === 'succeeded' && terminou > fechado;
  await fim(ok ? 0 : 1, `${ok ? 'ok' : 'FALHA'}: execução ${execucao} "${r.corpo.status}" — criada ${r.corpo.created_at}, app fechado ${new Date(fechado).toISOString()}, terminou ${r.corpo.finished_at}`);
}
await fim(1, 'uso: --fase disparar | conferir');

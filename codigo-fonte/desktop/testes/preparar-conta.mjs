#!/usr/bin/env node
// Cria a conta de dono numa instância DESCARTÁVEL e recém-criada do Ergon (primeiro uso), pula as perguntas de
// boas-vindas e grava usuário, senha e frase de recuperação num arquivo local — nada é impresso.
// Uso: node preparar-conta.mjs http://localhost:18791 conta.json
import crypto from 'node:crypto';
import fs from 'node:fs';

const [base, arquivo] = process.argv.slice(2);
if (!base || !arquivo) { console.error('uso: preparar-conta.mjs <endereço> <arquivo>'); process.exit(1); }
const conta = { username: 'teste-desktop', password: `Teste-${crypto.randomBytes(12).toString('base64url')}` };
let cookie = '';
const pedir = async (metodo, url, corpo, csrf) => {
  const r = await fetch(base + url, { method: metodo, headers: { 'content-type': 'application/json', origin: base, cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
  const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  return { status: r.status, corpo: await r.json().catch(() => null) };
};
const estado = await pedir('GET', '/api/auth/state');
if (!estado.corpo?.needsSetup) { console.error('a instância já tem conta: use uma instância nova'); process.exit(1); }
const s = await pedir('POST', '/api/auth/setup', { ...conta, displayName: 'Teste Desktop' });
if (s.status !== 200) { console.error(`criar a conta: ${s.status}`); process.exit(1); }
conta.phrase = s.corpo.recovery?.phrase ?? null;
const me = await pedir('GET', '/api/me');
// a frase só passa a valer depois de confirmar as palavras pedidas (como no primeiro uso pela tela)
let frase = 'sem frase';
if (conta.phrase && s.corpo.recovery?.ask) {
  const palavras = conta.phrase.split(' ');
  const answers = Object.fromEntries(s.corpo.recovery.ask.map((n) => [String(n), palavras[n - 1]]));
  const c = await pedir('POST', '/api/security/recovery/confirm', { answers }, me.corpo?.csrf);
  frase = c.status === 200 ? 'frase confirmada' : `frase NÃO confirmada (${c.status})`;
}
const pulo = await pedir('POST', '/api/onboarding/skip', {}, me.corpo?.csrf);
await pedir('PUT', '/api/me/prefs', { tips: false, tourDone: true }, me.corpo?.csrf);
fs.writeFileSync(arquivo, JSON.stringify(conta));
console.log(`conta criada (${frase}; boas-vindas ${pulo.status === 200 ? 'puladas' : `não puladas (${pulo.status})`})`);

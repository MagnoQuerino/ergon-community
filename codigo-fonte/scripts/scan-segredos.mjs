#!/usr/bin/env node
// Varredura de segredos nos arquivos versionados (CI e antes de enviar): chaves privadas, tokens de nuvem e de IA,
// segredos de app OAuth e atribuições em arquivos .env. Nunca imprime o valor achado — só o arquivo, a linha e a regra.
//   node scripts/scan-segredos.mjs            (arquivos do Git; fora do Git, a pasta toda)
// Falso positivo de verdade (valor de teste, documentação): ponha a impressão (sha256) em .segredos-permitidos.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const RULES = [
  ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['chave da AWS', /\bAKIA[0-9A-Z]{16}\b/g],
  ['token do GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['segredo de cliente do Google', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g],
  ['chave de API do Google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['chave de IA (OpenAI/Anthropic/OpenRouter)', /\bsk-(?:ant-[a-z0-9]+-|or-v1-|proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['chave do Stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['segredo de webhook do Stripe', /\bwhsec_[A-Za-z0-9]{24,}\b/g],
  ['segredo de app da Microsoft', /\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}\b/g],
];
// em arquivos de ambiente: NOME_COM_SEGREDO=valor (exemplo vazio, <...>, ${...} e textos "seu..." passam)
const ENV_FILE = /(^|[\\/])(\.env(\..+)?|[^\\/]*\.env)$/;
const ENV_RULE = /^\s*([A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|APIKEY|PASSWORD|PASS|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*["']?([^\s"'#]{12,})/gm;
const ENV_OK = /^(<|\$\{|seu|sua|your|xxx|changeme|troque|exemplo|example)/i;
const BINARY = /\.(png|jpe?g|gif|ico|webp|zip|gz|tgz|pdf|woff2?|ttf|otf|mp3|mp4|wasm|sqlite|db|bin)$/i;
const SKIP = /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)|package-lock\.json$/;

const allowed = new Set(fs.existsSync(path.join(root, '.segredos-permitidos'))
  ? fs.readFileSync(path.join(root, '.segredos-permitidos'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l)) : []);
const fingerprint = (v) => crypto.createHash('sha256').update(v).digest('hex');

let files;
try { files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
catch { files = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (SKIP.test(r)) continue; if (e.isDirectory()) walk(r); else files.push(r); } }; walk('.'); }

const found = [];
for (const rel of files) {
  if (BINARY.test(rel) || SKIP.test(rel)) continue;
  let text;
  try { const b = fs.readFileSync(path.join(root, rel)); if (b.length > 5 * 1024 * 1024 || b.includes(0)) continue; text = b.toString('utf8'); } catch { continue; }
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const hit = (rule, value, index) => { if (!allowed.has(fingerprint(value))) found.push({ rel, line: lineOf(index), rule, fp: fingerprint(value) }); };
  for (const [rule, re] of RULES) for (const m of text.matchAll(re)) hit(rule, m[0], m.index);
  // ERGON_SECRETS_DIR e afins são caminhos e endereços, não segredos
  if (ENV_FILE.test(rel)) for (const m of text.matchAll(ENV_RULE)) if (!ENV_OK.test(m[2]) && !/_(DIR|PATH|FILE|URL|ID)$/.test(m[1])) hit(`segredo em arquivo de ambiente (${m[1]})`, m[2], m.index);
}

if (!found.length) { console.log(`Nenhum segredo encontrado (${files.length} arquivo(s) conferido(s)).`); process.exit(0); }
console.error(`${found.length} possível(is) segredo(s) — o valor não é mostrado:`);
for (const f of found) console.error(`  ${f.rel}:${f.line} · ${f.rule} · impressão ${f.fp.slice(0, 16)}…`);
console.error('Se for segredo de verdade: tire do arquivo, troque a credencial (ela já pode ter vazado) e reescreva o histórico.');
console.error('Se for exemplo ou valor de teste: ponha a impressão inteira (sha256) em .segredos-permitidos.');
process.exit(1);

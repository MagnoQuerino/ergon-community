#!/usr/bin/env node
// Catálogo dos modelos da comunidade: confere cada .ergon em catalogo/pacotes/ com a mesma validação da instalação e
// confere (ou grava, com --gravar) o catalogo/index.json que a loja lê.
//   node catalogo/conferir.mjs            confere (a CI roda assim em cada envio)
//   node catalogo/conferir.mjs --gravar   refaz o index.json a partir dos pacotes
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.resolve(import.meta.dirname, '..');
const pasta = path.join(raiz, 'catalogo', 'pacotes');
const arqIndice = path.join(raiz, 'catalogo', 'index.json');
const { validatePackage, INSTALLABLE } = await import('../server/src/services/ergon-package.ts');
const { OFFICIAL_KEYS } = await import('../server/src/services/catalog.ts');

const ID = /^comunidade\.[a-z0-9][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9-]{1,40}$/;
const MAX = 5 * 1024 * 1024;
const lista = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? lista(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

const problemas = [];
const pacotes = [];
const vistos = new Set();
for (const arq of lista(pasta).sort()) {
  const rel = path.relative(path.join(raiz, 'catalogo'), arq).split(path.sep).join('/');
  if (!rel.endsWith('.ergon')) { problemas.push(`${rel}: só arquivos .ergon em catalogo/pacotes`); continue; }
  if (!/^pacotes\/[a-z0-9][a-z0-9-]{1,30}\/[a-z0-9][a-z0-9._-]{0,80}\.ergon$/.test(rel)) { problemas.push(`${rel}: use pacotes/<criador>/<nome>.ergon, em minúsculas`); continue; }
  const buf = fs.readFileSync(arq);
  if (buf.length > MAX) { problemas.push(`${rel}: maior que 5 MB`); continue; }
  let v;
  try { v = validatePackage(buf, OFFICIAL_KEYS); } catch (e) { problemas.push(`${rel}: ${e.message}`); continue; }
  const m = v.manifest;
  if (!ID.test(m.package_id)) { problemas.push(`${rel}: package_id deve ser comunidade.<criador>.<nome> (é ${m.package_id})`); continue; }
  if (m.package_id.split('.')[1] !== rel.split('/')[1]) { problemas.push(`${rel}: a pasta deve ser a do criador do package_id (${m.package_id.split('.')[1]})`); continue; }
  if (!INSTALLABLE.has(m.kind)) { problemas.push(`${rel}: o tipo ${m.kind} ainda não se instala pela loja`); continue; }
  if (vistos.has(m.package_id)) { problemas.push(`${rel}: package_id repetido (${m.package_id})`); continue; }
  vistos.add(m.package_id);
  pacotes.push({ id: m.package_id, version: m.version, title: m.title, summary: m.summary, kind: m.kind, author: m.creator_id, path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
}

const indice = { version: 1, packages: pacotes };
const texto = `${JSON.stringify(indice, null, 2)}\n`;
if (process.argv.includes('--gravar')) {
  if (problemas.length) { console.error(problemas.join('\n')); process.exit(1); }
  fs.writeFileSync(arqIndice, texto);
  console.log(`index.json gravado: ${pacotes.length} modelo(s)`);
} else {
  const atual = fs.existsSync(arqIndice) ? fs.readFileSync(arqIndice, 'utf8') : '';
  if (atual.replace(/\r\n/g, '\n') !== texto) problemas.push('catalogo/index.json não confere com os pacotes: rode node catalogo/conferir.mjs --gravar');
  if (problemas.length) { console.error(problemas.join('\n')); process.exit(1); }
  console.log(`catálogo conferido: ${pacotes.length} modelo(s)`);
}

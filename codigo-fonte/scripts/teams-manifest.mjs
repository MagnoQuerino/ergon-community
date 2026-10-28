#!/usr/bin/env node
// Teams: valida o template do manifest e, com IDs reais, gera o pacote instalável (manifest + ícones).
//   node scripts/teams-manifest.mjs --check
//   node scripts/teams-manifest.mjs --build --app-id <GUID> --bot-id <GUID> --developer-name "<nome>" \
//        --website https://... --privacy https://... --terms https://...
// Sem dependências externas. Não instala nada no tenant nem chama APIs da Microsoft.
// A validação contra o JSON Schema oficial (v1.19) e no Developer Portal é passo humano documentado.
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(root, 'connectors', 'teams', 'appPackage');
const outDir = path.join(root, 'connectors', 'teams', 'build');
const template = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.template.json'), 'utf8'));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** Regras estruturais conhecidas do manifest v1.19 (subconjunto usado aqui). */
export function validateManifest(m, { allowPlaceholders }) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(m.manifestVersion === '1.19', 'manifestVersion deve ser 1.19');
  need(/^\d+\.\d+\.\d+$/.test(m.version ?? ''), 'version deve ser semver x.y.z');
  need(typeof m.name?.short === 'string' && m.name.short.length >= 1 && m.name.short.length <= 30, 'name.short: 1–30 caracteres');
  need(typeof m.name?.full === 'string' && m.name.full.length <= 100, 'name.full: até 100 caracteres');
  need(typeof m.description?.short === 'string' && m.description.short.length <= 80, 'description.short: até 80 caracteres');
  need(typeof m.description?.full === 'string' && m.description.full.length <= 4000, 'description.full: até 4000 caracteres');
  need(/^#[0-9a-f]{6}$/i.test(m.accentColor ?? ''), 'accentColor: #RRGGBB');
  need(m.icons?.color === 'color.png' && m.icons?.outline === 'outline.png', 'icons: color.png e outline.png');
  need(Array.isArray(m.bots) && m.bots.length === 1, 'exatamente um bot');
  for (const b of m.bots ?? []) {
    need(Array.isArray(b.scopes) && b.scopes.every((s) => ['personal', 'team', 'groupChat'].includes(s)), 'bot.scopes inválidos');
    for (const cl of b.commandLists ?? []) {
      need(cl.commands.length <= 10, 'no máximo 10 comandos por lista');
      for (const c of cl.commands) {
        need(c.title.length <= 32 && !c.title.includes('/'), `comando "${c.title}": até 32 caracteres, sem "/"`);
        need(c.description.length <= 128, `comando "${c.title}": descrição até 128 caracteres`);
      }
    }
  }
  const idOk = (v, name) => {
    if (allowPlaceholders && /^\{\{[A-Z_]+\}\}$/.test(v)) return;
    need(GUID.test(v ?? '') && !ZERO.test(v), `${name} deve ser um GUID real (não placeholder/zeros)`);
  };
  idOk(m.id, 'id (Teams app id)');
  idOk(m.bots?.[0]?.botId, 'botId (Microsoft App ID do bot)');
  for (const k of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
    const v = m.developer?.[k] ?? '';
    if (allowPlaceholders && /^\{\{[A-Z_]+\}\}$/.test(v)) continue;
    need(/^https:\/\/[^\s]+$/.test(v), `developer.${k} deve ser URL https`);
  }
  if (!(allowPlaceholders && /^\{\{[A-Z_]+\}\}$/.test(m.developer?.name ?? ''))) need((m.developer?.name ?? '').length >= 1 && (m.developer?.name ?? '').length <= 32, 'developer.name: 1–32 caracteres');
  return errs;
}

// Ícones: os da marca (scripts/brand-assets.mjs gera color.png e outline.png em appPackage) ---------------
const icons = () => ['color.png', 'outline.png'].map((n) => [n, fs.readFileSync(path.join(pkgDir, n))]);

// ZIP (método store), suficiente para o pacote do Teams -----------------------------------------
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(33, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(33, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n);
    offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

if (process.argv.includes('--check')) {
  const errs = validateManifest(template, { allowPlaceholders: true });
  if (errs.length) { console.error('Template inválido:\n- ' + errs.join('\n- ')); process.exit(1); }
  console.log('Template do manifest Teams v1.19: estrutura válida (placeholders pendentes: IDs e URLs reais).');
} else if (process.argv.includes('--build')) {
  const m = JSON.parse(JSON.stringify(template)
    .replaceAll('{{TEAMS_APP_ID}}', arg('--app-id') ?? '').replaceAll('{{BOT_ID}}', arg('--bot-id') ?? '')
    .replaceAll('{{DEVELOPER_NAME}}', arg('--developer-name') ?? '').replaceAll('{{WEBSITE_URL}}', arg('--website') ?? '')
    .replaceAll('{{PRIVACY_URL}}', arg('--privacy') ?? '').replaceAll('{{TERMS_URL}}', arg('--terms') ?? ''));
  const errs = validateManifest(m, { allowPlaceholders: false });
  if (errs.length) { console.error('Não gerado. Corrija:\n- ' + errs.join('\n- ')); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const files = [['manifest.json', Buffer.from(JSON.stringify(m, null, 2))], ...icons()];
  for (const [n, d] of files) fs.writeFileSync(path.join(outDir, n), d);
  fs.writeFileSync(path.join(outDir, 'ergon-teams-app.zip'), zip(files));
  console.log(`Pacote gerado em ${path.relative(root, outDir)} (não instalado). Valide no Developer Portal antes de instalar.`);
} else {
  console.log('Uso: --check | --build --app-id <GUID> --bot-id <GUID> --developer-name <nome> --website <https> --privacy <https> --terms <https>');
}

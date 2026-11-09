#!/usr/bin/env node
// Teams: valida o template do manifest e, com os IDs reais, gera o pacote do app (manifest + ícones).
//   node scripts/teams-manifest.mjs --check
//   node scripts/teams-manifest.mjs --build [--publico] --app-id <GUID> --bot-id <GUID> --developer-name "<nome>" \
//        --website https://... --privacy https://... --terms https://... [--valid-domain <host>]... [--version x.y.z] \
//        [--sem-permissoes] [--out <pasta>]
// --publico: o app público "Conversar com a equipe pelo Teams" (só conversa pessoal; o validador recusa outro escopo).
// --app-id: o id do app que já existe no Teams (para atualizar a mesma ficha, não criar outra); --bot-id: o Microsoft
// App ID do bot. --version: suba a cada envio à loja. --sem-permissoes: sem "identity" (o Developer Portal decide qual
// aceita: teste as duas).
// Sem dependências externas. Não instala nada no tenant nem chama APIs da Microsoft.
// A validação contra o JSON Schema oficial (v1.19) e no Developer Portal é passo humano documentado.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32 } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(root, 'connectors', 'teams', 'appPackage');
const defaultOut = path.join(root, 'connectors', 'teams', 'build');
export const template = () => JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.template.json'), 'utf8'));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const HOST = /^(?=.{1,253}$)(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Regras estruturais conhecidas do manifest v1.19 (subconjunto usado aqui). `publico`: o perfil do app público. */
export function validateManifest(m, { allowPlaceholders, publico = false }) {
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
    if (publico) {
      need(JSON.stringify(b.scopes) === '["personal"]', 'app público: bot.scopes deve ser só ["personal"] (grupos e canais ficam para depois)');
      need(b.isNotificationOnly === false, 'app público: isNotificationOnly deve ser false');
      need(b.supportsFiles === false, 'app público: supportsFiles deve ser false');
    }
    for (const cl of b.commandLists ?? []) {
      if (publico) need(JSON.stringify(cl.scopes) === '["personal"]', 'app público: commandLists.scopes deve ser só ["personal"]');
      need(cl.commands.length <= 10, 'no máximo 10 comandos por lista');
      for (const c of cl.commands) {
        need(c.title.length <= 32 && !c.title.includes('/'), `comando "${c.title}": até 32 caracteres, sem "/"`);
        need(c.description.length <= 128, `comando "${c.title}": descrição até 128 caracteres`);
      }
    }
  }
  if (publico) need(!(m.permissions ?? []).includes('messageTeamMembers'), 'app público: sem messageTeamMembers (não há envio a membros de equipe)');
  need(Array.isArray(m.validDomains) && m.validDomains.every((d) => HOST.test(d)), 'validDomains: só nomes de domínio (sem https://)');
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

/** O manifest com os valores reais (o template não muda). */
export function preencher(t, o) {
  const m = JSON.parse(JSON.stringify(t)
    .replaceAll('{{TEAMS_APP_ID}}', o.appId ?? '').replaceAll('{{BOT_ID}}', o.botId ?? '')
    .replaceAll('{{DEVELOPER_NAME}}', o.developerName ?? '').replaceAll('{{WEBSITE_URL}}', o.website ?? '')
    .replaceAll('{{PRIVACY_URL}}', o.privacy ?? '').replaceAll('{{TERMS_URL}}', o.terms ?? ''));
  if (o.version) m.version = o.version;
  if (o.validDomains?.length) m.validDomains = [...new Set(o.validDomains)];
  if (o.semPermissoes) m.permissions = [];
  return m;
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

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const todos = (name) => argv.flatMap((v, i) => (v === name && argv[i + 1] ? [argv[i + 1]] : []));
  const publico = argv.includes('--publico');
  if (argv.includes('--check')) {
    const errs = validateManifest(template(), { allowPlaceholders: true, publico: true });
    if (errs.length) { console.error('Template inválido:\n- ' + errs.join('\n- ')); return 1; }
    console.log('Template do manifest Teams v1.19: estrutura válida, perfil do app público (placeholders pendentes: IDs e URLs reais).');
    return 0;
  }
  if (argv.includes('--build')) {
    const m = preencher(template(), { appId: arg('--app-id'), botId: arg('--bot-id'), developerName: arg('--developer-name'), website: arg('--website'), privacy: arg('--privacy'),
      terms: arg('--terms'), version: arg('--version'), validDomains: todos('--valid-domain'), semPermissoes: argv.includes('--sem-permissoes') });
    const errs = validateManifest(m, { allowPlaceholders: false, publico });
    if (errs.length) { console.error('Não gerado. Corrija:\n- ' + errs.join('\n- ')); return 1; }
    const outDir = arg('--out') ? path.resolve(arg('--out')) : defaultOut;
    fs.mkdirSync(outDir, { recursive: true });
    const files = [['manifest.json', Buffer.from(JSON.stringify(m, null, 2))], ...icons()];
    for (const [n, d] of files) fs.writeFileSync(path.join(outDir, n), d);
    fs.writeFileSync(path.join(outDir, 'ergon-teams-app.zip'), zip(files));
    console.log(`Pacote gerado em ${path.relative(root, outDir) || outDir} (não instalado). Valide no Developer Portal antes de enviar à loja.`);
    return 0;
  }
  console.log('Uso: --check | --build [--publico] --app-id <GUID> --bot-id <GUID> --developer-name <nome> --website <https> --privacy <https> --terms <https> [--valid-domain <host>] [--version x.y.z] [--sem-permissoes] [--out <pasta>]');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
// Teams: valida o template do manifest e gera o pacote do app oficial do Ergon (manifest + en.json + ícones da marca).
//   node scripts/teams-manifest.mjs --check
//   node scripts/teams-manifest.mjs --build --bot-id <GUID>                       ← o pacote oficial (só precisa disto)
//   node scripts/teams-manifest.mjs --build --bot-id <GUID> [--app-id <GUID>] [--developer-name "<nome>"] \
//        [--website https://...] [--privacy https://...] [--terms https://...] [--valid-domain <host>]... \
//        [--version x.y.z] [--sem-permissoes] [--out <pasta>]
// --bot-id: o Microsoft App ID do bot (Application (client) ID do registro no Entra). --app-id: o id do app no Teams;
// sem ele, é o próprio App ID do bot (o relé informa esse id ao Ergon para o "Abrir no Teams"). Sem os demais, valem os
// do app oficial (OFICIAL: Ergon, ergonworld.com, /privacidade, /termos). --version: suba a cada envio à loja.
// --sem-permissoes: sem "identity" (o Developer Portal decide qual aceita: teste as duas). --publico: aceito por
// compatibilidade; o pacote sempre sai no perfil do app público (só conversa pessoal; o validador recusa outro escopo).
// Saída: connectors/teams/build/ergon-teams-app.zip (fora do Git), ou --out.
// Sem dependências externas. Não instala nada no tenant nem chama APIs da Microsoft.
// A validação contra o JSON Schema oficial (v1.19) e no Developer Portal é passo humano documentado.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { crc32 } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(root, 'connectors', 'teams', 'appPackage');
const defaultOut = path.join(root, 'connectors', 'teams', 'build');
export const template = () => JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.template.json'), 'utf8'));
/** As traduções do pacote (localizationInfo.additionalLanguages): arquivo → conteúdo. */
export const traducoes = () => Object.fromEntries((template().localizationInfo?.additionalLanguages ?? []).map((l) => [l.file, JSON.parse(fs.readFileSync(path.join(pkgDir, l.file), 'utf8'))]));
export const ZIP_PADRAO = path.join(defaultOut, 'ergon-teams-app.zip');

/** O app oficial do Ergon: o que vale quando o --build não diz outra coisa. */
export const OFICIAL = Object.freeze({
  developerName: 'Ergon',
  website: 'https://ergonworld.com',
  privacy: 'https://ergonworld.com/privacidade',
  terms: 'https://ergonworld.com/termos',
  validDomains: Object.freeze(['ergonworld.com', 'api.ergonworld.com']),
});

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
  const li = m.localizationInfo;
  if (li) {
    need(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(li.defaultLanguageTag ?? ''), 'localizationInfo.defaultLanguageTag: etiqueta de idioma (ex.: pt-br)');
    for (const l of li.additionalLanguages ?? []) {
      need(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(l.languageTag ?? '') && l.languageTag !== li.defaultLanguageTag, `idioma adicional "${l.languageTag}": etiqueta válida e diferente da padrão`);
      need(/^[a-z0-9-]+\.json$/i.test(l.file ?? ''), `idioma "${l.languageTag}": arquivo .json na raiz do pacote`);
    }
  }
  return errs;
}

/** Um arquivo de tradução (MicrosoftTeams.Localization v1.19): mesmos limites do manifest, só chaves conhecidas. */
export function validateLocalizacao(l, m, nome = 'tradução') {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(`${nome}: ${msg}`); };
  need(/MicrosoftTeams\.Localization\.schema\.json$/.test(l.$schema ?? ''), '$schema do arquivo de tradução');
  need(typeof l['name.short'] === 'string' && l['name.short'].length >= 1 && l['name.short'].length <= 30, 'name.short: 1–30 caracteres');
  need(typeof l['name.full'] === 'string' && l['name.full'].length <= 100, 'name.full: até 100 caracteres');
  need(typeof l['description.short'] === 'string' && l['description.short'].length <= 80, 'description.short: até 80 caracteres');
  need(typeof l['description.full'] === 'string' && l['description.full'].length <= 4000, 'description.full: até 4000 caracteres');
  for (const k of Object.keys(l)) {
    if (['$schema', 'name.short', 'name.full', 'description.short', 'description.full'].includes(k)) continue;
    const c = /^bots\[(\d+)\]\.commandLists\[(\d+)\]\.commands\[(\d+)\]\.(title|description)$/.exec(k);
    const cmd = c ? m?.bots?.[+c[1]]?.commandLists?.[+c[2]]?.commands?.[+c[3]] : null;
    need(!!cmd, `chave desconhecida ou sem comando correspondente: ${k}`);
    if (c?.[4] === 'title') need(l[k].length <= 32 && !l[k].includes('/'), `${k}: até 32 caracteres, sem "/"`);
    if (c?.[4] === 'description') need(l[k].length <= 128, `${k}: até 128 caracteres`);
  }
  return errs;
}

/** Lê um PNG (RGBA 8 bits, como os da marca): largura, altura e os pixels. */
export function lerPng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('não é PNG');
  let o = 8; let w = 0; let h = 0; let tipo = -1; let prof = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o); const t = buf.toString('ascii', o + 4, o + 8); const d = buf.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); prof = d[8]; tipo = d[9]; }
    if (t === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  if (tipo !== 6 || prof !== 8) return { w, h, rgba: null };
  const raw = zlib.inflateSync(Buffer.concat(idat)); const st = w * 4; const px = Buffer.alloc(st * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)];
    for (let x = 0; x < st; x++) {
      const v = raw[y * (st + 1) + 1 + x]; const a = x >= 4 ? px[y * st + x - 4] : 0; const b = y ? px[(y - 1) * st + x] : 0; const c = x >= 4 && y ? px[(y - 1) * st + x - 4] : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      px[y * st + x] = (v + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 0xff;
    }
  }
  return { w, h, rgba: px };
}

/** Os ícones exigidos pelo Teams: colorido 192×192; contorno 32×32, só branco sobre transparente. */
export function validateIcones(color, outline) {
  const errs = [];
  const c = lerPng(color); const o = lerPng(outline);
  if (c.w !== 192 || c.h !== 192) errs.push(`color.png deve ter 192×192 (tem ${c.w}×${c.h})`);
  if (o.w !== 32 || o.h !== 32) errs.push(`outline.png deve ter 32×32 (tem ${o.w}×${o.h})`);
  if (!o.rgba) errs.push('outline.png deve ser RGBA de 8 bits (transparente)');
  else {
    let opacos = 0; let transparentes = 0; let coloridos = 0;
    for (let i = 0; i < o.rgba.length; i += 4) {
      const [r, g, b, a] = o.rgba.subarray(i, i + 4);
      if (a === 0) transparentes++; else { opacos++; if (r < 240 || g < 240 || b < 240) coloridos++; }
    }
    if (!transparentes) errs.push('outline.png precisa de fundo transparente');
    if (!opacos) errs.push('outline.png está vazio');
    if (coloridos) errs.push('outline.png: só branco sobre transparente');
  }
  return errs;
}

/**
 * O manifest com os valores reais (o template não muda). O que não vier em `o` é o do app oficial (OFICIAL), e o id
 * do app no Teams é o próprio App ID do bot quando não vier outro.
 */
export function preencher(t, o) {
  const v = { ...OFICIAL, ...Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== null && x !== '')) };
  const botId = (v.botId ?? '').toLowerCase(); const appId = (v.appId ?? botId).toLowerCase();
  const m = JSON.parse(JSON.stringify(t)
    .replaceAll('{{TEAMS_APP_ID}}', appId).replaceAll('{{BOT_ID}}', botId)
    .replaceAll('{{DEVELOPER_NAME}}', v.developerName).replaceAll('{{WEBSITE_URL}}', v.website)
    .replaceAll('{{PRIVACY_URL}}', v.privacy).replaceAll('{{TERMS_URL}}', v.terms));
  if (v.version) m.version = v.version;
  m.validDomains = [...new Set(o.validDomains?.length ? o.validDomains : OFICIAL.validDomains)];
  if (v.semPermissoes) m.permissions = [];
  return m;
}

/** Os arquivos do pacote, na ordem do zip: manifest, traduções e ícones. Lança com a lista do que corrigir. */
export function montarPacote(o) {
  const m = preencher(template(), o);
  const trad = traducoes();
  const files = [['manifest.json', Buffer.from(JSON.stringify(m, null, 2) + '\n')], ...Object.entries(trad).map(([n, l]) => [n, Buffer.from(JSON.stringify(l, null, 2) + '\n')]), ...icons()];
  const errs = [
    ...validateManifest(m, { allowPlaceholders: false, publico: true }),
    ...Object.entries(trad).flatMap(([n, l]) => validateLocalizacao(l, m, n)),
    ...validateIcones(files.find(([n]) => n === 'color.png')[1], files.find(([n]) => n === 'outline.png')[1]),
  ];
  for (const l of m.localizationInfo?.additionalLanguages ?? []) if (!trad[l.file]) errs.push(`falta o arquivo de tradução ${l.file}`);
  if (errs.length) throw Object.assign(new Error('pacote inválido'), { erros: errs });
  return { manifest: m, files };
}

// Ícones: os da marca (scripts/brand-assets.mjs gera color.png e outline.png em appPackage) ---------------
const icons = () => ['color.png', 'outline.png'].map((n) => [n, fs.readFileSync(path.join(pkgDir, n))]);

// ZIP (método store), suficiente para o pacote do Teams -----------------------------------------
export function zip(files) {
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
  if (argv.includes('--check')) {
    const t = template();
    const errs = [...validateManifest(t, { allowPlaceholders: true, publico: true }), ...Object.entries(traducoes()).flatMap(([n, l]) => validateLocalizacao(l, t, n)),
      ...validateIcones(fs.readFileSync(path.join(pkgDir, 'color.png')), fs.readFileSync(path.join(pkgDir, 'outline.png')))];
    if (errs.length) { console.error('Template inválido:\n- ' + errs.join('\n- ')); return 1; }
    console.log('Template do manifest Teams v1.19: estrutura válida, perfil do app público, pt-BR + en, ícones 192×192 e 32×32 (pendente: o App ID do bot).');
    return 0;
  }
  if (argv.includes('--build')) {
    let pacote;
    try {
      pacote = montarPacote({ appId: arg('--app-id'), botId: arg('--bot-id'), developerName: arg('--developer-name'), website: arg('--website'), privacy: arg('--privacy'),
        terms: arg('--terms'), version: arg('--version'), validDomains: todos('--valid-domain'), semPermissoes: argv.includes('--sem-permissoes') });
    } catch (e) {
      if (!e.erros) throw e;
      console.error('Não gerado. Corrija:\n- ' + e.erros.join('\n- '));
      return 1;
    }
    const outDir = arg('--out') ? path.resolve(arg('--out')) : defaultOut;
    fs.mkdirSync(outDir, { recursive: true });
    for (const [n, d] of pacote.files) fs.writeFileSync(path.join(outDir, n), d);
    const zipPath = path.join(outDir, 'ergon-teams-app.zip');
    fs.writeFileSync(zipPath, zip(pacote.files));
    console.log(`Pacote gerado: ${zipPath}\n  app id ${pacote.manifest.id} · bot ${pacote.manifest.bots[0].botId} · versão ${pacote.manifest.version}\n  Não instalado. Valide no Developer Portal (Apps › Import app) antes de enviar ao Teams admin center ou à loja.`);
    return 0;
  }
  console.log('Uso: --check | --build --bot-id <GUID> [--app-id <GUID>] [--developer-name <nome>] [--website <https>] [--privacy <https>] [--terms <https>] [--valid-domain <host>]... [--version x.y.z] [--sem-permissoes] [--out <pasta>]');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));

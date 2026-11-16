/**
 * O pacote do app público do Teams (scripts/teams-manifest.mjs): o template passa no perfil público, o pacote sai com o
 * id do app que já existe (atualiza a mesma ficha), só conversa pessoal, comandos ajuda/desligar, sem messageTeamMembers,
 * e o validador recusa outro escopo no perfil público.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { tmpDir } from './helpers.ts';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'teams-manifest.mjs');
// a imagem de teste do Docker só leva shared/server/web: sem o script, estes testes pulam
const SEM_SCRIPT = { skip: !fs.existsSync(SCRIPT) };
const APP = '12345678-aaaa-4bbb-8ccc-1234567890ab';
const BOT = '87654321-dddd-4eee-8fff-ba0987654321';
const rodar = (...a: string[]) => execFileSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('--check: o template vale no perfil do app público', SEM_SCRIPT, () => {
  assert.match(rodar('--check'), /perfil do app público/);
});

test('--build --publico: o id do app de antes, só conversa pessoal, comandos ajuda e desligar, sem messageTeamMembers', SEM_SCRIPT, () => {
  const out = tmpDir();
  rodar('--build', '--publico', '--app-id', APP, '--bot-id', BOT, '--developer-name', 'Ergon', '--website', 'https://ergon.exemplo.com', '--privacy', 'https://ergon.exemplo.com/privacidade',
    '--terms', 'https://ergon.exemplo.com/termos', '--valid-domain', 'ergon.exemplo.com', '--version', '1.0.1', '--out', out);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.id, APP, 'atualiza a mesma ficha'); assert.equal(m.bots[0].botId, BOT); assert.equal(m.version, '1.0.1');
  assert.deepEqual(m.bots[0].scopes, ['personal']); assert.deepEqual(m.bots[0].commandLists[0].scopes, ['personal']);
  assert.deepEqual(m.bots[0].commandLists[0].commands.map((c: { title: string }) => c.title), ['ajuda', 'desligar']);
  assert.equal(m.bots[0].isNotificationOnly, false); assert.equal(m.bots[0].supportsFiles, false);
  assert.ok(!m.permissions.includes('messageTeamMembers'));
  assert.deepEqual(m.validDomains, ['ergon.exemplo.com']);
  assert.equal(m.description.short, 'Converse com a sua equipe do Ergon direto pelo Teams.');
  assert.match(m.description.full, /conversa direta/); assert.match(m.description.full, /código/); assert.match(m.description.full, /7 dias/); assert.match(m.description.full, /não lê outros chats/);
  assert.ok(fs.statSync(path.join(out, 'ergon-teams-app.zip')).size > 200);
  const sem = tmpDir();
  rodar('--build', '--publico', '--app-id', APP, '--bot-id', BOT, '--developer-name', 'Ergon', '--website', 'https://ergon.exemplo.com', '--privacy', 'https://ergon.exemplo.com/p', '--terms', 'https://ergon.exemplo.com/t', '--sem-permissoes', '--out', sem);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sem, 'manifest.json'), 'utf8')).permissions, [], 'a variante sem "identity", para testar as duas no Developer Portal');
});

test('o validador recusa escopo de grupo ou canal no perfil público, domínio com https:// e id de mentira', SEM_SCRIPT, async () => {
  const mod = await import(pathToFileURL(SCRIPT).href) as { template: () => any; validateManifest: (m: any, o: any) => string[]; preencher: (t: any, o: any) => any };
  const m = mod.preencher(mod.template(), { appId: APP, botId: BOT, developerName: 'Ergon', website: 'https://a.exemplo.com', privacy: 'https://a.exemplo.com/p', terms: 'https://a.exemplo.com/t' });
  assert.deepEqual(mod.validateManifest(m, { allowPlaceholders: false, publico: true }), []);
  const grupo = structuredClone(m); grupo.bots[0].scopes = ['personal', 'team'];
  assert.ok(mod.validateManifest(grupo, { allowPlaceholders: false, publico: true }).some((e) => /só \["personal"\]/.test(e)));
  assert.deepEqual(mod.validateManifest(grupo, { allowPlaceholders: false, publico: false }), [], 'fora do perfil público, o escopo de equipe é válido');
  const dom = structuredClone(m); dom.validDomains = ['https://a.exemplo.com'];
  assert.ok(mod.validateManifest(dom, { allowPlaceholders: false, publico: true }).some((e) => /validDomains/.test(e)));
  const zero = structuredClone(m); zero.id = '00000000-0000-0000-0000-000000000000';
  assert.ok(mod.validateManifest(zero, { allowPlaceholders: false, publico: true }).some((e) => /GUID real/.test(e)));
  const msg = structuredClone(m); msg.permissions = ['identity', 'messageTeamMembers'];
  assert.ok(mod.validateManifest(msg, { allowPlaceholders: false, publico: true }).some((e) => /messageTeamMembers/.test(e)));
});

test('--build só com o App ID do bot: o pacote oficial (Ergon, ergonworld.com, privacidade, termos), pt-BR + en e os ícones da marca', SEM_SCRIPT, async () => {
  const out = tmpDir();
  const saida = rodar('--build', '--bot-id', BOT.toUpperCase(), '--out', out);
  const zipPath = path.join(out, 'ergon-teams-app.zip');
  assert.match(saida, new RegExp(`Pacote gerado: ${zipPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.id, BOT, 'sem --app-id, o id do app no Teams é o próprio App ID do bot (o relé informa esse id ao Ergon)');
  assert.equal(m.bots[0].botId, BOT);
  assert.deepEqual(m.developer, { name: 'Ergon', websiteUrl: 'https://ergonworld.com', privacyUrl: 'https://ergonworld.com/privacidade', termsOfUseUrl: 'https://ergonworld.com/termos' });
  assert.deepEqual(m.validDomains, ['ergonworld.com', 'teams.ergonworld.com']);
  assert.equal(m.name.short, 'Ergon');
  assert.deepEqual(m.bots[0].scopes, ['personal']); assert.equal(m.bots[0].supportsFiles, false); assert.equal(m.bots[0].isNotificationOnly, false);
  assert.deepEqual(m.localizationInfo, { defaultLanguageTag: 'pt-br', additionalLanguages: [{ languageTag: 'en', file: 'en.json' }] });
  const en = JSON.parse(fs.readFileSync(path.join(out, 'en.json'), 'utf8'));
  assert.equal(en['name.short'], 'Ergon');
  assert.equal(en['description.short'], 'Chat with your Ergon team right from Teams.');
  assert.ok(en['description.short'].length <= 80 && en['description.full'].length <= 4000);
  assert.match(en['description.full'], /one-on-one chat/); assert.match(en['description.full'], /7 days/); assert.match(en['description.full'], /does not read other chats/);
  // o zip: os quatro arquivos na raiz (sem pasta), cada um igual ao gravado ao lado
  const zip = fs.readFileSync(zipPath);
  const nomes: string[] = [];
  for (let o = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); o >= 0; o = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), o + 4)) nomes.push(zip.toString('utf8', o + 46, o + 46 + zip.readUInt16LE(o + 28)));
  assert.deepEqual(nomes, ['manifest.json', 'en.json', 'color.png', 'outline.png']);
  for (const n of nomes) assert.ok(zip.includes(fs.readFileSync(path.join(out, n))), `${n} no zip`);
  const mod = await import(pathToFileURL(SCRIPT).href) as { lerPng: (b: Buffer) => { w: number; h: number }; ZIP_PADRAO: string };
  assert.deepEqual([mod.lerPng(fs.readFileSync(path.join(out, 'color.png'))).w, mod.lerPng(fs.readFileSync(path.join(out, 'color.png'))).h], [192, 192]);
  assert.deepEqual([mod.lerPng(fs.readFileSync(path.join(out, 'outline.png'))).w, mod.lerPng(fs.readFileSync(path.join(out, 'outline.png'))).h], [32, 32]);
  assert.match(mod.ZIP_PADRAO, /connectors[\\/]teams[\\/]build[\\/]ergon-teams-app\.zip$/, 'sem --out: o caminho conhecido (fora do Git)');
});

test('--build sem o App ID do bot não gera nada; tradução e ícones fora das regras são recusados', SEM_SCRIPT, async () => {
  const out = tmpDir();
  assert.throws(() => rodar('--build', '--out', out), /GUID real/);
  assert.ok(!fs.existsSync(path.join(out, 'ergon-teams-app.zip')));
  const mod = await import(pathToFileURL(SCRIPT).href) as {
    template: () => any; traducoes: () => Record<string, any>; preencher: (t: any, o: any) => any; validateLocalizacao: (l: any, m: any, n?: string) => string[]; validateIcones: (c: Buffer, o: Buffer) => string[];
  };
  const m = mod.preencher(mod.template(), { botId: BOT });
  const en = mod.traducoes()['en.json'];
  assert.deepEqual(mod.validateLocalizacao(en, m, 'en.json'), []);
  assert.ok(mod.validateLocalizacao({ ...en, 'description.short': 'x'.repeat(81) }, m).some((e) => /description\.short/.test(e)));
  assert.ok(mod.validateLocalizacao({ ...en, 'bots[0].commandLists[0].commands[5].title': 'help' }, m).some((e) => /sem comando/.test(e)));
  assert.ok(mod.validateLocalizacao({ ...en, 'developer.name': 'Outro' }, m).some((e) => /chave desconhecida/.test(e)));
  const { png } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'png.mjs')).href) as { png: (w: number, h: number, rgba: Buffer) => Buffer };
  const cor = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'connectors', 'teams', 'appPackage', 'color.png'));
  const contorno = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'connectors', 'teams', 'appPackage', 'outline.png'));
  assert.deepEqual(mod.validateIcones(cor, contorno), []);
  const azul = Buffer.alloc(32 * 32 * 4); for (let i = 0; i < 32 * 32; i++) if (i % 2) azul.writeUInt32BE(0x1d184bff, i * 4);
  assert.ok(mod.validateIcones(cor, png(32, 32, azul)).some((e) => /só branco/.test(e)), 'contorno colorido');
  assert.ok(mod.validateIcones(png(96, 96, Buffer.alloc(96 * 96 * 4, 255)), contorno).some((e) => /192×192/.test(e)));
  assert.ok(mod.validateIcones(cor, png(32, 32, Buffer.alloc(32 * 32 * 4, 255))).some((e) => /transparente/.test(e)), 'contorno sem transparência');
});

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

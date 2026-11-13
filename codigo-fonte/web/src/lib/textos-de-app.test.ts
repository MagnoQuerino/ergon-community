// Os textos de um aplicativo do catálogo das Conexões no idioma da tela (lib/textos-de-app.ts): GoHighLevel em
// português e em inglês, e o português igual ao que o servidor manda (quem tem a tela antiga lê o mesmo texto).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { pt } from '../i18n/pt/index.ts';
import { en } from '../i18n/en/index.ts';
import { noIdioma, TEXTOS_DE_APP } from './textos-de-app.ts';
import type { Integration } from './types.ts';

const tDe = (d: Record<string, Record<string, unknown>>) => (k: string) => { const i = k.indexOf('.'); return String(d[k.slice(0, i)][k.slice(i + 1)]); };
const GHL: Integration = {
  kind: 'gohighlevel', name: 'GoHighLevel (LeadConnector)', auth: 'token', group: 'vendas', about: 'do servidor', tasks: false, site: 'gohighlevel.com', soon: null,
  help: { url: 'https://help.gohighlevel.com/x', steps: 'passos do servidor', extras: [{ rotulo: 'link do servidor', url: 'https://help.gohighlevel.com/x' }] },
  fields: [{ name: 'location', label: 'ID', secret: false, placeholder: '' }, { name: 'token', label: 'Chave', secret: true, placeholder: '' }, { name: 'outro', label: 'Outro', secret: false, placeholder: 'x' }],
  state: 'off', account: null, connectedAt: null, lastSyncAt: null, error: null, ready: true,
} as Integration;

test('GoHighLevel em inglês: descrição, passos, campos e link', () => {
  const x = noIdioma(GHL, tDe(en as never));
  assert.match(x.about, /^A HighLevel sub-account/);
  assert.match(x.help!.steps, /Settings › Private Integrations/);
  assert.equal(x.fields[0].label, 'Sub-account ID (Location ID)');
  assert.equal(x.fields[1].placeholder, 'Paste the key here');
  assert.deepEqual(x.fields[2], GHL.fields[2], 'campo sem tradução segue como veio');
  assert.equal(x.help!.extras![0].rotulo, 'HighLevel help on private integrations');
  assert.equal((x.help!.extras![0] as { url: string }).url, 'https://help.gohighlevel.com/x', 'o endereço é o do servidor');
  assert.doesNotMatch(`${x.about} ${x.help!.steps}`, /\btoken\b|\bAPI\b|Hermes/i);
});

test('o português do dicionário é o mesmo que o servidor manda', () => {
  const servidor = fs.readFileSync(new URL('../../../server/src/services/conexoes/conectores/gohighlevel.ts', import.meta.url), 'utf8');
  const c = (pt as unknown as Record<string, Record<string, string>>).conexoes;
  for (const k of ['app.gohighlevel.sobre', 'app.gohighlevel.passos', 'app.gohighlevel.campo.location', 'app.gohighlevel.campo.token', 'app.gohighlevel.ajuda']) assert.ok(servidor.includes(c[k]), k);
});

test('aplicativo sem tradução: o mesmo objeto', () => {
  const outro = { ...GHL, kind: 'hubspot' };
  assert.equal(noIdioma(outro, tDe(en as never)), outro);
  assert.ok(Object.keys(TEXTOS_DE_APP).every((k) => /^[a-z]+$/.test(k)));
});

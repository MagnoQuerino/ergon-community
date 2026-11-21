/**
 * A cifra das conexões a caminho da nuvem (sync-crypto.ts, sealForDevice): dentro de uma mudança cifrada com a chave do
 * workspace vai um envelope para UM aparelho. Só o aparelho-nuvem abre; quem tem a chave do workspace (um colaborador,
 * outro computador) abre a mudança mas não o envelope; adulterar, copiar para outro workspace, outro remetente ou outro
 * destino: recusado. E o que conta como endereço da rede local (a conexão fica fora da nuvem).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { newWorkspaceKey, openChange, openForDevice, sealChange, sealForDevice } from '../src/world/sync-crypto.ts';
import { enderecoLocal } from '../src/world/sync-conexoes.ts';

const par = () => {
  const x = crypto.generateKeyPairSync('x25519');
  return { pub: x.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), priv: x.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
};
const ed = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const WS = `sws_${'a'.repeat(32)}`; const PC = `dev_${'1'.repeat(32)}`; const NUVEM = `dev_${'2'.repeat(32)}`;
const CRED = JSON.stringify({ itens: [{ kind: 'notion', cred: { token: 'secret_token-do-notion-da-dona-0123456789' } }] });

test('só o aparelho-nuvem abre; o colaborador, com a chave do workspace, abre a mudança mas não o envelope', () => {
  const nuvem = par(); const colaborador = par(); const outroPc = par();
  const dek = newWorkspaceKey(); // a chave do workspace: o colaborador também a tem
  const envelope = sealForDevice(Buffer.from(CRED), nuvem.pub, { ws: WS, from: PC, to: NUVEM });
  assert.ok(!envelope.includes('secret_token'), 'nada em claro no envelope');
  const mudanca = sealChange(dek, WS, { type: 'conexoes', v: 1, para: NUVEM, envelope }, { operationId: 'cx_0123456789ab', expectedVersion: 0, schemaVersion: 1, keyVersion: 1, kind: 'conexoes' }, ed());
  assert.ok(!JSON.stringify(mudanca).includes('secret_token'));
  // quem tem a chave do workspace abre a mudança…
  const corpo = openChange<{ envelope: string }>(dek, WS, mudanca);
  assert.ok(!corpo.envelope.includes('secret_token'));
  // …mas só a nuvem abre o envelope
  assert.equal(openForDevice(corpo.envelope, nuvem.priv, { ws: WS, from: PC, to: NUVEM }).toString(), CRED);
  for (const k of [colaborador, outroPc]) assert.throws(() => openForDevice(corpo.envelope, k.priv, { ws: WS, from: PC, to: NUVEM }));
});

test('adulterado, de outro workspace, de outro remetente ou para outro destino: recusado', () => {
  const nuvem = par();
  const envelope = sealForDevice(Buffer.from(CRED), nuvem.pub, { ws: WS, from: PC, to: NUVEM });
  const w = JSON.parse(envelope) as { ct: string; nonce: string; eph: string };
  // um byte trocado no cifrado, no nonce ou na chave efêmera
  const troca = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[3] ^= 1; return b.toString('base64'); };
  for (const campo of ['ct', 'nonce', 'eph'] as const) assert.throws(() => openForDevice(JSON.stringify({ ...w, [campo]: troca(w[campo]) }), nuvem.priv, { ws: WS, from: PC, to: NUVEM }), Error, campo);
  // o mesmo envelope em outro contexto (copiado para outro workspace, como se viesse de outro aparelho, ou para outro destino)
  assert.throws(() => openForDevice(envelope, nuvem.priv, { ws: `sws_${'b'.repeat(32)}`, from: PC, to: NUVEM }));
  assert.throws(() => openForDevice(envelope, nuvem.priv, { ws: WS, from: `dev_${'3'.repeat(32)}`, to: NUVEM }));
  assert.throws(() => openForDevice(envelope, nuvem.priv, { ws: WS, from: PC, to: `dev_${'4'.repeat(32)}` }));
  // formato desconhecido
  assert.throws(() => openForDevice(JSON.stringify({ ...w, v: 2 }), nuvem.priv, { ws: WS, from: PC, to: NUVEM }), /formato/);
  assert.throws(() => openForDevice(JSON.stringify({ ...w, kind: 'device' }), nuvem.priv, { ws: WS, from: PC, to: NUVEM }), /formato/);
  // e o certo abre
  assert.equal(openForDevice(envelope, nuvem.priv, { ws: WS, from: PC, to: NUVEM }).toString(), CRED);
});

test('cada envelope é único (chave efêmera nova): o mesmo conteúdo não se reconhece de fora', () => {
  const nuvem = par();
  const a = sealForDevice(Buffer.from(CRED), nuvem.pub, { ws: WS, from: PC, to: NUVEM }); const b = sealForDevice(Buffer.from(CRED), nuvem.pub, { ws: WS, from: PC, to: NUVEM });
  assert.notEqual(JSON.parse(a).eph, JSON.parse(b).eph); assert.notEqual(JSON.parse(a).ct, JSON.parse(b).ct);
});

test('endereço da rede local (a conexão fica fora da nuvem) e endereço público', () => {
  for (const v of ['localhost:8065', 'http://127.0.0.1', '10.0.0.5', 'https://192.168.1.20/mm', '172.20.1.1', '169.254.1.1', 'mattermost.local', 'chat.empresa.lan', 'intranet', 'http://[::1]:3000', 'https://[fd12::1]/', 'gitlab.internal'])
    assert.equal(enderecoLocal(v), true, v);
  for (const v of ['empresa.atlassian.net', 'https://gitlab.com', 'chat.empresa.com.br', '8.8.8.8', '172.32.0.1', '', 'https://[2001:db8::1]/'])
    assert.equal(enderecoLocal(v), false, v);
});

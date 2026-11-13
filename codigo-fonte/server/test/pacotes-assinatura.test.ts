/**
 * Assinatura dos pacotes .ergon (manifest_version 3): o texto assinado é o manifesto inteiro em JSON canônico
 * PROFUNDO (chaves em ordem em todos os níveis). Antes (versão 2) a serialização usava um replacer em lista, que
 * apagava as chaves dos objetos aninhados: os `components` (caminho, sha256, tamanho) viravam `{}` no texto assinado,
 * e dava para trocar um arquivo de um pacote "verificado" junto com o sha256 do manifesto sem a assinatura perceber.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { readZip, writeZip } from '../src/lib/zip.ts';
import * as pkg from '../src/services/ergon-package.ts';
import { buildPackage, PackageError, validatePackage } from '../src/services/ergon-package.ts';
import { harness, ORIGIN, req, setupOwner } from './helpers.ts';
import { OFFICIAL_KEYS } from '../src/services/catalog.ts';

const base = (id = 'comunidade.ana.aura') => ({ package_id: id, version: '1.0.0', title: 'Aura', summary: 'Aura suave', creator_id: 'ana', license: 'CC-BY-4.0', ergon: { min: '0.2.0' }, kind: 'fx' as const, tags: ['efeito'] });
const fx = { effects: [{ target: { all: true as const }, effect: 'aura' as const, color: '#e9c46a', intensity: 0.6 }] };
const k = crypto.generateKeyPairSync('ed25519');
const keys = { loja1: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const priv = k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const sign = { keyId: 'loja1', privatePkcs8B64: priv };

const entries = (buf: Buffer) => [...readZip(buf).entries()].map(([name, e]) => ({ name, data: e.read() }));
const manifestOf = (buf: Buffer) => JSON.parse(readZip(buf).get('manifest.json')!.read().toString('utf8'));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** troca um arquivo do pacote E atualiza sha256/tamanho no manifesto, mantendo a assinatura original */
function trocarArquivo(buf: Buffer, name: string, novo: Buffer): Buffer {
  const m = manifestOf(buf);
  const c = m.components.find((x: { path: string }) => x.path === name);
  c.sha256 = sha(novo); c.size = novo.length;
  return writeZip(entries(buf).map((e) => (e.name === 'manifest.json' ? { name: e.name, data: Buffer.from(JSON.stringify(m, null, 2)) } : e.name === name ? { name, data: novo } : e)));
}
const comManifesto = (buf: Buffer, m: unknown) => writeZip(entries(buf).map((e) => (e.name === 'manifest.json' ? { name: e.name, data: Buffer.from(JSON.stringify(m)) } : e)));
/** como a versão 2 assinava (o formato com a falha), para montar um pacote oficial antigo nos testes */
function assinarComoV2(m: Record<string, unknown>): Record<string, unknown> {
  const { signature: _s, ...rest } = m; void _s;
  const digest = crypto.createHash('sha256').update(JSON.stringify(rest, Object.keys(rest).sort())).digest();
  return { ...rest, signature: { alg: 'ed25519', key_id: 'loja1', sig: crypto.sign(null, digest, crypto.createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64') } };
}
async function pacoteV2(signed: boolean): Promise<Buffer> {
  const buf = await buildPackage(base(), fx);
  const m = { ...manifestOf(buf), manifest_version: 2 };
  delete m.signature;
  return comManifesto(buf, signed ? assinarComoV2(m) : m);
}

describe('assinatura dos pacotes (manifest_version 3)', () => {
  test('a falha da versão 2: trocar um arquivo e o sha256 de um pacote assinado não pode continuar "verificado"', async () => {
    const assinado = await buildPackage(base(), fx, {}, sign);
    assert.equal(validatePackage(assinado, keys).verified, true);
    const outroDado = Buffer.from(JSON.stringify({ effects: [{ ...fx.effects[0], color: '#000000', intensity: 1 }] }));
    const mexido = trocarArquivo(assinado, 'data/package.json', outroDado);
    let r: pkg.ValidatedPackage | null = null;
    try { r = validatePackage(mexido, keys); } catch (e) { assert.ok(e instanceof PackageError); assert.match(e.message, /assinatura não confere/); }
    assert.ok(!r?.verified, 'arquivo trocado + sha256 trocado: a assinatura tem que perceber');
  });

  test('qualquer mudança dentro dos objetos aninhados quebra a assinatura (components, ergon, tags, campo novo)', async () => {
    const assinado = await buildPackage(base(), fx, {}, sign);
    const m0 = manifestOf(assinado);
    const mudar: Array<[string, (m: Record<string, any>) => void]> = [
      ['tamanho do componente', (m) => { m.components[0].size += 1; }],
      ['tipo do componente', (m) => { m.components[0].type = 'image/png'; }],
      ['campo novo no componente', (m) => { m.components[0].extra = 'x'; }],
      ['versão mínima do Ergon', (m) => { m.ergon.min = '9.9.9'; }],
      ['etiquetas', (m) => { m.tags = ['outra']; }],
      ['dependências', (m) => { m.dependencies = [{ package_id: 'comunidade.bia.outro', range: '^1.0.0' }]; }],
      ['permissões vazias', (m) => { m.permissions = null; }],
    ];
    for (const [nome, fn] of mudar) {
      const m = structuredClone(m0); fn(m);
      assert.throws(() => validatePackage(comManifesto(assinado, m), keys), /assinatura não confere/, nome);
    }
    assert.throws(() => validatePackage(comManifesto(assinado, { ...m0, manifest_version: 4 }), keys), /manifest_version/);
  });

  test('pacote v3 íntegro é verificado; a ordem das chaves no arquivo não importa; algoritmo diferente é recusado', async () => {
    const assinado = await buildPackage(base(), fx, {}, sign);
    const m = manifestOf(assinado);
    assert.equal(m.manifest_version, 3);
    assert.equal(validatePackage(assinado, keys).verified, true);
    // mesmo manifesto com as chaves em outra ordem (inclusive nas aninhadas) continua verificado
    const reverso = (v: unknown): unknown => Array.isArray(v) ? v.map(reverso) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([a, b]) => [a, reverso(b)])) : v;
    assert.equal(validatePackage(comManifesto(assinado, reverso(m)), keys).verified, true);
    assert.throws(() => validatePackage(comManifesto(assinado, { ...m, signature: { ...m.signature, alg: 'rsa' } }), keys), /assinatura/);
    assert.throws(() => validatePackage(assinado, {}), /chave desconhecida/);
  });

  test('JSON canônico profundo: chaves em ordem em todos os níveis, listas na ordem delas', () => {
    const c = pkg.canonicalJson;
    assert.equal(c({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(c({ components: [{ path: 'a', sha256: 'X' }] }), '{"components":[{"path":"a","sha256":"X"}]}', 'o replacer em lista dava {"components":[{}]}');
    assert.notEqual(c([1, 2]), c([2, 1]));
    assert.equal(c({ a: undefined, b: null }), '{"b":null}');
    assert.throws(() => c({ a: Number.NaN }));
    assert.throws(() => c({ a: () => 1 }));
  });

  test('formato antigo: v2 sem assinatura entra como "não verificado"; v2 assinado é recusado com aviso claro', async () => {
    const livre = validatePackage(await pacoteV2(false), keys);
    assert.deepEqual([livre.manifest.manifest_version, livre.verified], [2, false]);
    const antigo = await pacoteV2(true);
    assert.throws(() => validatePackage(antigo, keys), /versão antiga/);
    // trocar só o número do formato de 2 para 3 não aproveita a assinatura antiga
    assert.throws(() => validatePackage(comManifesto(antigo, { ...manifestOf(antigo), manifest_version: 3 }), keys), /assinatura não confere/);
    // e o v3 assinado rebaixado para 2 também não passa como verificado
    const v3 = await buildPackage(base(), fx, {}, sign);
    assert.throws(() => validatePackage(comManifesto(v3, { ...manifestOf(v3), manifest_version: 2 }), keys), /versão antiga/);
  });

  test('reassinar: mesmo conteúdo no formato 3 e verificado; arquivo que não confere com o manifesto não se reassina', async () => {
    const v2 = await pacoteV2(true);
    const novo = await pkg.resignPackage(v2, sign);
    const v = validatePackage(novo, keys);
    assert.deepEqual([v.manifest.manifest_version, v.verified, v.keyId], [3, true, 'loja1']);
    const antes = new Map(entries(v2).map((e) => [e.name, e.data])); const depois = new Map(entries(novo).map((e) => [e.name, e.data]));
    assert.deepEqual([...antes.keys()].sort(), [...depois.keys()].sort());
    for (const [n, b] of antes) if (n !== 'manifest.json') assert.ok(b.equals(depois.get(n)!), n);
    const { signature: _a, ...m2 } = manifestOf(v2); const { signature: _b, ...m3 } = manifestOf(novo); void _a; void _b;
    assert.deepEqual({ ...m2, manifest_version: 3 }, m3, 'o manifesto só muda a versão e a assinatura');
    // um arquivo trocado sem atualizar o manifesto: a reassinatura recusa
    const mexido = writeZip(entries(v2).map((e) => (e.name === 'data/package.json' ? { name: e.name, data: Buffer.from('{"effects":[]}') } : e)));
    await assert.rejects(pkg.resignPackage(mexido, sign), /sha256 não confere|tamanho diferente/);
  });

  test('formato 3 só no pacote assinado: sem assinatura (buildPackage, editor) sai no 2, que as versões anteriores instalam', async () => {
    const livre = await buildPackage(base(), fx);
    assert.equal(manifestOf(livre).manifest_version, 2, 'o validador da rc.25 e de antes só aceita 2');
    assert.equal('signature' in manifestOf(livre), false);
    const v = validatePackage(livre, keys);
    assert.deepEqual([v.manifest.manifest_version, v.verified], [2, false]);
    assert.equal(manifestOf(await buildPackage(base(), fx, {}, sign)).manifest_version, 3);
  });

  test('signature null, vazia ou falsa = sem assinatura ("não verificado"), no formato 2 e no 3, como na rc.25', async () => {
    const livre = await buildPackage(base(), fx);
    const m = manifestOf(livre);
    for (const mv of [2, 3]) for (const sg of [null, '', false, 0]) {
      const v = validatePackage(comManifesto(livre, { ...m, manifest_version: mv, signature: sg }), keys);
      assert.deepEqual([v.manifest.manifest_version, v.verified, v.keyId], [mv, false, null], `v${mv} signature=${JSON.stringify(sg)}`);
    }
    // um objeto de assinatura que existe e está malformado continua recusado
    for (const sg of [{}, [], 'abc', { alg: 'ed25519', key_id: 'loja1' }, { alg: 'ed25519', key_id: 'loja1', sig: 1 }]) {
      assert.throws(() => validatePackage(comManifesto(livre, { ...m, manifest_version: 3, signature: sg }), keys), /assinatura/, JSON.stringify(sg));
    }
    // no formato 2, uma assinatura de verdade é do formato antigo (recusada)
    assert.throws(() => validatePackage(comManifesto(livre, { ...m, manifest_version: 2, signature: { alg: 'ed25519', key_id: 'loja1', sig: 'x' } }), keys), /versão antiga/);
  });

  test('reassinar os oficiais do formato 2 exige o arquivo igual ao do Git (a assinatura antiga não cobria os arquivos)', async (t) => {
    const raiz = path.resolve(import.meta.dirname, '..', '..');
    const script = path.join(raiz, 'scripts', 'catalogo', 'conferir-git.mjs');
    if (!fs.existsSync(script) || !fs.existsSync(path.join(raiz, '.git'))) return t.skip('sem scripts/ ou sem Git nesta cópia');
    const { arquivoNoGit, exigirIgualAoGit } = await import(pathToFileURL(script).href);
    const arq = path.join(raiz, 'server', 'catalogo', 'oficiais', 'aura-dourada.ergon');
    const noGit = arquivoNoGit(raiz, arq, 'HEAD');
    if (!noGit) return t.skip('arquivo ainda não está no Git');
    assert.doesNotThrow(() => exigirIgualAoGit(raiz, arq, noGit, 'HEAD'));
    // o ataque: trocar o arquivo de dentro e o sha256 no manifesto. A assinatura v2 não perceberia; o Git percebe
    const mexido = trocarArquivo(noGit, 'data/package.json', Buffer.from(JSON.stringify({ effects: [{ ...fx.effects[0], color: '#000000' }] })));
    assert.throws(() => exigirIgualAoGit(raiz, arq, mexido, 'HEAD'), /diferente do que está em HEAD/);
    assert.throws(() => exigirIgualAoGit(raiz, path.join(raiz, 'server', 'catalogo', 'oficiais', 'nao-existe.ergon'), noGit, 'HEAD'), /não está em HEAD/);
    assert.throws(() => exigirIgualAoGit(raiz, arq, noGit, '--output=x'), /referência do Git inválida/);
    assert.throws(() => exigirIgualAoGit(raiz, path.join(raiz, '..', 'fora.ergon'), noGit, 'HEAD'), /fora do repositório/);
  });

  test('instalado antes continua funcionando; o arquivo oficial antigo de novo é recusado com aviso claro', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const r = await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.aura-dourada' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      // simula um oficial instalado por uma versão anterior (manifesto v2 guardado no banco)
      const row = h.db.get<{ id: string; manifest: string }>("SELECT id, manifest FROM installed_packages WHERE package_id = 'ergon.oficial.aura-dourada'")!;
      h.db.run('UPDATE installed_packages SET manifest = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(row.manifest), manifest_version: 2 }), row.id);
      const lista = (await req(h, 'GET', '/api/packages', s)).json as Array<{ packageId: string; verified: boolean; active: boolean }>;
      assert.deepEqual(lista.map((x) => [x.packageId, x.verified, x.active]), [['ergon.oficial.aura-dourada', true, true]]);
      assert.equal(((await req(h, 'GET', '/api/packages/cosmetics', s)).json as { effects: unknown[] }).effects.length > 0, true, 'o efeito continua na cidade');
      const novo = await h.app.inject({ method: 'POST', url: '/api/packages/install', payload: await pacoteV2(true), headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/x-ergon' } });
      assert.equal(novo.statusCode, 400);
      assert.match(novo.json().message ?? JSON.stringify(novo.json()), /versão antiga do Ergon/);
      const del = await h.app.inject({ method: 'DELETE', url: `/api/packages/${row.id}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN } });
      assert.equal(del.statusCode, 200, 'desfazer o antigo continua funcionando');
    } finally { await h.close(); }
  });

  test('os pacotes oficiais que vêm com o Ergon estão no formato 3 e verificam com a chave oficial', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'catalogo', 'oficiais');
    const arqs = fs.readdirSync(dir).filter((f) => f.endsWith('.ergon'));
    assert.ok(arqs.length >= 20);
    for (const f of arqs) {
      const buf = fs.readFileSync(path.join(dir, f));
      const v = validatePackage(buf, OFFICIAL_KEYS);
      assert.deepEqual([v.manifest.manifest_version, v.verified, v.keyId], [3, true, 'ergon-oficial-2026'], f);
    }
  });

  test('os exemplos do catálogo da comunidade validam no formato 2 (sem assinatura, "não verificado"), que as versões anteriores instalam', (t) => {
    const dir = path.resolve(import.meta.dirname, '..', '..', 'community', 'publico', 'catalogo', 'pacotes', 'exemplos');
    if (!fs.existsSync(dir)) return t.skip('catálogo da comunidade fora desta cópia');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ergon'))) {
      const v = validatePackage(fs.readFileSync(path.join(dir, f)), OFFICIAL_KEYS);
      assert.deepEqual([v.manifest.manifest_version, v.verified], [2, false], f);
    }
  });
});

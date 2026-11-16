/**
 * Executáveis recebidos (pedido do dono, 16/11): aceitos e guardados, mas nunca abertos; baixar só depois do aviso, com a
 * impressão digital. Reconhecidos pelo conteúdo (um .exe renomeado para .pdf) e dentro de um .zip.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { executavel, sha256 } from '../src/lib/executavel.ts';
import { writeZip } from '../src/lib/zip.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const PE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 7)]);

describe('executáveis', () => {
  test('reconhecidos pela extensão, pelo conteúdo e dentro de um .zip; documentos comuns não', () => {
    assert.equal(executavel('instalador.exe', Buffer.from('qualquer')), 'arquivo .exe');
    assert.equal(executavel('fatura.pdf', PE), 'programa do Windows', 'renomeado continua executável');
    assert.equal(executavel('x.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0])), 'programa do Linux');
    assert.equal(executavel('rodar.txt', Buffer.from('#!/bin/sh\nrm -rf /')), 'script');
    assert.match(executavel('fotos.zip', writeZip([{ name: 'fotos/leia.txt', data: 'oi' }, { name: 'fotos/abrir.scr', data: 'x' }]))!, /pacote com abrir\.scr/);
    assert.equal(executavel('fotos.zip', writeZip([{ name: 'a.jpg', data: 'x' }])), null);
    assert.equal(executavel('contrato.pdf', Buffer.from('%PDF-1.7 ...')), null);
    assert.equal(executavel('planilha.xlsx', writeZip([{ name: 'xl/workbook.xml', data: '<x/>' }])), null);
  });

  describe('download', () => {
    let h: Harness; let s: Session;
    before(async () => { h = await harness(); s = await setupOwner(h); });
    after(async () => { await h.close(); });
    const upload = (name: string, data: Buffer) => req(h, 'POST', '/api/artifacts', s, data, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-file-type': 'application/octet-stream' });

    test('executável: aceito, mas o download mostra o aviso com a impressão digital; "Baixar mesmo assim" baixa', async () => {
      const up = await upload('fatura.pdf', PE);
      assert.equal(up.status, 201);
      const aviso = await req(h, 'GET', `/api/artifacts/${up.json.id}/download`, s);
      assert.equal(aviso.status, 200);
      assert.match(String(aviso.res.headers['content-type']), /text\/html/);
      assert.match(String(aviso.res.headers['content-security-policy']), /default-src 'none'/, 'a página de aviso não roda nada');
      assert.match(aviso.res.body, /Este arquivo é um executável/);
      assert.ok(aviso.res.body.includes(sha256(PE)));
      assert.ok(aviso.res.body.includes(`/api/artifacts/${up.json.id}/download?confirmo=1`));
      const dl = await req(h, 'GET', `/api/artifacts/${up.json.id}/download?confirmo=1`, s);
      assert.equal(dl.res.headers['content-type'], 'application/octet-stream');
      assert.match(String(dl.res.headers['content-disposition']), /^attachment;/);
      assert.ok(dl.res.rawPayload.equals(PE));
    });

    test('nome com HTML não vira código na página de aviso', async () => {
      const up = await upload('<img src=x onerror=alert(1)>.exe', PE);
      const aviso = await req(h, 'GET', `/api/artifacts/${up.json.id}/download`, s);
      assert.doesNotMatch(aviso.res.body, /<img src=x/);
    });

    test('documento comum baixa direto, como antes', async () => {
      const up = await upload('nota.txt', Buffer.from('texto comum'));
      const dl = await req(h, 'GET', `/api/artifacts/${up.json.id}/download`, s);
      assert.equal(dl.res.body, 'texto comum');
    });
  });
});

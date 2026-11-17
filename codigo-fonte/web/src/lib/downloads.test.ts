import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PEDIDO, lerAviso, lerPasta, nomeDoDownload } from './downloads.ts';

const O = 'http://localhost:8787';
const ART = `art_${'c'.repeat(32)}`;
const link = (href: string, download: string | null = null, texto = '') => ({ href, download, texto });

test('rc.33: o aviso do aplicativo só passa com a forma esperada', () => {
  assert.deepEqual(lerAviso({ id: 3, nome: 'relatorio.pdf', pasta: 'C:\\Users\\ana\\Downloads' }), { id: 3, nome: 'relatorio.pdf', pasta: 'C:\\Users\\ana\\Downloads' });
  assert.deepEqual(lerAviso({ id: -1, nome: 'a.txt' }), { id: null, nome: 'a.txt', pasta: null }, 'número estranho: sem os botões');
  assert.deepEqual(lerAviso({ id: '2', nome: 'a.txt', pasta: 7 }), { id: null, nome: 'a.txt', pasta: null });
  assert.equal(lerAviso({ id: 1 }), null);
  assert.equal(lerAviso(null), null);
  assert.deepEqual(lerPasta({ pasta: '/home/ana/Baixados', padrao: true }), { pasta: '/home/ana/Baixados', padrao: true });
  assert.equal(lerPasta({ padrao: true }), null);
});

test('rc.33: os pedidos ao aplicativo levam só o número do download, nunca um caminho', () => {
  assert.equal(PEDIDO.abrirPasta(4), '/__desktop/downloads/abrir-pasta?id=4');
  assert.equal(PEDIDO.mostrar(0), '/__desktop/downloads/mostrar?id=0');
});

test('rc.33: quais cliques são downloads do Ergon (o aviso no navegador)', () => {
  assert.equal(nomeDoDownload(link(`${O}/api/artifacts/${ART}/download`, 'vendas.xlsx'), O), 'vendas.xlsx');
  assert.equal(nomeDoDownload(link(`/api/artifacts/${ART}/download`, null, '  relatorio.pdf '), O), 'relatorio.pdf');
  assert.equal(nomeDoDownload(link(`/api/artifacts/${ART}/download?inline=1`), O), null, 'a prévia abre, não baixa');
  assert.equal(nomeDoDownload(link('blob:http://localhost:8787/1234', 'entrega.doc'), O), 'entrega.doc', 'arquivo montado na página');
  assert.equal(nomeDoDownload(link('https://exemplo.com/a.pdf', 'a.pdf'), O), null, 'outro site');
  assert.equal(nomeDoDownload(link(`${O}/#documentos`), O), null);
});

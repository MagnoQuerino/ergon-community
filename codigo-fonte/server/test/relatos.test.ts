// "Relatar um problema": esquema, limpeza (segredos, e-mails, pastas pessoais), prévia = enviado, dados técnicos
// desligados por padrão e só com as chaves fixas, falha de rede, 429 e o id recebido. Nunca o receptor de verdade:
// um receptor falso em 127.0.0.1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CHAVES_DIAGNOSTICO, DEFAULT_RELATOS_URL, limparTexto, montarRelato, relatosUrl, sistemaDe } from '../src/services/relatos.ts';
import { VERSION } from '../src/version.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

type Passo = { status: number; body?: unknown } | 'derrubar' | 'calar';
let roteiro: Passo[] = [];
const recebidos: unknown[] = [];
let receptor: http.Server; let base = '';

before(async () => {
  receptor = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (c) => { b += c; });
    rq.on('end', () => {
      const p = roteiro.shift() ?? { status: 201, body: { id: 'R-ABCDEF' } };
      if (p === 'derrubar') { rq.socket.destroy(); return; }
      if (p === 'calar') return; // nunca responde: o tempo máximo corta
      recebidos.push(JSON.parse(b));
      rs.writeHead(p.status, { 'content-type': 'application/json' }); rs.end(JSON.stringify(p.body ?? {}));
    });
  });
  await new Promise<void>((r) => receptor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receptor.address() as AddressInfo).port}/v1/relatos`;
});
after(() => { receptor.closeAllConnections(); receptor.close(); });

const PEDIDO = { categoria: 'erro', titulo: 'A conversa não abre', descricao: 'Cliquei no agente e a janela ficou em branco.' };
const ctx = { versao: '1.2.3', distribuicao: 'community' as const, instalacao: '0b9a3c1e-2f4d-4a6b-8c7d-9e0f1a2b3c4d',
  diagnostico: () => ({ versaoMotor: '1.2.3', motorAtivo: 'hermes', idioma: 'pt-BR', memoriaMb: 8192, arquitetura: 'x64' }) };

describe('relatos: limpeza e esquema', () => {
  test('segredos (as regras de scripts/scan-segredos.mjs), e-mails e pastas pessoais viram [removido]', () => {
    const chaves = ['AKIA' + 'ABCDEFGHIJKLMNOP', 'gh' + 'p_' + 'a'.repeat(36), 'sk-' + 'ant-api03-' + 'b'.repeat(40), 'xox' + 'b-1234567890-abc', 'AIza' + 'c'.repeat(35),
      'GOCSPX-' + 'd'.repeat(24), 'whsec_' + 'e'.repeat(24), 'sk_' + 'live_' + 'f'.repeat(24), 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12)];
    for (const k of chaves) assert.equal(limparTexto(`a chave ${k} vazou`), 'a chave [removido] vazou', k);
    assert.equal(limparTexto('-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'), '[removido]');
    assert.equal(limparTexto('mande para joao.silva+x@empresa.com.br hoje'), 'mande para [removido] hoje');
    assert.equal(limparTexto('abri C:\\Users\\João Silva\\Desktop\\a.txt e travou'), 'abri [removido] e travou');
    assert.equal(limparTexto('em C:\\Users\\joao deu erro'), 'em [removido] deu erro');
    assert.equal(limparTexto('log em /home/maria/.ergon/x.log, ok'), 'log em [removido] ok');
    assert.equal(limparTexto('no Mac: /Users/pedro/Library/Logs'), 'no Mac: [removido]');
    assert.equal(limparTexto('\\\\wsl$\\Ubuntu\\home\\ana\\ergon'), '\\\\wsl$\\Ubuntu[removido]');
    // o que não é pessoal fica; controle e bidi saem
    assert.equal(limparTexto('  /usr/lib/ergon e C:\\Program Files\\Ergon \u202Eok\u0007 '), '/usr/lib/ergon e C:\\Program Files\\Ergon ok');
  });

  test('cobre todas as regras de scripts/scan-segredos.mjs', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'scan-segredos.mjs'), 'utf8');
    const regras = [...src.matchAll(/\['[^']+', \/(.+?)\/g\]/g)].map((m) => m[1]);
    assert.ok(regras.length >= 10);
    const nossas = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'services', 'relatos.ts'), 'utf8');
    for (const r of regras) {
      // a nossa versão pode ir além (o corpo da chave privada, o _test_ do Stripe), nunca ficar aquém
      const base = r.replace('(?:sk|rk)_live_', '(?:sk|rk)_(?:live|test)_');
      assert.ok(nossas.includes(base), `regra do scan-segredos sem par: ${r}`);
    }
  });

  test('o relato tem só os campos do receptor; vazio fica de fora; curto demais depois da limpeza é recusado', () => {
    const r = montarRelato({ ...PEDIDO, categoria: 'erro', passos: '  ', sistema: 'windows' }, ctx);
    assert.deepEqual(Object.keys(r).sort(), ['categoria', 'descricao', 'distribuicao', 'instalacao', 'sistema', 'titulo', 'versao']);
    assert.equal(r.sistema, 'windows');
    assert.match(r.versao, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
    assert.throws(() => montarRelato({ ...PEDIDO, categoria: 'erro', titulo: ' ab\u202E ' }, ctx), /curto demais/);
    assert.equal(sistemaDe('win32'), 'windows'); assert.equal(sistemaDe('darwin'), 'macos'); assert.equal(sistemaDe('linux'), 'linux'); assert.equal(sistemaDe('aix'), 'outro');
  });

  test('dados técnicos: desligados por padrão; ligados, só as chaves fixas e códigos de erro no formato', () => {
    assert.equal(montarRelato({ ...PEDIDO, categoria: 'erro', codigosErro: ['world_offline'] }, ctx).diagnostico, undefined);
    const d = montarRelato({ ...PEDIDO, categoria: 'erro', dadosTecnicos: true, codigosErro: ['world_offline', 'Mensagem Livre', 'world_offline', 'a@b.com'] }, ctx).diagnostico!;
    assert.deepEqual(Object.keys(d).sort(), [...CHAVES_DIAGNOSTICO].sort());
    assert.deepEqual(d.codigosErro, ['world_offline']);
  });

  test('endereço: padrão o do World, vazio desliga, http só local', () => {
    assert.equal(relatosUrl({}), DEFAULT_RELATOS_URL);
    assert.equal(relatosUrl({ ERGON_RELATOS_URL: '' }), null);
    assert.equal(relatosUrl({ ERGON_RELATOS_URL: 'http://exemplo.com/v1/relatos' }), null);
    assert.equal(relatosUrl({ ERGON_RELATOS_URL: 'http://127.0.0.1:9/v1/relatos' }), 'http://127.0.0.1:9/v1/relatos');
    assert.equal(process.env.ERGON_RELATOS_URL, '', 'os testes nunca falam com o receptor de verdade');
  });
});

describe('relatos: rotas', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness({ relatosUrl: base, relatosTimeoutMs: 300 }); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('prévia = enviado, limpo, com instalação fixa (UUID v4, não a do World) e o id recebido', async () => {
    const corpo = { ...PEDIDO, descricao: 'Erro com a chave sk-' + 'proj-' + 'x'.repeat(40) + ' e o e-mail eu@casa.com em /home/eu/ergon' };
    const p = await req(h, 'POST', '/api/relatos/previa', s, corpo);
    assert.equal(p.status, 200);
    const relato = p.json.relato;
    assert.equal(relato.descricao, 'Erro com a chave [removido] e o e-mail [removido] em [removido]');
    assert.equal(relato.distribuicao, 'community');
    assert.equal(relato.versao, VERSION);
    assert.match(relato.instalacao, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(relato.diagnostico, undefined);
    assert.equal(recebidos.length, 0, 'a prévia não envia nada');
    const e = await req(h, 'POST', '/api/relatos/enviar', s, corpo);
    assert.equal(e.status, 200);
    assert.deepEqual(e.json, { id: 'R-ABCDEF' });
    assert.deepEqual(recebidos.at(-1), relato, 'o que saiu é o que a prévia mostrou');
    const p2 = await req(h, 'POST', '/api/relatos/previa', s, PEDIDO);
    assert.equal(p2.json.relato.instalacao, relato.instalacao, 'a mesma instalação de uma vez para outra');
    const world = h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'world_installation_id'")?.value;
    assert.notEqual(world, relato.instalacao);
  });

  test('dados técnicos ligados: só as chaves fixas', async () => {
    const p = await req(h, 'POST', '/api/relatos/previa', s, { ...PEDIDO, dadosTecnicos: true, codigosErro: ['world_offline'] });
    const d = p.json.relato.diagnostico;
    assert.deepEqual(Object.keys(d).sort(), [...CHAVES_DIAGNOSTICO].sort());
    assert.deepEqual(d.codigosErro, ['world_offline']);
    assert.equal(typeof d.memoriaMb, 'number');
  });

  test('esquema: campo desconhecido, categoria fora da lista e texto longo demais são recusados', async () => {
    assert.equal((await req(h, 'POST', '/api/relatos/previa', s, { ...PEDIDO, conversa: 'x' })).status, 400);
    assert.equal((await req(h, 'POST', '/api/relatos/previa', s, { ...PEDIDO, categoria: 'hack' })).status, 400);
    assert.equal((await req(h, 'POST', '/api/relatos/previa', s, { ...PEDIDO, titulo: 'x'.repeat(121) })).status, 400);
    assert.equal((await req(h, 'POST', '/api/relatos/previa', s, { ...PEDIDO, codigosErro: ['Frase livre'] })).status, 400);
    assert.equal((await req(h, 'POST', '/api/relatos/previa', null, PEDIDO)).status, 401, 'só quem entrou no Ergon');
  });

  test('429 do receptor: "tente mais tarde"; sem resposta ou conexão caída: não foi enviado; resposta estranha: recusado', async () => {
    roteiro = [{ status: 429, body: { error: 'rate_limited' } }];
    const a = await req(h, 'POST', '/api/relatos/enviar', s, PEDIDO);
    assert.equal(a.status, 429); assert.equal(a.json.error, 'relato_limite');
    roteiro = ['derrubar'];
    const b = await req(h, 'POST', '/api/relatos/enviar', s, PEDIDO);
    assert.equal(b.status, 503); assert.equal(b.json.error, 'relato_offline');
    roteiro = ['calar'];
    const n = recebidos.length;
    const c = await req(h, 'POST', '/api/relatos/enviar', s, PEDIDO);
    assert.equal(c.status, 503); assert.equal(c.json.error, 'relato_offline', 'tempo máximo');
    assert.equal(recebidos.length, n, 'sem tentar de novo sozinho');
    roteiro = [{ status: 400, body: { error: 'invalid_request' } }];
    assert.equal((await req(h, 'POST', '/api/relatos/enviar', s, PEDIDO)).json.error, 'relato_recusado');
    roteiro = [{ status: 201, body: { id: '<script>' } }];
    assert.equal((await req(h, 'POST', '/api/relatos/enviar', s, PEDIDO)).json.error, 'relato_recusado');
    roteiro = [];
  });

  test('fora do ar (porta fechada): não foi enviado', async () => {
    const h2 = await harness({ relatosUrl: 'http://127.0.0.1:9/v1/relatos' }); const s2 = await setupOwner(h2);
    try {
      const r = await req(h2, 'POST', '/api/relatos/enviar', s2, PEDIDO);
      assert.equal(r.status, 503); assert.equal(r.json.error, 'relato_offline');
    } finally { await h2.close(); }
  });

  test('sem endereço (o padrão dos testes): envio indisponível, prévia segue', async () => {
    const h3 = await harness(); const s3 = await setupOwner(h3);
    try {
      assert.deepEqual((await req(h3, 'GET', '/api/relatos', s3)).json, { disponivel: false });
      assert.equal((await req(h3, 'POST', '/api/relatos/previa', s3, PEDIDO)).status, 200);
      const r = await req(h3, 'POST', '/api/relatos/enviar', s3, PEDIDO);
      assert.equal(r.status, 503); assert.equal(r.json.error, 'relato_indisponivel');
    } finally { await h3.close(); }
    assert.deepEqual((await req(h, 'GET', '/api/relatos', s)).json, { disponivel: true });
  });
});

/**
 * Peças do protocolo Ergon ↔ serviço do Teams (contrato v1): o vetor de teste do conteúdo selado (o mesmo da suíte do
 * relé), o código de ligação, os HMACs da instância, o que fazer com cada código de fechamento, o endereço aceito, o
 * texto e os cartões que vão ao Teams, e que o recurso não depende do módulo opcional da nuvem (vai na Community).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { montarCartao, textoParaTeams, partesDoResumo } from '../src/services/teams-app/cartoes.ts';
import {
  abrirSelado, enderecoDoRele, esperaDaTentativa, gerarChaves, normalizarCodigo, personRefDe, reacaoAoFechar, selar, tokenCartao, tokenConfere, wsDoRele,
} from '../src/services/teams-app/protocolo.ts';

// ---------------------------------------------------------------- vetor de teste do selo (contrato, 2.6)
// chaves fixas montadas por partes, a partir de textos públicos (nada aqui é segredo de verdade)
const semente = (s: string) => crypto.createHash('sha256').update(['ergon-teams-relay', 'vetor', s].join('/')).digest();
const PKCS8_X25519 = Buffer.from(['302e0201', '00300506', '032b656e', '04220420'].join(''), 'hex');
const privadaX = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const INST = privadaX(semente('instalacao'));
const EFEMERA = privadaX(semente('efemera'));
const IV = semente('iv').subarray(0, 12);
const INST_PUB = crypto.createPublicKey(INST).export({ format: 'der', type: 'spki' }).toString('base64');
const INST_PRIV = INST.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const AAD = 'dlv_vetorDeTeste01|ins_vetordeteste0000000001|activity';
const PLAIN = { text: 'Olá, equipe!', teamsMessageId: '1700000000000', timestamp: '2026-11-09T12:00:00.000Z', locale: 'pt-BR', fromName: 'Maria Souza' };
const ESPERADO = {
  instPub: 'MCowBQYDK2VuAyEAZ7J8VfSnjHLYt4gfIRMyvgUDxviqU7LQZGTvlGFH5V0=',
  epk: 'MCowBQYDK2VuAyEAphIt+6SaiMTedca0ozBYHBx9hgv87lk4B/pY/ygDSUQ=',
  iv: 'jccU50Vy-Y6FTFhL',
  ct: 'SSsy46OEGG8aXzQFYXfKZjlVzf0yaumZEM6-JwgQ5Cl1KlR4tFyk4zjoNnVA73-JDys0LW81NGyiVAw61kYvUoQQcxuc2BC8GQa9OSDunXOSfSX42SAx-nMiX-81rK_hrVn812BXKIVp-21N1zdNBywndgZckd3HisurP_3WMIe_IBdVIYrJ7u5s',
  tag: 'H-Fje9lvqxclQ7UbN-Fdhg',
};

describe('conteúdo selado: vetor de teste', () => {
  test('o selo com chaves fixas dá exatamente o vetor, e o cálculo à mão (X25519 → HKDF → AES-GCM) confere', () => {
    assert.equal(INST_PUB, ESPERADO.instPub);
    const s = selar(INST_PUB, PLAIN, AAD, { efemera: EFEMERA, iv: IV });
    assert.deepEqual(s, { v: 1, epk: ESPERADO.epk, iv: ESPERADO.iv, ct: ESPERADO.ct, tag: ESPERADO.tag });
    // à mão, sem o código do Ergon
    const z = crypto.diffieHellman({ privateKey: EFEMERA, publicKey: crypto.createPublicKey(INST) });
    const salt = Buffer.concat([Buffer.from(ESPERADO.epk, 'base64').subarray(-32), Buffer.from(ESPERADO.instPub, 'base64').subarray(-32)]);
    const key = Buffer.from(crypto.hkdfSync('sha256', z, salt, Buffer.from('ergon-teams-relay/seal/v1'), 32));
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ESPERADO.iv, 'base64url'));
    d.setAAD(Buffer.from(AAD)); d.setAuthTag(Buffer.from(ESPERADO.tag, 'base64url'));
    const plain = Buffer.concat([d.update(Buffer.from(ESPERADO.ct, 'base64url')), d.final()]).toString('utf8');
    assert.equal(plain, JSON.stringify(PLAIN));
  });
  test('o vetor da suíte do relé (relay-teams/test/vetor-selo.json): o Ergon chega ao mesmo selo e abre o dele', () => {
    // os mesmos valores do arquivo do relé (chaves derivadas por SHA-256 de frases públicas; nada é segredo)
    const h = (s: string) => crypto.createHash('sha256').update(s).digest();
    const inst = privadaX(h(['ergon-teams-relay', 'vetor', 'v1', 'instalacao'].join('/')));
    const eph = privadaX(h(['ergon-teams-relay', 'vetor', 'v1', 'efemera'].join('/')));
    const iv = h(['ergon-teams-relay', 'vetor', 'v1', 'iv'].join('/')).subarray(0, 12);
    assert.equal(iv.toString('hex'), '08d7cbea4963ea7e192f9281');
    const pub = crypto.createPublicKey(inst).export({ format: 'der', type: 'spki' }).toString('base64');
    assert.equal(pub, 'MCowBQYDK2VuAyEA0tH6ci0hh5fojYw7fQ+qnFhUKJWt7c9gsohtKcKnq0I=');
    const aad = 'dlv_vetorDeTeste0000000001|ins_aaaaaaaaaaaaaaaaaaaaaaaaaa|activity';
    const plain = { text: 'Olá, equipe! Preciso do relatório até sexta.', teamsMessageId: '1731150000000', timestamp: '2026-11-09T12:00:00.000Z', locale: 'pt-BR', fromName: 'Pessoa de Teste' };
    const doRele = {
      v: 1 as const, epk: 'MCowBQYDK2VuAyEAbhuQM68g+Sww7a3sqnqhzpY1xjHRUKvz8/jEEDdCP1Q=', iv: 'CNfL6klj6n4ZL5KB',
      ct: 'CiNInCcXJO2FHcHVv_bT83XIIRvRIqmoPM4qPvITzusZYf1smb4noSNwsVAM2BG2Mgxt8IaM1BRo9yQjO7QzyX3hvyTDJAMtu7AQPfQOOk3zgZ63PWMhIb1kTGZVIdImjQsMbPZICLi3LPMp8flROciYL8CCzGZEoVMp0XbVIiNyySMjjOSLOkeaHrrFF_XH_lvNGmOcAZbp1YG2ew87CZCgzR6w4-KVQTTwHY-yBEk',
      tag: 'OS6mC1of3eT-iXGybYRbqg',
    };
    assert.deepEqual(selar(pub, plain, aad, { efemera: eph, iv }), doRele, 'o mesmo selo, byte a byte');
    assert.deepEqual(abrirSelado({ x25519: inst.export({ format: 'der', type: 'pkcs8' }).toString('base64'), x25519Public: pub }, doRele, aad), plain);
  });
  test('abre com a privada da instalação; outro contexto, etiqueta mexida ou outra instalação não abrem', () => {
    const k = { x25519: INST_PRIV, x25519Public: INST_PUB };
    const s = { v: 1 as const, ...ESPERADO };
    assert.deepEqual(abrirSelado(k, s, AAD), PLAIN);
    assert.throws(() => abrirSelado(k, s, AAD.replace('activity', 'card.action')), 'o tipo entra no contexto');
    assert.throws(() => abrirSelado(k, { ...s, tag: 'A'.repeat(22) }, AAD));
    const outra = gerarChaves();
    assert.throws(() => abrirSelado(outra, s, AAD), 'só a instalação abre');
  });
});

describe('ligação, HMACs e conexão', () => {
  test('código: maiúsculas, sem hífen nem espaços; recusa o que tem 0, O, 1, I ou L, ou tamanho errado', () => {
    assert.equal(normalizarCodigo(' abcd-efgh '), 'ABCDEFGH');
    assert.equal(normalizarCodigo('ab cd ef gh'), 'ABCDEFGH');
    for (const x of ['ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFG0', 'OBCD-EFGH', 'IBCD-EFGH', 'LBCD-EFGH', 'ABCD-EFG1', 'ÁBCD-EFGH']) assert.equal(normalizarCodigo(x), null, x);
  });
  test('personRef e o t dos cartões: 22 caracteres, estáveis, amarrados à proposta e ao vínculo', () => {
    const k = gerarChaves();
    const ref = personRefDe(k, 'usr_1');
    assert.equal(ref.length, 22); assert.equal(ref, personRefDe(k, 'usr_1')); assert.notEqual(ref, personRefDe(k, 'usr_2'));
    assert.notEqual(ref, personRefDe(gerarChaves(), 'usr_1'), 'cada instalação tem a sua chave');
    const t = tokenCartao(k, 'apr_1', 'bnd_aaaaaaaa');
    assert.ok(tokenConfere(k, 'apr_1', 'bnd_aaaaaaaa', t));
    assert.ok(!tokenConfere(k, 'apr_2', 'bnd_aaaaaaaa', t), 'outra proposta');
    assert.ok(!tokenConfere(k, 'apr_1', 'bnd_bbbbbbbb', t), 'outro vínculo');
    assert.ok(!tokenConfere(k, 'apr_1', 'bnd_aaaaaaaa', 123));
  });
  test('fechamento: o que reconecta, o que para e o que registra de novo; backoff com teto e variação', () => {
    for (const c of [1000, 1001, 4400, 4408, 1011]) assert.equal(reacaoAoFechar(c).acao, 'reconectar', String(c));
    assert.deepEqual(reacaoAoFechar(4429), { acao: 'reconectar', esperaMs: 60_000 });
    assert.deepEqual(reacaoAoFechar(4401), { acao: 'parar', motivo: 'assinatura' });
    assert.deepEqual(reacaoAoFechar(4403), { acao: 'parar', motivo: 'revogada' });
    assert.deepEqual(reacaoAoFechar(4409), { acao: 'parar', motivo: 'substituida' });
    assert.deepEqual(reacaoAoFechar(4426), { acao: 'parar', motivo: 'versao' });
    assert.deepEqual(reacaoAoFechar(4404), { acao: 'registrar_de_novo' });
    assert.equal(esperaDaTentativa(0, 1000, 60_000, () => 0.5), 1000);
    assert.equal(esperaDaTentativa(3, 1000, 60_000, () => 0.5), 8000);
    assert.equal(esperaDaTentativa(20, 1000, 60_000, () => 0.5), 60_000);
    assert.equal(esperaDaTentativa(0, 1000, 60_000, () => 0), 800); assert.equal(esperaDaTentativa(0, 1000, 60_000, () => 1), 1200);
  });
  test('endereço do serviço: https; http só no próprio computador; vira wss', () => {
    assert.equal(enderecoDoRele('https://teams-relay.exemplo.com/'), 'https://teams-relay.exemplo.com');
    assert.equal(enderecoDoRele('http://127.0.0.1:9999'), 'http://127.0.0.1:9999');
    for (const x of ['http://teams-relay.exemplo.com', 'ftp://x', 'https://u:p@x.com', 'https://x.com/?a=1', 'nada', '', null]) assert.equal(enderecoDoRele(x), null, String(x));
    assert.equal(wsDoRele('https://teams-relay.exemplo.com'), 'wss://teams-relay.exemplo.com/v1/ergon');
    assert.equal(wsDoRele('http://127.0.0.1:9'), 'ws://127.0.0.1:9/v1/ergon');
  });
});

describe('o que vai ao Teams', () => {
  const NOME = ['Her', 'mes'].join('');
  test('texto: sem linhas de controle, marcas, HTML nem o nome do motor; longo demais, corta avisando', () => {
    const t = textoParaTeams(`Feito.\n[[plano objetivo="x"]]\n{{desfazer:abc}}<b>negrito</b> pelo ${NOME}.`);
    assert.equal(t, 'Feito.\n\nnegrito pelo a equipe.');
    const longo = textoParaTeams('x'.repeat(30_000));
    assert.ok(longo.length <= 20_000); assert.match(longo, /continua no Ergon/);
  });
  test('cartão: botões dentro de ActionSet, Execute com reserva Submit, até 28 KiB mesmo com texto enorme', () => {
    const k = gerarChaves();
    const card = montarCartao({ titulo: 'Precisa de você', itens: [{ tipo: 'decisao', p: 'apr_1', ...partesDoResumo(`Enviar e-mail\n${'texto '.repeat(20_000)}`) }] }, new Map(), 'bnd_aaaaaaaa', k, 'America/Sao_Paulo');
    assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 28 * 1024);
    assert.deepEqual(card.actions, []);
    const set = (card.body as any[]).find((b) => b.type === 'ActionSet');
    assert.equal(set.actions[0].type, 'Action.Execute'); assert.equal(set.actions[0].fallback.type, 'Action.Submit');
    assert.equal(set.actions[0].data.t, tokenCartao(k, 'apr_1', 'bnd_aaaaaaaa'));
    const final = montarCartao({ titulo: 'Precisa de você', itens: [{ tipo: 'decisao', p: 'apr_1', titulo: 'x', texto: '' }] },
      new Map([['apr_1', { status: 'applied', decidedAt: '2026-11-09T13:12:00.000Z' }]]), 'bnd_aaaaaaaa', k, 'America/Sao_Paulo');
    assert.ok(!(final.body as any[]).some((b) => b.type === 'ActionSet'));
    assert.ok((final.body as any[]).some((b) => b.text === 'Aprovado por você às 10h12.'), JSON.stringify(final.body));
  });
});

describe('edição Community', () => {
  const raiz = path.resolve(import.meta.dirname, '..', '..');
  test('o recurso não importa nada do módulo opcional da nuvem nem depende do endereço dele', () => {
    const dir = path.join(raiz, 'server', 'src', 'services', 'teams-app');
    for (const f of fs.readdirSync(dir)) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(s, /from ['"](?:\.\.?\/)+(?:\.\.\/)*world\/|import\(['"][^'"]*world\//, f);
      // o nome da variável montado por partes: a exportação pública recusa arquivos com ele escrito por inteiro
      assert.doesNotMatch(s, new RegExp(['ERGON', 'WORLD', 'URL'].join('_')), f);
    }
  });
  // o exportador só existe no repositório privado (a cópia pública não leva scripts/community)
  const exportador = path.join(raiz, 'scripts', 'community', 'exportar.mjs');
  test('a exportação pública leva o lado do Ergon (server/) e não leva o serviço do Teams (relay-teams/)', { skip: !fs.existsSync(exportador) }, () => {
    const exp = fs.readFileSync(exportador, 'utf8');
    const permitido = exp.slice(exp.indexOf('const PERMITIDO'), exp.indexOf('];', exp.indexOf('const PERMITIDO')));
    assert.match(permitido, /'server\/'/);
    assert.doesNotMatch(permitido, /relay-teams/);
  });
  test('nada de "o nome do motor" nos textos do recurso, nem nomes internos', () => {
    const proibidas = new RegExp(['Her' + 'mes', 'M' + 'G3', 'am' + 'agno', 'fund' + 'ador'].join('|'));
    const arquivos = [...fs.readdirSync(path.join(raiz, 'server', 'src', 'services', 'teams-app')).map((f) => path.join(raiz, 'server', 'src', 'services', 'teams-app', f)),
      path.join(raiz, 'web', 'src', 'views', 'ConexoesView.tsx'), path.join(raiz, 'connectors', 'teams', 'appPackage', 'manifest.template.json')];
    for (const f of arquivos) {
      // só as frases (entre aspas) contam: a expressão que tira o nome do motor das respostas é montada por partes
      const frases = fs.readFileSync(f, 'utf8').match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
      for (const x of frases) assert.doesNotMatch(x, proibidas, `${path.basename(f)}: ${x.slice(0, 80)}`);
    }
  });
});

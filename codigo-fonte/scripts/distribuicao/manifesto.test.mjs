// Recusas do manifesto de versão (D2): tudo o que o cliente precisa rejeitar SEM executar nada.
//   node --test scripts/distribuicao/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assinar, verificarManifesto, conferirArquivo, compararVersoes, origemPermitida, seguranca, segurancaMinima, recentesDoCanal, RECENTES, sha256, Recusa } from './manifesto.mjs';

const novaChave = (keyId) => {
  const k = crypto.generateKeyPairSync('ed25519');
  return { keyId, privatePkcs8B64: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publica: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const A = novaChave('teste-a'), B = novaChave('teste-b');
const chaves = { [A.keyId]: { publica: A.publica } };
const AGORA = new Date('2026-10-27T12:00:00Z');
const arquivo = Buffer.from('conteúdo do pacote local');
const D = (c) => `sha256:${c.repeat(64)}`;

const base = (mud = {}) => ({
  formato: 1, produto: 'ergon', edicao: 'community', canal: 'estavel', versao: '1.0.2', sequencia: 1000,
  emitidoEm: '2026-10-27T10:00:00Z', validoAte: '2027-01-25T10:00:00Z',
  componentes: {
    core: { tipo: 'oci', imagem: 'ghcr.io/dono/ergon-community', versao: '1.0.2', digest: D('a'), plataformas: { amd64: D('b'), arm64: D('c') } },
    'pacote-local': { tipo: 'arquivo', url: 'https://github.com/dono/ergon-community/releases/download/v1.0.2/ergon-local-1.0.2.zip', sha256: sha256(arquivo), tamanho: arquivo.length },
  },
  ...mud,
});
const empacotar = (m, chave = A) => { const bytes = Buffer.from(JSON.stringify(m, null, 2)); return { bytes, sig: Buffer.from(assinar(bytes, chave)) }; };
const opts = (o = {}) => ({ chaves, edicao: 'community', canal: 'estavel', agora: AGORA, ...o });
const recusa = (fn, codigo) => assert.throws(fn, (e) => e instanceof Recusa && e.codigo === codigo, `esperava ${codigo}`);

test('manifesto correto é aceito', () => {
  const { bytes, sig } = empacotar(base());
  assert.equal(verificarManifesto(bytes, sig, opts()).versao, '1.0.2');
});

test('um byte editado depois de assinar: recusado', () => {
  const { bytes, sig } = empacotar(base());
  const editado = Buffer.from(bytes.toString().replace('"1.0.2"', '"1.0.3"'));
  recusa(() => verificarManifesto(editado, sig, opts()), 'ASSINATURA');
  const troca = Buffer.from(bytes.toString().replace(sha256(arquivo), sha256(Buffer.from('outro'))));
  recusa(() => verificarManifesto(troca, sig, opts()), 'ASSINATURA');
});

test('assinatura de chave fora do chaveiro, ilegível, vazia ou revogada: recusada', () => {
  const { bytes, sig } = empacotar(base(), B);
  recusa(() => verificarManifesto(bytes, sig, opts()), 'CHAVE_DESCONHECIDA');
  // B assina mas finge ser A
  const fingida = Buffer.from(JSON.stringify({ ...JSON.parse(sig), keyId: A.keyId }));
  recusa(() => verificarManifesto(bytes, fingida, opts()), 'ASSINATURA');
  recusa(() => verificarManifesto(bytes, Buffer.from('lixo'), opts()), 'ASSINATURA');
  recusa(() => verificarManifesto(bytes, Buffer.from('{}'), opts()), 'ASSINATURA');
  recusa(() => verificarManifesto(bytes, Buffer.from(JSON.stringify({ keyId: '__proto__', assinatura: 'x' })), opts()), 'ASSINATURA');
  recusa(() => verificarManifesto(bytes, Buffer.from(JSON.stringify({ keyId: 'constructor', assinatura: 'x' })), opts()), 'CHAVE_DESCONHECIDA');
  const ok = empacotar(base());
  recusa(() => verificarManifesto(ok.bytes, ok.sig, opts({ chaves: { [A.keyId]: { publica: A.publica, revogadaEm: '2026-10-01T00:00:00Z' } } })), 'CHAVE_REVOGADA');
});

test('rotação: chave nova no chaveiro aceita; a antiga continua até ser revogada', () => {
  const dois = { ...chaves, [B.keyId]: { publica: B.publica } };
  for (const k of [A, B]) { const { bytes, sig } = empacotar(base(), k); assert.ok(verificarManifesto(bytes, sig, opts({ chaves: dois }))); }
});

test('edição e canal errados: recusados', () => {
  const p = empacotar(base({ edicao: 'proprietary' }));
  recusa(() => verificarManifesto(p.bytes, p.sig, opts()), 'EDICAO');
  const t = empacotar(base({ canal: 'teste', versao: '1.0.2-rc.1' }));
  recusa(() => verificarManifesto(t.bytes, t.sig, opts()), 'CANAL');
  assert.ok(verificarManifesto(t.bytes, t.sig, opts({ canal: 'teste' })));
});

test('metadados vencidos ou emitidos no futuro: recusados', () => {
  const v = empacotar(base({ validoAte: '2026-10-27T11:00:00Z' }));
  recusa(() => verificarManifesto(v.bytes, v.sig, opts()), 'EXPIRADO');
  const f = empacotar(base({ emitidoEm: '2026-10-28T10:00:00Z' }));
  recusa(() => verificarManifesto(f.bytes, f.sig, opts()), 'FORMATO');
});

test('repetição de manifesto antigo e rebaixamento: recusados', () => {
  const { bytes, sig } = empacotar(base());
  recusa(() => verificarManifesto(bytes, sig, opts({ estado: { ultimaSequencia: 1000 } })), 'REPETICAO');
  recusa(() => verificarManifesto(bytes, sig, opts({ estado: { ultimaSequencia: 2000 } })), 'REPETICAO');
  recusa(() => verificarManifesto(bytes, sig, opts({ estado: { ultimaSequencia: 1, versaoInstalada: '1.1.0' } })), 'REBAIXAMENTO');
  assert.ok(verificarManifesto(bytes, sig, opts({ estado: { ultimaSequencia: 999, versaoInstalada: '1.0.1' } })));
  // a mesma versão republicada com sequência nova (reparo) é aceita
  assert.ok(verificarManifesto(bytes, sig, opts({ estado: { ultimaSequencia: 999, versaoInstalada: '1.0.2' } })));
});

test('cliente antigo demais para a versão: recusado', () => {
  const { bytes, sig } = empacotar(base({ clienteMinimo: '1.2.0' }));
  recusa(() => verificarManifesto(bytes, sig, opts({ versaoCliente: '1.1.9' })), 'CLIENTE_ANTIGO');
  assert.ok(verificarManifesto(bytes, sig, opts({ versaoCliente: '1.2.0' })));
});

test('origem fora da lista, http, credencial na URL ou porta: recusados mesmo assinados', () => {
  for (const url of ['https://exemplo.com/ergon.zip', 'http://github.com/x.zip', 'https://user:senha@github.com/x.zip', 'https://github.com:8443/x.zip', 'https://github.com.exemplo.com/x.zip']) {
    const m = base(); m.componentes['pacote-local'].url = url;
    const { bytes, sig } = empacotar(m);
    recusa(() => verificarManifesto(bytes, sig, opts()), 'ORIGEM');
  }
  const m = base(); m.componentes.core.imagem = 'docker.io/dono/ergon';
  const { bytes, sig } = empacotar(m);
  recusa(() => verificarManifesto(bytes, sig, opts()), 'FORMATO');
  assert.ok(origemPermitida('https://release-assets.githubusercontent.com/a?b=c'));
});

test('forma inválida (assinada) recusada: digest, tipo, formato futuro', () => {
  const casos = [
    (m) => { m.componentes.core.digest = 'sha256:abc'; },
    (m) => { m.componentes.core.tipo = 'script'; },
    (m) => { m.formato = 2; },
    (m) => { m.sequencia = -1; },
    (m) => { m.componentes = {}; },
    (m) => { m.componentes['pacote-local'].tamanho = 0; },
  ];
  for (const mudar of casos) { const m = base(); mudar(m); const { bytes, sig } = empacotar(m); recusa(() => verificarManifesto(bytes, sig, opts()), 'FORMATO'); }
});

test('arquivo baixado truncado, maior ou corrompido: recusado', () => {
  const c = base().componentes['pacote-local'];
  conferirArquivo(arquivo, c);
  recusa(() => conferirArquivo(arquivo.subarray(0, 10), c), 'TAMANHO');
  recusa(() => conferirArquivo(Buffer.concat([arquivo, Buffer.from('x')]), c), 'TAMANHO');
  const mexido = Buffer.from(arquivo); mexido[3] ^= 1;
  recusa(() => conferirArquivo(mexido, c), 'HASH');
});

test('ordem das versões, inclusive pré-versões', () => {
  const ordem = ['1.0.0', '1.0.1-rc.1', '1.0.1-rc.2', '1.0.1-rc.10', '1.0.1', '1.0.10', '1.1.0', '2.0.0'];
  for (let i = 1; i < ordem.length; i++) assert.equal(compararVersoes(ordem[i - 1], ordem[i]), -1, `${ordem[i - 1]} < ${ordem[i]}`);
  assert.equal(compararVersoes('1.0.1', '1.0.1'), 0);
});

test('atualização de segurança em qualquer idioma das notas: o campo explícito e a linha em inglês', () => {
  const motivo = 'fecha uma falha no acesso ao cofre do motor.';
  // o campo explícito (comentário, que a página e o aplicativo não mostram), em qualquer idioma das notas
  assert.deepEqual(seguranca(`## 1.1.0\n<!-- seguranca: ${motivo} -->\n- New features.`), { obrigatoria: true, motivo });
  assert.deepEqual(seguranca(`## 1.1.0\n<!-- security: closes a flaw in the engine vault -->\n- New features.`), { obrigatoria: true, motivo: 'closes a flaw in the engine vault' });
  assert.deepEqual(seguranca(`<!--\n  segurança:\n  ${motivo}\n-->`), { obrigatoria: true, motivo }, 'o comentário pode ocupar várias linhas');
  // a linha das notas em inglês
  assert.deepEqual(seguranca('## 1.1.0\n- **Security (required):** closes a flaw in the engine vault.\n- Other improvements.'), { obrigatoria: true, motivo: 'closes a flaw in the engine vault.' });
  assert.deepEqual(seguranca('- Security (mandatory): closes a flaw in the engine vault.'), { obrigatoria: true, motivo: 'closes a flaw in the engine vault.' });
  // o português de sempre continua
  assert.deepEqual(seguranca(`- **Segurança (obrigatória):** ${motivo}`), { obrigatoria: true, motivo });
  // nada disso: atualização comum; motivo curto não vale
  assert.equal(seguranca('## 1.1.0\n- Security improvements in the login.'), null, '"security" solto não é obrigatório');
  assert.equal(seguranca('<!-- security: curto -->'), null);
  assert.equal(seguranca('<!-- outra marca: qualquer coisa longa o bastante -->'), null);
  // o piso carregado adiante também enxerga as versões marcadas em inglês
  assert.equal(segurancaMinima([{ tag_name: 'v1.1.0-rc.26', body: '<!-- security: closes a flaw in the engine vault -->' }, { tag_name: 'v1.1.0-rc.27', body: '- Improvements.' }], '1.1.0-rc.27'), '1.1.0-rc.26');
});

test('o exemplo do campo nas notas (entre crases, num bloco de código, no meio da frase) não marca a versão como obrigatória', () => {
  const exemplo = '<!-- security: reason for the update -->';
  assert.equal(seguranca(`## 1.1.0\n- New: mark a release as required with \`${exemplo}\` in the notes.`), null, 'entre crases');
  assert.equal(seguranca(`## 1.1.0\n- Como marcar:\n\n\`\`\`\n${exemplo}\n\`\`\`\n- Outras melhorias.`), null, 'bloco de código');
  assert.equal(seguranca('## 1.1.0\n```md\n- **Security (required):** closes a flaw in the engine vault.\n```'), null, 'a linha dentro do bloco também não');
  assert.equal(seguranca(`- Use ${exemplo} para marcar.`), null, 'no meio da frase');
  assert.equal(segurancaMinima([{ tag_name: 'v1.1.0-rc.26', body: `- Novo: o campo \`${exemplo}\`.` }, { tag_name: 'v1.1.0-rc.27', body: '- Improvements.' }], '1.1.0-rc.27'), null, 'nem o piso');
  // numa linha só dele, depois de um exemplo entre crases, continua valendo
  assert.deepEqual(seguranca(`- O campo \`${exemplo}\` é novo.\n\n  <!-- security: closes a flaw in the engine vault -->\n`), { obrigatoria: true, motivo: 'closes a flaw in the engine vault' });
});

test('atualização de segurança: lida das novidades, assinada no manifesto; forma errada recusada', () => {
  assert.deepEqual(seguranca('## 1.0.3\n- **Segurança (obrigatória):** fecha uma falha no acesso ao cofre do motor.\n- Outras melhorias.'),
    { obrigatoria: true, motivo: 'fecha uma falha no acesso ao cofre do motor.' });
  assert.equal(seguranca('## 1.0.3\n- Melhorias na Central.'), null, 'sem a linha: atualização comum');
  assert.equal(seguranca('- Segurança (obrigatória): curto'), null, 'motivo curto demais não vale');
  const { bytes, sig } = empacotar(base({ seguranca: { obrigatoria: true, motivo: 'fecha uma falha no acesso ao cofre do motor.' } }));
  assert.equal(verificarManifesto(bytes, sig, opts()).seguranca.obrigatoria, true);
  for (const s of [{ obrigatoria: false, motivo: 'motivo longo o bastante' }, { obrigatoria: true }, { obrigatoria: true, motivo: 'x'.repeat(401) }, 'sim']) {
    const e = empacotar(base({ seguranca: s }));
    recusa(() => verificarManifesto(e.bytes, e.sig, opts()), 'FORMATO');
  }
});

test('piso de segurança carregado adiante: a de segurança mais nova até esta versão; forma errada recusada', () => {
  const SEG = '- **Segurança (obrigatória):** fecha uma falha no acesso ao cofre do motor.';
  const publicadas = [
    { tag_name: 'v1.1.0-rc.27', body: '- Melhorias.' },
    { tag_name: 'v1.1.0-rc.26', body: SEG },
    { tag_name: 'v1.1.0-rc.25', body: '- Melhorias.' },
    { tag_name: 'v1.1.0-rc.22', body: SEG },
    { tag_name: 'v1.1.0-rc.28', body: SEG }, // depois da versão do manifesto: não conta
    { tag_name: 'v1.1.0-rc.29', body: SEG, draft: true },
    { tag_name: 'qualquer', body: SEG },
  ];
  assert.equal(segurancaMinima(publicadas, '1.1.0-rc.27'), '1.1.0-rc.26', 'a rc.27 comum carrega o piso da rc.26');
  assert.equal(segurancaMinima(publicadas, '1.1.0-rc.26'), '1.1.0-rc.26', 'inclusive a própria');
  assert.equal(segurancaMinima(publicadas, '1.1.0-rc.25'), '1.1.0-rc.22');
  assert.equal(segurancaMinima(publicadas, '1.1.0-rc.21'), null);
  assert.equal(segurancaMinima(publicadas, '1.1.0'), '1.1.0-rc.28', 'a final vem depois das pré-versões');
  const ok = empacotar(base({ segurancaMinima: '1.0.1' }));
  assert.equal(verificarManifesto(ok.bytes, ok.sig, opts()).segurancaMinima, '1.0.1');
  for (const p of ['1.0', 1, '1.0.3']) {
    const e = empacotar(base({ segurancaMinima: p }));
    recusa(() => verificarManifesto(e.bytes, e.sig, opts()), 'FORMATO');
  }
});

test('recentes: as versões publicadas no canal até esta, a mais nova primeiro (o Ergon Desktop volta só para as duas anteriores à instalada)', () => {
  const publicadas = [
    { tag_name: 'v1.1.0-rc.25', prerelease: true }, { tag_name: 'v1.1.0-rc.26', prerelease: true }, { tag_name: 'v1.1.0-rc.24', prerelease: true },
    { tag_name: 'v1.1.0-rc.28', prerelease: true }, // depois da versão do manifesto: não entra
    { tag_name: 'v1.1.0-rc.27', prerelease: true, draft: true }, // rascunho: não entra
    { tag_name: 'canal-teste', prerelease: true }, { tag_name: 'v1.0.1' }, { tag_name: 'v1.1.0-rc.26', prerelease: true }, // repetida: uma vez só
  ];
  assert.deepEqual(recentesDoCanal(publicadas, '1.1.0-rc.27', 'teste'), ['1.1.0-rc.26', '1.1.0-rc.25', '1.1.0-rc.24', '1.0.1']);
  assert.deepEqual(recentesDoCanal(publicadas, '1.1.0', 'estavel'), ['1.0.1'], 'o estável só vê as finais');
  const muitas = Array.from({ length: 30 }, (_, i) => ({ tag_name: `v1.1.0-rc.${i + 1}`, prerelease: true }));
  const r = recentesDoCanal(muitas, '1.1.0-rc.30', 'teste');
  assert.equal(r.length, RECENTES); assert.equal(r[0], '1.1.0-rc.30'); assert.equal(r.at(-1), '1.1.0-rc.19', 'número, não texto');
  // a forma conferida na verificação
  const ok = empacotar(base({ recentes: ['1.0.1', '1.0.0'] }));
  assert.deepEqual(verificarManifesto(ok.bytes, ok.sig, opts()).recentes, ['1.0.1', '1.0.0']);
  for (const recentes of [[], 'sim', ['1.0.0', '1.0.1'], ['1.0.1', '1.0.1'], ['9.9.9'], ['1.0'], Array.from({ length: 13 }, (_, i) => `0.0.${i}`)]) {
    const e = empacotar(base({ recentes }));
    recusa(() => verificarManifesto(e.bytes, e.sig, opts()), 'FORMATO');
  }
});

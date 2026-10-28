// Casos de teste do manifesto para os outros verificadores (o do aplicativo, em Rust): cada caso traz os bytes do
// manifesto, a assinatura, as opções do cliente e o resultado esperado ("ok" ou o código da recusa). Chaves de
// teste geradas na hora; nenhuma chave real.
//   node scripts/distribuicao/vetores.mjs desktop/src-tauri/testes/vetores-manifesto.json
import fs from 'node:fs';
import crypto from 'node:crypto';
import { assinar, sha256, verificarManifesto, Recusa } from './manifesto.mjs';

const nova = (keyId) => {
  const k = crypto.generateKeyPairSync('ed25519');
  return { keyId, privatePkcs8B64: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publica: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const A = nova('teste-a'), B = nova('teste-b'), R = nova('teste-revogada');
const chaves = { [A.keyId]: { publica: A.publica }, [R.keyId]: { publica: R.publica, revogadaEm: '2026-10-01T00:00:00Z' } };
const AGORA = '2026-10-27T12:00:00Z';
const D = (c) => `sha256:${c.repeat(64)}`;
const base = (mud = {}) => ({
  formato: 1, produto: 'ergon', edicao: 'community', canal: 'estavel', versao: '1.0.2', sequencia: 1000,
  emitidoEm: '2026-10-27T10:00:00Z', validoAte: '2027-01-25T10:00:00Z',
  componentes: {
    core: { tipo: 'oci', imagem: 'ghcr.io/dono/ergon-community', versao: '1.0.2', digest: D('a'), plataformas: { amd64: D('b') } },
    'pacote-local': { tipo: 'arquivo', url: 'https://github.com/dono/ergon-community/releases/download/v1.0.2/ergon-local-1.0.2.zip', sha256: sha256(Buffer.from('x')), tamanho: 1 },
  },
  ...mud,
});
const com = (f) => { const m = base(); f(m); return m; };
const casos = [];
const caso = (nome, m, esperado, { chave = A, opcoes = {}, bytes, sig } = {}) => {
  const b = bytes ?? Buffer.from(JSON.stringify(m, null, 2));
  const s = sig ?? Buffer.from(assinar(b, chave));
  casos.push({ nome, manifesto: b.toString('base64'), sig: s.toString('base64'), edicao: 'community', canal: 'estavel', estado: {}, ...opcoes, esperado });
};

caso('correto', base(), 'ok');
{ const b = Buffer.from(JSON.stringify(base(), null, 2)); const s = Buffer.from(assinar(b, A));
  caso('byte editado', null, 'ASSINATURA', { bytes: Buffer.from(b.toString().replace('"1.0.2"', '"1.0.3"')), sig: s }); }
caso('chave fora do chaveiro', base(), 'CHAVE_DESCONHECIDA', { chave: B });
{ const b = Buffer.from(JSON.stringify(base(), null, 2)); const s = JSON.parse(assinar(b, B));
  caso('chave fingida', null, 'ASSINATURA', { bytes: b, sig: Buffer.from(JSON.stringify({ ...s, keyId: A.keyId })) }); }
caso('chave revogada', base(), 'CHAVE_REVOGADA', { chave: R });
caso('assinatura ilegível', base(), 'ASSINATURA', { sig: Buffer.from('lixo') });
caso('assinatura vazia', base(), 'ASSINATURA', { sig: Buffer.from('{}') });
caso('assinatura curta', base(), 'ASSINATURA', { sig: Buffer.from(JSON.stringify({ keyId: A.keyId, assinatura: 'AAAA' })) });
caso('edição errada', base({ edicao: 'proprietary' }), 'EDICAO');
caso('canal errado', base({ canal: 'teste', versao: '1.0.2-rc.1' }), 'CANAL');
caso('canal de teste aceito', base({ canal: 'teste', versao: '1.0.2-rc.1' }), 'ok', { opcoes: { canal: 'teste' } });
caso('vencido', base({ validoAte: '2026-10-27T11:00:00Z' }), 'EXPIRADO');
caso('emitido no futuro', base({ emitidoEm: '2026-10-28T10:00:00Z' }), 'FORMATO');
caso('repetição', base(), 'REPETICAO', { opcoes: { estado: { ultimaSequencia: 1000 } } });
caso('sequência antiga', base(), 'REPETICAO', { opcoes: { estado: { ultimaSequencia: 2000 } } });
caso('rebaixamento', base(), 'REBAIXAMENTO', { opcoes: { estado: { ultimaSequencia: 1, versaoInstalada: '1.1.0' } } });
caso('mesma versão, sequência nova (reparo)', base(), 'ok', { opcoes: { estado: { ultimaSequencia: 999, versaoInstalada: '1.0.2' } } });
caso('pré-versão anterior à final instalada', base({ versao: '1.0.2-rc.1' }), 'REBAIXAMENTO', { opcoes: { estado: { versaoInstalada: '1.0.2' } } });
caso('cliente antigo', base({ clienteMinimo: '1.2.0' }), 'CLIENTE_ANTIGO', { opcoes: { versaoCliente: '1.1.9' } });
caso('cliente na versão mínima', base({ clienteMinimo: '1.2.0' }), 'ok', { opcoes: { versaoCliente: '1.2.0' } });
for (const [n, url] of [['origem estranha', 'https://exemplo.com/a.zip'], ['http', 'http://github.com/a.zip'], ['credencial na url', 'https://u:s@github.com/a.zip'], ['porta', 'https://github.com:8443/a.zip'], ['host parecido', 'https://github.com.exemplo.com/a.zip']])
  caso(n, com((m) => { m.componentes['pacote-local'].url = url; }), 'ORIGEM');
caso('registro fora', com((m) => { m.componentes.core.imagem = 'docker.io/dono/ergon'; }), 'FORMATO');
caso('digest curto', com((m) => { m.componentes.core.digest = 'sha256:abc'; }), 'FORMATO');
caso('tipo desconhecido', com((m) => { m.componentes.core.tipo = 'script'; }), 'FORMATO');
caso('formato futuro', base({ formato: 2 }), 'FORMATO');
caso('sem componentes', base({ componentes: {} }), 'FORMATO');
caso('tamanho zero', com((m) => { m.componentes['pacote-local'].tamanho = 0; }), 'FORMATO');
caso('não é JSON', null, 'FORMATO', { bytes: Buffer.from('não é json') });

// o próprio verificador de referência tem de concordar com cada caso
for (const c of casos) {
  let r = 'ok';
  try { verificarManifesto(Buffer.from(c.manifesto, 'base64'), Buffer.from(c.sig, 'base64'), { chaves, edicao: c.edicao, canal: c.canal, estado: c.estado, versaoCliente: c.versaoCliente, agora: new Date(AGORA) }); }
  catch (e) { if (!(e instanceof Recusa)) throw e; r = e.codigo; }
  if (r !== c.esperado) throw new Error(`${c.nome}: referência deu ${r}, esperado ${c.esperado}`);
}
const saida = process.argv[2] ?? 'vetores-manifesto.json';
fs.writeFileSync(saida, JSON.stringify({ agora: AGORA, chaves, casos }, null, 1) + '\n');
console.log(`${casos.length} casos em ${saida}`);

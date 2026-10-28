// Manifesto de TESTE da instalação: as imagens (digests) da versão publicada + o ambiente e o pacote servidos em
// 127.0.0.1, assinado com uma chave de teste. Nunca publicado.
//   node scripts/distribuicao/montar-teste.mjs --base <manifesto publicado> --pasta <arquivos> --url http://127.0.0.1:18999
//        --chave <chave de teste> --saida <pasta>/manifesto-estavel.json [--adulterar ambiente-wsl]
import fs from 'node:fs';
import path from 'node:path';
import { assinar, sha256 } from './manifesto.mjs';

const opc = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const base = JSON.parse(fs.readFileSync(opc('base'), 'utf8'));
const pasta = opc('pasta'), url = opc('url'), saida = opc('saida');
const chave = JSON.parse(fs.readFileSync(opc('chave'), 'utf8'));
const arquivos = { 'ambiente-wsl': 'ergon-ambiente-wsl.tar.gz', 'pacote-local': `ergon-local-${base.versao}.zip` };
const agora = new Date();
const m = { ...base, sequencia: Math.floor(agora.getTime() / 1000), emitidoEm: agora.toISOString(), validoAte: new Date(agora.getTime() + 864e5).toISOString(), componentes: { core: base.componentes.core, motor: base.componentes.motor } };
for (const [id, nome] of Object.entries(arquivos)) {
  const b = fs.readFileSync(path.join(pasta, nome));
  m.componentes[id] = { tipo: 'arquivo', nome, url: `${url}/${nome}`, sha256: sha256(b), tamanho: b.length };
}
if (opc('adulterar')) m.componentes[opc('adulterar')].sha256 = sha256(Buffer.from('outro conteúdo'));
const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
fs.writeFileSync(saida, bytes);
fs.writeFileSync(`${saida}.sig`, assinar(bytes, chave));
console.log(`manifesto de teste ${m.versao}: ${Object.entries(m.componentes).map(([k, c]) => `${k}${c.tamanho ? ` ${(c.tamanho / 1e6).toFixed(1)} MB` : ''}`).join(', ')}`);

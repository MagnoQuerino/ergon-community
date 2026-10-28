// Manifesto de versão assinado: gerar a partir de uma versão publicada, assinar, verificar e resolver como um cliente
// limpo (sem login em lugar nenhum). A chave privada fica fora do Git e da versão; aqui só entra o caminho dela.
//   node scripts/distribuicao/cli.mjs chave-nova --saida <arquivo fora do repositório> [--id ergon-versoes-1]
//   node scripts/distribuicao/cli.mjs gerar --repo dono/ergon-community --tag v1.0.1 [--canal estavel] [--validade-dias 90] --saida m.json
//   node scripts/distribuicao/cli.mjs assinar --chave <arquivo> m.json            (escreve m.json.sig)
//   node scripts/distribuicao/cli.mjs verificar m.json [--edicao community] [--canal estavel] [--estado e.json]
//   node scripts/distribuicao/cli.mjs resolver <m.json | URL> [--edicao community] [--canal estavel] [--relatorio r.json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assinar, verificarManifesto, conferirArquivo, baixar, manifestoOci, camadaAcessivel, validarForma, sha256, FORMATO } from './manifesto.mjs';

// recusa vira uma linha clara, sem pilha (o código da recusa vem na frente: ASSINATURA, HASH, EXPIRADO...)
const falhou = (e) => { console.error(`RECUSADO ${e?.message ?? e}`); process.exit(1); };
process.on("uncaughtException", falhou); process.on("unhandledRejection", falhou);

const CHAVEIRO = path.join(import.meta.dirname, 'chaves.json');
const [cmd, ...resto] = process.argv.slice(2);
const opc = (n, padrao) => { const i = resto.indexOf(`--${n}`); return i >= 0 ? resto[i + 1] : padrao; };
const posicional = resto.filter((a, i) => !a.startsWith('--') && !(i > 0 && resto[i - 1].startsWith('--')))[0];
const sai = (msg, c = 1) => { console.error(msg); process.exit(c); };
const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`;

async function lerFonte(f) {
  if (/^https:\/\//.test(f)) return (await baixar(f, { maxBytes: 2 ** 20 })).buf;
  return fs.readFileSync(f);
}

const IMAGENS = { community: { core: 'ergon-community', motor: 'ergon-community-hermes' }, proprietary: { core: 'ergon', motor: 'ergon-hermes' } };
// nome do arquivo da versão → componente
const ARQUIVOS = [[/^ergon-local-.*\.zip$/, 'pacote-local'], [/^ergon-ambiente-wsl\.tar\.gz$/, 'ambiente-wsl'], [/\.exe$/i, 'desktop-windows'], [/\.deb$/, 'desktop-deb'], [/\.AppImage$/, 'desktop-appimage']];

switch (cmd) {
  case 'chave-nova': {
    const saida = opc('saida') ?? sai('--saida <arquivo> (fora do repositório)', 2);
    if (fs.existsSync(saida)) sai(`${saida} já existe: não sobrescrevo uma chave`);
    if (path.resolve(saida).startsWith(path.resolve(import.meta.dirname, '..', '..'))) sai('a chave privada não pode ficar dentro do repositório');
    const k = crypto.generateKeyPairSync('ed25519');
    const chave = { keyId: opc('id', 'ergon-versoes-1'), privatePkcs8B64: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      publicSpkiB64: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(path.resolve(saida)), { recursive: true });
    fs.writeFileSync(saida, JSON.stringify(chave, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ keyId: chave.keyId, publica: chave.publicSpkiB64 }));
    break;
  }

  case 'gerar': {
    const repo = opc('repo') ?? sai('--repo dono/nome', 2), tag = opc('tag') ?? sai('--tag vX.Y.Z', 2);
    const edicao = opc('edicao', repo.endsWith('-community') ? 'community' : 'proprietary');
    const versao = tag.replace(/^v/, ''), dono = repo.split('/')[0].toLowerCase();
    const canal = opc('canal', versao.includes('-') ? 'teste' : 'estavel');
    const emitido = new Date();
    // API do GitHub só no gerador (CI), nunca no cliente; anônima por padrão, com token se houver (versão em rascunho)
    const h = { accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN && opc('token') === 'ambiente' ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
    const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: h })).json();
    if (!rel.assets) sai(`versão ${tag} não encontrada em ${repo}: ${rel.message ?? ''}`);
    const componentes = {};
    for (const [id, nome] of Object.entries(IMAGENS[edicao])) {
      const imagem = `ghcr.io/${dono}/${nome}`;
      const idx = await manifestoOci(imagem, versao);
      const plataformas = {};
      for (const p of idx.json.manifests ?? []) if (p.platform?.os === 'linux' && p.platform.architecture !== 'unknown') plataformas[p.platform.architecture] = p.digest;
      if (!Object.keys(plataformas).length) sai(`${imagem}:${versao} não é um índice multiplataforma`);
      componentes[id] = { tipo: 'oci', imagem, versao, digest: idx.digest, plataformas };
    }
    for (const a of rel.assets) {
      const tipo = ARQUIVOS.find(([re]) => re.test(a.name));
      if (!tipo) continue;
      const url = a.browser_download_url;
      const buf = (await baixar(url)).buf;   // baixa de verdade: o hash é do que a pessoa vai receber
      if (componentes[tipo[1]]) sai(`dois arquivos para ${tipo[1]}`);
      componentes[tipo[1]] = { tipo: 'arquivo', nome: a.name, url, sha256: sha256(buf), tamanho: buf.length };
    }
    const m = {
      formato: FORMATO, produto: 'ergon', edicao, canal, versao, sequencia: Number(opc('sequencia', Math.floor(emitido.getTime() / 1000))),
      emitidoEm: emitido.toISOString(), validoAte: new Date(emitido.getTime() + Number(opc('validade-dias', 90)) * 864e5).toISOString(),
      clienteMinimo: opc('cliente-minimo', undefined), notas: rel.html_url,
      requisitos: { windows: { buildMinimo: 19041, wsl: 2 }, arquiteturas: Object.keys(componentes.core.plataformas) },
      componentes,
    };
    if (!m.clienteMinimo) delete m.clienteMinimo;
    validarForma(m);
    fs.writeFileSync(opc('saida', 'manifesto.json'), JSON.stringify(m, null, 2) + '\n');
    console.log(`manifesto ${edicao}/${canal} ${versao} · sequência ${m.sequencia} · ${Object.keys(componentes).join(', ')}`);
    break;
  }

  case 'assinar': {
    const arq = posicional ?? sai('arquivo do manifesto', 2);
    const fonte = opc('chave') ?? sai('--chave <arquivo> ou --chave ambiente (ERGON_MANIFESTO_CHAVE)', 2);
    const chave = JSON.parse(fonte === 'ambiente' ? (process.env.ERGON_MANIFESTO_CHAVE ?? sai('ERGON_MANIFESTO_CHAVE vazio')) : fs.readFileSync(fonte, 'utf8'));
    const bytes = fs.readFileSync(arq);
    validarForma(JSON.parse(bytes.toString('utf8')));
    fs.writeFileSync(`${arq}.sig`, assinar(bytes, chave));
    console.log(`assinado com ${chave.keyId}: ${arq}.sig`);
    break;
  }

  case 'verificar':
  case 'resolver': {
    const fonte = posicional ?? sai('manifesto (arquivo ou URL https)', 2);
    const chaves = JSON.parse(fs.readFileSync(opc('chaves', CHAVEIRO), 'utf8'));
    const estadoArq = opc('estado');
    const estado = estadoArq && fs.existsSync(estadoArq) ? JSON.parse(fs.readFileSync(estadoArq, 'utf8')) : {};
    const bytes = await lerFonte(fonte), sig = await lerFonte(opc('sig', `${fonte}.sig`));
    const m = verificarManifesto(bytes, sig, { chaves, edicao: opc('edicao', 'community'), canal: opc('canal', 'estavel'), estado, versaoCliente: opc('cliente') });
    console.log(`ok   manifesto ${m.edicao}/${m.canal} ${m.versao}, sequência ${m.sequencia}, assinatura conferida, válido até ${m.validoAte}`);
    if (cmd === 'verificar') break;

    // cliente limpo: cada artefato baixado sem login e conferido; imagens resolvidas por digest, camadas acessíveis
    const rel = { versao: m.versao, arquivos: {}, imagens: {} };
    for (const [id, c] of Object.entries(m.componentes)) {
      if (c.tipo === 'arquivo') {
        const t0 = Date.now(); const { buf } = await baixar(c.url, { maxBytes: c.tamanho });
        conferirArquivo(buf, c, id);
        rel.arquivos[id] = { bytes: buf.length, ms: Date.now() - t0 };
        console.log(`ok   ${id}: ${c.nome ?? path.basename(new URL(c.url).pathname)} · ${mb(buf.length)} · SHA-256 conferido · sem login`);
      } else {
        const idx = await manifestoOci(c.imagem, c.digest);
        const lista = Object.fromEntries((idx.json.manifests ?? []).map((p) => [p.digest, p]));
        let total = 0, camadas = 0;
        for (const [arq, d] of Object.entries(c.plataformas)) {
          if (!lista[d] || lista[d].platform?.architecture !== arq) throw new Error(`${id}: ${arq} não está no índice ${c.digest}`);
          const pm = await manifestoOci(c.imagem, d);
          for (const l of [pm.json.config, ...pm.json.layers]) {
            const n = await camadaAcessivel(pm.repo, pm.token, l.digest);
            if (n && n !== l.size) throw new Error(`${id}: camada ${l.digest.slice(7, 19)} com tamanho ${n}, manifesto diz ${l.size}`);
            if (arq === 'amd64') { total += l.size; camadas++; }
          }
        }
        rel.imagens[id] = { digest: c.digest, amd64: { camadas, bytes: total } };
        console.log(`ok   ${id}: ${c.imagem}@${c.digest.slice(0, 19)}… · ${Object.keys(c.plataformas).join('+')} · amd64 ${camadas} camadas, ${mb(total)} · sem login`);
      }
    }
    if (estadoArq) fs.writeFileSync(estadoArq, JSON.stringify({ ultimaSequencia: m.sequencia, versaoInstalada: m.versao }, null, 2));
    if (opc('relatorio')) fs.writeFileSync(opc('relatorio'), JSON.stringify(rel, null, 2));
    console.log('resultado: todos os artefatos resolvidos e conferidos sem login');
    break;
  }

  default:
    sai('uso: cli.mjs chave-nova | gerar | assinar | verificar | resolver (veja o cabeçalho)', 2);
}

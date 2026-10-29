// Manifesto de versão assinado (plano do instalador, D2): a combinação completa aprovada de uma versão — imagens por
// digest, arquivos por SHA-256 e tamanho, de onde podem vir — assinada com Ed25519 sobre os bytes exatos do arquivo.
// O cliente só confia no manifesto que confere com uma chave embutida; o "latest" do canal serve só para descobrir.
// Biblioteca sem rede (verificação pura) + funções de rede usadas pelos comandos em cli.mjs.
import crypto from 'node:crypto';

export const FORMATO = 1;
export const EDICOES = ['community', 'proprietary'];
export const CANAIS = ['estavel', 'teste'];
// Hosts de onde um artefato pode vir (HTTPS, inclusive depois de redirecionar). Nada que a página ou o manifesto
// mandem fora daqui é baixado; mudar de origem (CDN própria) é um cliente novo, assinado pelo manifesto anterior.
export const ORIGENS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'ghcr.io', 'pkg-containers.githubusercontent.com'];
export const LIMITE_REDIRECIONAMENTOS = 5;

export class Recusa extends Error {
  constructor(codigo, msg) { super(`${codigo}: ${msg}`); this.codigo = codigo; }
}
const recusa = (c, m) => { throw new Recusa(c, m); };

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// --------------------------------------------------------------------------------------------------- versões
// x.y.z[-pre]: pré-versão vem antes da versão final (1.0.2-rc.1 < 1.0.2)
export function compararVersoes(a, b) {
  const p = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v); if (!m) recusa('FORMATO', `versão inválida: ${v}`); return m; };
  const x = p(a), y = p(b);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] < +y[i] ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const xs = x[4].split('.'), ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const nx = /^\d+$/.test(xs[i]), ny = /^\d+$/.test(ys[i]);
    if (nx && ny && +xs[i] !== +ys[i]) return +xs[i] < +ys[i] ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Atualização de segurança nas novidades da versão: uma linha "Segurança (obrigatória): motivo" (com ou sem marcador e
 * negrito, como no CHANGELOG). Sem a linha: atualização comum (nada é obrigatório).
 */
export function seguranca(texto) {
  const l = String(texto).split(/\r?\n/).map((x) => x.replace(/^[\s>*-]+/, '').replace(/\*\*/g, '').trim()).find((x) => /^Segurança \(obrigatória\):/i.test(x));
  if (!l) return null;
  const motivo = l.replace(/^Segurança \(obrigatória\):/i, '').trim().slice(0, 400);
  return motivo.length >= 10 ? { obrigatoria: true, motivo } : null;
}

// --------------------------------------------------------------------------------------------------- origens
export function origemPermitida(url) {
  let u; try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port && ORIGENS.includes(u.hostname);
}

// --------------------------------------------------------------------------------------------------- forma
const DIGEST = /^sha256:[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/, KEYID = /^[a-z0-9-]{3,40}$/;

export function validarForma(m) {
  const f = (cond, msg) => { if (!cond) recusa('FORMATO', msg); };
  f(m && typeof m === 'object' && !Array.isArray(m), 'manifesto não é um objeto');
  f(m.formato === FORMATO, `formato ${m.formato} desconhecido (este cliente lê o ${FORMATO})`);
  f(m.produto === 'ergon', 'produto diferente');
  f(EDICOES.includes(m.edicao), 'edição desconhecida');
  f(CANAIS.includes(m.canal), 'canal desconhecido');
  compararVersoes(m.versao, m.versao);
  f(Number.isSafeInteger(m.sequencia) && m.sequencia > 0, 'sequência inválida');
  f(!Number.isNaN(Date.parse(m.emitidoEm)) && !Number.isNaN(Date.parse(m.validoAte)), 'datas inválidas');
  f(Date.parse(m.validoAte) > Date.parse(m.emitidoEm), 'validade antes da emissão');
  if (m.clienteMinimo !== undefined) compararVersoes(m.clienteMinimo, m.clienteMinimo);
  if (m.seguranca !== undefined) {
    f(m.seguranca && typeof m.seguranca === 'object' && m.seguranca.obrigatoria === true, 'seguranca: só "obrigatoria: true" com o motivo');
    f(typeof m.seguranca.motivo === 'string' && m.seguranca.motivo.trim().length >= 10 && m.seguranca.motivo.length <= 400, 'seguranca: motivo de 10 a 400 caracteres');
  }
  f(m.componentes && typeof m.componentes === 'object' && Object.keys(m.componentes).length > 0, 'sem componentes');
  for (const [id, c] of Object.entries(m.componentes)) {
    f(/^[a-z0-9-]{2,40}$/.test(id), `componente com nome inválido: ${id}`);
    if (c.tipo === 'oci') {
      f(typeof c.imagem === 'string' && /^ghcr\.io\/[a-z0-9._/-]+$/.test(c.imagem), `${id}: imagem inválida`);
      f(DIGEST.test(c.digest), `${id}: digest inválido`);
      f(c.plataformas && Object.values(c.plataformas).every((d) => DIGEST.test(d)), `${id}: digest de plataforma inválido`);
    } else if (c.tipo === 'arquivo') {
      f(typeof c.url === 'string', `${id}: sem url`);
      f(HEX64.test(c.sha256), `${id}: SHA-256 inválido`);
      f(Number.isSafeInteger(c.tamanho) && c.tamanho > 0, `${id}: tamanho inválido`);
    } else f(false, `${id}: tipo ${c.tipo} desconhecido`);
    if (c.tipo === 'arquivo' && !origemPermitida(c.url)) recusa('ORIGEM', `${id}: ${c.url} fora das origens permitidas`);
    if (c.tipo === 'oci' && !ORIGENS.includes(c.imagem.split('/')[0])) recusa('ORIGEM', `${id}: registro fora das origens permitidas`);
  }
}

// --------------------------------------------------------------------------------------------------- assinatura
// manifesto.json.sig = {"keyId": "...", "assinatura": "<base64 da Ed25519 sobre os bytes de manifesto.json>"}
export function assinar(bytes, chave) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(chave.privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  return JSON.stringify({ keyId: chave.keyId, assinatura: crypto.sign(null, Buffer.from(bytes), priv).toString('base64') }) + '\n';
}

// chaves: { [keyId]: { publica: <SPKI base64>, revogadaEm?: ISO } } — o chaveiro embutido no cliente
export function conferirAssinatura(bytes, sigBytes, chaves, agora = new Date()) {
  let sig; try { sig = JSON.parse(Buffer.from(sigBytes).toString('utf8')); } catch { recusa('ASSINATURA', 'arquivo de assinatura ilegível'); }
  if (!sig || typeof sig.keyId !== 'string' || !KEYID.test(sig.keyId) || typeof sig.assinatura !== 'string') recusa('ASSINATURA', 'assinatura sem chave ou valor');
  const k = Object.hasOwn(chaves, sig.keyId) ? chaves[sig.keyId] : null;
  if (!k) recusa('CHAVE_DESCONHECIDA', `chave ${sig.keyId} não está no chaveiro deste cliente`);
  if (k.revogadaEm && Date.parse(k.revogadaEm) <= agora.getTime()) recusa('CHAVE_REVOGADA', `chave ${sig.keyId} revogada em ${k.revogadaEm}`);
  const pub = crypto.createPublicKey({ key: Buffer.from(k.publica, 'base64'), format: 'der', type: 'spki' });
  let ok = false; try { ok = crypto.verify(null, Buffer.from(bytes), pub, Buffer.from(sig.assinatura, 'base64')); } catch { ok = false; }
  if (!ok) recusa('ASSINATURA', 'a assinatura não confere com o manifesto');
  return sig.keyId;
}

// --------------------------------------------------------------------------------------------------- verificação
// Tudo o que o cliente exige antes de usar um manifesto. estado = o que ele já aceitou antes (proteção contra
// repetição e rebaixamento): { ultimaSequencia, versaoInstalada }. Devolve o manifesto já conferido.
export function verificarManifesto(bytes, sigBytes, { chaves, edicao, canal, estado = {}, versaoCliente, agora = new Date() }) {
  const keyId = conferirAssinatura(bytes, sigBytes, chaves, agora);   // primeiro a assinatura: nada não assinado é lido
  let m; try { m = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { recusa('FORMATO', 'manifesto não é JSON'); }
  validarForma(m);
  if (m.chave !== undefined && m.chave !== keyId) recusa('ASSINATURA', 'o manifesto declara outra chave');
  if (m.edicao !== edicao) recusa('EDICAO', `manifesto da edição ${m.edicao}; esta instalação é ${edicao}`);
  if (m.canal !== canal) recusa('CANAL', `manifesto do canal ${m.canal}; esta instalação segue ${canal}`);
  if (Date.parse(m.validoAte) <= agora.getTime()) recusa('EXPIRADO', `metadados vencidos em ${m.validoAte}`);
  if (Date.parse(m.emitidoEm) > agora.getTime() + 10 * 60_000) recusa('FORMATO', 'emitido no futuro');
  if (estado.ultimaSequencia !== undefined && m.sequencia <= estado.ultimaSequencia) recusa('REPETICAO', `sequência ${m.sequencia} não é mais nova que a ${estado.ultimaSequencia} já aceita`);
  if (estado.versaoInstalada && compararVersoes(m.versao, estado.versaoInstalada) < 0) recusa('REBAIXAMENTO', `${m.versao} é anterior à instalada (${estado.versaoInstalada})`);
  if (m.clienteMinimo && versaoCliente && compararVersoes(versaoCliente, m.clienteMinimo) < 0) recusa('CLIENTE_ANTIGO', `esta versão pede o instalador ${m.clienteMinimo} ou mais novo`);
  return m;
}

// Confere um arquivo baixado contra o componente do manifesto (tamanho antes do hash: truncado não chega a ser lido).
export function conferirArquivo(buf, comp, id = 'arquivo') {
  if (buf.length !== comp.tamanho) recusa('TAMANHO', `${id}: ${buf.length} bytes, o manifesto diz ${comp.tamanho}`);
  const h = sha256(buf);
  if (h !== comp.sha256) recusa('HASH', `${id}: SHA-256 ${h.slice(0, 12)}…, o manifesto diz ${comp.sha256.slice(0, 12)}…`);
}

// --------------------------------------------------------------------------------------------------- rede (anônima)
// Nunca envia credencial: nada de token do GitHub, mesmo que exista no ambiente. Cada salto de redirecionamento
// também precisa estar nas origens permitidas.
export async function baixar(url, { maxBytes = 2 ** 31, headers = {}, metodo = 'GET' } = {}) {
  let atual = url;
  for (let i = 0; i <= LIMITE_REDIRECIONAMENTOS; i++) {
    if (!origemPermitida(atual)) recusa('ORIGEM', `${new URL(atual).hostname} fora das origens permitidas`);
    const r = await fetch(atual, { method: metodo, redirect: 'manual', headers });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const prox = new URL(r.headers.get('location'), atual);
      if (prox.hostname !== new URL(atual).hostname) { const { authorization, ...resto } = headers; headers = resto; }   // o token do registro não vai para outro host
      atual = prox.href; continue;
    }
    if (!r.ok) recusa('REDE', `${r.status} em ${new URL(atual).hostname}${new URL(atual).pathname}`);
    if (metodo === 'HEAD') return { headers: r.headers, buf: Buffer.alloc(0) };
    const declarado = Number(r.headers.get('content-length') ?? 0);
    if (declarado > maxBytes) recusa('TAMANHO', `${declarado} bytes passa do limite`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) recusa('TAMANHO', `${buf.length} bytes passa do limite`);
    return { headers: r.headers, buf };
  }
  recusa('ORIGEM', 'redirecionamentos demais');
}

const TIPOS_OCI = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

// Token anônimo de leitura do GHCR (o mesmo que "docker pull" sem login pede)
async function tokenAnonimo(repo) {
  const { buf } = await baixar(`https://ghcr.io/token?scope=repository:${repo}:pull`, { maxBytes: 65536 });
  return JSON.parse(buf.toString('utf8')).token;
}

// Manifesto OCI por referência (etiqueta ou digest), anônimo; confere que o conteúdo bate com o digest pedido.
export async function manifestoOci(imagem, ref) {
  const repo = imagem.replace(/^ghcr\.io\//, '');
  const token = await tokenAnonimo(repo);
  const { buf, headers } = await baixar(`https://ghcr.io/v2/${repo}/manifests/${ref}`, { maxBytes: 4 * 2 ** 20, headers: { accept: TIPOS_OCI, authorization: `Bearer ${token}` } });
  const digest = `sha256:${sha256(buf)}`;
  if (ref.startsWith('sha256:') && digest !== ref) recusa('HASH', `${imagem}@${ref.slice(0, 19)}…: o registro devolveu outro conteúdo`);
  if (headers.get('docker-content-digest') && headers.get('docker-content-digest') !== digest) recusa('HASH', `${imagem}: digest do registro diferente do conteúdo`);
  return { digest, json: JSON.parse(buf.toString('utf8')), token, repo };
}

// Camada existe e é pública (HEAD anônimo; não baixa o conteúdo)
export async function camadaAcessivel(repo, token, digest) {
  const { headers } = await baixar(`https://ghcr.io/v2/${repo}/blobs/${digest}`, { metodo: 'HEAD', headers: { authorization: `Bearer ${token}` } });
  return Number(headers.get('content-length') ?? 0);
}

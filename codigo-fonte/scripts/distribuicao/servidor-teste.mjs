// Servidor de arquivos para os testes da instalação (só 127.0.0.1): aceita Range e, para simular a internet caindo,
// derruba a PRIMEIRA conexão de um arquivo depois de N bytes (--cortar arquivo:bytes). Registra cada pedido.
//   node scripts/distribuicao/servidor-teste.mjs <pasta> [--porta 18999] [--cortar ergon-ambiente-wsl.tar.gz:30000000]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const pasta = path.resolve(process.argv[2] ?? '.');
const opc = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : p; };
const porta = Number(opc('porta', 18999));
const cortes = new Map((opc('cortar', '') || '').split(',').filter(Boolean).map((c) => { const [a, b] = c.split(':'); return [a, Number(b)]; }));

http.createServer((req, res) => {
  const nome = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const arq = path.join(pasta, nome);
  if (!arq.startsWith(pasta + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404).end(); console.log(`404 ${nome}`); return; }
  const tam = fs.statSync(arq).size;
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const ini = m ? Number(m[1]) : 0;
  if (ini >= tam && m) { res.writeHead(416, { 'content-range': `bytes */${tam}` }).end(); return; }
  const corte = cortes.get(nome);
  console.log(`${m ? 206 : 200} ${nome} desde ${ini}${corte ? ` (vai cair em ${corte})` : ''}`);
  res.writeHead(m ? 206 : 200, { 'content-length': tam - ini, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${ini}-${tam - 1}/${tam}` } : {}) });
  const s = fs.createReadStream(arq, { start: ini });
  if (corte) {
    cortes.delete(nome);   // só a primeira conexão cai
    let enviados = 0;
    s.on('data', (b) => { enviados += b.length; if (enviados >= corte - ini) { s.destroy(); req.socket.destroy(); console.log(`cortou ${nome} em ${ini + enviados}`); } });
  }
  s.pipe(res);
}).listen(porta, '127.0.0.1', () => console.log(`servindo ${pasta} em http://127.0.0.1:${porta}`));

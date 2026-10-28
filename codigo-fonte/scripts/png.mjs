// PNG e BMP mínimos (RGBA, sem dependências): ícones da marca, pacote do Teams e imagem do instalador do Windows.
import zlib from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
export const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Codifica w×h pixels RGBA (Buffer de w*h*4 bytes) em PNG. */
export function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Codifica w×h pixels RGBA em BMP de 24 bits (o que o instalador NSIS aceita); o alfa é ignorado. */
export function bmp(w, h, rgba) {
  const linha = Math.ceil((w * 3) / 4) * 4; const dados = linha * h;
  const b = Buffer.alloc(54 + dados);
  b.write('BM', 0); b.writeUInt32LE(54 + dados, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(dados, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) { // de baixo para cima, BGR
    const o = 54 + (h - 1 - y) * linha;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; b[o + x * 3] = rgba[i + 2]; b[o + x * 3 + 1] = rgba[i + 1]; b[o + x * 3 + 2] = rgba[i]; }
  }
  return b;
}

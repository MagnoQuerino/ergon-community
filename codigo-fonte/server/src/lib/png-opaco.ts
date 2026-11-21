/**
 * PNG sem canal alfa para o PDF (lib/pdf-documento.ts). O PDFKit embute na hora só o PNG opaco: com alfa (o logo com
 * fundo transparente, o cartão do bloco visual), ele separa o canal depois, com zlib assíncrono, e o PDF montado de uma
 * vez sairia sem a imagem. Aqui o alfa vira o fundo (branco), tudo síncrono. Só 8 bits sem entrelaçamento; o resto
 * passa como veio.
 */
import zlib from 'node:zlib';

const ASSINATURA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pedaco(tipo: string, dados: Buffer): Buffer {
  const t = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(t) >>> 0);
  return Buffer.concat([len, t, crc]);
}

/** RGBA cru → PNG RGB sobre `fundo`. */
export function pngRgbDe(rgba: Buffer, w: number, h: number, fundo: readonly [number, number, number] = [255, 255, 255]): Buffer {
  const linha = w * 3 + 1;
  const raw = Buffer.alloc(linha * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; const o = y * linha + 1 + x * 3; const a = rgba[i + 3] / 255;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(rgba[i + k] * a + fundo[k] * (1 - a));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([ASSINATURA, pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(raw)), pedaco('IEND', Buffer.alloc(0))]);
}

const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** O PNG com alfa (cinza+alfa ou RGBA, 8 bits) vira opaco; qualquer outro formato volta igual. */
export function semAlfa(buf: Buffer, fundo: readonly [number, number, number] = [255, 255, 255]): Buffer {
  try {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(ASSINATURA)) return buf;
    let pos = 8; let w = 0, h = 0, cor = -1; const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos); const tipo = buf.toString('latin1', pos + 4, pos + 8); const dados = buf.subarray(pos + 8, pos + 8 + len);
      if (tipo === 'IHDR') { w = dados.readUInt32BE(0); h = dados.readUInt32BE(4); if (dados[8] !== 8 || dados[12] !== 0) return buf; cor = dados[9]; }
      else if (tipo === 'IDAT') idat.push(dados);
      else if (tipo === 'IEND') break;
      pos += 12 + len;
    }
    if ((cor !== 6 && cor !== 4) || !w || !h || w * h > 40_000_000) return buf;
    const bpp = cor === 6 ? 4 : 2; const stride = w * bpp;
    const z = zlib.inflateSync(Buffer.concat(idat));
    if (z.length < (stride + 1) * h) return buf;
    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const f = z[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[dst + x - bpp] : 0; const b = y ? px[dst - stride + x] : 0; const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
        const v = z[src + x];
        px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : v) & 255;
      }
    }
    const rgba = cor === 6 ? px : Buffer.alloc(w * h * 4);
    if (cor === 4) for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i * 2]; rgba[i * 4 + 3] = px[i * 2 + 1]; }
    return pngRgbDe(rgba, w, h, fundo);
  } catch { return buf; }
}

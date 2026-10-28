/**
 * ZIP mínimo (sem dependências): ler os arquivos do Office (docx, xlsx, pptx são ZIP com XML) e gravar a
 * apresentação que as rotinas produzem. Só o necessário: armazenado ou deflate, sem ZIP64, com limites contra
 * "bomba de zip" (tamanho descompactado e número de entradas).
 */
import zlib from 'node:zlib';

export class ZipError extends Error {}

const MAX_ENTRIES = 4000;
/** limite descompactado por entrada e no total (um docx de verdade fica muito abaixo disto) */
const MAX_ENTRY = 40 * 1024 * 1024; const MAX_TOTAL = 120 * 1024 * 1024;

export interface ZipEntry { name: string; size: number; read: () => Buffer }

/** Lista as entradas de um ZIP; o conteúdo só é descompactado quando pedido. */
export function readZip(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ZipError('não é um arquivo ZIP');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('ZIP sem diretório central');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new ZipError('ZIP com entradas demais');
  const out = new Map<string, ZipEntry>(); let total = 0;
  // o tamanho declarado pode mentir (bomba de zip): o teto vale para o que sai de verdade, somando todas as leituras
  let inflated = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('diretório central corrompido');
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20); const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (size > MAX_ENTRY) throw new ZipError(`entrada grande demais (${name})`);
    total += size; if (total > MAX_TOTAL) throw new ZipError('conteúdo descompactado grande demais');
    out.set(name, { name, size, read: () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError('entrada corrompida');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      const left = MAX_TOTAL - inflated;
      if (left <= 0) throw new ZipError('conteúdo descompactado grande demais');
      let r: Buffer;
      if (method === 0) r = Buffer.from(data);
      else if (method === 8) {
        try { r = zlib.inflateRawSync(data, { maxOutputLength: Math.min(MAX_ENTRY, left) }); } catch (e) {
          if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(left < MAX_ENTRY ? 'conteúdo descompactado grande demais (passa de 120 MB somando as partes)' : `entrada descompacta para mais do que o limite (${name})`);
          throw new ZipError(`entrada corrompida (${name})`);
        }
      } else throw new ZipError(`compressão não suportada (${method})`);
      inflated += r.length;
      return r;
    } });
  }
  return out;
}

/** Grava um ZIP (deflate). As datas ficam fixas: o mesmo conteúdo gera o mesmo arquivo. */
export function writeZip(files: Array<{ name: string; data: Buffer | string }>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const comp = zlib.deflateRawSync(raw); const name = Buffer.from(f.name, 'utf8'); const crc = zlib.crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); // 01/01/1980
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, e]);
}

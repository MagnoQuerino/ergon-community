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

/** `dosDate`/`dosTime`: a data gravada na entrada (formato do MS-DOS, hora de parede) */
export interface ZipEntry { name: string; size: number; dosDate: number; dosTime: number; read: () => Buffer }

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
    const local = buf.readUInt32LE(p + 42); const dosTime = buf.readUInt16LE(p + 12); const dosDate = buf.readUInt16LE(p + 14);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (size > MAX_ENTRY) throw new ZipError(`entrada grande demais (${name})`);
    total += size; if (total > MAX_TOTAL) throw new ZipError('conteúdo descompactado grande demais');
    out.set(name, { name, size, dosDate, dosTime, read: () => {
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


/**
 * Uma entrada para gravar. `store`: guarda sem compactar (o que já vem compactado: imagem, PDF, Office). `mtime`: a data
 * do arquivo (sem ela, 01/01/1980 fixo: o mesmo conteúdo gera o mesmo arquivo); `tz`: o fuso em que essa data é escrita
 * (o ZIP guarda a hora "de parede", sem fuso; sem `tz`, a do computador).
 */
export interface ZipInput { name: string; data: Buffer | string; store?: boolean; mtime?: Date; tz?: string }

/** Limites do formato sem ZIP64: até 65.535 entradas e 4 GB (quem chama limita bem antes). */
export const ZIP_MAX_ENTRIES = 65_535;
const ZIP_MAX_OFFSET = 0xffff_ffff;

/** Uma entrada pronta: só o compactado fica guardado (o original sai da memória assim que a entrada é montada). */
interface Packed { name: Buffer; comp: Buffer; crc: number; size: number; method: 0 | 8; time: number; date: number }

const DOS_1980 = { time: 0, date: 0x21 };
const relogios = new Map<string, Intl.DateTimeFormat>();
/** Data e hora no formato do ZIP (o do MS-DOS: hora de parede, de 2 em 2 segundos, de 1980 a 2107). */
export function dosDateTime(d: Date | undefined, tz?: string): { time: number; date: number } {
  if (!d || Number.isNaN(d.getTime())) return DOS_1980;
  let fmt = relogios.get(tz ?? '');
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return tz ? dosDateTime(d) : DOS_1980; }
    relogios.set(tz ?? '', fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  if (!(p.year >= 1980 && p.year <= 2107)) return DOS_1980;
  return { time: ((p.hour % 24) << 11) | (p.minute << 5) | (p.second >> 1), date: ((p.year - 1980) << 9) | (p.month << 5) | p.day };
}

const rawOf = (d: Buffer | string) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : d);
const pack = (f: ZipInput, raw: Buffer, comp: Buffer): Packed => {
  const { time, date } = dosDateTime(f.mtime, f.tz);
  return { name: Buffer.from(f.name, 'utf8'), comp, crc: zlib.crc32(raw), size: raw.length, method: f.store ? 0 : 8, time, date };
};
const localHeader = (f: Packed): Buffer => {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(f.method, 8);
  h.writeUInt16LE(f.time, 10); h.writeUInt16LE(f.date, 12);
  h.writeUInt32LE(f.crc, 14); h.writeUInt32LE(f.comp.length, 18); h.writeUInt32LE(f.size, 22); h.writeUInt16LE(f.name.length, 26); h.writeUInt16LE(0, 28);
  return h;
};
const centralHeader = (f: Packed, offset: number): Buffer => {
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(f.method, 10);
  c.writeUInt16LE(f.time, 12); c.writeUInt16LE(f.date, 14); c.writeUInt32LE(f.crc, 16); c.writeUInt32LE(f.comp.length, 20); c.writeUInt32LE(f.size, 24);
  c.writeUInt16LE(f.name.length, 28); c.writeUInt32LE(offset, 42);
  return c;
};
const localSize = (f: Packed) => 30 + f.name.length + f.comp.length;

/** As partes do arquivo, uma entrada por vez; cada entrada entregue sai da lista (e da memória, se ninguém mais a segura). */
function* assembleParts(entries: Array<Packed | null>): Generator<Buffer> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipError('entradas demais para um ZIP');
  let total = 22;
  for (const f of entries) total += localSize(f!) + 46 + f!.name.length;
  if (total > ZIP_MAX_OFFSET) throw new ZipError('conteúdo grande demais para um ZIP');
  const central: Buffer[] = []; let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i]!;
    entries[i] = null;
    central.push(centralHeader(f, offset), f.name);
    offset += localSize(f);
    yield Buffer.concat([localHeader(f), f.name]);
    yield f.comp;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  yield cd; yield e;
}

/** Grava um ZIP (deflate). Sem `mtime`, as datas ficam fixas: o mesmo conteúdo gera o mesmo arquivo. */
export function writeZip(files: ZipInput[]): Buffer {
  return Buffer.concat([...assembleParts(files.map((f) => { const raw = rawOf(f.data); return pack(f, raw, f.store ? raw : zlib.deflateRawSync(raw)); }))]);
}

const deflateRaw = (b: Buffer) => new Promise<Buffer>((ok, falha) => zlib.deflateRaw(b, (e, r) => (e ? falha(e) : ok(r))));

/**
 * Monta um ZIP grande aos poucos, sem travar o servidor (o "Baixar meus dados"): cada entrada é compactada fora da
 * linha principal assim que chega, e só o compactado fica guardado (o original já pode sair da memória). No fim,
 * `partes()` entrega o arquivo pedaço por pedaço, para mandar aos poucos na resposta, sem juntar tudo num pedaço só.
 */
export class ZipMontador {
  private entradas: Packed[] = [];
  private bytes = 0;
  get quantas(): number { return this.entradas.length; }
  /** o que está guardado na memória até agora (compactado) */
  get guardado(): number { return this.bytes; }
  /** `primeiro`: vai para o topo da lista (o LEIA-ME, montado por último, aparece primeiro ao abrir o ZIP) */
  async add(f: ZipInput, opts: { primeiro?: boolean } = {}): Promise<void> {
    if (this.entradas.length >= ZIP_MAX_ENTRIES) throw new ZipError('entradas demais para um ZIP');
    const raw = rawOf(f.data);
    const p = pack(f, raw, f.store ? raw : await deflateRaw(raw));
    if (opts.primeiro) this.entradas.unshift(p); else this.entradas.push(p);
    this.bytes += p.comp.length;
  }
  /** o tamanho exato do arquivo final */
  tamanho(): number {
    let n = 22;
    for (const f of this.entradas) n += localSize(f) + 46 + f.name.length;
    return n;
  }
  /** Entrega o arquivo em pedaços; depois disso o montador fica vazio. */
  partes(): Generator<Buffer> {
    const tudo: Array<Packed | null> = this.entradas;
    this.entradas = []; this.bytes = 0;
    return assembleParts(tudo);
  }
}

/** O mesmo que writeZip, compactando fora da linha principal; devolve o arquivo inteiro. */
export async function writeZipAsync(files: ZipInput[]): Promise<Buffer> {
  const z = new ZipMontador();
  for (const f of files) await z.add(f);
  return Buffer.concat([...z.partes()]);
}

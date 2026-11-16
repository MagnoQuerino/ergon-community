/**
 * Arquivo executável (programa, script, atalho, instalador): o Ergon guarda, mas nunca abre, não mostra prévia, não entrega
 * a agente e só deixa baixar depois de um aviso. Reconhecido pela extensão E pelo conteúdo (um .exe renomeado para .pdf
 * continua sendo um executável), e também dentro de um .zip (pelos nomes de dentro).
 */
import crypto from 'node:crypto';
import { readZip } from './zip.ts';

const EXT = new Set(['exe', 'com', 'scr', 'pif', 'msi', 'msix', 'msp', 'appx', 'appxbundle', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'lnk', 'url', 'reg', 'cpl', 'dll', 'sys', 'jar', 'sh', 'bash', 'zsh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'run', 'bin',
  'elf', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'docm', 'xlsm', 'pptm', 'xlam', 'scf', 'inf', 'chm', 'gadget', 'application', 'ps2', 'apk', 'ipa']);

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] ?? '';

/** Pelo começo do arquivo: Windows (MZ), Linux (ELF), macOS (Mach-O), script com #!, atalho do Windows (.lnk). */
function conteudoExecutavel(data: Buffer): string | null {
  if (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) return 'programa do Windows';
  if (data.length >= 4 && data.readUInt32BE(0) === 0x7f454c46) return 'programa do Linux';
  if (data.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(data.readUInt32BE(0))) return 'programa do macOS';
  if (data.length >= 2 && data[0] === 0x23 && data[1] === 0x21) return 'script';
  if (data.length >= 20 && data.readUInt32LE(0) === 0x4c && data.subarray(4, 20).equals(Buffer.from('0114020000000000c000000000000046', 'hex'))) return 'atalho do Windows';
  return null;
}

/** null = não é executável; senão, o que é (para o aviso). */
export function executavel(filename: string, data: Buffer): string | null {
  const e = ext(filename);
  const pelo = conteudoExecutavel(data);
  if (pelo) return pelo;
  if (EXT.has(e)) return `arquivo .${e}`;
  if (e === 'zip' || (data.length > 4 && data.readUInt32LE(0) === 0x04034b50 && !['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'ergon'].includes(e))) {
    try {
      const dentro = [...readZip(data).keys()].find((n) => EXT.has(ext(n)));
      if (dentro) return `pacote com ${dentro.split('/').pop()}`;
    } catch { /* ZIP ilegível: não é aberto mesmo */ }
  }
  return null;
}

export const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

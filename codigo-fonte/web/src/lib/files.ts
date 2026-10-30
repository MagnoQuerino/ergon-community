/** Ajuda de arquivos para a conversa e Documentos: tamanho legível, tipo para o ícone, prévia permitida. */

export const size = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** imagem comum (mostra a miniatura) */
export const isImage = (mime: string): boolean => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime);
/** prévia dentro do Ergon: imagem comum e PDF (o resto só baixa) */
export const inlinePreview = (mime: string): boolean => isImage(mime) || mime === 'application/pdf';

/** Rótulo curto do tipo (PDF, Word, Planilha…). */
export function kindOf(filename: string, mime: string): string {
  const e = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
  if (mime === 'application/pdf' || e === 'pdf') return 'PDF';
  if (/wordprocessing|msword/.test(mime) || ['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'Word';
  if (/spreadsheet|ms-excel|csv/.test(mime) || ['xls', 'xlsx', 'csv', 'ods'].includes(e)) return 'Planilha';
  if (/presentation|powerpoint/.test(mime) || ['ppt', 'pptx', 'odp'].includes(e)) return 'Apresentação';
  if (mime.startsWith('image/')) return 'Imagem';
  if (mime.startsWith('audio/')) return 'Áudio';
  if (mime.startsWith('video/')) return 'Vídeo';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(e)) return 'Pacote';
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'xml'].includes(e)) return 'Texto';
  return e ? e.toUpperCase() : 'Arquivo';
}

/** Arquivos arrastados (só arquivos, não texto nem links). */
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

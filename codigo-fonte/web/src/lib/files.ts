/** Ajuda de arquivos para a conversa e Documentos: tamanho legível, tipo para o ícone, prévia permitida. */
import { fmtBytes, t } from '../i18n/index.ts';

/** tamanho no idioma da tela: 820 B · 1,5 MB / 1.5 MB */
export const size = (n: number): string => fmtBytes(n);

/** imagem comum (mostra a miniatura) */
export const isImage = (mime: string): boolean => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime);
/** prévia dentro do Ergon: imagem comum e PDF (o resto só baixa) */
export const inlinePreview = (mime: string): boolean => isImage(mime) || mime === 'application/pdf';

/** Rótulo curto do tipo (PDF, Word, Planilha…). */
export function kindOf(filename: string, mime: string): string {
  const e = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
  if (mime === 'application/pdf' || e === 'pdf') return 'PDF';
  if (/wordprocessing|msword/.test(mime) || ['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'Word';
  if (/spreadsheet|ms-excel|csv/.test(mime) || ['xls', 'xlsx', 'csv', 'ods'].includes(e)) return t('geral.arquivo.planilha');
  if (/presentation|powerpoint/.test(mime) || ['ppt', 'pptx', 'odp'].includes(e)) return t('geral.arquivo.apresentacao');
  if (mime.startsWith('image/')) return t('geral.arquivo.imagem');
  if (mime.startsWith('audio/')) return t('geral.arquivo.audio');
  if (mime.startsWith('video/')) return t('geral.arquivo.video');
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(e)) return t('geral.arquivo.pacote');
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'xml'].includes(e)) return t('geral.arquivo.texto');
  return e ? e.toUpperCase() : t('geral.arquivo.arquivo');
}

/** Arquivos arrastados (só arquivos, não texto nem links). */
// i18n-ok: 'Files' é o tipo que o navegador dá ao arrastar arquivos, não texto de tela
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

// O relatório aberto: o visualizador de documentos do Ergon, por cima da conversa. Com os Entregáveis (rc.42), é o
// <Documento fonte={{ artifactId }} modo="dialogo" revisar /> de components/Documento.tsx (revisão ao vivo, versões,
// PDF); os blocos ```ergon-<tipo> do .md são desenhados por Visual.tsx (BlocoDoDocumento, registrado em lib/documento.ts).
// Antes deles, o leitor de arquivos de sempre (FileViewer), que já desenha o .md com os blocos.
import { FileViewer } from '../components/FileViewer.tsx';

export interface ArquivoDoRelatorio { id: string; nome: string; tamanho: number }

export function DocumentoDoRelatorio({ arquivo, onClose }: { arquivo: ArquivoDoRelatorio; onClose: () => void }) {
  return <FileViewer file={{ id: arquivo.id, filename: arquivo.nome, mime: 'text/markdown', size: arquivo.tamanho }} onClose={onClose} />;
}

// O relatório aberto: o documento do Ergon por cima da conversa (components/Documento.tsx), com a revisão ao vivo, as
// versões e o PDF; os blocos ```ergon-<tipo> do .md são desenhados por Visual.tsx (BlocoDoDocumento, no registro de
// lib/documento.ts por visuais/registro.ts).
import { Documento } from '../components/Documento.tsx';

export interface ArquivoDoRelatorio { id: string; nome: string; tamanho: number }

export function DocumentoDoRelatorio({ arquivo, onClose }: { arquivo: ArquivoDoRelatorio; onClose: () => void }) {
  return <Documento fonte={{ artifactId: arquivo.id, tamanho: arquivo.tamanho }} modo="dialogo" revisar onClose={onClose} />;
}

// Os blocos visuais do agente (```ergon-<tipo>, shared/visuais) no registro do documento (lib/documento.ts): o mesmo
// desenho na conversa, nas salas, no detalhe das entregas e no documento dos Entregáveis. A cerca genérica
// ```ergon-visual (o tipo no JSON) também.
import { registrarBlocoVisual } from '../lib/documento.ts';
import { BlocoDoDocumento, TIPOS_DO_DOCUMENTO } from './Visual.tsx';

for (const t of [...TIPOS_DO_DOCUMENTO, 'visual']) registrarBlocoVisual(t, BlocoDoDocumento);

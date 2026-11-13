// Capacidades da equipe (rc.27): o que GET /api/recursos e as rotas vizinhas devolvem. Só tipos e caminhos, sem texto.
export interface RecursosEstado {
  checkpoints: boolean; codigoInseguro: boolean; limpeza: boolean; buscaFerramentas: boolean; conectores: string[];
  voz: { transcrever: string | null; falar: string | null };
  navegador: { chromium: boolean; pronto: boolean };
  escrita: string[];
}
export interface Vaga { provider: string; model: string }
export interface Conselho { preset: string; ligado: boolean; opinam: Vaga[]; agrega: Vaga }
export interface CompetenciaLoja { id: string; nome: string; descricao: string; fonte: string; confianca: string; categoria: string; instalada: boolean }
export interface Varredura {
  id: string; nome: string; confianca: string; veredito: 'safe' | 'caution' | 'dangerous' | string; politica: 'allow' | 'ask' | 'block' | string;
  motivo: string; resumo: string; achados: Array<{ gravidade: string; arquivo: string; linha: number | null; descricao: string }>;
}
export interface ConectorCatalogo {
  nome: string; descricao: string; entrada: string; transporte: string; campos: Array<{ nome: string; pergunta: string; obrigatorio: boolean }>;
  depois: string; instalado: boolean; ligado: boolean;
}
export interface Conectores { catalogo: ConectorCatalogo[]; servidores: Array<{ nome: string; ligado: boolean; entrada: string }>; busca_ferramentas: boolean; escrita: string[] }
export interface PontoDeVolta { id: string; quando: string; pasta: string; motivo: string; arquivos: number }

/** Aplicativos conectados pela pessoa (rc.29): GET /api/recursos/apps-proprios. */
export type TipoFerramenta = 'leitura' | 'escrita' | 'envio';
export interface FerramentaApp { nome: string; descricao: string; sugerido: TipoFerramenta; tipo: TipoFerramenta }
export interface AppConectado {
  nome: string; app: string; apelido: string | null; icone: string | null; transporte: 'http' | 'sse' | 'stdio';
  /** a conta dentro do aplicativo, como nas Conexões: '' = a principal */
  conta: string; principal: boolean;
  endereco: string | null; comando: string | null; argumentos: string[];
  chaves: Array<{ tipo: 'cabecalho' | 'variavel'; nome: string }>; ferramentas: FerramentaApp[]; testadoEm: string | null; erro: string | null; criadoEm: string;
}

export const RECURSOS = '/api/recursos';

interface Anexo { id: string; filename: string; mime: string }
export const ehAudio = (f: { filename: string; mime: string }): boolean =>
  f.mime.startsWith('audio/') || /\.(ogg|oga|opus|mp3|m4a|wav|webm|flac|aac)$/i.test(f.filename);
/**
 * Os áudios que a pessoa mandou desde `desde` (ms) e ainda não foram tentados pela transcrição automática. Cada áudio é
 * tentado sozinho uma vez só: se falhar, fica o botão "Transcrever" (sem isso, cada mudança na conversa tentava de novo e
 * repetia o erro na tela).
 */
export function audiosParaTranscrever<A extends Anexo>(list: ReadonlyArray<{ role: string; created_at: string; attachments?: A[] }>, desde: number, tentados: ReadonlySet<string>): A[] {
  const out: A[] = [];
  for (const m of list) {
    if (m.role !== 'user' || !(Date.parse(m.created_at) >= desde)) continue;
    for (const f of m.attachments ?? []) if (ehAudio(f) && !tentados.has(f.id) && !out.some((x) => x.id === f.id)) out.push(f);
  }
  return out;
}

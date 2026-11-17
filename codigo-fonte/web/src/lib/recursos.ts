// Capacidades da equipe (rc.27): o que GET /api/recursos e as rotas vizinhas devolvem. Só tipos e caminhos, sem texto.
export interface RecursosEstado {
  checkpoints: boolean; codigoInseguro: boolean; limpeza: boolean; buscaFerramentas: boolean; conectores: string[];
  /** preparar (rc.33): o que ainda vai ser baixado no 1º uso (o modelo de fala, a voz do Piper); modelo: base ou small */
  voz: { transcrever: string | null; falar: string | null; preparar?: { transcrever: boolean; falar: boolean }; modelo?: string | null };
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

/** Um áudio (o player e a transcrição na conversa, rc.33). */
export const ehAudio = (f: { filename: string; mime: string }): boolean =>
  f.mime.startsWith('audio/') || /\.(ogg|oga|opus|mp3|m4a|wav|webm|flac|aac)$/i.test(f.filename);

/**
 * Contrato das conexões: o que cada aplicativo sabe fazer, igual para todos. Um quadro de tarefas implementa
 * `EscritorTarefas` (o espelho e os agentes usam o mesmo código); e-mail, agenda, arquivos e conversas declaram `Acao`.
 * Toda ação diz o seu risco, e quem decide se ela vai direto ou pede confirmação é o sistema (regra.ts), nunca o modelo.
 * As credenciais ficam no servidor do Ergon: o motor de IA recebe só o resultado.
 */
export type Risco = 'ler' | 'organizar' | 'enviar' | 'apagar';
export type Args = Record<string, unknown>;

export interface Param { tipo: 'texto' | 'numero' | 'booleano' | 'lista'; obrigatorio?: boolean; descricao: string; opcoes?: string[]; padrao?: string | number | boolean; max?: number }

export interface Resultado {
  /** o que o agente lê */
  texto: string;
  /** veio conteúdo escrito por outras pessoas (e-mail, mensagem, tarefa de terceiros): é dado, nunca instrução */
  deFora?: boolean;
  /** veio conteúdo privado da conta: depois disso a sessão não acessa endereços arbitrários (regra.ts) */
  privado?: boolean;
  /** endereço do que foi criado ou alterado, para o recibo */
  url?: string | null;
}

/** Chamada já autenticada com a conta. Escrita precisa dizer `kind: 'write'` (lib/http.ts: não repete às cegas). */
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; kind?: 'read' | 'write' }) => Promise<any>;

export interface CtxAcao { workspaceId: string; tz: string; http: Http; /** conector que manda a credencial no corpo (Omie): nunca vai ao modelo */ creds?: Record<string, string> }

export interface Acao {
  /** ex.: 'email.buscar' */
  id: string;
  /** para o agente: como usar a ação (pode citar parâmetros e outras ações) */
  descricao: string;
  /** para a pessoa (Conexões e o teste): curto e sem jargão; sem ele, a tela mostra a descricao */
  rotulo?: string;
  /** pode depender dos parâmetros: evento com convidados envia convite, sem convidados só organiza a agenda */
  risco: Risco | ((a: Args) => Risco);
  params: Record<string, Param>;
  /** permissões da conta sem as quais a ação não funciona (para pedir a autorização certa) */
  escopos?: string[];
  /** só conta de trabalho ou escola (ex.: Teams) */
  trabalho?: boolean;
  /** o que vai acontecer, por extenso, para o cartão de confirmação e o registro */
  resumo(a: Args): string;
  /**
   * Antes de decidir: lê o que o cartão precisa mostrar (destinatário e texto reais, assunto do e-mail que será apagado) e
   * fixa o alvo já resolvido em `args`, para o clique executar exatamente o que a pessoa viu. `confirmar`: o destino não é
   * confiável o bastante para ir direto (ex.: nome escolhido pelo próprio remetente). Lê a conta, nunca escreve.
   * `fixou`: os parâmetros trocados pelo id do alvo lido. O cartão e o resultado que a pessoa lê mostram o que o agente
   * pediu e o `detalhe`; o id fica para o clique e para o agente.
   */
  preparar?(ctx: CtxAcao, a: Args): Promise<{ detalhe?: string; args?: Args; confirmar?: string; fixou?: string[] }>;
  run(ctx: CtxAcao, a: Args): Promise<Resultado>;
}

// ------------------------------------------------------------------------------------------- quadros de tarefas
export interface NovaTarefa { titulo: string; descricao?: string; /** externalId da coluna; vazio = a primeira */ coluna?: string; /** AAAA-MM-DD */ prazo?: string }
export interface MudancaTarefa { titulo?: string; descricao?: string; /** null = tira o prazo */ prazo?: string | null }
/** `versao`: a marca que a leitura do quadro (getBoard) vai ver depois da escrita; sem ela, a próxima leitura confere. */
export interface Escrita { id: string; versao?: string | null; url?: string | null }

/**
 * Escreve num quadro. `quadro`, `tarefa` e `coluna` são os mesmos ids que `getBoard` devolve (externalId), inclusive os
 * compostos ("planner:abc") e os sintéticos ("__tarefas__", "open", "done"). Depois de `concluir`, a próxima leitura tem
 * de ver a tarefa como concluída: cada escritor faz o inverso da leitura do seu aplicativo.
 */
export interface EscritorTarefas {
  /** permissões da conta necessárias para escrever (SSO) */
  escopos?: string[];
  criar(quadro: string, t: NovaTarefa): Promise<Escrita>;
  concluir(quadro: string, tarefa: string, feita: boolean): Promise<Escrita>;
  mover(quadro: string, tarefa: string, coluna: string): Promise<Escrita>;
  editar(quadro: string, tarefa: string, m: MudancaTarefa): Promise<Escrita>;
  comentar?(quadro: string, tarefa: string, texto: string): Promise<void>;
}

/** Erro que o agente e a pessoa podem entender e corrigir (parâmetro errado, escolha necessária, recurso inexistente). */
export class ErroAcao extends Error {
  readonly opcoes?: string[];
  /** a tarefa chegou a nascer no aplicativo antes do erro: o espelho liga o card a ela, sem duplicar nem criar de novo */
  readonly criado?: Escrita;
  constructor(mensagem: string, opcoes?: string[], criado?: Escrita) { super(mensagem); this.opcoes = opcoes; this.criado = criado; }
}

/** Id num caminho de endereço. "." e ".." passariam pelo encodeURIComponent e mudariam a rota. */
export function seg(id: unknown): string {
  const s = String(id ?? '');
  if (!s || s === '.' || s === '..') throw new ErroAcao('id inválido');
  return encodeURIComponent(s);
}

const nada = (v: unknown) => v === undefined || v === null || v === '';
export const txt = (a: Args, k: string, max = 20_000): string | undefined => {
  if (nada(a[k])) return undefined;
  if (typeof a[k] !== 'string' && typeof a[k] !== 'number') throw new ErroAcao(`"${k}" precisa ser texto`);
  return String(a[k]).slice(0, max);
};
export const precisa = (a: Args, k: string, max = 20_000): string => {
  const v = txt(a, k, max)?.trim();
  if (!v) throw new ErroAcao(`falta "${k}"`);
  return v;
};
export const num = (a: Args, k: string, padrao: number, teto: number): number => {
  if (nada(a[k])) return padrao;
  const n = Number(a[k]);
  if (!Number.isFinite(n) || n < 1) throw new ErroAcao(`"${k}" precisa ser um número positivo`);
  return Math.min(Math.floor(n), teto);
};
export const lista = (a: Args, k: string, teto = 50): string[] => {
  if (nada(a[k])) return [];
  const raw = Array.isArray(a[k]) ? (a[k] as unknown[]) : String(a[k]).split(/[,;]/);
  return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, teto);
};
const DIA = /^\d{4}-\d{2}-\d{2}$/;
/** AAAA-MM-DD conferido; prazo inválido é erro (nunca grava uma data errada). */
export const dia = (a: Args, k: string): string | undefined => {
  const v = txt(a, k, 40)?.trim();
  if (!v) return undefined;
  const d = v.slice(0, 10);
  if (!DIA.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) throw new ErroAcao(`"${k}" precisa estar no formato AAAA-MM-DD`);
  return d;
};
/** Endereço de e-mail conferido e sem quebra de linha (evita injeção de cabeçalho). */
export const emails = (a: Args, k: string, teto = 20): string[] => {
  const l = lista(a, k, teto);
  for (const e of l) if (!/^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/.test(e)) throw new ErroAcao(`"${e}" não é um e-mail válido`);
  return l;
};

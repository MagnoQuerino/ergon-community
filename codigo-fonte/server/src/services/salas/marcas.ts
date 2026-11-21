/**
 * As regras puras das Salas (sem banco), para testar sozinhas:
 * - MARCAS: menção (@pessoa, @agente) e cessão (#pessoa) só existem quando a TELA as formou (a pessoa digitou o nome igual
 *   a um sugerido ou apertou Tab) e mandou junto da mensagem, com a posição no texto. O servidor nunca varre o texto atrás
 *   de @ ou #: texto colado, canal externo, comando e mensagem antiga não disparam nada (regra do dono, rc.42). Aqui só se
 *   confere o que veio: o trecho do texto bate com o marcador + o nome do membro, e o membro está na sala. Marca de quem
 *   não está na sala cai calada (nada vaza para ela, e a resposta não diz quem está ou não).
 * - PERMISSÃO EFETIVA: o agente usa as conexões de QUEM PEDIU. As conexões deste aparelho são da pessoa dona dele; outra
 *   pessoa só as usa por cessão dela (ativa, naquela sala, para aquele pedinte), com a governança deixando. Papel de leitura
 *   (viewer) só consulta.
 * - CESSÃO: prazos (só desta vez, 24 h, 7 dias, 1 mês, sempre) e quando vale.
 * - AGENTE CHAMANDO AGENTE: uma vez por mensagem humana, profundidade 1 (sem laço).
 */
export type TipoMarca = 'pessoa' | 'agente' | 'cessao';
export interface Marca { tipo: TipoMarca; chave: string; inicio: number; fim: number }
export interface Membro { tipo: 'pessoa' | 'agente'; chave: string; nome: string }
export interface MarcasConferidas { pessoas: string[]; agentes: string[]; cessoes: string[]; marcas: Marca[] }

/** Limites por mensagem: menções a agentes (cada um responde, em ordem), a pessoas e pedidos de cessão. */
export const MAX_AGENTES = 5;
export const MAX_PESSOAS = 20;
export const MAX_CESSOES = 10;
export const MAX_MARCAS = 40;

const MARCADOR: Record<TipoMarca, '@' | '#'> = { pessoa: '@', agente: '@', cessao: '#' };

/**
 * Confere as marcas que a tela mandou. `eu`: quem escreve (cessão para si mesmo não faz sentido; menção a si, também não).
 * Fora do formato, fora do texto, de quem não está na sala ou repetida: cai, sem erro (a mensagem segue como texto).
 */
export function conferirMarcas(texto: string, marcas: unknown, membros: Membro[], eu: string): MarcasConferidas {
  const out: MarcasConferidas = { pessoas: [], agentes: [], cessoes: [], marcas: [] };
  if (!Array.isArray(marcas)) return out;
  const porChave = new Map(membros.map((m) => [`${m.tipo}:${m.chave}`, m]));
  const usados: Array<[number, number]> = [];
  for (const bruta of marcas.slice(0, MAX_MARCAS)) {
    const m = bruta as Partial<Marca>;
    if (!m || (m.tipo !== 'pessoa' && m.tipo !== 'agente' && m.tipo !== 'cessao') || typeof m.chave !== 'string' || !Number.isInteger(m.inicio) || !Number.isInteger(m.fim)) continue;
    const inicio = m.inicio as number; const fim = m.fim as number;
    if (inicio < 0 || fim > texto.length || fim <= inicio) continue;
    const membro = porChave.get(`${m.tipo === 'cessao' ? 'pessoa' : m.tipo}:${m.chave}`);
    if (!membro || membro.chave === eu) continue;
    // o trecho é exatamente o marcador + o nome (a tela formou a marca assim); sobreposta a outra, não vale
    if (texto.slice(inicio, fim) !== `${MARCADOR[m.tipo]}${membro.nome}`) continue;
    if (usados.some(([a, b]) => inicio < b && fim > a)) continue;
    const lista = m.tipo === 'pessoa' ? out.pessoas : m.tipo === 'agente' ? out.agentes : out.cessoes;
    const teto = m.tipo === 'pessoa' ? MAX_PESSOAS : m.tipo === 'agente' ? MAX_AGENTES : MAX_CESSOES;
    if (lista.includes(membro.chave) || lista.length >= teto) continue;
    lista.push(membro.chave); usados.push([inicio, fim]);
    out.marcas.push({ tipo: m.tipo, chave: membro.chave, inicio, fim });
  }
  out.marcas.sort((a, b) => a.inicio - b.inicio);
  return out;
}

// ------------------------------------------------------------------------------------------------ cessão
export type Prazo = 'vez' | '24h' | '7d' | '30d' | 'sempre';
export const PRAZOS: readonly Prazo[] = ['vez', '24h', '7d', '30d', 'sempre'];
const PRAZO_MS: Record<Exclude<Prazo, 'vez' | 'sempre'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/** Quando a cessão expira (null: não expira por tempo — 'sempre', e 'vez', que vale só para o pedido dela). */
export function expiraEm(prazo: Prazo, agora: number): string | null {
  return prazo === 'vez' || prazo === 'sempre' ? null : new Date(agora + PRAZO_MS[prazo]).toISOString();
}

export interface Cessao { prazo: Prazo; pedinte_chave: string; message_id: string | null; expira_em: string | null; revogada_em: string | null }
/** A cessão vale para este pedido (de `pedinte`, a partir da mensagem `origem`) agora? */
export function cessaoVale(c: Cessao, pedido: { pedinte: string; origem: string }, agora: number): boolean {
  if (c.revogada_em) return false;
  if (c.pedinte_chave !== pedido.pedinte) return false;
  if (c.prazo === 'vez') return c.message_id === pedido.origem;
  return c.expira_em === null || Date.parse(c.expira_em) > agora;
}

// ------------------------------------------------------------------------------------------------ permissão efetiva
export type Papel = 'owner' | 'admin' | 'editor' | 'viewer';
export type Efetiva = 'propria' | 'cedida' | 'so_leitura' | 'sem_acesso';
/**
 * As conexões deste aparelho podem ser usadas por este pedido? `dono`: a pessoa dona das conexões daqui (no computador,
 * quem o usa; na nuvem do workspace, a conta dona do workspace). `pedinte`: quem mencionou o agente. Ler não tem efeito;
 * o resto ("organizar", "enviar", "apagar") é ação com efeito, que papel de leitura não pede.
 */
export function permissaoEfetiva(x: { dono: string; pedinte: string; papelPedinte: Papel | null; risco: string; cessaoAtiva: boolean; governancaCessao: boolean }): Efetiva {
  if (!x.papelPedinte) return 'sem_acesso'; // saiu do workspace
  if (x.papelPedinte === 'viewer' && x.risco !== 'ler') return 'so_leitura';
  if (x.pedinte === x.dono) return 'propria';
  return x.governancaCessao && x.cessaoAtiva ? 'cedida' : 'sem_acesso';
}

// ------------------------------------------------------------------------------------------------ agente chamando agente
/** Profundidade máxima: o agente chamado por outro agente não chama mais ninguém. */
export const PROFUNDIDADE_MAX = 1;
/** Pode um agente (na profundidade `prof`) chamar outro, se a mensagem humana já gastou `chamadas` chamadas de agente? */
export const podeChamarAgente = (prof: number, chamadas: number): boolean => prof < PROFUNDIDADE_MAX && chamadas < 1;

/** A linha de controle com que um agente chama um colega da sala: [[chamar agente="Nome" pedido="..."]] (estrutura, não @). */
const CHAMAR = /\[\[chamar\s+agente="([^"\]]{1,80})"(?:\s+pedido="([^"\]]{0,2000})")?\s*\]\]/;
export function chamadaDoAgente(saida: string | null | undefined): { agente: string; pedido: string } | null {
  const m = CHAMAR.exec(saida ?? '');
  return m ? { agente: m[1].trim(), pedido: (m[2] ?? '').trim() } : null;
}
/** A resposta sem as linhas de controle das salas. */
export const semControle = (s: string): string => s.replace(/\[\[chamar\s+[^\]]*\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

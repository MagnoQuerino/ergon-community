/**
 * "Baixar meus dados": um ZIP legível (decifrado) com o que é da pessoa, para ela guardar antes de excluir a conta ou a
 * qualquer momento. Só a própria pessoa baixa (a rota confere), com a identidade confirmada há pouco.
 *
 * O que entra (critério, sem vazar dado de outra pessoa):
 * - workspaces de que ela é dona: as conversas dela (as de outra pessoa que participe do workspace ficam de fora), as
 *   tarefas do quadro, os documentos e as entregas (menos os arquivos que outra pessoa enviou), as rotinas, a equipe
 *   (agentes, setores, instruções, competências treinadas, o esqueleto), as regras aprovadas e só os NOMES das contas e
 *   dos contatos conectados;
 * - workspaces de outra pessoa em que ela participa: só as conversas dela e os arquivos que ela enviou (a entrega que o
 *   agente produziu lá fica com quem é dono do workspace: a conversa cita o nome e diz isso);
 * - o cadastro dela (usuário, nome, foto).
 * Nunca: senha, chave pessoal, frase, tokens, segredos e credenciais das conexões (nem o trecho que parece um deles nas
 * configurações: só o trecho sai, o resto do texto fica).
 *
 * Memória e vez do servidor: cada arquivo é lido do disco sem travar, compactado fora da linha principal e só o
 * compactado fica guardado; entre um item e outro o servidor atende os outros pedidos; tudo tem teto (documentos e
 * texto, cada um com o seu); o arquivo sai aos poucos na resposta. O que passar do teto fica listado no LEIA-ME.
 */
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { ZIP_MAX_ENTRIES, ZipMontador } from '../lib/zip.ts';
import { CLOSED_VALUE } from '../security/fields.ts';
import { VERSION } from '../version.ts';
import { openArtifactAsync } from './artifacts.ts';
import { exportBlueprint } from './blueprint.ts';
import { toCsv } from './csv.ts';
import type { WorkspaceOwners } from './people.ts';
import { workspaceTz } from './routine-proposals.ts';
import { DEFAULT_TZ } from './routine-time.ts';
import type { Routines } from './routines.ts';

/** documentos e entregas: até 200 MB por arquivo baixado */
export const MEUS_DADOS_MAX_BYTES = 200 * 1024 * 1024;
/** o texto (conversas, tarefas, equipe, competências, rotinas, regras): até 50 MB por arquivo baixado */
export const MEUS_DADOS_MAX_TEXTO = 50 * 1024 * 1024;
const MAX_ENTRADAS = Math.min(20_000, ZIP_MAX_ENTRIES - 10);

export interface MeusDadosDeps { db: Db; cfg: Pick<Config, 'filesDir'>; routines: Routines; owners: WorkspaceOwners }
/** idioma: o da tela de quem pediu (cabeçalho X-Ergon-Lang): em inglês, o LEIA-ME vem como README.txt, em inglês */
export interface MeusDadosOpts { maxBytes?: number; maxTexto?: number; maxEntradas?: number; agora?: Date; idioma?: 'pt-BR' | 'en' }
export interface DeFora { arquivo: string; tamanho: number; motivo: string }
export interface MeusDados {
  /** o arquivo em pedaços, para mandar aos poucos (chamar uma vez só) */
  partes(): Generator<Buffer>;
  /** o tamanho exato do arquivo */
  bytes: number;
  nome: string; arquivos: number; deFora: DeFora[];
}

// ---------------------------------------------------------------- nomes seguros
const RESERVADOS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
/**
 * Um pedaço de caminho que abre em qualquer sistema: sem barras, sem os caracteres que o Windows recusa, sem controles,
 * sem ponto ou espaço nas pontas (nada de ".." nem nome escondido), sem os nomes reservados do Windows, curto.
 */
export function nomeSeguro(nome: string | null | undefined, max = 80): string {
  let s = String(nome ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // marcas invisíveis e de direção do texto
    .replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = 'sem nome';
  if (RESERVADOS.test(s)) s = `_${s}`;
  if (s.length > max) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(s)?.[0] ?? '';
    s = s.slice(0, Math.max(1, max - ext.length)).replace(/[.\s]+$/, '') + ext;
  }
  return s;
}

/** os arquivos da raiz do ZIP: nenhuma pasta de workspace pode ter um destes nomes */
const NA_RAIZ = ['LEIA-ME.txt', 'README.txt', 'minha-conta.json', 'foto-de-perfil.jpg', 'foto-de-perfil.png', 'foto-de-perfil.webp'];

/**
 * Os caminhos do ZIP, num conjunto só para arquivos e pastas (sem diferença de maiúsculas, como no Windows): nenhum
 * arquivo tem o nome de uma pasta e vice-versa. Arquivo repetido ganha " (2)", " (3)"...; pasta que bate com um arquivo
 * também, e todas as entradas dessa pasta seguem o novo nome.
 */
export class Caminhos {
  private readonly arquivos = new Set<string>(NA_RAIZ.map((n) => n.toLowerCase()));
  /** pasta pedida (com os pais já resolvidos) → pasta gravada */
  private readonly pastas = new Map<string, string>();
  private readonly pastasGravadas = new Set<string>();
  private livre(c: string): boolean { const k = c.toLowerCase(); return !this.arquivos.has(k) && !this.pastasGravadas.has(k); }
  private registrarPasta(pedido: string, gravada: string): void { this.pastas.set(pedido.toLowerCase(), gravada); this.pastasGravadas.add(gravada.toLowerCase()); }

  /** A pasta de um workspace, no primeiro nível, só dele (mesmo com nomes iguais); devolve o nome exato gravado. */
  raiz(nome: string, sufixo = ''): string {
    for (let n = 1; ; n++) {
      const fim = `${sufixo}${n === 1 ? '' : ` (${n})`}`;
      const c = nomeSeguro(`${nomeSeguro(nome, 80 - fim.length)}${fim}`);
      if (this.livre(c)) { this.registrarPasta(c, c); return c; }
    }
  }
  /** um arquivo fixo da raiz (LEIA-ME, minha-conta): o nome já está guardado para ele */
  fixo(nome: string): string { return nome; }

  private pasta(partes: string[]): string {
    let real = '';
    for (const p of partes) {
      const junto = (s: string) => (real ? `${real}/${s}` : s);
      const seg = this.pastas.has(junto(p).toLowerCase()) ? p : nomeSeguro(p);
      const pedido = junto(seg);
      let gravada = this.pastas.get(pedido.toLowerCase());
      if (!gravada) {
        for (let n = 1; ; n++) {
          const c = junto(n === 1 ? seg : `${nomeSeguro(seg, 80 - ` (${n})`.length)} (${n})`);
          if (this.livre(c)) { gravada = c; break; }
        }
        this.registrarPasta(pedido, gravada);
      }
      real = gravada;
    }
    return real;
  }

  novo(pastas: string[], arquivo: string): string {
    const dir = this.pasta(pastas);
    const nome = nomeSeguro(arquivo, 100);
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(nome)?.[0] ?? '';
    const base = ext ? nome.slice(0, -ext.length) : nome;
    for (let n = 1; ; n++) {
      const candidato = `${dir ? `${dir}/` : ''}${n === 1 ? nome : `${base} (${n})${ext}`}`;
      if (this.livre(candidato)) { this.arquivos.add(candidato.toLowerCase()); return candidato; }
    }
  }
}

/** Link relativo em Markdown: cada pedaço codificado (o "#" e os parênteses também, senão o link quebra). */
export const linkRelativo = (caminho: string): string =>
  caminho.split('/').map((p) => (p === '..' ? p : encodeURIComponent(p).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))).join('/');

// ---------------------------------------------------------------- sem segredos
const NOME_SECRETO = new Set(['token', 'secret', 'segredo', 'senha', 'password', 'passwd', 'pwd', 'pin', 'otp', 'totp', 'cookie', 'cookies', 'authorization',
  'auth', 'bearer', 'chave', 'apikey', 'xapikey', 'privatekey', 'chaveprivada', 'chavesecreta', 'chaveapi', 'chavedeapi', 'chavedaapi', 'clientsecret',
  'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'credentials', 'credential', 'credenciais', 'credencial']);
/** terminações: githubToken, client_secret, minhaSenha, api_key, private_key... (não "tokenCount" nem "palavrasChave") */
const FIM_SECRETO = /(token|secret|segredo|senha|password|passwd|apikey|privatekey|chaveprivada|chavesecreta|chavedeapi|chaveapi|credentials?|credenciais|credencial)$/;
const INICIO_SECRETO = /^(senha|password|segredo|apikey|chaveapi|chavesecreta|chaveprivada|privatekey|clientsecret)/;
/** um nome de campo que nunca sai: o nome inteiro ou a terminação, sem diferença de maiúsculas, acentos e separadores */
export function campoSecreto(k: string): boolean {
  const n = k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return NOME_SECRETO.has(n) || FIM_SECRETO.test(n) || INICIO_SECRETO.test(n);
}

const REMOVIDO = '[removido]';
/** valores com cara de credencial em qualquer lugar do texto (até dentro de um link): prefixos conhecidos, JWT, "Bearer ...", chave PEM */
const VALOR_SECRETO = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|ya29\.|AIza|AKIA|EAA[A-Za-z0-9]{6})[A-Za-z0-9_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
/** num link, o valor de um parâmetro com nome de credencial (?token=..., &api_key=...) */
const PARAMETRO_SECRETO = /([?&#](?:access_?token|refresh_?token|id_?token|token|api_?key|apikey|key|secret|client_?secret|sig|signature|password|senha|code|auth)=)[^&#\s]+/gi;
const LINK = /(\bhttps?:\/\/[^\s<>"'\]]+)/i;
const LONGO = /[A-Za-z0-9_+=-]{40,}/g;
/** fora dos links, uma sequência longa só conta como chave se mistura maiúsculas, minúsculas e dígitos (ou é hexadecimal) */
const pareceChave = (m: string) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m)) || (/^[0-9a-fA-F]+$/.test(m) && /\d/.test(m) && /[a-fA-F]/.test(m));

/** O texto com cada trecho que parece credencial trocado por "[removido]" (só o trecho: o resto fica como estava). */
export function tirarSegredos(s: string): string {
  let out = s;
  for (const r of VALOR_SECRETO) out = out.replace(r, REMOVIDO);
  out = out.replace(PARAMETRO_SECRETO, `$1${REMOVIDO}`);
  return out.split(LINK).map((pedaco, i) => (i % 2 ? pedaco : pedaco.replace(LONGO, (m) => (pareceChave(m) ? REMOVIDO : m)))).join('');
}
export const pareceSegredo = (v: string): boolean => tirarSegredos(v) !== v;
/** Cópia sem campos secretos e com os trechos que parecem credencial trocados por "[removido]". */
export function semSegredos(v: unknown, fundo = 0): unknown {
  if (fundo > 12) return null;
  if (typeof v === 'string') return tirarSegredos(v);
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => semSegredos(x, fundo + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!campoSecreto(k)) out[k] = semSegredos(x, fundo + 1);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- ajudantes
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const lerJson = (s: string | null | undefined, padrao: unknown = null): unknown => { if (!s) return padrao; try { return JSON.parse(s); } catch { return padrao; } };
const aberto = (v: string | null | undefined) => (v === CLOSED_VALUE ? null : v ?? null);
const relogios = new Map<string, Intl.DateTimeFormat>();
const relogio = (tz: string, longo = false) => {
  const k = `${tz}|${longo}`;
  let f = relogios.get(k);
  if (!f) { f = new Intl.DateTimeFormat('pt-BR', { dateStyle: longo ? 'long' : 'short', timeStyle: 'short', timeZone: tz }); relogios.set(k, f); }
  return f;
};
/** data e hora no fuso do workspace (não no do computador que roda o servidor) */
export const quando = (iso: string | null | undefined, tz: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : relogio(tz).format(d);
};
/** AAAA-MM-DD no fuso dado */
export const diaNoFuso = (d: Date, tz: string): string => {
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const data = (iso: string | null | undefined): Date | undefined => { if (!iso) return undefined; const d = new Date(iso); return Number.isNaN(d.getTime()) ? undefined : d; };
const mb = (n: number) => `${(Math.round((n / 1024 / 1024) * 10) / 10).toLocaleString('pt-BR')} MB`;
/** devolve a vez: o servidor atende os outros pedidos antes do próximo item */
const pausa = () => new Promise<void>((ok) => setImmediate(ok));
function agrupar<T, K>(lista: T[], chave: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of lista) { const k = chave(x); const g = m.get(k); if (g) g.push(x); else m.set(k, [x]); }
  return m;
}
const SITUACAO: Record<string, string> = {
  solicitada: 'Na fila', processamento: 'Trabalhando', resultado: 'Trabalhando', validacao: 'Trabalhando', concluida: 'Feito',
  aguardando_info: 'Precisa de você', aguardando_aprovacao: 'Esperando sua aprovação', revisao: 'Precisa da sua decisão', falha: 'Não foi feito',
};
/** já compactado por natureza: vai guardado (compactar de novo só gasta tempo) */
const JA_COMPACTADO = /^(image\/(png|jpeg|webp|gif)|application\/(pdf|zip|x-zip-compressed|vnd\.openxmlformats-officedocument\..+))$/;
/** a lixeira fica numa pasta só dela, ao lado de "documentos" (uma pasta da pessoa chamada "Lixeira" não se mistura) */
const PASTA_LIXEIRA = 'documentos (lixeira)';

interface Doc { id: string; filename: string; mime: string; size: number; folder_id: string | null; deleted_at: string | null; owner_user_id: string | null; created_at: string; task_id: string | null }

/** Monta o arquivo. `user`: a pessoa que pediu (a rota garante que é ela mesma). */
export async function exportarMeusDados(d: MeusDadosDeps, user: { id: string; username: string; displayName: string }, opts: MeusDadosOpts = {}): Promise<MeusDados> {
  const { db } = d;
  const maxBytes = opts.maxBytes ?? MEUS_DADOS_MAX_BYTES;
  const maxTexto = opts.maxTexto ?? MEUS_DADOS_MAX_TEXTO;
  const maxEntradas = Math.min(opts.maxEntradas ?? MAX_ENTRADAS, MAX_ENTRADAS);
  const agora = opts.agora ?? new Date();
  const caminhos = new Caminhos();
  const zip = new ZipMontador();
  const deFora: DeFora[] = [];
  let bytesDocs = 0; let bytesTexto = 0;
  const pessoas = new Set(db.all<{ id: string }>('SELECT id FROM users').map((u) => u.id));
  const outraPessoa = (uid: string | null | undefined) => !!uid && uid !== user.id && pessoas.has(uid);
  /** um texto (os documentos contam no teto deles, à parte) */
  const addTexto = async (pastas: string[], nome: string, conteudo: string, quando?: Date, tz?: string): Promise<string | null> => {
    const tamanho = Buffer.byteLength(conteudo);
    if (zip.quantas >= maxEntradas - 1) { deFora.push({ arquivo: [...pastas, nome].join('/'), tamanho, motivo: 'arquivos demais para um só download' }); return null; }
    if (bytesTexto + tamanho > maxTexto) { deFora.push({ arquivo: [...pastas, nome].join('/'), tamanho, motivo: `passaria do limite de ${mb(maxTexto)} de texto deste download` }); return null; }
    const caminho = caminhos.novo(pastas, nome);
    await zip.add({ name: caminho, data: conteudo, mtime: quando ?? agora, tz });
    bytesTexto += tamanho;
    return caminho;
  };

  const memberships = db.all<{ workspace_id: string; role: string; name: string }>(
    'SELECT m.workspace_id, m.role, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at', user.id);
  const donos = new Set(d.owners.owned(user.id));
  // o fuso da pessoa: o do primeiro workspace dela (ou do primeiro em que participa)
  const wsDoFuso = memberships.find((m) => donos.has(m.workspace_id) && db.workspaceOpen(m.workspace_id)) ?? memberships.find((m) => db.workspaceOpen(m.workspace_id));
  const tzPessoa = wsDoFuso ? workspaceTz(db, wsDoFuso.workspace_id) : DEFAULT_TZ;
  const fechados: string[] = [];
  const resumo: string[] = [];
  /** o mesmo resumo, em inglês (o README de quem usa a tela em inglês) */
  const resumoEn: string[] = [];

  for (const m of memberships) {
    const ws = m.workspace_id;
    const dona = donos.has(ws);
    const nomeWs = aberto(m.name) ?? 'Workspace';
    if (!db.workspaceOpen(ws)) { fechados.push(nomeWs); continue; }
    const tz = workspaceTz(db, ws);
    const raiz = caminhos.raiz(nomeWs, dona ? '' : ' (de outra pessoa)');
    const agentes = new Map(db.all<{ id: string; name: string; role: string }>('SELECT id, name, role FROM agents WHERE workspace_id = ?', ws).map((a) => [a.id, a]));

    // documentos e entregas primeiro: as conversas e as tarefas apontam para o caminho de cada um
    const pastas = new Map(db.all<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM folders WHERE workspace_id = ?', ws).map((f) => [f.id, f]));
    const caminhoDaPasta = (id: string | null): string[] => {
      const out: string[] = []; const vistos = new Set<string>();
      for (let cur = id ? pastas.get(id) : undefined; cur && !vistos.has(cur.id) && out.length < 20; cur = cur.parent_id ? pastas.get(cur.parent_id) : undefined) { vistos.add(cur.id); out.unshift(aberto(cur.name) ?? 'Pasta'); }
      return out;
    };
    const todos = db.all<Doc>('SELECT id, filename, mime, size, folder_id, deleted_at, owner_user_id, created_at, task_id FROM artifacts WHERE workspace_id = ? ORDER BY deleted_at IS NOT NULL, created_at', ws);
    const todosPorId = new Map(todos.map((a) => [a.id, a]));
    const docs = todos.filter((a) => (dona ? !outraPessoa(a.owner_user_id) : a.owner_user_id === user.id));
    const docIds = new Set(docs.map((a) => a.id));
    const docPath = new Map<string, string>();
    const foraIds = new Set<string>();
    let nDocs = 0;
    for (const a of docs) {
      await pausa();
      const pasta = [raiz, a.deleted_at ? PASTA_LIXEIRA : 'documentos', ...caminhoDaPasta(a.folder_id)];
      const nome = aberto(a.filename) ?? 'arquivo';
      const fora = (tamanho: number, motivo: string) => { deFora.push({ arquivo: [...pasta, nome].join('/'), tamanho, motivo }); foraIds.add(a.id); };
      const limite = `passaria do limite de ${mb(maxBytes)} de documentos deste download`;
      if (bytesDocs + (Number(a.size) || 0) > maxBytes) { fora(Number(a.size) || 0, limite); continue; }
      if (zip.quantas >= maxEntradas - 1) { fora(Number(a.size) || 0, 'arquivos demais para um só download'); continue; }
      let conteudo: Buffer;
      try { conteudo = (await openArtifactAsync(db, d.cfg.filesDir, ws, a.id)).data; } catch { fora(Number(a.size) || 0, 'não foi possível abrir o arquivo guardado'); continue; }
      if (bytesDocs + conteudo.length > maxBytes) { fora(conteudo.length, limite); continue; }
      const caminho = caminhos.novo(pasta, nome);
      await zip.add({ name: caminho, data: conteudo, store: JA_COMPACTADO.test(a.mime), mtime: data(a.created_at), tz });
      bytesDocs += conteudo.length; nDocs++;
      docPath.set(a.id, caminho);
    }
    const docNome = (id: string) => aberto(todosPorId.get(id)?.filename) ?? 'arquivo';
    /** caminho relativo de dentro de <raiz>/conversas ou <raiz>/tarefas até o documento */
    const rel = (id: string) => { const p = docPath.get(id); return p ? `../${p.slice(raiz.length + 1)}` : null; };
    /** o anexo que não veio: por quê, com o nome original */
    const porQueNaoVeio = (id: string): string => {
      if (foraIds.has(id)) return 'não veio neste download: veja o LEIA-ME';
      if (!todosPorId.has(id)) return 'o arquivo foi apagado';
      if (!docIds.has(id)) return dona ? 'enviado por outra pessoa: fica com ela, não vem neste download' : 'fica no workspace de quem é dono; não vem neste download';
      return 'não veio neste download: veja o LEIA-ME';
    };

    // conversas: as dela (nas dela, também as que não têm dona, como as de rotina)
    const convs = db.all<{ id: string; agent_id: string; owner_user_id: string | null; title: string | null; created_at: string; archived_at: string | null }>(
      'SELECT id, agent_id, owner_user_id, title, created_at, archived_at FROM conversations WHERE workspace_id = ? ORDER BY created_at', ws)
      .filter((c) => c.owner_user_id === user.id || (dona && !c.owner_user_id));
    for (const c of convs) {
      await pausa();
      const ag = agentes.get(c.agent_id);
      const agNome = aberto(ag?.name) ?? 'Agente';
      const msgs = db.all<{ id: string; role: string; author_user_id: string | null; content: string; created_at: string }>(
        'SELECT id, role, author_user_id, content, created_at FROM messages WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at, rowid', ws, c.id);
      const anexos = agrupar(db.all<{ message_id: string; artifact_id: string }>('SELECT ma.message_id, ma.artifact_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.conversation_id = ? AND ma.workspace_id = ?', c.id, ws), (r) => r.message_id);
      const titulo = aberto(c.title) || `Conversa com ${agNome}`;
      const linhas = [`# ${titulo}`, '', `- Agente: ${agNome}${ag?.role ? ` (${aberto(ag.role)})` : ''}`, `- Começou em: ${quando(c.created_at, tz)}`, `- Mensagens: ${msgs.length}`];
      if (c.archived_at) linhas.push(`- Arquivada em: ${quando(c.archived_at, tz)}`);
      linhas.push('', '---', '');
      for (const msg of msgs) {
        const quem = msg.role === 'agent' ? agNome : msg.role === 'system' ? 'Aviso do sistema' : outraPessoa(msg.author_user_id) ? 'Outra pessoa' : 'Você';
        linhas.push(`**${quem}** · ${quando(msg.created_at, tz)}`, '', aberto(msg.content) ?? '(mensagem que não abriu)');
        const an = anexos.get(msg.id) ?? [];
        if (an.length) {
          linhas.push('', 'Anexos:');
          for (const { artifact_id: id } of an) { const r = rel(id); linhas.push(r ? `- [${docNome(id)}](${linkRelativo(r)})` : `- ${docNome(id)} (${porQueNaoVeio(id)})`); }
        }
        linhas.push('', '');
      }
      const ultima = msgs.length ? msgs[msgs.length - 1].created_at : c.created_at;
      const diaConv = diaNoFuso(new Date(c.created_at), tz) || String(c.created_at).slice(0, 10);
      await addTexto([raiz, 'conversas'], `${diaConv} ${agNome} - ${titulo}.md`, linhas.join('\n'), data(ultima), tz);
    }

    let nTarefas = 0;
    if (dona) {
      // tarefas (cards) em planilha e em JSON
      const tarefas = db.all<{ id: string; number: number | null; title: string; description: string | null; completed: number; completed_at: string | null; archived: number; created_at: string; updated_at: string;
        due_on: string | null; work_state: string | null; agent_id: string | null; external_assignee: string | null; coluna: string | null; quadro: string | null }>(
        `SELECT t.id, t.number, t.title, t.description, t.completed, t.completed_at, t.archived, t.created_at, t.updated_at, t.due_on, t.work_state, t.agent_id, t.external_assignee,
                c.name AS coluna, b.name AS quadro
           FROM tasks t LEFT JOIN columns c ON c.id = t.column_id LEFT JOIN boards b ON b.id = t.board_id
          WHERE t.workspace_id = ? ORDER BY t.created_at, t.rowid`, ws);
      nTarefas = tarefas.length;
      const situacao = (t: { completed: number; work_state: string | null }) => (Number(t.completed) ? 'Feito' : SITUACAO[t.work_state ?? 'solicitada'] ?? 'Na fila');
      const responsavel = (t: { agent_id: string | null; external_assignee: string | null }) => aberto(t.agent_id ? agentes.get(t.agent_id)?.name : null) ?? aberto(t.external_assignee) ?? '';
      await pausa();
      await addTexto([raiz, 'tarefas'], 'tarefas.csv', toCsv([
        ['Número', 'Título', 'Descrição', 'Situação', 'Coluna', 'Quadro', 'Responsável', 'Prazo', 'Criada em', 'Atualizada em', 'Concluída em', 'Arquivada'],
        ...tarefas.map((t) => [t.number ?? '', aberto(t.title) ?? '', aberto(t.description) ?? '', situacao(t), aberto(t.coluna) ?? '', aberto(t.quadro) ?? '', responsavel(t), t.due_on ?? '',
          quando(t.created_at, tz), quando(t.updated_at, tz), quando(t.completed_at, tz), Number(t.archived) ? 'sim' : 'não']),
      ]), undefined, tz);
      const etapas = agrupar(db.all<{ task_id: string; position: number; title: string; status: string; output: string | null; agent_id: string | null; done_at: string | null }>(
        'SELECT task_id, position, title, status, output, agent_id, done_at FROM task_steps WHERE workspace_id = ? ORDER BY task_id, position', ws), (e) => e.task_id);
      const ligados = agrupar(db.all<{ task_id: string; artifact_id: string; role: string }>('SELECT task_id, artifact_id, role FROM task_artifacts WHERE workspace_id = ?', ws), (l) => l.task_id);
      await pausa();
      await addTexto([raiz, 'tarefas'], 'tarefas.json', json(tarefas.map((t) => ({
        numero: t.number, titulo: aberto(t.title), descricao: aberto(t.description), situacao: situacao(t), coluna: aberto(t.coluna), quadro: aberto(t.quadro), responsavel: responsavel(t) || null,
        prazo: t.due_on, criadaEm: t.created_at, atualizadaEm: t.updated_at, concluidaEm: t.completed_at, arquivada: !!Number(t.archived),
        etapas: (etapas.get(t.id) ?? []).map((e) => ({ titulo: aberto(e.title), situacao: e.status, agente: aberto(e.agent_id ? agentes.get(e.agent_id)?.name : null), resultado: aberto(e.output), feitaEm: e.done_at })),
        arquivos: (ligados.get(t.id) ?? []).filter((l) => docIds.has(l.artifact_id)).map((l) => ({ nome: docNome(l.artifact_id), papel: l.role, caminho: rel(l.artifact_id) })),
      }))), undefined, tz);

      // rotinas e as configurações delas
      const rotinas = (d.routines.list(ws) as Array<{ name: string; template: string | null; templateName: string | null; categoryLabel: string; status: string; schedule: string; trigger: unknown; agentName: string | null; version: number; config: unknown; createdAt: string; updatedAt: string; lastRunAt: string | null }>);
      await addTexto([raiz], 'rotinas.json', json(rotinas.map((r) => semSegredos({
        nome: r.name, modelo: r.templateName ?? r.template, categoria: r.categoryLabel, situacao: r.status, quando: r.schedule, gatilho: r.trigger, agente: r.agentName,
        versao: r.version, configuracao: r.config, criadaEm: r.createdAt, atualizadaEm: r.updatedAt, ultimaVezEm: r.lastRunAt,
      }))), undefined, tz);

      // a equipe: setores, agentes, competências treinadas e treinos
      const setores = db.all<{ id: string; key: string; name: string; description: string | null; instructions: string | null; examples: string | null; creates_tasks: string | null }>(
        'SELECT id, key, name, description, instructions, examples, creates_tasks FROM profiles WHERE workspace_id = ? ORDER BY position, rowid', ws);
      const ags = db.all<{ id: string; name: string; role: string; status: string; profile_id: string; bio: string | null; charter: string | null; skills: string | null; tools: string | null;
        personality: string | null; coordinator: number; model: string | null; provider: string | null; created_at: string; archived_at: string | null }>(
        'SELECT id, name, role, status, profile_id, bio, charter, skills, tools, personality, coordinator, model, provider, created_at, archived_at FROM agents WHERE workspace_id = ? ORDER BY coordinator DESC, created_at, rowid', ws);
      const comp = db.all<{ id: string; agent_id: string; name: string; title: string | null; description: string | null; status: string; version: number; uses: number; created_at: string; updated_at: string }>(
        'SELECT id, agent_id, name, title, description, status, version, uses, created_at, updated_at FROM agent_skills WHERE workspace_id = ? ORDER BY created_at', ws);
      const treinos = agrupar(db.all<{ agent_id: string; title: string | null; status: string; request: string | null; summary: string | null; created_at: string; decided_at: string | null }>(
        'SELECT agent_id, title, status, request, summary, created_at, decided_at FROM trainings WHERE workspace_id = ? ORDER BY created_at', ws), (t) => t.agent_id);
      const vozes = new Map(db.all<{ agent_id: string; personality: string }>('SELECT agent_id, personality FROM agent_voices WHERE workspace_id = ? AND user_id = ?', ws, user.id).map((v) => [v.agent_id, v.personality]));
      const setorDe = new Map(setores.map((s) => [s.id, aberto(s.name)]));
      const compDe = agrupar(comp, (c) => c.agent_id);
      for (const c of comp) {
        await pausa();
        const v = db.get<{ files: string | null }>('SELECT files FROM agent_skill_versions WHERE workspace_id = ? AND skill_id = ? ORDER BY version DESC LIMIT 1', ws, c.id);
        const files = lerJson(v?.files, {}) as Record<string, unknown>;
        for (const [p, conteudo] of Object.entries(files ?? {}).slice(0, 50)) {
          if (typeof conteudo !== 'string') continue;
          const partes = p.split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..');
          if (!partes.length) continue;
          await addTexto([raiz, 'equipe', 'competencias', aberto(agentes.get(c.agent_id)?.name) ?? 'Agente', aberto(c.title) || c.name, ...partes.slice(0, -1)], partes[partes.length - 1], conteudo, data(c.updated_at), tz);
        }
      }
      await addTexto([raiz, 'equipe'], 'equipe.json', json({
        setores: setores.map((s) => ({ nome: aberto(s.name), descricao: aberto(s.description), instrucoes: aberto(s.instructions), exemplos: lerJson(aberto(s.examples), aberto(s.examples)), criaTarefas: s.creates_tasks })),
        agentes: ags.map((a) => ({
          nome: aberto(a.name), cargo: aberto(a.role), setor: setorDe.get(a.profile_id) ?? null, situacao: a.status, coordena: !!Number(a.coordinator), historia: aberto(a.bio), instrucoes: aberto(a.charter),
          habilidades: lerJson(aberto(a.skills), []), ferramentas: semSegredos(lerJson(a.tools, [])), personalidade: aberto(vozes.get(a.id)) ?? aberto(a.personality),
          modelo: a.model, provedor: a.provider, criadoEm: a.created_at, arquivadoEm: a.archived_at,
          competencias: (compDe.get(a.id) ?? []).map((c) => ({ nome: aberto(c.title) || c.name, descricao: aberto(c.description), situacao: c.status, versao: c.version, usos: c.uses, criadaEm: c.created_at, atualizadaEm: c.updated_at })),
          treinos: (treinos.get(a.id) ?? []).map((t) => ({ titulo: aberto(t.title), situacao: t.status, pedido: aberto(t.request), resumo: aberto(t.summary), criadoEm: t.created_at, decididoEm: t.decided_at })),
        })),
      }), undefined, tz);
      let esqueleto: string | null = null;
      try { esqueleto = json(exportBlueprint(db, d.routines, ws)); } catch { /* sem esqueleto válido: equipe.json já tem tudo */ }
      if (esqueleto) await addTexto([raiz, 'equipe'], 'esqueleto-da-equipe.json', esqueleto, undefined, tz);

      // regras aprovadas (as do jeito de trabalhar e as das contas conectadas)
      const regras = db.all<{ text: string; created_at: string; decided_at: string | null }>("SELECT text, created_at, decided_at FROM rules WHERE workspace_id = ? AND status = 'active' ORDER BY created_at", ws);
      const regrasContas = db.all<{ tipo: string; oque: string; conexoes: string; so: string | null; alcance: string; expira_em: string | null; created_at: string }>(
        "SELECT tipo, oque, conexoes, so, alcance, expira_em, created_at FROM regras_conexoes WHERE workspace_id = ? AND status = 'ativa' ORDER BY created_at", ws);
      await addTexto([raiz], 'regras.json', json({
        regras: regras.map((r) => ({ texto: aberto(r.text), criadaEm: r.created_at, aprovadaEm: r.decided_at })),
        regrasDasContasConectadas: regrasContas.map((r) => semSegredos({ tipo: r.tipo === 'acao' ? 'ação liberada' : 'depois de ler', oque: aberto(r.oque), contas: lerJson(aberto(r.conexoes), aberto(r.conexoes)), so: aberto(r.so), vale: r.alcance, venceEm: r.expira_em, criadaEm: r.created_at })),
      }), undefined, tz);

      // contas e contatos conectados: só os nomes, nunca o acesso
      const contas = db.all<{ kind: string; state: string; account_label: string | null }>("SELECT kind, state, account_label FROM integrations WHERE workspace_id = ? AND (state != 'off' OR account_label IS NOT NULL) ORDER BY kind", ws);
      const canais = db.all<{ id: string; kind: string; label: string | null }>('SELECT id, kind, label FROM connections WHERE workspace_id = ? ORDER BY created_at', ws);
      const canalDe = new Map(canais.map((c) => [c.id, c.kind]));
      const contatos = db.all<{ connection_id: string; display_name: string | null }>('SELECT connection_id, display_name FROM external_identities WHERE workspace_id = ? ORDER BY created_at', ws);
      const nomeLimpo = (s: string | null | undefined) => { const v = aberto(s); return v && !pareceSegredo(v) ? v : null; };
      await addTexto([raiz], 'contas-conectadas.json', json({
        // o aviso no idioma de quem baixou (o README em inglês fala dele); os nomes dos campos são dados e ficam iguais
        aviso: opts.idioma === 'en'
          ? 'Only the names. Access to each account (passwords, keys, saved access) never leaves Ergon: to use one again, connect the account again.'
          : 'Só os nomes. O acesso a cada conta (senhas, tokens, chaves) não sai do Ergon: para usar de novo, conecte a conta outra vez.',
        contas: contas.map((c) => ({ servico: c.kind, conta: nomeLimpo(c.account_label), situacao: c.state === 'connected' ? 'conectada' : c.state === 'error' ? 'com problema' : c.state === 'pending' ? 'conectando' : 'desligada' })),
        canais: canais.map((c) => ({ tipo: c.kind, nome: nomeLimpo(c.label) })),
        contatos: contatos.map((c) => ({ nome: nomeLimpo(c.display_name), canal: canalDe.get(c.connection_id) ?? null })).filter((c) => c.nome),
      }), undefined, tz);
    }
    resumo.push(`- ${raiz}: ${convs.length} conversa(s)${dona ? `, ${nTarefas} tarefa(s)` : ''}, ${nDocs} documento(s)${dona ? '' : ' (só o que é seu: as suas conversas e os arquivos que você enviou)'}`);
    resumoEn.push(`- ${raiz}: ${plEn(convs.length, 'conversation')}${dona ? `, ${plEn(nTarefas, 'task')}` : ''}, ${plEn(nDocs, 'document')}${dona ? '' : ' (only what is yours: your conversations and the files you sent)'}`);
  }

  // o cadastro dela (sem senha, sem segredo do autenticador): sempre vem, fora dos tetos
  const u = db.get<{ username: string; display_name: string; created_at: string; totp_enabled: number; avatar: string | null }>('SELECT username, display_name, created_at, totp_enabled, avatar FROM users WHERE id = ?', user.id);
  await zip.add({ name: caminhos.fixo('minha-conta.json'), mtime: agora, tz: tzPessoa, data: json({
    usuario: u?.username ?? user.username, nome: aberto(u?.display_name) ?? user.displayName, contaCriadaEm: u?.created_at ?? null, autenticadorLigado: !!Number(u?.totp_enabled ?? 0),
    workspaces: memberships.map((m) => ({ nome: aberto(m.name), papel: donos.has(m.workspace_id) ? 'dona' : 'participa' })),
  }) });
  const foto = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(aberto(u?.avatar) ?? '');
  if (foto) await zip.add({ name: caminhos.fixo(`foto-de-perfil.${foto[1] === 'jpeg' ? 'jpg' : foto[1]}`), data: Buffer.from(foto[2], 'base64'), store: true, mtime: agora, tz: tzPessoa });

  const leiaMe = [
    'Os seus dados do Ergon',
    '======================',
    '',
    `Baixado em: ${relogio(tzPessoa, true).format(agora)}`,
    `Conta: ${user.displayName} (${user.username})`,
    `Versão do Ergon: ${VERSION}`,
    '',
    'ATENÇÃO: ESTE ARQUIVO NÃO É CIFRADO.',
    'Dentro do Ergon, os seus dados ficam cifrados com a sua chave. Aqui eles saem legíveis, para abrir em qualquer',
    'computador, sem o Ergon. Quem tiver este arquivo lê tudo o que está nele: guarde em lugar seguro (um disco ou uma',
    'pasta só sua) e apague quando não precisar mais.',
    '',
    'O que tem aqui (uma pasta por workspace):',
    '- conversas: uma conversa por arquivo de texto, com o agente, a data e as mensagens; os anexos apontam para a pasta documentos.',
    '- tarefas: os cards numa planilha (tarefas.csv, abre no Excel) e em tarefas.json, com título, descrição, situação, responsável, prazo e datas.',
    `- documentos: os arquivos e as entregas como foram enviados ou produzidos, com o nome original. O que estava na lixeira vem na pasta "${PASTA_LIXEIRA}".`,
    '- rotinas.json: as rotinas e as configurações de cada uma.',
    '- equipe: os agentes, os setores, as instruções e as competências treinadas (equipe.json e a pasta competencias), e o esqueleto da equipe',
    '  (esqueleto-da-equipe.json): a forma da equipe no formato que o Ergon lê, para montar a mesma equipe de novo.',
    '- regras.json: as regras que você aprovou.',
    '- contas-conectadas.json: só os nomes das contas e dos contatos conectados.',
    '- minha-conta.json (e a foto de perfil, se houver): o seu cadastro.',
    '',
    'Os arquivos .json são texto: abrem no Bloco de Notas ou em qualquer editor. As datas estão no fuso de cada workspace.',
    '',
    'O que não vem, de propósito: a sua senha, a sua chave pessoal, a frase de recuperação, e as senhas, tokens, chaves e',
    'credenciais das contas conectadas (um trecho de texto com cara de senha ou de chave aparece como [removido]). Também não',
    'vem nada que seja de outra pessoa (as conversas dela e os arquivos que ela enviou).',
    '',
    `Limites deste download: ${mb(maxBytes)} de documentos e ${mb(maxTexto)} de texto.`,
    '',
    'Resumo:',
    ...(resumo.length ? resumo : ['- nenhum workspace com dados para baixar']),
  ];
  if (fechados.length) leiaMe.push('', `Não vieram, porque estavam fechados neste momento: ${fechados.join(', ')}. Quem é dono precisa entrar no Ergon antes.`);
  if (deFora.length) {
    leiaMe.push('', `FICARAM DE FORA ${deFora.length} arquivo(s):`, ...deFora.slice(0, 500).map((f) => `- ${f.arquivo} (${mb(f.tamanho)}): ${f.motivo}`));
    if (deFora.length > 500) leiaMe.push(`- e mais ${deFora.length - 500}`);
    leiaMe.push('Para guardar esses, baixe um a um em Documentos (ou apague alguns arquivos grandes e baixe de novo) antes de excluir a conta.');
  } else leiaMe.push('', 'Nada ficou de fora.');
  leiaMe.push('');
  const en = opts.idioma === 'en';
  const texto = en ? readmeEn({ agora: new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: tzPessoa }).format(agora), user, maxBytes, maxTexto, resumo: resumoEn, fechados, deFora }) : leiaMe;
  // o LEIA-ME vai primeiro (é o que aparece no topo ao abrir o ZIP); quebras de linha do Windows: abre certo no Bloco de Notas
  await zip.add({ name: caminhos.fixo(en ? 'README.txt' : 'LEIA-ME.txt'), data: `﻿${texto.join('\r\n')}`, mtime: agora, tz: tzPessoa }, { primeiro: true });

  return { partes: () => zip.partes(), bytes: zip.tamanho(), nome: `meus-dados-ergon-${diaNoFuso(agora, tzPessoa)}.zip`, arquivos: zip.quantas, deFora };
}

// ---------------------------------------------------------------- o README em inglês (a tela de quem pediu em inglês)
const mbEn = (n: number) => `${(Math.round((n / 1024 / 1024) * 10) / 10).toLocaleString('en-US')} MB`;
/** "1 conversation", "3 conversations" */
const plEn = (n: number, coisa: string) => `${n} ${coisa}${n === 1 ? '' : 's'}`;
/** o motivo de um arquivo de fora, em inglês (os do servidor; outro, como veio) */
function motivoEn(m: string): string {
  if (m === 'arquivos demais para um só download') return 'too many files for a single download';
  if (m === 'não foi possível abrir o arquivo guardado') return 'the stored file could not be opened';
  const limite = /^passaria do limite de (.+) MB de (documentos|texto) deste download$/.exec(m);
  if (limite) return `it would go over the ${limite[1].replace(',', '.')} MB limit for ${limite[2] === 'texto' ? 'text' : 'documents'} in this download`;
  return m;
}
function readmeEn(x: { agora: string; user: { username: string; displayName: string }; maxBytes: number; maxTexto: number; resumo: string[]; fechados: string[]; deFora: DeFora[] }): string[] {
  const linhas = [
    'Your Ergon data',
    '===============',
    '',
    `Downloaded on: ${x.agora}`,
    `Account: ${x.user.displayName} (${x.user.username})`,
    `Ergon version: ${VERSION}`,
    '',
    'WARNING: THIS FILE IS NOT ENCRYPTED.',
    'Inside Ergon, your data is encrypted with your key. Here it comes out readable, so you can open it on any computer',
    'without Ergon. Anyone who has this file can read everything in it: keep it somewhere safe (a drive or a folder',
    'that is only yours) and delete it when you no longer need it.',
    '',
    'What is in here (one folder per workspace; folder and file names stay as they are in Ergon):',
    '- conversas (conversations): one conversation per text file, with the agent, the date and the messages; attachments point to the documentos folder.',
    '- tarefas (tasks): the cards in a spreadsheet (tarefas.csv, opens in Excel) and in tarefas.json, with title, description, status, owner, due date and dates.',
    `- documentos (documents): files and deliverables as they were sent or produced, with their original names. What was in the trash comes in the "${PASTA_LIXEIRA}" folder.`,
    '- rotinas.json (routines): the routines and the settings of each one.',
    '- equipe (team): the agents, sectors, instructions and trained skills (equipe.json and the competencias folder), and the team',
    '  outline (esqueleto-da-equipe.json): the shape of the team in the format Ergon reads, to set up the same team again.',
    '- regras.json (rules): the rules you approved.',
    '- contas-conectadas.json (connected accounts): only the names of the connected accounts and contacts.',
    '- minha-conta.json (my account), and the profile photo if there is one: your account details.',
    '',
    '.json files are plain text: they open in Notepad or any editor. Dates are in each workspace\'s time zone.',
    '',
    'What is left out on purpose: your password, your personal key, the recovery phrase, and the passwords, keys and saved',
    'access of connected accounts (any piece of text that looks like a password or a key shows up as [removido]). Nothing',
    'that belongs to someone else comes either (their conversations and the files they sent).',
    '',
    `Limits of this download: ${mbEn(x.maxBytes)} of documents and ${mbEn(x.maxTexto)} of text.`,
    '',
    'Summary:',
    ...(x.resumo.length ? x.resumo : ['- no workspace with data to download']),
  ];
  if (x.fechados.length) linhas.push('', `Not included, because they were locked at the time: ${x.fechados.join(', ')}. The owner needs to sign in to Ergon first.`);
  if (x.deFora.length) {
    linhas.push('', `${plEn(x.deFora.length, 'FILE').toUpperCase()} LEFT OUT:`, ...x.deFora.slice(0, 500).map((f) => `- ${f.arquivo} (${mbEn(f.tamanho)}): ${motivoEn(f.motivo)}`));
    if (x.deFora.length > 500) linhas.push(`- and ${x.deFora.length - 500} more`);
    linhas.push('To keep those, download them one by one in Documents (or delete some large files and download again) before deleting your account.');
  } else linhas.push('', 'Nothing was left out.');
  linhas.push('');
  return linhas;
}

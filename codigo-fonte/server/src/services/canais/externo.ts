/**
 * A camada comum dos canais externos (WhatsApp, Telegram, Discord e, pelo relé, Teams): quem fala por um canal fala como
 * um membro do workspace, com o papel dele, e com travas a mais, porque um celular roubado não pode vazar a empresa.
 *
 * INTERFACE para quem entrega pedidos de um canal externo (canais/servico.ts já usa; o relé do Teams e os bots oficiais
 * devem usar a mesma):
 *
 *   const r = externos.externalRequest({ channel: 'telegram', workspaceId, memberId, text, conversationId });
 *   if (!r.ok) → NÃO entregue à equipe. Responda r.resposta no canal (pode vir vazia: fique em silêncio).
 *                r.motivo: 'nao_membro' | 'pausado' | 'segredo' | 'somente_leitura' | 'aprovar_no_app'.
 *                Em 'aprovar_no_app', o pedido ficou num cartão no app (r.proposalId); aprovado lá, o Ergon chama
 *                `entregarAprovado` (quem registrou o canal entrega o texto na conversa).
 *   if (r.ok)  → entregue como pedido do membro: r.papel, r.categoria e r.nota (a nota de sistema para o agente).
 *
 *   externos.podeDecidirPeloCanal(workspaceId, memberId, proposalId) → o "1 Aprovar"/botão do canal pode decidir este
 *     cartão? Se não, o canal diz "abra o Ergon para responder".
 *   externos.daConversa(conversationId) → { channel, memberId, papel } quando a conversa é de um canal externo.
 *   externos.decisaoDaAcao(papel, risco) → numa ação numa conta pedida de uma conversa de canal externo:
 *     'recusar' (papel de leitura escrevendo), 'confirmar' (qualquer escrita confirma no app) ou null (ler: segue a regra).
 *   externos.ehCartao(ws, pid) / externos.decidir(ws, userId, pid, decisao) → o cartão 'canal_externo' no app.
 *
 * O que vale, para todo canal externo:
 * - Só membro do workspace (memberships). Saiu do workspace: os números e vínculos dele somem (removerMembro).
 * - O papel é o do membro: dono → 'owner'; 'member' local → o papel dele no workspace do Ergon World (owner, admin, editor
 *   ou viewer), pela conta do World ligada à pessoa local (world_links.account_id; a mesma conta em duas pessoas é
 *   ambíguo: leitura) e pela lista de membros que o app já busca (GET /v1/sync/workspaces/:id/members). O papel fica
 *   guardado (canais_externo_papeis) e é buscado de novo depois de 5 minutos; sem o World, vale o último conhecido por
 *   24 h e depois 'viewer'. Sem nada disso, 'viewer' (o mais restrito). Papel de leitura só consulta.
 * - Membro tirado do workspace (no World, ou a pessoa removida do Ergon): os números e vínculos dele caem na hora, com
 *   registro (canal.externo.revogado).
 * - Pedidos de risco pelo texto (classificar): exportar dados em massa, mandar a terceiros, apagar, mudar configurações,
 *   conexões, permissões ou a lista de números: não vão à equipe direto; ficam num cartão no app, que o dono ou um admin
 *   aprova lá (não um "1" do mesmo celular). Revelar senha, chave ou código: nunca.
 * - Na execução (conexoes/servico.ts): escrita numa conta pedida por canal externo sempre confirma, e "mandar" e
 *   "apagar" só se confirmam no app; papel de leitura não escreve. Cartões de configuração, ferramentas, apagar,
 *   senha e afins só se decidem no app.
 * - Volume: mais de `por10Min` pedidos em 10 minutos ou `porDia` em 24 h pausa o canal daquele membro e avisa o dono no
 *   app (um cartão: aprovar retoma).
 * - Auditoria: cada pedido fica no registro (canal.externo.pedido: membro, canal, categoria, papel, resultado), sem o texto.
 * A classificação pelo texto é uma heurística de palavras: o que segura de verdade é a confirmação no app (execução e
 * cartões). A nota de sistema pede ao agente resumos, nunca despejo de dados brutos.
 */
import type { Db } from '../../db/db.ts';
import { HttpError, clip, fold, id as novoId, now } from '../../lib/util.ts';
import { audit, type Bus } from '../bus.ts';
import { msg, type CodigoServidor } from '../../lib/i18n.ts';
import { readLang } from '../prefs.ts';

export type Papel = 'owner' | 'admin' | 'editor' | 'viewer';
export type Categoria = 'comum' | 'exportar' | 'terceiros' | 'apagar' | 'config' | 'segredo';
export const KIND_EXTERNO = 'canal_externo';
const ARRISCADAS: readonly Categoria[] = ['exportar', 'terceiros', 'apagar', 'config'];
/** Cartões que um "1"/botão do canal pode decidir (o resto, só no app). */
const DECIDE_PELO_CANAL = new Set(['task', 'sector_new', 'batch', 'ledger']);
const NOME_DA_CATEGORIA: Record<Categoria, string> = {
  comum: 'pedido comum', exportar: 'exportar dados em massa', terceiros: 'mandar dados a terceiros', apagar: 'apagar', config: 'mudar configurações, conexões ou permissões', segredo: 'revelar credenciais',
};

/** O nome curto do canal (whatsapp:<ws>:<conta>:<tel> → whatsapp). */
export const tipoDoCanal = (canal: string): string => canal.split(':')[0];
const nomeDoCanal = (canal: string): string => ({ whatsapp: 'WhatsApp', telegram: 'Telegram', discord: 'Discord', teams: 'Teams', feishu: 'Feishu/Lark', dingtalk: 'DingTalk', wecom: 'WeCom', weixin: 'WeChat', whatsapp_cloud: 'WhatsApp' } as Record<string, string>)[tipoDoCanal(canal)] ?? tipoDoCanal(canal);

const DADOS = /\b(clientes?|contatos?|e-?mails?|arquivos?|documentos?|dados|planilhas?|base|listas?|conversas?|mensagens|contratos?|leads?|vendas|pedidos|fornecedores|funcionarios|clients?|customers?|contacts?|files?|documents?|data|records|database|messages|suppliers|employees)\b/;
const TUDO = /\b(tod[oa]s?|tudo|inteir[oa]s?|complet[oa]s?|all|every|entire|whole|full)\b/;
const EXPORTA = /\b(export\w*|dump|backup|download\w*|baix\w*)\b/;
const SEGREDO = /\b(senhas?|password|passwords|tokens?|chaves? (de api|secretas?|privadas?|de acesso)|api ?keys?|credencia\w*|credentials?|secrets?|codigos? de (acesso|verificacao|seguranca)|2fa|otp)\b/;
const MUDAR = /\b(mud\w*|troc\w*|alter\w*|lig[ae]\w*|deslig\w*|ativ[ae]\w*|desativ\w*|configur\w*|tir[ae]\w*|adicion\w*|liber[ae]\w*|bloque\w*|revog\w*|conced\w*|change|enable|disable|grant|revoke|add|turn|set|update|remove)\b/;
const CONFIG = /\b(configurac\w*|ajustes?|conexo\w*|conexao|integrac\w*|permiss\w*|acessos?|papel|papeis|cargos?|admin\w*|whitelist|allowlist|numeros? liberados?|telefones? liberados?|lista de (telefones|numeros)|settings?|connections?|integrations?|permissions?|access|roles?)\b/;
const APAGAR = /\b(apag\w*|delet\w*|exclu\w*|remov\w*|destru\w*|esvazi\w*|erase|wipe|delete|purge)\b/;
const MANDAR = /\b(envi\w*|mand\w*|encaminh\w*|compartilh\w*|repass\w*|forward\w*|send|share)\b/;
const DESTINO = /([\w.+-]+@[\w-]+\.[\w.]+)|(\+?\d[\d\s().-]{7,}\d)/;

/** O que o pedido quer, pelo texto (português e inglês, sem acento). Heurística: a trava de verdade é a confirmação no app. */
export function classificar(texto: string): Categoria {
  const t = fold(String(texto ?? '')).replace(/\s+/g, ' ');
  if (SEGREDO.test(t) && !MUDAR.test(t)) return 'segredo';
  if ((TUDO.test(t) || EXPORTA.test(t)) && DADOS.test(t) && (EXPORTA.test(t) || MANDAR.test(t) || /\b(list\w*|mostr\w*|me (de|da|passa)|show|give|copi\w*)\b/.test(t))) return 'exportar';
  if (MANDAR.test(t) && DESTINO.test(t)) return 'terceiros';
  if (CONFIG.test(t) && (MUDAR.test(t) || APAGAR.test(t))) return 'config';
  if (SEGREDO.test(t)) return 'config'; // trocar a senha, mudar a chave: configuração
  if (APAGAR.test(t)) return 'apagar';
  return 'comum';
}

export interface PedidoExterno { channel: string; workspaceId: string; memberId: string; text: string; conversationId?: string | null }
export type RespostaExterna =
  | { ok: true; papel: Papel; categoria: Categoria; nota: string }
  | { ok: false; motivo: 'nao_membro' | 'pausado' | 'segredo' | 'somente_leitura' | 'aprovar_no_app'; resposta: string; proposalId?: string };

interface Deps { db: Db; bus: Bus; papelWorld?: ((userId: string, ws: string) => string | null) | null }
/** Ajustes (os testes encurtam): o volume que pausa o canal de um membro. */
interface Ajustes { por10Min: number; porDia: number }

const MIGRACAO = `
  CREATE TABLE IF NOT EXISTS canais_externo_pausas (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, canal TEXT NOT NULL, desde TEXT NOT NULL,
    motivo TEXT NOT NULL, avisado INTEGER NOT NULL DEFAULT 0, proposal_id TEXT, PRIMARY KEY (workspace_id, user_id, canal));
  CREATE TABLE IF NOT EXISTS canais_externo_volume (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, canal TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS canais_externo_volume_quem ON canais_externo_volume(workspace_id, user_id, canal, at);
  CREATE TABLE IF NOT EXISTS canais_externo_papeis (workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, papel TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, account_id));
`;
/** O papel do World guardado é buscado de novo depois disto; sem o World, vale até PAPEL_VALE (depois, leitura). */
const PAPEL_FRESCO_MS = 5 * 60_000;
const PAPEL_VALE_MS = 24 * 3_600_000;
export type MembroDoWorld = { accountId: string; role: string };

export class CanaisExternos {
  readonly d: Deps;
  ajustes: Ajustes = { por10Min: 20, porDia: 200 };
  agora: () => number = Date.now;
  /** quem entrega o pedido aprovado no app (canais/servico.ts) */
  entregarAprovado: ((p: PedidoExterno & { proposalId: string; aprovadoPor: string }) => void) | null = null;
  /** quem responde no canal o que foi recusado no app */
  avisarNoCanal: ((p: { channel: string; memberId: string; texto: string }) => void) | null = null;
  /** quem guarda números ou vínculos de um membro (o número da equipe no WhatsApp): esquece quando ele sai do workspace */
  private aoRemover: Array<(ws: string, userId: string) => void> = [];
  /** a lista de membros do workspace no World (world/index.ts liga; null: World fora ou workspace não ligado) */
  buscarMembros: ((ws: string) => Promise<MembroDoWorld[] | null>) | null = null;
  private buscando = new Set<string>();

  constructor(d: Deps) { this.d = d; d.db.raw.exec(MIGRACAO); }

  aoRemoverMembro(fn: (ws: string, userId: string) => void): void { this.aoRemover.push(fn); }

  /** O papel do membro no workspace, ou null quando não é membro. */
  papel(ws: string, userId: string): Papel | null {
    const m = this.d.db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', ws, userId);
    if (!m) return null;
    if (m.role === 'owner') return 'owner';
    const w = this.d.papelWorld?.(userId, ws) ?? this.papelNoWorld(ws, userId);
    if (w === 'removido') return null;
    return w === 'owner' || w === 'admin' || w === 'editor' || w === 'viewer' ? w : 'viewer';
  }

  /** A conta do World da pessoa local; null sem conta ou quando a mesma conta está em mais de uma pessoa (ambíguo). */
  private contaWorld(userId: string): string | null {
    try {
      const r = this.d.db.get<{ account_id: string }>("SELECT account_id FROM world_links WHERE user_id = ? AND status = 'active'", userId);
      if (!r) return null;
      const n = Number(this.d.db.get<{ n: number }>("SELECT COUNT(DISTINCT user_id) AS n FROM world_links WHERE account_id = ? AND status = 'active'", r.account_id)?.n ?? 0);
      return n === 1 ? r.account_id : null;
    } catch { return null; } // sem o World nesta instalação (a tabela nem existe)
  }
  /** O papel guardado do World (owner/admin/editor/viewer, ou 'removido'); vencido ou sem saber: null (vira leitura). */
  private papelNoWorld(ws: string, userId: string): string | null {
    const conta = this.contaWorld(userId);
    if (!conta) return null;
    const r = this.d.db.get<{ papel: string; at: string }>('SELECT papel, at FROM canais_externo_papeis WHERE workspace_id = ? AND account_id = ?', ws, conta);
    const idade = r ? this.agora() - Date.parse(r.at) : Infinity;
    if (idade > PAPEL_FRESCO_MS) this.atualizarPapeis(ws);
    if (!r) return null;
    if (r.papel === 'removido') return 'removido';
    return idade > PAPEL_VALE_MS ? null : r.papel;
  }
  /** Busca a lista de membros no World em segundo plano (uma busca por vez por workspace). Falhou: fica o que se sabia. */
  atualizarPapeis(ws: string): Promise<void> {
    if (!this.buscarMembros || this.buscando.has(ws)) return Promise.resolve();
    this.buscando.add(ws);
    return this.buscarMembros(ws).then((m) => { if (m) this.membrosDoWorld(ws, m); }).catch(() => undefined).finally(() => { this.buscando.delete(ws); });
  }
  /** A lista de membros do World (a tela de membros e a renovação a trazem): guarda os papéis; quem sumiu dela saiu. */
  membrosDoWorld(ws: string, membros: MembroDoWorld[]): void {
    const ok = membros.filter((m) => typeof m?.accountId === 'string' && ['owner', 'admin', 'editor', 'viewer'].includes(String(m.role)));
    if (!ok.length) return; // lista vazia ou estranha: não tira ninguém por isso
    const antes = this.d.db.all<{ account_id: string; papel: string }>('SELECT account_id, papel FROM canais_externo_papeis WHERE workspace_id = ?', ws);
    const agora = new Date(this.agora()).toISOString();
    this.d.db.tx(() => {
      for (const m of ok) this.d.db.run('INSERT INTO canais_externo_papeis (workspace_id, account_id, papel, at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, account_id) DO UPDATE SET papel = excluded.papel, at = excluded.at', ws, m.accountId, m.role, agora);
    });
    for (const a of antes) if (a.papel !== 'removido' && !ok.some((m) => m.accountId === a.account_id)) this.membroSaiu(ws, a.account_id);
  }
  /** Tirado do workspace no World: o papel vira 'removido' e os canais das pessoas locais com essa conta caem na hora. */
  membroSaiu(ws: string, accountId: string): void {
    this.d.db.run("INSERT INTO canais_externo_papeis (workspace_id, account_id, papel, at) VALUES (?, ?, 'removido', ?) ON CONFLICT (workspace_id, account_id) DO UPDATE SET papel = 'removido', at = excluded.at",
      ws, accountId, new Date(this.agora()).toISOString());
    let locais: Array<{ user_id: string }> = [];
    try { locais = this.d.db.all<{ user_id: string }>("SELECT user_id FROM world_links WHERE account_id = ? AND status = 'active'", accountId); } catch { /* sem o World aqui */ }
    for (const l of locais) {
      if (this.d.db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', ws, l.user_id)?.role === 'owner') continue; // o dono local segue dono
      this.revogarMembro(ws, l.user_id, 'tirado do workspace no Ergon World');
    }
  }
  /** Revoga na hora os canais do membro neste workspace, com registro. */
  revogarMembro(ws: string, userId: string, motivo: string): void {
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'canal.externo.revogado', targetType: 'user', targetId: userId, evidence: { membro: userId, motivo }, result: `canais externos de ${this.nomeDe(userId)} revogados: ${motivo}` });
    this.removerMembro(ws, userId);
  }
  /** Os membros do workspace (para a lista do canal), com o papel de cada um. */
  membros(ws: string): Array<{ userId: string; nome: string; papel: Papel }> {
    return this.d.db.all<{ user_id: string; nome: string | null; username: string }>(
      'SELECT m.user_id, u.display_name AS nome, u.username FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at', ws)
      .map((r) => ({ userId: r.user_id, nome: r.nome || r.username, papel: this.papel(ws, r.user_id) ?? 'viewer' }));
  }

  /** A nota de sistema para o agente, num pedido que chegou por um canal externo. */
  nota(papel: Papel, canal: string): string {
    const base = `Pedido por um canal externo (${nomeDoCanal(canal)}): o celular pode não estar nas mãos da pessoa. Responda com resumos; nunca despeje dados brutos em massa (listas inteiras de clientes, e-mails, arquivos); nunca revele senhas, chaves, tokens ou códigos. Mandar dados a terceiros, apagar e mudar configurações, conexões ou permissões só se confirmam no app do Ergon.`;
    return papel === 'viewer' ? `${base} Quem pede tem papel de leitura neste workspace: só consultas; não crie, envie, apague nem mude nada.` : base;
  }

  // ------------------------------------------------------------------------------------------------ o pedido
  externalRequest(p: PedidoExterno): RespostaExterna {
    const canal = String(p.channel);
    const papel = this.papel(p.workspaceId, p.memberId);
    const registrar = (categoria: Categoria, resultado: string) => audit(this.d.db, this.d.bus, {
      workspaceId: p.workspaceId, actorType: 'user', actorId: p.memberId, action: 'canal.externo.pedido', targetType: 'canal', targetId: tipoDoCanal(canal),
      evidence: { canal: tipoDoCanal(canal), categoria, papel: papel ?? 'nenhum', resultado }, result: `pedido pelo ${nomeDoCanal(canal)}: ${NOME_DA_CATEGORIA[categoria]} (${resultado})`,
    });
    if (!papel) {
      // saiu do workspace: o que ligava o canal a ele some agora
      this.revogarMembro(p.workspaceId, p.memberId, 'não é mais membro do workspace');
      registrar('comum', 'não é membro');
      return { ok: false, motivo: 'nao_membro', resposta: '' };
    }
    const categoria = classificar(p.text);
    // a resposta no idioma da pessoa (rc.44); sem escolha, o português de sempre
    const lang = readLang(this.d.db, p.memberId);
    const pausa = this.d.db.get<{ avisado: number }>('SELECT avisado FROM canais_externo_pausas WHERE workspace_id = ? AND user_id = ? AND canal = ?', p.workspaceId, p.memberId, canal);
    if (pausa) {
      registrar(categoria, 'canal pausado');
      if (Number(pausa.avisado)) return { ok: false, motivo: 'pausado', resposta: '' };
      this.d.db.run('UPDATE canais_externo_pausas SET avisado = 1 WHERE workspace_id = ? AND user_id = ? AND canal = ?', p.workspaceId, p.memberId, canal);
      return { ok: false, motivo: 'pausado', resposta: msg(lang, 'canal.pausado') };
    }
    if (this.volumeIncomum(p.workspaceId, p.memberId, canal)) {
      this.pausar(p.workspaceId, p.memberId, canal);
      registrar(categoria, 'pausado por volume incomum');
      return { ok: false, motivo: 'pausado', resposta: msg(lang, 'canal.volume') };
    }
    if (categoria === 'segredo') {
      registrar(categoria, 'recusado');
      return { ok: false, motivo: 'segredo', resposta: msg(lang, 'canal.segredo') };
    }
    if (papel === 'viewer' && categoria !== 'comum' && categoria !== 'exportar') {
      registrar(categoria, 'recusado: papel de leitura');
      return { ok: false, motivo: 'somente_leitura', resposta: msg(lang, 'canal.somenteLeitura') };
    }
    if (ARRISCADAS.includes(categoria)) {
      const proposalId = this.guardarParaOApp(p, papel, categoria);
      registrar(categoria, 'espera aprovação no app');
      const nomeCat = msg(lang, `canal.categoria.${categoria}` as CodigoServidor);
      return { ok: false, motivo: 'aprovar_no_app', proposalId, resposta: msg(lang, 'canal.aprovarNoApp', { categoria: nomeCat }) };
    }
    registrar(categoria, 'entregue');
    return { ok: true, papel, categoria, nota: this.nota(papel, canal) };
  }

  private volumeIncomum(ws: string, userId: string, canal: string): boolean {
    const agora = this.agora();
    const desde = (ms: number) => new Date(agora - ms).toISOString();
    this.d.db.run('DELETE FROM canais_externo_volume WHERE at < ?', desde(25 * 3_600_000));
    this.d.db.run('INSERT INTO canais_externo_volume (workspace_id, user_id, canal, at) VALUES (?, ?, ?, ?)', ws, userId, canal, new Date(agora).toISOString());
    const n = (ms: number) => Number(this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canais_externo_volume WHERE workspace_id = ? AND user_id = ? AND canal = ? AND at >= ?', ws, userId, canal, desde(ms))?.n ?? 0);
    return n(10 * 60_000) > this.ajustes.por10Min || n(24 * 3_600_000) > this.ajustes.porDia;
  }

  private nomeDe(userId: string): string {
    const u = this.d.db.get<{ nome: string | null; username: string }>('SELECT display_name AS nome, username FROM users WHERE id = ?', userId);
    return u ? u.nome || u.username : 'um membro';
  }

  private cartao(ws: string, payload: Record<string, unknown>, resumo: string): string {
    const pid = novoId('apr');
    this.d.db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'proposed', ?)`,
      pid, ws, KIND_EXTERNO, this.d.db.seal(ws, JSON.stringify(payload)), this.d.db.seal(ws, clip(resumo, 1200)), now());
    this.d.bus.publish(ws, 'proposals.changed', { conversationId: null });
    return pid;
  }

  /** Pausa o canal do membro e avisa no app (o cartão: aprovar retoma). */
  pausar(ws: string, userId: string, canal: string, motivo = 'volume incomum de pedidos'): void {
    const pid = this.cartao(ws, { tipo: 'pausa', channel: canal, memberId: userId, motivo },
      `O canal ${nomeDoCanal(canal)} de ${this.nomeDe(userId)} foi pausado: ${motivo}. Se foi ela mesma, aprove para retomar; se não, recuse e revogue o número em Conexões.`);
    this.d.db.run('INSERT INTO canais_externo_pausas (workspace_id, user_id, canal, desde, motivo, avisado, proposal_id) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (workspace_id, user_id, canal) DO NOTHING',
      ws, userId, canal, now(), motivo, pid);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'canal.externo.pausado', targetType: 'canal', targetId: tipoDoCanal(canal), evidence: { canal: tipoDoCanal(canal), membro: userId, motivo }, result: `canal ${nomeDoCanal(canal)} pausado: ${motivo}` });
  }
  pausado(ws: string, userId: string, canal: string): boolean {
    return !!this.d.db.get('SELECT 1 AS x FROM canais_externo_pausas WHERE workspace_id = ? AND user_id = ? AND canal = ?', ws, userId, canal);
  }
  retomar(ws: string, userId: string, canal: string): void {
    this.d.db.run('DELETE FROM canais_externo_pausas WHERE workspace_id = ? AND user_id = ? AND canal = ?', ws, userId, canal);
    this.d.db.run('DELETE FROM canais_externo_volume WHERE workspace_id = ? AND user_id = ? AND canal = ?', ws, userId, canal);
  }

  private guardarParaOApp(p: PedidoExterno, papel: Papel, categoria: Categoria): string {
    return this.cartao(p.workspaceId, { tipo: 'pedido', channel: p.channel, memberId: p.memberId, conversationId: p.conversationId ?? null, texto: clip(p.text, 4000), categoria, papel },
      `Pedido pelo ${nomeDoCanal(p.channel)} de ${this.nomeDe(p.memberId)} (${NOME_DA_CATEGORIA[categoria]}): "${clip(p.text, 600)}". Por segurança, um pedido assim por canal externo só vai à equipe com a sua aprovação aqui.`);
  }

  /** Membro saiu do workspace (ou o número foi revogado por isso): vínculos, pausas e números dele somem. */
  removerMembro(ws: string, userId: string): void {
    this.d.db.run('DELETE FROM canais_externo_pausas WHERE workspace_id = ? AND user_id = ?', ws, userId);
    for (const f of this.aoRemover) { try { f(ws, userId); } catch { /* quem guarda cuida do seu */ } }
  }

  // ------------------------------------------------------------------------------------------------ cartões e execução
  /** A conversa é de um canal externo? (canais_vinculos: Telegram, Discord e o número da equipe no WhatsApp) */
  daConversa(conversationId: string | null | undefined): { channel: string; memberId: string; papel: Papel } | null {
    if (!conversationId) return null;
    const v = this.d.db.get<{ canal: string; user_id: string; workspace_id: string }>('SELECT canal, user_id, workspace_id FROM canais_vinculos WHERE conversation_id = ?', conversationId);
    if (!v) return null;
    return { channel: v.canal, memberId: v.user_id, papel: this.papel(v.workspace_id, v.user_id) ?? 'viewer' };
  }

  /** Ação numa conta pedida de uma conversa de canal externo: leitura segue a regra; escrita confirma; papel de leitura não escreve. */
  decisaoDaAcao(papel: Papel, risco: string): 'recusar' | 'confirmar' | null {
    if (risco === 'ler') return null;
    return papel === 'viewer' ? 'recusar' : 'confirmar';
  }

  /** O "1"/botão do canal pode decidir este cartão? Senhas, configuração, apagar, mandar e o que é deste módulo: só no app. */
  podeDecidirPeloCanal(ws: string, memberId: string, proposalId: string): boolean {
    const papel = this.papel(ws, memberId);
    if (!papel || papel === 'viewer') return false;
    const p = this.d.db.get<{ kind: string; payload: string }>('SELECT kind, payload FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, ws);
    if (!p) return false;
    if (p.kind === 'conexao') {
      try {
        const acao = (JSON.parse(p.payload) as { acaoId?: string }).acaoId;
        const risco = acao ? this.d.db.get<{ risco: string }>('SELECT risco FROM conexao_acoes WHERE id = ? AND workspace_id = ?', acao, ws)?.risco : null;
        return risco === 'organizar';
      } catch { return false; }
    }
    return DECIDE_PELO_CANAL.has(p.kind);
  }

  ehCartao(ws: string, pid: string): boolean { return !!this.d.db.get('SELECT 1 AS x FROM agent_proposals WHERE id = ? AND workspace_id = ? AND kind = ?', pid, ws, KIND_EXTERNO); }

  /** POST /api/proposals/:id de um cartão deste módulo: só o dono ou um admin, no app. */
  decidir(ws: string, userId: string, pid: string, decisao: 'apply' | 'reject'): { status: string; result: string } {
    const row = this.d.db.get<{ payload: string; status: string }>('SELECT payload, status FROM agent_proposals WHERE id = ? AND workspace_id = ? AND kind = ?', pid, ws, KIND_EXTERNO);
    if (!row) throw new HttpError(404, 'not_found', 'cartão não encontrado');
    if (row.status !== 'proposed') throw new HttpError(409, 'decided', 'este cartão já foi decidido');
    const quem = this.papel(ws, userId);
    if (quem !== 'owner' && quem !== 'admin') throw new HttpError(403, 'forbidden', 'Só o dono ou um admin do workspace decide isto.');
    const p = JSON.parse(row.payload) as { tipo: 'pausa' | 'pedido'; channel: string; memberId: string; conversationId?: string | null; texto?: string; categoria?: Categoria };
    let status: 'applied' | 'rejected' = decisao === 'apply' ? 'applied' : 'rejected';
    let result: string;
    if (p.tipo === 'pausa') {
      if (decisao === 'apply') { this.retomar(ws, p.memberId, p.channel); result = 'canal retomado'; } else result = 'o canal segue pausado';
    } else if (decisao === 'apply') {
      if (!this.papel(ws, p.memberId)) { status = 'rejected'; result = 'quem pediu não é mais membro do workspace'; }
      else { this.entregarAprovado?.({ channel: p.channel, workspaceId: ws, memberId: p.memberId, text: String(p.texto ?? ''), conversationId: p.conversationId ?? null, proposalId: pid, aprovadoPor: userId }); result = 'aprovado no app: o pedido foi à equipe'; }
    } else {
      result = 'recusado no app';
      this.avisarNoCanal?.({ channel: p.channel, memberId: p.memberId, texto: msg(readLang(this.d.db, p.memberId), 'canal.naoAprovado') });
    }
    this.d.db.run('UPDATE agent_proposals SET status = ?, result = ?, decided_at = ? WHERE id = ?', status, this.d.db.seal(ws, result), now(), pid);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: `canal.externo.${p.tipo}.${status}`, targetType: 'proposal', targetId: pid, evidence: { canal: tipoDoCanal(p.channel), membro: p.memberId, ...(p.categoria ? { categoria: p.categoria } : {}) }, result });
    this.d.bus.publish(ws, 'proposals.changed', { conversationId: null });
    return { status, result };
  }
}

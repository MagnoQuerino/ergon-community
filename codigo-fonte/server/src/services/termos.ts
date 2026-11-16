/**
 * Termos de uso (16/11, decisão do dono): Executar código e Terminal vêm ligados por padrão, e os termos avisam disso.
 * O que muda para a pessoa só muda depois que ela aceita a versão atual (na criação da conta ou, para quem já usava, no
 * aviso que aparece uma vez depois da atualização). Sem aceite, tudo segue como antes: código bloqueado até a senha.
 */
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting } from './sectors.ts';

/** A versão dos termos (a data em que o texto mudou). Mudar o texto que exige novo aceite = mudar esta versão. */
export const TERMOS_VERSAO = '2026-11-16';
/** As ferramentas que vêm ligadas depois do aceite. */
export const CODIGO_PADRAO = ['calculo', 'terminal'] as const;

export function aceitouTermos(db: Db, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return db.get<{ v: string | null }>('SELECT terms_version AS v FROM users WHERE id = ?', userId)?.v === TERMOS_VERSAO;
}

export function estadoDosTermos(db: Db, userId: string): { versao: string; aceitos: boolean; aceitosEm: string | null } {
  const u = db.get<{ v: string | null; at: string | null }>('SELECT terms_version AS v, terms_at AS at FROM users WHERE id = ?', userId);
  return { versao: TERMOS_VERSAO, aceitos: u?.v === TERMOS_VERSAO, aceitosEm: u?.v === TERMOS_VERSAO ? u.at : null };
}

/** Grava o aceite da versão atual (só ela: aceitar uma versão antiga não vale). */
export function aceitarTermos(db: Db, bus: Bus | null, userId: string, versao: string, workspaceId: string | null): boolean {
  if (versao !== TERMOS_VERSAO) return false;
  db.run('UPDATE users SET terms_version = ?, terms_at = ? WHERE id = ?', TERMOS_VERSAO, now(), userId);
  if (workspaceId) audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: 'termos.aceite', evidence: { versao: TERMOS_VERSAO }, result: `termos de uso aceitos (versão ${TERMOS_VERSAO})` });
  return true;
}

/** Quem é dono do workspace aceitou os termos atuais? (vale para o que é da equipe: o motor, as ferramentas dos agentes) */
export function codigoPorPadrao(db: Db, workspaceId: string): boolean {
  const donos = db.all<{ user_id: string }>("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'", workspaceId);
  return donos.some((d) => aceitouTermos(db, d.user_id));
}

/**
 * O agente ganha Executar código e Terminal uma vez (workspace com os termos aceitos e a pessoa não desligou para a
 * equipe). Uma vez só por agente: se a pessoa tirar de um agente depois, não volta sozinho.
 */
export function sincronizarCodigoDoAgente(db: Db, workspaceId: string, agentId: string): void {
  if (!codigoPorPadrao(db, workspaceId)) return;
  const marca = `codigo.padrao:${agentId}`;
  if (getSetting(db, workspaceId, marca)) return;
  const row = db.get<{ tools: string | null; coordinator: number }>("SELECT tools, coordinator FROM agents WHERE id = ? AND workspace_id = ? AND status = 'active'", agentId, workspaceId);
  if (!row || Number(row.coordinator)) return; // o Coordenador encaminha; o código fica com os especialistas
  let tools: string[] = [];
  try { const x = JSON.parse(row.tools ?? '[]'); if (Array.isArray(x)) tools = x.map(String); } catch { /* ilegível: começa vazia */ }
  const somar = CODIGO_PADRAO.filter((t) => !tools.includes(t) && getSetting(db, workspaceId, `ferramentas.${t}`) !== 'desligado');
  db.tx(() => {
    if (somar.length) db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, ...somar]), agentId);
    db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)", workspaceId, marca, now(), now());
  });
}

/** Todos os agentes ativos do workspace (logo depois do aceite). */
export function sincronizarCodigoDaEquipe(db: Db, workspaceId: string): void {
  for (const a of db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active'", workspaceId)) sincronizarCodigoDoAgente(db, workspaceId, a.id);
}

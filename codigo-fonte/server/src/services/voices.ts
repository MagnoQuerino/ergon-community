/**
 * A voz de cada colega na conversa: a personalidade (catálogo em shared/personalities.ts) e o jeito de colega de
 * trabalho, comum a todos. A escolha é de cada pessoa (agent_voices); sem escolha, vale o padrão do agente
 * (agents.personality, que quem é dono do workspace define) e, sem ele, o de fábrica do personagem.
 */
import type { Db } from '../db/db.ts';
import { HttpError, notFound, now } from '../lib/util.ts';
import { DEFAULT_PERSONALITY, PERSONALITY, VOICE_COMMON, isPersonality, voiceFor, type PersonalityId } from '../../../shared/personalities.ts';
import { audit, type Bus } from './bus.ts';

export function personalityOf(db: Db, workspaceId: string, agentId: string, userId?: string | null): PersonalityId {
  if (userId) {
    const mine = db.get<{ personality: string }>('SELECT personality FROM agent_voices WHERE user_id = ? AND agent_id = ? AND workspace_id = ?', userId, agentId, workspaceId)?.personality;
    if (isPersonality(mine)) return mine;
  }
  const a = db.get<{ personality: string | null; char_key: string | null }>('SELECT personality, char_key FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
  if (isPersonality(a?.personality)) return a.personality;
  return (a?.char_key && DEFAULT_PERSONALITY[a.char_key]) || 'cordial';
}

/** Primeiro nome de quem conversa (o nome de exibição da conta). */
export function firstName(db: Db, userId: string): string {
  const n = db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', userId)?.display_name ?? '';
  return n.trim().split(/\s+/)[0] ?? '';
}

/**
 * Marca da conversa na lista (o agente decide): urgente = algo para sem a pessoa ou tem prazo hoje; alta = precisa
 * dela, sem pressa. Sai sozinha quando ela responde.
 */
const PRIORITY_HOW = 'Se o que você escreveu agora depende da pessoa e é urgente (algo para sem ela ou tem prazo hoje), marque a conversa no fim da resposta: [[prioridade nivel="urgente" motivo="poucas palavras"]]; se só precisa dela, sem pressa: nivel="alta". Não marque cumprimento, entrega comum nem dúvida sua. Resolvido, [[prioridade nivel="normal"]].';

/** O trecho das instruções que dá a voz: guia comum, personalidade e quem é a pessoa. */
export function voiceInstructions(db: Db, workspaceId: string, agentId: string, userId: string): string {
  const name = firstName(db, userId);
  return [VOICE_COMMON, voiceFor(personalityOf(db, workspaceId, agentId, userId)), name ? `Você conversa com ${name}, a pessoa dona deste workspace.` : '', PRIORITY_HOW].filter(Boolean).join('\n');
}

/**
 * Troca a personalidade de um agente para a pessoa (ou o padrão do agente, para quem é dono). Os extremos só com o
 * aviso aceito (`accepted`); sem isso, recusa — a tela mostra o aviso antes.
 */
export function setPersonality(db: Db, bus: Bus, workspaceId: string, userId: string, agentId: string, personality: string,
  opts: { accepted?: boolean; asDefault?: boolean } = {}): PersonalityId {
  if (!isPersonality(personality)) throw new HttpError(400, 'personality', 'personalidade desconhecida');
  const agent = db.get<{ id: string; name: string }>('SELECT id, name FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
  if (!agent) throw notFound('agente');
  if (PERSONALITY[personality].extreme && !opts.accepted) {
    throw new HttpError(409, 'confirm_extreme', `A personalidade ${PERSONALITY[personality].label} precisa do seu aceite antes.`);
  }
  if (opts.asDefault) {
    const owner = db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role === 'owner';
    if (!owner) throw new HttpError(403, 'forbidden', 'só quem é dono do workspace muda o padrão da equipe');
    db.run('UPDATE agents SET personality = ? WHERE id = ?', personality, agentId);
  }
  db.run(`INSERT INTO agent_voices (workspace_id, user_id, agent_id, personality, accepted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, agent_id) DO UPDATE SET personality = excluded.personality, accepted_at = COALESCE(excluded.accepted_at, agent_voices.accepted_at), updated_at = excluded.updated_at`,
    workspaceId, userId, agentId, personality, opts.accepted ? now() : null, now());
  audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: 'agent.personality', targetType: 'agent', targetId: agentId,
    evidence: { personality, extreme: !!PERSONALITY[personality].extreme, asDefault: !!opts.asDefault }, result: `${agent.name}: ${PERSONALITY[personality].label}` });
  bus.publish(workspaceId, 'agents.changed', { id: agentId });
  return personality;
}

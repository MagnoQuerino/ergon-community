/**
 * Tabelas do recurso "Conversar com a equipe pelo Teams" (migração própria, registrada em teams_app_migrations):
 * vínculos, entregas já recebidas (61 dias: mais que os 60 que o relé guarda), saída para o Teams (sobrevive a reinício, 7 dias), cartões enviados e o
 * estado por pessoa (conversa "Teams", chave geral, até onde as respostas já foram).
 */
import type { Db } from '../../db/db.ts';

const MIGRACOES: Array<[string, string]> = [
  ['t0001_teams_app', `
    CREATE TABLE IF NOT EXISTS teams_bindings (
      binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, person_ref TEXT NOT NULL,
      teams_name TEXT, status TEXT NOT NULL DEFAULT 'active', notices INTEGER NOT NULL DEFAULT 1, revoked_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS teams_bindings_user ON teams_bindings(user_id);
    CREATE TABLE IF NOT EXISTS teams_inbound (delivery_id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, message_id TEXT, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams_outbox (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, purpose TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', activity_id TEXT, error TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS teams_outbox_pending ON teams_outbox(status, next_at);
    CREATE TABLE IF NOT EXISTS teams_cards (
      proposal_id TEXT NOT NULL, binding_id TEXT NOT NULL, activity_id TEXT, state TEXT NOT NULL, outbox_id TEXT,
      PRIMARY KEY (proposal_id, binding_id));
    CREATE TABLE IF NOT EXISTS teams_people (
      user_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      reply_binding TEXT, cursor_rowid INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams_noticed (user_id TEXT NOT NULL, item TEXT NOT NULL, at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, item));
  `],
  // revisão da rc.26: o clique decide fora da fila (a intenção fica gravada e volta depois de reiniciar), o pedido que
  // chegou com atraso avisa o agente, a primeira mensagem de cada vínculo avisa no Ergon, e o limite de avisos por hora
  // sobrevive a reinício
  ['t0002_teams_app_revisao', `
    ALTER TABLE teams_inbound ADD COLUMN state TEXT;
    ALTER TABLE teams_inbound ADD COLUMN decision TEXT;
    ALTER TABLE teams_inbound ADD COLUMN binding_id TEXT;
    ALTER TABLE teams_inbound ADD COLUMN request_id TEXT;
    ALTER TABLE teams_inbound ADD COLUMN sent_at TEXT;
    ALTER TABLE teams_inbound ADD COLUMN delayed INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS teams_inbound_state ON teams_inbound(state);
    CREATE INDEX IF NOT EXISTS teams_inbound_request ON teams_inbound(request_id);
    ALTER TABLE teams_bindings ADD COLUMN first_message_at TEXT;
    ALTER TABLE teams_people ADD COLUMN notice_window TEXT;
  `],
  // bots oficiais de Telegram e Discord pelo mesmo serviço: cada vínculo diz a plataforma, e cada pessoa tem UMA conversa
  // por plataforma (a do Teams continua a de antes).
  ['t0003_canais_oficiais', `
    ALTER TABLE teams_bindings ADD COLUMN platform TEXT NOT NULL DEFAULT 'teams';
    CREATE TABLE teams_people_v3 (
      user_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'teams', workspace_id TEXT NOT NULL, conversation_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      reply_binding TEXT, cursor_rowid INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, notice_window TEXT, PRIMARY KEY (user_id, platform));
    INSERT INTO teams_people_v3 (user_id, platform, workspace_id, conversation_id, enabled, reply_binding, cursor_rowid, updated_at, notice_window)
      SELECT user_id, 'teams', workspace_id, conversation_id, enabled, reply_binding, cursor_rowid, updated_at, notice_window FROM teams_people;
    DROP TABLE teams_people;
    ALTER TABLE teams_people_v3 RENAME TO teams_people;
    CREATE INDEX IF NOT EXISTS teams_people_conv ON teams_people(conversation_id);
  `],
  // nuvem do Ergon World: o contêiner atende as contas ligadas no computador enquanto ele está fechado (reserva).
  // standby_of = a instalação dona do vínculo (o computador); teams_synced = mensagens que vieram pela sincronia (o
  // outro aparelho já respondeu por elas no canal: não vão de novo)
  ['t0004_reserva_na_nuvem', `
    ALTER TABLE teams_bindings ADD COLUMN standby_of TEXT;
    CREATE TABLE IF NOT EXISTS teams_synced (message_id TEXT PRIMARY KEY, at TEXT NOT NULL);
  `],
];

export function migrarTeamsApp(db: Db): string[] {
  db.raw.exec('CREATE TABLE IF NOT EXISTS teams_app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const feitas = new Set(db.all<{ name: string }>('SELECT name FROM teams_app_migrations').map((r) => r.name));
  const out: string[] = [];
  for (const [nome, sql] of MIGRACOES) {
    if (feitas.has(nome)) continue;
    db.tx(() => { db.raw.exec(sql); db.run('INSERT INTO teams_app_migrations (name, applied_at) VALUES (?, ?)', nome, new Date().toISOString()); });
    out.push(nome);
  }
  return out;
}

export interface VinculoRow {
  binding_id: string; user_id: string; workspace_id: string; person_ref: string; teams_name: string | null;
  status: 'active' | 'paused' | 'revoking' | 'revoked'; notices: number; revoked_by: string | null; created_at: string; updated_at: string;
  first_message_at: string | null; platform: Plataforma; standby_of: string | null;
}
export type Plataforma = 'teams' | 'telegram' | 'discord';
export interface PessoaRow { platform: Plataforma; user_id: string; workspace_id: string; conversation_id: string | null; enabled: number; reply_binding: string | null; cursor_rowid: number; updated_at: string; notice_window: string | null }
export interface SaidaRow { id: string; binding_id: string; workspace_id: string; kind: 'send' | 'card.update'; payload: string; purpose: string | null; attempts: number; next_at: string; status: string; activity_id: string | null; created_at: string }

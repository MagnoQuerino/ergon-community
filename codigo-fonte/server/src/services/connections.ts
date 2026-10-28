import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { HermesClient } from './hermes.ts';

/** Estados exibidos. "preparado" nunca é "conectado": conectado exige evento real autenticado recebido. */
export type ConnState = 'nao_configurado' | 'configurado' | 'nao_validado' | 'conectado' | 'falha' | 'fixture' | 'local';

export interface ConnStatus {
  id: string; kind: string; mode: string; label: string; state: ConnState; detail: string; lastRealEventAt: string | null; canValidate: boolean;
}

let hermesCache: { at: number; ok: boolean; detail: string } | null = null;

export async function hermesHealth(cfg: Config, client: HermesClient | null): Promise<{ ok: boolean; detail: string }> {
  if (!client) return { ok: false, detail: 'motor de IA não configurado' };
  if (hermesCache && Date.now() - hermesCache.at < 15000) return hermesCache;
  const h = await client.health();
  hermesCache = { at: Date.now(), ...h };
  return h;
}

export async function connectionStatuses(db: Db, cfg: Config, workspaceId: string, hermes: HermesClient | null): Promise<ConnStatus[]> {
  const rows = db.all<{ id: string; kind: string; mode: string; label: string; last_real_event_at: string | null; last_error: string | null; validated_at: string | null }>(
    'SELECT id, kind, mode, label, last_real_event_at, last_error, validated_at FROM connections WHERE workspace_id = ? ORDER BY kind, mode', workspaceId);
  const h = cfg.executor === 'hermes' || cfg.hermesApiKey ? await hermesHealth(cfg, hermes) : null;
  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, mode: r.mode, label: r.label, lastRealEventAt: r.last_real_event_at, canValidate: false };
    const pending = { ...base, canValidate: true };
    if (r.mode === 'fixture') return { ...base, state: 'fixture' as const, detail: 'Simulação local identificada. Não é integração conectada.' };
    if (r.kind === 'chat') return { ...base, state: 'local' as const, detail: 'Chat no navegador local.' };
    if (r.kind === 'hermes') {
      if (cfg.executor !== 'hermes') {
        return { ...base, state: (h?.ok ? 'nao_validado' : 'nao_configurado') as ConnState,
          detail: h?.ok ? 'O motor de IA responde, mas ERGON_EXECUTOR=simulated: respostas são SIMULADAS.' : 'ERGON_EXECUTOR=simulated: respostas dos agentes são SIMULADAS (sem modelo).' };
      }
      if (!h?.ok) return { ...base, state: 'falha' as const, detail: h?.detail ?? 'motor de IA inacessível' };
      return { ...base, state: 'configurado' as const, detail: 'O motor de IA responde. A validação real depende de uma conta de IA conectada (Conexões).' };
    }
    if (r.kind === 'teams') {
      const t = cfg.teams;
      if (!t.enabled) return { ...base, state: 'nao_configurado' as const, detail: 'ERGON_TEAMS_ENABLED=false. Registro do app, consentimento, túnel e instalação são passos humanos.' };
      if (!t.tenantId || t.allowedUsers.length === 0 || !cfg.bridgeToken) return { ...base, state: 'configurado' as const, detail: 'Faltam tenant, usuários autorizados ou token da ponte.' };
      if (r.last_error) return { ...base, state: 'falha' as const, detail: r.last_error };
      if (!r.last_real_event_at) return { ...base, state: 'nao_validado' as const, detail: 'Configurado, nenhum evento recebido pela ponte ainda.' };
      if (!r.validated_at) return { ...pending, state: 'nao_validado' as const, detail: 'Eventos chegam pela ponte. Confirme após um teste real no Teams (o sistema não distingue sozinho um disparo de teste).' };
      return { ...base, state: 'conectado' as const, detail: 'Teste real confirmado pelo proprietário; eventos chegam pela ponte do motor.' };
    }
    if (r.kind === 'whatsapp') {
      const w = cfg.whatsapp;
      if (!w.enabled) return { ...base, state: 'nao_configurado' as const, detail: 'Experimental (Baileys, não oficial). Pareamento por QR é passo humano. Envio desligado por padrão.' };
      if (w.ownerIds.length === 0 || !cfg.bridgeToken) return { ...base, state: 'configurado' as const, detail: 'Faltam identidade do proprietário ou token da ponte.' };
      if (!r.last_real_event_at) return { ...base, state: 'nao_validado' as const, detail: `Configurado; envio ${w.sendEnabled ? 'HABILITADO' : 'desligado'}; nenhum evento recebido pela ponte.` };
      if (!r.validated_at) return { ...pending, state: 'nao_validado' as const, detail: `Eventos chegam pela ponte; envio ${w.sendEnabled ? 'HABILITADO' : 'desligado'}. Confirme após teste real com o número pareado.` };
      return { ...base, state: 'conectado' as const, detail: `Teste real confirmado pelo proprietário; envio ${w.sendEnabled ? 'HABILITADO' : 'desligado'}.` };
    }
    return { ...base, state: 'nao_configurado' as const, detail: '' };
  });
}

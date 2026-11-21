/**
 * O aparelho-nuvem do workspace, FIXADO na primeira vez que este computador o vê (confiança no primeiro uso).
 *
 * Por quê: o World diz qual é o aparelho-nuvem do workspace e a chave pública dele (GET /v1/cloud, cloudDevice;
 * devices-needing-key, kind 'cloud'). Um World mal-intencionado (ou invadido) poderia trocar essa chave em silêncio e
 * receber, cifradas para ele, as credenciais das conexões do dono e a chave do workspace. Com a fixação, um aparelho-nuvem
 * diferente do primeiro não recebe nada até a pessoa dona confirmar, neste computador e com a senha, que a nuvem foi
 * mesmo recriada (o caso legítimo: a nuvem refeita depois de 30 dias parada, disco novo). A troca fica na auditoria.
 */
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';
import { audit, type Bus } from '../services/bus.ts';

interface Fixa { workspace_id: string; aparelho: string; chave: string; fixada_em: string; nova_aparelho: string | null; nova_chave: string | null; nova_em: string | null }
export interface AparelhoNuvem { deviceId: string; syncPublicKey: string }

const ler = (db: Db, ws: string) => db.get<Fixa>('SELECT * FROM world_nuvem_fixa WHERE workspace_id = ?', ws);

/**
 * Este aparelho-nuvem pode receber? 'ok': é o fixado (ou o primeiro visto, que passa a ser o fixado); 'trocada': outro,
 * guardado como "novo, esperando a confirmação" (a primeira vez que aparece vai para a auditoria).
 * `anterior`: um aparelho-nuvem que já recebeu antes desta versão (instalações anteriores à fixação): se for outro, também
 * pede a confirmação.
 */
export function conferirNuvem(db: Db, bus: Bus, ws: string, d: AparelhoNuvem, anterior?: string | null): 'ok' | 'trocada' {
  const f = ler(db, ws);
  if (!f) {
    if (anterior && anterior !== d.deviceId) {
      db.run('INSERT INTO world_nuvem_fixa (workspace_id, aparelho, chave, fixada_em, nova_aparelho, nova_chave, nova_em) VALUES (?, ?, ?, ?, ?, ?, ?)', ws, anterior, '', now(), d.deviceId, d.syncPublicKey, now());
      avisar(db, bus, ws, anterior, d.deviceId);
      return 'trocada';
    }
    db.run('INSERT INTO world_nuvem_fixa (workspace_id, aparelho, chave, fixada_em) VALUES (?, ?, ?, ?)', ws, d.deviceId, d.syncPublicKey, now());
    return 'ok';
  }
  if (f.aparelho === d.deviceId && f.chave === d.syncPublicKey) return 'ok';
  // a mesma troca já registrada: só espera
  if (f.nova_aparelho === d.deviceId && f.nova_chave === d.syncPublicKey) return 'trocada';
  db.run('UPDATE world_nuvem_fixa SET nova_aparelho = ?, nova_chave = ?, nova_em = ? WHERE workspace_id = ?', d.deviceId, d.syncPublicKey, now(), ws);
  avisar(db, bus, ws, f.aparelho, d.deviceId);
  return 'trocada';
}

function avisar(db: Db, bus: Bus, ws: string, antes: string, depois: string) {
  audit(db, bus, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'world.cloud_device_changed', targetType: 'device', targetId: depois,
    evidence: { antes, depois }, result: 'o aparelho-nuvem do workspace mudou: nada vai para ele (conexões, chave) até a pessoa dona confirmar com a senha' });
  bus.publish(ws, 'integrations.changed', {}); bus.publish(ws, 'world.cloud', {});
}

/** A troca esperando a confirmação (para a tela), ou null. */
export function trocaPendente(db: Db, ws: string): { desde: string; aparelho: string } | null {
  const f = ler(db, ws);
  return f?.nova_aparelho && f.nova_em ? { desde: f.nova_em, aparelho: f.nova_aparelho } : null;
}

/**
 * A pessoa dona confirmou (com a senha) que a nuvem nova é dela: `atual` é o aparelho-nuvem que o World diz AGORA, e só
 * ele vira o fixado se for o mesmo que estava esperando (um terceiro aparelho aparecendo no meio pede outra confirmação).
 */
export function confirmarNuvem(db: Db, bus: Bus, ws: string, userId: string, atual: AparelhoNuvem | null): boolean {
  const f = ler(db, ws);
  if (!f?.nova_aparelho || !atual || atual.deviceId !== f.nova_aparelho || atual.syncPublicKey !== f.nova_chave) return false;
  db.run('UPDATE world_nuvem_fixa SET aparelho = ?, chave = ?, fixada_em = ?, nova_aparelho = NULL, nova_chave = NULL, nova_em = NULL WHERE workspace_id = ?', atual.deviceId, atual.syncPublicKey, now(), ws);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'world.cloud_device_confirmed', targetType: 'device', targetId: atual.deviceId,
    evidence: { antes: f.aparelho, depois: atual.deviceId }, result: 'a pessoa dona confirmou a nuvem nova do workspace: conexões e chave voltam a ir' });
  bus.publish(ws, 'integrations.changed', {}); bus.publish(ws, 'world.cloud', {});
  return true;
}

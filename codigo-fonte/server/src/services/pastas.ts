/**
 * Pastas do computador (rc.42, "mãos na massa"): a pessoa escolhe uma pasta local (um repositório, a pasta de trabalho) em
 * Conexões › Pastas do computador — pelo seletor do Ergon Desktop ou digitando o caminho — e ela é concedida ao motor
 * dela: o gerente de motores monta só essa pasta em /pastas/<nome> no contêiner (lib/pastas-seguras.ts confere aqui e de
 * novo lá). O agente clona, edita, testa e faz commit nela pelo Terminal.
 *
 * Conceder ou revogar muda a especificação do motor: o contêiner é refeito com o MESMO cofre (as sessões e a memória
 * ficam) no primeiro momento em que não há trabalho em andamento (motors.ts, a renovação de sempre). Revogar desmonta.
 * A mesma política vale lá dentro: o que apaga de vez pede a pessoa toda vez (o plugin do motor pergunta), e as contas
 * continuam pelas Conexões, com "Liberar tudo" e as protegidas. Na nuvem não há computador: não existe.
 */
import os from 'node:os';
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import { conferirPasta, MAX_PASTAS, nomeNoMotor, PastaRecusada, RAIZ_NO_MOTOR, type ModoPasta, type PastaMontada } from '../lib/pastas-seguras.ts';
import { audit, type Bus } from './bus.ts';

export interface PastaDaTela { id: string; caminho: string; nome: string; noMotor: string; modo: ModoPasta; desde: string; montada: boolean }
interface Linha { id: string; user_id: string; workspace_id: string; caminho: string; nome: string; modo: ModoPasta; criada_em: string }

interface DepsPastas {
  db: Db; bus: Bus;
  /** na nuvem do Ergon World não há computador da pessoa */
  nuvem: boolean;
  /** o motor da pessoa precisa ser refeito com as pastas novas (no primeiro momento seguro) */
  aplicar(userId: string): void;
  /** as pastas montadas agora no motor dela (o que o gerente disse por último); null = não sabe */
  montadas?(userId: string): PastaMontada[] | null;
}

/** As casas conhecidas desta máquina: nunca concedidas inteiras (nem o que fica acima delas). */
export const casasDaMaquina = (): string[] => [...new Set([...(process.env.ERGON_HOST_HOME ?? '').split(';'), process.env.HOME ?? '', os.homedir()].map((x) => x.trim()).filter(Boolean))];

export class Pastas {
  private readonly d: DepsPastas;
  constructor(d: DepsPastas) { this.d = d; }

  private ativas(userId: string): Linha[] {
    return this.d.db.all<Linha>('SELECT id, user_id, workspace_id, caminho, nome, modo, criada_em FROM pastas_computador WHERE user_id = ? AND revogada_em IS NULL ORDER BY criada_em', userId);
  }

  /** O que vai ao gerente de motores para o motor desta pessoa; null = nunca concedeu nada (o pedido segue como antes). */
  paraOMotor(userId: string): PastaMontada[] | null {
    if (!this.d.db.get('SELECT 1 AS x FROM pastas_computador WHERE user_id = ? LIMIT 1', userId)) return null;
    return this.ativas(userId).map((l) => ({ origem: l.caminho, nome: l.nome, modo: l.modo }));
  }

  listar(userId: string, ws: string): PastaDaTela[] {
    const m = this.d.montadas?.(userId) ?? null;
    return this.ativas(userId).filter((l) => l.workspace_id === ws).map((l) => ({ id: l.id, caminho: l.caminho, nome: l.nome, noMotor: `${RAIZ_NO_MOTOR}/${l.nome}`, modo: l.modo, desde: l.criada_em,
      montada: !!m?.some((x) => x.nome === l.nome && x.origem === l.caminho && x.modo === l.modo) }));
  }

  conceder(userId: string, ws: string, caminho: string, modo: ModoPasta): PastaDaTela {
    if (this.d.nuvem) throw new HttpError(409, 'nuvem', 'na nuvem não há pastas do computador');
    let p: string;
    try { p = conferirPasta(caminho, casasDaMaquina()); } catch (e) { if (e instanceof PastaRecusada) throw new HttpError(400, 'pasta', e.message); throw e; }
    const ativas = this.ativas(userId);
    if (ativas.length >= MAX_PASTAS) throw new HttpError(409, 'limite', `no máximo ${MAX_PASTAS} pastas: tire uma antes`);
    const igual = ativas.find((l) => l.caminho === p);
    if (igual) {
      if (igual.modo !== modo) this.d.db.run('UPDATE pastas_computador SET modo = ? WHERE id = ?', modo, igual.id);
    } else {
      const nome = nomeNoMotor(p, new Set(ativas.map((l) => l.nome)));
      this.d.db.run('INSERT INTO pastas_computador (id, user_id, workspace_id, caminho, nome, modo, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?)', id('pst'), userId, ws, this.d.db.seal(ws, p), nome, modo, now());
    }
    const l = this.ativas(userId).find((x) => x.caminho === p)!;
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'pastas.concedida', targetType: 'pasta', targetId: l.id, evidence: { nome: l.nome, modo },
      result: `pasta do computador concedida à equipe (${modo === 'ro' ? 'só leitura' : 'leitura e escrita'}) em ${RAIZ_NO_MOTOR}/${l.nome}` });
    this.d.aplicar(userId);
    this.d.bus.publish(ws, 'pastas.changed', {});
    return this.listar(userId, ws).find((x) => x.id === l.id)!;
  }

  revogar(userId: string, ws: string, pastaId: string): void {
    const l = this.ativas(userId).find((x) => x.id === pastaId && x.workspace_id === ws);
    if (!l) throw notFound('pasta');
    this.d.db.run('UPDATE pastas_computador SET revogada_em = ? WHERE id = ?', now(), l.id);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'pastas.revogada', targetType: 'pasta', targetId: l.id, evidence: { nome: l.nome }, result: `pasta do computador revogada: ${RAIZ_NO_MOTOR}/${l.nome} sai do motor` });
    this.d.aplicar(userId);
    this.d.bus.publish(ws, 'pastas.changed', {});
  }

}

/** Para as instruções do agente: as pastas que ele enxerga no Terminal (sem o caminho do computador). */
export function promptPastas(db: Db, ws: string): string {
  const l = db.all<{ nome: string; modo: ModoPasta }>(`SELECT p.nome, p.modo FROM pastas_computador p JOIN memberships m ON m.user_id = p.user_id AND m.workspace_id = p.workspace_id
    WHERE p.workspace_id = ? AND p.revogada_em IS NULL ORDER BY p.criada_em`, ws);
  if (!l.length) return '';
  return `Pastas do computador da pessoa, no Terminal: ${l.map((x) => `${RAIZ_NO_MOTOR}/${x.nome} (${x.modo === 'ro' ? 'só leitura' : 'leitura e escrita'})`).join(', ')}. Trabalhe só nelas (num repositório: ramo novo, testes, commit; para enviar ao GitHub/GitLab, use codigo.preparar e o endereço do Ergon como remoto). Apagar de vez pede a pessoa.`;
}

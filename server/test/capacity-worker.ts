// Worker de teste: abre conexão própria ao mesmo arquivo SQLite e tenta criar um agente
// no mesmo instante que os demais (barreira por Atomics), simulando processos concorrentes.
import { parentPort, workerData } from 'node:worker_threads';
import { Db } from '../src/db/db.ts';
import { Bus } from '../src/services/bus.ts';
import { createAgent } from '../src/services/capacity.ts';

const { dbPath, dbKey, workspaceId, userId, n, barrier } = workerData as { dbPath: string; dbKey: string | null; workspaceId: string; userId: string; n: number; barrier: SharedArrayBuffer };
const db = new Db(dbPath, dbKey ? { key: Buffer.from(dbKey, 'hex') } : {});
const flag = new Int32Array(barrier);
Atomics.add(flag, 1, 1);
Atomics.wait(flag, 0, 0); // espera o sinal de largada
try {
  createAgent(db, new Bus(), workspaceId, userId, { name: `Concorrente ${n}`, role: 'Teste de corrida', profileKey: 'central' });
  parentPort!.postMessage({ ok: true });
} catch (err) {
  parentPort!.postMessage({ ok: false, code: (err as { code?: string }).code ?? String(err) });
} finally {
  db.close();
}

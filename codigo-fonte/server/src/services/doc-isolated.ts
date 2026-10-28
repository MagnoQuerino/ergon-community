/**
 * Leitura de documentos isolada. Cada documento é lido num worker próprio, com
 * tempo e memória limitados: um arquivo pesado ou malformado não trava a conversa, a agenda nem a API, e quando
 * passa do limite o worker é encerrado e a leitura volta como erro dito ("não foi lido"), nunca como texto vazio.
 * No máximo duas leituras ao mesmo tempo (as outras esperam a vez). Não é um contêiner por agente: é só o leitor.
 *
 * Memória: a proteção principal são os tetos de entrada (50 MB por envio, 120 MB descompactados por documento),
 * que nenhuma alocação isolada passa perto dos 384 MB do worker. O teto do worker pega o crescimento gradual (o
 * worker morre sozinho e o servidor segue). Teto pequeno demais é pior que nenhum: uma alocação única maior que ele
 * aborta o processo inteiro (comportamento do V8, medido) — por isso o padrão é folgado.
 */
import { Worker } from 'node:worker_threads';
import type { DocText } from './doc-text.ts';

export interface IsolateOpts { timeoutMs?: number; memMb?: number; /** só para testes: outro programa de worker */ workerUrl?: URL }
const DEFAULT = { timeoutMs: 30_000, memMb: 384 };
const MAX_PARALLEL = 2;

let active = 0; const waiting: Array<() => void> = [];
const acquire = () => new Promise<void>((r) => { if (active < MAX_PARALLEL) { active++; r(); } else waiting.push(() => { active++; r(); }); });
const release = () => { active--; waiting.shift()?.(); };

const failed = (name: string, detail: string): DocText => ({ name, kind: 'outro', status: 'erro', text: '', detail });

/** Texto de um documento, lido num worker com limites. Nunca lança: qualquer falha volta como `status: 'erro'`. */
export async function readDocument(name: string, mime: string, data: Buffer, opts: IsolateOpts = {}): Promise<DocText> {
  const o = { ...DEFAULT, ...opts };
  await acquire();
  try {
    return await new Promise<DocText>((resolve) => {
      let done = false;
      const finish = (d: DocText) => { if (done) return; done = true; clearTimeout(timer); void w.terminate(); resolve(d); };
      const w = new Worker(o.workerUrl ?? new URL('./doc-worker.ts', import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: o.memMb, maxYoungGenerationSizeMb: Math.max(16, Math.round(o.memMb / 8)), stackSizeMb: 8 },
      });
      const timer = setTimeout(() => finish(failed(name, `a leitura passou de ${Math.max(1, Math.round(o.timeoutMs / 1000))} s e foi interrompida (arquivo grande demais ou malformado); nada foi lido dele`)), o.timeoutMs);
      w.once('message', (d: DocText) => finish(d));
      w.once('error', (e: Error & { code?: string }) => finish(failed(name, e.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? 'o arquivo pediu memória demais para ler e a leitura foi interrompida; nada foi lido dele'
        : `a leitura falhou (${e.message.slice(0, 120)}); nada foi lido dele`)));
      w.once('exit', (code) => finish(failed(name, `a leitura parou sem resposta (código ${code}); nada foi lido dele`)));
      // cópia (não transfere: um Buffer pequeno divide memória com outros)
      w.postMessage({ name, mime, data: new Uint8Array(data) });
    });
  } finally { release(); }
}

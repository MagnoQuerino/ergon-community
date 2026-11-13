/**
 * Provedor de quadro de fixture, em formato inspirado no Planner (buckets, percentComplete, etag), lido de
 * fixtures/mirror/<variante>.json. Só os testes usam: a instalação não importa quadros fictícios.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../src/lib/util.ts';
import { ProviderError, type BoardSnapshot, type TaskProvider } from '../src/services/mirror.ts';

const FIXTURE_NAME = /^[a-z0-9-]{1,40}$/;

/** Fixture em formato inspirado no Planner (buckets, percentComplete, etag). NÃO é Planner conectado. */
export class FixtureTaskProvider implements TaskProvider {
  readonly name = 'fixture-planner-like';
  readonly isFixture = true;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly data: any;

  constructor(fixturesDir: string, variant: string) {
    if (!FIXTURE_NAME.test(variant)) throw new HttpError(400, 'fixture', 'fixture inválida');
    const file = path.join(fixturesDir, 'mirror', `${variant}.json`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'fixture', 'fixture inexistente');
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  private check(): void {
    if (this.data.error === 'forbidden') throw new ProviderError('forbidden', 'permissão revogada no aplicativo externo (simulado)');
    if (this.data.error === 'unavailable') throw new ProviderError('unavailable', 'serviço externo indisponível (simulado)');
  }

  async listBoards() {
    this.check();
    return (this.data.plans as any[]).map((p) => ({ externalId: p.id, name: p.title, version: p['@odata.etag'], taskCount: p.tasks.length }));
  }

  async getBoard(externalId: string): Promise<BoardSnapshot> {
    this.check();
    const p = (this.data.plans as any[]).find((x) => x.id === externalId);
    if (!p) throw new ProviderError('not_found', 'quadro não encontrado (ou sem acesso)');
    const columns = (p.buckets as any[]).map((b, i) => ({ externalId: b.id, name: b.name, order: i }));
    const tasks = (p.tasks as any[]).map((t) => {
      const { id: tid, bucketId, title, description, percentComplete, '@odata.etag': etag, ...extra } = t;
      return { externalId: tid, columnExternalId: bucketId, title, description: description ?? '', completed: percentComplete === 100, version: etag, extra };
    });
    return { board: { externalId: p.id, name: p.title, version: p['@odata.etag'] }, columns, tasks, complete: p.pageComplete !== false };
  }
}

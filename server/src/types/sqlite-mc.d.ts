// Tipos do SQLite3 Multiple Ciphers (o pacote traz index.d.ts na raiz, fora do "main", e o TypeScript não o
// encontra pelo nome do módulo). Só o que o Ergon usa — a classe Db é o único ponto de contato com o banco.
declare module 'better-sqlite3-multiple-ciphers' {
  namespace Database {
    interface Statement {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    }
    interface Database {
      prepare(sql: string): Statement;
      exec(sql: string): this;
      pragma(source: string, options?: { simple?: boolean }): unknown;
      /** função SQL definida em JavaScript (ex.: ws_open) */
      function(name: string, options: { deterministic?: boolean }, cb: (...params: unknown[]) => unknown): this;
      close(): this;
    }
  }
  const Database: { new (filename: string, options?: Record<string, unknown>): Database.Database };
  export = Database;
}

// O pacote ws (WebSocket) não traz tipos: só o que o Ergon usa (services/navegador.ts e os testes dele).
declare module 'ws' {
  import type { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer;
  export interface ClientOptions { headers?: Record<string, string>; perMessageDeflate?: boolean; maxPayload?: number; handshakeTimeout?: number; origin?: string }
  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    constructor(address: string, options?: ClientOptions);
    readonly readyState: 0 | 1 | 2 | 3;
    readonly bufferedAmount: number;
    send(data: string | Buffer, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'open', cb: () => void): this;
    on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'close', cb: (code: number, reason: Buffer) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: 'unexpected-response', cb: (req: unknown, res: IncomingMessage) => void): this;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer?: boolean; maxPayload?: number; perMessageDeflate?: boolean; port?: number; host?: string });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
    close(cb?: () => void): void;
    on(event: 'connection', cb: (ws: WebSocket, req: IncomingMessage) => void): this;
    address(): { port: number } | string | null;
  }
  export { WebSocket };
  export default WebSocket;
}

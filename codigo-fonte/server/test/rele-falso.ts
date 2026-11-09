/**
 * Serviço do Teams (relé) falso, em processo, para os testes do lado do Ergon: registro da instalação, WebSocket
 * (servidor mínimo sobre node:http, só quadros de texto), autenticação pela assinatura Ed25519, fila com entregas
 * seladas para a instalação (feito aqui de novo, à parte do código do Ergon), ack/held/reentrega, vínculos por código e
 * o que o Ergon manda ao Teams (mensagens, cartões, atualizações, digitando). Nenhuma credencial real; nada sai do computador.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';

const GUID_WS = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rid = (p: string) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;

interface Entrega { id: string; seq: number; type: 'activity' | 'card.action' | 'link.revoked'; bindingId: string; personRef: string; quadro: Record<string, unknown>; state: 'pending' | 'held' | 'inflight'; r4: boolean }
export interface Vinculo { bindingId: string; installationId: string; personRef: string; status: 'active' | 'paused'; notices: boolean; teamsName: string; label: string; linkedAt: string; claimId?: string }
/** A conta do Teams que pediu o código (contrato 12.1): o relé conhece o locatário e o objeto da conta. */
export interface ContaTeams { tenantId: string; aadObjectId: string }
/** O mesmo cálculo do relé, feito aqui à parte do código do Ergon. */
export const hashComoRele = (c: ContaTeams) => crypto.createHash('sha256').update(`ergon-teams/account/v1|${c.tenantId.toLowerCase()}|${c.aadObjectId.toLowerCase()}`).digest('base64url');
export interface Enviado { id: string; bindingId: string; purpose: string; text?: string; card?: any; summary?: string; activityId: string }

/** Sela como o relé (contrato, 2.6), com código independente do Ergon. */
export function selarComoRele(boxPublicKey: string, valor: unknown, aad: string): Record<string, unknown> {
  const pub = crypto.createPublicKey({ key: Buffer.from(boxPublicKey, 'base64'), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const epkDer = eph.publicKey.export({ format: 'der', type: 'spki' });
  const z = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const salt = Buffer.concat([epkDer.subarray(-32), pub.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  const key = Buffer.from(crypto.hkdfSync('sha256', z, salt, Buffer.from('ergon-teams-relay/seal/v1'), 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(valor)), c.final()]);
  return { v: 1, epk: epkDer.toString('base64'), iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

class Conexao {
  sock: net.Socket; buf = Buffer.alloc(0); parte: Buffer[] = []; installationId: string | null = null; nonce = crypto.randomBytes(32).toString('base64url'); fechada = false;
  constructor(sock: net.Socket) { this.sock = sock; }
  enviar(obj: unknown): void {
    if (this.fechada) return;
    const p = Buffer.from(JSON.stringify(obj));
    const h = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
    this.sock.write(Buffer.concat([h, p]));
  }
  fechar(code: number): void {
    if (this.fechada) return;
    this.fechada = true;
    try { this.sock.write(Buffer.from([0x88, 2, code >> 8, code & 255])); this.sock.end(); } catch { /* já caiu */ }
    setTimeout(() => this.sock.destroy(), 200).unref();
  }
}

export class ReleFalso {
  server!: http.Server; base = '';
  instalacoes = new Map<string, { sign: string; box: string }>();
  registros = 0;
  conexao: Conexao | null = null;
  conexoes = 0;
  vinculos = new Map<string, Vinculo>();
  codigos = new Map<string, { teamsName: string; conta?: ContaTeams }>();
  claims = new Map<string, { code: string; personRef: string; installationId: string; teamsName: string }>();
  /** link.confirm já feitos (claimId → vínculo): o mesmo claimId devolve o mesmo vínculo (contrato 12.10) */
  confirmados = new Map<string, string>();
  /** testes: os próximos N link.claim recebem not_ready (a instalação acabou de se registrar, contrato 12.2) */
  naoPronto = 0;
  /** testes: o próximo link.confirm é feito, mas o ack se perde e a conexão cai */
  perderAckDoConfirm = false;
  /** testes: quadros destes tipos não recebem resposta */
  semResposta = new Set<string>();
  /** testes: todo registro é recusado (assinatura errada de verdade) */
  recusarRegistro = false;
  tentativasDeRegistro = 0;
  fila: Entrega[] = [];
  seq = 0;
  enviados: Enviado[] = [];
  atualizados: Array<{ id: string; bindingId: string; activityId: string; card: any }> = [];
  digitando: Array<{ bindingId: string; on: boolean }> = [];
  automaticas: Array<{ bindingId: string; texto: string }> = [];
  acks: Array<{ id: string; status: string; ok: boolean; error?: { code: string } }> = [];
  quadros: any[] = [];
  abertas = new Map<string, boolean>();
  /** testes: não apaga a entrega no ack (para simular o relé reiniciando antes de gravar o ack) */
  reterAcks = false;
  /** testes: o próximo envio do Ergon recebe este erro */
  proximoErroDeEnvio: string | null = null;

  static async iniciar(): Promise<ReleFalso> {
    const r = new ReleFalso();
    r.server = http.createServer((req, res) => void r.http(req, res));
    r.server.on('upgrade', (req, sock) => r.upgrade(req, sock as net.Socket));
    await new Promise<void>((ok) => r.server.listen(0, '127.0.0.1', () => ok()));
    r.base = `http://127.0.0.1:${(r.server.address() as net.AddressInfo).port}`;
    return r;
  }
  async parar(): Promise<void> {
    this.conexao?.fechar(1001);
    await new Promise<void>((ok) => { this.server.close(() => ok()); this.server.closeAllConnections?.(); });
  }

  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const json = (st: number, v: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.method === 'GET' && req.url === '/v1/info') return json(200, { protocol: [1], teamsAppId: '11111111-2222-3333-4444-555555555555' });
    if (req.method === 'POST' && req.url === '/v1/installations') {
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const msg = `ergon-teams-relay|register|v1|${b.signPublicKey}|${b.boxPublicKey}|${b.ts}`;
      let ok = false;
      try { ok = crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.from(b.signPublicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(b.proof, 'base64')); } catch { ok = false; }
      this.tentativasDeRegistro++;
      // fora da hora: o relé diz a dele (contrato 12.8)
      if (this.recusarRegistro || !ok || Math.abs(Date.parse(b.ts) - Date.now()) > 5 * 60_000) return json(401, { error: 'bad_proof', serverTime: new Date().toISOString() });
      const id = `ins_${crypto.randomBytes(16).toString('hex').slice(0, 26)}`;
      this.instalacoes.set(id, { sign: b.signPublicKey, box: b.boxPublicKey });
      this.registros++;
      return json(201, { installationId: id, registeredAt: new Date().toISOString() });
    }
    json(404, { error: 'not_found' });
  }

  private upgrade(req: http.IncomingMessage, sock: net.Socket): void {
    const key = req.headers['sec-websocket-key'];
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim());
    if (req.url !== '/v1/ergon' || typeof key !== 'string' || !protos.includes('ergon-teams.v1')) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + GUID_WS).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ergon-teams.v1\r\n\r\n`);
    const c = new Conexao(sock);
    this.conexoes++;
    sock.on('data', (d: Buffer) => this.dados(c, d));
    sock.on('close', () => { c.fechada = true; if (this.conexao === c) { this.conexao = null; for (const e of this.fila) if (e.state === 'inflight') e.state = 'pending'; } });
    sock.on('error', () => undefined);
    c.enviar({ type: 'hello', v: 1, nonce: c.nonce, serverTime: new Date().toISOString(), maxFrameBytes: 131072 });
  }

  private dados(c: Conexao, d: Buffer): void {
    c.buf = Buffer.concat([c.buf, d]);
    for (;;) {
      if (c.buf.length < 2) return;
      const fin = (c.buf[0] & 0x80) !== 0; const op = c.buf[0] & 0x0f; const mascara = (c.buf[1] & 0x80) !== 0;
      let len = c.buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
      const m = mascara ? c.buf.subarray(off, off + 4) : null; if (mascara) off += 4;
      if (c.buf.length < off + len) return;
      const p = Buffer.from(c.buf.subarray(off, off + len)); c.buf = c.buf.subarray(off + len);
      if (m) for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
      if (op === 0x8) { c.fechar(p.length >= 2 ? p.readUInt16BE(0) : 1000); continue; }
      if (op === 0x9) { continue; }
      if (op === 0x1 || op === 0x0) {
        c.parte.push(p);
        if (!fin) continue;
        const txt = Buffer.concat(c.parte).toString('utf8'); c.parte = [];
        let f: any; try { f = JSON.parse(txt); } catch { c.fechar(4400); return; }
        this.quadro(c, f);
      }
    }
  }

  private quadro(c: Conexao, f: any): void {
    this.quadros.push(f);
    if (!c.installationId) {
      if (f.type !== 'auth') { c.fechar(4400); return; }
      const inst = this.instalacoes.get(f.installationId);
      if (!inst) { c.fechar(4404); return; }
      const msg = `ergon-teams-relay|auth|v1|${f.installationId}|${c.nonce}|${f.ts}`;
      const ok = crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.from(inst.sign, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(f.sig), 'base64'));
      if (!ok || !(Math.abs(Date.parse(String(f.ts)) - Date.now()) <= 5 * 60_000)) { c.fechar(4401); return; }
      if (this.conexao && this.conexao !== c) this.conexao.fechar(4409);
      c.installationId = f.installationId; this.conexao = c;
      for (const p of f.persons ?? []) this.abertas.set(p.personRef, !!p.open);
      const meus = [...this.vinculos.values()].filter((v) => v.installationId === c.installationId);
      c.enviar({ type: 'ready', sessionId: rid('ses'), queued: this.fila.length, bindings: meus.map((v) => ({ bindingId: v.bindingId, personRef: v.personRef, status: v.status, notices: v.notices, teamsName: v.teamsName, linkedAt: v.linkedAt, ...(v.claimId ? { claimId: v.claimId } : {}) })) });
      this.entregar(true);
      return;
    }
    const ack = (extra: Record<string, unknown>) => c.enviar({ type: 'ack', id: f.id, ok: true, ...extra });
    const erro = (code: string) => c.enviar({ type: 'ack', id: f.id, ok: false, error: { code, message: code } });
    if (this.semResposta.has(f.type)) return;
    switch (f.type) {
      case 'pong': return;
      case 'ack': {
        this.acks.push({ id: f.id, status: f.status, ok: f.ok, error: f.error });
        const e = this.fila.find((x) => x.id === f.id);
        if (!e) return;
        if (f.status === 'person_locked') { e.state = 'held'; if (!e.r4) { e.r4 = true; this.automaticas.push({ bindingId: e.bindingId, texto: 'Recebi. A equipe faz assim que o seu Ergon estiver aberto.' }); } return; }
        if (this.reterAcks) { e.state = 'pending'; return; }
        this.fila = this.fila.filter((x) => x !== e);
        if (f.status === 'rejected' && f.error?.code === 'unknown_person') this.vinculos.delete(e.bindingId);
        this.entregar(false);
        return;
      }
      case 'link.claim': {
        if (this.naoPronto > 0) { this.naoPronto--; return c.enviar({ type: 'ack', id: f.id, ok: false, error: { code: 'not_ready', message: 'not_ready' }, retryAfterMs: 50 }); }
        const v = this.codigos.get(f.code);
        if (!v) return erro('code_invalid');
        const id = rid('clm');
        this.claims.set(id, { code: f.code, personRef: f.personRef, installationId: c.installationId, teamsName: v.teamsName });
        return ack({ claimId: id, teamsName: v.teamsName, expiresAt: new Date(Date.now() + 120_000).toISOString(),
          ...(v.conta ? { tenantId: v.conta.tenantId.toLowerCase(), accountHash: hashComoRele(v.conta) } : {}) });
      }
      case 'link.confirm': {
        const ja = this.confirmados.get(f.claimId);
        const jv = ja ? this.vinculos.get(ja) : undefined;
        if (jv) return ack({ bindingId: jv.bindingId, teamsName: jv.teamsName, linkedAt: jv.linkedAt });
        const cl = this.claims.get(f.claimId);
        if (!cl) return erro('claim_expired');
        this.claims.delete(f.claimId); this.codigos.delete(cl.code);
        const v: Vinculo = { bindingId: rid('bnd'), installationId: cl.installationId, personRef: cl.personRef, status: 'active', notices: f.notices !== false, teamsName: cl.teamsName, label: f.label, linkedAt: new Date().toISOString(), claimId: f.claimId };
        this.vinculos.set(v.bindingId, v);
        this.confirmados.set(f.claimId, v.bindingId);
        this.automaticas.push({ bindingId: v.bindingId, texto: `Pronto: esta conta está ligada ao Ergon de **${f.label}**.` });
        if (this.perderAckDoConfirm) { this.perderAckDoConfirm = false; setTimeout(() => c.fechar(1001), 20).unref(); return; }
        return ack({ bindingId: v.bindingId, teamsName: v.teamsName, linkedAt: v.linkedAt });
      }
      case 'link.cancel': this.claims.delete(f.claimId); return ack({});
      case 'link.revoke': {
        if (!this.vinculos.delete(f.bindingId)) return erro('not_found');
        this.fila = this.fila.filter((x) => x.bindingId !== f.bindingId);
        this.automaticas.push({ bindingId: f.bindingId, texto: 'Esta conta do Teams foi desligada do Ergon, pela tela do Ergon.' });
        return ack({});
      }
      case 'link.update': {
        const v = this.vinculos.get(f.bindingId);
        if (!v) return erro('not_found');
        if (typeof f.paused === 'boolean') v.status = f.paused ? 'paused' : 'active';
        if (typeof f.notices === 'boolean') v.notices = f.notices;
        return ack({ status: v.status, notices: v.notices });
      }
      case 'send': {
        const ja = this.enviados.find((x) => x.id === f.id);
        if (ja) return ack({ activityId: ja.activityId });
        const v = this.vinculos.get(f.bindingId);
        if (!v) return erro('not_linked');
        if (v.status === 'paused') return erro('paused');
        if (this.proximoErroDeEnvio) { const e = this.proximoErroDeEnvio; this.proximoErroDeEnvio = null; return c.enviar({ type: 'ack', id: f.id, ok: false, error: { code: e }, retryAfterMs: 30 }); }
        const e: Enviado = { id: f.id, bindingId: f.bindingId, purpose: f.purpose, text: f.text, card: f.card, summary: f.summary, activityId: `act-${this.enviados.length + 1}` };
        this.enviados.push(e);
        return ack({ activityId: e.activityId });
      }
      case 'card.update': this.atualizados.push({ id: f.id, bindingId: f.bindingId, activityId: f.activityId, card: f.card }); return ack({ activityId: f.activityId });
      case 'typing': this.digitando.push({ bindingId: f.bindingId, on: !!f.on }); return;
      case 'person.state': this.abertas.set(f.personRef, !!f.open); if (f.open) { for (const e of this.fila) if (e.personRef === f.personRef && e.state === 'held') e.state = 'pending'; this.entregar(false); } return;
      default: c.enviar({ type: 'error', code: 'unknown_type', ref: f.id ?? null });
    }
  }

  /** Entrega o que está pendente (em ordem), até 20 sem ack; `inicio`: logo depois do ready (com queue.begin/end). */
  private entregar(inicio: boolean): void {
    const c = this.conexao;
    if (!c || !c.installationId) return;
    // entrega também à pessoa fechada: o Ergon responde person_locked e a entrega espera (held) até person.state
    const prontas = this.fila.filter((e) => e.state === 'pending');
    if (inicio && this.fila.length) c.enviar({ type: 'queue.begin', count: this.fila.length });
    let voo = this.fila.filter((e) => e.state === 'inflight').length;
    for (const e of prontas) {
      if (voo >= 20) break;
      e.state = 'inflight'; voo++;
      c.enviar({ ...e.quadro, fromQueue: inicio });
    }
    if (inicio && this.fila.length) c.enviar({ type: 'queue.end' });
  }

  private novaEntrega(type: Entrega['type'], v: Vinculo, conteudo: unknown | null, extra: Record<string, unknown> = {}): Entrega {
    const id = rid('dlv');
    const inst = this.instalacoes.get(v.installationId)!;
    const q: Record<string, unknown> = { type, id, seq: ++this.seq, bindingId: v.bindingId, personRef: v.personRef, receivedAt: new Date().toISOString(), fromQueue: false, ...extra };
    if (conteudo !== null) q.sealed = selarComoRele(inst.box, conteudo, `${id}|${v.installationId}|${type}`);
    const e: Entrega = { id, seq: this.seq, type, bindingId: v.bindingId, personRef: v.personRef, quadro: q, state: 'pending', r4: false };
    this.fila.push(e);
    // Ergon fora, ou a parte da pessoa fechada: a resposta automática na hora (R4)
    if (type === 'activity' && (!this.conexao || this.abertas.get(v.personRef) === false)) { e.r4 = true; this.automaticas.push({ bindingId: v.bindingId, texto: 'Recebi. A equipe faz assim que o seu Ergon estiver aberto.' }); }
    this.entregar(false);
    return e;
  }

  // ------------------------------------------------------------------------------------------------ o que a pessoa faz no Teams
  /** O bot mostra um código para esta conta do Teams (formato ABCD-EFGH). */
  codigoPara(teamsName: string, conta?: ContaTeams): string {
    let c = ''; for (let i = 0; i < 8; i++) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
    this.codigos.set(c, { teamsName, conta });
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  }
  diz(bindingId: string, text: string, timestamp = new Date().toISOString()): string {
    const v = this.vinculos.get(bindingId);
    if (!v) throw new Error('sem vínculo');
    return this.novaEntrega('activity', v, { text, teamsMessageId: rid('msg'), timestamp, locale: 'pt-BR', fromName: v.teamsName }).id;
  }
  clica(bindingId: string, data: Record<string, unknown>, cardActivityId = 'act-x', via: 'execute' | 'submit' = 'execute'): string {
    const v = this.vinculos.get(bindingId);
    if (!v) throw new Error('sem vínculo');
    return this.novaEntrega('card.action', v, { verb: 'ergon.decidir', data, cardActivityId, via }).id;
  }
  /** "Desfazer" no Teams, ou o app desinstalado: o vínculo some e o Ergon fica sabendo. */
  desfazer(bindingId: string, by: 'teams' | 'uninstall' = 'teams'): void {
    const v = this.vinculos.get(bindingId);
    if (!v) throw new Error('sem vínculo');
    this.vinculos.delete(bindingId);
    this.fila = this.fila.filter((x) => x.bindingId !== bindingId);
    this.novaEntrega('link.revoked', v, null, { by });
  }
  /** Entrega de alguém que não está ligado a este Ergon (personRef e vínculo desconhecidos). */
  estranho(installationId: string, text: string): string {
    const v: Vinculo = { bindingId: 'bnd_desconhecido01', installationId, personRef: 'ref-de-ninguem-000000', status: 'active', notices: true, teamsName: 'Fulano', label: 'x', linkedAt: new Date().toISOString() };
    return this.novaEntrega('activity', v, { text, teamsMessageId: rid('msg'), timestamp: new Date().toISOString(), locale: 'pt-BR', fromName: 'Fulano' }).id;
  }
  derrubar(code = 1001): void { this.conexao?.fechar(code); }
  conectado(): boolean { return !!this.conexao?.installationId && !this.conexao.fechada; }
  vinculoUnico(): Vinculo { const v = [...this.vinculos.values()]; if (v.length !== 1) throw new Error(`vínculos: ${v.length}`); return v[0]; }
}

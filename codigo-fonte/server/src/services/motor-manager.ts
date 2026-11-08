/**
 * Gerente de motores: o único contêiner com acesso ao Docker. Cria, liga, desliga, renova e remove o contêiner do
 * motor de IA de cada pessoa — sempre a mesma imagem e a mesma configuração do motor do Ergon (cofre gocryptfs, nenhum
 * privilégio além do de montar o cofre, que o próprio cofre solta depois de montar), cada um com o cofre e os tokens
 * dele, derivados do token da instalação (que nenhum motor recebe).
 *
 * Só o Ergon fala com ele (rede interna própria + token da instalação). O pedido só escolhe a pessoa: imagem,
 * comando, pastas, variáveis e limites vêm daqui. A primeira conta pode herdar o cofre do motor de antes (o mesmo
 * volume), uma vez e só se nenhum outro contêiner o usa.
 *
 * Renovação: cada contêiner leva rótulos com a marca da especificação (HMAC, porque a especificação leva os tokens
 * derivados), a imagem configurada e a marca da instalação. Um motor com imagem ou especificação desatualizada é
 * recriado com o MESMO volume (o do rótulo, nunca recalculado) quando está parado ou quando o Ergon diz que está
 * livre; a imagem de antes fica guardada até o Ergon confirmar a troca (ou voltar para ela). A limpeza só apaga
 * imagens dos repositórios do Ergon que nada usa: nunca a atual, nunca com força, nunca com prune e nunca um volume.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

export interface DockerResponse { status: number; json: any }
export type DockerCall = (method: string, path: string, body?: unknown) => Promise<DockerResponse>;

export interface ManagerConfig {
  master: string;
  image: string;
  network: string;
  legacyVolume: string;
  volumePrefix: string;
  bridgeUrl: string;
  memBytes: number;
  nanoCpus: number;
  /** Possíveis IDs do contêiner do próprio gerente (ver selfContainerIds): por ele se acha a imagem do núcleo. */
  selfIds?: string[];
}

const UID = /^usr_[a-f0-9]{32}$/;
/** Sobe quando o jeito de calcular a marca da especificação muda (recria todos os motores, de propósito). */
export const SPEC_SCHEMA = '1';
export const LABEL = {
  uid: 'ergon.motor',
  volume: 'ergon.motor.volume',
  spec: 'ergon.motor.spec',
  image: 'ergon.motor.image',
  install: 'ergon.instalacao',
  prev: 'ergon.motor.prev-image',
  hold: 'ergon.motor.hold',
} as const;

export const motorName = (uid: string) => `ergon-motor-${uid.slice(4)}`;
const secret = (master: string, purpose: string, uid: string) => crypto.createHmac('sha256', master).update(`ergon/motor-${purpose}/${uid}`).digest('hex');
/** Marca desta instalação nos contêineres (não revela o token). Num Docker compartilhado, o que não tem a marca não é nosso. */
export const installTag = (master: string) => crypto.createHmac('sha256', master).update('instalacao').digest('hex');

/** JSON canônico (chaves em ordem): a marca não depende da ordem em que o código monta a especificação. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
/**
 * Marca da especificação: HMAC do JSON canônico sem os rótulos e sem a imagem. A imagem é conferida à parte, pelo ID
 * (a mesma imagem pode ter outro nome, e a volta para a imagem anterior não pode parecer "especificação mudou").
 */
export function specHash(c: ManagerConfig, spec: Record<string, unknown>): string {
  const { Labels: _labels, Image: _image, ...rest } = spec;
  return crypto.createHmac('sha256', c.master).update(`ergon/motor-spec/${SPEC_SCHEMA}\n${canon(rest)}`).digest('hex');
}

/** O contêiner do motor de uma pessoa: o mesmo do docker-compose.yml (serviço do motor), com o cofre e os tokens dela. */
export function motorSpec(c: ManagerConfig, uid: string, volume: string, opts: { image?: string; labels?: Record<string, string> } = {}): Record<string, unknown> {
  const image = opts.image ?? c.image;
  const spec: Record<string, unknown> = {
    Image: image,
    Cmd: ['gateway', 'run'],
    Env: [
      'API_SERVER_ENABLED=true', 'API_SERVER_HOST=0.0.0.0', 'API_SERVER_PORT=8642', `API_SERVER_KEY=${secret(c.master, 'api', uid)}`,
      // painel interno do motor: só dentro do contêiner; o Ergon chega pela ponte de controle
      'HERMES_DASHBOARD=1', 'HERMES_DASHBOARD_HOST=127.0.0.1', 'HERMES_DASHBOARD_PORT=9119', `HERMES_DASHBOARD_SESSION_TOKEN=${secret(c.master, 'dashboard', uid)}`,
      'ERGON_CONTROL_PORT=8643', `ERGON_BRIDGE_URL=${c.bridgeUrl}`, `ERGON_BRIDGE_TOKEN=${secret(c.master, 'bridge', uid)}`,
      'ERGON_VAULT=1', // espera a chave do Ergon (porta 8644, só rede interna)
    ],
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: volume, Target: '/vault' }], // só o lado cifrado vai para o disco
      // a vista decifrada fica só na memória; o cofre do motor entrega a pasta ao usuário dele (uid/gid aqui o Podman recusa)
      Tmpfs: { '/opt/data': 'mode=0700' },
      Devices: [{ PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' }],
      CapAdd: ['SYS_ADMIN'], CapDrop: ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP'],
      SecurityOpt: ['apparmor:unconfined', 'no-new-privileges:true'],
      Memory: c.memBytes, NanoCpus: c.nanoCpus,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } }, // só o que o Docker e o Podman aceitam
      NetworkMode: c.network,
      // sem portas publicadas, sem pastas do computador, sem o socket do Docker
    },
  };
  spec.Labels = {
    [LABEL.uid]: uid, [LABEL.volume]: volume, [LABEL.spec]: specHash(c, spec), [LABEL.image]: image, [LABEL.install]: installTag(c.master),
    ...(opts.labels ?? {}),
  };
  return spec;
}

/**
 * Pedido de download da imagem. Com digest ('repo@sha256:…'), a referência inteira vai em fromImage, sem tag (a API
 * aceita ali "nome com tag ou digest"). Sem digest, a tag é só o ':' depois da última '/' (antes dela é a porta do registro).
 */
export function pullQuery(ref: string): string {
  if (ref.includes('@')) return `fromImage=${encodeURIComponent(ref)}`;
  const at = ref.lastIndexOf(':');
  const [from, tag] = at > ref.lastIndexOf('/') ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest'];
  return `fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`;
}

/** Repositório de uma referência ('ghcr.io/x/y:tag', 'y@sha256:…'), sem os prefixos que o Docker e o Podman põem sozinhos. */
export function repoOf(ref: string): string {
  let r = ref.trim().toLowerCase();
  const at = r.indexOf('@'); if (at >= 0) r = r.slice(0, at);
  const colon = r.lastIndexOf(':'); if (colon > r.lastIndexOf('/')) r = r.slice(0, colon);
  return r.replace(/^(?:docker\.io\/library\/|index\.docker\.io\/library\/|docker\.io\/|index\.docker\.io\/|localhost\/)/, '');
}
/** Só repositórios com nome do Ergon ('…/ergon', '…/ergon-community-hermes', 'ergon-hermes') entram na limpeza. */
const ergonRepo = (repo: string) => /^ergon[\w.-]*$/.test(repo.split('/').pop() ?? '');

/** O Docker devolve 'sha256:<hex>'; o Podman, conforme a versão, devolve com ou sem o prefixo. Compara só o hex. */
const hex = (id: unknown): string => typeof id === 'string' ? id.trim().toLowerCase().replace(/^sha256:/, '') : '';
const sameId = (a: unknown, b: unknown) => !!hex(a) && hex(a) === hex(b);
const fullId = (id: unknown): string | null => hex(id) ? `sha256:${hex(id)}` : null;
const isId = (ref: string) => /^(?:sha256:)?[a-f0-9]{64}$/i.test(ref);
const DIGEST = /@sha256:[a-f0-9]{64}$/i;
/** Nomes que uma imagem tem (tags e digests), sem os '<none>' das imagens sem nome. */
const refsOf = (img: { RepoTags?: string[] | null; RepoDigests?: string[] | null } | undefined) =>
  [...(img?.RepoTags ?? []), ...(img?.RepoDigests ?? [])].filter((r) => typeof r === 'string' && r && !r.includes('<none>'));
const enc = (f: Record<string, string[]>) => encodeURIComponent(JSON.stringify(f));

/**
 * Possíveis IDs do contêiner onde o gerente roda: os que aparecem nos caminhos de /proc/self/mountinfo e
 * /proc/self/cgroup (Docker: /var/lib/docker/containers/<id>/…; Podman: overlay-containers/<id>/…, libpod-<id>) e o
 * nome da máquina (por padrão, o começo do ID). Cada um só vale depois de conferido pelo inspect.
 */
export function selfContainerIds(read: (path: string) => string = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }, host: string = os.hostname()): string[] {
  const ids = new Set<string>();
  for (const f of ['/proc/self/mountinfo', '/proc/self/cgroup']) for (const m of read(f).matchAll(/(?:containers\/|docker[-/]|libpod-)([a-f0-9]{64})/g)) ids.add(m[1]);
  if (/^[a-f0-9]{12,64}$/.test(host)) ids.add(host);
  return [...ids];
}

class ManagerError extends Error { readonly status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export interface EnsureOptions { adoptLegacy?: boolean; idle?: boolean; start?: boolean }
/**
 * Por que um motor desatualizado não foi renovado agora (stale sem recreated): 'ocupado' = ligado e o Ergon não disse que
 * está livre (renova quando ficar); 'sem-imagem' = a imagem nova não está neste computador e não baixou (segue o de antes,
 * ligado); 'nao-parou' = o motor não parou a tempo, ou voltou a ligar no meio (segue o de antes).
 */
export type MotivoAdiado = 'ocupado' | 'sem-imagem' | 'nao-parou';
export interface EnsureResult {
  adopted: boolean; created: boolean; recreated: boolean; stale: boolean;
  /** só com stale e sem recreated: por que não renovou agora */
  motivo: MotivoAdiado | null;
  /** ID da imagem do contêiner agora; imageRef = referência com que foi criado; prevImage = imagem de antes da troca. */
  image: string | null; imageRef: string | null; prevImage: string | null;
  /** troca ainda sem confirm nem rollback (o que este gerente sabe desde que ligou) */
  pendente: boolean;
  /** travado na versão anterior: a imagem configurada foi recusada numa volta atrás (rótulo hold no contêiner) */
  held: boolean;
  state: string;
}
/** estimar: só a conta do que a limpeza liberaria (rota própria, /v1/maintenance/estimate), sem apagar nada */
export interface CleanRequest { users?: string[]; pendentes?: string[]; volumesOrfaos?: string[]; manterNucleoAnterior?: boolean; estimar?: boolean }
export interface CleanResult {
  removidas: { id: string; bytes: number }[];
  /**
   * bytes liberados de fato no disco: a diferença do LayersSize do /system/df, que o Docker e o Podman 5.x devolvem (o
   * Podman 5.6.2 sondado devolve o total de verdade). Quando o LayersSize vem 0 ou falta, a soma do que era só de cada
   * imagem; null = não deu para medir
   */
  liberado: number | null;
  /** na estimativa: quanto a limpeza liberaria agora (null = não deu para medir) */
  liberavel?: number | null;
  avisos: { volume: string; motivo: 'conta-removida' | 'sem-conta'; texto: string }[];
  repositorios: string[];
}

type Labels = Record<string, string>;
interface Summary { Id?: string; Image?: string; ImageID?: string; Labels?: Labels | null; State?: string; Mounts?: { Name?: string; Destination?: string }[] }
interface ImageSummary { Id?: string; RepoTags?: string[] | null; RepoDigests?: string[] | null; Created?: number; Size?: number }

export function createManager(c: ManagerConfig, docker: DockerCall) {
  const inst = installTag(c.master);
  const ok = (r: DockerResponse, what: string) => { if (r.status >= 300 && r.status !== 304) throw new ManagerError(502, `${what}: Docker respondeu ${r.status} ${JSON.stringify(r.json?.message ?? '')}`); };
  const inspect = async (name: string): Promise<any | null> => {
    const r = await docker('GET', `/containers/${name}/json`);
    if (r.status === 404) return null;
    ok(r, 'conferir o motor');
    return r.json;
  };
  const labelsOf = (x: any): Labels => (x?.Config?.Labels ?? x?.Labels ?? {}) as Labels;

  /**
   * Uma operação por pessoa de cada vez (renovar, ligar, desligar, confirmar, voltar, remover). Com uma limpeza em
   * andamento, a operação nova espera ela terminar: uma troca não começa no meio da listagem da limpeza (no instante sem
   * contêiner, a imagem anterior da pessoa não estaria protegida por contêiner nenhum).
   */
  const locks = new Map<string, Promise<unknown>>();
  let limpezaAtual: Promise<unknown> | null = null;
  function lock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const barreira = limpezaAtual;
    const run = Promise.all([(locks.get(uid) ?? Promise.resolve()).catch(() => null), barreira?.catch(() => null)]).then(fn);
    const tail = run.catch(() => null);
    locks.set(uid, tail);
    void tail.then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
    return run;
  }
  /** Trocas ainda sem confirm nem rollback (uid → imagem anterior). Só na memória: o Ergon também manda as que ele sabe. */
  const pendentes = new Map<string, string>();
  /** Recriados na partida do gerente, sem o Ergon saber: o próximo ensure avisa (recreated) para ele reentregar a chave e confirmar. */
  const naPartida = new Set<string>();

  // ---- imagens
  const idCache = new Map<string, { id: string; at: number }>();
  async function lookupImage(ref: string): Promise<string | null> {
    const r = await docker('GET', `/images/${ref}/json`);
    if (r.status === 404) return null;
    ok(r, 'conferir a imagem do motor');
    return hex(r.json?.Id) || null;
  }
  async function pull(ref: string) {
    if (isId(ref)) throw new ManagerError(409, 'a imagem pedida não está mais neste computador');
    idCache.delete(ref);
    ok(await docker('POST', `/images/create?${pullQuery(ref)}`), 'baixar a imagem do motor');
  }
  /** ID da imagem de uma referência, com cache (por digest não muda; por tag, confere de novo depois de 1 min). Sem ela no disco, baixa. */
  async function imageId(ref: string, download = true): Promise<string | null> {
    const hit = idCache.get(ref);
    if (hit && (DIGEST.test(ref) || isId(ref) || Date.now() - hit.at < 60_000)) return hit.id;
    let id = await lookupImage(ref);
    if (!id && download) {
      await pull(ref);
      id = await lookupImage(ref);
      if (!id) throw new ManagerError(502, 'a imagem do motor não chegou a este computador');
    }
    if (id) idCache.set(ref, { id, at: Date.now() });
    return id;
  }

  // ---- contêineres
  /** O contêiner é o motor desta pessoa e desta instalação? (sem a marca da instalação, vale porque o Ergon pediu pelo uid) */
  function mine(cur: any, uid: string) {
    const L = labelsOf(cur);
    if (L[LABEL.uid] !== uid) throw new ManagerError(409, 'esse contêiner não é o motor desta pessoa');
    if (L[LABEL.install] && L[LABEL.install] !== inst) throw new ManagerError(409, 'esse motor é de outra instalação do Ergon neste computador: nada foi mexido');
  }
  /**
   * Volume montado em /vault (o que o contêiner usa de fato): Mounts[].Name (Docker e Podman); depois HostConfig.Mounts
   * (o Podman 5.x devolve null ali) e HostConfig.Binds ("<volume>:/vault:<opções>", como o Podman devolve).
   */
  function mountedVault(cur: any): string | null {
    const m = (cur?.Mounts ?? []).find((x: { Destination?: string }) => x.Destination === '/vault');
    if (m?.Name) return m.Name;
    const h = (cur?.HostConfig?.Mounts ?? []).find((x: { Target?: string }) => x.Target === '/vault');
    if (h?.Source) return h.Source;
    const b = (cur?.HostConfig?.Binds ?? []).map((x: unknown) => String(x).split(':')).find((x: string[]) => x[1] === '/vault' && /^[\w.-]+$/.test(x[0]));
    return b?.[0] ?? null;
  }
  const volumeOf = (cur: any): string | null => labelsOf(cur)[LABEL.volume] ?? mountedVault(cur);

  /** Desatualizado = especificação diferente, ou imagem diferente da configurada (menos a recusada numa volta, enquanto a configurada for ela). */
  function staleOf(uid: string, L: Labels, curImage: unknown, volume: string, want: string | null) {
    const spec = L[LABEL.spec] !== specHash(c, motorSpec(c, uid, volume));
    const held = L[LABEL.hold] === c.image;
    const image = !!want && !sameId(curImage, want) && !held;
    return { stale: spec || image, held };
  }

  async function createContainer(name: string, spec: Record<string, unknown>) {
    let made = await docker('POST', `/containers/create?name=${name}`, spec);
    if (made.status === 404) {
      // imagem ainda não está neste computador: baixa a publicada e tenta de novo
      await pull(String(spec.Image));
      made = await docker('POST', `/containers/create?name=${name}`, spec);
    }
    ok(made, 'criar o motor');
  }
  const startContainer = async (name: string) => ok(await docker('POST', `/containers/${name}/start`), 'ligar o motor');
  /** Cofre novo já com a marca da instalação (assim a limpeza reconhece um cofre sem motor como nosso, e não de outra instalação). */
  async function createVolume(volume: string, uid: string) {
    if ((await docker('GET', `/volumes/${volume}`)).status === 200) return;
    ok(await docker('POST', '/volumes/create', { Name: volume, Labels: { [LABEL.install]: inst, [LABEL.uid]: uid } }), 'criar o cofre do motor');
  }

  /** A imagem está neste computador agora? Sem cache (ela pode ter saído depois de conferida); sem ela, tenta baixar uma vez. */
  async function noDisco(image: string): Promise<boolean> {
    if (await lookupImage(image)) return true;
    idCache.delete(image);
    if (isId(image)) return false;
    try { await pull(image); } catch { return false; }
    return !!(await lookupImage(image).catch(() => null));
  }

  /**
   * Troca o contêiner pelo da imagem pedida, com o MESMO volume. Antes de mexer: o cofre montado tem de ser o do rótulo
   * (senão 409, e o motor nem é desligado) e a imagem pedida tem de estar no disco agora (senão, nada muda: 'sem-imagem').
   * Para (até 20 s), confere de novo e só remove o antigo se ele parou de fato; remove sem força e sem volumes.
   * Devolve o motivo quando não trocou (fica como estava).
   */
  async function recreate(uid: string, cur: any, volume: string, image: string, labels: Labels, start: boolean): Promise<{ now: any } | { motivo: MotivoAdiado }> {
    const name = motorName(uid);
    if (mountedVault(cur) !== volume) throw new ManagerError(409, 'o cofre montado no motor não confere com o rótulo: nada foi trocado (o motor segue como estava)');
    if (!(await noDisco(image))) return { motivo: 'sem-imagem' };
    if (cur?.State?.Running) {
      const s = await docker('POST', `/containers/${name}/stop?t=20`);
      if (s.status !== 404) ok(s, 'desligar o motor');
    }
    const now = await inspect(name);
    if (now) {
      if (now.State?.Running) return { motivo: 'nao-parou' };
      mine(now, uid);
      if (mountedVault(now) !== volume) throw new ManagerError(409, 'o cofre montado no motor não confere com o rótulo: nada foi trocado');
      const del = await docker('DELETE', `/containers/${name}`);
      if (del.status === 409) return { motivo: 'nao-parou' }; // voltou a ligar no meio do caminho: fica como estava
      if (del.status !== 404) ok(del, 'remover o contêiner antigo do motor');
    }
    try {
      await createContainer(name, motorSpec(c, uid, volume, { image, labels }));
    } catch (e) {
      // não deixa a pessoa sem motor: refaz com a imagem de antes, no mesmo cofre
      if (now?.Image) await docker('POST', `/containers/create?name=${name}`, motorSpec(c, uid, volume, { image: String(now.Image) })).catch(() => null);
      throw e;
    }
    if (start) await startContainer(name);
    return { now: await inspect(name) };
  }

  function report(uid: string, cur: any, f: { created?: boolean; recreated?: boolean; stale?: boolean; motivo?: MotivoAdiado }): EnsureResult {
    const L = labelsOf(cur);
    return {
      adopted: L[LABEL.volume] === c.legacyVolume,
      created: !!f.created, recreated: !!f.recreated, stale: !!f.stale,
      motivo: f.stale && !f.recreated ? f.motivo ?? null : null,
      image: fullId(cur?.Image), imageRef: L[LABEL.image] ?? null, prevImage: fullId(L[LABEL.prev]),
      pendente: pendentes.has(uid), held: L[LABEL.hold] === c.image,
      state: cur?.State?.Status ?? (cur?.State?.Running ? 'running' : 'exited'),
    };
  }

  /** O cofre de antes pode ir para esta pessoa? (existe, e nenhum outro contêiner o usa — nem o motor antigo ligado) */
  async function canAdopt(uid: string): Promise<boolean> {
    if ((await docker('GET', `/volumes/${c.legacyVolume}`)).status !== 200) return false;
    const users = await docker('GET', `/containers/json?all=1&filters=${enc({ volume: [c.legacyVolume] })}`);
    return (users.json ?? []).every((x: Summary) => x.Labels?.[LABEL.uid] === uid);
  }

  /**
   * Garante o motor da pessoa. Novo: cria (e liga). Existente e em dia: liga. Desatualizado: ligado e sem o Ergon dizer
   * que está livre (idle), não mexe e avisa (stale); parado ou livre, recria com o mesmo volume.
   */
  function ensure(uid: string, o: EnsureOptions = {}): Promise<EnsureResult> { return lock(uid, () => doEnsure(uid, o)); }
  async function doEnsure(uid: string, { adoptLegacy = false, idle = false, start = true }: EnsureOptions): Promise<EnsureResult> {
    const name = motorName(uid);
    const cur = await inspect(name);
    if (!cur) {
      const own = `${c.volumePrefix}${uid.slice(4)}`;
      // a pessoa já tem cofre (ex.: o gerente caiu no meio de uma troca, entre remover o contêiner antigo e criar o novo):
      // é ele que volta, nunca o herdado. O cofre de antes só vai para quem ainda não tem cofre nenhum
      const temCofre = (await docker('GET', `/volumes/${own}`)).status === 200;
      const adopt = adoptLegacy && !temCofre && (await canAdopt(uid));
      const volume = adopt ? c.legacyVolume : own;
      await imageId(c.image); // baixa antes, se faltar
      if (!adopt) await createVolume(volume, uid);
      await createContainer(name, motorSpec(c, uid, volume));
      if (start) await startContainer(name);
      return report(uid, await inspect(name), { created: true });
    }
    mine(cur, uid);
    const volume = volumeOf(cur);
    if (!volume) throw new ManagerError(409, 'não deu para saber qual é o cofre deste motor: nada foi trocado');
    const L = labelsOf(cur);
    const want = await imageId(c.image).catch(() => null); // sem a imagem (sem internet): segue com o motor de antes
    const st = staleOf(uid, L, cur.Image, volume, want);
    let motivo: MotivoAdiado | undefined;
    if (st.stale) {
      if (cur.State?.Running && !idle) return report(uid, cur, { stale: true, motivo: 'ocupado' });
      // depois de uma volta, uma mudança de especificação mantém a imagem e a trava
      const image = st.held ? String(cur.Image) : want ? c.image : null;
      if (image) {
        const prev = !st.held && !sameId(cur.Image, want) ? String(cur.Image) : null;
        const labels: Labels = st.held ? { [LABEL.hold]: L[LABEL.hold] } : prev ? { [LABEL.prev]: prev } : {};
        const r = await recreate(uid, cur, volume, image, labels, start);
        if ('now' in r) {
          naPartida.delete(uid);
          if (prev) pendentes.set(uid, hex(prev)); else pendentes.delete(uid);
          return report(uid, r.now, { recreated: true });
        }
        motivo = r.motivo;
      } else motivo = 'sem-imagem';
    }
    // não renovou agora (sem a imagem nova, ou o motor não parou): o de antes segue ligado, e o Ergon abre ele
    if (start && !(await inspect(name).then((x) => x?.State?.Running).catch(() => cur.State?.Running))) await startContainer(name);
    const fromStart = naPartida.delete(uid);
    return report(uid, (await inspect(name)) ?? cur, { recreated: fromStart, stale: st.stale, motivo });
  }

  /** A troca deu certo: apaga a imagem anterior (sem força; em uso, ou guardada para outra troca sem confirmar, fica). */
  function confirm(uid: string, others: string[] = []): Promise<{ removida: boolean; emUso?: boolean; id?: string }> {
    return lock(uid, async () => {
      const cur = await inspect(motorName(uid));
      if (!cur) throw new ManagerError(404, 'esta pessoa não tem motor');
      mine(cur, uid);
      pendentes.delete(uid); naPartida.delete(uid);
      const prev = labelsOf(cur)[LABEL.prev];
      if (!prev || sameId(prev, cur.Image)) return { removida: false };
      const pend = new Set([...others, ...pendentes.keys()]);
      const keep = new Set([...pendentes.values()]);
      for (const x of await listMotors()) {
        const XL = x.Labels ?? {};
        if (XL[LABEL.prev] && XL[LABEL.uid] !== uid && (pend.has(XL[LABEL.uid]) || XL[LABEL.install] !== inst)) keep.add(hex(XL[LABEL.prev]));
      }
      const want = await imageId(c.image, false).catch(() => null); if (want) keep.add(want);
      const self = await selfInfo(); if (self) keep.add(self.image);
      if (keep.has(hex(prev))) return { removida: false, emUso: true };
      const r = await docker('DELETE', `/images/${fullId(prev)}`);
      if (r.status === 409) return { removida: false, emUso: true };
      if (r.status === 404) return { removida: false };
      ok(r, 'apagar a imagem anterior do motor');
      return { removida: true, id: fullId(prev)! };
    });
  }

  /**
   * A troca não deu certo: recria com a imagem anterior (se ainda está no disco), no mesmo cofre, e marca a imagem
   * recusada (rótulo hold) para o próximo ensure não tentar de novo enquanto a configurada for ela.
   */
  function rollback(uid: string, start = true): Promise<EnsureResult> {
    return lock(uid, async () => {
      const cur = await inspect(motorName(uid));
      if (!cur) throw new ManagerError(404, 'esta pessoa não tem motor');
      mine(cur, uid);
      const L = labelsOf(cur);
      const prev = fullId(L[LABEL.prev]);
      if (!prev) throw new ManagerError(409, 'não há versão anterior guardada para voltar');
      if (!(await lookupImage(prev))) throw new ManagerError(409, 'a versão anterior do motor não está mais neste computador');
      const volume = volumeOf(cur);
      if (!volume) throw new ManagerError(409, 'não deu para saber qual é o cofre deste motor: nada foi trocado');
      const r = await recreate(uid, cur, volume, prev, { [LABEL.hold]: L[LABEL.image] ?? c.image }, start);
      if (!('now' in r)) throw new ManagerError(409, r.motivo === 'sem-imagem' ? 'a versão anterior do motor não está mais neste computador' : 'o motor não parou a tempo; tente de novo em instantes');
      pendentes.delete(uid); naPartida.delete(uid);
      return report(uid, r.now, { recreated: true });
    });
  }

  function stop(uid: string): Promise<void> {
    return lock(uid, async () => {
      const cur = await inspect(motorName(uid));
      if (!cur) return;
      mine(cur, uid);
      const r = await docker('POST', `/containers/${motorName(uid)}/stop?t=20`);
      if (r.status !== 404) ok(r, 'desligar o motor');
    });
  }
  /** Remove contêiner e cofre (conta removida). O cofre herdado também sai: era dela. */
  function remove(uid: string): Promise<void> {
    return lock(uid, async () => {
      const cur = await inspect(motorName(uid));
      if (cur) mine(cur, uid);
      const volume = (cur && volumeOf(cur)) || `${c.volumePrefix}${uid.slice(4)}`;
      if (cur) ok(await docker('DELETE', `/containers/${motorName(uid)}?force=true`), 'remover o motor');
      const v = await docker('DELETE', `/volumes/${volume}`);
      if (v.status !== 404) ok(v, 'remover o cofre do motor');
      pendentes.delete(uid); naPartida.delete(uid);
    });
  }

  async function listMotors(): Promise<Summary[]> {
    const r = await docker('GET', `/containers/json?all=1&filters=${enc({ label: [LABEL.uid] })}`);
    ok(r, 'listar os motores');
    return (r.json ?? []) as Summary[];
  }
  /** Motores desta instalação (e os antigos, sem a marca, como "legado": o Ergon cruza com as contas dele). */
  async function list() {
    const want = await imageId(c.image, false).catch(() => null);
    return (await listMotors()).filter((x) => { const L = x.Labels ?? {}; return UID.test(L[LABEL.uid] ?? '') && (!L[LABEL.install] || L[LABEL.install] === inst); }).map((x) => {
      const L = x.Labels ?? {}; const uid = L[LABEL.uid];
      const volume = L[LABEL.volume] ?? (x.Mounts ?? []).find((m) => m.Destination === '/vault')?.Name ?? '';
      return {
        uid, state: x.State ?? 'unknown', image: fullId(x.ImageID), imageRef: L[LABEL.image] ?? null, prevImage: fullId(L[LABEL.prev]),
        stale: staleOf(uid, L, x.ImageID, volume, want).stale, pendente: pendentes.has(uid), legado: !L[LABEL.install], held: L[LABEL.hold] === c.image,
      };
    });
  }

  // ---- o próprio gerente: a imagem e o repositório do núcleo
  let selfCache: Promise<{ image: string; ref: string | null } | null> | null = null;
  function selfInfo() {
    selfCache ??= (async () => {
      for (const id of c.selfIds ?? []) {
        if (!/^[a-f0-9]{12,64}$/.test(id)) continue;
        const r = await docker('GET', `/containers/${id}/json`);
        if (r.status !== 200 || !hex(r.json?.Id).startsWith(id) || !hex(r.json?.Image)) continue;
        return { image: hex(r.json.Image), ref: typeof r.json.Config?.Image === 'string' ? r.json.Config.Image as string : null };
      }
      return null;
    })().catch(() => { selfCache = null; return null; });
    return selfCache;
  }

  // ---- limpeza
  async function df(): Promise<{ layers: number; unique: Map<string, number> } | null> {
    const r = await docker('GET', '/system/df').catch(() => null);
    if (!r || r.status !== 200) return null;
    const unique = new Map<string, number>();
    for (const i of r.json?.Images ?? []) {
      const s = Number(i.Size), sh = Number(i.SharedSize);
      if (Number.isFinite(s) && Number.isFinite(sh) && sh >= 0) unique.set(hex(i.Id), Math.max(0, s - sh));
    }
    return { layers: Number(r.json?.LayersSize) || 0, unique };
  }
  const isMotorVolume = (nome: string) => nome.startsWith(c.volumePrefix) && /^[a-f0-9]{32}$/.test(nome.slice(c.volumePrefix.length));
  const listAll = async () => { const r = await docker('GET', '/containers/json?all=1'); ok(r, 'listar os contêineres'); return (r.json ?? []) as Summary[]; };

  /**
   * Libera espaço: apaga só imagens dos repositórios do Ergon (o do motor configurado e o do núcleo, que é o do
   * próprio gerente) que nada protege — a imagem de todo contêiner (inclusive parado), a atual do motor, a do gerente,
   * a anterior de cada troca sem confirmar (e as de outra instalação) e, só se pedido, a versão anterior do núcleo (para
   * voltar sem internet). Sem força, sem prune; 409 = fica. Contêiner de conta que não existe mais (com a marca desta
   * instalação) sai; o cofre fica e vira aviso. NUNCA apaga volume aqui.
   */
  function clean(b: CleanRequest): Promise<CleanResult> {
    // a estimativa não apaga nada: só espera as trocas em andamento, sem segurar as novas
    if (b.estimar) return Promise.allSettled([...locks.values()]).then(() => doClean(b));
    // não limpa no meio de uma troca (espera as que já estão em andamento) e nenhuma troca começa no meio da limpeza
    const ativas = [...locks.values()];
    const anterior = limpezaAtual;
    const p = Promise.all([anterior?.catch(() => null), Promise.allSettled(ativas)]).then(() => doClean(b));
    limpezaAtual = p;
    void p.catch(() => null).then(() => { if (limpezaAtual === p) limpezaAtual = null; });
    return p;
  }
  async function doClean(b: CleanRequest): Promise<CleanResult> {
    const users = new Set((b.users ?? []).filter((u) => UID.test(u)));
    const pend = new Set([...(b.pendentes ?? []).filter((u) => UID.test(u)), ...pendentes.keys()]);
    const avisos: CleanResult['avisos'] = [];

    // 1) contêiner de conta removida: só com a marca desta instalação, e só com a lista de contas do Ergon (na estimativa, nada sai)
    let all = await listAll();
    if (users.size && !b.estimar) {
      let removed = false;
      for (const x of all) {
        const L = x.Labels ?? {}; const uid = L[LABEL.uid];
        if (!uid || !UID.test(uid) || L[LABEL.install] !== inst || users.has(uid)) continue;
        const ref = x.Id ?? motorName(uid);
        // sem o lock da pessoa: com a limpeza em andamento, nenhuma operação por pessoa roda (as novas esperam a limpeza)
        const gone = await (async () => {
          const s = await docker('POST', `/containers/${ref}/stop?t=20`);
          if (s.status >= 300 && s.status !== 304) return false;
          const d = await docker('DELETE', `/containers/${ref}`); // sem força e sem volumes
          return d.status < 300 || d.status === 404;
        })().catch(() => false);
        if (!gone) continue;
        removed = true;
        if (L[LABEL.volume]) avisos.push({ volume: L[LABEL.volume], motivo: 'conta-removida', texto: 'A conta não existe mais neste computador; o cofre do motor dela ficou guardado.' });
      }
      if (removed) all = await listAll();
    }

    // 2) o que fica
    const keep = new Set<string>();
    for (const x of all) if (hex(x.ImageID)) keep.add(hex(x.ImageID));
    for (const x of all) {
      const L = x.Labels ?? {}; const uid = L[LABEL.uid];
      if (!L[LABEL.prev]) continue;
      const ours = L[LABEL.install] === inst || (!L[LABEL.install] && users.has(uid));
      if (!ours || pend.has(uid)) keep.add(hex(L[LABEL.prev])); // de outra instalação: não sabemos se ela ainda vai precisar voltar
    }
    for (const id of pendentes.values()) keep.add(id);
    const motorNow = await imageId(c.image, false).catch(() => null);
    if (motorNow) keep.add(motorNow);
    const self = await selfInfo();
    if (self) keep.add(self.image);

    const ir = await docker('GET', '/images/json'); ok(ir, 'listar as imagens');
    const images = ((ir.json ?? []) as ImageSummary[]).filter((i) => hex(i.Id));
    const byId = new Map(images.map((i) => [hex(i.Id), i]));
    const motorRepos = new Set([repoOf(c.image), ...refsOf(motorNow ? byId.get(motorNow) : undefined).map(repoOf)].filter(ergonRepo));
    // sem se achar (hostname e cgroup não dizem), não sabe qual é o núcleo: as imagens dele ficam todas
    const coreRepos = new Set(self ? [...(self.ref && !isId(self.ref) ? [repoOf(self.ref)] : []), ...refsOf(byId.get(self.image)).map(repoOf)].filter(ergonRepo) : []);
    const ergonRepos = new Set([...motorRepos, ...coreRepos]);
    const onlyIn = (img: ImageSummary, repos: Set<string>) => { const refs = refsOf(img); return refs.length > 0 && refs.every((r) => repos.has(repoOf(r))); };

    // a versão anterior do núcleo (só se pedido: a regra é a mesma do lançador, que apaga a anterior ao atualizar)
    if (b.manterNucleoAnterior === true && self && coreRepos.size) {
      const selfCreated = byId.get(self.image)?.Created ?? Infinity;
      const older = images.filter((i) => hex(i.Id) !== self.image && onlyIn(i, coreRepos) && (i.Created ?? 0) <= selfCreated)
        .sort((x, y) => (y.Created ?? 0) - (x.Created ?? 0));
      if (older[0]) keep.add(hex(older[0].Id));
    }

    const candidates = images.filter((i) => !keep.has(hex(i.Id)) && onlyIn(i, ergonRepos));
    if (b.estimar) {
      // só a conta, sem apagar nada: o que era só de cada imagem (Size - SharedSize); sem essa conta, não inventa número
      const d = candidates.length ? await df() : null;
      const liberavel = !candidates.length ? 0 : candidates.every((i) => d?.unique.has(hex(i.Id))) ? candidates.reduce((s, i) => s + d!.unique.get(hex(i.Id))!, 0) : null;
      return { removidas: [], liberado: null, liberavel, avisos: [], repositorios: [...ergonRepos] };
    }
    const removidas: CleanResult['removidas'] = [];
    let liberado: number | null = 0;
    if (candidates.length) {
      const before = await df();
      for (const i of candidates) {
        const r = await docker('DELETE', `/images/${fullId(i.Id)}`);
        if (r.status === 409 || r.status === 404) continue; // em uso, ou com nome em outro repositório: fica
        ok(r, 'apagar uma imagem antiga');
        removidas.push({ id: fullId(i.Id)!, bytes: before?.unique.get(hex(i.Id)) ?? Number(i.Size ?? 0) });
      }
      if (removidas.length) {
        // conta honesta: a diferença real do disco (LayersSize, no Docker e no Podman 5.x); quando ele vem 0 ou falta, só o
        // que era exclusivo de cada imagem
        const after = before?.layers ? await df() : null;
        if (before?.layers && after?.layers) liberado = Math.max(0, before.layers - after.layers);
        else liberado = removidas.every((x) => before?.unique.has(hex(x.id))) ? removidas.reduce((s, x) => s + x.bytes, 0) : null;
      }
    }

    // 3) cofres sem motor cuja conta não está na lista do Ergon, e os que o Ergon diz não terem conta (cruzando com o
    // banco): só aviso; apagar é outra rota, com confirmação da pessoa. O cofre de uma conta da lista nunca vira aviso
    // (depois de reinstalar, os cofres ficam sem contêiner até cada pessoa entrar de novo).
    const uidOf = (n: string) => `usr_${n.slice(c.volumePrefix.length)}`;
    const vr = users.size || b.volumesOrfaos?.length ? await docker('GET', '/volumes').catch(() => null) : null;
    const lista = vr?.status === 200 ? ((vr.json?.Volumes ?? []) as { Name?: string; Labels?: Labels | null }[]) : [];
    const marcaDe = new Map(lista.map((x) => [String(x.Name ?? ''), donoDoCofre(x.Labels)]));
    // só os com a marca desta instalação; um cofre sem a marca (de antes dela) só se o Ergon mandar o nome; o de outra
    // instalação nunca, nem com o nome mandado
    const semConta = users.size ? lista.filter((x) => donoDoCofre(x.Labels) === 'nossa').map((x) => String(x.Name ?? '')).filter((n) => isMotorVolume(n) && !users.has(uidOf(n))) : [];
    for (const nome of new Set([...(b.volumesOrfaos ?? []), ...semConta])) {
      if (typeof nome !== 'string' || !isMotorVolume(nome) || nome === c.legacyVolume || avisos.some((a) => a.volume === nome)) continue;
      if (users.has(uidOf(nome)) || marcaDe.get(nome) === 'outra' || (vr?.status !== 200)) continue;
      if ((await docker('GET', `/volumes/${nome}`)).status !== 200) continue;
      const users2 = await docker('GET', `/containers/json?all=1&filters=${enc({ volume: [nome] })}`);
      if (users2.status !== 200 || (users2.json ?? []).length) continue;
      avisos.push({ volume: nome, motivo: 'sem-conta', texto: 'Cofre de um motor sem conta neste computador.' });
    }
    return { removidas, liberado, avisos, repositorios: [...ergonRepos] };
  }

  /** De quem é um cofre: com a marca desta instalação, sem marca (de antes da marca, ou de outra versão), ou de outra instalação. */
  const donoDoCofre = (labels: Labels | null | undefined): 'nossa' | 'sem-marca' | 'outra' => {
    const m = labels?.[LABEL.install];
    return !m ? 'sem-marca' : m === inst ? 'nossa' : 'outra';
  };
  /**
   * Cofres de motor neste computador (o Ergon cruza com as contas para saber qual é órfão). Num Docker compartilhado, o
   * cofre com a marca de OUTRA instalação nem aparece: o Ergon não tem como saber se a conta dele existe lá.
   */
  async function volumes() {
    const vr = await docker('GET', '/volumes'); ok(vr, 'listar os volumes');
    const used = new Set<string>();
    for (const x of await listAll()) for (const m of x.Mounts ?? []) if (m.Name) used.add(m.Name);
    return ((vr.json?.Volumes ?? []) as { Name: string; Labels?: Labels | null }[])
      .filter((v) => (isMotorVolume(v.Name) || v.Name === c.legacyVolume) && donoDoCofre(v.Labels) !== 'outra')
      .map((v) => ({ nome: v.Name, uid: isMotorVolume(v.Name) ? `usr_${v.Name.slice(c.volumePrefix.length)}` : null, emUso: used.has(v.Name), herdado: v.Name === c.legacyVolume, instalacao: donoDoCofre(v.Labels) as 'nossa' | 'sem-marca' }));
  }
  /**
   * Apaga um cofre que o Ergon disse ser órfão (cruzando com o banco, com confirmação da pessoa). Nunca o herdado, nunca em
   * uso, nunca o de outra instalação.
   */
  async function removeVolume(nome: string) {
    if (nome === c.legacyVolume) throw new ManagerError(409, 'o cofre herdado do motor de antes não sai por aqui');
    if (!isMotorVolume(nome)) throw new ManagerError(400, 'esse volume não é o cofre de um motor');
    const v = await docker('GET', `/volumes/${nome}`);
    if (v.status === 404) return { removido: false };
    ok(v, 'conferir o cofre');
    if (donoDoCofre(v.json?.Labels) === 'outra') throw new ManagerError(409, 'esse cofre é de outra instalação do Ergon neste computador: nada foi apagado');
    const users = await docker('GET', `/containers/json?all=1&filters=${enc({ volume: [nome] })}`);
    ok(users, 'conferir quem usa o cofre');
    if ((users.json ?? []).length) throw new ManagerError(409, 'esse cofre ainda é usado por um motor');
    const r = await docker('DELETE', `/volumes/${nome}`);
    if (r.status === 404) return { removido: false };
    if (r.status === 409) throw new ManagerError(409, 'esse cofre ainda é usado por um motor');
    ok(r, 'apagar o cofre');
    return { removido: true };
  }

  /** Na partida: motores PARADOS e desatualizados desta instalação são recriados sem ligar. Os ligados ficam (quem decide é o Ergon). */
  async function reconcileOnStart(): Promise<string[]> {
    const done: string[] = [];
    for (const x of await listMotors()) {
      const L = x.Labels ?? {}; const uid = L[LABEL.uid];
      if (!uid || !UID.test(uid) || L[LABEL.install] !== inst || x.State === 'running' || x.State === 'restarting' || x.State === 'paused') continue;
      try {
        const r = await ensure(uid, { start: false });
        if (r.recreated) { naPartida.add(uid); done.push(uid); }
      } catch { /* o Ergon tenta de novo quando a pessoa precisar */ }
    }
    return done;
  }

  /** Atende um pedido do Ergon (já com o corpo lido). */
  async function handle(method: string, url: string, token: string | undefined, body: unknown): Promise<{ status: number; json: any }> {
    try {
      if (url === '/health' && method === 'GET') return { status: 200, json: { ok: true } };
      const t = Buffer.from(token ?? ''); const m = Buffer.from(c.master);
      if (!c.master || t.length !== m.length || !crypto.timingSafeEqual(t, m)) throw new ManagerError(401, 'token inválido');
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const uids = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && UID.test(x)) : [];
      if (url === '/v1/motors' && method === 'GET') return { status: 200, json: { motors: await list() } };
      if (url === '/v1/volumes' && method === 'GET') return { status: 200, json: { volumes: await volumes() } };
      if (url === '/v1/maintenance/clean') {
        if (method !== 'POST') throw new ManagerError(405, 'método não permitido');
        const orf = Array.isArray(b.volumesOrfaos) ? b.volumesOrfaos.filter((x): x is string => typeof x === 'string') : [];
        return { status: 200, json: { ok: true, ...(await clean({ users: uids(b.users), pendentes: uids(b.pendentes), volumesOrfaos: orf, manterNucleoAnterior: b.manterNucleoAnterior === true })) } };
      }
      // a mesma conta da limpeza, sem apagar nada (rota própria: um gerente de antes responde 404, nunca limpa por engano)
      if (url === '/v1/maintenance/estimate') {
        if (method !== 'POST') throw new ManagerError(405, 'método não permitido');
        const r = await clean({ users: uids(b.users), pendentes: uids(b.pendentes), manterNucleoAnterior: b.manterNucleoAnterior === true, estimar: true });
        return { status: 200, json: { ok: true, liberavel: r.liberavel ?? null, repositorios: r.repositorios } };
      }
      const v = /^\/v1\/volumes\/([^/]+)$/.exec(url);
      if (v) {
        if (method !== 'DELETE') throw new ManagerError(405, 'método não permitido');
        let nome = '';
        try { nome = decodeURIComponent(v[1]); } catch { /* nome inválido */ }
        if (!/^[\w.-]{1,128}$/.test(nome)) throw new ManagerError(400, 'nome de volume inválido');
        return { status: 200, json: { ok: true, ...(await removeVolume(nome)) } };
      }
      const r = /^\/v1\/motors\/([^/]+)(?:\/(ensure|stop|confirm|rollback))?$/.exec(url);
      if (!r) throw new ManagerError(404, 'rota desconhecida');
      if (!UID.test(r[1])) throw new ManagerError(400, 'pessoa inválida');
      if (method === 'POST' && r[2] === 'ensure') return { status: 200, json: { ok: true, ...(await ensure(r[1], { adoptLegacy: b.adoptLegacy === true, idle: b.idle === true, start: b.start !== false })) } };
      if (method === 'POST' && r[2] === 'stop') { await stop(r[1]); return { status: 200, json: { ok: true } }; }
      if (method === 'POST' && r[2] === 'confirm') return { status: 200, json: { ok: true, ...(await confirm(r[1], uids(b.pendentes))) } };
      if (method === 'POST' && r[2] === 'rollback') return { status: 200, json: { ok: true, ...(await rollback(r[1], b.start !== false)) } };
      if (!r[2] && method === 'DELETE') { await remove(r[1]); return { status: 200, json: { ok: true } }; }
      throw new ManagerError(405, 'método não permitido');
    } catch (e) {
      return { status: e instanceof ManagerError ? e.status : 500, json: { error: (e as Error).message.slice(0, 300) } };
    }
  }
  return { handle, ensure, stop, remove, list, confirm, rollback, clean, volumes, removeVolume, reconcileOnStart };
}

/** Docker Engine API pelo socket (ou por um endereço, nos testes). */
export function dockerOver(socketPath: string | null, baseUrl: string | null): DockerCall {
  return (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const target = baseUrl ? new URL(baseUrl) : null;
    const req = http.request({
      ...(target ? { hostname: target.hostname, port: target.port } : { socketPath: socketPath! }),
      method, path: `/v1.41${path}`, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json: unknown = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = { message: raw.slice(0, 200) }; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('Docker não respondeu')));
    if (data) req.write(data);
    req.end();
  });
}

/** Maior corpo aceito: a lista de até 1.000 pessoas da limpeza cabe com folga. */
export const MAX_BODY = 64 * 1024;

/** Servidor HTTP do gerente (rede interna do Ergon). Ao ligar, recria (sem ligar) os motores parados e desatualizados. */
export function serveManager(c: ManagerConfig, docker: DockerCall, port: number, host = '0.0.0.0', onReconciled?: (uids: string[]) => void): http.Server {
  const m = createManager(c, docker);
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []; let size = 0; let tooBig = false;
    req.on('data', (x: Buffer) => { size += x.length; if (size > MAX_BODY) tooBig = true; else chunks.push(x); });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'pedido grande demais' })); return; }
      let body: unknown = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const out = await m.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], req.headers['x-ergon-manager-token'] as string | undefined, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  srv.listen(port, host, () => { void m.reconcileOnStart().then((u) => onReconciled?.(u), () => onReconciled?.([])); });
  return srv;
}

/** "2g", "512m", "1536" (MB) → bytes */
export function memBytes(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([gmk]?)b?$/i.exec(v.trim());
  if (!m) return 2 * 1024 ** 3;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return Math.round(n * (u === 'g' ? 1024 ** 3 : u === 'k' ? 1024 : 1024 ** 2));
}

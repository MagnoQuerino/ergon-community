/**
 * Docker falso do gerente de motores (renovação, volta e limpeza): conhece imagens (mapa nome → ID, 'Image' no inspect,
 * /images/{ref}/json, /images/json, DELETE /images com 409, /system/df), volumes com rótulos, e conta cada chamada. Usado
 * pelos testes do gerente sozinho e pelos de ponta a ponta (gerente de verdade atrás do servidor de verdade).
 */
import crypto from 'node:crypto';
import type { DockerCall, ManagerConfig } from '../src/services/motor-manager.ts';

export const MASTER = 'token-da-instalacao-'.padEnd(40, 'y');
export const OUTRO = 'token-de-outra-instalacao-'.padEnd(40, 'z');
export const U1 = `usr_${'c'.repeat(32)}`; const U2 = `usr_${'e'.repeat(32)}`; const U3 = `usr_${'7'.repeat(32)}`;
export const vol = (uid: string) => `ergon_motor-${uid.slice(4)}`;
export const nome = (uid: string) => `ergon-motor-${uid.slice(4)}`;
export const h = (p: string) => p.padEnd(64, '0');
export const CORE = 'ghcr.io/exemplo/ergon-community'; const MOTOR = 'ghcr.io/exemplo/ergon-community-hermes';
export const dig = (p: string) => `sha256:${h(p)}`;
/** As imagens do motor como numa instalação de verdade: baixadas só por digest (sem tag). */
export const A_REF = `${MOTOR}@${dig('a0a0a0a1')}`; const A = h('a0a0a0a2');   // a de 30/10, em uso pelo motor
export const B_REF = `${MOTOR}@${dig('b0b0b0b1')}`; const B = h('b0b0b0b2');   // a da rc.22, configurada e sem contêiner
export const C_REF = `${MOTOR}@${dig('c0ffee77')}`; const C = h('c0ffee11');   // uma versão seguinte
export const CORE_NOW = h('c0c0c0c1'); const SELF_ID = 'f'.repeat(64);

export const base = { network: 'ergon-net', legacyVolume: 'ergon_hermes-vault', volumePrefix: 'ergon_motor-', bridgeUrl: 'http://ergon:8787/internal/bridge/v1/events', memBytes: 2 * 1024 ** 3, nanoCpus: 2e9 };
export const cfg = (image: string, extra: Partial<ManagerConfig> = {}): ManagerConfig => ({ master: MASTER, image, ...base, selfIds: [SELF_ID.slice(0, 12)], ...extra });

interface Img { id: string; tags: string[]; digests: string[]; created: number; size: number; shared: number; conflito?: boolean }
interface Ctr { id: string; name: string; spec: any; running: boolean; image: string }

/**
 * Docker falso. bareIds: o inspect e a lista de contêineres devolvem o ID da imagem sem 'sha256:' (como alguns Podman).
 * podman: as respostas com a forma do Podman 5.6.2 de verdade (sondado na instalação real, só leitura): no inspect,
 * HostConfig.Mounts null e o cofre só em HostConfig.Binds e em Mounts[].Name; no /system/df, LayersSize de verdade
 * (diferente de 0), Images[].Id só com o hex e RepoTags ['<none>']; no /images/json, RepoTags com os digests quando não
 * há tag; cofre sem rótulo com Labels {} (e Warnings []); 404 com {cause, message, response}.
 */
export function fakeDocker(o: { bareIds?: boolean; bareImageIds?: boolean; stuckStop?: boolean; layersSize?: boolean; podman?: boolean } = {}) {
  const images = new Map<string, Img>();
  const registry = new Map<string, Img>();
  const containers = new Map<string, Ctr>();
  const volumes = new Set<string>();
  const volLabels = new Map<string, Record<string, string>>();
  const calls: string[] = [];
  const fmt = (id: string) => (o.bareIds ? id : `sha256:${id}`);
  /** corpo do 404: o do Podman ({cause, message, response}) ou o do Docker ({message}) */
  const nf = (cause: string) => ({ status: 404, json: o.podman ? { cause, message: `${cause}`, response: 404 } : { message: cause } });
  /** total do disco ocupado pelas camadas: as exclusivas de cada imagem e cada base compartilhada uma vez só */
  const layersTotal = (imgs: Img[]) => imgs.reduce((s, i) => s + i.size - i.shared, 0) + [...new Set(imgs.map((i) => i.shared).filter((x) => x > 0))].reduce((s, x) => s + x, 0);
  const resolve = (ref: string): Img | undefined => {
    const x = ref.replace(/^sha256:/, '');
    if (images.has(x)) return images.get(x);
    return [...images.values()].find((i) => i.tags.includes(ref) || i.digests.includes(ref) || i.tags.includes(`localhost/${ref}`));
  };
  const byName = (x: string) => containers.get(x) ?? [...containers.values()].find((c) => c.id.startsWith(x));
  const summary = (c: Ctr) => ({
    Id: c.id, Names: [`/${c.name}`], Image: c.spec.Image, ImageID: fmt(c.image), Labels: c.spec.Labels ?? {}, State: c.running ? 'running' : 'exited',
    Mounts: (c.spec.HostConfig?.Mounts ?? []).map((m: any) => ({ Type: 'volume', Name: m.Source, Destination: m.Target })),
  });
  const addImage = (i: Partial<Img> & { id: string }) => { const img = { tags: [], digests: [], created: 1, size: 100, shared: 0, ...i } as Img; images.set(img.id, img); return img; };
  const addContainer = (name: string, spec: any, imageId: string, running: boolean) => {
    const id = crypto.createHash('sha256').update(name + Math.random()).digest('hex');
    containers.set(name, { id, name, spec, running, image: imageId });
    for (const m of spec.HostConfig?.Mounts ?? []) volumes.add(m.Source);
    return id;
  };

  const docker: DockerCall = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const [p, q = ''] = path.split('?'); const qs = new URLSearchParams(q);
    let m;
    if ((m = /^\/containers\/([\w.-]+)\/json$/.exec(p)) && method === 'GET') {
      const c = byName(m[1]);
      if (!c) return nf('no such container');
      const s = summary(c);
      // Podman: HostConfig.Mounts vem null; o cofre só aparece em Binds ("<volume>:<destino>:<opções>") e em Mounts[].Name
      const hc = o.podman ? { ...(c.spec.HostConfig ?? {}), Mounts: null, Binds: (c.spec.HostConfig?.Mounts ?? []).map((m: any) => `${m.Source}:${m.Target}:rprivate,nosuid,nodev,rbind`) } : c.spec.HostConfig;
      return { status: 200, json: { Id: c.id, Name: `/${c.name}`, Image: fmt(c.image), State: { Running: c.running, Status: s.State }, Config: { Labels: s.Labels, Image: c.spec.Image }, Mounts: s.Mounts, HostConfig: hc } };
    }
    if (p === '/containers/create' && method === 'POST') {
      const n = qs.get('name')!;
      if (containers.has(n)) return { status: 409, json: { message: 'name in use' } };
      const img = resolve((body as any).Image);
      if (!img) return { status: 404, json: { message: 'No such image' } };
      addContainer(n, structuredClone(body), img.id, false);
      return { status: 201, json: { Id: containers.get(n)!.id } };
    }
    if ((m = /^\/containers\/([\w.-]+)\/(start|stop)$/.exec(p)) && method === 'POST') {
      const c = byName(m[1]);
      if (!c) return nf('no such container');
      if (m[2] === 'start') { if (c.running) return { status: 304, json: null }; c.running = true; return { status: 204, json: null }; }
      if (!c.running) return { status: 304, json: null };
      if (!o.stuckStop) c.running = false;
      return { status: 204, json: null };
    }
    if ((m = /^\/containers\/([\w.-]+)$/.exec(p)) && method === 'DELETE') {
      const c = byName(m[1]);
      if (!c) return nf('no such container');
      if (c.running && qs.get('force') !== 'true') return { status: 409, json: { message: 'You cannot remove a running container' } };
      containers.delete(c.name);
      return { status: 204, json: null };
    }
    if (p === '/containers/json' && method === 'GET') {
      const f = qs.get('filters') ? JSON.parse(qs.get('filters')!) : {};
      let all = [...containers.values()].map(summary);
      if (f.label) all = all.filter((x) => f.label.every((l: string) => l in x.Labels));
      if (f.volume) all = all.filter((x) => x.Mounts.some((mt: any) => mt.Name === f.volume[0]));
      return { status: 200, json: all };
    }
    if ((m = /^\/images\/(.+)\/json$/.exec(p)) && method === 'GET') {
      const i = resolve(m[1]);
      return i ? { status: 200, json: { Id: o.bareImageIds ? i.id : `sha256:${i.id}`, RepoTags: i.tags, RepoDigests: i.digests, Created: i.created, Size: i.size } } : nf('No such image');
    }
    if (p === '/images/create' && method === 'POST') {
      const from = qs.get('fromImage') ?? ''; const tag = qs.get('tag');
      const ref = tag ? (tag.startsWith('sha256:') ? `${from}@${tag}` : `${from}:${tag}`) : from;
      const r = registry.get(ref);
      if (!r) return { status: 404, json: { message: 'manifest unknown' } };
      addImage(structuredClone(r));
      return { status: 200, json: { message: '{"status":"Download complete"}' } };
    }
    if (p === '/images/json' && method === 'GET') {
      return { status: 200, json: [...images.values()].map((i) => ({ Id: `sha256:${i.id}`, RepoTags: i.tags.length ? i.tags : o.podman ? i.digests : null, RepoDigests: i.digests, Created: i.created, Size: i.size, SharedSize: -1 })) };
    }
    if ((m = /^\/images\/(.+)$/.exec(p)) && method === 'DELETE') {
      const i = resolve(m[1]);
      if (!i) return nf('No such image');
      if (qs.get('force') === 'true') throw new Error('o gerente nunca apaga imagem com força');
      if (i.conflito || [...containers.values()].some((c) => c.image === i.id)) return { status: 409, json: { message: 'conflict: image is being used' } };
      images.delete(i.id);
      return { status: 200, json: [{ Deleted: `sha256:${i.id}` }] };
    }
    if (p === '/system/df' && method === 'GET') {
      const imgs = [...images.values()];
      if (o.podman) return { status: 200, json: { LayersSize: layersTotal(imgs), Images: imgs.map((i) => ({ Id: i.id, Size: i.size, SharedSize: i.shared, VirtualSize: i.shared, Containers: [...containers.values()].filter((c) => c.image === i.id).length, RepoTags: ['<none>'] })) } };
      return { status: 200, json: { LayersSize: o.layersSize ? imgs.reduce((s, i) => s + i.size - i.shared, 0) : 0, Images: imgs.map((i) => ({ Id: `sha256:${i.id}`, Size: i.size, SharedSize: i.shared })) } };
    }
    const labelsOfVol = (n: string) => volLabels.get(n) ?? (o.podman ? {} : null);
    if (p === '/volumes' && method === 'GET') return { status: 200, json: { Volumes: [...volumes].map((Name) => ({ Name, Labels: labelsOfVol(Name), ...(o.podman ? { Driver: 'local' } : {}) })), Warnings: o.podman ? [] : null } };
    if (p === '/volumes/create' && method === 'POST') { const b = body as any; if (!volumes.has(b.Name)) { volumes.add(b.Name); volLabels.set(b.Name, b.Labels ?? {}); } return { status: 201, json: { Name: b.Name } }; }
    if ((m = /^\/volumes\/([\w.-]+)$/.exec(p))) {
      if (method === 'DELETE') {
        if ([...containers.values()].some((c) => (c.spec.HostConfig?.Mounts ?? []).some((mt: any) => mt.Source === m![1]))) return { status: 409, json: { message: 'volume is in use' } };
        return volumes.delete(m[1]) ? { status: 204, json: null } : o.podman ? nf('no such volume') : { status: 404, json: null };
      }
      return volumes.has(m[1]) ? { status: 200, json: { Name: m[1], Labels: labelsOfVol(m[1]) } } : o.podman ? nf('no such volume') : { status: 404, json: null };
    }
    return { status: 599, json: { message: `rota de teste ausente: ${method} ${path}` } };
  };
  const count = (re: RegExp) => calls.filter((x) => re.test(x)).length;
  return { docker, images, registry, containers, volumes, volLabels, calls, count, addImage, addContainer };
}

/** O contêiner do motor como a rc.22 criava: só os rótulos da pessoa e do volume. */
export function specRc22(uid: string, volume: string, image: string) {
  return { Image: image, Cmd: ['gateway', 'run'], Labels: { 'ergon.motor': uid, 'ergon.motor.volume': volume }, HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/vault' }], NetworkMode: 'ergon-net' } };
}

/**
 * A instalação de verdade antes da troca: núcleo da rc.22 (ergon_ergon_1 e o gerente), o motor parado na imagem de
 * 30/10, a imagem do motor da rc.22 baixada e sem contêiner, versões antigas dos dois e imagens de terceiros.
 */
export function instalacaoPresa(o: Parameters<typeof fakeDocker>[0] = {}) {
  const d = fakeDocker(o);
  [['c1c1c1c1', 1], ['c2c2c2c2', 2], ['c3c3c3c3', 3], ['c4c4c4c4', 4]].forEach(([id, t]) => d.addImage({ id: h(id as string), digests: [`${CORE}@${dig(`${id}9`)}`], created: t as number, size: 116e6, shared: 0 }));
  d.addImage({ id: CORE_NOW, digests: [`${CORE}@${dig('c0c0c0c19')}`], created: 5, size: 116e6 });
  [['d1d1d1d1', 1], ['d2d2d2d2', 2], ['d3d3d3d3', 3]].forEach(([id, t]) => d.addImage({ id: h(id as string), digests: [`${MOTOR}@${dig(`${id}9`)}`], created: t as number, size: 3.28e9, shared: 3.268e9 }));
  d.addImage({ id: A, digests: [A_REF], created: 4, size: 3.28e9, shared: 3.268e9 });
  d.addImage({ id: B, digests: [B_REF], created: 6, size: 3.28e9, shared: 3.268e9 });
  d.addImage({ id: h('a1a1a1a1'), tags: ['alpine:3.20'], digests: [`alpine@${dig('a1a1')}`], created: 1, size: 8e6 });
  d.addImage({ id: h('9e9e9e9e'), tags: ['quay.io/terceiro/ferramenta:1'], created: 1, size: 5e7 });
  d.addImage({ id: h('3e3e3e3e'), tags: [`${MOTOR}:minha`, 'meu/outro:1'], created: 1, size: 1e6 }); // com nome de fora também: fica
  d.addImage({ id: h('0d0d0d0d'), tags: [], digests: [], created: 1, size: 1e6 }); // sem nome nenhum: não dá para saber de quem é
  d.addContainer('ergon_ergon_1', { Image: `${CORE}@${dig('c0c0c0c19')}`, Labels: { 'com.docker.compose.service': 'ergon' } }, CORE_NOW, true);
  d.containers.get('ergon_ergon_1')!.spec.HostConfig = { Mounts: [{ Type: 'volume', Source: 'ergon_ergon-data', Target: '/data' }] }; d.volumes.add('ergon_ergon-data');
  d.containers.set('ergon_motores_1', { id: SELF_ID, name: 'ergon_motores_1', spec: { Image: `${CORE}@${dig('c0c0c0c19')}`, Labels: { 'com.docker.compose.service': 'motores' } }, running: true, image: CORE_NOW });
  d.addContainer(nome(U1), specRc22(U1, vol(U1), A_REF), A, false);
  return d;
}
export { U2, U3, MOTOR, A, B, C, SELF_ID };

/**
 * GitHub e GitLab de mentira, fiéis no que importa (rc.42, conexoes/codigo.ts): o git de verdade (git http-backend, o
 * mesmo CGI que servidores git usam) atrás de um endereço que só aceita o token certo como senha, e a API REST com as
 * rotas que as ações de código chamam (repositório, pull/merge request, merge, apagar ramo, Actions/pipeline, apagar).
 * Um só servidor: /git/<dono>/<repo>.git/... faz o papel de github.com (ou do host do GitLab) e /api/... o de
 * api.github.com (ou /api/v4). `redirecionar` monta o fetch que troca os endereços de verdade por este.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface PullFalso { number: number; title: string; head: string; base: string; body: string; merged: boolean; draft?: boolean }
export interface GitFalso {
  porta: number; raiz: string; token: string;
  pulls: PullFalso[];
  chamadas: Array<{ method: string; path: string; auth: string | null; body: any }>;
  /** pedidos ao git (o caminho e o cabeçalho de acesso): o teste confere que só o token guardado chega aqui */
  git: Array<{ path: string; auth: string | null }>;
  apagados: string[];
  criarRepo(nome: string, arquivos: Record<string, string>, principal?: string): void;
  /** o conteúdo de um arquivo num ramo do repositório nu (para conferir o que o agente enviou) */
  mostrar(nome: string, ref: string, arquivo: string): string | null;
  ramos(nome: string): string[];
  fechar(): Promise<void>;
}

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Teste', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'Teste', GIT_COMMITTER_EMAIL: 't@x' } }).toString();

export async function gitFalso(raiz: string, token: string, o: { tipo?: 'github' | 'gitlab' } = {}): Promise<GitFalso> {
  const tipo = o.tipo ?? 'github';
  fs.mkdirSync(raiz, { recursive: true });
  const estado = { pulls: [] as PullFalso[], chamadas: [] as GitFalso['chamadas'], git: [] as GitFalso['git'], apagados: [] as string[] };
  const principais = new Map<string, string>();
  const json = (res: http.ServerResponse, v: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const autorizado = (h: string | undefined) => {
    if (!h) return false;
    if (tipo === 'gitlab' && h === token) return true; // PRIVATE-TOKEN
    const b = /^Basic (.+)$/.exec(h); if (b) return Buffer.from(b[1], 'base64').toString().split(':').slice(1).join(':') === token;
    return h === `Bearer ${token}`;
  };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const corpo = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname.startsWith('/git/')) {
        const auth = (req.headers.authorization as string | undefined) ?? null;
        estado.git.push({ path: u.pathname, auth });
        if (!autorizado(auth ?? undefined)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="falso"' }); res.end('sem acesso'); return; }
        const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: raiz, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: u.pathname.slice(4),
          QUERY_STRING: u.search.slice(1), CONTENT_TYPE: String(req.headers['content-type'] ?? ''), CONTENT_LENGTH: String(corpo.length), REMOTE_USER: 'ergon', REMOTE_ADDR: '127.0.0.1',
          HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''), HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? '') } });
        const saida: Buffer[] = [];
        cgi.stdout.on('data', (c) => saida.push(c));
        cgi.stdin.end(corpo);
        cgi.on('close', () => {
          const tudo = Buffer.concat(saida);
          const fim = tudo.indexOf('\r\n\r\n') >= 0 ? tudo.indexOf('\r\n\r\n') : tudo.indexOf('\n\n');
          const sep = tudo.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
          const cab: Record<string, string> = {}; let status = 200;
          for (const l of tudo.subarray(0, fim).toString().split(/\r?\n/)) { const i = l.indexOf(':'); if (i < 0) continue; const k = l.slice(0, i).trim(); const v = l.slice(i + 1).trim(); if (/^status$/i.test(k)) status = parseInt(v, 10); else cab[k] = v; }
          res.writeHead(status, cab); res.end(tudo.subarray(fim + sep));
        });
        return;
      }
      const auth = (req.headers.authorization ?? req.headers['private-token'] ?? null) as string | null;
      let body: any = null; try { body = corpo.length ? JSON.parse(corpo.toString()) : null; } catch { body = corpo.toString(); }
      const p = u.pathname.replace(/^\/api(\/v4)?/, '');
      estado.chamadas.push({ method: req.method ?? 'GET', path: p, auth, body });
      if (!autorizado(auth ?? undefined)) return json(res, { message: 'Bad credentials' }, 401);
      const repoDe = (s: string) => decodeURIComponent(s);
      let m: RegExpExecArray | null;
      if (tipo === 'github') {
        if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
          const nome = m[1];
          if (!fs.existsSync(path.join(raiz, `${nome}.git`))) return json(res, { message: 'Not Found' }, 404);
          if (req.method === 'DELETE') { estado.apagados.push(nome); res.writeHead(204); res.end(); return; }
          return json(res, { full_name: nome, default_branch: principais.get(nome) ?? 'main', html_url: `https://github.com/${nome}`, permissions: { push: true, admin: false } });
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(p)) && req.method === 'POST') {
          const n = estado.pulls.length + 1;
          estado.pulls.push({ number: n, title: body.title, head: body.head, base: body.base, body: body.body, merged: false, draft: body.draft });
          return json(res, { number: n, html_url: `https://github.com/${m[1]}/pull/${n}` }, 201);
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p))) { const pr = estado.pulls[Number(m[2]) - 1]; return pr ? json(res, { number: pr.number, title: pr.title, head: { ref: pr.head }, base: { ref: pr.base } }) : json(res, { message: 'Not Found' }, 404); }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(p)) && req.method === 'PUT') { const pr = estado.pulls[Number(m[2]) - 1]; if (pr) pr.merged = true; return json(res, { merged: true, sha: 'abc123def4567890' }); }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method === 'DELETE') { sh(path.join(raiz, `${m[1]}.git`), 'update-ref', '-d', `refs/heads/${m[2]}`); res.writeHead(204); res.end(); return; }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p)) && req.method === 'POST') { res.writeHead(204); res.end(); return; }
      } else {
        if ((m = /^\/projects\/([^/]+)$/.exec(p))) {
          const nome = repoDe(m[1]);
          if (!fs.existsSync(path.join(raiz, `${nome}.git`))) return json(res, { message: '404 Project Not Found' }, 404);
          if (req.method === 'DELETE') { estado.apagados.push(nome); return json(res, { message: '202 Accepted' }, 202); }
          return json(res, { path_with_namespace: nome, default_branch: principais.get(nome) ?? 'main', web_url: `https://gitlab.com/${nome}`, permissions: { project_access: { access_level: 40 } } });
        }
        if ((m = /^\/projects\/([^/]+)\/merge_requests$/.exec(p)) && req.method === 'POST') {
          const n = estado.pulls.length + 1;
          estado.pulls.push({ number: n, title: body.title, head: body.source_branch, base: body.target_branch, body: body.description, merged: false });
          return json(res, { iid: n, web_url: `https://gitlab.com/${repoDe(m[1])}/-/merge_requests/${n}` }, 201);
        }
      }
      return json(res, { message: `rota falsa desconhecida: ${req.method} ${p}` }, 404);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const porta = (srv.address() as AddressInfo).port;
  return {
    porta, raiz, token, ...estado,
    criarRepo(nome, arquivos, principal = 'main') {
      const nu = path.join(raiz, `${nome}.git`);
      fs.mkdirSync(path.dirname(nu), { recursive: true });
      const trab = fs.mkdtempSync(path.join(raiz, '.trab-'));
      sh(trab, 'init', '-q', '-b', principal);
      for (const [f, c] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(path.join(trab, f)), { recursive: true }); fs.writeFileSync(path.join(trab, f), c); }
      sh(trab, 'add', '-A'); sh(trab, 'commit', '-q', '-m', 'início');
      sh(raiz, 'clone', '-q', '--bare', trab, nu);
      sh(nu, 'config', 'http.receivepack', 'true');
      fs.rmSync(trab, { recursive: true, force: true });
      principais.set(nome, principal);
    },
    mostrar(nome, ref, arquivo) { try { return sh(path.join(raiz, `${nome}.git`), 'show', `${ref}:${arquivo}`); } catch { return null; } },
    ramos(nome) { return sh(path.join(raiz, `${nome}.git`), 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean); },
    fechar: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** O fetch que manda github.com (git) e api.github.com (API) — ou o GitLab — ao servidor falso; o resto segue para `antes`. */
export function redirecionar(f: Pick<GitFalso, 'porta'>, antes: typeof fetch, o: { gitHost?: string; apiHost?: string; apiPrefixo?: string } = {}): typeof fetch {
  const gitHost = o.gitHost ?? 'github.com'; const apiHost = o.apiHost ?? 'api.github.com';
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.host === apiHost && (apiHost !== gitHost || u.pathname.startsWith(o.apiPrefixo ?? '/api/'))) return antes(`http://127.0.0.1:${f.porta}/api${apiHost === gitHost ? u.pathname.replace(/^\/api/, '') : u.pathname}${u.search}`, init);
    if (u.host === gitHost) return antes(`http://127.0.0.1:${f.porta}/git${u.pathname}${u.search}`, init);
    return antes(input, init);
  }) as typeof fetch;
}

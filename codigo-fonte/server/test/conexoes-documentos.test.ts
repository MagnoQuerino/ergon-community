// Conectores de documentos e código (sem rede): Confluence, GitLab, GitHub e Notion. Confere método, endereço, cabeçalho, corpo e desarme do texto.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { CONFLUENCE } from '../src/services/conexoes/conectores/confluence.ts';
import { GITHUB_EXTRAS } from '../src/services/conexoes/conectores/extras-github.ts';
import { NOTION_EXTRAS } from '../src/services/conexoes/conectores/extras-notion.ts';
import { GITLAB } from '../src/services/conexoes/conectores/gitlab.ts';
import { acaoDe, conferirConector, httpDoConector, type ConectorDef } from '../src/services/conexoes/conectores/declarativo.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { ErroAcao } from '../src/services/conexoes/tipos.ts';
import { harness, setupOwner } from './helpers.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
afterEach(() => { calls.length = 0; answer = () => ({}); });

const acaoEm = (def: ConectorDef) => (id: string) => acaoDe(def.acoes.find((a) => a.id === id)!);
const ctxDe = (def: ConectorDef, creds: Record<string, string>) => ({ workspaceId: 'ws', tz: 'UTC', http: httpDoConector(def, creds) });
const recusaSemChamar = async (p: () => Promise<unknown>, msg: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof ErroAcao && msg.test(e.message));
  assert.equal(calls.length, 0, 'nada foi ao serviço');
};
const proibido = (texto: string) => new Response(JSON.stringify({ message: texto }), { status: 403 });

describe('definições', () => {
  const DEFS = [CONFLUENCE, GITLAB, GITHUB_EXTRAS, NOTION_EXTRAS];
  test('kind, grupo, ajuda e ações no contrato', () => {
    assert.deepEqual(DEFS.map((d) => d.kind), ['confluence', 'gitlab', 'github', 'notion']);
    for (const d of DEFS) {
      assert.match(d.kind, /^[a-z]{3,20}$/); assert.equal(d.grupo, 'documentos');
      assert.match(d.ajuda.url, /^https:\/\//); assert.ok(d.ajuda.passos.length > 40); assert.ok(d.sobre.length > 40);
      const ids = d.acoes.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length, 'ids únicos');
      for (const a of d.acoes) {
        assert.ok(a.id.startsWith(`${d.kind}.`), a.id);
        assert.ok(['ler', 'organizar', 'enviar', 'apagar'].includes(typeof a.risco === 'function' ? a.risco({}) : a.risco), a.id);
      }
    }
    assert.deepEqual(GITHUB_EXTRAS.campos, []); assert.deepEqual(NOTION_EXTRAS.campos, []);
  });
  test('o risco certo em cada ação', () => {
    const risco = (d: ConectorDef, id: string) => { const r = d.acoes.find((a) => a.id === id)!.risco; return typeof r === 'function' ? r({}) : r; };
    const esperado: Array<[ConectorDef, string, string]> = [
      [CONFLUENCE, 'confluence.espacos', 'ler'], [CONFLUENCE, 'confluence.buscar', 'ler'], [CONFLUENCE, 'confluence.ler_pagina', 'ler'], [CONFLUENCE, 'confluence.comentarios', 'ler'],
      [CONFLUENCE, 'confluence.criar_pagina', 'enviar'], [CONFLUENCE, 'confluence.atualizar_pagina', 'enviar'], [CONFLUENCE, 'confluence.comentar', 'enviar'],
      [GITLAB, 'gitlab.projetos', 'ler'], [GITLAB, 'gitlab.buscar', 'ler'], [GITLAB, 'gitlab.issues', 'ler'], [GITLAB, 'gitlab.ler_issue', 'ler'], [GITLAB, 'gitlab.comentarios_issue', 'ler'],
      [GITLAB, 'gitlab.merge_requests', 'ler'], [GITLAB, 'gitlab.ler_merge_request', 'ler'], [GITLAB, 'gitlab.comentarios_merge_request', 'ler'],
      [GITLAB, 'gitlab.criar_issue', 'enviar'], [GITLAB, 'gitlab.comentar_issue', 'enviar'], [GITLAB, 'gitlab.comentar_merge_request', 'enviar'],
      [GITHUB_EXTRAS, 'github.repositorios', 'ler'], [GITHUB_EXTRAS, 'github.buscar', 'ler'], [GITHUB_EXTRAS, 'github.issues', 'ler'], [GITHUB_EXTRAS, 'github.ler_issue', 'ler'], [GITHUB_EXTRAS, 'github.comentarios', 'ler'],
      [GITHUB_EXTRAS, 'github.pull_requests', 'ler'], [GITHUB_EXTRAS, 'github.ler_pull_request', 'ler'], [GITHUB_EXTRAS, 'github.criar_issue', 'enviar'], [GITHUB_EXTRAS, 'github.comentar', 'enviar'],
      [GITHUB_EXTRAS, 'github.fechar_issue', 'enviar'], [GITHUB_EXTRAS, 'github.reabrir_issue', 'enviar'],
      [NOTION_EXTRAS, 'notion.buscar', 'ler'], [NOTION_EXTRAS, 'notion.ler', 'ler'], [NOTION_EXTRAS, 'notion.criar_pagina', 'enviar'], [NOTION_EXTRAS, 'notion.acrescentar', 'enviar'],
    ];
    for (const [d, id, r] of esperado) assert.equal(risco(d, id), r, id);
    assert.equal(esperado.length, DEFS.reduce((n, d) => n + d.acoes.length, 0), 'toda ação conferida');
  });
  test('quem lê não promete o texto inteiro: textos longos vêm cortados', () => {
    for (const id of ['confluence.ler_pagina', 'gitlab.ler_issue', 'gitlab.ler_merge_request', 'github.ler_issue', 'github.ler_pull_request']) {
      const d = DEFS.flatMap((x) => x.acoes).find((a) => a.id === id)!;
      assert.ok(!/inteir/i.test(d.descricao), id);
      assert.match(d.descricao, /cortad/, id);
    }
  });
});

describe('GitLab', () => {
  const creds = { site: '', token: 'tok-gitlab-de-teste' };
  const ctx = ctxDe(GITLAB, creds);
  const acao = acaoEm(GITLAB);

  test('sem endereço usa gitlab.com; confere a conta com o cabeçalho do token', async () => {
    answer = () => ({ username: 'ana', name: 'Ana Souza' });
    assert.equal(await conferirConector(GITLAB, creds), 'Ana Souza');
    assert.equal(calls[0].url.href, 'https://gitlab.com/api/v4/user'); assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'tok-gitlab-de-teste');
  });
  test('o endereço é opcional: em branco, ou sem o campo, usa gitlab.com', async () => {
    assert.equal(GITLAB.campos.find((c) => c.name === 'site')!.opcional, true);
    assert.ok(!GITLAB.campos.find((c) => c.name === 'token')!.opcional, 'o token continua obrigatório');
    answer = () => ({ username: 'ana' });
    assert.equal(await conferirConector(GITLAB, { token: 'x' }), 'ana');
    assert.equal(calls[0].url.href, 'https://gitlab.com/api/v4/user');
    await conferirConector(GITLAB, { site: '', token: 'x' });
    assert.equal(calls[1].url.href, 'https://gitlab.com/api/v4/user');
  });
  test('conectar de verdade: sem o endereço vai a gitlab.com e guarda só o token; com ele, vai à instalação; sem o token, recusa', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const token = 'glpat-token-de-teste-123';
      answer = () => ({ username: 'ana', name: 'Ana Souza' });
      assert.equal(await h.integrations.connectToken(s.workspaceId, s.userId, 'gitlab', { site: '   ', token }), 'Ana Souza');
      assert.equal(calls.at(-1)!.url.href, 'https://gitlab.com/api/v4/user');
      assert.deepEqual(h.integrations.secrets.readOwn(s.workspaceId, 'gitlab'), { token });
      await h.integrations.connectToken(s.workspaceId, s.userId, 'gitlab', { site: 'git.empresa.com', token });
      assert.equal(calls.at(-1)!.url.href, 'https://git.empresa.com/api/v4/user');
      await assert.rejects(() => h.integrations.connectToken(s.workspaceId, s.userId, 'gitlab', { site: 'git.internal', token }), /endereço interno/);
      await assert.rejects(() => h.integrations.connectToken(s.workspaceId, s.userId, 'gitlab', { site: 'git.empresa.com' }), /preencha: Token pessoal/);
      assert.equal(h.integrations.list(s.workspaceId).find((i) => i.kind === 'gitlab')!.fields.find((f) => f.name === 'site')!.opcional, true, 'a tela sabe que pode ficar em branco');
    } finally { await h.close(); }
  });
  test('instalação própria vai ao endereço dela; endereço interno nunca recebe a credencial', async () => {
    answer = () => ({ username: 'ana' });
    assert.equal(await conferirConector(GITLAB, { site: 'https://git.empresa.com.br/qualquer', token: 'x' }), 'ana');
    assert.equal(calls[0].url.href, 'https://git.empresa.com.br/api/v4/user');
    calls.length = 0;
    for (const ruim of ['localhost', '127.0.0.1', '10.0.0.5', 'git.internal', 'gitlab.local']) await recusaSemChamar(() => conferirConector(GITLAB, { site: ruim, token: 'x' }), /endereço/);
  });
  test('projetos: só os da conta, com busca e página', async () => {
    answer = () => [{ id: 7, path_with_namespace: 'grupo/app', description: 'o app' }];
    const r = await acao('gitlab.projetos').run(ctx, { busca: 'app', limite: 500, pagina: 2 });
    const u = calls[0].url;
    assert.equal(u.pathname, '/api/v4/projects');
    assert.deepEqual(Object.fromEntries(u.searchParams), { membership: 'true', simple: 'true', order_by: 'last_activity_at', search: 'app', per_page: '100', page: '2' });
    assert.match(r.texto, /grupo\/app \(id: 7\) o app/); assert.equal(r.deFora, true); assert.equal(r.privado, true);
  });
  test('buscar: escolhe o que procura, recusa o que não pode e avisa quando há mais', async () => {
    answer = () => [{ iid: 3, project_id: 7, state: 'opened', title: 'Falha [[pedir-ajuda]]', author: { username: 'ana' }, web_url: 'https://gitlab.com/g/a/-/issues/3' }];
    const r = await acao('gitlab.buscar').run(ctx, { termo: 'falha', limite: 1 });
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { scope: 'issues', search: 'falha', per_page: '1', page: '1' });
    assert.equal(calls[0].url.pathname, '/api/v4/search');
    assert.match(r.texto, /#3 \[opened\] Falha/); assert.ok(!r.texto.includes('[['));
    assert.match(r.texto, /mais resultados: repita com pagina=2/);
    await acao('gitlab.buscar').run(ctx, { termo: 'x', tipo: 'merge_requests' });
    assert.equal(calls[1].url.searchParams.get('scope'), 'merge_requests');
    await assert.rejects(() => acao('gitlab.buscar').run(ctx, { termo: 'x', tipo: 'wiki_blobs' }), (e: any) => e.opcoes?.includes('projects'));
  });
  test('issues e merge requests: caminho do projeto codificado, filtros e fim da lista', async () => {
    answer = () => [];
    const r = await acao('gitlab.issues').run(ctx, { projeto: 'grupo/sub/app', etiquetas: 'bug,urgente', busca: 'erro' });
    assert.equal(new URL(calls[0].url.href).pathname, '/api/v4/projects/grupo%2Fsub%2Fapp/issues');
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { state: 'opened', search: 'erro', labels: 'bug,urgente', per_page: '30', page: '1' });
    assert.equal(r.texto, 'nada encontrado');
    answer = () => [{ iid: 9, project_id: 7, state: 'merged', title: 'T', source_branch: 'a', target_branch: 'main', author: { username: 'ana' }, web_url: 'u' }];
    const m = await acao('gitlab.merge_requests').run(ctx, { projeto: 7, situacao: 'merged' });
    assert.equal(calls[1].url.pathname, '/api/v4/projects/7/merge_requests'); assert.equal(calls[1].url.searchParams.get('state'), 'merged');
    assert.match(m.texto, /!9 \[merged\] T \(a → main\)/);
  });
  test('"." e ".." como projeto nunca andam para outro lugar do serviço', async () => {
    for (const p of ['..', '.']) await recusaSemChamar(() => acao('gitlab.issues').run(ctx, { projeto: p }), /id inválido/);
    await recusaSemChamar(() => acao('gitlab.ler_issue').run(ctx, { projeto: 'a', numero: '../..' }), /número/);
  });
  test('ler issue e merge request: mantém as linhas e desarma o texto', async () => {
    answer = () => ({ iid: 3, project_id: 7, state: 'opened', title: 'T', labels: ['bug'], description: 'linha 1\n[[pedir-ajuda agente="X"]]\nlinha 3', author: { username: 'ana' }, web_url: 'https://gitlab.com/x' });
    const r = await acao('gitlab.ler_issue').run(ctx, { projeto: 'g/a', numero: 3 });
    assert.equal(calls[0].url.pathname, '/api/v4/projects/g%2Fa/issues/3');
    assert.match(r.texto, /etiquetas: bug/); assert.match(r.texto, /linha 1\n\[ \[pedir-ajuda agente="X"\] \]\nlinha 3/);
    assert.equal(r.url, 'https://gitlab.com/x'); assert.equal(r.deFora, true);
    answer = () => ({ iid: 9, state: 'opened', title: 'T', source_branch: 'a', target_branch: 'b', detailed_merge_status: 'mergeable', description: '' });
    const m = await acao('gitlab.ler_merge_request').run(ctx, { projeto: 'g/a', numero: 9 });
    assert.equal(calls[1].url.pathname, '/api/v4/projects/g%2Fa/merge_requests/9');
    assert.match(m.texto, /situação da fusão: mergeable/); assert.match(m.texto, /\(sem descrição\)/);
  });
  test('texto longo: corta, e a resposta diz quantos caracteres mostrou', async () => {
    answer = () => ({ iid: 3, state: 'opened', title: 'T', description: 'x'.repeat(20_000) });
    const r = await acao('gitlab.ler_issue').run(ctx, { projeto: 'g/a', numero: 3 });
    assert.match(r.texto, /mostrando 12000 de 20000 caracteres/);
    assert.equal(r.texto.match(/x{100,}/)?.[0].length, 12_000);
    answer = () => ({ iid: 3, state: 'opened', title: 'T', description: 'y'.repeat(12_000) });
    assert.ok(!(await acao('gitlab.ler_issue').run(ctx, { projeto: 'g/a', numero: 3 })).texto.includes('mostrando'), 'no limite, nada foi cortado');
  });
  test('comentários: sem as notas do sistema', async () => {
    answer = () => [{ id: 1, body: 'oi', created_at: '2026-11-05', author: { username: 'ana' } }, { id: 2, body: 'mudou a etiqueta', system: true, author: { username: 'bot' } }];
    const r = await acao('gitlab.comentarios_merge_request').run(ctx, { projeto: 'g/a', numero: 9 });
    assert.equal(calls[0].url.pathname, '/api/v4/projects/g%2Fa/merge_requests/9/notes');
    assert.match(r.texto, /ana: oi \(id: 1\)/); assert.ok(!r.texto.includes('mudou a etiqueta'));
    const i = await acao('gitlab.comentarios_issue').run(ctx, { projeto: 'g/a', numero: 3 });
    assert.equal(calls[1].url.pathname, '/api/v4/projects/g%2Fa/issues/3/notes'); assert.equal(calls[1].url.searchParams.get('activity_filter'), 'only_comments');
    assert.match(i.texto, /ana: oi/);
  });
  test('comentar: comando em linha própria não é executado e @ não marca ninguém, mas o resumo mostra o que foi pedido', async () => {
    answer = () => ({ id: 77 });
    const a = acao('gitlab.comentar_merge_request');
    const texto = 'Pronto, aviso @all e @ana.\n/merge\n/close agora\n\r/approve\nCaminho /usr/bin/env e\n/usr/bin/env\nfulano@empresa.com';
    assert.equal(a.resumo({ projeto: 'g/a', numero: 9, texto }), `Comentar no merge request !9 do projeto g/a do GitLab:\n${texto}`);
    const r = await a.run(ctx, { projeto: 'g/a', numero: 9, texto });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/api/v4/projects/g%2Fa/merge_requests/9/notes');
    assert.deepEqual(calls[0].body, { body: 'Pronto, aviso \\@all e \\@ana.\n`/merge`\n`/close agora`\n`/approve`\nCaminho /usr/bin/env e\n/usr/bin/env\nfulano@empresa.com' });
    assert.match(r.texto, /Comentário publicado \(id: 77\)/); assert.equal(r.deFora, undefined);
  });
  test('código fica intacto; contrabarra escrita não rearma a menção', async () => {
    answer = () => ({ id: 1 });
    const a = acao('gitlab.comentar_issue');
    await a.run(ctx, { projeto: 'g/a', numero: 3, texto: 'veja `@types/node` e @ana\n```\n/merge\n@all\n```\n\\@bia \\\\@caio\n/close' });
    assert.equal(calls[0].body.body, 'veja `@types/node` e \\@ana\n```\n/merge\n@all\n```\n\\@bia \\\\\\@caio\n`/close`');
    calls.length = 0;
    // crases que não fecham, e cerca dentro de bloco HTML, não protegem nada: a menção é desarmada do mesmo jeito
    await a.run(ctx, { projeto: 'g/a', numero: 3, texto: '``` @all `' });
    assert.equal(calls[0].body.body, '``` \\@all `');
    calls.length = 0;
    await a.run(ctx, { projeto: 'g/a', numero: 3, texto: '<div>\n```\n@all\n/merge\n```\n</div>' });
    assert.equal(calls[0].body.body, '<div>\n```\n\\@all\n`/merge`\n```\n</div>');
  });
  test('cerca recuada dentro de item de lista não protege a linha sem recuo: no Markdown ela já está fora do código', async () => {
    answer = () => ({ id: 1 });
    const a = acao('gitlab.comentar_merge_request');
    for (const lista of ['- item', '* item', '+ item', '1. item', '2) item']) {
      calls.length = 0;
      await a.run(ctx, { projeto: 'g/a', numero: 9, texto: `${lista}\n  \`\`\`\n/merge\n@all\n` });
      assert.equal(calls[0].body.body, `${lista}\n  \`\`\`\n\`/merge\`\n\\@all\n`, lista);
    }
    calls.length = 0;
    // cerca sem recuo fecha a lista e abre código de verdade: fica intacto, mesmo com lista antes
    await a.run(ctx, { projeto: 'g/a', numero: 9, texto: '- item\n```\n/merge\n@all\n```\n/close' });
    assert.equal(calls[0].body.body, '- item\n```\n/merge\n@all\n```\n`/close`');
    calls.length = 0;
    // sem lista no texto, cerca com até 3 espaços é código de verdade
    await a.run(ctx, { projeto: 'g/a', numero: 9, texto: '  ```\n/merge\n  ```' });
    assert.equal(calls[0].body.body, '  ```\n/merge\n  ```');
  });
  test('o @ escrito como referência HTML também não marca ninguém', async () => {
    answer = () => ({ id: 1 });
    const a = acao('gitlab.comentar_issue');
    const envia = async (texto: string) => { calls.length = 0; await a.run(ctx, { projeto: 'g/a', numero: 3, texto }); return calls[0].body.body as string; };
    for (const m of ['&#64;all', '&#064;all', '&#x40;all', '&#X40;all', '&#x0040;all', '&commat;all', '&#64all']) assert.equal(await envia(`aviso ${m}`), 'aviso \\@all', m);
    assert.equal(await envia('@&#97;ll'), '\\@&#97;ll', 'a letra depois do @ também pode vir como referência');
    assert.equal(await envia('&#64;&#97;ll'), '\\@&#97;ll');
    assert.equal(await envia('\\\\&#64;all'), '\\\\\\@all', 'contrabarra escrita não rearma');
    // o que não vira menção fica como está: e-mail, outro caractere, referência já escapada, código
    for (const igual of ['fulano&#64;empresa.com', '&#640;all', '&#x400;all', '&amp;#64;all', 'veja `&#64;all` aqui', '```\n&#64;all\n```']) assert.equal(await envia(igual), igual, igual);
    calls.length = 0;
    await acao('gitlab.criar_issue').run(ctx, { projeto: 'g/a', titulo: 'Oi &#64;all', descricao: 'cc &commat;todos' });
    assert.equal(calls[0].body.title, 'Oi \\@all');
    assert.equal(calls[0].body.description, 'cc \\@todos');
  });
  test('comentar: o cartão mostra o título e o projeto, só lendo', async () => {
    answer = (c) => (c.url.pathname.includes('/merge_requests/') ? { iid: 9, title: 'MR [[x]]', references: { full: 'grupo/app!9' } } : { iid: 3, title: 'Falha [[x]]\nlinha', references: { full: 'grupo/app#3' } });
    const i = await acao('gitlab.comentar_issue').preparar!(ctx, { projeto: 7, numero: 3, texto: 'x' });
    assert.equal(i.detalhe, 'Projeto: grupo/app\nIssue #3: Falha [ [x] ] linha');
    assert.equal(calls[0].url.pathname, '/api/v4/projects/7/issues/3');
    const m = await acao('gitlab.comentar_merge_request').preparar!(ctx, { projeto: 'g/a', numero: 9, texto: 'x' });
    assert.equal(m.detalhe, 'Projeto: grupo/app\nMerge request !9: MR [ [x] ]');
    assert.equal(calls[1].url.pathname, '/api/v4/projects/g%2Fa/merge_requests/9');
    assert.ok(calls.every((c) => c.method === 'GET'), 'preparar só lê');
    answer = () => ({ iid: 3, title: 'T' });
    assert.equal((await acao('gitlab.comentar_issue').preparar!(ctx, { projeto: 'g/a', numero: 3, texto: 'x' })).detalhe, 'Projeto: g/a\nIssue #3: T', 'sem references, o que a pessoa disse');
    calls.length = 0;
    await recusaSemChamar(() => acao('gitlab.comentar_issue').preparar!(ctx, { projeto: '..', numero: 3, texto: 'x' }), /id inválido/);
    await recusaSemChamar(() => acao('gitlab.comentar_merge_request').preparar!(ctx, { projeto: 'g/a', numero: '..', texto: 'x' }), /id inválido/);
  });
  test('comentar: nota interna é parâmetro e continua sendo enviar', async () => {
    answer = () => ({ id: 1 });
    const a = acao('gitlab.comentar_issue');
    assert.equal(a.risco, 'enviar');
    assert.match(a.resumo({ projeto: 'g/a', numero: 3, texto: 'oi', interna: true }), /nota interna/);
    await a.run(ctx, { projeto: 'g/a', numero: 3, texto: 'oi', interna: 'sim' });
    assert.deepEqual(calls[0].body, { body: 'oi', internal: true });
  });
  test('criar issue: corpo exato, título sem menção, comando desarmado na descrição', async () => {
    answer = () => ({ iid: 12, web_url: 'https://gitlab.com/g/a/-/issues/12' });
    const a = acao('gitlab.criar_issue');
    assert.equal(a.resumo({ projeto: 'g/a', titulo: 'T', descricao: 'd', etiquetas: 'bug' }), 'Criar no projeto g/a do GitLab a issue "T", com as etiquetas bug:\nd');
    const r = await a.run(ctx, { projeto: 'g/a', titulo: 'Olá @all', descricao: 'texto\n/confidential', etiquetas: 'bug,urgente', confidencial: true });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/api/v4/projects/g%2Fa/issues');
    assert.deepEqual(calls[0].body, { title: 'Olá \\@all', description: 'texto\n`/confidential`', labels: 'bug,urgente', confidential: true });
    assert.match(r.texto, /Issue #12 criada/); assert.equal(r.url, 'https://gitlab.com/g/a/-/issues/12');
    calls.length = 0;
    await a.run(ctx, { projeto: 'g/a', titulo: 'Só o título' });
    assert.deepEqual(calls[0].body, { title: 'Só o título' });
  });
  test('quem manda a outras pessoas tem o limite de 5000 caracteres, que cabe no cartão: nunca publica pela metade', async () => {
    for (const [id, base] of [['gitlab.comentar_issue', { projeto: 'g/a', numero: 3, texto: 'x'.repeat(5001) }], ['gitlab.comentar_merge_request', { projeto: 'g/a', numero: 9, texto: 'x'.repeat(5001) }], ['gitlab.criar_issue', { projeto: 'g/a', titulo: 'T', descricao: 'x'.repeat(5001) }]] as const) {
      await recusaSemChamar(() => acao(id).run(ctx, base), /limite é 5000/);
    }
    answer = () => ({ id: 1 });
    await acao('gitlab.comentar_issue').run(ctx, { projeto: 'g/a', numero: 3, texto: 'x'.repeat(5000) });
    assert.equal(calls.length, 1);
  });
  test('título e texto juntos cabem no cartão: título de mais de 500 caracteres é recusado', async () => {
    await recusaSemChamar(() => acao('gitlab.criar_issue').run(ctx, { projeto: 'g/a', titulo: 'x'.repeat(501), descricao: 'd' }), /limite é 500/);
    answer = () => ({ iid: 1 });
    await acao('gitlab.criar_issue').run(ctx, { projeto: 'g/a', titulo: 'x'.repeat(500), descricao: 'd' });
    assert.equal(calls.length, 1);
  });
  test('sem permissão vira erro de acesso; escrita que falha não é repetida', async () => {
    answer = () => proibido('403 Forbidden');
    await assert.rejects(() => acao('gitlab.criar_issue').run(ctx, { projeto: 'g/a', titulo: 'T' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && /403 Forbidden/.test(e.message));
    assert.equal(calls.length, 1);
    calls.length = 0;
    answer = () => new Response('{"message":"500 Internal Server Error"}', { status: 500 });
    await assert.rejects(() => acao('gitlab.comentar_issue').run(ctx, { projeto: 'g/a', numero: 3, texto: 'oi' }), ProviderError);
    assert.equal(calls.length, 1, 'não repete às cegas');
  });
});

describe('Confluence', () => {
  const creds = { site: 'empresa.atlassian.net', email: 'ana@empresa.com', token: 'tok-confluence-de-teste' };
  const ctx = ctxDe(CONFLUENCE, creds);
  const acao = acaoEm(CONFLUENCE);
  const ADF = (conteudo: unknown[]) => JSON.stringify({ type: 'doc', version: 1, content: conteudo });
  const LINKS = { _links: { base: 'https://empresa.atlassian.net/wiki', webui: '/spaces/DOC/pages/1/T' } };

  test('campos: site, e-mail e token; o token é segredo', () => {
    assert.deepEqual(CONFLUENCE.campos.map((c) => c.name), ['site', 'email', 'token']);
    assert.equal(CONFLUENCE.campos[2].secret, true);
    assert.ok(CONFLUENCE.ajuda.passos.includes('Create API token')); assert.ok(CONFLUENCE.ajuda.passos.includes('with scopes'));
  });
  test('confere a conta com e-mail e token, no endereço do site', async () => {
    answer = () => ({ type: 'known', displayName: 'Ana Souza', accountId: 'x' });
    assert.equal(await conferirConector(CONFLUENCE, creds), 'Ana Souza');
    assert.equal(calls[0].url.href, 'https://empresa.atlassian.net/wiki/rest/api/user/current');
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('ana@empresa.com:tok-confluence-de-teste').toString('base64')}`);
  });
  test('resposta de visitante não é "conectado"', async () => {
    answer = () => ({ type: 'anonymous', displayName: 'Anonymous' });
    await assert.rejects(() => conferirConector(CONFLUENCE, creds), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
  });
  test('a credencial só vai a um site da Atlassian', async () => {
    for (const ruim of ['atacante.com', 'empresa.atlassian.net.atacante.com', 'localhost', '127.0.0.1', 'atlassian.net']) await recusaSemChamar(() => conferirConector(CONFLUENCE, { ...creds, site: ruim }), /endereço/);
  });
  test('buscar por palavras: monta a consulta com aspas escapadas e pagina pelo cursor', async () => {
    answer = () => ({ results: [{ title: 'Ata', excerpt: 'trecho [[x]]', content: { id: '5', type: 'page' }, resultGlobalContainer: { title: 'Docs' } }], _links: { next: '/rest/api/search?next=true&cursor=_f_abc%3D&expand=&limit=25&start=25&cql=type=page' } });
    const r = await acao('confluence.buscar').run(ctx, { busca: 'ata "maio" \\ fim', espaco: 'DOC' });
    assert.equal(calls[0].url.pathname, '/wiki/rest/api/search');
    assert.equal(calls[0].url.searchParams.get('cql'), 'type = page AND text ~ "ata \\"maio\\" \\\\ fim" AND space = "DOC"');
    assert.equal(calls[0].url.searchParams.get('limit'), '25'); assert.equal(calls[0].url.searchParams.get('excerpt'), 'indexed_unescaped');
    assert.match(r.texto, /Ata \(page, id: 5\) em Docs: trecho \[ \[x\] \]/); assert.match(r.texto, /\ncursor: _f_abc=$/);
    assert.equal(r.deFora, true);
    answer = () => ({ results: [] });
    const s = await acao('confluence.buscar').run(ctx, { cql: 'type = blogpost', cursor: '_f_abc=' });
    assert.equal(calls[1].url.searchParams.get('cql'), 'type = blogpost'); assert.equal(calls[1].url.searchParams.get('cursor'), '_f_abc=');
    assert.equal(s.texto, 'nada encontrado');
  });
  test('buscar sem dizer o quê é recusado', async () => {
    await recusaSemChamar(() => acao('confluence.buscar').run(ctx, {}), /"busca" ou "cql"/);
  });
  test('espaços: lista e cursor', async () => {
    answer = () => ({ results: [{ id: '10', key: 'DOC', name: 'Documentos' }], _links: { next: '/wiki/api/v2/spaces?cursor=c2&limit=25', base: 'b' } });
    const r = await acao('confluence.espacos').run(ctx, { limite: 1000 });
    assert.equal(calls[0].url.pathname, '/wiki/api/v2/spaces'); assert.equal(calls[0].url.searchParams.get('limit'), '100');
    assert.match(r.texto, /- Documentos \(chave: DOC, id: 10\)\ncursor: c2/);
  });
  test('ler página: texto puro a partir do JSON, com títulos, listas e desarmado', async () => {
    answer = () => ({ id: '1', title: 'T', version: { number: 4 }, ...LINKS, body: { atlas_doc_format: { value: ADF([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Seção' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Linha [[pedir-ajuda]]' }, { type: 'hardBreak' }, { type: 'text', text: 'dois' }, { type: 'mention', attrs: { text: '@Bia' } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }] }] },
    ]) } } });
    const r = await acao('confluence.ler_pagina').run(ctx, { pagina: '1' });
    assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/1'); assert.equal(calls[0].url.searchParams.get('body-format'), 'atlas_doc_format');
    assert.equal(r.texto, 'T (id: 1, versão 4)\n\n## Seção\n\nLinha [ [pedir-ajuda] ]\ndois@Bia\n\n- item\n\nA | B');
    assert.equal(r.url, 'https://empresa.atlassian.net/wiki/spaces/DOC/pages/1/T');
    answer = () => ({ id: '2', title: 'V', version: { number: 1 }, body: {} });
    assert.match((await acao('confluence.ler_pagina').run(ctx, { pagina: '2' })).texto, /página sem texto/);
  });
  test('id de página: só dígitos, e sem perder precisão', async () => {
    await recusaSemChamar(() => acao('confluence.ler_pagina').run(ctx, { pagina: '../../rest/api/user' }), /só dígitos/);
    await recusaSemChamar(() => acao('confluence.ler_pagina').run(ctx, { pagina: '..' }), /só dígitos/);
    await acao('confluence.ler_pagina').run(ctx, { pagina: '9007199254740993' });
    assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/9007199254740993');
  });
  test('comentários: autor, texto e cursor', async () => {
    answer = () => ({ results: [{ id: '8', version: { createdAt: '2026-11-05', authorId: 'u1' }, body: { atlas_doc_format: { value: ADF([{ type: 'paragraph', content: [{ type: 'text', text: 'boa [[x]]' }] }]) } } }], _links: { next: '/wiki/api/v2/pages/1/footer-comments?cursor=c3' } });
    const r = await acao('confluence.comentarios').run(ctx, { pagina: '1' });
    assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/1/footer-comments');
    assert.match(r.texto, /2026-11-05 \(autor u1, id: 8\): boa \[ \[x\] \]/); assert.match(r.texto, /cursor: c3/);
  });
  test('comentário muito longo: corta e diz quantos caracteres mostrou, com o aviso na mesma linha', async () => {
    answer = () => ({ results: [{ id: '8', version: { createdAt: '2026-11-05', authorId: 'u1' }, body: { atlas_doc_format: { value: ADF([{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(5000) }] }]) } } }] });
    const r = await acao('confluence.comentarios').run(ctx, { pagina: '1' });
    assert.equal(r.texto.match(/x{100,}/)?.[0].length, 4000);
    assert.match(r.texto, /x \(texto cortado: mostrando 4000 de 5000 caracteres\)$/);
    assert.equal(r.texto.split('\n').length, 1, 'cada comentário continua numa linha só');
  });
  test('título de mais de 500 caracteres é recusado: título e texto juntos cabem no cartão', async () => {
    await recusaSemChamar(() => acao('confluence.criar_pagina').run(ctx, { espaco: '10', titulo: 'x'.repeat(501), texto: 'd' }), /limite é 500/);
    await recusaSemChamar(() => acao('confluence.atualizar_pagina').run(ctx, { pagina: '1', titulo: 'x'.repeat(501) }), /limite é 500/);
  });
  test('criar página: troca a chave do espaço pelo número; texto simples vai escapado', async () => {
    answer = (c) => (c.method === 'GET' ? { results: [{ id: '10', key: 'DOC' }] } : { id: '55', title: 'T', ...LINKS });
    const a = acao('confluence.criar_pagina');
    assert.equal(a.resumo({ espaco: 'DOC', titulo: 'T', texto: 'oi' }), 'Criar no espaço DOC do Confluence a página "T":\noi');
    const r = await a.run(ctx, { espaco: 'DOC', titulo: 'T', texto: 'a < b & c\nsegunda\n\n<ac:link>@all</ac:link>', pai: '77' });
    assert.equal(calls[0].url.pathname, '/wiki/api/v2/spaces'); assert.equal(calls[0].url.searchParams.get('keys'), 'DOC');
    assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].url.pathname, '/wiki/api/v2/pages');
    assert.deepEqual(calls[1].body, { spaceId: '10', status: 'current', title: 'T', parentId: '77', body: { representation: 'storage', value: '<p>a &lt; b &amp; c<br/>segunda</p><p>&lt;ac:link&gt;@all&lt;/ac:link&gt;</p>' } });
    assert.match(r.texto, /Página criada: T \(id: 55\)/); assert.equal(r.url, 'https://empresa.atlassian.net/wiki/spaces/DOC/pages/1/T');
  });
  test('criar página: número do espaço dispensa a consulta; formato storage vai como está', async () => {
    answer = () => ({ id: '55' });
    const d = CONFLUENCE.acoes.find((x) => x.id === 'confluence.criar_pagina')!;
    const marcado = '<p><ac:link><ri:user ri:account-id="u1"/></ac:link></p>';
    await acaoDe(d).run(ctx, { espaco: '10', titulo: 'T', texto: marcado, formato: 'storage' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.body, { representation: 'storage', value: marcado });
  });
  test('criar página: espaço que não existe para antes de escrever', async () => {
    answer = () => ({ results: [] });
    await assert.rejects(() => acao('confluence.criar_pagina').run(ctx, { espaco: 'NAO', titulo: 'T' }), (e: unknown) => e instanceof ErroAcao && /não achei o espaço/.test(e.message));
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  });
  test('atualizar: por padrão acrescenta, com a versão seguinte e o título que já tinha', async () => {
    answer = (c) => (c.method === 'GET' ? { id: '1', title: 'Antigo', version: { number: 4 }, body: { storage: { value: '<p>velho</p><ac:macro/>' } } } : { id: '1', title: 'Antigo', version: { number: 5 }, ...LINKS });
    const a = acao('confluence.atualizar_pagina');
    assert.equal(a.resumo({ pagina: '1', texto: 'novo' }), 'Atualizar a página 1 do Confluence, acrescentando ao fim:\nnovo');
    const r = await a.run(ctx, { pagina: '1', texto: 'novo', nota: 'ajuste' });
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.searchParams.get('body-format'), 'storage');
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].url.pathname, '/wiki/api/v2/pages/1');
    assert.deepEqual(calls[1].body, { id: '1', status: 'current', title: 'Antigo', body: { representation: 'storage', value: '<p>velho</p><ac:macro/><p>novo</p>' }, version: { number: 5, message: 'ajuste' } });
    assert.equal(r.texto, 'Página 1 atualizada (versão 5).', 'o título que a página já tinha não volta ao agente');
  });
  test('atualizar: substituir troca tudo e o resumo avisa; só o título mantém o texto', async () => {
    answer = (c) => (c.method === 'GET' ? { id: '1', title: 'Antigo', version: { number: 4 }, body: { storage: { value: '<p>velho</p>' } } } : { id: '1', version: { number: 5 } });
    const a = acao('confluence.atualizar_pagina');
    assert.match(a.resumo({ pagina: '1', texto: 'novo', modo: 'substituir' }), /trocando todo o texto por:\nnovo/);
    await a.run(ctx, { pagina: '1', texto: 'novo', modo: 'substituir', titulo: 'Novo' });
    assert.deepEqual(calls[1].body, { id: '1', status: 'current', title: 'Novo', body: { representation: 'storage', value: '<p>novo</p>' }, version: { number: 5 } });
    calls.length = 0;
    assert.equal(a.resumo({ pagina: '1', titulo: 'Novo' }), 'Atualizar a página 1 do Confluence, com o novo título "Novo"');
    await a.run(ctx, { pagina: '1', titulo: 'Novo' });
    assert.equal(calls[1].body.body.value, '<p>velho</p>'); assert.equal(calls[1].body.title, 'Novo');
    calls.length = 0;
    await recusaSemChamar(() => a.run(ctx, { pagina: '1' }), /o que muda/);
  });
  test('atualizar: sem saber a versão, não escreve; recusa do serviço (espaço com aprovação) vira erro', async () => {
    answer = () => ({ id: '1', title: 'T' });
    await assert.rejects(() => acao('confluence.atualizar_pagina').run(ctx, { pagina: '1', texto: 'x' }), /versão/);
    assert.equal(calls.length, 1);
    calls.length = 0;
    answer = (c) => (c.method === 'GET' ? { id: '1', title: 'T', version: { number: 4 }, body: { storage: { value: '' } } } : new Response('{"message":"Approval required"}', { status: 409 }));
    await assert.rejects(() => acao('confluence.atualizar_pagina').run(ctx, { pagina: '1', texto: 'x' }), (e: unknown) => e instanceof ProviderError && /409/.test(e.message));
  });
  test('comentar: na página ou respondendo; resumo com o texto inteiro', async () => {
    answer = () => ({ id: '9', ...LINKS });
    const a = acao('confluence.comentar');
    assert.equal(a.risco, 'enviar');
    assert.equal(a.resumo({ pagina: '1', texto: 'oi @all' }), 'Comentar na página 1 do Confluence:\noi @all');
    const r = await a.run(ctx, { pagina: '1', texto: 'oi @all <b>' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/wiki/api/v2/footer-comments');
    assert.deepEqual(calls[0].body, { pageId: '1', body: { representation: 'storage', value: '<p>oi @all &lt;b&gt;</p>' } });
    assert.match(r.texto, /Comentário publicado \(id: 9\)/); assert.equal(r.url, 'https://empresa.atlassian.net/wiki/spaces/DOC/pages/1/T');
    await a.run(ctx, { pagina: '1', texto: 'ok', responder_a: '8' });
    assert.deepEqual(calls[1].body, { parentCommentId: '8', body: { representation: 'storage', value: '<p>ok</p>' } });
  });
  test('comentar: o cartão mostra o título da página, só lendo', async () => {
    answer = () => ({ id: '1', title: 'Ata [[x]]\nde maio' });
    const p = await acao('confluence.comentar').preparar!(ctx, { pagina: '1', texto: 'x' });
    assert.equal(p.detalhe, 'Página: Ata [ [x] ] de maio');
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/1');
    calls.length = 0;
    await recusaSemChamar(() => acao('confluence.comentar').preparar!(ctx, { pagina: '../../x', texto: 'x' }), /só dígitos/);
  });
  test('comentário tem o limite de 5000; página pode ser longa, até o teto do motor, e o cartão pede para abrir o texto inteiro', async () => {
    await recusaSemChamar(() => acao('confluence.comentar').run(ctx, { pagina: '1', texto: 'x'.repeat(5001) }), /limite é 5000/);
    answer = (c) => (c.method === 'GET' ? { results: [{ id: '10' }] } : { id: '55' });
    const a = acao('confluence.criar_pagina');
    await a.run(ctx, { espaco: '10', titulo: 'T', texto: 'x'.repeat(100_000) });
    assert.equal(calls.length, 1);
    calls.length = 0;
    await recusaSemChamar(() => a.run(ctx, { espaco: '10', titulo: 'T', texto: 'x'.repeat(100_001) }), /limite é 100000/);
    assert.match(a.resumo({ espaco: '10', titulo: 'T', texto: 'x'.repeat(5001) }), /página "T" \(5001 caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar\):/);
    assert.ok(!a.resumo({ espaco: '10', titulo: 'T', texto: 'x'.repeat(5000) }).includes('o começo'));
    assert.match(acao('confluence.atualizar_pagina').resumo({ pagina: '1', texto: 'x'.repeat(5001) }), /\(5001 caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar\)/);
  });
  test('sem permissão no espaço vira erro de acesso', async () => {
    answer = () => proibido('Not permitted');
    await assert.rejects(() => acao('confluence.comentar').run(ctx, { pagina: '1', texto: 'oi' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
  });
});

describe('GitHub (extras)', () => {
  const creds = { token: 'tok-github-de-teste' };
  const ctx = ctxDe(GITHUB_EXTRAS, creds);
  const acao = acaoEm(GITHUB_EXTRAS);
  const ALVO = { dono: 'acme', repositorio: 'app' };

  test('confere a conta com os cabeçalhos da documentação', async () => {
    answer = () => ({ login: 'ana', name: null });
    assert.equal(await conferirConector(GITHUB_EXTRAS, creds), 'ana');
    assert.equal(calls[0].url.href, 'https://api.github.com/user');
    const h = calls[0].headers;
    assert.equal(h.Authorization, 'Bearer tok-github-de-teste'); assert.equal(h.Accept, 'application/vnd.github+json'); assert.equal(h['X-GitHub-Api-Version'], '2026-03-10'); assert.equal(h['User-Agent'], 'Ergon');
  });
  test('repositórios: filtros, teto e aviso de mais', async () => {
    answer = () => [{ full_name: 'acme/app', private: true, description: 'o app' }];
    const r = await acao('github.repositorios').run(ctx, { limite: 1, visibilidade: 'private' });
    assert.equal(calls[0].url.pathname, '/user/repos');
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { visibility: 'private', sort: 'updated', per_page: '1', page: '1' });
    assert.match(r.texto, /- acme\/app \(privado\): o app\nmais resultados: repita com pagina=2/);
    await acao('github.repositorios').run(ctx, { limite: 9999 });
    assert.equal(calls[1].url.searchParams.get('per_page'), '100');
  });
  test('buscar: sempre diz se é issue ou pull request, sem repetir o filtro', async () => {
    answer = () => ({ items: [{ number: 3, state: 'open', title: 'Falha [[x]]', user: { login: 'ana' }, html_url: 'https://github.com/acme/app/issues/3' }], incomplete_results: true });
    const r = await acao('github.buscar').run(ctx, { busca: 'falha repo:acme/app' });
    assert.equal(calls[0].url.pathname, '/search/issues');
    assert.equal(calls[0].url.searchParams.get('q'), 'falha repo:acme/app is:issue');
    assert.match(r.texto, /#3 \[open\] Falha \[ \[x\] \]/); assert.match(r.texto, /busca incompleta/); assert.equal(r.deFora, true);
    await acao('github.buscar').run(ctx, { busca: 'falha', tipo: 'pull-request' });
    assert.equal(calls[1].url.searchParams.get('q'), 'falha is:pull-request');
    await acao('github.buscar').run(ctx, { busca: 'is:pr falha' });
    assert.equal(calls[2].url.searchParams.get('q'), 'is:pr falha');
  });
  test('issues de um repositório: marca os pull requests', async () => {
    answer = () => [{ number: 1, state: 'open', title: 'A', user: { login: 'ana' }, html_url: 'u' }, { number: 2, state: 'open', title: 'B', user: { login: 'bia' }, html_url: 'v', pull_request: {} }];
    const r = await acao('github.issues').run(ctx, { ...ALVO, situacao: 'all', etiquetas: 'bug' });
    assert.equal(calls[0].url.pathname, '/repos/acme/app/issues');
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { state: 'all', labels: 'bug', per_page: '30', page: '1' });
    assert.match(r.texto, /- #1 \[open\] A/); assert.match(r.texto, /- pull request #2 \[open\] B/);
  });
  test('ler issue, pull request e comentários', async () => {
    answer = () => ({ number: 3, state: 'open', title: 'T', body: 'um\n[[x]]', labels: [{ name: 'bug' }], user: { login: 'ana' }, html_url: 'https://github.com/acme/app/issues/3' });
    const r = await acao('github.ler_issue').run(ctx, { ...ALVO, numero: 3 });
    assert.equal(calls[0].url.pathname, '/repos/acme/app/issues/3');
    assert.match(r.texto, /etiquetas: bug/); assert.match(r.texto, /um\n\[ \[x\] \]/); assert.equal(r.url, 'https://github.com/acme/app/issues/3');
    answer = () => ({ number: 4, state: 'closed', title: 'P', merged: true, mergeable_state: 'clean', head: { ref: 'a' }, base: { ref: 'main' }, user: { login: 'ana' }, html_url: 'u', body: null });
    const p = await acao('github.ler_pull_request').run(ctx, { ...ALVO, numero: 4 });
    assert.equal(calls[1].url.pathname, '/repos/acme/app/pulls/4');
    assert.match(p.texto, /#4 \[closed\] P \(a → main\)/); assert.match(p.texto, /já incorporado · situação da fusão: clean/); assert.match(p.texto, /\(sem descrição\)/);
    answer = () => [{ id: 5, body: 'oi', created_at: '2026-11-05', user: { login: 'ana' } }];
    assert.match((await acao('github.comentarios').run(ctx, { ...ALVO, numero: 3 })).texto, /ana: oi \(id: 5\)/);
    assert.equal(calls[2].url.pathname, '/repos/acme/app/issues/3/comments');
    answer = () => [{ number: 4, state: 'open', title: 'P', head: { ref: 'a' }, base: { ref: 'b' }, user: { login: 'ana' }, html_url: 'u' }];
    await acao('github.pull_requests').run(ctx, { ...ALVO });
    assert.equal(calls[3].url.pathname, '/repos/acme/app/pulls'); assert.equal(calls[3].url.searchParams.get('state'), 'open');
  });
  test('dono e repositório: só nomes; "." e ".." nunca andam para outro lugar', async () => {
    for (const ruim of ['a/b', '../user', '']) await recusaSemChamar(() => acao('github.issues').run(ctx, { dono: ruim, repositorio: 'app' }), /dono/);
    for (const ruim of ['..', '.']) await recusaSemChamar(() => acao('github.issues').run(ctx, { dono: ruim, repositorio: 'app' }), /id inválido/);
    await recusaSemChamar(() => acao('github.comentar').run(ctx, { dono: 'acme', repositorio: '..', numero: 1, texto: 'x' }), /id inválido/);
    await recusaSemChamar(() => acao('github.ler_issue').run(ctx, { ...ALVO, numero: '..' }), /número/);
  });
  test('criar issue: corpo exato; @ não marca ninguém, e o que está em código ou em e-mail fica', async () => {
    answer = () => ({ number: 12, html_url: 'https://github.com/acme/app/issues/12' });
    const a = acao('github.criar_issue');
    assert.equal(a.resumo({ ...ALVO, titulo: 'T', texto: 'd @ana' }), 'Criar em acme/app no GitHub a issue "T":\nd @ana');
    const r = await a.run(ctx, { ...ALVO, titulo: 'Oi @acme/todos', texto: 'cc @acme/todos e @dependabot merge\nfulano@empresa.com `npm i @types/node`\n```\n@keep\n```', etiquetas: 'bug, urgente' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/repos/acme/app/issues');
    assert.deepEqual(calls[0].body, { title: 'Oi @\u200Bacme/todos', body: 'cc @\u200Bacme/todos e @\u200Bdependabot merge\nfulano@empresa.com `npm i @types/node`\n```\n@keep\n```', labels: ['bug', 'urgente'] });
    assert.match(r.texto, /Issue #12 criada/); assert.equal(r.url, 'https://github.com/acme/app/issues/12'); assert.equal(r.deFora, undefined);
  });
  test('comentar: enviar, com o texto inteiro no resumo e sem acionar ninguém', async () => {
    answer = () => ({ id: 1, html_url: 'https://github.com/acme/app/issues/3#issuecomment-1' });
    const a = acao('github.comentar');
    assert.equal(a.risco, 'enviar');
    assert.equal(a.resumo({ ...ALVO, numero: 3, texto: 'oi @acme/todos' }), 'Comentar em #3 de acme/app no GitHub:\noi @acme/todos');
    const r = await a.run(ctx, { ...ALVO, numero: 3, texto: 'oi @acme/todos\n``` @all `' });
    assert.equal(calls[0].url.pathname, '/repos/acme/app/issues/3/comments');
    assert.deepEqual(calls[0].body, { body: 'oi @\u200Bacme/todos\n``` @\u200Ball `' });
    assert.equal(r.url, 'https://github.com/acme/app/issues/3#issuecomment-1');
    calls.length = 0;
    // a cerca recuada termina junto com o item da lista: a men\u00E7\u00E3o seguinte n\u00E3o \u00E9 c\u00F3digo
    await a.run(ctx, { ...ALVO, numero: 3, texto: '- item\n  ```\n@acme/todos' });
    assert.deepEqual(calls[0].body, { body: '- item\n  ```\n@\u200Bacme/todos' });
  });
  test('o @ escrito como referência HTML também não marca ninguém', async () => {
    answer = () => ({ id: 1, html_url: 'u' });
    const envia = async (texto: string) => { calls.length = 0; await acao('github.comentar').run(ctx, { ...ALVO, numero: 3, texto }); return calls[0].body.body as string; };
    for (const m of ['&#64;acme/todos', '&#064;acme/todos', '&#x40;acme/todos', '&#X40;acme/todos', '&commat;acme/todos']) assert.equal(await envia(`cc ${m}`), 'cc @\u200Bacme/todos', m);
    assert.equal(await envia('&#64dependabot merge'), '@\u200Bdependabot merge');
    assert.equal(await envia('@&#97;ll'), '@\u200B&#97;ll', 'a letra depois do @ também pode vir como referência');
    for (const igual of ['fulano&#64;empresa.com', '&#640;all', '&#x400;all', '&amp;#64;all', 'veja `&#64;all` aqui', '```\n&#64;all\n```']) assert.equal(await envia(igual), igual, igual);
    calls.length = 0;
    await acao('github.criar_issue').run(ctx, { ...ALVO, titulo: 'Oi &commat;todos', texto: 'cc &#x40;todos' });
    assert.equal(calls[0].body.title, 'Oi @\u200Btodos');
    assert.equal(calls[0].body.body, 'cc @\u200Btodos');
  });
  test('comentar e fechar: o cartão mostra o título e o repositório, só lendo', async () => {
    answer = (c) => (c.url.pathname.endsWith('/4') ? { number: 4, title: 'PR [[x]]', pull_request: { url: 'x' } } : { number: 3, title: 'Falha [[x]]\nlinha' });
    const c = await acao('github.comentar').preparar!(ctx, { ...ALVO, numero: 3, texto: 'x' });
    assert.equal(c.detalhe, 'Repositório: acme/app\nIssue #3: Falha [ [x] ] linha');
    assert.equal(calls[0].url.pathname, '/repos/acme/app/issues/3');
    assert.equal((await acao('github.comentar').preparar!(ctx, { ...ALVO, numero: 4, texto: 'x' })).detalhe, 'Repositório: acme/app\nPull request #4: PR [ [x] ]');
    assert.equal((await acao('github.fechar_issue').preparar!(ctx, { ...ALVO, numero: 3 })).detalhe, 'Repositório: acme/app\nIssue #3: Falha [ [x] ] linha');
    assert.ok(calls.every((x) => x.method === 'GET'), 'preparar só lê');
    await assert.rejects(() => acao('github.fechar_issue').preparar!(ctx, { ...ALVO, numero: 4 }), (e: unknown) => e instanceof ErroAcao && /pull request/.test(e.message), 'nem chega ao cartão');
    calls.length = 0;
    await recusaSemChamar(() => acao('github.comentar').preparar!(ctx, { dono: 'a/b', repositorio: 'app', numero: 3, texto: 'x' }), /dono/);
    await recusaSemChamar(() => acao('github.fechar_issue').preparar!(ctx, { ...ALVO, repositorio: '..', numero: 3 }), /id inválido/);
    await recusaSemChamar(() => acao('github.comentar').preparar!(ctx, { ...ALVO, numero: '..', texto: 'x' }), /id inválido/);
  });
  test('quem manda a outras pessoas tem o limite de 5000 caracteres, que cabe no cartão', async () => {
    await recusaSemChamar(() => acao('github.comentar').run(ctx, { ...ALVO, numero: 3, texto: 'x'.repeat(5001) }), /limite é 5000/);
    await recusaSemChamar(() => acao('github.criar_issue').run(ctx, { ...ALVO, titulo: 'T', texto: 'x'.repeat(5001) }), /limite é 5000/);
  });
  test('título e texto juntos cabem no cartão: título de mais de 500 caracteres é recusado', async () => {
    await recusaSemChamar(() => acao('github.criar_issue').run(ctx, { ...ALVO, titulo: 'x'.repeat(501), texto: 'd' }), /limite é 500/);
  });
  test('fechar e reabrir: confere que é issue e manda o motivo', async () => {
    answer = (c) => (c.method === 'GET' ? { number: 3, state: 'open' } : { number: 3, state: 'closed', html_url: 'u' });
    const f = acao('github.fechar_issue');
    assert.equal(f.resumo({ ...ALVO, numero: 3 }), 'Fechar a issue #3 de acme/app no GitHub, como resolvida');
    assert.match((await f.run(ctx, { ...ALVO, numero: 3 })).texto, /Issue #3 fechada/);
    assert.equal(calls[1].method, 'PATCH'); assert.equal(calls[1].url.pathname, '/repos/acme/app/issues/3');
    assert.deepEqual(calls[1].body, { state: 'closed', state_reason: 'completed' });
    calls.length = 0;
    await f.run(ctx, { ...ALVO, numero: 3, motivo: 'not_planned' });
    assert.deepEqual(calls[1].body, { state: 'closed', state_reason: 'not_planned' });
    await assert.rejects(() => f.run(ctx, { ...ALVO, numero: 3, motivo: 'qualquer' }), (e: any) => e.opcoes?.includes('completed'));
    calls.length = 0;
    await acao('github.reabrir_issue').run(ctx, { ...ALVO, numero: 3 });
    assert.deepEqual(calls[1].body, { state: 'open', state_reason: 'reopened' });
  });
  test('fechar não mexe em pull request', async () => {
    answer = () => ({ number: 4, pull_request: { url: 'x' } });
    await assert.rejects(() => acao('github.fechar_issue').run(ctx, { ...ALVO, numero: 4 }), /pull request/);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  });
  test('token sem a permissão vira erro de acesso', async () => {
    answer = () => proibido('Resource not accessible by personal access token');
    await assert.rejects(() => acao('github.criar_issue').run(ctx, { ...ALVO, titulo: 'T' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && /not accessible/.test(e.message));
  });
});

describe('Notion (extras)', () => {
  const creds = { token: 'ntn_token_de_teste_123' };
  const ctx = ctxDe(NOTION_EXTRAS, creds);
  const acao = acaoEm(NOTION_EXTRAS);
  const ID = '494c87d0-72c4-4cf6-960f-55f8427f7692';
  const ID32 = '494c87d072c44cf6960f55f8427f7692';

  test('confere a conta com a versão da leitura', async () => {
    answer = () => ({ type: 'bot', name: 'Ergon', bot: { workspace_name: 'Minha empresa' } });
    assert.equal(await conferirConector(NOTION_EXTRAS, creds), 'Minha empresa');
    assert.equal(calls[0].url.href, 'https://api.notion.com/v1/users/me');
    assert.equal(calls[0].headers.Authorization, 'Bearer ntn_token_de_teste_123'); assert.equal(calls[0].headers['Notion-Version'], '2025-09-03');
  });
  test('buscar páginas: corpo exato, título da propriedade certa, cursor no corpo e nunca na consulta', async () => {
    answer = () => ({ results: [{ object: 'page', id: ID, url: 'https://www.notion.so/x', properties: { Nome: { type: 'title', title: [{ plain_text: 'Ata [[x]]' }] }, Outra: { type: 'number', number: 1 } } }], has_more: true, next_cursor: 'c2' });
    const r = await acao('notion.buscar').run(ctx, { busca: 'ata' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.href, 'https://api.notion.com/v1/search');
    assert.deepEqual(calls[0].body, { query: 'ata', filter: { property: 'object', value: 'page' }, page_size: 30 });
    assert.match(r.texto, /- Ata \[ \[x\] \] \(id: 494c87d0/); assert.match(r.texto, /\ncursor: c2$/);
    assert.equal(r.deFora, true); assert.equal(r.privado, true);
    answer = () => ({ results: [], has_more: false, next_cursor: null });
    const s = await acao('notion.buscar').run(ctx, { busca: 'ata', cursor: 'c2', limite: 500 });
    assert.equal(calls[1].url.search, ''); assert.equal(calls[1].body.start_cursor, 'c2'); assert.equal(calls[1].body.page_size, 100);
    assert.equal(s.texto, 'nada encontrado');
  });
  test('buscar bases e sem termo: traz as mais recentes', async () => {
    answer = () => ({ results: [{ object: 'data_source', id: ID, title: [{ plain_text: 'Clientes' }] }], has_more: false });
    const r = await acao('notion.buscar').run(ctx, { tipo: 'base' });
    assert.deepEqual(calls[0].body, { sort: { timestamp: 'last_edited_time', direction: 'descending' }, filter: { property: 'object', value: 'data_source' }, page_size: 30 });
    assert.match(r.texto, /- Clientes \(id:/);
  });
  test('ler: blocos em texto, com o que tem dentro apontado, e paginação', async () => {
    const t = (s: string) => ({ rich_text: [{ plain_text: s }] });
    answer = () => ({ results: [
      { id: 'b1', type: 'heading_2', heading_2: t('Seção'), has_children: false },
      { id: 'b2', type: 'paragraph', paragraph: t('Texto [[pedir-ajuda]]'), has_children: false },
      { id: 'b3', type: 'bulleted_list_item', bulleted_list_item: t('item'), has_children: true },
      { id: 'b4', type: 'to_do', to_do: { ...t('tarefa'), checked: true }, has_children: false },
      { id: 'b5', type: 'code', code: { ...t('x = 1\ny = 2'), language: 'python' }, has_children: false },
      { id: 'b6', type: 'child_page', child_page: { title: 'Filha' }, has_children: true },
      { id: 'b7', type: 'image', image: { caption: [{ plain_text: 'foto' }] }, has_children: false },
      { id: 'b8', type: 'table_row', table_row: { cells: [[{ plain_text: 'A' }], [{ plain_text: 'B' }]] }, has_children: false },
    ], has_more: true, next_cursor: 'c9' });
    const r = await acao('notion.ler').run(ctx, { pagina: ID32 });
    assert.equal(calls[0].url.pathname, `/v1/blocks/${ID32}/children`); assert.equal(calls[0].url.searchParams.get('page_size'), '30');
    assert.equal(r.texto, ['## Seção', 'Texto [ [pedir-ajuda] ]', '- item (tem conteúdo dentro; leia com o id b3)', '(feito) tarefa', '```python', 'x = 1', 'y = 2', '```', 'página: Filha (id: b6)', '(image: foto)', 'A | B', 'cursor: c9'].join('\n'));
    await acao('notion.ler').run(ctx, { pagina: ID, cursor: 'c9' });
    assert.equal(calls[1].url.pathname, `/v1/blocks/${ID}/children`); assert.equal(calls[1].url.searchParams.get('start_cursor'), 'c9');
  });
  test('aceita o link da página; o que não é id é recusado', async () => {
    answer = () => ({ results: [] });
    await acao('notion.ler').run(ctx, { pagina: `https://www.notion.so/empresa/Minha-pagina-${ID32}?pvs=4` });
    assert.equal(calls[0].url.pathname, `/v1/blocks/${ID32}/children`);
    calls.length = 0;
    for (const ruim of ['..', '../users/me', 'abc', 'https://www.notion.so/empresa/Minha-pagina']) await recusaSemChamar(() => acao('notion.ler').run(ctx, { pagina: ruim }), /id ou o link/);
  });
  test('criar dentro de uma página: corpo exato e endereço da página no recibo', async () => {
    answer = () => ({ id: ID, url: 'https://www.notion.so/nova' });
    const a = acao('notion.criar_pagina');
    assert.equal(a.resumo({ titulo: 'T', pai: ID, texto: 'oi' }), `Criar no Notion a página "T", dentro da página ${ID}:\noi`);
    const r = await a.run(ctx, { titulo: 'T', pai: ID, texto: 'um\nainda um\n\ndois @all' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.href, 'https://api.notion.com/v1/pages');
    const par = (content: string) => ({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } });
    assert.deepEqual(calls[0].body, { parent: { page_id: ID }, properties: { title: { title: [{ type: 'text', text: { content: 'T' } }] } }, children: [par('um\nainda um'), par('dois @all')] });
    assert.equal(r.url, 'https://www.notion.so/nova'); assert.match(r.texto, /Página criada/);
  });
  test('criar numa base: descobre o nome do campo de título', async () => {
    answer = (c) => (c.method === 'GET' ? { id: ID, properties: { Situação: { type: 'status' }, Tarefa: { type: 'title', title: {} } } } : { id: ID, url: 'u' });
    await acao('notion.criar_pagina').run(ctx, { titulo: 'T', base: ID });
    assert.equal(calls[0].url.href, `https://api.notion.com/v1/data_sources/${ID}`);
    assert.deepEqual(calls[1].body, { parent: { type: 'data_source_id', data_source_id: ID }, properties: { Tarefa: { title: [{ type: 'text', text: { content: 'T' } }] } } });
    calls.length = 0;
    answer = () => ({ id: ID, properties: {} });
    await assert.rejects(() => acao('notion.criar_pagina').run(ctx, { titulo: 'T', base: ID }), /campo de título/);
    assert.equal(calls.length, 1, 'não tenta criar');
  });
  test('criar: título longo é recusado, nunca cortado em silêncio: o que vai é o que o cartão mostrou', async () => {
    await recusaSemChamar(() => acao('notion.criar_pagina').run(ctx, { titulo: 'x'.repeat(501), pai: ID }), /limite é 500/);
    answer = () => ({ id: ID, url: 'u' });
    await acao('notion.criar_pagina').run(ctx, { titulo: 'x'.repeat(500), pai: ID });
    assert.equal(calls[0].body.properties.title.title[0].text.content.length, 500);
  });
  test('criar: precisa dizer onde, um lugar só', async () => {
    await recusaSemChamar(() => acao('notion.criar_pagina').run(ctx, { titulo: 'T' }), /um dos dois/);
    await recusaSemChamar(() => acao('notion.criar_pagina').run(ctx, { titulo: 'T', pai: ID, base: ID }), /um dos dois/);
  });
  test('acrescentar: corpo exato, cortado nos 2000 caracteres sem partir emoji', async () => {
    answer = () => ({ results: [{ id: 'n1' }] });
    const a = acao('notion.acrescentar');
    assert.equal(a.resumo({ pagina: ID, texto: 'oi' }), `Acrescentar ao fim da página ${ID} do Notion:\noi`);
    const longo = `${'x'.repeat(1999)}😀${'y'.repeat(100)}`;
    const r = await a.run(ctx, { pagina: ID, texto: longo });
    assert.equal(calls[0].method, 'PATCH'); assert.equal(calls[0].url.href, `https://api.notion.com/v1/blocks/${ID}/children`);
    const pedacos = calls[0].body.children[0].paragraph.rich_text.map((x: any) => x.text.content as string);
    assert.deepEqual(pedacos, ['x'.repeat(1999), `😀${'y'.repeat(100)}`]);
    assert.equal(pedacos.join(''), longo);
    assert.ok(pedacos.every((p: string) => p.length <= 2000));
    assert.equal(r.texto, 'Conteúdo acrescentado: 1 parágrafo.'); assert.equal(r.deFora, undefined);
  });
  test('acrescentar: texto além dos limites é recusado sem escrever nada', async () => {
    await recusaSemChamar(() => acao('notion.acrescentar').run(ctx, { pagina: ID, texto: Array.from({ length: 101 }, (_, i) => `p${i}`).join('\n\n') }), /mais de 100 parágrafos/);
    await recusaSemChamar(() => acao('notion.acrescentar').run(ctx, { pagina: ID, texto: 'x'.repeat(100_001) }), /limite é 100000/);
    await acao('notion.acrescentar').run(ctx, { pagina: ID, texto: Array.from({ length: 100 }, (_, i) => `p${i}`).join('\n\n') });
    assert.equal(calls[0].body.children.length, 100);
  });
  test('acrescentar: o cartão mostra o título da página, só lendo, e avisa quando o texto passa do que ele mostra', async () => {
    answer = () => ({ object: 'page', id: ID, properties: { Nome: { type: 'title', title: [{ plain_text: 'Ata [[x]]' }] } } });
    const a = acao('notion.acrescentar');
    const p = await a.preparar!(ctx, { pagina: `https://www.notion.so/empresa/Ata-${ID32}?pvs=4`, texto: 'x' });
    assert.equal(p.detalhe, 'Página: Ata [ [x] ]');
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.href, `https://api.notion.com/v1/pages/${ID32}`);
    calls.length = 0;
    await recusaSemChamar(() => a.preparar!(ctx, { pagina: '..', texto: 'x' }), /id ou o link/);
    assert.match(a.resumo({ pagina: ID, texto: 'x'.repeat(5001) }), /\(5001 caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar\)/);
    assert.match(acao('notion.criar_pagina').resumo({ titulo: 'T', pai: ID, texto: 'x'.repeat(5001) }), /\(5001 caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar\)/);
  });
  test('ler: página longa corta e diz quantos caracteres mostrou', async () => {
    answer = () => ({ results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'x'.repeat(30_000) }] }, has_children: false }], has_more: false });
    assert.match((await acao('notion.ler').run(ctx, { pagina: ID })).texto, /mostrando 25000 de 30000 caracteres/);
  });
  test('página não compartilhada com a conexão vira erro claro', async () => {
    answer = () => new Response(JSON.stringify({ object: 'error', status: 404, code: 'object_not_found', message: 'Could not find block' }), { status: 404 });
    await assert.rejects(() => acao('notion.ler').run(ctx, { pagina: ID }), (e: unknown) => e instanceof ProviderError && e.kind === 'not_found');
    answer = () => new Response(JSON.stringify({ object: 'error', status: 403, code: 'restricted_resource', message: 'Insufficient permissions for this endpoint.' }), { status: 403 });
    await assert.rejects(() => acao('notion.acrescentar').run(ctx, { pagina: ID, texto: 'x' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && /restricted_resource/.test(e.message));
  });
});

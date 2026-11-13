/**
 * "Baixar meus dados": o ZIP abre e vem legível (decifrado), com os arquivos esperados; nenhum segredo, token ou chave
 * sai; só a própria pessoa baixa (quem administra e as outras pessoas: 403); sem a identidade confirmada há pouco, recusa;
 * nome de arquivo malicioso vira seguro; o teto de tamanho deixa de fora com aviso no LEIA-ME. E a limpeza do cofre da
 * equipe de quem saiu tenta de novo sozinha.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readZip, writeZip, writeZipAsync } from '../src/lib/zip.ts';
import { tentarDeNovo } from '../src/lib/tentar-de-novo.ts';
import { throttle } from '../src/security/factors.ts';
import { SEALED_PREFIX } from '../src/security/fields.ts';
import { SecretStore, setIntegration } from '../src/services/integrations.ts';
import { dosDateTime } from '../src/lib/zip.ts';
import { Caminhos, campoSecreto, exportarMeusDados, linkRelativo, nomeSeguro, pareceSegredo, semSegredos, tirarSegredos } from '../src/services/meus-dados.ts';
import { WorkspaceOwners } from '../src/services/people.ts';
import { setSetting } from '../src/services/sectors.ts';
import { addPerson, allAgents, confirmPhrase, harness, req, setupOwner, type Harness, type Recovery, type Session } from './helpers.ts';

const B = { user: 'bruna', pass: 'senha-bruna-123' };
const SEGREDO = 'ghp_' + 'Zq81'.repeat(9); // com cara de token do GitHub
const SEGREDO_CONFIG = 'valor-secreto-da-rotina-7781';
const MALICIOSO = '..\\..\\..\\CON:evil?<x>|"*.txt';
/** com "#" e parênteses: o link da conversa precisa abrir mesmo assim */
const ANEXO = 'NF #123 (v2).txt';
/** uma instrução de rotina com links compridos: sai igual (nada de "[removido]" no lugar dela) */
const INSTRUCAO = 'Resuma a planilha https://contoso.sharepoint.com/sites/vendas/Documentos-Compartilhados/relatorio-mensal.xlsx e https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit toda semana';

const deps = (h: Harness) => ({ db: h.db, cfg: h.cfg, routines: h.routines, owners: new WorkspaceOwners(h.db) });
const lerZip = (r: { partes(): Generator<Buffer> }) => readZip(Buffer.concat([...r.partes()]));

/** Bruna com conversa (e anexo), tarefa, documento com nome malicioso, rotina, regra, conta conectada e segredos guardados. */
async function cenario(): Promise<{ h: Harness; a: Session; b: Session & { recovery: Recovery }; conv: string; anexo: string; ag: string }> {
  throttle.reset();
  const h = await harness();
  const a = await setupOwner(h);
  const b = await addPerson(h, B.user, B.pass, 'Bruna');
  assert.equal((await req(h, 'POST', '/api/tasks', a, { title: 'Segredo do Alexandre' })).status, 201);
  assert.equal((await req(h, 'POST', '/api/tasks', b, { title: 'Proposta da Bruna', description: 'Mandar até sexta; valor = 1200', dueOn: '2026-11-20' })).status, 201);
  const ag = (await allAgents(h, b))[0];
  const conv = (await req(h, 'POST', '/api/conversations', b, { agentId: ag.id })).json.id as string;
  const up = await req(h, 'POST', '/api/artifacts', b, Buffer.from('conteúdo do anexo da Bruna'), { 'content-type': 'application/octet-stream', 'x-filename': 'anexo.txt', 'x-file-type': 'text/plain', 'x-conversation-id': conv });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const msg = await req(h, 'POST', `/api/conversations/${conv}/messages`, b, { text: 'Olá, segue a planilha da Bruna', clientRequestId: 'req-meus-dados-01', attachments: [up.json.id] });
  assert.ok(msg.status < 300, JSON.stringify(msg.json));
  const doc = await req(h, 'POST', '/api/artifacts', b, Buffer.from('arquivo com nome perigoso'), { 'content-type': 'application/octet-stream', 'x-filename': 'perigo.txt', 'x-file-type': 'text/plain' });
  // nome gravado de propósito como viria de fora (o envio já limpa; aqui é o pior caso)
  h.db.run('UPDATE artifacts SET filename = ? WHERE id = ?', MALICIOSO, doc.json.id);
  h.db.run('UPDATE conversations SET title = ? WHERE id = ?', '../../fora/da pasta', conv);
  // rotina com um campo secreto na configuração, regra aprovada e conta conectada com o acesso guardado
  const rot = await req(h, 'POST', '/api/routines', b, { template: 'briefing-diario', tz: 'America/Sao_Paulo' });
  assert.ok(rot.status < 300, JSON.stringify(rot.json));
  const cfgAtual = JSON.parse(String(h.db.get<{ config: string }>('SELECT config FROM routines WHERE id = ?', rot.json.id)!.config));
  h.db.run('UPDATE routines SET config = ? WHERE id = ?', h.db.seal(b.workspaceId, JSON.stringify({ ...cfgAtual, instruction: INSTRUCAO,
    params: { ...(cfgAtual.params ?? {}), apiKey: SEGREDO_CONFIG, aviso: `Use a chave ${SEGREDO} só aqui`, palavrasChave: ['vendas', 'metas'] } })), rot.json.id);
  // o anexo com "#" e parênteses no nome (gravado como viria de fora)
  h.db.run('UPDATE artifacts SET filename = ? WHERE id = ?', ANEXO, up.json.id);
  h.db.run("INSERT INTO rules (id, workspace_id, text, status, created_at, decided_at) VALUES ('rul_meusdados0001', ?, ?, 'active', ?, ?)", b.workspaceId, h.db.seal(b.workspaceId, 'Responder sempre em português'), new Date().toISOString(), new Date().toISOString());
  new SecretStore(h.cfg.dataDir, () => h.db.fieldCipher).write(b.workspaceId, 'github', { token: SEGREDO, refresh_token: SEGREDO_CONFIG });
  setIntegration(h.db, b.workspaceId, 'github', { state: 'connected', account_label: 'bruna-no-github', settings: { access_token: SEGREDO, client_secret: SEGREDO_CONFIG } });
  return { h, a, b, conv, anexo: up.json.id as string, ag: ag.id as string };
}

const post = (h: Harness, url: string, s: Session | null) => h.app.inject({ method: 'POST', url, headers: { ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}), origin: 'http://localhost:8787', 'content-type': 'application/json' }, payload: '{}' });
const confirmarHaPouco = (h: Harness, s: Session, quando = Date.now()) => h.db.run('UPDATE sessions SET auth_at = ? WHERE user_id = ?', new Date(quando).toISOString(), s.userId);

describe('baixar meus dados', () => {
  test('o ZIP abre, vem legível, com os arquivos esperados, sem segredo nem dado de outra pessoa; fica registrado', async () => {
    const { h, b } = await cenario();
    confirmarHaPouco(h, b);
    const r = await post(h, '/api/me/export', b);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'application/zip');
    assert.match(String(r.headers['content-disposition']), /^attachment; filename="meus-dados-ergon-\d{4}-\d{2}-\d{2}\.zip"$/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const zip = readZip(r.rawPayload);
    const nomes = [...zip.keys()];
    const ler = (n: string) => zip.get(n)!.read().toString('utf8');
    const achar = (re: RegExp) => { const n = nomes.find((x) => re.test(x)); assert.ok(n, `falta ${re} em ${nomes.join(' | ')}`); return n!; };
    assert.equal(nomes[0], 'LEIA-ME.txt', 'o LEIA-ME vem primeiro');
    const leia = ler('LEIA-ME.txt');
    assert.match(leia, /NÃO É CIFRADO/); assert.match(leia, /guarde em lugar seguro/); assert.match(leia, /Versão do Ergon: \d/); assert.match(leia, /Conta: Bruna \(bruna\)/);
    assert.match(leia, /Nada ficou de fora/);
    // conversa em texto, com o agente, a mensagem e o anexo apontando para o documento
    const md = ler(achar(/^Ergon Local\/conversas\/.+\.md$/));
    assert.match(md, /^# /); assert.match(md, /- Agente: /); assert.match(md, /Olá, segue a planilha da Bruna/); assert.match(md, /\*\*Você\*\*/);
    const link = /\[NF #123 \(v2\)\.txt\]\(([^)\s]+)\)/.exec(md);
    assert.ok(link, `o anexo aparece com o caminho:\n${md}`);
    assert.ok(!/[#()]/.test(link[1]), `o "#" e os parênteses vão codificados (senão o link quebra): ${link[1]}`);
    const alvo = `Ergon Local/conversas/${link[1].split('/').map(decodeURIComponent).join('/')}`.split('/').reduce<string[]>((p, s) => (s === '..' ? p.slice(0, -1) : [...p, s]), []).join('/');
    assert.equal(ler(alvo), 'conteúdo do anexo da Bruna', 'o caminho do anexo abre o arquivo certo');
    // tarefas em planilha e JSON
    const csv = ler(achar(/^Ergon Local\/tarefas\/tarefas\.csv$/));
    assert.match(csv.split('\r\n')[0], /Título;Descrição;Situação;Coluna;Quadro;Responsável;Prazo;Criada em/);
    assert.match(csv, /Proposta da Bruna/); assert.match(csv, /2026-11-20/);
    const tarefas = JSON.parse(ler('Ergon Local/tarefas/tarefas.json')) as Array<{ titulo: string; descricao: string; prazo: string; situacao: string }>;
    const t = tarefas.find((x) => x.titulo === 'Proposta da Bruna');
    assert.ok(t); assert.equal(t.descricao, 'Mandar até sexta; valor = 1200'); assert.equal(t.prazo, '2026-11-20'); assert.ok(t.situacao);
    // o resto do workspace
    for (const n of ['Ergon Local/rotinas.json', 'Ergon Local/equipe/equipe.json', 'Ergon Local/equipe/esqueleto-da-equipe.json', 'Ergon Local/regras.json', 'Ergon Local/contas-conectadas.json', 'minha-conta.json']) assert.ok(zip.has(n), `falta ${n}`);
    const equipe = JSON.parse(ler('Ergon Local/equipe/equipe.json'));
    assert.ok(equipe.agentes.length > 0 && equipe.agentes[0].nome && equipe.setores.length > 0, 'agentes e setores legíveis');
    assert.equal(JSON.parse(ler('Ergon Local/equipe/esqueleto-da-equipe.json')).format, 'ergon.blueprint');
    assert.deepEqual(JSON.parse(ler('Ergon Local/regras.json')).regras.map((x: { texto: string }) => x.texto), ['Responder sempre em português']);
    const rotinas = JSON.parse(ler('Ergon Local/rotinas.json'));
    assert.equal(rotinas.length, 1); assert.ok(rotinas[0].nome); assert.equal(rotinas[0].configuracao.params.apiKey, undefined, 'campo secreto da configuração não sai');
    assert.equal(rotinas[0].configuracao.params.aviso, 'Use a chave [removido] só aqui', 'só o trecho com cara de token sai; o resto do texto fica');
    assert.equal(rotinas[0].configuracao.instruction, INSTRUCAO, 'a instrução com links compridos sai igual');
    assert.deepEqual(rotinas[0].configuracao.params.palavrasChave, ['vendas', 'metas'], 'campo comum com "chave" no nome fica');
    const contas = JSON.parse(ler('Ergon Local/contas-conectadas.json'));
    assert.deepEqual(contas.contas, [{ servico: 'github', conta: 'bruna-no-github', situacao: 'conectada' }], 'só o nome da conta');
    const conta = JSON.parse(ler('minha-conta.json'));
    assert.equal(conta.usuario, 'bruna'); assert.equal(conta.password_hash, undefined);
    // nome malicioso vira seguro, sem sair da pasta
    const perigo = achar(/evil/);
    assert.equal(ler(perigo), 'arquivo com nome perigoso');
    assert.notEqual(zip.get(perigo)!.dosDate, 0x21, 'o documento leva a data dele, não 01/01/1980');
    assert.ok(perigo.startsWith('Ergon Local/documentos/'), perigo);
    for (const n of nomes) {
      const partes = n.split('/');
      assert.ok(partes.every((p) => p && p !== '.' && p !== '..' && !/[\\:*?"<>|\u0000-\u001f]/.test(p) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) && !/[. ]$/.test(p)), `nome inseguro: ${n}`);
    }
    // tudo legível, nada cifrado, nenhum segredo, nada do Alexandre
    const tudo = nomes.map((n) => ler(n)).join('\n');
    assert.ok(!tudo.includes(SEALED_PREFIX), 'nada sai cifrado');
    assert.ok(!tudo.includes('[fechado]'), 'nada sai fechado');
    for (const s of [SEGREDO, SEGREDO_CONFIG]) assert.ok(!tudo.includes(s), `o segredo de teste aparece: ${s}`);
    assert.doesNotMatch(tudo, /gh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.|password_hash|totp_secret|scrypt\$|BEGIN [A-Z ]*PRIVATE KEY/, 'padrões de token, hash e chave');
    assert.ok(!tudo.includes('Segredo do Alexandre'), 'nada de outra pessoa');
    // registro na auditoria, sem conteúdo
    const aud = h.db.get<{ result: string; evidence: string }>("SELECT result, evidence FROM audit_events WHERE action = 'people.export' AND actor_id = ?", b.userId);
    assert.ok(aud); assert.match(aud.result, /dados baixados/);
    assert.deepEqual(Object.keys(JSON.parse(aud.evidence)).sort(), ['arquivos', 'bytes', 'deFora']);
    // depois de baixar, a exclusão segue como antes
    assert.equal((await req(h, 'DELETE', '/api/me/account', b, { confirm: B.user })).status, 200);
    await h.close();
  });

  test('só a própria pessoa baixa: pelo id de outra pessoa nada sai; sem sessão, 401', async () => {
    const { h, a, b } = await cenario();
    confirmarHaPouco(h, a); confirmarHaPouco(h, b);
    const adm = await post(h, `/api/people/${b.userId}/export`, a);
    assert.ok(adm.statusCode !== 200 && !adm.rawPayload.includes(Buffer.from('PK')), 'quem administra não baixa os dados da Bruna pelo id');
    assert.equal((await post(h, '/api/me/export', null)).statusCode, 401);
    // o do Alexandre não tem nada da Bruna
    const dele = readZip((await post(h, '/api/me/export', a)).rawPayload);
    const tudo = [...dele.values()].map((e) => e.read().toString('utf8')).join('\n');
    assert.ok(tudo.includes('Segredo do Alexandre')); assert.ok(!tudo.includes('Proposta da Bruna')); assert.ok(!tudo.includes('bruna-no-github'));
    await h.close();
  });

  test('sem a identidade confirmada há pouco, recusa (a tela pede a senha e tenta de novo)', async () => {
    const { h, b } = await cenario();
    confirmarHaPouco(h, b, Date.now() - 3600_000);
    const r = await post(h, '/api/me/export', b);
    assert.equal(r.statusCode, 401); assert.equal(r.json().error, 'reauth');
    assert.equal((await req(h, 'POST', '/api/session/unlock', b, { password: 'errada-123456' })).status, 401);
    assert.equal((await post(h, '/api/me/export', b)).statusCode, 401, 'senha errada não libera');
    assert.equal((await req(h, 'POST', '/api/session/unlock', b, { password: B.pass })).status, 200);
    assert.equal((await post(h, '/api/me/export', b)).statusCode, 200);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'people.export'")!.n, 1, 'só o download que saiu fica registrado');
    await h.close();
  });

  test('com o teto de tamanho, os documentos que passam ficam de fora e o LEIA-ME avisa', async () => {
    const { h, b } = await cenario();
    const r = await exportarMeusDados(deps(h), { id: b.userId, username: B.user, displayName: 'Bruna' }, { maxBytes: 10 });
    const zip = lerZip(r);
    assert.equal(r.deFora.length, 2, JSON.stringify(r.deFora));
    const leia = zip.get('LEIA-ME.txt')!.read().toString('utf8');
    assert.match(leia, /FICARAM DE FORA 2 arquivo\(s\)/); assert.ok(leia.includes(ANEXO)); assert.match(leia, /baixe um a um em Documentos/);
    assert.ok(![...zip.keys()].some((n) => n.includes('/documentos/')), 'nenhum documento entrou');
    const md = [...zip.entries()].find(([n]) => n.endsWith('.md'))![1].read().toString('utf8');
    assert.ok(md.includes(`${ANEXO} (não veio neste download: veja o LEIA-ME)`), 'a conversa avisa o anexo que ficou de fora, com o nome original');
    assert.ok(zip.has('Ergon Local/tarefas/tarefas.csv'), 'o texto sempre vem');
    await h.close();
  });

  test('o texto também tem teto: o que passa fica de fora, com o motivo no LEIA-ME', async () => {
    const { h, b } = await cenario();
    const r = await exportarMeusDados(deps(h), { id: b.userId, username: B.user, displayName: 'Bruna' }, { maxTexto: 50 });
    const zip = lerZip(r);
    assert.ok(r.deFora.length > 0 && r.deFora.every((f) => /de texto deste download/.test(f.motivo)), JSON.stringify(r.deFora));
    assert.ok(zip.has('LEIA-ME.txt') && zip.has('minha-conta.json'), 'o LEIA-ME e o cadastro sempre vêm');
    assert.match(zip.get('LEIA-ME.txt')!.read().toString('utf8'), /de texto deste download/);
    await h.close();
  });

  test('anexo que não é dela: a conversa mostra o nome original e o motivo certo (aqui e no workspace de outra pessoa)', async () => {
    const { h, a, b, anexo } = await cenario();
    // no workspace dela, um anexo que outra pessoa enviou
    h.db.run('UPDATE artifacts SET owner_user_id = ? WHERE id = ?', a.userId, anexo);
    // no workspace do Alexandre, onde ela participa: uma conversa dela com uma entrega que ficou com o dono
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", a.workspaceId, b.userId, new Date().toISOString());
    const agA = (await allAgents(h, a))[0].id as string;
    const entrega = await req(h, 'POST', '/api/artifacts', a, Buffer.from('entrega do agente'), { 'content-type': 'application/octet-stream', 'x-filename': 'resultado-T5.md', 'x-file-type': 'text/markdown' });
    assert.equal(entrega.status, 201);
    const t = new Date().toISOString();
    h.db.run('INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'cnv_meusdados_fora', a.workspaceId, agA, b.userId, h.db.seal(a.workspaceId, 'Pedido da Bruna lá'), 'sess-meus-dados-fora', t);
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES ('msg_meusdados_fora', ?, 'cnv_meusdados_fora', 'agent', ?, 'local', ?)",
      a.workspaceId, h.db.seal(a.workspaceId, 'Pronto, segue a entrega'), t);
    h.db.run("INSERT INTO message_attachments (message_id, artifact_id, workspace_id) VALUES ('msg_meusdados_fora', ?, ?)", entrega.json.id, a.workspaceId);
    const r = await exportarMeusDados(deps(h), { id: b.userId, username: B.user, displayName: 'Bruna' });
    const zip = lerZip(r);
    const mds = [...zip.entries()].filter(([n]) => n.endsWith('.md'));
    const daqui = mds.find(([n]) => n.startsWith('Ergon Local/'))![1].read().toString('utf8');
    assert.ok(daqui.includes(`${ANEXO} (enviado por outra pessoa`), daqui);
    const dela = mds.find(([n]) => n.includes('(de outra pessoa)/conversas/'));
    assert.ok(dela, [...zip.keys()].join(' | '));
    const md = dela[1].read().toString('utf8');
    assert.match(md, /Pronto, segue a entrega/);
    assert.ok(md.includes('resultado-T5.md (fica no workspace de quem é dono; não vem neste download)'), md);
    assert.ok(![...zip.keys()].some((n) => n.includes('resultado-T5')), 'a entrega do dono não vem');
    assert.doesNotMatch(zip.get('LEIA-ME.txt')!.read().toString('utf8'), /FICARAM DE FORA/, 'não é corte de tamanho: o LEIA-ME não lista');
    await h.close();
  });

  test('datas no fuso do workspace, nome do arquivo no mesmo fuso, e cada documento com a data dele', async () => {
    const { h, b, conv, anexo } = await cenario();
    setSetting(h.db, b.workspaceId, 'tz', 'Asia/Tokyo');
    // 01h de 10/11 em UTC = 10h de 10/11 em Tóquio (e 22h de 09/11 em São Paulo)
    const iso = '2026-11-10T01:00:00.000Z';
    h.db.run('UPDATE messages SET created_at = ? WHERE conversation_id = ?', iso, conv);
    h.db.run('UPDATE artifacts SET created_at = ? WHERE id = ?', iso, anexo);
    const r = await exportarMeusDados(deps(h), { id: b.userId, username: B.user, displayName: 'Bruna' }, { agora: new Date('2026-11-09T16:00:00.000Z') });
    assert.equal(r.nome, 'meus-dados-ergon-2026-11-10.zip', 'o dia de Tóquio, não o de UTC');
    const zip = lerZip(r);
    const md = [...zip.entries()].find(([n]) => n.endsWith('.md'))![1].read().toString('utf8');
    assert.match(md, /10\/11\/2026,? 10:00/, md);
    const doc = [...zip.values()].find((e) => e.name.endsWith('.txt') && e.name.includes('/documentos/') && e.read().toString('utf8') === 'conteúdo do anexo da Bruna')!;
    assert.deepEqual([doc.dosDate, doc.dosTime], [dosDateTime(new Date(iso), 'Asia/Tokyo').date, dosDateTime(new Date(iso), 'Asia/Tokyo').time]);
    assert.match(zip.get('LEIA-ME.txt')!.read().toString('utf8'), /Baixado em: 10 de novembro de 2026/);
    await h.close();
  });

  test('a lixeira não se mistura com uma pasta "Lixeira" da pessoa; workspace com nome de arquivo não colide', async () => {
    const { h, b, anexo } = await cenario();
    h.db.run('UPDATE workspaces SET name = ? WHERE id = ?', h.db.seal(b.workspaceId, 'minha-conta.json'), b.workspaceId);
    h.db.run('INSERT INTO folders (id, workspace_id, parent_id, name, created_at) VALUES (?, ?, NULL, ?, ?)', 'fld_meusdados_lixeira', b.workspaceId, h.db.seal(b.workspaceId, 'Lixeira'), new Date().toISOString());
    const outro = await req(h, 'POST', '/api/artifacts', b, Buffer.from('na pasta Lixeira dela'), { 'content-type': 'application/octet-stream', 'x-filename': 'dela.txt', 'x-file-type': 'text/plain' });
    h.db.run('UPDATE artifacts SET folder_id = ? WHERE id = ?', 'fld_meusdados_lixeira', outro.json.id);
    h.db.run('UPDATE artifacts SET deleted_at = ? WHERE id = ?', new Date().toISOString(), anexo);
    const zip = lerZip(await exportarMeusDados(deps(h), { id: b.userId, username: B.user, displayName: 'Bruna' }));
    const nomes = [...zip.keys()];
    assert.ok(zip.has('minha-conta.json'), 'o cadastro fica com o nome dele');
    assert.ok(nomes.some((n) => n === 'minha-conta.json (2)/documentos/Lixeira/dela.txt'), nomes.join(' | '));
    assert.ok(nomes.some((n) => n.startsWith('minha-conta.json (2)/documentos (lixeira)/') && n.endsWith(ANEXO)), nomes.join(' | '));
    // nenhum caminho é ao mesmo tempo arquivo e pasta
    const pastas = new Set(nomes.flatMap((n) => n.split('/').slice(0, -1).map((_, i, p) => p.slice(0, i + 1).join('/').toLowerCase())));
    for (const n of nomes) assert.ok(!pastas.has(n.toLowerCase()), `arquivo e pasta com o mesmo nome: ${n}`);
    await h.close();
  });

  test('poucos arquivos montando ao mesmo tempo na instalação: quem chega depois espera (429)', async () => {
    const { h, a, b } = await cenario();
    await confirmPhrase(h, b, b.recovery);
    const c = await addPerson(h, 'carla', 'senha-carla-123', 'Carla');
    for (const s of [a, b, c]) confirmarHaPouco(h, s);
    const rs = await Promise.all([post(h, '/api/me/export', a), post(h, '/api/me/export', b), post(h, '/api/me/export', c)]);
    const codigos = rs.map((r) => r.statusCode).sort();
    assert.deepEqual(codigos, [200, 200, 429], codigos.join(','));
    const espera = rs.find((r) => r.statusCode === 429)!;
    assert.equal(espera.json().error, 'export_queue'); assert.match(espera.json().message, /tente de novo/i);
    assert.equal((await post(h, '/api/me/export', c)).statusCode, 200, 'depois que os outros desceram, a vaga libera');
    assert.ok(rs.filter((r) => r.statusCode === 200).every((r) => Number(r.headers['content-length']) === r.rawPayload.length), 'o tamanho anunciado é o do arquivo');
    await h.close();
  });
});

describe('baixar meus dados: peças', () => {
  test('nome seguro: sem caminho, sem caracteres proibidos, sem nome reservado, curto', () => {
    assert.equal(nomeSeguro('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(nomeSeguro('..'), 'sem nome');
    assert.equal(nomeSeguro('   . '), 'sem nome');
    assert.equal(nomeSeguro('CON'), '_CON'); assert.equal(nomeSeguro('nul.txt'), '_nul.txt'); assert.equal(nomeSeguro('com1'), '_com1');
    assert.equal(nomeSeguro('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h');
    assert.equal(nomeSeguro('relatório.\u0000\u202e txt.'), 'relatório. txt');
    assert.equal(nomeSeguro('C:\\Windows\\system32'), 'C__Windows_system32');
    const longo = nomeSeguro(`${'x'.repeat(300)}.pdf`);
    assert.ok(longo.length <= 80 && longo.endsWith('.pdf'));
  });

  test('o ZIP montado fora da linha principal abre igual ao de sempre, guardado ou compactado', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const z = readZip(await writeZipAsync([{ name: 'a/texto.txt', data: 'olá '.repeat(500) }, { name: 'foto.png', data: png, store: true }]));
    assert.equal(z.get('a/texto.txt')!.read().toString('utf8'), 'olá '.repeat(500));
    assert.deepEqual(z.get('foto.png')!.read(), png);
    assert.deepEqual(readZip(writeZip([{ name: 'x.txt', data: 'igual' }])).get('x.txt')!.read().toString(), 'igual');
  });

  test('sem segredos: campos secretos saem, valores com cara de credencial viram "[removido]"', () => {
    const v = semSegredos({ nome: 'Rotina', token: 'abc', apiKey: 'x', client_secret: 'y', senha: 'z', aninhado: { refresh_token: 'r', ok: 'fica', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' }, lista: [SEGREDO, 'texto comum'] });
    assert.deepEqual(v, { nome: 'Rotina', aninhado: { ok: 'fica', jwt: '[removido]' }, lista: ['[removido]', 'texto comum'] });
    assert.equal(pareceSegredo('Bearer abcdefghijklmnop1234'), true);
    assert.equal(pareceSegredo('sk-proj-abcdefghijklmnopqrstu'), true);
    assert.equal(pareceSegredo('Relatório semanal de vendas'), false);
    assert.equal(pareceSegredo('https://exemplo.com.br/pasta/arquivo'), false);
  });

  test('sem segredos sem estragar o texto: links compridos ficam, só o trecho secreto sai, campos comuns com "chave" ficam', () => {
    for (const url of ['https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
      'https://www.exemplo.com.br/noticias/economia/mercado-financeiro-hoje/feed',
      'https://contoso.sharepoint.com/sites/vendas/Documentos-Compartilhados/relatorio-mensal-consolidado-2026.xlsx']) assert.equal(pareceSegredo(url), false, url);
    assert.equal(tirarSegredos(INSTRUCAO), INSTRUCAO);
    assert.equal(tirarSegredos(`antes ${SEGREDO} depois`), 'antes [removido] depois');
    assert.equal(tirarSegredos('veja https://api.exemplo.com/x?token=abc123segredo&pagina=2'), 'veja https://api.exemplo.com/x?token=[removido]&pagina=2');
    assert.equal(tirarSegredos('chave: Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789AbCdEf fim'), 'chave: [removido] fim', 'sequência longa misturada, fora de link');
    assert.equal(tirarSegredos('relatorio-mensal-de-vendas-da-regional-sul-e-sudeste-2026'), 'relatorio-mensal-de-vendas-da-regional-sul-e-sudeste-2026', 'um nome comprido comum fica');
    assert.equal(tirarSegredos(['-----BEGIN ' + 'PRIVATE KEY-----', 'MIIabc', '-----END ' + 'PRIVATE KEY-----'].join('\n')), '[removido]');
    for (const k of ['palavrasChave', 'chaves_de_busca', 'tokenCount', 'maxTokens', 'refresh_interval', 'privateNote', 'otpEnabled', 'secretaria']) assert.equal(campoSecreto(k), false, k);
    for (const k of ['token', 'apiKey', 'api_key', 'client_secret', 'githubToken', 'refresh_token', 'senha', 'minhaSenha', 'password', 'private_key', 'chave', 'chaveApi', 'otp', 'Authorization']) assert.equal(campoSecreto(k), true, k);
    assert.deepEqual(semSegredos({ params: { palavrasChave: ['x'], apiKey: 'y' } }), { params: { palavrasChave: ['x'] } });
  });

  test('caminhos: um conjunto só para arquivos e pastas, o nome da pasta do workspace é o gravado, links codificados', () => {
    const c = new Caminhos();
    assert.equal(c.raiz('LEIA-ME.txt'), 'LEIA-ME.txt (2)', 'pasta de workspace não pega o nome do LEIA-ME');
    assert.equal(c.raiz('minha-conta.json'), 'minha-conta.json (2)');
    const longo = 'W'.repeat(60);
    const r1 = c.raiz(longo, ' (de outra pessoa)'); const r2 = c.raiz(longo, ' (de outra pessoa)');
    assert.notEqual(r1, r2);
    for (const r of [r1, r2]) { assert.ok(r.length <= 80, r); assert.equal(nomeSeguro(r), r, 'o nome gravado não muda de novo'); assert.ok(r.includes('(de outra pessoa)')); }
    const f = c.novo([r2, 'documentos'], 'relatorio.pdf');
    assert.ok(f.startsWith(`${r2}/documentos/`), 'o arquivo fica dentro da pasta com o nome gravado');
    // uma pasta com o nome de um arquivo que já existe ganha outro nome, e tudo dela segue junto
    const p1 = c.novo([r2, 'documentos', 'relatorio.pdf'], 'a.txt'); const p2 = c.novo([r2, 'documentos', 'relatorio.pdf'], 'b.txt');
    assert.equal(p1, `${r2}/documentos/relatorio.pdf (2)/a.txt`); assert.equal(p2, `${r2}/documentos/relatorio.pdf (2)/b.txt`);
    // e um arquivo com o nome de uma pasta que já existe também
    assert.equal(c.novo([r2], 'documentos'), `${r2}/documentos (2)`);
    assert.equal(linkRelativo('../documentos/NF #1 (a)/x%.txt'), '../documentos/NF%20%231%20%28a%29/x%25.txt');
  });

  test('data do ZIP: hora de parede no fuso pedido; sem data, 01/01/1980 fixo', () => {
    const d = dosDateTime(new Date('2026-11-10T01:00:00.000Z'), 'Asia/Tokyo');
    assert.equal(d.date, ((2026 - 1980) << 9) | (11 << 5) | 10); assert.equal(d.time, 10 << 11);
    const sp = dosDateTime(new Date('2026-11-10T01:00:00.000Z'), 'America/Sao_Paulo');
    assert.equal(sp.date, ((2026 - 1980) << 9) | (11 << 5) | 9); assert.equal(sp.time, 22 << 11);
    assert.deepEqual(dosDateTime(undefined), { time: 0, date: 0x21 });
    assert.deepEqual(readZip(writeZip([{ name: 'x.txt', data: 'a' }])).get('x.txt')!.dosDate, 0x21, 'sem data: o mesmo conteúdo gera o mesmo arquivo');
  });

  test('cofre da equipe: as novas tentativas não trocam a data da remoção que a Saúde mostra', async () => {
    throttle.reset();
    const h = await harness({ motorManagerUrl: 'http://gerente.test:8645', bridgeToken: 'token-da-instalacao-'.padEnd(40, 'x') },
      { motorFetch: (async () => new Response(JSON.stringify({ error: 'fora do ar' }), { status: 503, headers: { 'content-type': 'application/json' } })) as typeof fetch });
    const uid = `usr_${'ab'.repeat(16)}`;
    const ler = () => JSON.parse(String(h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'motores_removidos'")?.value ?? '{}')) as Record<string, string>;
    await assert.rejects(h.motors.remove(uid));
    const primeira = ler()[uid.slice(4)];
    assert.ok(primeira, 'a data da remoção fica registrada');
    await new Promise((r) => setTimeout(r, 15));
    await assert.rejects(h.motors.remove(uid));
    assert.equal(ler()[uid.slice(4)], primeira, 'a segunda tentativa não regrava a data');
    await h.close();
  });

  test('o cofre da equipe de quem saiu: tenta de novo sozinho, com espera crescente, e para quando dá certo ou acaba a lista', async () => {
    let n = 0; const avisos: Array<[number, boolean]> = [];
    const ok = tentarDeNovo(async () => { n++; if (n < 3) throw new Error('ainda subindo'); }, { esperas: [5, 10, 20], aoFalhar: (_e, t, d) => avisos.push([t, d]) });
    assert.equal(await ok.feito, true); assert.equal(n, 3); assert.deepEqual(avisos, [[1, false], [2, false]]);
    let m = 0;
    const nunca = tentarDeNovo(async () => { m++; throw new Error('fora do ar'); }, { esperas: [1, 1] });
    assert.equal(await nunca.feito, false); assert.equal(m, 3, 'a primeira e mais uma por espera');
    let k = 0;
    const parado = tentarDeNovo(async () => { k++; throw new Error('x'); }, { esperas: [60_000] });
    await new Promise((r) => setTimeout(r, 5));
    parado.cancelar();
    assert.equal(await parado.feito, false); assert.equal(k, 1, 'cancelado: não tenta mais');
  });

  test('remover a conta não espera a limpeza do cofre da equipe (mesmo travada)', async () => {
    throttle.reset();
    const h = await harness();
    const a = await setupOwner(h);
    const b = await addPerson(h, B.user, B.pass, 'Bruna');
    const original = h.motors.remove.bind(h.motors);
    let chamadas = 0;
    h.motors.remove = (async () => { chamadas++; await new Promise(() => undefined); }) as typeof h.motors.remove;
    const t0 = Date.now();
    assert.equal((await req(h, 'DELETE', `/api/people/${b.userId}`, a, { confirm: B.user })).status, 200);
    assert.ok(Date.now() - t0 < 5000);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(chamadas, 1, 'a primeira tentativa sai na hora');
    h.motors.remove = original;
    await h.close();
  });
});

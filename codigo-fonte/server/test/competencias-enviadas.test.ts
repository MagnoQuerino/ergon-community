/**
 * Adicionar uma competência pronta (rc.29): o Ergon abre o SKILL.md, a pasta compactada ou o texto colado, acerta o
 * cabeçalho, passa pela varredura da ponte (simulada aqui com o que o plugin responde) e liga no agente ou na equipe.
 * O plugin de verdade é conferido em hermes/tests/test_ergon_bridge_recursos.py, dentro da imagem.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { writeZip } from '../src/lib/zip.ts';
import { acertarCabecalho, nomeDeCompetencia, pacoteDeTexto, pacoteDeZip } from '../src/services/competencias.ts';
import { origemDe, type HermesClient, type HermesControlClient, type ModelOptions, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SKILL = `---
name: Revisar Contratos
description: Confere cláusulas de contratos de prestação de serviço
version: 1.0.0
metadata:
  hermes:
    tags: [juridico]
---
# Revisar contratos

Leia o contrato e aponte prazos, multas e foro.
`;

describe('pacote da competência (sem motor)', () => {
  test('nome a partir do cabeçalho, do título ou do arquivo; nunca com o prefixo das do Treinar', () => {
    assert.equal(nomeDeCompetencia('Revisar Contratos'), 'revisar-contratos');
    assert.equal(nomeDeCompetencia('Orçamento de obra.md'), 'orcamento-de-obra');
    assert.equal(nomeDeCompetencia('ergon-copia'), 'copia');
    assert.equal(nomeDeCompetencia('***'), 'competencia');
    assert.ok(nomeDeCompetencia('a'.repeat(200)).length <= 60);
  });

  test('o cabeçalho fica com o nome da pasta e a descrição; o resto do cabeçalho e o texto ficam como estão', () => {
    const c = acertarCabecalho(SKILL, 'x');
    assert.equal(c.nome, 'revisar-contratos');
    assert.equal(c.titulo, 'Revisar contratos');
    assert.match(c.texto, /^---\nname: "revisar-contratos"\ndescription: "Confere cláusulas/);
    assert.match(c.texto, /version: 1\.0\.0\nmetadata:\n {2}hermes:\n {4}tags: \[juridico\]\n---\n# Revisar contratos/);
    assert.equal((c.texto.match(/^name:/gm) ?? []).length, 1);
  });

  test('sem cabeçalho: nasce um, com o título e o primeiro parágrafo', () => {
    const c = acertarCabecalho('# Atas de reunião\n\nTransforma a conversa da reunião em ata com responsáveis e prazos.\n\n## Passos\n1. Ler', 'x');
    assert.equal(c.nome, 'atas-de-reuniao');
    assert.equal(c.descricao, 'Transforma a conversa da reunião em ata com responsáveis e prazos.');
    assert.match(c.texto, /^---\nname: "atas-de-reuniao"\ndescription: "Transforma/);
  });

  test('descrição em bloco (várias linhas) é lida e não duplica', () => {
    const c = acertarCabecalho('---\nname: x-y\ndescription: >\n  Primeira linha\n  e segunda\nlicense: MIT\n---\nCorpo', 'z');
    assert.equal(c.descricao, 'Primeira linha e segunda');
    assert.match(c.texto, /description: "Primeira linha e segunda"\nlicense: MIT\n---\nCorpo/);
  });

  test('texto vazio ou grande demais é recusado', () => {
    assert.throws(() => pacoteDeTexto('   '), /Cole o texto/);
    assert.throws(() => pacoteDeTexto('x'.repeat(500 * 1024)), /passa de/);
  });

  test('pasta compactada: a pasta do SKILL.md é a competência; binários, ocultos e outra competência ficam de fora', () => {
    const zip = writeZip([
      { name: 'minha-comp/SKILL.md', data: SKILL },
      { name: 'minha-comp/references/clausulas.md', data: '# Cláusulas' },
      { name: 'minha-comp/scripts/ajuda.py', data: 'print(1)' },
      { name: 'minha-comp/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
      { name: 'minha-comp/.env', data: 'SEGREDO=1' },
      { name: 'minha-comp/outra/SKILL.md', data: '# Outra' },
      { name: '__MACOSX/minha-comp/._SKILL.md', data: 'lixo' },
    ]);
    const p = pacoteDeZip(zip, 'minha-comp.zip');
    assert.equal(p.nome, 'revisar-contratos');
    assert.deepEqual(Object.keys(p.arquivos).sort(), ['SKILL.md', 'references/clausulas.md', 'scripts/ajuda.py']);
    assert.deepEqual(p.ignorados.sort(), ['.env', 'logo.png', 'outra/SKILL.md']);
  });

  test('pasta compactada sem SKILL.md, com duas competências no mesmo nível ou que não é zip', () => {
    assert.throws(() => pacoteDeZip(writeZip([{ name: 'leia.txt', data: 'oi' }])), /não tem um SKILL\.md/);
    assert.throws(() => pacoteDeZip(writeZip([{ name: 'a/SKILL.md', data: '# A' }, { name: 'b/SKILL.md', data: '# B' }])), /mais de uma competência/);
    assert.throws(() => pacoteDeZip(Buffer.from('não sou zip')), /Não consegui abrir/);
  });

  test('origem de cada competência da biblioteca', () => {
    assert.equal(origemDe('bundled', 'productivity'), 'equipe');
    assert.equal(origemDe('hub', 'finance'), 'loja');
    assert.equal(origemDe('agent', 'enviadas'), 'enviada');
    assert.equal(origemDe('agent', 'notes'), 'criada');
  });
});

// ---------------------------------------------------------------- pelas rotas, com a ponte simulada
const TOKEN = 'token-da-ponte-de-teste-envio-0123456789';
class Motor implements HermesClient {
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) { return { runId: 'run_envio000001', replayed: false }; }
  async getRun(): Promise<RemoteRun> { return { status: 'running', output: null, error: null, sessionId: 's', usage: null, model: null }; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return ['skills', 'todo'].map((name) => ({ name, label: name, enabled: true, configured: true, tools: [] })); }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
function ponteFalsa() {
  const chamadas: Array<{ method: string; sub: string; body?: any; query?: any }> = [];
  const biblioteca = new Map<string, Record<string, string>>();
  const veredito = (arquivos: Record<string, string>) => /rm -rf \//.test(Object.values(arquivos).join('\n')) ? 'dangerous' : /curl /.test(Object.values(arquivos).join('\n')) ? 'caution' : 'safe';
  const politica = (v: string) => ({ safe: 'allow', caution: 'ask', dangerous: 'block' } as Record<string, string>)[v];
  const recursos = async (method: string, sub: string, body?: any, query?: any): Promise<{ status: number; json: any }> => {
    chamadas.push({ method, sub, body, query });
    if (sub === 'loja/varrer') { const v = veredito(body.arquivos); return { status: 200, json: { veredito: v, politica: politica(v), achados: v === 'safe' ? [] : [{ gravidade: 'high', arquivo: 'SKILL.md', linha: 3, descricao: 'baixa da internet' }] } }; }
    if (sub === 'loja/enviar') {
      const v = veredito(body.arquivos);
      if (v === 'dangerous' || (v === 'caution' && body.risco_aceito !== true)) return { status: 409, json: { error: 'barrou', varredura: { veredito: v, politica: politica(v) } } };
      const atualizada = biblioteca.has(body.nome);
      biblioteca.set(body.nome, body.arquivos);
      return { status: 200, json: { ok: true, nome: body.nome, atualizada, varredura: { veredito: v } } };
    }
    if (sub === 'loja/remover') { if (!biblioteca.delete(body.nome)) return { status: 409, json: { error: 'esta competência já vem com a equipe e não pode ser removida' } }; return { status: 200, json: { ok: true } }; }
    if (sub === 'loja/conteudo') return biblioteca.has(query.nome) ? { status: 200, json: { nome: query.nome, texto: biblioteca.get(query.nome)!['SKILL.md'], arquivos: Object.keys(biblioteca.get(query.nome)!), enviada: true } } : { status: 400, json: { error: 'competência não encontrada' } };
    return { status: 404, json: { error: 'rota não liberada pela ponte do Ergon' } };
  };
  const control = { health: async () => true, recursos, apiToolsets: async () => ({ enabled: ['skills'], safe: ['skills'] }), setApiToolsets: async (e: string[]) => e } as unknown as HermesControlClient;
  return { control, chamadas, biblioteca };
}

let h: Harness; let s: Session; let ponte: ReturnType<typeof ponteFalsa>;
beforeEach(async () => {
  ponte = ponteFalsa();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor(), control: ponte.control });
  s = await setupOwner(h);
});
afterEach(() => h.close());

const agentes = () => h.db.all<{ id: string; tools: string | null; hermes_skills: string | null }>("SELECT id, tools, hermes_skills FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at", s.workspaceId);
const lista = (v: string | null) => JSON.parse(v ?? '[]') as string[];

describe('adicionar uma competência pronta', () => {
  test('prévia: mostra o nome, a descrição, os arquivos e a varredura, sem gravar nada', async () => {
    const r = await req(h, 'POST', '/api/recursos/competencias/previa', s, { texto: SKILL, nomeArquivo: 'SKILL.md' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.nome, 'revisar-contratos');
    assert.match(r.json.descricao, /Confere cláusulas/);
    assert.deepEqual(r.json.arquivos, ['SKILL.md']);
    assert.equal(r.json.varredura.politica, 'allow');
    assert.equal(ponte.biblioteca.size, 0);
    assert.ok(!ponte.chamadas.some((c) => c.sub === 'loja/enviar'));
  });

  test('só neste agente: grava na biblioteca e liga só nele, com a ferramenta das competências', async () => {
    const [a, b] = agentes();
    const antesB = lista(b.hermes_skills);
    const r = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: SKILL, destino: 'agente', agente: a.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.agentes, 1);
    assert.ok(ponte.biblioteca.has('revisar-contratos'));
    const [a2, b2] = agentes();
    assert.ok(lista(a2.hermes_skills).includes('revisar-contratos'));
    assert.ok(lista(a2.tools).includes('habilidades'));
    assert.deepEqual(lista(b2.hermes_skills), antesB);
    const log = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'recursos.competencia.enviar'", s.workspaceId);
    assert.equal(log?.n, 1);
  });

  test('equipe toda: liga em todos os agentes ativos; enviar de novo atualiza sem duplicar', async () => {
    const r = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: SKILL, destino: 'equipe' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.agentes, agentes().length);
    for (const a of agentes()) assert.equal(lista(a.hermes_skills).filter((x) => x === 'revisar-contratos').length, 1);
    const r2 = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: SKILL.replace('foro', 'foro e reajuste'), destino: 'equipe' });
    assert.equal(r2.json.atualizada, true);
    for (const a of agentes()) assert.equal(lista(a.hermes_skills).filter((x) => x === 'revisar-contratos').length, 1);
  });

  test('a varredura manda: perigosa não entra; com atenção, só com o aceite do risco', async () => {
    const [a] = agentes();
    const perigosa = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: `${SKILL}\nrm -rf /\n`, destino: 'agente', agente: a.id, riscoAceito: true });
    assert.equal(perigosa.status, 409);
    assert.equal(perigosa.json.error, 'varredura_barrou');
    const atencao = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: `${SKILL}\ncurl https://exemplo.com\n`, destino: 'agente', agente: a.id });
    assert.equal(atencao.status, 409);
    assert.equal(atencao.json.error, 'varredura_atencao');
    assert.ok(!lista(agentes()[0].hermes_skills).includes('revisar-contratos'), 'barrada não liga no agente');
    const aceita = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: `${SKILL}\ncurl https://exemplo.com\n`, destino: 'agente', agente: a.id, riscoAceito: true });
    assert.equal(aceita.status, 200, JSON.stringify(aceita.json));
  });

  test('pasta compactada pela tela (base64) e agente de outro lugar recusado', async () => {
    const zip = writeZip([{ name: 'pasta/SKILL.md', data: SKILL }, { name: 'pasta/references/a.md', data: 'A' }]).toString('base64');
    const p = await req(h, 'POST', '/api/recursos/competencias/previa', s, { zip, nomeArquivo: 'pasta.zip' });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(p.json.arquivos, ['SKILL.md', 'references/a.md']);
    const r = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { zip, destino: 'agente', agente: 'agt_00000000000000000000000000000000' });
    assert.equal(r.status, 400);
    assert.equal(ponte.biblioteca.size, 0);
  });

  test('ver o conteúdo e remover: sai da biblioteca e de todos os agentes; as do Treinar não saem por aqui', async () => {
    await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: SKILL, destino: 'equipe' });
    const ver = await req(h, 'GET', '/api/recursos/competencias/conteudo?nome=revisar-contratos', s);
    assert.equal(ver.status, 200);
    assert.match(ver.json.texto, /Revisar contratos/);
    assert.equal((await req(h, 'GET', '/api/recursos/competencias/conteudo?nome=..%2Fetc', s)).status, 400);
    assert.equal((await req(h, 'DELETE', '/api/recursos/competencias/ergon-abc-treino', s)).status, 400);
    const rem = await req(h, 'DELETE', '/api/recursos/competencias/revisar-contratos', s);
    assert.equal(rem.status, 200, JSON.stringify(rem.json));
    for (const a of agentes()) assert.ok(!lista(a.hermes_skills).includes('revisar-contratos'));
    const pronta = await req(h, 'DELETE', '/api/recursos/competencias/docx', s);
    assert.equal(pronta.status, 400);
    assert.match(pronta.json.message ?? '', /já vem com a equipe/);
  });

  test('ligar e desligar num agente: a conta é sobre a lista gravada (cliques seguidos não se apagam) e a ferramenta vai junto', async () => {
    const [a, b] = agentes();
    await h.db.run("UPDATE agents SET tools = '[]' WHERE id = ?", a.id);
    const antes = lista(a.hermes_skills);
    // duas chamadas em seguida, como dois cliques antes de a tela recarregar
    const [r1, r2] = await Promise.all([
      req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: a.id, nome: 'comp-um', ligar: true }),
      req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: a.id, nome: 'comp-dois', ligar: true }),
    ]);
    assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r2.status, 200, JSON.stringify(r2.json));
    const depois = agentes().find((x) => x.id === a.id)!;
    assert.deepEqual(lista(depois.hermes_skills).filter((x) => !antes.includes(x)).sort(), ['comp-dois', 'comp-um']);
    assert.ok(lista(depois.tools).includes('habilidades'));
    // de novo: não duplica
    await req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: a.id, nome: 'comp-um', ligar: true });
    assert.equal(lista(agentes().find((x) => x.id === a.id)!.hermes_skills).filter((x) => x === 'comp-um').length, 1);
    const off = await req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: a.id, nome: 'comp-um', ligar: false });
    assert.ok(!off.json.competencias.includes('comp-um') && off.json.competencias.includes('comp-dois'));
    assert.deepEqual(lista(agentes().find((x) => x.id === b.id)!.hermes_skills), lista(b.hermes_skills), 'o outro agente não muda');
    assert.equal((await req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: a.id, nome: 'ergon-abc-treino', ligar: true })).status, 400);
    assert.equal((await req(h, 'POST', '/api/recursos/competencias/ligar', s, { agente: 'agt_00000000000000000000000000000000', nome: 'comp-um', ligar: true })).status, 404);
  });

  test('os erros novos têm código para a tela traduzir', async () => {
    const r = await req(h, 'POST', '/api/recursos/competencias/previa', s, { texto: '   ' });
    assert.equal(r.status, 400);
    assert.equal(r.json.message_t?.codigo, 'erro.compVazia');
    const z = await req(h, 'POST', '/api/recursos/competencias/previa', s, { zip: Buffer.from('nao sou zip').toString('base64'), nomeArquivo: 'x.zip' });
    assert.equal(z.json.message_t?.codigo, 'erro.compZipAbrir');
    const ag = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: SKILL, destino: 'agente' });
    assert.equal(ag.json.message_t?.codigo, 'erro.compAgenteAtivo');
    const [a] = agentes();
    const at = await req(h, 'POST', '/api/recursos/competencias/instalar', s, { texto: `${SKILL}\ncurl https://exemplo.com\n`, destino: 'agente', agente: a.id });
    assert.equal(at.json.message_t?.codigo, 'erro.compVarreduraAtencao');
  });
});

/**
 * Entregáveis (rc.42): o .md formatado com identidade e modelo, o PDF fiel (cabeçalho, rodapé, número de página, ABNT),
 * o logo conferido pelos bytes e a revisão com o coordenador — frentes por trecho, cada uma um card com prioridade,
 * texto chegando ao vivo, ninguém sobrescrevendo o outro, o revisor só no que já foi liberado, versões e desfazer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, RunEvent, StartRun } from '../src/services/hermes.ts';
import { conferirLogo } from '../src/services/entregaveis.ts';
import { documentoPdf } from '../src/lib/pdf-documento.ts';
import { chaveDaCerca, pngsDasCercas, svgParaPngJa } from '../src/services/visuais/png.ts';
import { cercaVisual } from '../../shared/visuais/cercas.ts';
import { EXEMPLOS } from '../../shared/visuais/exemplos.ts';
import { IDENTIDADE_PADRAO, MODELOS_ORIGINAIS, normalizarModelo, numeracao } from '../../shared/entregaveis.ts';
import { corDoAgente, juntarTrechos, liberadosAPartir, MARCA_FIM, MARCA_INICIO, planejar, textoDaResposta, trechosDe } from '../../shared/revisao.ts';
import { drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: Array<StartRun & { runId: string }> = [];
  runs = new Map<string, RemoteRun>();
  ouvintes = new Map<string, (e: RunEvent) => void>();
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_doc${String(this.started.length + 1).padStart(6, '0')}`;
    this.started.push({ ...p, runId });
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: 's', usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop(id: string) { this.runs.set(id, { status: 'cancelled', output: null, error: null, sessionId: 's', usage: null, model: null }); return { accepted: true, detail: 'ok' }; }
  async events(id: string, on: (e: RunEvent) => void, signal: AbortSignal) {
    this.ouvintes.set(id, on);
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
  fala(id: string, delta: string) { this.ouvintes.get(id)?.({ event: 'message.delta', delta } as RunEvent); }
  finish(id: string, output: string) { this.runs.set(id, { status: 'completed', output, error: null, sessionId: 's', usage: null, model: 'nous/teste-1' }); }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64');
const DOC = [
  '# Proposta de serviço',
  'Este documento apresenta a proposta de consultoria para a Acme, com escopo, prazos e condições.',
  '## Código de integração',
  '```js\nconst total = itens.reduce((a, i) => a + i.valor, 0)\n```',
  '## Cláusulas',
  'Cláusula 1. A contratante pagará a contratada em até 30 dias. A rescisão segue a Lei nº 8.666.',
  '## Conclusão',
  'Ficamos à disposição para ajustes.',
].join('\n\n');

describe('entregáveis: documento, PDF, identidade, modelos e revisão ao vivo', () => {
  let h: Harness; let s: Session; let motor: Motor; let art: string;
  const resposta = (texto: string) => `Pronto.\n${MARCA_INICIO}\n${texto}\n${MARCA_FIM}`;
  const frenteDoRun = (runId: string) => h.db.get<{ id: string; acao: string; blocos: string; passada: string | null; agent_id: string }>(
    'SELECT f.id, f.acao, f.blocos, f.passada, f.agent_id FROM doc_revisao_frentes f JOIN runs r ON r.task_id = f.task_id WHERE r.hermes_run_id = ?', runId);

  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', maxConcurrentRuns: 4 }, { hermes: motor });
    s = await setupOwner(h);
    const up = await req(h, 'POST', '/api/artifacts', s, Buffer.from(DOC, 'utf8'), { 'content-type': 'application/octet-stream', 'x-filename': 'proposta-T12-4f05ef35.md', 'x-file-type': 'text/markdown' });
    assert.equal(up.status, 201, JSON.stringify(up.json));
    art = up.json.id;
  });
  after(async () => { await h.close(); });

  test('trechos, plano por especialidade e cor fixa de cada agente', () => {
    const t = trechosDe(DOC);
    assert.equal(t.length, 8);
    assert.equal(juntarTrechos(t).trim(), DOC.trim(), 'juntar devolve o mesmo texto');
    assert.deepEqual(trechosDe('- a\n\n  continua\n- b\n\n```\nx\n\ny\n```'), ['- a\n\n  continua\n- b', '```\nx\n\ny\n```'], 'item com parágrafo e código com linha em branco ficam inteiros');
    const equipe = [
      { id: 'c', name: 'Coord', role: 'Coordenação da equipe', coordinator: true },
      { id: 'dev', name: 'Arquimedes', role: 'Desenvolvedor de software' },
      { id: 'jur', name: 'Sólon', role: 'Assessor jurídico' },
      { id: 'red', name: 'Hipátia', role: 'Redatora' },
      { id: 'rev', name: 'Sócrates', role: 'Revisor de qualidade' },
    ];
    const plano = planejar(t, 'revise tudo', equipe);
    const de = (id: string) => plano.filter((f) => f.agentId === id);
    assert.deepEqual(de('dev').map((f) => f.blocos), [[3]], 'o código vai para quem programa');
    assert.deepEqual(de('jur').map((f) => f.blocos), [[4, 5]], 'as cláusulas (título e texto) vão para o jurídico');
    assert.ok(de('red').length >= 2, 'o resto do texto, para a redatora');
    assert.equal(de('rev')[0].acao, 'conferir', 'o revisor confere por último');
    assert.ok(!plano.some((f) => f.agentId === 'c'), 'o coordenador não edita');
    // reservas: nenhum trecho em duas frentes de edição
    const vistos = plano.filter((f) => f.acao !== 'conferir').flatMap((f) => f.blocos);
    assert.equal(new Set(vistos).size, vistos.length);
    assert.deepEqual(planejar(t, 'reescreva a conclusão', equipe, { selecionados: [7] }), [{ agentId: 'red', acao: 'reescrever', blocos: [7], especialidade: 'texto' }]);
    assert.deepEqual(liberadosAPartir(8, 0, new Set([3, 5])), [0, 1, 2], 'o revisor para no primeiro trecho reservado');
    assert.equal(corDoAgente('agt_1'), corDoAgente('agt_1'));
    assert.notEqual(corDoAgente('agt_1'), corDoAgente('agt_2'));
    assert.match(corDoAgente('x'), /^#[0-9a-f]{6}$/);
    assert.equal(textoDaResposta(`oi\n${MARCA_INICIO}\nnovo\n${MARCA_FIM}\ntchau`), 'novo');
    assert.equal(textoDaResposta(`${MARCA_INICIO}\nmeio do`, true), 'meio do', 'ao vivo: até onde chegou');
  });

  test('modelos: normalização, numeração ABNT e PDF com páginas, cabeçalho e capa', () => {
    const m = normalizarModelo({ nome: 'Cliente X', base: 'abnt', margens: { topo: 99, esquerda: '3,5' }, tamanho: 2, paginacao: 'invalida' }, 'mod_x');
    assert.equal(m.margens.topo, 5); assert.equal(m.margens.esquerda, 3.5); assert.equal(m.tamanho, 9); assert.equal(m.paginacao, 'topo'); assert.equal(m.fonte, 'serif');
    assert.deepEqual(numeracao([1, 2, 3, 3, 2, 4]), ['', '1', '1.1', '1.2', '2', '2.1.1']);
    const longo = `${DOC}\n\n${Array.from({ length: 80 }, (_, i) => `Parágrafo ${i + 1} com texto suficiente para ocupar uma linha inteira e um pouco mais do documento.`).join('\n\n')}`;
    for (const modelo of MODELOS_ORIGINAIS) {
      const pdf = documentoPdf({ markdown: longo, titulo: 'Proposta', identidade: { ...IDENTIDADE_PADRAO, nome: 'Acme' }, modelo, logo: PNG });
      const txt = pdf.toString('latin1');
      assert.match(txt, /^%PDF-1\./);
      const paginas = (txt.match(/\/Type \/Page\b/g) ?? []).length;
      assert.ok(paginas >= 3, `${modelo.id}: ${paginas} páginas`);
    }
  });

  test('PDF: o bloco visual ```ergon-<tipo> sai como imagem (o cartão), não como código', () => {
    const md = `# Relatório\n\nOs gastos do mês:\n\n${cercaVisual(EXEMPLOS.kpi)}\n\n${cercaVisual(EXEMPLOS.barras)}\n\nFim.`;
    const pngs = pngsDasCercas(md);
    assert.equal(pngs.size, 2);
    const com = documentoPdf({ markdown: md, titulo: 'R', identidade: IDENTIDADE_PADRAO, modelo: MODELOS_ORIGINAIS[0], visual: (l, c) => pngs.get(chaveDaCerca(l, c)) ?? null }).toString('latin1');
    const sem = documentoPdf({ markdown: md, titulo: 'R', identidade: IDENTIDADE_PADRAO, modelo: MODELOS_ORIGINAIS[0] }).toString('latin1');
    assert.equal((com.match(/\/Subtype \/Image/g) ?? []).length, 2);
    assert.equal((sem.match(/\/Subtype \/Image/g) ?? []).length, 0);
  });

  test('PDF: o logo com fundo transparente aparece (o alfa vira o fundo branco)', () => {
    const logo = svgParaPngJa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15" fill="#c33"/></svg>', 1);
    assert.ok(logo);
    const capa = MODELOS_ORIGINAIS.find((m) => m.capa.ligada)!;
    const pdf = documentoPdf({ markdown: '# T\n\nx', titulo: 'T', identidade: { ...IDENTIDADE_PADRAO, nome: 'Acme' }, modelo: capa, logo }).toString('latin1');
    assert.ok((pdf.match(/\/Subtype \/Image/g) ?? []).length >= 1);
  });

  test('logo: só PNG ou JPEG conferido pelos bytes; SVG e disfarce recusados', async () => {
    assert.deepEqual(conferirLogo(PNG), { mime: 'image/png', w: 16, h: 16 });
    assert.throws(() => conferirLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /PNG, JPEG ou SVG/);
    assert.throws(() => conferirLogo(Buffer.concat([Buffer.from('GIF89a'), PNG])), /PNG, JPEG ou SVG/);
    assert.throws(() => conferirLogo(Buffer.alloc(600 * 1024, 1)), /512 KB/);
    let r = await req(h, 'PUT', '/api/entregaveis/identidade/logo', s, PNG, { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.logo.w, 16);
    const img = await h.app.inject({ method: 'GET', url: '/api/entregaveis/identidade/logo', headers: { cookie: s.cookie } });
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.match(String(img.headers['content-security-policy']), /sandbox/);
    r = await req(h, 'PUT', '/api/entregaveis/identidade/logo', s, Buffer.from('<svg onload="x()"/>'), { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 415);
    r = await req(h, 'PUT', '/api/entregaveis/identidade', s, { nome: 'Acme Engenharia', corPrimaria: '#0B5394', corDestaque: '#E69138', mostrarErgon: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.corPrimaria, '#0b5394');
    assert.equal((await req(h, 'PUT', '/api/entregaveis/identidade', s, { corPrimaria: 'red; background:url(x)' })).status, 400);
  });

  test('documento: texto inteiro com modelo; o agente escolhe o modelo pelo nome; PDF do arquivo', async () => {
    let r = await req(h, 'GET', `/api/artifacts/${art}/documento`, s);
    assert.equal(r.status, 200);
    assert.equal(r.json.texto, DOC);
    assert.equal(r.json.modelo.id, 'ergon');
    assert.equal(r.json.identidade.nome, 'Acme Engenharia');
    const criado = await req(h, 'POST', '/api/entregaveis/modelos', s, { nome: 'Relatório Acme', base: 'ergon', capa: { ligada: true, autor: 'Equipe' }, rodape: { mostrar: true, texto: '{empresa} · confidencial' } });
    assert.equal(criado.status, 200);
    assert.match(criado.json.id, /^mod_/);
    const { escolherModelo } = await import('../src/services/entregaveis.ts');
    assert.equal(escolherModelo(h.db, h.bus, s.workspaceId, { type: 'agent', id: 'x' }, art, 'abnt')?.id, 'abnt', '"usa o modelo ABNT"');
    r = await req(h, 'GET', `/api/artifacts/${art}/documento`, s);
    assert.equal(r.json.modelo.id, 'abnt');
    const pdf = await h.app.inject({ method: 'GET', url: `/api/artifacts/${art}/pdf`, headers: { cookie: s.cookie } });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(String(pdf.headers['content-disposition']), /attachment; filename\*=UTF-8''proposta-T12-4f05ef35\.pdf/);
    assert.equal((await req(h, 'PUT', `/api/artifacts/${art}/modelo`, s, { modelo: null })).status, 200);
  });

  test('revisão: frentes em paralelo, texto ao vivo, ninguém sobrescreve o outro, revisor só no liberado, versões e desfazer', async () => {
    const antes = motor.started.length;
    const r = await req(h, 'POST', `/api/artifacts/${art}/revisao`, s, { pedido: 'Revise o documento inteiro' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await drain(h, 4);
    let st = (await req(h, 'GET', `/api/artifacts/${art}/revisao`, s)).json;
    assert.ok(st.ativa, 'a revisão começou');
    const edicao = st.ativa.frentes.filter((f: { acao: string }) => f.acao !== 'conferir');
    assert.ok(edicao.length >= 2, `mais de uma frente: ${edicao.length}`);
    // cards com prioridade, delegados pelo fluxo de tarefas
    const cards = h.db.all<{ priority: number; title: string }>('SELECT t.priority, t.title FROM tasks t JOIN doc_revisao_frentes f ON f.task_id = t.id');
    assert.ok(cards.length >= 2 && cards.every((c) => Number(c.priority) === 1), 'prioridade ligada');
    const rodando = motor.started.slice(antes);
    assert.ok(rodando.length >= 2, 'as frentes de edição rodam ao mesmo tempo');
    assert.ok(rodando.every((p) => !p.input.includes(DOC)), 'ninguém recebe o documento inteiro');
    // o texto chega ao vivo
    const primeiro = rodando[0];
    motor.fala(primeiro.runId, `${MARCA_INICIO}\nTexto novo che`);
    await new Promise((res) => setTimeout(res, 300));
    st = (await req(h, 'GET', `/api/artifacts/${art}/revisao`, s)).json;
    const viva = st.ativa.frentes.find((f: { aoVivo: string | null }) => f.aoVivo);
    assert.equal(viva?.aoVivo, 'Texto novo che');
    // o revisor espera: os trechos de cima estão reservados
    const conf = st.ativa.frentes.find((f: { acao: string }) => f.acao === 'conferir');
    if (conf) assert.equal(conf.estado, 'espera');
    // terminam em ordem inversa: cada uma troca só os seus trechos; as frentes seguintes do mesmo agente começam depois
    const marcas: string[] = [];
    const vistos = new Set<string>();
    for (let volta = 0; volta < 10; volta++) {
      const abertos = motor.started.slice(antes).filter((p) => motor.runs.get(p.runId)?.status === 'running' && frenteDoRun(p.runId) && frenteDoRun(p.runId)!.acao !== 'conferir');
      if (!abertos.length) break;
      const porAgente = new Set(abertos.map((p) => frenteDoRun(p.runId)!.agent_id));
      assert.equal(porAgente.size, abertos.length, 'um agente, um trecho por vez');
      for (const p of [...abertos].reverse()) {
        const f = frenteDoRun(p.runId)!;
        vistos.add(f.id);
        const marca = `EDITADO-${f.id.slice(-6)}`;
        marcas.push(marca);
        motor.finish(p.runId, resposta(`Trecho revisado ${marca}.`));
        await drain(h, 3);
      }
    }
    assert.ok(vistos.size >= 2);
    st = (await req(h, 'GET', `/api/artifacts/${art}/revisao`, s)).json;
    let doc = (await req(h, 'GET', `/api/artifacts/${art}/documento`, s)).json.texto as string;
    for (const m of marcas) assert.ok(doc.includes(m), `a edição ${m} ficou`);
    // agora o revisor pega o que foi liberado, de cima para baixo
    for (let volta = 0; volta < 6; volta++) {
      await drain(h, 3);
      const confRun = motor.started.slice(antes).find((p) => frenteDoRun(p.runId)?.acao === 'conferir' && motor.runs.get(p.runId)?.status === 'running');
      if (!confRun) break;
      const passada = JSON.parse(frenteDoRun(confRun.runId)!.passada ?? '[]') as number[];
      assert.ok(passada.length > 0);
      const atual = trechosDe(doc);
      motor.finish(confRun.runId, resposta(`${passada.map((i) => atual[i] ?? '').filter(Boolean).join('\n\n')}\n\nCONFERIDO-${volta}`));
      await drain(h, 3);
      doc = (await req(h, 'GET', `/api/artifacts/${art}/documento`, s)).json.texto as string;
    }
    for (const m of marcas) assert.ok(doc.includes(m), `o revisor não apagou ${m}`);
    assert.match(doc, /CONFERIDO-0/);
    st = (await req(h, 'GET', `/api/artifacts/${art}/revisao`, s)).json;
    assert.equal(st.ativa, null, 'a revisão terminou');
    assert.equal(st.pedidos.at(-1).estado, 'feito');
    const v = (await req(h, 'GET', `/api/artifacts/${art}/versoes`, s)).json;
    assert.ok(v.atual >= 3, `uma versão por frente: ${v.atual}`);
    assert.equal(v.versoes.at(-1).nota, 'original');
    // desfazer volta uma versão; voltar à 1 devolve o original
    assert.equal((await req(h, 'POST', `/api/artifacts/${art}/desfazer`, s, {})).status, 200);
    assert.equal((await req(h, 'POST', `/api/artifacts/${art}/versoes/1/restaurar`, s, {})).status, 200);
    assert.equal((await req(h, 'GET', `/api/artifacts/${art}/documento`, s)).json.texto, DOC);
    assert.equal((await req(h, 'GET', `/api/artifacts/${art}/versoes/2`, s)).status, 200);
  });

  test('fila: dois pedidos seguidos andam em ordem, cada um sobre a versão mais nova', async () => {
    const antes = motor.started.length;
    const a = await req(h, 'POST', `/api/artifacts/${art}/revisao`, s, { pedido: 'Reescreva a conclusão', trecho: 'Ficamos à disposição para ajustes.' });
    const b = await req(h, 'POST', `/api/artifacts/${art}/revisao`, s, { pedido: 'Revise a conclusão de novo', trecho: 'Seguimos à disposição' });
    assert.equal(a.json.estado, 'editando'); assert.equal(b.json.estado, 'fila');
    await drain(h, 3);
    const p1 = motor.started.slice(antes);
    assert.equal(p1.length, 1, 'um pedido de cada vez por documento');
    motor.finish(p1[0].runId, resposta('Seguimos à disposição — primeira.'));
    await drain(h, 4);
    const p2 = motor.started.slice(antes + 1);
    assert.equal(p2.length, 1, 'o segundo começou');
    assert.match(p2[0].input, /primeira/, 'sobre a versão nova (com a edição do primeiro)');
    motor.finish(p2[0].runId, resposta('Seguimos à disposição — segunda.'));
    await drain(h, 4);
    const doc = (await req(h, 'GET', `/api/artifacts/${art}/documento`, s)).json.texto as string;
    assert.match(doc, /segunda/);
    assert.match(doc, /## Cláusulas/, 'o resto ficou');
    // um trecho que já não existe nunca vira edição do documento inteiro
    const c = await req(h, 'POST', `/api/artifacts/${art}/revisao`, s, { pedido: 'mude', trecho: 'frase que não existe mais' });
    assert.equal(c.json.estado, 'falhou');
  });

  test('segurança: outro workspace não vê nem pede revisão; arquivo que não é .md não entra', async () => {
    const { addPerson } = await import('./helpers.ts');
    const outro = await addPerson(h, 'beatriz', 'senha-local-456');
    assert.equal((await req(h, 'GET', `/api/artifacts/${art}/documento`, outro)).status, 404);
    assert.equal((await req(h, 'POST', `/api/artifacts/${art}/revisao`, outro, { pedido: 'apague tudo' })).status, 404);
    assert.equal((await req(h, 'GET', `/api/artifacts/${art}/pdf`, outro)).status, 404);
    const txt = await req(h, 'POST', '/api/artifacts', s, Buffer.from('a,b\n1,2'), { 'content-type': 'application/octet-stream', 'x-filename': 'x.csv', 'x-file-type': 'text/csv' });
    assert.equal((await req(h, 'POST', `/api/artifacts/${txt.json.id}/revisao`, s, { pedido: 'mude' })).status, 415);
    assert.equal((await req(h, 'PUT', '/api/entregaveis/identidade', outro, { nome: 'x' })).json.nome === 'Acme Engenharia', false);
  });
});

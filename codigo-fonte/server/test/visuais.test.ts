// Blocos visuais (rc.42): o formato (shared/visuais), a validação que devolve o erro ao agente, o texto dos canais, o
// PNG, a busca protegida da prévia de link (SSRF) e as rotas: a ferramenta do motor, o voto e o relatório.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { CERCA, TODOS_OS_TIPOS, validarBloco, type Bloco } from '../../shared/visuais/esquema.ts';
import { apurar, blocosDe, cercaVisual, cercaVoto, normalizarVisuais, votoDe } from '../../shared/visuais/cercas.ts';
import { EXEMPLOS } from '../../shared/visuais/exemplos.ts';
import { relatorioComoMarkdown, visuaisComoTexto, visualComoTexto } from '../../shared/visuais/texto.ts';
import { cenaDe, GRAFICOS } from '../../shared/visuais/cena.ts';
import { cartaoSvg } from '../../shared/visuais/svg.ts';
import { PALETAS } from '../../shared/visuais/paleta.ts';
import { VISUAIS_NO_PROMPT } from '../../shared/visuais/prompt.ts';
import { fmtValor } from '../../shared/visuais/formato.ts';
import { textoParaTeams } from '../src/services/teams-app/cartoes.ts';
import { visualParaPng } from '../src/services/visuais/png.ts';
import { Recusado, buscarSeguro, conferirUrl, ipPrivado, metadadosDe } from '../src/services/visuais/rede.ts';
import { harness, req, setupOwner } from './helpers.ts';
import { almaDoAgente } from '../src/services/runs.ts';
import { marcaErgonSvg, cartaoSvg as cartao } from '../../shared/visuais/svg.ts';
import { logoSvg } from '../../shared/logo-ergon.ts';

const FONTE = [{ tipo: 'conexao', titulo: 'Outlook · suporte@', periodo: '1–20/11' }];

test('cada tipo do catálogo tem exemplo, valida, vira texto, e os gráficos viram cena com texto alternativo e dados', () => {
  assert.deepEqual(Object.keys(EXEMPLOS).sort(), [...TODOS_OS_TIPOS].sort());
  for (const [tipo, b] of Object.entries(EXEMPLOS)) {
    const r = validarBloco(b);
    assert.ok(r.ok, `${tipo}: ${r.ok ? '' : r.erros.join('; ')}`);
    const txt = visualComoTexto(r.bloco);
    assert.ok(txt.trim().length > 5, `${tipo}: texto vazio`);
    if (GRAFICOS.has(r.bloco.tipo)) {
      for (const largura of [358, 720]) {
        const c = cenaDe(r.bloco, { largura })!;
        assert.ok(c.prims.length > 2 && c.alt.length > 5, `${tipo}: cena`);
        assert.ok(c.w <= Math.max(largura, 260) + 1, `${tipo}: cabe em ${largura} (deu ${c.w})`);
        if (tipo !== 'icones' && tipo !== 'sparkline') assert.ok(c.dados?.linhas.length, `${tipo}: a tabela de dados por trás do gráfico`);
      }
    }
  }
});

test('sem fonte o servidor recusa (o erro volta ao agente com o caminho); "estimativa" passa e fica marcada', () => {
  const sem = validarBloco({ tipo: 'kpi', rotulo: 'Gastos', valor: 10 });
  assert.equal(sem.ok, false);
  assert.match((sem as { erros: string[] }).erros.join(), /fontes: diga de onde veio/);
  const est = validarBloco({ tipo: 'kpi', rotulo: 'Gastos', valor: 10, estimativa: true });
  assert.ok(est.ok);
  assert.match(visualComoTexto((est as { bloco: Bloco }).bloco), /estimativa/);
  // o aviso, o checklist e a enquete não pedem fonte
  assert.ok(validarBloco({ tipo: 'aviso', tom: 'dica', texto: 'Use o Pix.' }).ok);
});

test('os erros dizem onde e o que corrigir: número como texto, série do tamanho errado, linha de tabela curta, endereço perigoso', () => {
  const erros = (v: unknown) => { const r = validarBloco(v); return r.ok ? [] : r.erros; };
  assert.match(erros({ tipo: 'kpi', rotulo: 'X', valor: '12', fontes: FONTE }).join(), /valor: deve ser número/);
  assert.match(erros({ tipo: 'barras', categorias: ['a', 'b'], series: [{ nome: 's', valores: [1] }], fontes: FONTE }).join(), /series\[0\]\.valores: 1 valores para 2 categorias/);
  assert.match(erros({ tipo: 'tabela', colunas: [{ titulo: 'a' }, { titulo: 'b' }], linhas: [['x']], fontes: FONTE }).join(), /linhas\[0\]: 1 células para 2 colunas/);
  assert.match(erros({ tipo: 'tabela', colunas: [{ titulo: 'v', formato: 'moeda' }], linhas: [['R$ 1.200']], fontes: FONTE }).join(), /mande os valores como número/);
  assert.match(erros({ tipo: 'link', url: 'javascript:alert(1)' }).join(), /só http/);
  assert.match(erros({ tipo: 'galeria', imagens: [{ src: 'http://exemplo.com/a.png', alt: 'a' }] }).join(), /https/);
  assert.match(erros({ tipo: 'kpi', rotulo: 'X', valor: 1, fontes: [{ tipo: 'site', titulo: 'x', url: 'https://u:p@exemplo.com' }] }).join(), /sem usuário e senha/);
  assert.match(erros({ tipo: 'referencias', itens: [{ tipo: 'email', titulo: 'NF', url: 'https://site-qualquer.com/x' }] }).join(), /só o link do próprio aplicativo/);
  assert.match(erros({ tipo: 'nada' }).join(), /tipo: use kpi/);
  assert.match(erros({ tipo: 'relatorio', secoes: [{ titulo: 'a', blocos: [{ tipo: 'relatorio', secoes: [] }] }], estimativa: true }).join(), /relatório dentro de relatório/);
  // a conferência do workspace: id interno que não existe é recusado
  const r = validarBloco({ tipo: 'arquivo', id: 'art_0123456789abcdef0123456789abcdef' }, { idValido: () => false });
  assert.equal(r.ok, false);
});

test('a cerca na mensagem: normaliza, divide a lista, guarda o JSON que não passa como código comum e limita a quantidade', () => {
  const b = { tipo: 'kpi', rotulo: 'Gastos', valor: 10, fontes: FONTE, campoQueNaoExiste: 1 };
  const txt = `Veja:\n\n\`\`\`${CERCA}\n${JSON.stringify([b, b])}\n\`\`\`\n\n\`\`\`ergon-kpi\n{"tipo":"kpi"}\n\`\`\`\n\nfim`;
  const n = normalizarVisuais(txt);
  assert.equal(n.blocos.length, 2);
  assert.equal(blocosDe(n.texto).length, 2);
  assert.ok(!n.texto.includes('campoQueNaoExiste'), 'o que não é do formato sai');
  assert.match(n.texto, /```json\n\{"tipo":"kpi"\}\n```/);
  assert.match(n.texto, /```ergon-kpi\n\{"rotulo":"Gastos"/, 'gravada na cerca do tipo');
  // a cerca do tipo (a convenção do documento): o tipo vem da linguagem; um tipo diferente no JSON é erro
  assert.equal(blocosDe('```ergon-linha-do-tempo\n{"marcos":[{"data":"2026-11-21","titulo":"x"}],"estimativa":true}\n```')[0]?.tipo, 'linha_do_tempo');
  assert.equal(blocosDe('```ergon-kpi\n{"tipo":"pizza","rotulo":"x","valor":1,"estimativa":true}\n```').length, 0);
  assert.equal(blocosDe('```ergon-desconhecido\n{}\n```').length, 0);
  assert.ok(n.erros.some((e) => /bloco 2: rotulo: obrigatório/.test(e)));
  const muitos = Array.from({ length: 12 }, () => cercaVisual(EXEMPLOS.kpi)).join('\n\n');
  assert.equal(normalizarVisuais(muitos).blocos.length, 8);
  // o id da enquete e do relatório nasce na normalização
  const enq = normalizarVisuais('```ergon-enquete\n{"pergunta":"Qual?","opcoes":["a","b"]}\n```', { novoId: () => 'enq_fixo' });
  assert.equal((enq.blocos[0] as { id: string }).id, 'enq_fixo');
});

test('texto dos canais e das notificações: o bloco vira números legíveis com a fonte; a prévia da lista fica numa linha', () => {
  const msg = `Fechei o mês.\n\n${cercaVisual(EXEMPLOS.barras)}\n\n${cercaVisual(EXEMPLOS.kpi)}`;
  const t = textoParaTeams(msg);
  assert.ok(!t.includes('ergon-') && !t.includes('"rotulo"'), t);
  assert.match(t, /Folha: R\$ 9\.800\n/);
  assert.match(t, /Fonte: Nubank PJ · conta 0001 \(1–20\/11\)/);
  assert.match(t, /Gastos de novembro: \*\*R\$ 18\.420,50\*\* \(▼ −8,2% vs\. outubro\)/);
  assert.equal(visuaisComoTexto(msg, { curto: true }).replace(/\s+/g, ' '), 'Fechei o mês. [gráfico: Gastos por categoria] Gastos de novembro: R$ 18.420,50');
  assert.equal(visuaisComoTexto(cercaVoto({ enquete: 'enq-1', opcao: 0 })), '(votou na enquete)');
});

test('números no padrão pt-BR: moeda, percentual, compacto e data', () => {
  assert.equal(fmtValor(1234.5, { formato: 'moeda' }), 'R$ 1.234,50');
  assert.equal(fmtValor(12.5, { formato: 'percentual' }), '12,5%');
  assert.equal(fmtValor(18420, { formato: 'moeda', curto: true }), 'R$ 18,4 mil');
  assert.equal(fmtValor('2026-11-21', { formato: 'data' }), '21/11/2026');
});

test('votos: a mensagem que é só o voto; vale o último de cada pessoa', () => {
  assert.deepEqual(votoDe(cercaVoto({ enquete: 'enq-1', opcao: 2 })), { enquete: 'enq-1', opcao: 2 });
  assert.equal(votoDe(`oi ${cercaVoto({ enquete: 'enq-1', opcao: 2 })}`), null);
  const a = apurar([{ enquete: 'e1', opcao: 0, quem: 'ana' }, { enquete: 'e1', opcao: 1, quem: 'bia' }, { enquete: 'e1', opcao: 1, quem: 'ana' }, { enquete: 'e2', opcao: 0, quem: 'caio' }], 'e1', 2);
  assert.deepEqual(a.porOpcao, [[], ['ana', 'bia']]);
  assert.equal(a.total, 2);
});

test('o prompt ensina a escolher o visual pela pergunta, com exemplos que passam na validação', () => {
  assert.match(VISUAIS_NO_PROMPT, /percentual → pizza/);
  assert.match(VISUAIS_NO_PROMPT, /satisfação ou nota → medidor/);
  for (const m of VISUAIS_NO_PROMPT.matchAll(/→ (\{"tipo".*?\}\]\})/g)) {
    const r = validarBloco(JSON.parse(m[1]));
    assert.ok(r.ok, `exemplo do prompt: ${r.ok ? '' : r.erros.join('; ')}`);
  }
});

test('PNG: o cartão de cada tipo vira imagem 2x (o Telegram e o Discord recebem), com o título e a fonte no SVG', async () => {
  for (const [tipo, b] of Object.entries(EXEMPLOS)) {
    const svg = cartaoSvg(b, { paleta: PALETAS.escuro });
    assert.ok(svg.svg.startsWith('<svg') && !svg.svg.includes('<script') && !svg.svg.includes('NaN') && !svg.svg.includes('undefined'), `${tipo}: svg`);
    if (b.titulo) assert.ok(svg.svg.includes(b.titulo.replace(/&/g, '&amp;').slice(0, 10)), `${tipo}: título no PNG`);
  }
  const png = await visualParaPng(EXEMPLOS.barras);
  assert.ok(png, 'o resvg está instalado');
  assert.equal(png.png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.w, 1440);
  assert.match(cartaoSvg(EXEMPLOS.barras, { paleta: PALETAS.claro }).svg, /Fonte: Nubank PJ/);
  assert.doesNotMatch(cartaoSvg(EXEMPLOS.barras, { paleta: PALETAS.claro, marca: null }).svg, />Ergon</);
  assert.match(cartaoSvg(EXEMPLOS.barras, { paleta: PALETAS.claro, marca: { texto: 'Acelen', ergon: false } }).svg, />Acelen</);
});

// ------------------------------------------------------------------------------------------------ SSRF

test('prévia de link: nada de endereço interno, porta estranha, usuário e senha ou esquema que não é http(s)', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) assert.ok(ipPrivado(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!ipPrivado(ip), ip);
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'ftp://exemplo.com', 'http://u:p@exemplo.com/', 'http://exemplo.com:8080/', 'http://intranet.local/', 'http://169.254.169.254/latest/meta-data/']) {
    assert.throws(() => conferirUrl(u), Recusado, u);
  }
  // o nome que aponta para dentro (inclusive só um dos endereços) é recusado: sem "DNS rebinding"
  await assert.rejects(buscarSeguro('https://interno.exemplo.com/', { resolver: async () => ['93.184.216.34', '10.0.0.5'] }), (e: unknown) => e instanceof Recusado && /interno/.test(e.motivo));
});

test('prévia de link: segue redirecionamento conferido, corta no tamanho máximo, desiste no tempo e lê os metadados', async () => {
  const srv = http.createServer((q, r) => {
    if (q.url === '/vai') { r.writeHead(302, { location: '/pagina' }); r.end(); return; }
    if (q.url === '/dentro') { r.writeHead(302, { location: 'http://169.254.169.254/' }); r.end(); return; }
    if (q.url === '/grande') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('x'.repeat(200_000)); return; }
    if (q.url === '/lento') { setTimeout(() => { r.writeHead(200); r.end('ok'); }, 1500); return; }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end('<html><head><title>Ignorado</title><meta property="og:title" content="Calend&aacute;rio de dezembro"><meta name="description" content="As datas"><meta property="og:image" content="/capa.png"><meta property="og:site_name" content="Receita"></head></html>');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  after(() => srv.close());
  const porta = (srv.address() as AddressInfo).port;
  // só nos testes: o servidor local é aceito e a porta dele também (fora daqui, nem um nem outro)
  const o = { resolver: async () => ['127.0.0.1'], confiarEm: ['127.0.0.1'] };
  const base = `http://teste.exemplo:${porta}`;
  const pega = (p: string, extra = {}) => buscarSeguroTeste(`${base}${p}`, { ...o, ...extra });
  const r = await pega('/vai');
  assert.equal(r.status, 200);
  const m = metadadosDe(r.corpo.toString('utf8'), r.url);
  assert.deepEqual(m, { titulo: 'Calendário de dezembro', descricao: 'As datas', imagem: 'http://teste.exemplo/capa.png', site: 'Receita' });
  await assert.rejects(pega('/dentro'), Recusado);
  assert.equal((await pega('/grande', { maxBytes: 1000 })).corpo.length, 1000);
  await assert.rejects(pega('/lento', { tempoMs: 300 }), Recusado);
});

/** a busca de verdade só aceita as portas 80 e 443: no teste, o servidor local numa porta alta (o resto igual) */
async function buscarSeguroTeste(url: string, o: Parameters<typeof buscarSeguro>[1]) {
  const u = new URL(url); const porta = u.port; u.port = '';
  const orig = http.request;
  (http as { request: unknown }).request = ((op: http.RequestOptions, cb: never) => orig({ ...op, port: Number(porta) }, cb)) as never;
  try { return await buscarSeguro(u.toString(), o); } finally { (http as { request: unknown }).request = orig; }
}

// ------------------------------------------------------------------------------------------------ rotas

test('rotas: a ferramenta do motor valida e devolve a cerca ou os erros; o voto vira mensagem sem chamar o agente; o relatório vira documento .md', async () => {
  const TOKEN = ['token-da-ponte', 'de-teste', 'visuais-0123'].join('-');
  const h = await harness({ bridgeToken: TOKEN });
  try {
    const s = await setupOwner(h);
    const ponte = { 'x-ergon-bridge-token': TOKEN };
    const cat = await req(h, 'POST', '/internal/bridge/v1/visual', null, { catalogo: true }, ponte);
    assert.match(cat.json.catalogo, /medidor: valor, min, max, faixas/);
    const ruim = await req(h, 'POST', '/internal/bridge/v1/visual', null, { bloco: { tipo: 'kpi', rotulo: 'X', valor: '1' } }, ponte);
    assert.equal(ruim.json.ok, false);
    assert.ok(ruim.json.erros.some((e: string) => /valor: deve ser número/.test(e)));
    const bom = await req(h, 'POST', '/internal/bridge/v1/visual', null, { bloco: EXEMPLOS.kpi }, ponte);
    assert.equal(bom.json.ok, true);
    assert.ok(bom.json.cerca.startsWith('```ergon-kpi\n{"rotulo":"Gastos de novembro"'), bom.json.cerca);
    assert.equal((await req(h, 'POST', '/internal/bridge/v1/visual', null, { bloco: EXEMPLOS.kpi }, { 'x-ergon-bridge-token': 'x'.repeat(30) })).status, 401);

    // uma conversa com uma enquete do agente: o voto entra como mensagem da pessoa, e nenhuma execução começa
    const agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? LIMIT 1', s.workspaceId)!;
    const conv = await req(h, 'POST', '/api/conversations', s, { agentId: agente.id });
    assert.equal(conv.status, 201, JSON.stringify(conv.json));
    const cid = conv.json.id as string;
    const execucoes = () => Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n);
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', ?, 'local', ?)",
      'msg_' + 'a'.repeat(32), s.workspaceId, cid, h.db.seal(s.workspaceId, `Vamos decidir:\n\n${cercaVisual(EXEMPLOS.enquete)}`), new Date().toISOString());
    const antes = execucoes();
    const v = await req(h, 'POST', `/api/conversations/${cid}/votos`, s, { enquete: 'enq-fornecedor', opcao: 1, pedido: 'pedido-voto-0001' });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(execucoes(), antes, 'votar não chama o agente');
    const msgs = (await req(h, 'GET', `/api/conversations/${cid}/messages`, s)).json as Array<{ role: string; content: string }>;
    assert.deepEqual(votoDe(msgs.at(-1)!.content), { enquete: 'enq-fornecedor', opcao: 1 });
    assert.equal((await req(h, 'POST', `/api/conversations/${cid}/votos`, s, { enquete: 'nao-existe', opcao: 0, pedido: 'pedido-voto-0002' })).status, 404);
    assert.equal((await req(h, 'POST', `/api/conversations/${cid}/votos`, s, { enquete: 'enq-fornecedor', opcao: 5, pedido: 'pedido-voto-0003' })).status, 400);

    const doc = await req(h, 'POST', '/api/visuais/relatorio/documento', s, { relatorio: EXEMPLOS.relatorio });
    assert.equal(doc.status, 200, JSON.stringify(doc.json));
    assert.equal(doc.json.nome, 'Gastos de novembro v2.md');
    const de_novo = await req(h, 'POST', '/api/visuais/relatorio/documento', s, { relatorio: EXEMPLOS.relatorio });
    assert.equal(de_novo.json.id, doc.json.id, 'abrir de novo não duplica o arquivo');
    const sem = await req(h, 'POST', '/api/visuais/relatorio/documento', s, { relatorio: { ...EXEMPLOS.relatorio, fontes: undefined, secoes: [{ titulo: 'x', blocos: [{ tipo: 'kpi', rotulo: 'a', valor: 1 }] }] } });
    assert.equal(sem.status, 422, 'o relatório também pede fonte');
    const png = await req(h, 'POST', '/api/visuais/png', s, { bloco: EXEMPLOS.medidor, tema: 'escuro' });
    assert.equal(png.status, 200);
  } finally { await h.close(); }
});

test('o relatório vira Markdown com as cercas ```ergon-<tipo> (o documento dos Entregáveis desenha, revisa e exporta)', () => {
  const md = relatorioComoMarkdown(EXEMPLOS.relatorio);
  assert.match(md, /^# Gastos de novembro/);
  assert.match(md, /```ergon-linha-do-tempo\n\{"marcos"/);
  assert.equal(blocosDe(md).length, 4);
});

test('todo agente recebe a regra dos visuais, inclusive o criado pela pessoa (nada preso a um papel)', async () => {
  const h = await harness();
  try {
    const s = await setupOwner(h);
    const novo = await req(h, 'POST', '/api/agents', s, { name: 'Temístocles', role: 'Vendas e propostas comerciais' });
    assert.ok(novo.status < 300, JSON.stringify(novo.json));
    const ids = h.db.all<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ?', s.workspaceId).map((a) => a.id);
    assert.ok(ids.length > 3);
    for (const id of ids) assert.ok(almaDoAgente(h.db, s.workspaceId, id).includes(VISUAIS_NO_PROMPT), id);
  } finally { await h.close(); }
});

test('a marca no PNG é a oficial (shared/logo-ergon.ts), sem desenho próprio, na versão clara e na escura', () => {
  assert.equal(marcaErgonSvg(false), logoSvg({ kind: 'horizontal' }));
  assert.equal(marcaErgonSvg(true), logoSvg({ kind: 'horizontal', onDark: true }));
  const claro = cartao(EXEMPLOS.kpi, { paleta: PALETAS.claro }).svg;
  const escuro = cartao(EXEMPLOS.kpi, { paleta: PALETAS.escuro }).svg;
  // o SVG oficial vai inteiro (só ganha a posição e o tamanho na raiz)
  const corpo = (x: string) => x.replace(/^<svg [^>]*>/, '');
  assert.ok(claro.includes(corpo(logoSvg({ kind: 'horizontal' }))), 'claro: a marca oficial');
  assert.ok(escuro.includes(corpo(logoSvg({ kind: 'horizontal', onDark: true }))), 'escuro: a versão oficial para fundo escuro');
  assert.ok(!cartao(EXEMPLOS.kpi, { paleta: PALETAS.claro, marca: null }).svg.includes(corpo(logoSvg({ kind: 'horizontal' }))));
});

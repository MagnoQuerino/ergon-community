/**
 * A trava "depois de ler conteúdo privado" usa os nomes REAIS das ferramentas do motor. Os nomes vêm do fixture
 * test/fixtures/hermes-v0.22.2-ferramentas.json, tirado do toolsets.py do Hermes fixado na imagem; dentro da imagem,
 * hermes/tests/test_ergon_bridge_conformidade.py falha se o fixture divergir do Hermes instalado. Assim, uma ferramenta
 * nova (ou renomeada) numa versão do motor não passa sem que a trava a cubra: foi o que aconteceu com 'process' (o nome
 * real é process_manage) e com 'web_crawl' (não existe).
 *
 * A comparação é a do plugin do motor (ergon_bridge, _negada): o nome exato, ou um prefixo quando a entrada termina em "_".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { BLOQUEADAS_DEPOIS_DE_LER, leEndereco } from '../src/services/conexoes/regra.ts';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'hermes-v0.22.2-ferramentas.json'), 'utf8')) as {
  hermes: string; toolsets: Record<string, string[]>;
};
const TS = FIXTURE.toolsets;
/** a mesma regra do plugin: nome exato, ou prefixo se a entrada termina em "_" */
const negada = (tool: string) => [...BLOQUEADAS_DEPOIS_DE_LER].some((d) => tool === d || (d.endsWith('_') && d.length > 1 && tool.startsWith(d)));
/** A única exceção de propósito: a busca na web segue valendo (a consulta vai ao buscador, o agente só recebe resultados). */
const SEGUEM = new Set(['web_search']);
/** os grupos que alcançam endereços arbitrários ou executam código */
// image_gen ficou de fora de propósito (decisão de 08/11: uso livre da geração de imagem)
const GRUPOS = ['web', 'terminal', 'code_execution', 'browser', 'vision'];
const TODAS = new Set(Object.values(TS).flat());

describe('trava depois de ler conteúdo privado: nomes do Hermes de verdade', () => {
  test('a geração de imagem fica livre (decisão de 08/11)', () => {
    assert.ok(TS.image_gen?.includes('image_generate'));
    assert.ok(!negada('image_generate'));
  });

  test('o fixture traz os grupos que a trava cobre', () => {
    assert.equal(FIXTURE.hermes, '0.22.2');
    for (const g of GRUPOS) assert.ok(Array.isArray(TS[g]) && TS[g].length > 0, `o fixture não tem o grupo ${g}`);
  });

  test('toda ferramenta de web, terminal, execução de código, navegador e visão está coberta', () => {
    const fora = GRUPOS.flatMap((g) => TS[g].filter((t) => !negada(t) && !SEGUEM.has(t)).map((t) => `${g}: ${t}`));
    assert.deepEqual(fora, [], `ferramentas do motor sem a trava: ${fora.join(', ')}`);
  });

  test('process_manage (do grupo terminal) é barrada', () => {
    assert.ok(TS.terminal.includes('process_manage'));
    assert.ok(negada('process_manage'));
  });

  test('o navegador inteiro cai pelo prefixo, inclusive o que roda JavaScript na página', () => {
    assert.ok(BLOQUEADAS_DEPOIS_DE_LER.has('browser_'));
    for (const t of ['browser_console', 'browser_cdp', 'browser_exec', 'browser_vault', 'browser_get_images', 'browser_dialog']) assert.ok(negada(t), t);
    assert.ok(negada('browser_ferramenta_de_uma_versao_nova'), 'o prefixo vale para o que vier depois');
  });

  test('a busca na web segue valendo, e as Conexões também', () => {
    assert.ok(!negada('web_search'));
    assert.ok(!negada('conexoes_listar') && !negada('conexoes_executar'));
    assert.ok(!negada('todo_list') && !negada('skill_view'));
  });

  test('nenhum nome inventado: cada entrada existe no motor (ou, se prefixo, pega alguma ferramenta dele)', () => {
    const fantasmas = [...BLOQUEADAS_DEPOIS_DE_LER].filter((d) => (d.endsWith('_') ? ![...TODAS].some((t) => t.startsWith(d)) : !TODAS.has(d)));
    assert.deepEqual(fantasmas, [], `nomes que não existem no Hermes ${FIXTURE.hermes}: ${fantasmas.join(', ')}`);
  });

  test('ler pela web ou pelo navegador marca conteúdo de fora; imagem em data: não', () => {
    for (const t of [...TS.web, ...TS.browser]) assert.ok(leEndereco(t), t);
    assert.ok(leEndereco('vision_analyze', 'https://exemplo.com/a.png'));
    assert.ok(!leEndereco('vision_analyze', 'data:image/png;base64,AAAA'));
  });
});

const HERMES = path.resolve(import.meta.dirname, '..', '..', 'hermes');
describe('versão do plugin do motor: uma só', { skip: !fs.existsSync(path.join(HERMES, 'plugins', 'ergon_bridge', '__init__.py')) && 'o plugin do motor não vem nesta cópia (imagem de teste)' }, () => {
  test('plugin.yaml, PLUGIN_VERSION do código e o rótulo da imagem dizem a mesma versão', () => {
    const yaml = fs.readFileSync(path.join(HERMES, 'plugins', 'ergon_bridge', 'plugin.yaml'), 'utf8').match(/^version:\s*"?([0-9.]+)"?\s*$/m)?.[1];
    const code = fs.readFileSync(path.join(HERMES, 'plugins', 'ergon_bridge', '__init__.py'), 'utf8').match(/^PLUGIN_VERSION = "([0-9.]+)"$/m)?.[1];
    const label = fs.readFileSync(path.join(HERMES, 'Dockerfile'), 'utf8').match(/^LABEL ergon\.plugin\.version="([0-9.]+)"$/m)?.[1];
    assert.ok(yaml && code && label, `faltou a versão em algum lugar: yaml=${yaml} código=${code} rótulo=${label}`);
    assert.equal(code, yaml);
    assert.equal(label, yaml);
  });
});

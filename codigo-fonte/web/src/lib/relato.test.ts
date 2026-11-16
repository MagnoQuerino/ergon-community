import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATEGORIAS, DADOS_TECNICOS, FORM_VAZIO, anotarCodigoErro, categoriaDoEndereco, codigosRecentes, enderecoDoRelato, falhaDoEnvio, faltaNoRelato, pedidoDoRelato, sistemaDoNavegador, textoDoRelato } from './relato.ts';

const OK = { ...FORM_VAZIO, categoria: 'erro' as const, titulo: 'Não abre', descricao: 'A janela fica em branco.' };

test('as categorias e as chaves dos dados técnicos são as do servidor (e do receptor)', () => {
  const srv = readFileSync(new URL('../../../server/src/services/relatos.ts', import.meta.url), 'utf8');
  for (const c of CATEGORIAS) assert.match(srv, new RegExp(`'${c}'`));
  const chaves = /CHAVES_DIAGNOSTICO = \[([^\]]+)\]/.exec(srv)![1].match(/'(\w+)'/g)!.map((x) => x.slice(1, -1));
  assert.deepEqual(DADOS_TECNICOS.map((k) => k.split('.').at(-1)), chaves, 'a lista na tela é exatamente o que entra');
});

test('falta: categoria, título (5) e descrição (10); o resto é opcional', () => {
  assert.equal(faltaNoRelato(FORM_VAZIO), 'ajuda.relato.falta.categoria');
  assert.equal(faltaNoRelato({ ...OK, titulo: ' abc ' }), 'ajuda.relato.falta.titulo');
  assert.equal(faltaNoRelato({ ...OK, descricao: 'curta' }), 'ajuda.relato.falta.descricao');
  assert.equal(faltaNoRelato(OK), null);
});

test('dados técnicos desligados por padrão: o pedido não leva códigos de erro', () => {
  assert.equal(FORM_VAZIO.dadosTecnicos, false);
  anotarCodigoErro('world_offline');
  const p = pedidoDoRelato({ ...OK, passos: '  ' }, 'linux');
  assert.deepEqual(Object.keys(p).sort(), ['categoria', 'descricao', 'sistema', 'titulo']);
  const q = pedidoDoRelato({ ...OK, dadosTecnicos: true, esperado: 'abrir' }, 'windows');
  assert.equal(q.dadosTecnicos, true);
  assert.deepEqual(q.codigosErro, ['world_offline']);
  assert.equal(q.esperado, 'abrir');
});

test('códigos de erro: só o formato de código, sem repetir, os 20 últimos', () => {
  anotarCodigoErro('Mensagem livre com nome'); anotarCodigoErro('a@b.com');
  for (let i = 0; i < 25; i++) anotarCodigoErro(`c${i}`);
  anotarCodigoErro('c3');
  const r = codigosRecentes();
  assert.equal(r.length, 20); assert.equal(r.at(-1), 'c3');
  assert.ok(r.every((c) => /^[a-z0-9_.]{1,60}$/.test(c)));
});

test('do card de erro: a categoria vem no endereço', () => {
  assert.equal(enderecoDoRelato('erro'), '#ajuda?relatar=erro');
  assert.equal(categoriaDoEndereco('#ajuda?relatar=conexao'), 'conexao');
  assert.equal(categoriaDoEndereco('#ajuda?relatar'), '');
  assert.equal(categoriaDoEndereco('#ajuda?relatar=hack'), '');
});

test('sistema pelo navegador; a prévia e o "Copiar texto" são o JSON exato; cada falha tem a sua frase', () => {
  assert.equal(sistemaDoNavegador('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(sistemaDoNavegador('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'macos');
  assert.equal(sistemaDoNavegador('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(sistemaDoNavegador('Mozilla/5.0 (Linux; Android 14)'), 'outro');
  const relato = { titulo: 'x', diagnostico: { idioma: 'pt-BR' } };
  assert.deepEqual(JSON.parse(textoDoRelato(relato)), relato);
  assert.equal(falhaDoEnvio('relato_limite'), 'ajuda.relato.erro.limite');
  assert.equal(falhaDoEnvio('relato_offline'), 'ajuda.relato.erro.naoEnviado');
  assert.equal(falhaDoEnvio(''), 'ajuda.relato.erro.naoEnviado');
  assert.equal(falhaDoEnvio('relato_indisponivel'), 'ajuda.relato.indisponivel');
});

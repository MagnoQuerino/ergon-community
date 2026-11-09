// Tela de abertura do Ergon Desktop (desktop/ui/abertura.js), no fluxo "Voltar para esta versão": roda o script de
// verdade com uma página de mentira e um aplicativo de mentira (invoke/listen), para provar que nada troca de versão
// sem a confirmação da pessoa, que a recusa explica e não oferece voltar, e que sem backup só segue com outro clique.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const SCRIPT = fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/ui/abertura.js'), 'utf8');

interface El { id?: string; textContent: string; hidden: boolean; disabled?: boolean; className?: string; children: El[]; click?: () => void }

function tela(hash: string, respostas: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const els = new Map<string, El>();
  const el = (id?: string): El => {
    const e: El & Record<string, unknown> = {
      id, textContent: '', hidden: false, children: [],
      classList: { toggle() {} }, style: {}, setAttribute() {}, focus() {},
      replaceChildren(...c: El[]) { e.children = c; },
      append(c: El) { e.children.push(c); },
      querySelector() { return e.children[0] ?? null; },
      addEventListener(t: string, f: () => void) { if (t === 'click') e.click = f; },
    };
    return e;
  };
  const chamadas: Array<[string, Record<string, unknown> | undefined]> = [];
  const ouvintes = new Map<string, (ev: { payload: unknown }) => void>();
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
      createElement: () => el(),
    },
    location: { hash, pathname: '/index.html' },
    history: { replaceState() { (ctx.location as { hash: string }).hash = ''; } },
    matchMedia: () => ({ matches: true }), // "menos movimento": frases inteiras, sem relógio
    addEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, // os prazos nunca vencem aqui
    console,
  };
  ctx.window = ctx;
  ctx.__TAURI__ = {
    core: { invoke: async (cmd: string, args?: Record<string, unknown>) => { chamadas.push([cmd, args === undefined ? undefined : JSON.parse(JSON.stringify(args))]); /* objetos de outro "realm": só os dados */ return respostas[cmd]?.(args); } },
    event: { listen: (nome: string, f: (ev: { payload: unknown }) => void) => { ouvintes.set(nome, f); } },
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  const doc = ctx.document as { getElementById: (id: string) => El };
  const $ = (id: string) => doc.getElementById(id);
  return {
    chamadas, $,
    botoes: () => $('acoes').children.map((b) => b.textContent),
    clicar: (rotulo: string) => { const b = $('acoes').children.find((x) => x.textContent === rotulo); assert.ok(b, `botão ${rotulo}`); b.click!(); },
    emitir: (nome: string, payload: unknown) => ouvintes.get(nome)!({ payload }),
  };
}
const esperar = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const DIAG = { estado: 'parado', titulo: 'O Ergon está desligado', explicacao: '', avisos: [], detalhes: [], acoes: ['tentar'], confirmado: false };

test('voltar: confere, avisa e só troca depois do clique em confirmar', async () => {
  const t = tela('#voltar=1.1.0-rc.23', { avaliar_volta: () => ({ pode: true, atual: '1.1.0-rc.25', alvo: '1.1.0-rc.23', motivo: null }), diagnosticar: () => DIAG });
  await esperar();
  assert.deepEqual(t.chamadas, [['avaliar_volta', { versao: '1.1.0-rc.23' }]], 'só confere; nada muda');
  assert.equal(t.$('titulo').textContent, 'Voltar para a 1.1.0-rc.23?');
  assert.match(t.$('texto').textContent, /backup/);
  assert.ok(t.$('avisos').children.some((li) => /pode não abrir/.test(li.textContent)), 'avisa que os dados da mais nova podem não abrir');
  // o backup não é prometido como saída que a pessoa não alcança: diz o que leva, o que não leva e que não há botão para trazer de volta
  const avisos = t.$('avisos').children.map((li) => li.textContent).join(' ');
  assert.doesNotMatch(avisos, /É por isso que o backup vem antes/);
  assert.match(avisos, /memória dos agentes não entra/);
  assert.match(avisos, /ainda não tem um botão/);
  assert.deepEqual(t.botoes(), ['Cancelar', 'Sim, voltar para a 1.1.0-rc.23'], 'Cancelar primeiro (o foco começa nele)');
  t.clicar('Sim, voltar para a 1.1.0-rc.23');
  await esperar();
  assert.deepEqual(t.chamadas.at(-1), ['voltar_versao', { versao: '1.1.0-rc.23', semBackup: false }]);
  // etapas chegam como as da atualização; a da equipe ganha a sua fase
  t.emitir('instalacao:etapa', 'equipe');
  assert.equal(t.$('fase').textContent, 'Atualizando a equipe');
  t.emitir('servicos:linha', 'Ligando o motor de contêineres do ambiente…');
  assert.equal(t.$('fase').textContent, 'Atualizando a equipe', 'linhas técnicas não trocam a fase no meio da volta');
});

test('backup não feito: nada mudou; seguir sem backup é outro clique, de propósito', async () => {
  const t = tela('#voltar=1.1.0-rc.23', { avaliar_volta: () => ({ pode: true, atual: '1.1.0-rc.25', alvo: '1.1.0-rc.23', motivo: null }), diagnosticar: () => DIAG });
  await esperar();
  t.clicar('Sim, voltar para a 1.1.0-rc.23');
  await esperar();
  t.emitir('servicos:fim', { ok: false, mensagem: 'SEM_BACKUP:Não deu para fazer o backup dos seus dados agora. Nada foi mudado.' });
  assert.equal(t.$('titulo').textContent, 'O backup não deu certo');
  assert.equal(t.$('texto').textContent, 'Não deu para fazer o backup dos seus dados agora. Nada foi mudado.', 'sem a marca técnica na tela');
  assert.deepEqual(t.botoes(), ['Cancelar', 'Tentar o backup de novo', 'Voltar mesmo sem backup', 'Ver diagnóstico']);
  t.clicar('Voltar mesmo sem backup');
  await esperar();
  assert.deepEqual(t.chamadas.at(-1), ['voltar_versao', { versao: '1.1.0-rc.23', semBackup: true }]);
});

test('não dá para voltar (antiga demais): explica e não oferece voltar', async () => {
  const motivo = 'A 1.1.0-rc.9 é antiga demais para voltar com segurança.';
  const t = tela('#voltar=1.1.0-rc.9', { avaliar_volta: () => ({ pode: false, atual: '1.1.0-rc.25', alvo: '1.1.0-rc.9', motivo }), diagnosticar: () => DIAG });
  await esperar();
  assert.equal(t.$('texto').textContent, motivo);
  assert.deepEqual(t.botoes(), ['Cancelar']);
  assert.ok(!t.chamadas.some(([c]) => c === 'voltar_versao'));
});

test('versão que não veio no endereço: a tela diz que não reconheceu, sem perguntar ao aplicativo', async () => {
  const t = tela('#voltar=', { diagnosticar: () => DIAG });
  await esperar();
  assert.match(t.$('texto').textContent, /não foi reconhecida/);
  assert.deepEqual(t.chamadas, []);
  assert.deepEqual(t.botoes(), ['Cancelar']);
});

// O Rust do aplicativo só compila na CI (job Desktop); aqui, ao menos, a ligação das travas no lugar certo.
test('aplicativo: a troca desfaz em qualquer falha antes de religar, e a trava de segurança falha fechada', () => {
  const rs = fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/src-tauri/src/atualizacao.rs'), 'utf8');
  const corpo = (nome: string) => { const i = rs.indexOf(`fn ${nome}(`); assert.ok(i >= 0, nome); return rs.slice(i, rs.indexOf('\n}\n', i)); };
  const troca = corpo('trocar_pacote');
  const guardou = troca.indexOf('cp -a /opt/ergon-pacote');
  const desfaz = troca.indexOf('ou_desfaz(|| entregar(m, versao, pacote, &mut *ev), por_de_volta_o_anterior)?');
  assert.ok(guardou >= 0 && desfaz > guardou, 'entregar, prender as imagens e ligar: tudo dentro do desfazer, depois de guardar o de antes');
  assert.ok(desfaz < troca.indexOf('let ligou = instalar'), 'antes de religar');
  assert.doesNotMatch(troca, /ambiente::entregar_pacote|ambiente::fixar_imagens|ligar_motor_de_conteineres/, 'nada fora do desfazer');
  const conferir = corpo('conferir_volta');
  assert.match(conferir, /let canal = canal_publicado\(\)\?;/, 'sem o manifesto do canal conferido, a volta não é feita');
  assert.match(conferir, /let piso = piso_de_seguranca\(&canal\);/);
  // só as duas versões publicadas logo antes da instalada (decisão de 09/11), pela lista assinada do canal
  const duas = conferir.indexOf('fora_das_duas_anteriores(alvo, instalada.as_deref().unwrap_or(""), canal.get("recentes"))');
  assert.ok(duas > 0 && duas < conferir.indexOf('manifesto_da_versao(alvo)?'), 'antes de baixar o pacote da versão escolhida');
  assert.match(corpo('canal_publicado'), /canal_conferido\(baixado, &o\)/);
  assert.doesNotMatch(corpo('canal_conferido'), /\.ok\(\)\?/, 'nenhuma falha vira "sem piso"');
});

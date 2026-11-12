// Cartões pedidos pelo agente e trabalho contínuo (rc.27): o que a tela precisa garantir, lido no código.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pt from '../i18n/pt/conversas.ts';
import en from '../i18n/en/conversas.ts';

const codigo = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('cartão protegido: campo de senha, valor só pela rota própria, nunca guardado na tela', () => {
  const c = codigo('components/ChatCards.tsx');
  const card = c.slice(c.indexOf('export function SecretCard'));
  assert.match(card, /type="password"/, 'o valor é digitado num campo de senha');
  assert.match(card, /autoComplete="new-password"/, 'o navegador não preenche nem sugere');
  assert.match(card, /\/api\/proposals\/\$\{p\.id\}\/segredo/, 'vai pela rota do cofre');
  assert.match(card, /setValor\(''\)/, 'o campo limpa depois de entregar');
  assert.doesNotMatch(card, /localStorage|sessionStorage|DRAFTS/, 'nada do valor fica guardado na tela');
  assert.match(card, /conversas\.segredo\.riscoSudo/, 'a senha de administrador vem com o aviso de risco');
  assert.match(card, /conversas\.segredo\.guardarSudo/, 'e a escolha de guardar, desmarcada por padrão');
  assert.match(card, /useState\(false\)/);
});

test('os cartões aparecem na conversa, no card e em "Aguardando você"', () => {
  assert.match(codigo('components/ChatPanel.tsx'), /p\.kind === 'segredo' \? <SecretCard/);
  const td = codigo('components/TaskDetail.tsx');
  assert.match(td, /<SecretCard key=\{c\.id\}/);
  assert.match(td, /<QuestionCard key=\{c\.id\}/);
  assert.match(codigo('components/DecisionsPanel.tsx'), /p\.kind === 'question' \|\| p\.kind === 'segredo'/);
  assert.match(codigo('views/SegurancaPanel.tsx'), /\/api\/seguranca\/chaves/, 'Configurações › Segurança lista e apaga');
});

test('trabalho contínuo: as cinco ações à vista, cada uma com a linha que explica e o aviso de custo, nas duas línguas', () => {
  const c = codigo('components/Comandos.tsx');
  assert.match(c, /const TIPOS: TipoComando\[\] = \['meta', 'repetir', 'checagem', 'comentar', 'revisao'\]/);
  assert.match(c, /conversas\.comando\.linha\.\$\{aberto\}/);
  assert.match(c, /conversas\.comando\.custo\.\$\{aberto\}/);
  for (const k of ['meta', 'repetir', 'checagem', 'comentar', 'revisao'] as const) {
    for (const d of [pt, en] as Array<Record<string, unknown>>) {
      assert.ok(d[`comando.nome.${k}`] && d[`comando.linha.${k}`] && d[`comando.custo.${k}`], `${k} sem nome, linha ou custo`);
    }
  }
  // os atalhos com os nomes do Ergon e os originais
  for (const n of ['/meta · /goal', '/repetir · /loop', '/checagem · /heartbeat', '/comentar · /btw', '/revisao · /review']) assert.ok(c.includes(n), n);
  assert.match(codigo('components/ChatPanel.tsx'), /<ComandosBar compacto/, 'na conversa');
  assert.match(codigo('components/TaskDetail.tsx'), /<ComandosBar listaUrl=\{`\/api\/comandos\?taskId=/, 'e no card');
});

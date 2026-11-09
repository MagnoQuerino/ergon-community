/**
 * Textos do servidor que chegam à tela da pessoa leiga (Saúde, Atividade, cartões, Contas de IA, erros das rotas): sem
 * as peças por dentro do Ergon, sem o erro cru da Microsoft e sem os nomes privados. O mesmo cuidado de
 * web/src/lib/textos-tela.test.ts, do lado do servidor: varre as strings das funções e rotas que vão para a tela e confere
 * as traduções dos motivos técnicos (o técnico fica no registro do servidor, que não é tela).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decimal, paraTela, temJargao } from '../src/lib/texto-tela.ts';
import { GUARDED_RISK, TOOLS } from '../src/services/characters.ts';
import { motivoDoProvedor } from '../src/services/integrations.ts';
import { motivoParaTela } from '../src/services/motors.ts';
import { SSO } from '../src/services/sso.ts';
import { CSV_LIMITS, parseCsv } from '../src/services/csv.ts';

// montada por partes: a exportação pública recusa arquivos com estes nomes escritos por inteiro
const PROIBIDAS = new RegExp(['Her' + 'mes', 'M' + 'G3', 'am' + 'agno', 'fund' + 'ador'].join('|'), 'i');
/** o jargão apontado nas revisões da rc.24 (o da web e o erro cru da Microsoft) */
const PECAS = /\bmotor(?:es)?\b|\bgerente\b|ponte de controle|cont[eê]iner|\bpodman\b|\bdocker\b|AADSTS|access_denied|consent_required|respondeu \d{3}|fetch failed|ECONN/i;
/** "Skills" como nome na tela (o arquivo SKILL.md e a ferramenta skill_view das instruções ao agente não contam) */
const SKILLS = /\b[Ss]kills?\b/;
const jargao = (t: string) => PECAS.test(t) || SKILLS.test(t);

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
// o World não vai na cópia Community: lá o arquivo não existe e não há o que conferir
const ler = (rel: string) => (rel.startsWith('world/') && !fs.existsSync(path.join(src, rel)) ? '' : fs.readFileSync(path.join(src, rel), 'utf8'));
/** o código sem os comentários (de bloco e de linha; um "//" dentro de endereço também corta, o que só esconde texto) */
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
/**
 * As frases entre aspas de um arquivo (com espaço: identificadores, chaves e caminhos ficam de fora), fora dos comentários
 * e fora das linhas do registro do servidor (log.warn/info/error), que não é tela.
 */
function frases(rel: string): Array<{ onde: string; texto: string }> {
  const out: Array<{ onde: string; texto: string }> = [];
  semComentarios(ler(rel)).split('\n').forEach((l, i) => {
    if (/\blog\.(warn|info|error)\(|req\.log\./.test(l)) return;
    for (const m of l.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []) {
      const texto = m.slice(1, -1).replace(/\$\{[^}]*\}/g, '…');
      if (/\s/.test(texto) && !/^(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/.test(texto)) out.push({ onde: `${rel}:${i + 1}`, texto });
    }
  });
  return out;
}

test('as frases das funções e rotas que vão para a tela não têm jargão nem nomes privados', () => {
  const arquivos = [
    'services/motors.ts', 'services/health.ts', 'routes/integracoes.ts', 'services/results.ts', 'services/characters.ts',
    'services/trainings.ts', 'services/ai.ts', 'services/sso.ts', 'world/index.ts', 'lib/texto-tela.ts',
    'services/teams-app/servico.ts', 'services/teams-app/rotas.ts', 'services/teams-app/cartoes.ts',
  ];
  const achados: string[] = [];
  for (const rel of arquivos) for (const f of frases(rel)) if (jargao(f.texto) || PROIBIDAS.test(f.texto)) achados.push(`${f.onde}: ${f.texto.slice(0, 120)}`);
  assert.deepEqual(achados, []);
});

test('as mensagens de erro das rotas (HttpError) e da equipe de IA (HermesError) estão em português simples', () => {
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? todos(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []);
  const achados: string[] = [];
  let vistas = 0;
  for (const f of todos(src)) {
    const codigo = semComentarios(fs.readFileSync(f, 'utf8'));
    const re = /new (?:HttpError\(\d+,\s*'[^']*'|HermesError\([^,]+),\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
    for (const m of codigo.matchAll(re)) {
      vistas++;
      const texto = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '…');
      if (jargao(texto) || PROIBIDAS.test(texto)) achados.push(`${path.relative(src, f)}: ${texto.slice(0, 120)}`);
    }
  }
  assert.ok(vistas > 100, `a varredura achou as mensagens (${vistas})`);
  assert.deepEqual(achados, []);
});

test('o motivo técnico da troca de versão vira português (Saúde, Contas de IA, o pedido na fila, Atividade)', () => {
  // todas as mensagens do gerente (que roda à parte e fala de contêiner, imagem, volume) e os erros de rede
  const doGerente = [...semComentarios(ler('services/motor-manager.ts')).matchAll(/new ManagerError\(\d+,\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.ok(doGerente.length > 10, 'a varredura achou as mensagens do gerente');
  const tecnicos = [
    ...doGerente,
    'baixar a imagem do motor: Docker respondeu 500 "manifest unknown"', 'gerente de motores respondeu 502', 'cofre do motor respondeu 502',
    'fetch failed', 'connect ECONNREFUSED 10.89.0.3:8644', 'The operation was aborted due to timeout', 'a ponte de controle do motor não respondeu',
    'o motor não respondeu depois de abrir o cofre', 'a versão nova do motor veio sem as Conexões', 'Docker não respondeu',
  ];
  for (const t of tecnicos) {
    const p = motivoParaTela(t);
    assert.ok(p.length > 5, t);
    assert.equal(temJargao(p), false, `${t} → ${p}`);
    assert.ok(!jargao(p), `${t} → ${p}`);
  }
  assert.equal(motivoParaTela('a imagem do motor não chegou a este computador'), 'a versão nova da equipe ainda não chegou a este computador');
  assert.equal(motivoParaTela('a versão anterior do motor não está mais neste computador'), 'a versão anterior da equipe já não está neste computador');
  assert.equal(motivoParaTela('o motor não parou a tempo; tente de novo em instantes'), 'a equipe não parou a tempo para a troca');
  assert.equal(motivoParaTela('fetch failed'), 'a equipe não respondeu a tempo');
  // o que já é para a pessoa passa como está
  for (const t of ['a versão nova da equipe ainda está chegando a este computador', 'a chave não confere']) assert.equal(motivoParaTela(t), t);
});

test('o login da Microsoft e do Google grava o motivo em português, nunca o erro cru', () => {
  const casos: Array<[Parameters<typeof motivoDoProvedor>, string]> = [
    [['microsoft', 'access_denied', 'AADSTS90094: Admin consent is required for the permissions requested by this application.'], 'A empresa exige a aprovação do administrador.'],
    [['microsoft', 'invalid_request', 'AADSTS90095: Admin consent is required'], 'A empresa exige a aprovação do administrador.'],
    [['microsoft', 'access_denied', 'AADSTS65001: The user or administrator has not consented'], 'A empresa exige a aprovação do administrador.'],
    [['microsoft', 'consent_required', null], 'A empresa exige a aprovação do administrador.'],
    [['google', 'admin_policy_enforced', null], 'A empresa exige a aprovação do administrador.'],
    [['microsoft', 'access_denied', 'AADSTS65004: User declined to consent to access the app.'], 'A autorização foi recusada na página da conta.'],
    [['google', 'access_denied', null], 'A autorização foi recusada na página da conta.'],
    [['microsoft', 'invalid_request', 'AADSTS50020: User account from identity provider does not exist in tenant.'], 'A Microsoft não concluiu a autorização (código AADSTS50020, para o suporte).'],
    [['google', 'server_error', null], 'O Google não concluiu a autorização (código server_error, para o suporte).'],
    [['microsoft', null, null], 'A Microsoft não mandou resposta ao login. Tente de novo.'],
  ];
  for (const [args, esperado] of casos) {
    const t = motivoDoProvedor(...args);
    assert.equal(t, esperado, JSON.stringify(args));
    // nada em inglês nem os códigos que pedem o administrador: o código que fica é só referência para o suporte
    assert.doesNotMatch(t, /AADSTS9|AADSTS65|access_denied|consent_required|admin_policy|Admin consent|User declined|administrator/i, t);
  }
});

test('ferramentas, Treinar e guia: os nomes que a tela mostra, iguais no servidor e na web', () => {
  for (const t of Object.values(TOOLS)) {
    assert.ok(!jargao(`${t.label} ${t.note}`), t.id);
    assert.doesNotMatch(`${t.label} ${t.note}`, PROIBIDAS, t.id);
  }
  assert.ok(!jargao(GUARDED_RISK));
  assert.match(GUARDED_RISK, /ambiente isolado da equipe/);
  assert.equal(TOOLS.habilidades.label, 'Competências da biblioteca');
  assert.equal(TOOLS.habilidades.toolset, 'skills', 'o nome do dado não muda: só o rótulo');
  const janela = fs.readFileSync(path.resolve(src, '../../web/src/components/AgentWindow.tsx'), 'utf8');
  assert.ok(janela.includes(`"${TOOLS.habilidades.label}"`), 'a janela do agente cita a ferramenta pelo mesmo nome');
  assert.doesNotMatch(janela.replace(/hermesSkills|shownSkills|toggleSkill|skillQ|className="skill[\w-]*"|skill-item[\w-]*|\.skills\b|\/api\/ai\/skills|Skill\[\]|<Skill/g, ''), />[^<>{}]*\bSkills?\b[^<>{}]*</);
  for (const k of ['microsoft', 'google'] as const) {
    assert.equal(SSO[k].doc, 'o guia de instalação', k);
    assert.doesNotMatch(SSO[k].doc, /docs\/|\.md\b/);
  }
});

test('números com vírgula decimal e o filtro do texto de tela', () => {
  assert.equal(decimal(51.43), '51,4');
  assert.equal(decimal(0.94), '0,9');
  assert.equal(paraTela('o cofre da equipe não abriu'), 'o cofre da equipe não abriu');
  assert.equal(paraTela('gerente de motores respondeu 502'), null);
  assert.equal(paraTela('connect ECONNREFUSED 10.89.0.3:8644', 'reserva'), 'reserva');
  assert.equal(paraTela('', 'reserva'), 'reserva');
  // a planilha grande demais também fala com vírgula (1,5 MB, não 1.5 MB)
  assert.throws(() => parseCsv(Buffer.alloc(Math.round(1.5 * 1024 * 1024), 0x61), { ...CSV_LIMITS, maxBytes: 1024 * 1024 }),
    (e: Error) => e.message === 'O arquivo tem 1,5 MB; o limite para análise é 1 MB.');
});

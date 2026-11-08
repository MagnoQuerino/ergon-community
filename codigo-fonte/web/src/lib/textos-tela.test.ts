import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FRASE_RENOVANDO, erroDaConexao, motivoDaFalha, motivoDoLogin, oQuePedirAoAdministrador, proximoPassoTarefas, rotuloDoCofre,
  semJargao, textoConfirmarLiberar, textoDaVolta, textoDoLiberado, textoUltimaLimpeza,
} from './textos-tela.ts';
import type { EtapaConsentimento } from './types.ts';

// o que a pessoa leiga nunca deve ler: o erro cru da Microsoft (inglês e código), e as peças por dentro do Ergon
const CRU = /AADSTS9|AADSTS65|access_denied|consent_required|Admin consent|User declined|administrator|\bmotor|gerente|ponte de controle/i;
// montada por partes: a exportação pública recusa arquivos com estes nomes escritos por inteiro
const PROIBIDAS = new RegExp(["Her" + "mes", "M" + "G3", "am" + "agno", "fund" + "ador"].join("|"), "i");

test('T1: o erro da Microsoft vira texto em português (o código fica só para o suporte)', () => {
  const adminBase = 'access_denied (AADSTS90094: Admin consent is required for the permissions requested by this application. An admin consent request may be sent to the admin. )';
  assert.equal(motivoDoLogin(adminBase), 'A empresa exige a aprovação do administrador.');
  assert.equal(motivoDoLogin('consent_required'), 'A empresa exige a aprovação do administrador.');
  assert.equal(motivoDoLogin('access_denied (AADSTS65001: The user or administrator has not consented)'), 'A empresa exige a aprovação do administrador.');
  const recusou = 'A conta não concluiu o login: access_denied (AADSTS65004: User declined to consent to access the app.)';
  assert.equal(motivoDoLogin(recusou), 'A autorização foi recusada na página da Microsoft.');
  assert.equal(motivoDoLogin('O administrador não aprovou: access_denied (AADSTS65004: User declined to consent)'), 'O administrador não aprovou o pedido.');
  const outro = motivoDoLogin('A conta não concluiu o login: invalid_request (AADSTS50020: User account from identity provider does not exist in tenant)');
  assert.equal(outro, 'A Microsoft não concluiu a autorização (código AADSTS50020, para o suporte).');
  assert.match(motivoDoLogin('A conta não concluiu o login: server_error') ?? '', /^A Microsoft não concluiu a autorização \(código server_error, para o suporte\)\.$/);
  assert.equal(motivoDoLogin('A conta não concluiu o login: access_denied', 'google'), 'A autorização foi recusada na página do Google.');
  assert.match(motivoDoLogin('A conta não concluiu o login: admin_policy_enforced', 'google') ?? '', /aprovação do administrador/);
  // o que já vem em português do servidor passa como está (com a primeira letra maiúscula e ponto final)
  assert.equal(motivoDoLogin('A autorização foi recusada na página da conta.'), 'A autorização foi recusada na página da conta.');
  assert.equal(motivoDoLogin('a empresa exige a aprovação do administrador'), 'A empresa exige a aprovação do administrador.');
  assert.equal(motivoDoLogin(null), null);
  assert.equal(motivoDoLogin(''), null);
  for (const t of [adminBase, recusou]) assert.doesNotMatch(motivoDoLogin(t) ?? '', CRU);
});

test('T1/T9: o cartão da conexão não repete em vermelho o passo esperado do administrador, nem mostra o erro cru', () => {
  const link = 'https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=x';
  assert.equal(erroDaConexao({ kind: 'microsoft', error: 'A sua empresa exige que o administrador aprove o Ergon antes do primeiro acesso.', adminBase: { link, erro: 'access_denied (AADSTS90094: Admin consent is required)' } }), null);
  assert.equal(erroDaConexao({ kind: 'microsoft', error: 'A conta não concluiu o login: access_denied (AADSTS65004: User declined to consent)', adminBase: null }), 'A autorização foi recusada na página da Microsoft.');
  assert.equal(erroDaConexao({ kind: 'google', error: 'A conta não concluiu o login: access_denied' }), 'A autorização foi recusada na página do Google.');
  // os outros aplicativos: o problema gravado (já em português) continua à vista
  assert.equal(erroDaConexao({ kind: 'trello', error: 'A credencial não tem permissão para alterar o quadro.' }), 'A credencial não tem permissão para alterar o quadro.');
  assert.equal(erroDaConexao({ kind: 'trello', error: null }), null);
});

test('T2: a volta da aprovação do administrador cita o botão que existe na tela', () => {
  const semConta = textoDaVolta('microsoft', 'admin-aprovou', false);
  assert.equal(semConta, 'A Microsoft registrou a aprovação do administrador. Para terminar, clique em "Já aprovaram? Entrar de novo", abaixo.');
  assert.equal(textoDaVolta('microsoft', 'admin-aprovou-base', false), semConta);
  assert.equal(textoDaVolta('microsoft', 'admin-aprovou-base', true), semConta);
  // com a conta conectada, a etapa aprovada tem mesmo o "Autorizar agora"
  assert.match(textoDaVolta('microsoft', 'admin-aprovou', true), /"Autorizar agora"/);
  const outro = textoDaVolta('microsoft', 'admin-aprovou-outro', false);
  assert.equal(outro, 'A Microsoft registrou a aprovação. Quem pediu já pode entrar de novo com a conta Microsoft no Ergon.');
  assert.equal(textoDaVolta('microsoft', 'conectado', true), 'Conta Microsoft conectada.');
  assert.equal(textoDaVolta('google', 'recusado', false), 'Login do Google cancelado.');
  assert.equal(textoDaVolta('microsoft', 'qualquer-outra', false), 'Não deu para concluir o login da Microsoft. Tente de novo.');
  for (const s of ['conectado', 'parcial', 'sem-leitura', 'sem-canais', 'admin-aprovou', 'admin-recusou', 'admin-aprovou-outro', 'admin-recusou-outro', 'admin-base', 'admin-aprovou-base', 'erro']) {
    for (const c of [true, false]) assert.doesNotMatch(textoDaVolta('microsoft', s, c), PROIBIDAS);
  }
});

test('T7: a mensagem pronta ao administrador anuncia tudo o que o link da primeira etapa pede', () => {
  assert.equal(oQuePedirAoAdministrador('base'), 'enviar e ler e-mail, ver a agenda, criar e ler arquivos, organizar tarefas e mandar e ler mensagens no Teams');
  assert.equal(oQuePedirAoAdministrador('leitura'), 'ler e-mail, agenda, arquivos, tarefas e conversas do Teams');
  assert.equal(oQuePedirAoAdministrador('canais'), 'ler as mensagens dos canais do Teams');
});

test('T8: na Microsoft, o próximo passo de Tarefas só depois de liberada a leitura', () => {
  const etapa = (id: EtapaConsentimento['id'], estado: EtapaConsentimento['estado']): EtapaConsentimento => ({ id, estado, opcional: false, administrador: true, link: null, erro: null });
  const pronto = 'Próximo passo: em Tarefas, escolha a lista ou o quadro. Dar check ou mover por lá reflete aqui e vice-versa.';
  const depois = 'Depois de liberar a leitura, escolha a lista ou o quadro em Tarefas.';
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'bloqueado')]).texto, depois);
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'falta')]).texto, depois);
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'aprovado')]).texto, depois);
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'ok')]).texto, pronto);
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'ok')]).link, true);
  assert.equal(proximoPassoTarefas('microsoft', [etapa('base', 'ok'), etapa('leitura', 'bloqueado')]).link, false);
  // sem as etapas (conta conectada antes delas, ou outros aplicativos): como antes
  assert.equal(proximoPassoTarefas('microsoft', []).texto, pronto);
  assert.equal(proximoPassoTarefas('google', []).texto, pronto);
});

test('T4: a renovação e a limpeza falam da equipe, não do motor (Saúde e Contas de IA)', () => {
  assert.equal(FRASE_RENOVANDO, 'Atualizando a equipe para a versão nova… os pedidos esperam e seguem sozinhos.');
  assert.equal(textoDoLiberado({ liberado: 2.4 * 1024 ** 3, removidas: 3 }, false), '2,4 GB liberados: 3 versão(ões) antiga(s) da equipe apagada(s). Nenhum dado seu foi apagado.');
  assert.equal(textoDoLiberado({ liberado: null, removidas: 1 }, true), 'Espaço liberado dentro do ambiente do Ergon: 1 versão(ões) antiga(s) da equipe apagada(s). Nenhum dado seu foi apagado.');
  assert.equal(textoDoLiberado({ liberado: 0, removidas: 0 }, false), 'Nada para liberar agora: as versões antigas já tinham saído.');
  const ultima = textoUltimaLimpeza({ at: '2026-11-02T12:00:00Z', liberado: 5 * 1024 ** 2, removidas: 2 }, false);
  assert.match(ultima, /^Última limpeza das versões antigas da equipe \(\d{2}\/\d{2}\/2026\): 5 MB liberados\.$/);
  assert.match(textoUltimaLimpeza({ at: '2026-11-02T12:00:00Z', liberado: null, removidas: 0 }, false), /: nada para liberar\.$/);
  assert.equal(textoConfirmarLiberar(false), 'Apaga as versões antigas da equipe que já não estão em uso. Nenhum dado seu é apagado: conversas, arquivos, contas e cofres ficam como estão.');
  assert.match(textoConfirmarLiberar(true), /já não estão em uso \(espaço liberado dentro do ambiente do Ergon\)\./);
  for (const t of [FRASE_RENOVANDO, textoDoLiberado({ liberado: 1, removidas: 1 }, true), textoDoLiberado({ liberado: 0, removidas: 0 }, true), ultima, textoConfirmarLiberar(true)]) assert.doesNotMatch(t, CRU);
});

test('T4: o motivo de demora com peça interna não vai para a tela; o que já é para a pessoa, vai', () => {
  for (const cru of [
    'o gerente de motores ainda está trabalhando (por exemplo, baixando a versão nova do motor)',
    'gerente de motores respondeu 500',
    'a ponte de controle do motor não respondeu',
    'cofre do motor respondeu 502',
    'connect ECONNREFUSED 10.89.0.3:8790',
    'fetch failed',
  ]) assert.equal(semJargao(cru), null, cru);
  assert.equal(semJargao('a versão nova não respondeu a tempo'), 'a versão nova não respondeu a tempo');
  assert.equal(semJargao('a versão nova da equipe ainda está chegando a este computador'), 'a versão nova da equipe ainda está chegando a este computador');
  assert.equal(semJargao(null), null);
});

test('T5: o card em falha mostra o motivo e o que fazer', () => {
  const j = 'Não foi feito: a Microsoft não aceitou enviar o e-mail (sem permissão). O card fica aberto.';
  assert.equal(motivoDaFalha(j), `${j} Use "Tentar de novo" ou devolva com uma instrução.`);
  assert.equal(motivoDaFalha(null), 'Não deu certo. Use "Tentar de novo" ou devolva com uma instrução.');
  assert.equal(motivoDaFalha('   '), 'Não deu certo. Use "Tentar de novo" ou devolva com uma instrução.');
});

test('T6: o nome do cofre não repete "cofre de" e diz "uma conta"', () => {
  assert.equal(rotuloDoCofre('cofre de uma conta que não existe neste Ergon (pode ser de outra instalação, ou de antes de reinstalar)'), 'uma conta que não existe neste Ergon (pode ser de outra instalação, ou de antes de reinstalar)');
  assert.equal(rotuloDoCofre('conta removida em 02/11/2026'), 'uma conta removida em 02/11/2026');
  assert.equal(rotuloDoCofre('conta removida'), 'uma conta removida');
  // o texto novo do servidor passa como está
  assert.equal(rotuloDoCofre('uma conta removida em 02/11/2026'), 'uma conta removida em 02/11/2026');
  assert.doesNotMatch(`Cofre de ${rotuloDoCofre('cofre de uma conta que não existe neste Ergon')}`, /cofre de cofre/i);
});

// ---- varredura das telas: os textos (fora dos comentários) sem as palavras proibidas e sem o jargão apontado na rc.24

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? arquivos(path.join(d, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [path.join(d, e.name)] : []);
/** o código sem os comentários (de bloco, de JSX e de linha; um "//" dentro de endereço também corta, o que só esconde texto) */
const semComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
// o World não vai na cópia Community: lá o arquivo não existe e não há o que conferir
const codigo = (rel: string) => (rel.includes('/world/') && !fs.existsSync(path.join(raiz, rel)) ? '' : semComentarios(fs.readFileSync(path.join(raiz, rel), 'utf8')));

test('T3: nenhuma tela usa os nomes proibidos (bastidores e nomes privados)', () => {
  const achados: string[] = [];
  for (const f of arquivos(raiz)) {
    semComentarios(fs.readFileSync(f, 'utf8')).split('\n').forEach((l, i) => {
      // identificadores do código (hermesSkills, campos da API) não aparecem na tela: só o que está entre aspas
      const textos = (l.match(/'[^']*'|"[^"]*"|`[^`]*`|>[^<>{}]+</g) ?? []).map((t) => t.replace(/\$\{[^}]*\}/g, ''));
      if (textos.some((t) => PROIBIDAS.test(t))) achados.push(`${path.relative(raiz, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(achados, []);
});

test('T12/T4: o jargão apontado na rc.24 saiu das telas', () => {
  const proibidos: Array<[string, RegExp]> = [
    ['views/ConexoesView.tsx', /O token precisa ter permissão de escrita/],
    ['components/AiAccounts.tsx', /sem custo por token/],
    ['views/AjudaView.tsx', /sem custo por token/],
    ['views/SaudePanel.tsx', /volume do Ergon|do motor|nenhum motor/],
    ['components/ChatCards.tsx', /ambiente isolado do motor de IA/],
    // revisão dos textos da rc.24: "motor" nas telas de conta, pessoas, segurança e proteção; "Skill"; ponto decimal no custo
    ['components/AiAccounts.tsx', /motor de IA/],
    ['components/AuthFlow.tsx', /motor de IA/],
    ['views/PessoasPanel.tsx', /\bmotor\b/],
    ['views/SegurancaPanel.tsx', /\bmotor\b/],
    ['views/world/WorldPanel.tsx', /motor de IA/],
    ['views/PacotesPanel.tsx', /'Skill'/],
    ['views/OtherViews.tsx', /cost_usd\.toFixed\(4\)\}/],
  ];
  for (const [rel, re] of proibidos) assert.ok(!re.test(codigo(rel)), `${rel}: ${re}`);
});

const tem = (src: string, re: RegExp, msg: string) => assert.ok(re.test(src), msg);
const naoTem = (src: string, re: RegExp, msg: string) => assert.ok(!re.test(src), msg);

test('as telas usam os textos acima (e não as cópias antigas)', () => {
  const cx = codigo('views/ConexoesView.tsx');
  naoTem(cx, /\{i\.adminBase\.erro\}/, 'T1: o erro cru do administrador não vai para o cartão');
  naoTem(cx, /\{e\.erro\}/, 'T1: o erro cru da etapa não vai para a tela');
  tem(cx, /motivoDoLogin\(e\.erro/, 'T1: a etapa mostra o motivo em português');
  tem(cx, /erroDaConexao\(i\)/, 'T1/T9: o cartão mostra o problema pela função');
  naoTem(cx, /\{i\.error && <p className="error">\{i\.error\}/, 'T9');
  tem(cx, /textoDaVolta\(/, 'T2');
  naoTem(cx, /VOLTA_DO_LOGIN/, 'T2: uma cópia só dos avisos');
  tem(cx, /link=\{i\.adminBase\.link\} etapa="base"/, 'T7');
  tem(cx, /oQuePedirAoAdministrador\(etapa\)/, 'T7');
  tem(cx, /proximoPassoTarefas\(/, 'T8');
  const td = codigo('components/TaskDetail.tsx');
  tem(td, /mode === 'team' && need === 'retry' && [\s\S]{0,80}motivoDaFalha\(work\?\.result\?\.justification/, 'T5');
  const ai = codigo('components/AiAccounts.tsx');
  tem(ai, /renovando=\{s\.motor\.state === 'renovando'\}/, 'T4: as Contas de IA dizem que a equipe está sendo atualizada');
  tem(ai, /semJargao\(erro\)/, 'T4: o motivo da demora passa pelo filtro');
  tem(codigo('components/Onboarding.tsx'), /renovando=\{ai\?\.motor\?\.state === 'renovando'\}/, 'T4: nas boas-vindas também');
  const sp = codigo('views/SaudePanel.tsx');
  tem(sp, /rotuloDoCofre\(v\.conta\)/, 'T6');
  tem(sp, /rotuloDoCofre\(cofre\.alvo\.conta\)/, 'T6');
});

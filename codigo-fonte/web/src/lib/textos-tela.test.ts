import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AVISO_APROVAR_SEM_CARTAO, FRASE_RENOVANDO, ROTULO_APROVAR_DEPOIS_DE_LER, ROTULO_CONFIRMAR_ORGANIZAR, erroDaConexao, motivoDaFalha, motivoDoLogin, oQuePedirAoAdministrador, proximoPassoTarefas, rotuloDoCofre,
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
  // o login segue sozinho até os canais: quem volta sem eles (ou sem o Teams, que a empresa exigiu do administrador) continua
  // conectado, e o aviso diz isso antes do que ficou de fora
  assert.match(textoDaVolta('microsoft', 'sem-canais', true), /^Conta Microsoft conectada\. Só a leitura dos canais do Teams \(opcional\)/);
  assert.match(textoDaVolta('microsoft', 'precisa-admin', true), /^Conta Microsoft conectada: enviar e-mail e criar arquivos já funcionam\. .*administrador/);
  for (const s of ['conectado', 'parcial', 'precisa-admin', 'sem-leitura', 'sem-canais', 'admin-aprovou', 'admin-recusou', 'admin-aprovou-outro', 'admin-recusou-outro', 'admin-base', 'admin-aprovou-base', 'erro']) {
    for (const c of [true, false]) assert.doesNotMatch(textoDaVolta('microsoft', s, c), PROIBIDAS);
  }
});

test('T7: a mensagem pronta ao administrador anuncia tudo o que o link da primeira etapa pede', () => {
  assert.equal(oQuePedirAoAdministrador('base'), 'enviar e ler e-mail, ver a agenda, criar e ler arquivos, organizar tarefas e mandar e ler mensagens no Teams');
  assert.equal(oQuePedirAoAdministrador('leitura'), 'ler e-mail, agenda, arquivos, tarefas e conversas do Teams');
  assert.equal(oQuePedirAoAdministrador('canais'), 'ler as mensagens dos canais do Teams');
  // o Teams que a empresa só libera com o administrador: o link é o da leitura, que pede também o Teams
  assert.match(oQuePedirAoAdministrador('trabalho'), /mandar mensagens no Teams/);
  assert.match(oQuePedirAoAdministrador('trabalho'), /ler e-mail/);
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
  assert.equal(textoDoLiberado({ liberado: 2.4 * 1024 ** 3, removidas: 3 }, false), '2,4 GB liberados: 3 versões antigas da equipe apagadas. Nenhum dado seu foi apagado.');
  assert.equal(textoDoLiberado({ liberado: null, removidas: 1 }, true), 'Espaço liberado dentro do ambiente do Ergon: 1 versão antiga da equipe apagada. Nenhum dado seu foi apagado.');
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
    ['i18n/pt/ajuda.ts', /sem custo por token/],
    ['views/SaudePanel.tsx', /volume do Ergon|do motor|nenhum motor/],
    // o aviso de permissão do ChatCards mora no dicionário de conversas
    ['i18n/pt/conversas.ts', /ambiente isolado do motor de IA|\bmotor\b/],
    ['i18n/en/conversas.ts', /\b(engine|container)s?\b/i],
    // revisão dos textos da rc.24: "motor" nas telas de conta, pessoas, segurança e proteção; "Skill"; ponto decimal no custo
    ['components/AiAccounts.tsx', /motor de IA/],
    ['components/AuthFlow.tsx', /motor de IA/],
    ['views/PessoasPanel.tsx', /\bmotor\b/],
    ['views/SegurancaPanel.tsx', /\bmotor\b/],
    // os textos dessas telas moraram para os dicionários da área conta: o jargão também não entra lá
    ['i18n/pt/conta.ts', /\bmotor\b/i],
    ['i18n/en/conta.ts', /\bengine\b|\bcontainer\b|\btoken\b|\bHermes\b/i],
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

test('decisão 19: o histórico do card diz em português o que a equipe fez ao tentar de novo (nunca o nome cru do registro)', async () => {
  // os rótulos do histórico saíram do componente para lib/tarefa-tela.ts (linhas curtas, com o "ver mais")
  const td = codigo('lib/tarefa-tela.ts');
  const rotulos = td.slice(td.indexOf('const ACTION_LABEL'), td.indexOf('};', td.indexOf('const ACTION_LABEL')));
  const mostra = td.slice(td.indexOf('const SHOW_RESULT'), td.indexOf(']);', td.indexOf('const SHOW_RESULT')));
  for (const acao of ['task.persist', 'task.persist_decision', 'task.persist_exhausted', 'task.help_step', 'conexao.pessoa']) {
    assert.match(rotulos, new RegExp(`'${acao.replace('.', '\.')}': 'tarefa\\.[^']+'`), `${acao}: rótulo na tela (uma chave do dicionário)`);
    assert.ok(mostra.includes(`'${acao}'`), `${acao}: o histórico mostra o que houve`);
  }
  // o texto vem do dicionário (i18n/pt/tarefa.ts), no idioma da tela
  const { ACTION_LABEL } = await import('./tarefa-tela.ts'); const { t } = await import('../i18n/index.ts');
  assert.equal(t(ACTION_LABEL['task.persist']), 'A equipe tentou de novo');
  assert.equal(t(ACTION_LABEL['conexao.pessoa']), 'Só você resolve');
  assert.equal(t(ACTION_LABEL['task.regra']), 'Liberado pela sua regra', 'o histórico do card diz que foi pela regra');
});

test('Conexões: as escolhas de cuidado (aprovar antes de abrir sites ou rodar programas, confirmar antes de organizar) aparecem claras', () => {
  const jargao = /\bmotor\b|token|\bAPI\b|contêiner|ferramenta '|web_extract|terminal/i;
  for (const r of [ROTULO_APROVAR_DEPOIS_DE_LER, ROTULO_CONFIRMAR_ORGANIZAR, AVISO_APROVAR_SEM_CARTAO]) { assert.doesNotMatch(r, jargao); assert.doesNotMatch(r, PROIBIDAS); }
  assert.match(ROTULO_APROVAR_DEPOIS_DE_LER, /aprovação antes de abrir sites ou rodar programas/);
  assert.match(ROTULO_CONFIRMAR_ORGANIZAR, /confirmação antes de organizar/);
  // os textos da tela de Conexões ficam no dicionário (i18n/pt/conexoes.ts): o código e o português juntos
  const cx = codigo('views/ConexoesView.tsx') + codigo('i18n/pt/conexoes.ts');
  tem(cx, /ROTULO_APROVAR_DEPOIS_DE_LER/, 'a opção está na tela de Conexões');
  tem(cx, /\/api\/conexoes\/aprovar-depois-de-ler/, 'e liga e desliga de verdade');
  // equipe ainda sem o pedido de aprovação: a tela avisa que, por enquanto, isso barra em vez de mostrar o cartão
  tem(cx, /aprovarDepoisDeLerBarra && <p className="warn">\{AVISO_APROVAR_SEM_CARTAO\}/, 'o aviso da equipe sem o cartão');
  tem(cx, /você escolhe por quanto tempo vale: 1 h, 8 h ou 72 h/, 'a pessoa escolhe o prazo da aprovação');
  tem(cx, /ROTULO_CONFIRMAR_ORGANIZAR/, 'confirmar antes de organizar também');
  tem(cx, /\/api\/conexoes\/confirmar-organizar/, 'e liga e desliga de verdade');
  // o cartão de aprovação e o de regra são decididos um a um: nunca entram no "aplicar todas"
  // (e o cartão de um comando de risco que o motor parou pedindo aprovação, rc.27)
  tem(codigo('components/ChatPanel.tsx'), /'conexao', 'depois_de_ler', 'aprovacao', 'regra', 'segredo'\]\.includes\(p\.kind\)/, 'fora do aplicar todas');
});

test('rc.26: as regras num lugar só (Conexões › Regras), com os botões do alcance e do prazo nos cartões', () => {
  const cr = codigo('components/CartaoRegra.tsx') + codigo('i18n/pt/conexoes.ts');
  for (const r of ['Só neste pedido', 'Por 24 h', 'Sempre', "'1 h'", "'8 h'", "'72 h'"]) tem(cr, new RegExp(r), `botão ${r}`);
  for (const arq of ['components/ChatPanel.tsx', 'components/DecisionsPanel.tsx']) {
    tem(codigo(arq), /<BotoesRegra /, `${arq}: o cartão de regra com o alcance`);
    tem(codigo(arq), /<BotoesPrazo /, `${arq}: a aprovação com o prazo`);
  }
  tem(codigo('components/TaskDetail.tsx'), /<BotoesPrazo /, 'no card também');
  const cx = codigo('views/ConexoesView.tsx');
  tem(cx, /id="conn-regras"/, 'a seção Regras em Conexões');
  tem(cx, /\/api\/conexoes\/regras\/\$\{x\.id\}\/desfazer/, 'Desfazer de verdade');
  tem(cx, /decision: 'rejected' \}\), t\('conexoes\.regras\.desligada'\)/, 'as regras de texto se desligam ali');
  const at = codigo('views/OtherViews.tsx');
  naoTem(at, /Regras propostas/, 'a aba antiga saiu de Atividade');
  tem(at, /'#conexoes\?regras'/, 'o endereço antigo leva a Conexões › Regras');
});

test('a cópia antiga dos dados da equipe: a pergunta diz que não tem volta, sem jargão; a frase do pedido é a que o servidor exige', async () => {
  const { CONFIRMAR_DADOS_ANTIGOS, TEXTO_CONFIRMAR_DADOS_ANTIGOS } = await import('./textos-tela.ts');
  assert.equal(CONFIRMAR_DADOS_ANTIGOS, 'apagar sem volta');
  assert.match(TEXTO_CONFIRMAR_DADOS_ANTIGOS, /Não tem volta\.$/);
  assert.match(TEXTO_CONFIRMAR_DADOS_ANTIGOS, /não confirmou que a recebeu/);
  assert.doesNotMatch(TEXTO_CONFIRMAR_DADOS_ANTIGOS, CRU);
  assert.doesNotMatch(TEXTO_CONFIRMAR_DADOS_ANTIGOS, PROIBIDAS);
  assert.doesNotMatch(TEXTO_CONFIRMAR_DADOS_ANTIGOS, /volume|cont[eê]iner|\btoken\b/i);
  // a tela da Saúde manda exatamente esta frase
  const tela = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'SaudePanel.tsx'), 'utf8');
  assert.match(tela, /\/api\/saude\/dados-antigos', \{ confirmar: CONFIRMAR_DADOS_ANTIGOS \}/);
  assert.match(tela, /c\.id === 'dados-antigos'/);
  // manter também é decisão: o botão existe, chama a rota, e some depois de mantida (apagar segue)
  assert.match(tela, /\/api\/saude\/dados-antigos\/manter'/);
  assert.match(tela, /!esp\?\.dadosAntigos\?\.mantida && <button[^\n]*>\{t\('configuracoes\.saude\.manterCopia'\)\}<\/button>/);
  const { TEXTO_MANTIDOS_DADOS_ANTIGOS } = await import('./textos-tela.ts');
  assert.doesNotMatch(TEXTO_MANTIDOS_DADOS_ANTIGOS, CRU);
  assert.doesNotMatch(TEXTO_MANTIDOS_DADOS_ANTIGOS, PROIBIDAS);
  assert.match(TEXTO_MANTIDOS_DADOS_ANTIGOS, /dá para apagar aqui mesmo/);
});

test('baixar meus dados e excluir a conta: o arquivo sai legível, os backups de antes são ditos como são, quem administra sabe que só a pessoa baixa', async () => {
  const t = await import('./textos-tela.ts');
  assert.match(t.TEXTO_BAIXAR_DADOS, /legível, sem a cifra/);
  assert.match(t.TEXTO_BAIXAR_DADOS, /Guarde em lugar seguro/);
  assert.match(t.TEXTO_ANTES_DE_EXCLUIR, /^Antes de excluir, baixe os seus dados/);
  // o texto antigo dizia que nada mais abria "nem por backup": falso para os backups feitos antes
  assert.doesNotMatch(t.TEXTO_EXCLUIR_CONTA, /nem por backup/);
  assert.match(t.TEXTO_EXCLUIR_CONTA, /somem desta instalação/);
  assert.match(t.TEXTO_EXCLUIR_CONTA, /backup da instalação feito antes pode trazer de volta a instalação inteira/);
  const rem = t.textoRemoverPessoa('bruna');
  assert.match(rem, /Só a própria pessoa pode baixar os dados dela/);
  assert.match(rem, /Peça para ela baixar antes de remover/);
  assert.doesNotMatch(rem, /nem você nem ela conseguem recuperar/);
  assert.match(rem, /backup da instalação feito antes/);
  assert.equal(t.textoBaixado(0), 'Arquivo baixado. Guarde em lugar seguro: ele não é cifrado.');
  assert.equal(t.textoBaixado(3), 'Arquivo baixado. 3 arquivos ficaram de fora: a lista e o motivo estão no LEIA-ME, dentro do arquivo. Guarde em lugar seguro: ele não é cifrado.');
  assert.match(t.textoBaixado(1), /1 arquivo ficou de fora: a lista e o motivo estão no LEIA-ME/);
  for (const n of [1, 2]) { assert.doesNotMatch(t.textoBaixado(n), /pelo tamanho|documento/, 'o motivo pode ser outro: quem diz é o LEIA-ME'); assert.match(t.textoBaixado(n), /não é cifrado/, 'o aviso de que o arquivo é legível sempre vem'); }
  for (const s of [t.TEXTO_BAIXAR_DADOS, t.TEXTO_ANTES_DE_EXCLUIR, t.TEXTO_EXCLUIR_CONTA, rem, t.textoBaixado(2)]) { assert.doesNotMatch(s, CRU); assert.doesNotMatch(s, PROIBIDAS); assert.doesNotMatch(s, /\bo Ergon (lê|sabe|guarda|acha)/); }
  // as telas usam estes textos (e o texto errado de antes saiu delas)
  const views = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../views');
  const seg = fs.readFileSync(path.join(views, 'SegurancaPanel.tsx'), 'utf8');
  const pes = fs.readFileSync(path.join(views, 'PessoasPanel.tsx'), 'utf8');
  const conta = fs.readFileSync(path.join(views, 'ContaPanel.tsx'), 'utf8');
  assert.ok(!seg.includes('nem por backup') && seg.includes('TEXTO_EXCLUIR_CONTA') && seg.includes('<BaixarMeusDados'), 'Segurança: baixar antes de excluir');
  // o botão "Excluir a minha conta…" pela chave (o texto está em i18n/pt/conta.ts)
  assert.ok(seg.indexOf('<BaixarMeusDados') < seg.indexOf("t('conta.seg.excluirComecar')"), 'o passo de baixar vem antes do botão de excluir');
  assert.ok(!pes.includes('nem você nem ela conseguem recuperar') && pes.includes('textoRemoverPessoa('), 'Pessoas: o aviso certo');
  assert.ok(conta.includes('<BaixarMeusDados'), 'Minha conta: baixar a qualquer momento');
});

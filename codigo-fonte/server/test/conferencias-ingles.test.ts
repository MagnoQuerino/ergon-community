/**
 * As conferências do sistema entendem inglês (rc.26): quando a pessoa escreve em inglês, a equipe responde em inglês, e
 * nada pode quebrar em silêncio — o "não consegui" continua falha, a linha "Feito:"/"Done:" continua a frase da entrega,
 * os cards continuam andando pelas colunas, e os pedidos, prazos, regras e números continuam reconhecidos. Cada caso vale
 * nas duas línguas: o português de sempre não muda.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { classifyTask, intencoesDoPedido, intencoesPelaConta, naoFeito } from '../src/services/results.ts';
import { idioma, semNomeComum } from '../src/lib/idioma.ts';
import { separarLinhaParaVoce, avisoSemCartao } from '../src/services/resumo-tarefa.ts';
import { parseVerdict } from '../src/services/review.ts';
import { decide, interpretRules } from '../src/services/interpret.ts';
import { parseDue } from '../src/services/due.ts';
import { vagueTitle, cutTitle } from '../src/services/card-title.ts';
import { regraDaFrase, soLiberacao, parseRegras } from '../src/services/conexoes/regras.ts';
import { parseChatCommand } from '../src/services/proposals.ts';
import { parseWhen } from '../src/services/routine-time.ts';
import { checkRun, numbersIn } from '../src/services/routines.ts';
import { referenceFrom } from '../src/services/operations.ts';
import { routeDemand } from '../src/services/characters.ts';
import { pedeEquipeInteira } from '../src/services/runs.ts';
import { autoSector } from '../src/services/sectors.ts';
import { chavePeloNome, colunaPorChave, marcarColunas } from '../src/services/colunas.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { semComentarios } from '../src/version.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { resumoDaTarefa } from '../src/services/resumo-tarefa.ts';
import { harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

const central = { profileCreates: 'demands' as const, canCommand: true, observeOnly: false };

describe('"não consegui" / "I couldn\'t": o agente diz que não fez', () => {
  test('nas duas línguas, no começo da resposta', () => {
    for (const t of [
      'Não consegui enviar o e-mail para a Ana: a conta pediu para autorizar de novo.',
      'Não tenho acesso à sua caixa de entrada agora.',
      'As Conexões ainda não estão habilitadas para mim.',
      'Nada foi feito ainda.',
      "I couldn't send the email to Ana: the account asked to be authorized again.",
      'I couldn’t send the email to Ana (apóstrofo curvo).',
      'I was unable to access your inbox.',
      "I wasn't able to create the tasks in Planner.",
      "We don't have access to the shared calendar.",
      'I have no permission to post in that channel.',
      "The connections aren't enabled for me yet.",
      'The integration is not available right now.',
      'Nothing was done.',
      'It was not possible to schedule the meeting.',
      "I can't access your inbox right now.",
    ]) assert.ok(naoFeito(t), t);
  });

  test('frase de resultado não é falha: os mesmos verbos do português (sem "find", "get", "make", "do" soltos)', () => {
    for (const t of [
      "I couldn't find any errors in the spreadsheet. The totals match the bank statement.",
      "I can't find any duplicates in the list you sent; everything looks clean.",
      "I couldn't get a single inconsistency out of the data: all 120 rows match.",
      'We can’t make this decision for you. Here are the three options, with prices.',
      "I couldn't find any errors in the contract. It is ready to sign.",
      'I failed to find any evidence that the supplier was late.',
      "I couldn't get the exact figure for 2023, so the table uses the 2022 value.",
      'We cannot do much about the weather, but the plan has a backup date.',
      // o rascunho honesto, como "Nada foi enviado ainda: o rascunho está acima…"
      'Nothing was sent yet: the draft is above for your approval.',
      'Não consegui encontrar nenhum erro na planilha.',
      'Nada foi enviado ainda: o rascunho está acima para a sua aprovação.',
    ]) assert.equal(naoFeito(t), null, t);
    assert.ok(naoFeito("I couldn't do it: the file was locked."), 'com o objeto, "do it" continua falha');
  });

  test('ressalva de uma entrega e o assunto do texto não contam', () => {
    assert.equal(naoFeito('Não consegui acessar o site X, mas usei o relatório anual, que traz os mesmos números.'), null);
    assert.equal(naoFeito("I couldn't access site X, but I used the annual report, which has the same figures."), null);
    assert.equal(naoFeito("I couldn't open the PDF, so I used the summary page instead."), null);
    assert.equal(naoFeito('Millions of people still do not have access to the internet, according to the report.'), null);
    assert.equal(naoFeito('Milhões de pessoas ainda não têm acesso à internet, segundo o relatório.'), null);
  });

  test('o que nenhuma conexão faz (pagar): só conta o que fala da conta ou da ferramenta', () => {
    assert.equal(naoFeito('Não tenho acesso ao seu banco; deixei o boleto pronto para você pagar.', true), null);
    assert.equal(naoFeito("I don't have access to your bank; the payment slip is ready for you to pay.", true), null);
    assert.ok(naoFeito("I don't have the tool to read your inbox.", true));
  });
});

describe('tipo de trabalho pelas palavras do pedido, nas duas línguas', () => {
  test('documento, ação externa e informação', () => {
    assert.equal(classifyTask('Escreva um relatório sobre as vendas', false), 'documental');
    assert.equal(classifyTask('Write a report on last quarter sales', false), 'documental');
    assert.equal(classifyTask('Draft a proposal for the new client', false), 'documental');
    assert.equal(classifyTask('Envie a proposta ao cliente', false), 'externo');
    assert.equal(classifyTask('Send the proposal to the client', false), 'externo');
    assert.equal(classifyTask('Pay the supplier invoice today', false), 'externo');
    assert.equal(classifyTask('Analise a planilha de vendas', true), 'dados');
    assert.equal(classifyTask('Analyze the sales spreadsheet', true), 'dados');
  });

  test('"report" do inglês não pega o português "reporte", "reportagem"', () => {
    assert.equal(classifyTask('Reporte ao fornecedor que o pedido 123 atrasou e peça um novo prazo', false), 'informativo');
    assert.equal(classifyTask('Leia a reportagem e me diga o principal', false), 'informativo');
    assert.equal(classifyTask('Prepare the weekly reports for the board', false), 'documental');
    assert.equal(classifyTask('Confira o reporte e a contagem', true), 'dados', '"contagem" continua dado');
    assert.equal(classifyTask('Confira o reporte do fornecedor', true), 'informativo', 'com o CSV, "reporte" não é dado');
  });

  test('pergunta e pesquisa sobre envio não são ação externa', () => {
    assert.notEqual(classifyTask('Qual a melhor hora para enviar e-mails?', false), 'externo');
    assert.notEqual(classifyTask('What is the best time to send emails?', false), 'externo');
    assert.notEqual(classifyTask('Research the best tools to send newsletters', false), 'externo');
    assert.notEqual(classifyTask('Research equal pay policies in Brazil', false), 'externo');
  });
});

describe('a linha da entrega: "Feito:"/"Done:" e "Para você decidir:"/"For you to decide:"', () => {
  test('nas duas línguas, com e sem negrito; sai do corpo', () => {
    const pt = separarLinhaParaVoce('O texto completo.\n\nFeito: criei no Planner as tarefas A e B.');
    assert.deepEqual(pt.linha, { tipo: 'feito', texto: 'criei no Planner as tarefas A e B.' });
    const en = separarLinhaParaVoce('The full text.\n\nDone: I created tasks A and B in Planner.');
    assert.deepEqual(en.linha, { tipo: 'feito', texto: 'I created tasks A and B in Planner.' });
    assert.equal(en.corpo, 'The full text.');
    const dec = separarLinhaParaVoce('The draft.\n\n**For you to decide:** choose between plan A ($50/month) and plan B ($80/month).');
    assert.equal(dec.linha?.tipo, 'decidir');
    assert.match(dec.linha!.texto, /plan A/);
    assert.equal(separarLinhaParaVoce('Texto.\n\nPara você decidir: aprovar o texto para a Ana.').linha?.tipo, 'decidir');
  });

  test('numa lista do documento é conteúdo, nas duas línguas', () => {
    assert.equal(separarLinhaParaVoce('Status:\n- Done: item A').linha, null);
    assert.equal(separarLinhaParaVoce('Status:\n- Feito: item A').linha, null);
  });

  test('o aviso "Aprovar só conclui" também para a linha em inglês que promete uma ação', () => {
    assert.ok(avisoSemCartao({ tipo: 'decidir', texto: 'approve sending the email to Ana and Bruno' }));
    assert.ok(avisoSemCartao({ tipo: 'decidir', texto: 'aprovar o envio do e-mail para a Ana' }));
    assert.equal(avisoSemCartao({ tipo: 'decidir', texto: 'choose between the two texts' }), null);
  });
});

describe('veredito da revisão: VEREDITO e VERDICT', () => {
  test('o último vale, nas duas línguas', () => {
    assert.equal(parseVerdict('VEREDITO: ajustar\n...\nVEREDITO: pronto'), 'pronto');
    assert.equal(parseVerdict('Some questions.\nVERDICT: revise'), 'ajustar');
    assert.equal(parseVerdict('All good.\n**VERDICT:** ready'), 'pronto');
    assert.equal(parseVerdict('VERDICT: ready\nthen... VEREDITO: ajustar'), 'ajustar');
    assert.equal(parseVerdict('no verdict here'), null);
  });
});

describe('interpretador por regras em inglês (o português de sempre continua)', () => {
  const casos: Array<[string, string, string]> = [
    ['Create a task to review the contract', 'comando', 'create_task'],
    ['Please add a new task: prepare the meeting agenda', 'comando', 'create_task'],
    ['New task: call the supplier', 'comando', 'create_task'],
    ['What is still pending?', 'comando', 'list_pending'],
    ['Rename card #12 to "Q3 report"', 'mudanca', 'update_task'],
    ['From now on, always use the standard template', 'mudanca', 'propose_rule'],
    ['I finished #4', 'conclusao', 'complete_task'],
    ['Thanks!', 'resposta', 'none'],
    ['Good morning', 'resposta', 'none'],
    ['What if we launch in March?', 'ideia', 'none'],
    ['I need someone to review the contract by Friday', 'demanda', 'create_task'],
    // o português de sempre
    ['Crie uma tarefa para revisar o contrato', 'comando', 'create_task'],
    ['Terminei a #4', 'conclusao', 'complete_task'],
    ['A partir de agora, use sempre o modelo padrão', 'mudanca', 'propose_rule'],
  ];
  for (const [text, cat, kind] of casos) {
    test(`"${text}" → ${cat}/${kind}`, () => {
      const i = interpretRules(text);
      assert.equal(i.category, cat);
      assert.equal(decide(i, central, text).kind, kind);
    });
  }

  test('título preserva o original; pergunta e negação não concluem o card', () => {
    assert.equal(interpretRules('Create a task to Review Q3 Budget').task_title, 'Review Q3 Budget');
    assert.equal(interpretRules('Rename card #12 to "Q3 Report"').task_title, 'Q3 Report');
    assert.notEqual(interpretRules('Is #12 done?').category, 'conclusao');
    assert.notEqual(interpretRules("#12 isn't done yet").category, 'conclusao');
    assert.notEqual(interpretRules('Send it whenever you can').proposed_action, 'propor_regra');
  });

  test('o card só é concluído quando a pessoa afirma a conclusão, nas duas línguas', () => {
    for (const t of ['I finished #4', "I've completed #4", 'We just finished #7', '#12 is done', '#12 is now complete', 'Mark #12 as done', '#12 done!', 'Done with #12',
      "I'm done with #12", 'Terminei a #4', 'O #12 está feito', 'mude o card #12 para Feito'])
      assert.equal(decide(interpretRules(t), central, t).kind, 'complete_task', t);
    for (const t of ['Make sure #12 gets done by Friday', '#12 needs to be done before the meeting', "Look at #12 when you're done with #11", 'Have you finished #4',
      'Did you finish #4', '#12 should be done by Monday', "When I'm done with #11 I'll send you #12", 'Get #12 done today',
      'O #12 precisa ser feito até sexta', 'Me avise quando o #12 estiver pronto', 'O #12 está pronto?', 'Deixe o #12 pronto até amanhã', 'O #12 tem que ser concluído hoje'])
      assert.notEqual(interpretRules(t).category, 'conclusao', t);
  });
});

describe('prazos ditos no pedido, nas duas línguas', () => {
  const tz = 'America/Sao_Paulo';
  const agora = Date.parse('2026-11-09T15:00:00Z'); // segunda-feira, 09/11/2026
  const casos: Array<[string, string | null]> = [
    ['Revisar o contrato até sexta', '2026-11-13'],
    ['prazo 30/11', '2026-11-30'],
    ['até amanhã', '2026-11-10'],
    ['até 15 de dezembro', '2026-12-15'],
    ['Review the contract by Friday', '2026-11-13'],
    ['due tomorrow', '2026-11-10'],
    ['by 11/20', '2026-11-20'],
    ['by 20/11', '2026-11-20'],
    ['by Nov 15', '2026-11-15'],
    ['by the 15th of December', '2026-12-15'],
    ['by the 5th', '2026-12-05'],
    ['deadline: 2026-12-01', '2026-12-01'],
    ['by end of week', '2026-11-13'],
    ['by end of the month', '2026-11-30'],
    ['meeting on Friday', null],
    ['reunião na sexta', null],
    // "o dia 15 de dezembro" é dezembro, não o dia 15 deste mês
    ['entregar até o dia 15 de dezembro', '2026-12-15'],
    ['até dia 15', '2026-11-15'],
    ['até o dia 5', '2026-12-05'],
    // dois números até 12: no Brasil, dia/mês também em inglês; nunca pula para o ano que vem
    ['Prepare the deck by 10/12', '2026-12-10'],
    ['Send the invoice by 05/12', '2026-12-05'],
    ['Send the invoice by 03/11', null],
    ['by 03/11/2027', '2027-11-03'],
  ];
  for (const [t, quer] of casos) test(`"${t}" → ${quer}`, () => assert.equal(parseDue(t, tz, agora), quer));
  test('nos Estados Unidos, a data com barras é mês/dia', () => {
    assert.equal(parseDue('Prepare the deck by 12/10', 'America/New_York', agora), '2026-12-10');
    assert.equal(parseDue('Prepare the deck by 12/10', tz, agora), null, 'em São Paulo, 12/10 (12 de outubro) já passou: sem prazo, nada de ano que vem');
    assert.equal(parseDue('by 11/20', 'America/New_York', agora), '2026-11-20');
  });
});

describe('título vago do card, nas duas línguas', () => {
  test('o que não diz do que se trata', () => {
    for (const t of ['?', 'ok', 'faz isso', 'me ajuda', 'yes', 'do it', 'can you help?', 'try again', 'please continue', 'thanks!', 'any news?', 'what about the rest?'])
      assert.ok(vagueTitle(t), t);
    for (const t of ['Revisar o contrato da Acme', 'Review the Acme contract', 'Status of order 4521', 'Welcome email for Ana'])
      assert.ok(!vagueTitle(t), t);
  });
  test('o cumprimento não entra no título', () => {
    assert.equal(cutTitle('Hi, review the Acme contract'), 'review the Acme contract');
    assert.equal(cutTitle('Oi, revise o contrato'), 'revise o contrato');
  });
});

describe('regra de Conexões pela frase da pessoa, nas duas línguas', () => {
  test('liberação de envio e o alcance', () => {
    assert.deepEqual(regraDaFrase('podem mandar os e-mails sem me pedir aprovação', ['microsoft'])?.riscos, ['enviar']);
    const sempre = regraDaFrase('From now on you can send the emails without my approval', ['microsoft']);
    assert.deepEqual(sempre?.riscos, ['enviar']);
    assert.equal(sempre?.alcance, 'sempre');
    assert.equal(sempre?.so, 'email');
    assert.equal(regraDaFrase('No need to ask for my approval to send emails today', ['microsoft'])?.alcance, '24h');
    assert.ok(soLiberacao('From now on you can send the emails without my approval'));
  });
  test('o que ela nega fica de fora; pergunta e reclamação não propõem', () => {
    const r = regraDaFrase("You can reply to messages and delete spam without asking me, but don't delete anything from clients", ['microsoft']);
    assert.ok(r && r.riscos.includes('enviar') && !r.riscos.includes('apagar'), JSON.stringify(r));
    assert.equal(regraDaFrase('Who sent the emails without my approval?', ['microsoft']), null);
    assert.equal(regraDaFrase('Why did you send that without my approval', ['microsoft']), null);
    assert.equal(regraDaFrase('quem mandou enviar sem a minha aprovação?', ['microsoft']), null);
  });
  test('a proibição com mais palavras até o verbo não vira liberação, nas duas línguas', () => {
    for (const t of [
      "I don't want you to send emails without my approval",
      "Please don't, under any circumstances, send emails without my approval",
      'Under no circumstances send emails without my approval',
      "We wouldn't like anyone to reply to client emails without my approval",
      "Don't ever send emails without my approval",
      'não quero que vocês enviem e-mails sem a minha aprovação',
      'Em hipótese alguma enviem e-mails sem a minha aprovação',
      'nunca permito que ninguém responda os e-mails sem a minha aprovação',
    ]) assert.equal(regraDaFrase(t, ['microsoft']), null, t);
    // pedir o envio continua liberação
    assert.deepEqual(regraDaFrase("Don't hesitate to send the emails without my approval", ['microsoft'])?.riscos, ['enviar']);
    assert.deepEqual(regraDaFrase('Não deixem de enviar os e-mails sem esperar a minha aprovação', ['microsoft'])?.riscos, ['enviar']);
    assert.deepEqual(regraDaFrase('You don\'t need to ask for my approval to send emails', ['microsoft'])?.riscos, ['enviar']);
    assert.deepEqual(regraDaFrase('não precisa me pedir aprovação para enviar os e-mails', ['microsoft'])?.riscos, ['enviar']);
  });
  test('o marcador da coordenação com valores em inglês', () => {
    const [r] = parseRegras('[[regra acao="send" conexao="all" alcance="always" so="email"]]');
    assert.deepEqual(r.riscos, ['enviar']);
    assert.deepEqual(r.conexoes, ['*']);
    assert.equal(r.alcance, 'sempre');
  });
});

describe('frases para a coordenação em inglês', () => {
  test('mudar de setor, renomear, criar agente e cancelar card', () => {
    assert.deepEqual(parseChatCommand('Move Fídias to the Communication team'), { kind: 'sector', agent: 'Fídias', sector: 'Communication' });
    assert.deepEqual(parseChatCommand('Rename Hipátia to Ana'), { kind: 'edit_agent', agent: 'Hipátia', changes: { name: 'Ana' } });
    assert.equal(parseChatCommand('Create a new agent called Leo, to handle social media')?.kind, 'create_agent');
    assert.deepEqual(parseChatCommand('Cancel card 12 because the client gave up'), { kind: 'delete_task', number: 12, reason: 'the client gave up' });
    assert.equal(parseChatCommand('Move the meeting to Friday'), null, '"move" sem setor não é mudar alguém de setor');
    assert.equal(parseChatCommand('Move card 12 to the Done team'), null, 'é o card');
    assert.deepEqual(parseChatCommand('mova a Fídias para o setor de comunicação'), { kind: 'sector', agent: 'Fídias', sector: 'comunicação' });
  });
});

describe('quando de uma rotina, nas duas línguas', () => {
  const tz = 'America/Sao_Paulo';
  test('dias e horário', () => {
    assert.deepEqual(parseWhen('dias úteis 8h', tz), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00', tz });
    assert.deepEqual(parseWhen('weekdays 8am', tz), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00', tz });
    assert.deepEqual(parseWhen('every Friday at 5 pm', tz), { kind: 'schedule', days: [5], time: '17:00', tz });
    assert.deepEqual(parseWhen('Mon and Thu 10:30', tz), { kind: 'schedule', days: [1, 4], time: '10:30', tz });
    assert.deepEqual(parseWhen('daily 7:30', tz), { kind: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '07:30', tz });
    assert.deepEqual(parseWhen('toda sexta às 17:00', tz), { kind: 'schedule', days: [5], time: '17:00', tz });
    assert.deepEqual(parseWhen('on demand', tz), { kind: 'manual' });
  });
  test('o am/pm não pega o começo de uma palavra, e o "7h" do português vem primeiro', () => {
    assert.deepEqual(parseWhen('todo dia às 7h, 2 amostras', tz), { kind: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '07:00', tz });
    assert.deepEqual(parseWhen('toda sexta 3 amigos às 18h', tz), { kind: 'schedule', days: [5], time: '18:00', tz });
    assert.deepEqual(parseWhen('every Monday at 9 a.m.', tz), { kind: 'schedule', days: [1], time: '09:00', tz });
  });
});

describe('conferência das rotinas: números, datas e horários escritos em inglês', () => {
  const base = { when: 'segunda, 09/11 às 08:00', mode: 'real' as const, reads: [], warnings: [], panel: '', delivered: true, fileWanted: false, fileOk: true };
  test('número com milhar em vírgula (inglês) confere com o dado em português', () => {
    const facts = 'Total de vendas: 12.500,50 · clientes novos: 1.234';
    assert.equal(checkRun({ ...base, facts, extra: ['numeros'], text: 'Sales reached 12,500.50 with 1,234 new clients.' }).verdict, 'validado');
    assert.equal(checkRun({ ...base, facts, extra: ['numeros'], text: 'As vendas chegaram a 12.500,50 com 1.234 clientes novos.' }).verdict, 'validado');
    assert.equal(checkRun({ ...base, facts, extra: ['numeros'], text: 'Sales reached 13,900.00.' }).verdict, 'reprovado', 'número que não está nos dados');
  });
  test('"12,500" vale como 12500 (inglês) ou 12,5 (português)', () => {
    const [n] = numbersIn('12,500');
    assert.equal(n.value, 12500);
    assert.deepEqual(n.alts.map((a) => a.value), [12.5]);
  });
  test('data mês/dia, com o nome do mês e horário com am/pm', () => {
    const facts = '[Agenda: 1]\n- 2026-11-12 14:30–15:00 "Revisão" · Microsoft';
    assert.equal(checkRun({ ...base, facts, text: 'The review is on 11/12 at 2:30 pm.' }).verdict, 'validado');
    assert.equal(checkRun({ ...base, facts, text: 'The review is on Nov 12 at 2:30 PM.' }).verdict, 'validado');
    assert.equal(checkRun({ ...base, facts, text: 'A revisão é em 12/11 às 14:30.' }).verdict, 'validado');
    assert.equal(checkRun({ ...base, facts, text: 'The review is on 11/14 at 2:30 pm.' }).verdict, 'reprovado', 'data fora dos dados');
    assert.equal(checkRun({ ...base, facts, text: 'The review is on 11/12 at 4 pm.' }).verdict, 'reprovado', 'horário fora dos dados');
    assert.equal(checkRun({ ...base, facts, text: '8 out of 10 tasks are on track; the review is on 11/12 at 2:30 pm.' }).verdict, 'validado', '"8 out of" não é data');
    assert.equal(checkRun({ ...base, facts, text: 'Marco 2: a revisão é em 12/11 às 14:30.' }).verdict, 'validado', '"Marco 2" é um marco do projeto, não 2 de março');
  });
  test('no texto em português, a segunda leitura (12,5 por "12.500"; mês/dia) não vale', () => {
    const facts = 'Total do mês: 12,5 mil · revisão em 03/11';
    assert.equal(checkRun({ ...base, facts, extra: ['numeros'], text: 'O total foi R$ 12.500 no mês, e a revisão é em 03/11.' }).verdict, 'reprovado', 'R$ 12.500 não é 12,5');
    assert.equal(checkRun({ ...base, facts: 'revisão em 03/11', text: 'A revisão é em 11/03, como combinado.' }).verdict, 'reprovado', 'em português, 11/03 é 11 de março');
    assert.equal(checkRun({ ...base, facts: 'revisão em 03/11', text: 'The review is on 11/03, as agreed with the team.' }).verdict, 'validado', 'em inglês, 11/03 pode ser 3 de novembro');
    assert.equal(checkRun({ ...base, facts: 'Total: 12,5', extra: ['numeros'], text: 'The total for the month is 12.500 according to the sheet.' }).verdict, 'validado', 'em inglês, 12.500 pode ser 12,5');
  });
});

describe('outros detectores que decidem algo', () => {
  test('data de referência da análise', () => {
    assert.equal(referenceFrom('data de referência: 24/10/2026'), '2026-10-24');
    assert.equal(referenceFrom('reference date: 10/24/2026'), '2026-10-24');
    assert.equal(referenceFrom('as of 2026-10-24'), '2026-10-24');
  });
  test('quem faz e o setor pelas palavras, também em inglês', () => {
    assert.equal(routeDemand('Analyze the sales spreadsheet and the budget')?.key, 'arquimedes');
    assert.equal(routeDemand('Write a report and a proposal for the client')?.key, 'herodoto');
    assert.equal(routeDemand('Research the literature on remote work')?.key, 'hipatia');
    assert.equal(routeDemand('Analise a planilha de vendas e o orçamento')?.key, 'arquimedes');
    assert.equal(autoSector('Customer support assistant').key, 'central');
    assert.equal(autoSector('Market research and trends').key, 'brainstorm');
  });
  test('as notas da versão sem o campo de segurança escondido', () => {
    assert.equal(semComentarios('## 1.1.0\n<!-- seguranca: fecha uma falha no cofre -->\n- Melhorias.'), '## 1.1.0\n\n- Melhorias.');
    assert.equal(semComentarios('- Sem comentário.\n'), '- Sem comentário.\n', 'sem comentário: igual');
  });
});

describe('colunas do quadro pelo código fixo', () => {
  test('nomes de fábrica nas duas línguas', () => {
    assert.equal(chavePeloNome('A fazer'), 'todo');
    assert.equal(chavePeloNome('With you'), 'with_you');
    assert.equal(chavePeloNome('Concluído'), 'done');
    assert.equal(chavePeloNome('Fazendo', 'user'), 'doing');
    assert.equal(chavePeloNome('Qualquer coisa'), null);
  });

  test('banco antigo: a migração marca as colunas pelo nome de hoje (uma por código)', () => {
    const dir = tmpDir();
    const db = new Db(path.join(dir, 'db', 'ergon.sqlite'));
    db.migrate({ until: '0039_titulo_do_card.sql' });
    const now = new Date().toISOString();
    db.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_antigo', 'Empresa', ?)", now);
    const board = (id: string, audience: string, origin: string, names: string[]) => {
      db.run('INSERT INTO boards (id, workspace_id, name, origin, audience, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, 'ws_antigo', 'Quadro', origin, audience, now);
      names.forEach((n, i) => db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', `col_${id}_${i}`, 'ws_antigo', id, n, i));
    };
    board('brd_eq', 'team', 'native', ['A fazer', 'Em andamento', 'Com você', 'Concluído', 'Concluído']);
    board('brd_eu', 'user', 'native', ['A fazer', 'Fazendo', 'Feito']);
    board('brd_esp', 'team', 'mirror', ['A fazer', 'Concluído']);
    db.migrate();
    const k = (b: string) => db.all<{ name: string; system_key: string | null }>('SELECT name, system_key FROM columns WHERE board_id = ? ORDER BY position', b).map((x) => x.system_key);
    assert.deepEqual(k('brd_eq'), ['todo', 'doing', 'with_you', 'done', null], 'a coluna repetida fica sem código');
    assert.deepEqual(k('brd_eu'), ['todo', 'doing', 'done']);
    assert.deepEqual(k('brd_esp'), [null, null], 'quadro espelhado de outro aplicativo não ganha código');
    // quadro trazido sem o código (backup antigo, nomes em inglês): marcado pelo nome, uma vez
    db.run("UPDATE columns SET system_key = NULL WHERE board_id = 'brd_eq'");
    db.run("UPDATE columns SET name = 'To do' WHERE id = 'col_brd_eq_0'");
    db.run("UPDATE columns SET name = 'With you' WHERE id = 'col_brd_eq_2'");
    assert.equal(colunaPorChave(db, 'brd_eq', 'with_you'), 'col_brd_eq_2', 'sem o código, acha pelo nome de fábrica');
    marcarColunas(db, 'ws_antigo');
    assert.deepEqual(k('brd_eq'), ['todo', 'doing', 'with_you', 'done', null]);
    db.close();
  });

  describe('o card anda mesmo com as colunas renomeadas (em inglês)', () => {
    let h: Harness; let s: Session;
    before(async () => { h = await harness(); s = await setupOwner(h); });
    after(() => h.close());

    test('setWorkState e a fila usam o código, não o nome', async () => {
      const board = h.db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'team'", s.workspaceId)!.id;
      const keys = h.db.all<{ name: string; system_key: string }>('SELECT name, system_key FROM columns WHERE board_id = ? ORDER BY position', board);
      assert.deepEqual(keys.map((x) => x.system_key), ['todo', 'doing', 'with_you', 'done'], 'workspace novo já nasce com os códigos');
      // a pessoa (ou a tela em inglês) renomeia todas as colunas
      for (const [k, n] of [['todo', 'To do'], ['doing', 'In progress'], ['with_you', 'With you'], ['done', 'Done']]) h.db.run('UPDATE columns SET name = ? WHERE board_id = ? AND system_key = ?', n, board, k);
      const agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0 LIMIT 1", s.workspaceId)!.id;
      const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Review the Acme contract', agentId: agente })).json as { id: string; column_id: string };
      const col = (id: string) => h.db.get<{ system_key: string }>('SELECT c.system_key FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?', id)!.system_key;
      assert.ok(h.teamwork.queueInfo(s.workspaceId, t.id), 'o card novo está na fila de "To do"');
      h.results.setWorkState(s.workspaceId, t.id, 'processamento');
      assert.equal(col(t.id), 'doing');
      h.results.setWorkState(s.workspaceId, t.id, 'aguardando_aprovacao');
      assert.equal(col(t.id), 'with_you');
      h.results.setWorkState(s.workspaceId, t.id, 'concluida');
      assert.equal(col(t.id), 'done');
      const view = (await req(h, 'GET', `/api/boards/${board}`, s)).json as { columns: Array<{ name: string; system_key: string }> };
      assert.deepEqual(view.columns?.map((c) => c.system_key), ['todo', 'doing', 'with_you', 'done'], 'a tela recebe o código de cada coluna');
    });
  });
});

describe('pedido numa conta conectada, em inglês: a conferência pelo registro do serviço', () => {
  let h: Harness; let s: Session;
  before(async () => {
    h = await harness(); s = await setupOwner(h);
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
  });
  after(() => h.close());
  const ids = (t: string) => intencoesDoPedido(h.db, s.workspaceId, t).map((i) => i.id);

  test('pedidos do dia a dia', () => {
    for (const [p, quer] of [
      ['Reply to João on Teams that I agree', 'teams.enviar'],
      ['Tell the team on Teams that the meeting moved', 'teams.enviar'],
      ['Check Teams and tell me what is important', 'teams.ler'],
      ['Reply to the client email confirming the delivery', 'email.enviar'],
      ['Send the proposal to ana@empresa.com.br', 'email.enviar'],
      ['Email Ana the proposal', 'email.enviar'],
      ['Read my emails from today and summarize them', 'email.ler'],
      ['Summarize my inbox', 'email.ler'],
      ['Create a task in Planner to review the contract', 'tarefa.criar'],
      ['Schedule a meeting with Carla tomorrow', 'agenda.criar'],
      // o português de sempre
      ['responde o João no teams que eu topo', 'teams.enviar'],
      ['lê meus emails de hoje e me resume', 'email.ler'],
    ] as const) assert.ok(ids(p).includes(quer), `${p} -> ${JSON.stringify(ids(p))}`);
  });

  test('o que não é pedido de ação na conta', () => {
    for (const p of [
      'How do I reply to emails faster?',
      "Don't send the email, just draft it for me",
      'Write a guide on how to reply to customer emails',
      'Tell me what the client replies on Teams when I ask about the deadline',
      'What is the best time to send emails?',
      'Help me reply to this email that I pasted below',
      "I'll send it myself, just prepare the text of the email",
    ]) assert.ok(!ids(p).some((x) => x === 'email.enviar' || x === 'teams.enviar'), `${p} -> ${JSON.stringify(ids(p))}`);
    assert.ok(!ids('Send me a summary of my emails').includes('email.enviar'), 'o resumo vem aqui: é leitura');
  });

  test('"message", "post", "reply" e "text" depois de artigo são o substantivo, não o pedido de envio', () => {
    for (const p of [
      'Summarize the last message from Ana in Teams',
      'Translate the post on Teams into Portuguese',
      'Explain the message in Teams from the CFO',
      'Summarize the reply from the client email',
      'Check the text of the message on Teams for typos',
      // o português de sempre
      'resuma a última mensagem da Ana no Teams',
      // a palavra do inglês num pedido em português
      'Revise o texto do post do Teams de amanhã',
      'Melhore o post que saiu no Teams ontem',
    ]) assert.ok(!ids(p).some((x) => x === 'teams.enviar' || x === 'email.enviar'), `${p} -> ${JSON.stringify(ids(p))}`);
    assert.ok(ids('Summarize the last message from Ana in Teams').includes('teams.ler'), 'é leitura do Teams');
    // o verbo de verdade continua
    for (const [p, quer] of [['Message Ana on Teams that the meeting moved', 'teams.enviar'], ['Post it on Teams', 'teams.enviar'],
      ['Read the thread and reply to Bruno on Teams', 'teams.enviar'], ['Can you text João on Teams about the delay', 'teams.enviar']] as const)
      assert.ok(ids(p).includes(quer), `${p} -> ${JSON.stringify(ids(p))}`);
  });

  test('"teams" em inglês são os times: só o Microsoft Teams quando a forma não deixa dúvida', () => {
    for (const p of [
      'Analyze the performance of the sales teams this quarter',
      'Review the results of both teams and list the top 3 issues',
      'Tell the teams that the office will be closed on Friday',
      'Write a short note to both teams about the new holiday policy',
      'Summarize the quarter for our teams',
      'Prepare an onboarding plan for new hires in our teams',
      'Organize people in teams of four',
    ]) {
      assert.ok(!ids(p).some((x) => x.startsWith('teams.')), `${p} -> ${JSON.stringify(ids(p))}`);
      assert.ok(!intencoesPelaConta(h.db, s.workspaceId, p, 'I reviewed the results of both teams.').length, `rede: ${p}`);
    }
    for (const [p, quer] of [['Check Microsoft teams and tell me what is new', 'teams.ler'], ['check the teams chat from today', 'teams.ler'],
      ['reply to Ana on teams that I agree', 'teams.enviar'], ['lê as mensagens do teams de hoje', 'teams.ler']] as const)
      assert.ok(ids(p).includes(quer), `${p} -> ${JSON.stringify(ids(p))}`);
  });

  test('aplicativo com nome de palavra comum (monday.com): "on Monday" é o dia', () => {
    setIntegration(h.db, s.workspaceId, 'monday', { state: 'connected', account_label: 'Quadro', connected_at: new Date().toISOString() });
    try {
      const rede = (p: string) => intencoesPelaConta(h.db, s.workspaceId, p, 'Here is the agenda.').map((i) => i.id);
      for (const p of ['Prepare the agenda for our meeting on Monday', 'Write a one-page summary on Monday sales', 'Create the launch tasks on Monday']) {
        assert.ok(!rede(p).some((x) => /monday/.test(x)), `${p} -> ${JSON.stringify(rede(p))}`);
        assert.ok(!intencoesDoPedido(h.db, s.workspaceId, p).some((i) => i.pares.some((x) => x.startsWith('monday:'))), p);
      }
      assert.ok(intencoesDoPedido(h.db, s.workspaceId, 'Create the launch tasks in monday.com').some((i) => i.pares.some((x) => x.startsWith('monday:'))), 'a marca');
      assert.ok(rede('cria as tarefas do lançamento no monday').some((x) => /monday/.test(x)), 'o lugar em português');
    } finally {
      setIntegration(h.db, s.workspaceId, 'monday', { state: 'off' });
    }
  });

  test('pedido sobre a equipe inteira (a coordenação recebe a lista toda), nas duas línguas', () => {
    for (const t of ['List all my agents', 'Rename everyone with Greek names', 'Who on the team handles invoices?', 'Deactivate the marketing writer', 'Quais são os meus agentes?'])
      assert.ok(pedeEquipeInteira(h.db, s.workspaceId, { texto: t }), t);
    assert.ok(!pedeEquipeInteira(h.db, s.workspaceId, { texto: 'Write a short report about the quarter' }));
  });
});

describe('ponta a ponta: a equipe responde em inglês', () => {
  class Motor implements HermesClient {
    runs = new Map<string, RemoteRun>();
    n = 0;
    async health() { return { ok: true, detail: 'teste' }; }
    async startRun(_p: StartRun) {
      const runId = `run_ingles${String(++this.n).padStart(6, '0')}`;
      this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
      return { runId, replayed: false };
    }
    async getRun(id: string) { return this.runs.get(id)!; }
    async stop() { return { accepted: true, detail: 'ok' }; }
    async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
    async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
  }
  let h: Harness; let s: Session; let motor: Motor; let agente: string;
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-0123456789' }, { hermes: motor });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
  });
  after(() => h.close());
  async function entregar(titulo: string, output: string, conversa = false): Promise<string> {
    const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json as { id: string };
    if (conversa) {
      const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
      h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, t.id);
    }
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
    await tick();
    const r = h.db.get<{ hermes_run_id: string }>("SELECT hermes_run_id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%' ORDER BY created_at DESC LIMIT 1", t.id)!;
    motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
    await tick();
    return t.id;
  }
  const resultado = (taskId: string) => h.db.get<{ state: string; justification: string; evidence: string }>(
    'SELECT state, justification, evidence FROM task_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId)!;

  test('"I couldn\'t…" é falha declarada, nunca entrega para aprovar', async () => {
    const id = await entregar('Research competitors of our scheduling app', "I couldn't access the competitors' websites: the browsing tool is not enabled for me. Nothing was delivered yet.", true);
    const r = resultado(id);
    assert.equal(r.state, 'falha', r.justification);
    assert.equal(JSON.parse(r.evidence).honesta, 'declarou');
    assert.match(r.justification, /disse “(Nothing was delivered yet|I couldn't access)/);
  });

  test('"Done." sozinho não é entrega', async () => {
    const id = await entregar('Write a short note about the new office hours', 'Done.');
    assert.equal(resultado(id).state, 'reprovado');
  });

  test('a entrega em inglês com a linha "For you to decide:" vai para você aprovar, com a frase dela', async () => {
    const texto = 'The research covers the four main competitors, their prices, the features they offer and how customers rate them in public reviews, with the sources listed at the end of each section so you can check them.';
    const id = await entregar('Research competitors of our scheduling app', `${texto}\n\nFor you to decide: choose which two competitors we should study in depth next week.`, true);
    assert.equal(resultado(id).state, 'aguardando_aprovacao', resultado(id).justification);
    const resumo = resumoDaTarefa(h.db, s.workspaceId, id);
    assert.match(JSON.stringify(resumo), /choose which two competitors/);
  });
});

describe('o idioma do texto e os nomes de aplicativo que são palavras comuns', () => {
  test('idioma pelas palavras de ligação', () => {
    assert.equal(idioma('Please reply to the client on Teams'), 'en');
    assert.equal(idioma('Revise o texto do post do Teams de amanhã'), 'pt');
    assert.equal(idioma('Check Teams'), null, 'sem palavra de ligação: as duas leituras valem');
    assert.equal(idioma('cria as tarefas para o lançamento no monday.com'), 'pt');
  });
  test('"teams", "monday", "notion" e "linear" só ficam quando são o aplicativo', () => {
    const f = (s: string) => semNomeComum(s, s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase());
    assert.match(f('Reply on Teams'), /teams/);
    assert.match(f('no teams'), /teams/);
    assert.doesNotMatch(f('the sales teams'), /teams/);
    assert.doesNotMatch(f('teams of four'), /teams/);
    assert.doesNotMatch(f('the meeting on Monday'), /monday/);
    assert.match(f('the board in monday.com'), /monday/);
    assert.match(f('pelo monday'), /monday/);
    assert.doesNotMatch(f('the notion that prices will drop'), /notion/);
    assert.match(f('a page in Notion'), /notion/);
    assert.doesNotMatch(f('linear growth in sales'), /linear/);
    assert.equal(f('o mesmo comprimento').length, 'o mesmo comprimento'.length);
  });
});

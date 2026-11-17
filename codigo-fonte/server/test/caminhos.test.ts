/**
 * rc.33: caminhos do motor nunca chegam à pessoa (shared/caminhos.ts) — na conversa do app e no que sai pelos canais
 * externos (Telegram, Discord, Teams, WhatsApp da equipe: textoParaTeams).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ARQUIVO_INTERNO, limparCaminhos } from '../../shared/caminhos.ts';
import { textoParaTeams } from '../src/services/teams-app/cartoes.ts';

const DOC = { id: `art_${'a'.repeat(32)}`, filename: 'relatorio.pdf' };
const achar = (nome: string) => (nome === 'relatorio.pdf' ? DOC : null);
const INTERNO = /\/opt\/|\/tmp\/|\/home\/|\/root\/|HERMES_HOME|erg-[a-f0-9]|MEDIA:/;

describe('limparCaminhos', () => {
  test('caminhos de vários formatos viram "(arquivo interno)"', () => {
    const casos: Array<[string, string]> = [
      ['Salvei em /opt/data/profiles/erg-cc4d086464da8211f507/home/notas.txt', `Salvei em ${ARQUIVO_INTERNO}`],
      ['O programa está em /opt/hermes/.venv/bin/python.', `O programa está em ${ARQUIVO_INTERNO}.`],
      ['rascunho: /tmp/tmpab12/rascunho.md', `rascunho: ${ARQUIVO_INTERNO}`],
      ['veja /home/hermes/.config/browser-harness/tmp/shot.png!', `veja ${ARQUIVO_INTERNO}!`],
      ['Usei `/root/.cache/x.json` ontem', `Usei ${ARQUIVO_INTERNO} ontem`],
      ['(o arquivo /var/tmp/a.csv)', `(o arquivo ${ARQUIVO_INTERNO})`],
      ['a pasta ~/Downloads/x.zip', `a pasta ${ARQUIVO_INTERNO}`],
      ['está em $HERMES_HOME/skills/a.md e ${HERMES_HOME}/b', `está em ${ARQUIVO_INTERNO} e ${ARQUIVO_INTERNO}`],
      ['| arquivo | /opt/data/cache/generated/x.png |', `| arquivo | ${ARQUIVO_INTERNO} |`],
      ['(/tmp/a.png)', ARQUIVO_INTERNO],
    ];
    for (const [entra, sai] of casos) assert.equal(limparCaminhos(entra), sai, entra);
  });

  test('o arquivo que está em Documentos vira o link dele', () => {
    assert.equal(limparCaminhos('O relatório: /opt/data/profiles/erg-cc4d086464da8211f507/home/relatorio.pdf.', achar), `O relatório: [documento: ${DOC.id} relatorio.pdf].`);
    assert.equal(limparCaminhos('Pronto: `/tmp/x/relatorio.pdf`', achar), `Pronto: [documento: ${DOC.id} relatorio.pdf]`);
    assert.equal(limparCaminhos('Pasta: /tmp/x/', achar), `Pasta: ${ARQUIVO_INTERNO}`, 'pasta não é procurada em Documentos');
  });

  test('MEDIA: perdido sai com a linha; o id do perfil sai; o resto do texto fica', () => {
    assert.equal(limparCaminhos('Aí está: a tela.\n\nMEDIA:/opt/data/profiles/erg-cc4d086464da8211f507/home/.config/browser-harness/tmp/shot.png\n\nMais algo.'), 'Aí está: a tela.\n\nMais algo.');
    assert.equal(limparCaminhos('O perfil erg-cc4d086464da8211f507 rodou.'), 'O perfil rodou.');
  });

  test('o que não é caminho do motor fica como está', () => {
    for (const t of ['https://exemplo.com/tmp/a.png e http://x.com/home/', '1/2 de 3/4', 'a/home/b', '/homepage', 'docs em Documentos/Relatórios/x.pdf', 'erg-nome-qualquer', 'uma barra / sozinha']) {
      assert.equal(limparCaminhos(t), t, t);
    }
  });
});

describe('textoParaTeams (canais externos: Telegram, Discord, Teams, WhatsApp)', () => {
  test('sai sem caminho do motor e sem MEDIA', () => {
    const t = textoParaTeams('Aí está a tela.\nMEDIA:/opt/data/profiles/erg-cc4d086464da8211f507/home/.config/browser-harness/tmp/shot.png\nO rascunho ficou em /tmp/rascunho.md; use $HERMES_HOME/x.');
    assert.doesNotMatch(t, INTERNO, t);
    assert.equal(t, `Aí está a tela.\nO rascunho ficou em ${ARQUIVO_INTERNO}; use ${ARQUIVO_INTERNO}.`);
  });
  test('o link de um documento vai pelo nome', () => {
    assert.equal(textoParaTeams(`Pronto: [documento: ${DOC.id} relatorio.pdf].`), 'Pronto: relatorio.pdf.');
  });
});

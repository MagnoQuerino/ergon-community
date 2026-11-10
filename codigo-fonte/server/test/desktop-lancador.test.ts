// O Ergon Desktop e o lançador (ergon.sh / ergon.ps1) na rc.26: o Desktop continua chamando os nomes de antes
// (instalar, subir, parar, backup), para dar para voltar de versão sem quebrar, e pede as mensagens em português
// (ERGON_LANG=pt), porque as telas dele ainda são só em português e mostram as linhas e o último erro do lançador.
// Dentro do ambiente próprio do Windows (sem locale), o lançador cai em português pela marca /etc/ergon-ambiente.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const raiz = path.resolve(import.meta.dirname, '../..');
const ler = (rel: string) => fs.readFileSync(path.join(raiz, rel), 'utf8');
// o ergon.sh e o desktop/ambiente não vão na imagem de teste do Docker (só shared/server/web/fixtures/desktop/ui/src-tauri/src)
const seHouver = (rel: string) => (fs.existsSync(path.join(raiz, rel)) ? ler(rel) : null);

test('o Desktop chama o lançador com os nomes de antes', () => {
  const servicos = ler('desktop/src-tauri/src/servicos.rs');
  assert.match(servicos, /rodar_lancador\(&app2, &raiz, "subir"\)/);
  assert.match(servicos, /rodar_lancador\(app, &raiz, "parar"\)/);
  const ambiente = ler('desktop/src-tauri/src/ambiente.rs');
  assert.match(ambiente, /"\/root\/\.local\/share\/ergon\/ergon\.sh", "subir"/);
  assert.match(ambiente, /"\/root\/\.local\/share\/ergon\/ergon\.sh", "parar"/);
  assert.match(ambiente, /\.arg\(pac\.join\("ergon\.sh"\)\)\.arg\("instalar"\)/);
  for (const arq of ['ambiente.rs', 'atualizacao.rs', 'migracao.rs', 'servicos.rs', 'diag.rs']) {
    const rs = ler(`desktop/src-tauri/src/${arq}`);
    assert.doesNotMatch(rs, /ergon\.sh\\?"?,? ?"?(install|start|up|stop|update|uninstall)"/, `${arq}: nenhum nome novo chamado pelo Desktop`);
    assert.doesNotMatch(rs, /\.arg\("(install|start|up|stop|update|uninstall)"\)/, `${arq}: nenhum nome novo chamado pelo Desktop`);
  }
});

test('o Desktop pede as mensagens do lançador em português (as telas dele ainda são só em português)', () => {
  const servicos = ler('desktop/src-tauri/src/servicos.rs');
  const corpo = servicos.slice(servicos.indexOf('pub fn rodar_lancador'), servicos.indexOf('c.spawn()'));
  assert.ok(corpo.includes('c.env("ERGON_LANG", "pt");'), 'rodar_lancador (ergon.ps1 no Windows, ergon.sh no Linux)');
  const ambiente = ler('desktop/src-tauri/src/ambiente.rs');
  const linha = ambiente.split('\n').find((l) => l.includes('.arg(pac.join("ergon.sh")).arg("instalar")'));
  assert.ok(linha?.includes('.env("ERGON_LANG", "pt")'), 'instalação dos serviços no Linux pelo Desktop');
});

test('a orientação do diagnóstico cita o nome que todo lançador conhece', () => {
  const diag = ler('desktop/src-tauri/src/diag.rs');
  assert.ok(diag.includes('ligue pelo lançador (ergon iniciar) uma vez'), 'o "iniciar" vale em todas as versões');
  assert.ok(!diag.includes('(ergon start)'), 'um lançador anterior à rc.26 não conhece o "start"');
});

test('no ambiente próprio do Windows o lançador fica em português pela marca da imagem', (t) => {
  const containerfile = seHouver('desktop/ambiente/Containerfile');
  const sh = seHouver('ergon.sh');
  if (!containerfile || !sh) return t.skip('ergon.sh ou desktop/ambiente fora desta cópia');
  assert.match(containerfile, /> \/etc\/ergon-ambiente/, 'a imagem grava a marca');
  assert.match(sh, /AMBIENTE_DESKTOP="\$\{ERGON_AMBIENTE_MARCA:-\/etc\/ergon-ambiente\}"/, 'o lançador procura a mesma marca');
  assert.match(sh, /if \[\[ -f "\$AMBIENTE_DESKTOP" \]\]; then echo pt; else echo en; fi/, 'sem idioma dito: português só com a marca');
});

test('os guias dizem a quem vem da rc.25 ou de antes que o lançador instalado só conhece "ergon atualizar"', (t) => {
  const guias = ['docs/INSTALAR.md', 'community/publico/docs/INSTALAR.md', 'docs/DESKTOP.md', 'community/publico/docs/DESKTOP.md'];
  const lidos = guias.map((g) => [g, seHouver(g)] as const).filter(([, txt]) => txt !== null);
  if (!lidos.length) return t.skip('guias fora desta cópia');
  for (const [g, txt] of lidos) {
    const unido = txt!.replace(/\s+/g, ' ');
    assert.ok(/Vindo da 1\.1\.0-rc\.25 ou de antes\W.*só conhece os nomes em português.*`ergon atualizar`/.test(unido), g);
  }
});

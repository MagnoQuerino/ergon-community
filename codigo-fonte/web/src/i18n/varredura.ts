// Varredura do teste-catraca (catraca.test.ts): acha, num arquivo de tela, texto em português escrito direto no código
// em vez de vir do dicionário (t('area.chave')). Usa o próprio compilador do TypeScript para ler o arquivo (nada de
// expressão regular sobre o código: comentários, tipos e expressões regulares não entram). Só os testes importam isto;
// a tela nunca carrega o compilador.
//
// O que conta como texto de tela (a heurística, de propósito simples e previsível):
//   1. Texto solto no JSX (<b>Salvar</b>) com letras, tirando nomes que valem nas duas línguas (Ergon, Microsoft,
//      Ctrl…; lista UNIVERSAIS).
//   2. Qualquer texto entre aspas com letra acentuada do português (á, ã, ç, ê, õ…): "Configurações", "não".
//   3. Texto entre aspas com cara de frase: duas palavras ou mais e (começa com maiúscula, termina com . ! ? : … ou tem
//      uma palavra curta do português como "de", "para", "com", "você", "sem"). Num template, o pedaço com espaço e uma
//      palavra dessa lista (`${n} agentes`) e o plural montado à mão (`${n} agente${n === 1 ? '' : 's'}`) também contam.
//   4. Texto entre aspas em lugar visível: atributo title, aria-label, placeholder, alt, label… do JSX; propriedade
//      label, title, text, name, sub, hint… de um objeto; o resultado de uma expressão dentro do JSX
//      ({ok ? 'Pronto' : 'Erro'}); ou o argumento de quem mostra o texto (toast, alert, confirm, setHint, setErr…).
//   5. O idioma fixo 'pt-BR' (datas e números): use fmtData, fmtNumero… de i18n/index.ts.
//   6. A palavra solta num lugar de valor — valor de propriedade de objeto, item de lista, argumento de chamada que não é
//      técnica, valor padrão de parâmetro, valor inicial de variável ou o que uma função devolve: com maiúscula
//      ('Fixadas', 'Planilha'), terminada em . ! ? … ('Desfeito.', 'Enviando…') ou uma palavra que só aparece na tela
//      (PALAVRAS_SOLTAS: 'ontem', 'hoje', 'pronto'…). É a regra que pega as tabelas de rótulos ({ fixadas: 'Fixadas' },
//      ['Dom', 'Seg']) e o padrão de um parâmetro ({ label = 'Carregando…' }).
// Ficam de fora: o caminho de um import, tipos ('auto' | 'dia'), o 1º argumento de t()/tn(), chaves de objeto,
// className, key, id, href, data-*, role, type e parecidos, comparações (x === 'Concluída' só pela regra 2), nomes de
// tecla ('Escape', 'ArrowUp') e o que vai para console, localStorage e a API.
// Uma linha com o comentário  i18n-ok  (na própria linha ou na de cima) também fica de fora: use para texto que não é
// de tela (um padrão que reconhece o português do servidor, um nome interno com maiúscula) e diga o porquê no mesmo
// comentário.
import ts from 'typescript';

export interface Achado { linha: number; texto: string; regra: 1 | 2 | 3 | 4 | 5 | 6 }

/** Letras que só o português usa (o inglês não acentua). */
const ACENTO = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
/** Palavras curtas do português que quase nunca aparecem num texto técnico ou em inglês. */
const PALAVRAS_PT = new Set(('de da do das dos para pra com sem uma um uns umas que seu sua seus suas ou mais como quando ' +
  'ainda aqui isso isto este esta esse essa pelo pela pelos pelas ao aos nos nas em e o os voce vez ja nada tudo ' +
  'cada outro outra outros outras ate entre depois antes sobre sempre nunca muito pouco aguardando conta tarefa tarefas ' +
  'equipe cidade conversa conversas agente agentes rotina rotinas quadro quadros pedir abrir fechar salvar cancelar ' +
  'buscar sair ligado desligado excluir apagar voltar enviar criar novo nova ver mostrar').split(' '));
/** Palavras soltas que só aparecem como texto de tela (regra 6, mesmo em minúscula). */
const PALAVRAS_SOLTAS = new Set(('ontem hoje amanha nunca sempre nenhum nenhuma sim pronto pronta feito feita falhou ' +
  'erro aguardando trabalhando parado parada pausado pausada desfeito salvo enviado enviando copiado carregando').split(' '));
/** Nomes que valem nas duas línguas: não pedem tradução quando aparecem sozinhos no JSX. */
const UNIVERSAIS = new Set(('Ergon Ctrl Cmd Alt Shift Esc Enter Tab K OK Nous Microsoft Google GitHub WhatsApp Teams ' +
  'Telegram Slack Discord Notion Trello Outlook Gmail Planner PNG JPEG WebP PDF CSV JSON URL ZIP MB KB GB ID API Linux ' +
  'Windows macOS Mac PC Wi-Fi Stripe OpenAI ChatGPT Claude Anthropic Gemini Podman Tauri Pix Jira Asana Todoist ClickUp ' +
  'Linear Airtable Monday SharePoint OneDrive Dropbox Zoom Edge Chrome Firefox Safari Android iOS iPhone iPad Word Excel ' +
  'PowerPoint Smartsheet Pipefy').split(' '));
/** Nomes de tecla do navegador (e.key): técnicos, mesmo com maiúscula. */
const TECLAS = new Set(('Escape ArrowUp ArrowDown ArrowLeft ArrowRight Backspace Delete Home End PageUp PageDown Space ' +
  'Control Meta Insert Spacebar').split(' '));

/** Atributos do JSX que a pessoa lê. */
const ATRIBUTOS_VISIVEIS = new Set(['title', 'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'placeholder', 'alt', 'label',
  'text', 'confirmLabel', 'cancelLabel', 'hint', 'sub', 'description', 'message', 'heading', 'caption', 'subtitle', 'emptyText', 'tooltip']);
/** Propriedades de objeto que costumam ir para a tela. */
const PROPRIEDADES_VISIVEIS = new Set(['label', 'title', 'text', 'name', 'sub', 'hint', 'placeholder', 'description', 'desc', 'summary', 'confirmLabel',
  'cancelLabel', 'message', 'msg', 'aria', 'ariaLabel', 'heading', 'caption', 'subtitle', 'tip', 'help', 'detail', 'short', 'long', 'empty', 'nome', 'titulo', 'texto', 'rotulo', 'dica']);
/** Atributos técnicos: o valor nunca é texto de tela. */
const ATRIBUTOS_TECNICOS = /^(className|class|key|id|href|src|style|role|type|name|htmlFor|inputMode|autoComplete|accept|target|rel|method|action|lang|dir|tabIndex|data-[\w-]+|aria-(controls|labelledby|describedby|haspopup|live|current|owns))$/;
/** Chamadas cujo texto não vai para a tela. */
const CHAMADAS_TECNICAS = /^(console\.\w+|localStorage\.\w+|sessionStorage\.\w+|\w*[Ss]torage\w*|matchMedia|querySelector(All)?|document\.\w+|addEventListener|removeEventListener|dispatchEvent|api\.\w+|fetch|import|require|history\.\w+|setAttribute|getAttribute|classList\.\w+|t|tn|plural|useT|localPref|saveLocalPref|useResource|prefetchResources|postMessage|URLSearchParams|new URL|encodeURIComponent)$/;
/** Chamadas que mostram o texto na tela: o argumento é texto de tela, mesmo uma palavra minúscula (regra 4). */
const CHAMADAS_DE_TELA = /^(toast|alert|confirm|prompt|notify|avisar|aviso|window\.(alert|confirm|prompt)|set(Toast|Hint|Err|Erro|Error|Msg|Message|Aviso|Notice|Info|Feito|Status(Msg|Text)?))$/;

const palavras = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
const temLetras = (s: string) => /\p{L}{2,}/u.test(s);
/** Palavra = só letras (com aspas, parênteses e pontuação em volta): o caminho de um ícone SVG ("M4 6h16") e um pedaço de
 * HTML (<g class="x">) não contam. */
const PALAVRA = /^[("'“‘¿¡[]*(\p{L}[\p{L}'’-]*)[.,:;!?…)\]"'”’]*$/u;
const palavrasDeTexto = (s: string) => s.trim().split(/[\s·/|›»«]+/).map((w) => PALAVRA.exec(w)?.[1]).filter((w): w is string => !!w);
/** Tira o que vale nas duas línguas (nomes de produto, teclas, números e sinais): sobra algo para traduzir? */
const sobraTexto = (s: string) => palavrasDeTexto(s).some((w) => !UNIVERSAIS.has(w) && w.length >= 2);

/** Endereço, caminho ou âncora ("/api/team?", "#configuracao?conta", "https://…"): não é frase. */
const ENDERECO = /^\s*[/#.]|:\/\//;

function pareceFrase(s: string): boolean {
  if (ENDERECO.test(s)) return false;
  const ws = palavrasDeTexto(s);
  if (ws.length < 2) return false;
  const t = s.trim();
  if (/^[\p{Lu}]/u.test(t) || /[.!?:…]$/.test(t)) return true;
  return palavras(t).some((w) => PALAVRAS_PT.has(w));
}

/** Regra 6: uma palavra só (o texto inteiro), com cara de rótulo de tela. */
function palavraSolta(s: string): boolean {
  const t = s.trim();
  if (!t || ENDERECO.test(t) || /\s/.test(t)) return false;
  const ws = palavrasDeTexto(t);
  if (ws.length !== 1) return false;
  const w = ws[0];
  if (w.length < 2 || UNIVERSAIS.has(w) || TECLAS.has(w)) return false;
  // a palavra tem de ser o texto todo (com pontuação em volta): 'Foo.bar', 'x-Y' e 'MyComponent' não são rótulos
  if (!PALAVRA.test(t)) return false;
  if (/[.!?…]$/.test(t) && /^\p{Lu}/u.test(w)) return true;
  if (/…$/.test(t)) return true;
  if (/^\p{Lu}\p{Ll}+$/u.test(w)) return true;
  return PALAVRAS_SOLTAS.has(palavras(w).join(''));
}

/** Regra 3 num template: o pedaço com espaço junto do ${…} e uma palavra do português (`${n} agentes`). */
function pedacoComPalavra(s: string): boolean {
  // grudado no ${…} por - _ . : é nome montado (`tarefa-${id}`, `card_${n}`), não frase
  if (ENDERECO.test(s) || !/(^\s|\s$)/.test(s) || /(^[-_.:]|[-_.:]$)/.test(s)) return false;
  return palavrasDeTexto(s).some((w) => /^\p{L}+$/u.test(w) && PALAVRAS_PT.has(palavras(w).join('')));
}

function nomeDaChamada(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${nomeDaChamada(e.expression).split('.').pop()}.${e.name.text}`;
  return '';
}

type Lugar = 'tecnico' | 'visivel' | 'valor' | 'comum';

/**
 * Lugar em que o texto está: técnico (fica de fora), visível (regra 4), de valor (regra 6: propriedade, lista,
 * argumento, padrão, valor inicial, retorno) ou comum (só as regras 2, 3 e 5).
 */
function lugar(no: ts.Node): Lugar {
  let filho: ts.Node = no;
  let p: ts.Node | undefined = no.parent;
  // sobe pelas expressões que só combinam textos (condicional, &&, ??, +, parênteses, template); a condição de um ?: e
  // o lado esquerdo de um && são comparação, não texto mostrado
  while (p) {
    if (ts.isConditionalExpression(p) && p.condition === filho) return 'comum';
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.left === filho) return 'comum';
    const combina = ts.isParenthesizedExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) ||
      ts.isConditionalExpression(p) ||
      (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(p.operatorToken.kind));
    if (!combina) break;
    filho = p; p = p.parent;
  }
  if (!p) return 'comum';
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p) || ts.isImportTypeNode(p)) return 'tecnico';
  if (ts.isPropertyAssignment(p) && p.name === filho) return 'tecnico';
  if (ts.isElementAccessExpression(p) && p.argumentExpression === filho) return 'tecnico';
  if (ts.isCaseClause(p)) return 'comum';
  if (ts.isJsxAttribute(p) || (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent))) {
    const at = ts.isJsxAttribute(p) ? p : (p.parent as ts.JsxAttribute);
    const nome = at.name.getText();
    if (ATRIBUTOS_TECNICOS.test(nome)) return 'tecnico';
    return ATRIBUTOS_VISIVEIS.has(nome) ? 'visivel' : 'valor';
  }
  if (ts.isJsxExpression(p)) return 'visivel';
  if (ts.isPropertyAssignment(p)) {
    const nome = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
    return PROPRIEDADES_VISIVEIS.has(nome) ? 'visivel' : 'valor';
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    // o texto como função chamada (`'x'()`) não existe; aqui ele é argumento
    const n = (ts.isNewExpression(p) ? 'new ' : '') + nomeDaChamada(p.expression);
    const ultimo = n.split('.').pop() ?? '';
    if (CHAMADAS_TECNICAS.test(n) || CHAMADAS_TECNICAS.test(ultimo)) return 'tecnico';
    if (CHAMADAS_DE_TELA.test(n) || CHAMADAS_DE_TELA.test(ultimo)) return 'visivel';
    return 'valor';
  }
  if (ts.isArrayLiteralExpression(p) || ts.isReturnStatement(p)) return 'valor';
  if (ts.isArrowFunction(p) && p.body === filho) return 'valor';
  if ((ts.isParameter(p) || ts.isBindingElement(p) || ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer === filho) return 'valor';
  return 'comum';
}

/** Linha com  i18n-ok  (nela ou na de cima): fica de fora, de propósito. */
function liberada(linhas: string[], i: number): boolean {
  return /i18n-ok/.test(linhas[i] ?? '') || /i18n-ok/.test(linhas[i - 1] ?? '');
}

/** `${n === 1 ? '' : 's'}`: o pedaço do plural montado à mão. */
const ehSufixoDePlural = (e: ts.Expression): boolean => {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return false;
  const lit = (x: ts.Expression) => (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && /^(|s|es|is|ns|ões|ães)$/.test(x.text);
  return lit(e.whenTrue) && lit(e.whenFalse);
};

/** Os textos de tela escritos direto no arquivo (vazio: o arquivo já lê tudo do dicionário). */
export function varrer(fonte: string, nomeArquivo = 'arquivo.tsx'): Achado[] {
  const sf = ts.createSourceFile(nomeArquivo, fonte, ts.ScriptTarget.Latest, true, nomeArquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const linhas = fonte.split(/\r?\n/);
  const achados: Achado[] = [];
  const anotar = (no: ts.Node, texto: string, regra: Achado['regra']) => {
    const linha = sf.getLineAndCharacterOfPosition(no.getStart(sf)).line;
    if (!liberada(linhas, linha)) achados.push({ linha: linha + 1, texto: texto.trim().slice(0, 80), regra });
  };
  const visitar = (no: ts.Node) => {
    if (ts.isJsxText(no)) {
      const s = no.text.replace(/\s+/g, ' ').trim();
      if (temLetras(s) && sobraTexto(s)) anotar(no, s, 1);
    } else if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no) || ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) {
      const s = no.text;
      const pedaco = ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no);
      // um pedaço de `...${x}...` vale pelo lugar do template inteiro
      const base = ts.isTemplateHead(no) ? no.parent : pedaco ? no.parent.parent : no;
      const onde = lugar(base);
      if (onde !== 'tecnico') {
        // o pedaço seguido de ${n === 1 ? '' : 's'} (o plural montado à mão)
        const span = ts.isTemplateHead(no) ? (no.parent as ts.TemplateExpression).templateSpans[0] : pedaco && !ts.isTemplateTail(no) ? (no.parent as ts.TemplateSpan).parent.templateSpans[(no.parent as ts.TemplateSpan).parent.templateSpans.indexOf(no.parent as ts.TemplateSpan) + 1] : undefined;
        const pluralAMao = !!span && /\p{L}$/u.test(s) && ehSufixoDePlural(span.expression);
        if (s === 'pt-BR') anotar(no, s, 5);
        else if (ACENTO.test(s)) anotar(no, s, 2);
        else if (pareceFrase(s) || (pedaco && (pedacoComPalavra(s) || pluralAMao))) anotar(no, s, 3);
        else if (onde === 'visivel' && !ENDERECO.test(s) && temLetras(s) && sobraTexto(s)) anotar(no, s, 4);
        else if ((onde === 'valor' || onde === 'visivel') && !pedaco && palavraSolta(s)) anotar(no, s, 6);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return achados;
}

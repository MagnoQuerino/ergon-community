/**
 * Quem foi chamado pela voz (rc.49): acha, numa transcrição, os nomes dos agentes da sala — sem IA, para qualquer nome.
 *
 * O índice é montado na hora a partir dos nomes que a equipe tem agora (renomear um agente ou criar outro já vale na
 * próxima fala). Cada nome e cada palavra da fala viram uma chave fonética: sem acento, sem letra muda, com as trocas que
 * a transcrição costuma fazer (s/z/ç/ss, c/k/q, ph/f, th/t, y/i, w/v, e/i e o/u no fim, letras dobradas). Depois, a
 * distância de edição entre as chaves, com uma tolerância que cresce com o tamanho do nome: "Sócrates" casa com
 * "socrates", "Socratis", "Sócrate" e "ocrates"; um nome curto (até 3 sons) só casa inteiro. Nome que a transcrição
 * partiu em dois ("Arqui medes") e nome composto ("Ana Clara") também casam. As palavras comuns da língua nunca contam
 * como nome curto.
 *
 * Uso: `mencionados(texto, nomes)` → os nomes chamados, na ordem em que aparecem na fala. `chamaTodos(texto)`: a fala
 * começa chamando o grupo ("pessoal", "todo mundo", "equipe", "everyone"...).
 */

/** minúsculas, sem acento, só letras e espaço */
export function semAcento(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A chave fonética de uma palavra (já sem acento). */
export function chaveFonetica(palavra: string): string {
  let s = semAcento(palavra).replace(/\s+/g, '');
  if (!s) return '';
  s = s
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/sh/g, 'x').replace(/ch/g, 'x')
    .replace(/lh/g, 'li').replace(/nh/g, 'ni')
    .replace(/qu(?=[ei])/g, 'k').replace(/gu(?=[ei])/g, 'g').replace(/q/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/ç/g, 's').replace(/z/g, 's').replace(/y/g, 'i').replace(/w/g, 'v')
    .replace(/sc(?=[ei])/g, 's').replace(/xc(?=[ei])/g, 's')
    .replace(/h/g, '');
  // o fim átono, que a transcrição troca: -es/-is, -e/-i, -os/-us, -o/-u, -am/-ao
  s = s.replace(/es$/, 'is').replace(/e$/, 'i').replace(/os$/, 'us').replace(/o$/, 'u').replace(/am$/, 'au').replace(/ao$/, 'au');
  // n/m antes de consoante (nasal) soam igual
  s = s.replace(/m(?=[^aeiou])/g, 'n');
  // letras dobradas
  s = s.replace(/(.)\1+/g, '$1');
  return s;
}

/** distância de edição (Damerau restrita: troca de duas letras vizinhas conta 1) */
export function distancia(a: string, b: string, teto = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  const m = a.length; const n = b.length;
  let p2 = new Array<number>(n + 1).fill(0);
  let p1 = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const c = new Array<number>(n + 1).fill(0);
    c[0] = i;
    let menor = c[0];
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      c[j] = Math.min(p1[j] + 1, c[j - 1] + 1, p1[j - 1] + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) c[j] = Math.min(c[j], p2[j - 2] + 1);
      if (c[j] < menor) menor = c[j];
    }
    if (menor > teto) return teto + 1;
    p2 = p1; p1 = c;
  }
  return p1[n];
}

/** quantos erros a chave de um nome tolera (pelo tamanho dela) */
export function tolerancia(chave: string): number {
  const n = chave.length;
  if (n <= 3) return 0;
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  return 3;
}

/**
 * Palavras comuns (pt, en, es) que nunca contam como um nome curto: "a", "ana" (o verbo), "eu", "mais"... Um nome que é
 * também uma dessas palavras só casa com a palavra escrita igual, com maiúscula, na transcrição (o transcritor costuma
 * pôr maiúscula em nome próprio).
 */
const COMUNS = new Set(('a o e é as os um uma uns umas de do da dos das no na nos nas em por para pra pro com sem que se ' +
  'eu tu ele ela nos vos eles elas me te lhe mim ti meu minha seu sua isso isto aquilo ai aqui la ali ja so mas mais menos ' +
  'sim nao ou nem bem mal tem ter ser estar foi vai vou faz fez ver dar dia hoje ano mes hora oi ola ate ainda tudo todo toda ' +
  'the a an and or of to in on for with is are be it this that you he she we they me my your his her our yes no hi hey ok ' +
  'y el la los las del al con por para que es un una lo le se mi tu su si').split(' '));

export interface NomeAchado { nome: string; posicao: number; erros: number }

interface Entrada { nome: string; partes: string[]; chaves: string[]; junto: string }

function entradas(nomes: readonly string[]): Entrada[] {
  const out: Entrada[] = [];
  for (const nome of nomes) {
    const partes = semAcento(nome).split(' ').filter(Boolean);
    if (!partes.length) continue;
    const chaves = partes.map(chaveFonetica).filter(Boolean);
    out.push({ nome, partes, chaves, junto: chaveFonetica(partes.join('')) });
  }
  return out;
}

/**
 * Os nomes de `nomes` chamados em `texto`, na ordem da fala (cada nome uma vez). Vale o nome inteiro ("Ana Clara"), o
 * primeiro nome sozinho quando ele é só de um agente ("Ana", se não houver "Ana Paula" também) e o nome partido em dois
 * pela transcrição.
 */
export function mencionados(texto: string, nomes: readonly string[]): NomeAchado[] {
  const bruto = String(texto ?? '').normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const pal = bruto.map((w) => semAcento(w));
  const chaves = pal.map(chaveFonetica);
  const ents = entradas(nomes);
  // primeiro nome que só um agente usa: vale sozinho
  const primeiros = new Map<string, number>();
  for (const e of ents) primeiros.set(e.chaves[0], (primeiros.get(e.chaves[0]) ?? 0) + 1);
  const achados = new Map<string, NomeAchado>();
  const anotar = (nome: string, posicao: number, erros: number) => {
    const ja = achados.get(nome);
    if (!ja || erros < ja.erros || (erros === ja.erros && posicao < ja.posicao)) achados.set(nome, { nome, posicao: ja ? Math.min(ja.posicao, posicao) : posicao, erros });
  };
  const casa = (chaveNome: string, chaveFala: string, palavra: string, original: string): number | null => {
    if (!chaveNome || !chaveFala) return null;
    const tol = tolerancia(chaveNome);
    // nome curto ou palavra comum: só igual (e a palavra comum, só com maiúscula, como nome próprio)
    if (tol === 0 || COMUNS.has(palavra)) {
      if (chaveNome !== chaveFala) return null;
      if (COMUNS.has(palavra) && !/^\p{Lu}/u.test(original)) return null;
      return 0;
    }
    // a primeira letra (o som de ataque) costuma sobreviver; sem ela, só um erro a mais é aceito ("ocrates")
    const d = distancia(chaveNome, chaveFala, tol);
    if (d > tol) return null;
    // a fala bem mais curta que o nome não é ele ("so" não é "socrates")
    if (chaveFala.length < Math.ceil(chaveNome.length * 0.6)) return null;
    return d;
  };
  for (const e of ents) {
    const n = e.chaves.length;
    for (let i = 0; i < pal.length; i++) {
      // o nome inteiro, palavra por palavra
      if (n > 1 && i + n <= pal.length) {
        let soma = 0; let ok = true;
        for (let k = 0; k < n && ok; k++) { const d = casa(e.chaves[k], chaves[i + k], pal[i + k], bruto[i + k]); if (d === null) ok = false; else soma += d; }
        if (ok) anotar(e.nome, i, soma);
      }
      // o primeiro nome sozinho (quando só este agente o tem) ou o nome de uma palavra
      if (primeiros.get(e.chaves[0]) === 1 || n === 1) {
        const d = casa(e.chaves[0], chaves[i], pal[i], bruto[i]);
        if (d !== null) anotar(e.nome, i, d);
      }
      // a transcrição partiu o nome em dois ou três pedaços ("Arqui medes", "Hi pátia")
      for (let k = 2; k <= 3 && i + k <= pal.length; k++) {
        const junto = chaveFonetica(pal.slice(i, i + k).join(''));
        const alvo = n > 1 ? e.junto : e.chaves[0];
        if (pal.slice(i, i + k).some((w) => w.length > alvo.length)) continue;
        const d = casa(alvo, junto, pal.slice(i, i + k).join(''), bruto[i]);
        if (d !== null) anotar(e.nome, i, d + 1);
      }
    }
  }
  return [...achados.values()].sort((a, b) => a.posicao - b.posicao || a.erros - b.erros);
}

/** chamar o grupo todo, no começo da fala */
const TODOS = /^(?:(?:oi|ola|ei|e ai|bom dia|boa tarde|boa noite|hey|hi|hello)\s+)?(?:pessoal|todo mundo|todos|galera|equipe|time|turma|gente|everyone|everybody|team|all|guys)\b/;

/** A fala começa chamando o grupo ("Pessoal, ...", "Bom dia, equipe", "Everyone, ..."). */
export function chamaTodos(texto: string): boolean {
  const s = semAcento(texto).replace(/\s+/g, ' ').trim();
  return TODOS.test(s);
}

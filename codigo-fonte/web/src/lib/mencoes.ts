// O campo de mensagem das Salas: @ (pessoa ou agente) e # (cessão de conexões, só pessoas). Regra do dono (rc.42), sem
// menção por acidente:
// - ao digitar o marcador aparece a sugestão; a marca só se forma se a pessoa digitar o nome EXATAMENTE igual a um
//   sugerido (e seguir com espaço ou pontuação, ou enviar) ou apertar Tab (o primeiro da lista); Enter ou clique na lista
//   também escolhem;
// - sem isso, o texto segue cru (nenhuma marca vai ao servidor);
// - um Backspace logo depois de uma marca formada a desfaz (vira texto cru, sem apagar letra); o próximo apaga normalmente.
// Puro (sem tela) para os testes; o servidor confere de novo o que chega (services/salas/marcas.ts).
export type TipoMarca = 'pessoa' | 'agente' | 'cessao';
export interface Candidato { tipo: 'pessoa' | 'agente'; chave: string; nome: string }
export interface MarcaCampo { tipo: TipoMarca; chave: string; inicio: number; fim: number }
/** o texto, as marcas formadas e a marca recém-formada (o Backspace seguinte a desfaz) */
export interface Campo { texto: string; marcas: MarcaCampo[]; recem: number | null }
export interface Token { marcador: '@' | '#'; inicio: number; consulta: string }

export const vazio = (): Campo => ({ texto: '', marcas: [], recem: null });
const DELIM = /[\s,.;:!?)]/;
const NOME_MAX = 40;
const dobra = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** O marcador sendo digitado antes do cursor (fora de uma marca), ou null. */
export function tokenAtivo(c: Campo, cursor: number): Token | null {
  const antes = c.texto.slice(0, cursor);
  for (let i = antes.length - 1; i >= 0 && antes.length - i <= NOME_MAX + 1; i--) {
    const ch = antes[i];
    if (ch === '\n') return null;
    if (ch === '@' || ch === '#') {
      if (i > 0 && !/[\s(]/.test(antes[i - 1])) return null; // "ana@empresa", "C#": não é marcador
      if (c.marcas.some((m) => i >= m.inicio && i < m.fim)) return null;
      const consulta = antes.slice(i + 1);
      if (/[@#]/.test(consulta) || /\s{2,}/.test(consulta)) return null;
      return { marcador: ch, inicio: i, consulta };
    }
  }
  return null;
}

/** Quem sugerir para o que foi digitado: # só pessoas; os que começam pelo texto vêm antes. Até 6. */
export function sugestoes(t: Token, candidatos: Candidato[]): Candidato[] {
  const q = dobra(t.consulta);
  const base = t.marcador === '#' ? candidatos.filter((x) => x.tipo === 'pessoa') : candidatos;
  const comeca = base.filter((x) => dobra(x.nome).startsWith(q));
  const contem = q ? base.filter((x) => !comeca.includes(x) && dobra(x.nome).includes(q)) : [];
  return [...comeca, ...contem].slice(0, 6);
}

const tipoDe = (marcador: '@' | '#', x: Candidato): TipoMarca => (marcador === '#' ? 'cessao' : x.tipo);

/** Escolheu da lista (Tab, Enter ou clique): o trecho vira o nome certo + espaço e a marca se forma. Volta o cursor. */
export function escolher(c: Campo, t: Token, cursor: number, x: Candidato): { campo: Campo; cursor: number } {
  const trecho = `${t.marcador}${x.nome}`;
  const texto = `${c.texto.slice(0, t.inicio)}${trecho} ${c.texto.slice(cursor).replace(/^ /, '')}`;
  const delta = trecho.length + 1 - (cursor - t.inicio) - (c.texto[cursor] === ' ' ? 1 : 0);
  const marcas = c.marcas.map((m) => (m.inicio >= cursor ? { ...m, inicio: m.inicio + delta, fim: m.fim + delta } : m));
  const nova: MarcaCampo = { tipo: tipoDe(t.marcador, x), chave: x.chave, inicio: t.inicio, fim: t.inicio + trecho.length };
  const todas = [...marcas, nova].sort((a, b) => a.inicio - b.inicio);
  return { campo: { texto, marcas: todas, recem: todas.indexOf(nova) }, cursor: nova.fim + 1 };
}

/**
 * A pessoa mudou o texto (digitou, colou, apagou): as marcas antes da mudança ficam, as depois andam junto, e a que foi
 * tocada vira texto cru. Se ela acabou de digitar espaço ou pontuação logo depois de "@Nome" igual a um candidato (e
 * nenhum outro candidato continua com esse começo), a marca se forma.
 */
export function editar(c: Campo, texto: string, cursor: number, candidatos: Candidato[]): Campo {
  const a = c.texto; let ini = 0;
  while (ini < a.length && ini < texto.length && a[ini] === texto[ini]) ini++;
  let fa = a.length; let fb = texto.length;
  while (fa > ini && fb > ini && a[fa - 1] === texto[fb - 1]) { fa--; fb--; }
  const delta = texto.length - a.length;
  const marcas = c.marcas.flatMap((m) => {
    if (m.fim <= ini) return [m];
    if (m.inicio >= fa) return [{ ...m, inicio: m.inicio + delta, fim: m.fim + delta }];
    return []; // tocada: vira texto cru
  });
  const out: Campo = { texto, marcas, recem: null };
  // digitou um delimitador logo depois de um nome exato
  if (delta === 1 && fb === ini + 1 && DELIM.test(texto[ini] ?? '')) {
    const t = tokenAtivo(out, ini);
    if (t && t.consulta) {
      const base = t.marcador === '#' ? candidatos.filter((x) => x.tipo === 'pessoa') : candidatos;
      const exato = base.find((x) => x.nome === t.consulta);
      const continua = base.some((x) => x !== exato && x.nome.startsWith(t.consulta + texto[ini]));
      if (exato && !continua) {
        const nova: MarcaCampo = { tipo: tipoDe(t.marcador, exato), chave: exato.chave, inicio: t.inicio, fim: ini };
        const todas = [...marcas, nova].sort((x, y) => x.inicio - y.inicio);
        return { texto, marcas: todas, recem: todas.indexOf(nova) };
      }
    }
  }
  void cursor;
  return out;
}

/**
 * Backspace: logo depois de uma marca (o cursor no fim dela, ou depois do espaço que a escolha pôs, se ela acabou de se
 * formar), a marca se desfaz e o texto fica. null = o Backspace segue normal (apaga).
 */
export function backspace(c: Campo, cursor: number): Campo | null {
  const i = c.marcas.findIndex((m, k) => cursor === m.fim || (k === c.recem && cursor === m.fim + 1 && DELIM.test(c.texto[m.fim] ?? '')));
  if (i < 0) return null;
  return { texto: c.texto, marcas: c.marcas.filter((_, k) => k !== i), recem: null };
}

/** Qualquer outra tecla depois de formar: o próximo Backspace já não desfaz pelo espaço. */
export const esquecerRecem = (c: Campo): Campo => (c.recem === null ? c : { ...c, recem: null });

/** Ao enviar: "@Nome" exato no fim do texto também vale (a pessoa digitou igual). Volta as marcas para o servidor. */
export function aoEnviar(c: Campo, candidatos: Candidato[]): { texto: string; marcas: MarcaCampo[] } {
  let campo = c;
  const t = tokenAtivo(c, c.texto.length);
  if (t && t.consulta) {
    const base = t.marcador === '#' ? candidatos.filter((x) => x.tipo === 'pessoa') : candidatos;
    const exato = base.find((x) => x.nome === t.consulta);
    if (exato) campo = { ...c, marcas: [...c.marcas, { tipo: tipoDe(t.marcador, exato), chave: exato.chave, inicio: t.inicio, fim: c.texto.length }] };
  }
  // o servidor tira os espaços das pontas: as posições andam junto
  const lead = campo.texto.length - campo.texto.trimStart().length;
  const texto = campo.texto.trim();
  return { texto, marcas: campo.marcas.map((m) => ({ ...m, inicio: m.inicio - lead, fim: m.fim - lead })).filter((m) => m.inicio >= 0 && m.fim <= texto.length) };
}

/** O texto em pedaços para mostrar (a marca vira chip), dado o texto e as marcas que vieram com a mensagem. */
export function pedacos(texto: string, marcas: unknown): Array<{ texto: string; marca?: MarcaCampo }> {
  const ms = (Array.isArray(marcas) ? marcas : []).filter((m): m is MarcaCampo => !!m && typeof m === 'object' && Number.isInteger((m as MarcaCampo).inicio) && Number.isInteger((m as MarcaCampo).fim))
    .filter((m) => m.inicio >= 0 && m.fim <= texto.length && m.fim > m.inicio).sort((a, b) => a.inicio - b.inicio);
  const out: Array<{ texto: string; marca?: MarcaCampo }> = []; let p = 0;
  for (const m of ms) {
    if (m.inicio < p) continue;
    if (m.inicio > p) out.push({ texto: texto.slice(p, m.inicio) });
    out.push({ texto: texto.slice(m.inicio, m.fim), marca: m }); p = m.fim;
  }
  if (p < texto.length) out.push({ texto: texto.slice(p) });
  return out;
}

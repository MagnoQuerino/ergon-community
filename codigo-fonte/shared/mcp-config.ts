/**
 * Aplicativos conectados pela pessoa (rc.29, Conexões › Conectar outro aplicativo): ler a configuração que os aplicativos
 * publicam para conectar um servidor MCP ("mcpServers" do Claude Desktop, Cursor e Windsurf; "servers" do VS Code;
 * "mcp_servers"; ou uma entrada só) e montar o nome do servidor na equipe. Sem texto de tela: só dados e códigos.
 * A tela usa na hora (colar e ver o formulário preenchido); o servidor confere o pedido de novo antes de gravar.
 */

export type TransporteMcp = 'http' | 'sse' | 'stdio';

export interface EntradaMcp {
  /** o nome que veio na configuração (vira o nome do aplicativo, que a pessoa pode trocar) */
  app: string;
  transporte: TransporteMcp;
  endereco?: string;
  comando?: string;
  argumentos?: string[];
  /** cabeçalhos (endereço) e variáveis (programa): os valores são chaves e vão para o cofre */
  cabecalhos: Record<string, string>;
  variaveis: Record<string, string>;
  /** campos que vieram com um valor de exemplo (<SUA_CHAVE>, ${API_KEY}, YOUR_TOKEN…): a pessoa preenche */
  faltam: string[];
  /**
   * O endereço ou um argumento traz uma referência ($, como ${API_KEY}): o sistema recusa (seria trocada pela chave de
   * outra conexão e mandada ao aplicativo). A tela não preenche o formulário com ela e diz para pôr a chave num campo.
   */
  referencia?: boolean;
}

export type ErroLeitura = 'json' | 'vazio' | 'formato';
export type Leitura = { ok: true; entradas: EntradaMcp[] } | { ok: false; erro: ErroLeitura };

const LIMITE_ENTRADAS = 20;
/** valor de exemplo: vazio, <ALGO>, ${ALGO}, {{ALGO}}, YOUR_…, xxx… */
const EXEMPLO = /^\s*$|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\byour[_-]?|\bsua[_-]?chave|\bseu[_-]?token|^x{3,}$|^\*{3,}$|^\.\.\.$|api[_-]?key[_-]?here|token[_-]?here/i;

export const valorDeExemplo = (v: string): boolean => EXEMPLO.test(v);

const texto = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function mapaDeTexto(v: unknown, limite: number): Record<string, string> {
  if (!ehObjeto(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v).slice(0, limite)) if (typeof x === 'string' || typeof x === 'number') out[k.trim().slice(0, 80)] = String(x);
  return out;
}

/** "npx mcp-remote https://… --header Authorization:${AUTH}" vira o endereço direto (sem precisar do programa). */
function deMcpRemote(comando: string, args: string[], env: Record<string, string>): Pick<EntradaMcp, 'endereco' | 'cabecalhos' | 'transporte'> | null {
  if (!/^(npx|bunx|pnpx)$/.test(comando)) return null;
  const i = args.findIndex((a) => /^mcp-remote(@.*)?$/.test(a));
  if (i < 0) return null;
  const url = args.slice(i + 1).find((a) => /^https?:\/\//i.test(a));
  if (!url) return null;
  const cabecalhos: Record<string, string> = {};
  for (let j = i + 1; j < args.length - 1; j++) {
    if (args[j] !== '--header') continue;
    const m = /^([A-Za-z0-9-]{1,80})\s*:\s*(.*)$/.exec(args[j + 1]);
    if (!m) continue;
    // ${AUTH_HEADER} do próprio env da entrada: o valor que já veio
    const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(m[2].trim());
    cabecalhos[m[1]] = ref && env[ref[1]] !== undefined ? env[ref[1]] : m[2].trim();
  }
  const sse = args.includes('--transport') && args[args.indexOf('--transport') + 1] === 'sse-only';
  return { endereco: url, cabecalhos, transporte: sse ? 'sse' : 'http' };
}

function entradaDe(app: string, v: Record<string, unknown>): EntradaMcp | null {
  const url = texto(v.url, 2000) || texto(v.serverUrl, 2000) || texto(v.httpUrl, 2000);
  const tipo = texto(v.type, 40).toLowerCase() || texto(v.transport, 40).toLowerCase();
  const nome = texto(app, 60) || 'app';
  if (url) {
    const cabecalhos = mapaDeTexto(v.headers, 10);
    const faltam = Object.entries(cabecalhos).filter(([, x]) => valorDeExemplo(x)).map(([k]) => k);
    for (const k of faltam) cabecalhos[k] = '';
    return { app: nome, transporte: tipo === 'sse' ? 'sse' : 'http', endereco: url, cabecalhos, variaveis: {}, faltam, ...(url.includes('$') ? { referencia: true } : {}) };
  }
  const comando = texto(v.command, 200);
  if (!comando) return null;
  let argumentos = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').slice(0, 40).map((a) => a.slice(0, 1000)) : [];
  let cmd = comando;
  // "comando com argumentos" numa linha só: separa pelos espaços (sem aspas, como os exemplos costumam vir)
  if (/\s/.test(cmd) && !argumentos.length) { const partes = cmd.split(/\s+/).filter(Boolean); cmd = partes[0]; argumentos = partes.slice(1, 41); }
  const variaveis = mapaDeTexto(v.env, 20);
  const remoto = deMcpRemote(cmd, argumentos, variaveis);
  if (remoto) {
    const faltam = Object.entries(remoto.cabecalhos).filter(([, x]) => valorDeExemplo(x)).map(([k]) => k);
    for (const k of faltam) remoto.cabecalhos[k] = '';
    return { app: nome, ...remoto, variaveis: {}, faltam, ...(remoto.endereco?.includes('$') ? { referencia: true } : {}) };
  }
  const faltam = Object.entries(variaveis).filter(([, x]) => valorDeExemplo(x)).map(([k]) => k);
  for (const k of faltam) variaveis[k] = '';
  return { app: nome, transporte: 'stdio', comando: cmd, argumentos, cabecalhos: {}, variaveis, faltam, ...(argumentos.some((a) => a.includes('$')) ? { referencia: true } : {}) };
}

/** Lê o texto colado. Aceita o JSON padrão (com ou sem o objeto de fora) e uma entrada só. */
export function lerConfigMcp(colado: string): Leitura {
  const t = colado.trim();
  if (!t) return { ok: false, erro: 'vazio' };
  let j: unknown;
  try { j = JSON.parse(t); } catch {
    // muitos exemplos vêm sem as chaves de fora: "nome": { ... }
    try { j = JSON.parse(`{${t.replace(/,\s*$/, '')}}`); } catch { return { ok: false, erro: 'json' }; }
  }
  if (!ehObjeto(j)) return { ok: false, erro: 'formato' };
  const mcp = ehObjeto(j.mcp) ? j.mcp : null;
  const grupo = [j.mcpServers, j.servers, j.mcp_servers, j.context_servers, mcp?.servers, mcp?.mcpServers].find(ehObjeto) as Record<string, unknown> | undefined;
  const entradas: EntradaMcp[] = [];
  if (grupo) {
    for (const [nome, v] of Object.entries(grupo).slice(0, LIMITE_ENTRADAS)) {
      if (!ehObjeto(v)) continue;
      const e = entradaDe(nome, v);
      if (e) entradas.push(e);
    }
  } else if (j.url || j.serverUrl || j.httpUrl || j.command) {
    const e = entradaDe(texto(j.name, 60), j);
    if (e) entradas.push(e);
  } else {
    // { "nome": { "command": … } } sem o objeto de fora
    for (const [nome, v] of Object.entries(j).slice(0, LIMITE_ENTRADAS)) {
      if (!ehObjeto(v)) continue;
      const e = entradaDe(nome, v);
      if (e) entradas.push(e);
    }
  }
  return entradas.length ? { ok: true, entradas } : { ok: false, erro: 'formato' };
}

/** Nome válido de servidor na equipe: letras e números em até 5 partes separadas por "_" (nunca "__"). */
export const NOME_SERVIDOR = /^[a-z][a-z0-9]{0,30}(_[a-z0-9]{1,30}){0,4}$/;

function slug(s: string, partes: number): string[] {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').split('_').filter(Boolean).slice(0, partes).map((p) => p.slice(0, 20));
}

/**
 * O nome do servidor na equipe (o que aparece no nome das ferramentas): o aplicativo e o apelido da conta, para conectar
 * o mesmo aplicativo várias vezes (uma conta por conexão). Já existe: acrescenta 2, 3…
 */
export function nomeDoServidor(app: string, apelido: string | null | undefined, existentes: ReadonlySet<string>): string {
  const a = slug(app, 3);
  if (!a.length || !/^[a-z]/.test(a[0])) a.unshift('app');
  const base = [...a.slice(0, 3), ...slug(apelido ?? '', 1)].join('_').slice(0, 36).replace(/_+$/, '');
  const ok = NOME_SERVIDOR.test(base) ? base : 'app';
  if (!existentes.has(ok)) return ok;
  for (let n = 2; n < 1000; n++) { const c = `${ok}_${n}`; if (!existentes.has(c) && NOME_SERVIDOR.test(c)) return c; }
  return `app_${Date.now().toString(36)}`;
}

/** Os valores de "Trocar chave" que a pessoa preencheu (os em branco ficam como estão); vazio = nada a mandar. */
export function valoresPreenchidos(campos: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(campos).filter(([, v]) => typeof v === 'string' && v.trim()));
}

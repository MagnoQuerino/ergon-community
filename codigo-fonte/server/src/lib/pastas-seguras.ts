/**
 * Pastas do computador concedidas ao motor (rc.42): o que pode e o que nunca pode ser montado no contêiner da equipe.
 * Usado pelo Ergon (ao conceder) e, de novo, pelo gerente de motores (ao montar): o gerente não confia no pedido.
 *
 * Nunca: a raiz, as pastas do sistema, a casa inteira de alguém (e o que fica acima dela), e qualquer caminho que passe
 * por uma pasta oculta sensível (.ssh, .gnupg, .aws, ...). Também não: caminho relativo, com "..", com caracteres de
 * controle, ou com ":" fora da letra de unidade do Windows (o Docker leria como opção de montagem).
 * A pasta escolhida vai para /pastas/<nome> no motor, só ela, com leitura e escrita ou só leitura.
 */
export type ModoPasta = 'rw' | 'ro';
export interface PastaMontada { origem: string; nome: string; modo: ModoPasta }
export const RAIZ_NO_MOTOR = '/pastas';
export const MAX_PASTAS = 12;

/** Pastas ocultas que guardam credenciais: nem elas nem nada dentro delas. */
const OCULTAS_SENSIVEIS = new Set(['.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.config', '.local', '.password-store',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.vault-token', '.terraform.d', '.oci', '.mozilla', '.thunderbird', '.pki', '.keychain', '.gnome-keyring']);
/** Raízes do sistema (Linux e macOS): nem elas nem nada dentro delas. */
const SISTEMA = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/snap',
  '/System', '/Library', '/Applications', '/private', '/cores', '/opt/ergon', '/var/run/docker.sock'];
/** Pastas que só agrupam as casas: elas mesmas e a casa inteira (um nível abaixo) não. */
const CASAS = ['/home', '/Users', '/var/home'];
const WIN_SISTEMA = /^[a-z]:\/(?:windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|recovery|boot)(?:\/|$)/i;

export class PastaRecusada extends Error {}

/** Caminho normalizado com barras "/" (Windows: "C:/Users/ana/proj"); recusa o que não for absoluto e limpo. */
export function normalizar(bruto: string): string {
  let s = String(bruto ?? '').trim();
  if (!s) throw new PastaRecusada('diga o caminho da pasta');
  if (s.length > 1000 || /[\u0000-\u001f\u007f]/.test(s)) throw new PastaRecusada('caminho inválido');
  s = s.replace(/\\/g, '/');
  const win = /^([a-zA-Z]):\//.exec(s);
  if (!win && !s.startsWith('/')) throw new PastaRecusada('use o caminho completo da pasta (ex.: /home/ana/projetos/site ou C:\\Users\\Ana\\Projetos\\site)');
  const resto = win ? s.slice(2) : s;
  if (resto.includes(':') || /[*?"<>|]/.test(resto)) throw new PastaRecusada('o caminho tem caracteres que não valem numa pasta montada');
  const partes = resto.split('/').filter((p) => p && p !== '.');
  if (partes.includes('..')) throw new PastaRecusada('o caminho não pode subir de pasta ("..")');
  return `${win ? `${win[1].toUpperCase()}:` : ''}/${partes.join('/')}`;
}

/** A pasta pode ir para o motor? Devolve o caminho normalizado ou recusa dizendo por quê. `casas`: casas conhecidas desta máquina. */
export function conferirPasta(bruto: string, casas: readonly string[] = []): string {
  const p = normalizar(bruto);
  const semUnidade = p.replace(/^[A-Z]:/, '');
  const partes = semUnidade.split('/').filter(Boolean);
  if (!partes.length) throw new PastaRecusada('a raiz do disco inteira não pode ser concedida: escolha a pasta do projeto');
  const oculta = partes.find((x) => OCULTAS_SENSIVEIS.has(x.toLowerCase()));
  if (oculta) throw new PastaRecusada(`pastas como ${oculta} guardam senhas e chaves: não podem ser concedidas`);
  if (/^[A-Z]:/.test(p)) {
    if (WIN_SISTEMA.test(p)) throw new PastaRecusada('pastas do sistema não podem ser concedidas');
    if (/^[A-Z]:\/users(?:\/[^/]+)?$/i.test(p)) throw new PastaRecusada('a pasta pessoal inteira não pode ser concedida: escolha a pasta do projeto');
  } else {
    if (SISTEMA.some((s) => p === s || p.startsWith(`${s}/`))) throw new PastaRecusada('pastas do sistema não podem ser concedidas');
    if (CASAS.some((c) => p === c || (p.startsWith(`${c}/`) && p.slice(c.length + 1).split('/').length === 1))) throw new PastaRecusada('a pasta pessoal inteira não pode ser concedida: escolha a pasta do projeto');
    if (p === '/opt' || p === '/mnt' || p === '/media' || p === '/srv' || p === '/tmp' || p === '/Volumes') throw new PastaRecusada('escolha uma pasta dentro desta, não ela inteira');
  }
  for (const c of casas) {
    const casa = (() => { try { return normalizar(c); } catch { return null; } })();
    if (casa && (p === casa || casa.startsWith(`${p}/`))) throw new PastaRecusada('a pasta pessoal inteira não pode ser concedida: escolha a pasta do projeto');
  }
  return p;
}

/** O nome dentro do motor (/pastas/<nome>): o da pasta, só com letras, números, "-" e "_", sem repetir. */
export function nomeNoMotor(origem: string, usados: ReadonlySet<string>): string {
  const base = (origem.split('/').filter(Boolean).pop() ?? 'pasta').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pasta';
  let nome = base; let i = 2;
  while (usados.has(nome)) nome = `${base}-${i++}`;
  return nome;
}

/** A lista que o gerente recebe, conferida de novo: o que não passar fica de fora (nunca monta "quase certo"). */
export function pastasParaMontar(v: unknown, casas: readonly string[] = []): PastaMontada[] {
  if (!Array.isArray(v)) return [];
  const out: PastaMontada[] = []; const nomes = new Set<string>(); const origens = new Set<string>();
  for (const x of v.slice(0, MAX_PASTAS)) {
    const o = x as Partial<PastaMontada> | null;
    if (!o || typeof o.origem !== 'string' || (o.modo !== 'rw' && o.modo !== 'ro')) continue;
    let origem: string;
    try { origem = conferirPasta(o.origem, casas); } catch { continue; }
    if (origens.has(origem)) continue;
    const nome = typeof o.nome === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(o.nome) && !nomes.has(o.nome) ? o.nome : nomeNoMotor(origem, nomes);
    nomes.add(nome); origens.add(origem);
    out.push({ origem, nome, modo: o.modo });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome));
}

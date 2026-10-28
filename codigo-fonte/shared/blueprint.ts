/**
 * Esqueleto de workspace (blueprint) — contrato portável entre instalações e distribuições.
 * Leva a FORMA do workspace (setores, agentes, instruções, aparência, cidade e rotinas pausadas) e nunca leva
 * segredos, conexões, permissões de ferramenta, escolhas de modelo/conta de IA, histórico, membros, compras,
 * carteira ou direitos comerciais. A validação é por lista do que é permitido: campo desconhecido é recusado.
 */

export const BLUEPRINT_FORMAT = 'ergon.blueprint';
export const BLUEPRINT_VERSION = 1;
export const BLUEPRINT_MAX_BYTES = 1_000_000;

export interface BlueprintSector { key: string; name: string; description: string | null; instructions: string; createsTasks: 'demands' | 'explicit_only' }
export interface BlueprintAgent {
  name: string; role: string; sectorKey: string; charter: string | null; bio: string | null; skills: string[];
  color: string; lookSeed: number | null; coordinator: boolean; charKey: string | null;
}
export interface BlueprintStructure { kind: string; name: string; i: number; j: number; floors: number }
export type BlueprintTrigger = { kind: 'manual' } | { kind: 'schedule'; days: number[]; time: string; tz?: string };
export interface BlueprintRoutine { template: string; name: string; trigger: BlueprintTrigger; agentName: string | null }
export interface Blueprint {
  format: typeof BLUEPRINT_FORMAT; version: number; createdAt: string; ergonVersion: string;
  workspace: { name: string };
  sectors: BlueprintSector[]; agents: BlueprintAgent[]; structures: BlueprintStructure[]; routines: BlueprintRoutine[];
}

/** Nomes de campo que nunca entram num esqueleto, em qualquer nível (defesa além da lista de permitidos). */
const FORBIDDEN_KEY = /(token|secret|segredo|password|senha|passphrase|frase|api.?key|credential|credencial|oauth|cookie|session|sess[aã]o|wallet|carteira|dracma|entitlement|direito|license|licen[cç]a|stripe|payment|pagamento|tools|ferramenta|permission|permiss|provider|model|hermes|conex|connection)/i;

type Check = (v: unknown, path: string, errs: string[]) => void;
const str = (max: number, min = 0, re?: RegExp): Check => (v, p, e) => {
  if (typeof v !== 'string') return void e.push(`${p}: texto esperado`);
  if (v.length < min || v.length > max) e.push(`${p}: tamanho fora de ${min}..${max}`);
  if (re && !re.test(v)) e.push(`${p}: formato inválido`);
  if (/javascript:|<script|data:text\/html/i.test(v)) e.push(`${p}: conteúdo ativo não é permitido`);
};
const nstr = (max: number): Check => (v, p, e) => { if (v !== null) str(max)(v, p, e); };
const int = (min: number, max: number): Check => (v, p, e) => { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) e.push(`${p}: inteiro ${min}..${max} esperado`); };
const nint = (min: number, max: number): Check => (v, p, e) => { if (v !== null) int(min, max)(v, p, e); };
const bool: Check = (v, p, e) => { if (typeof v !== 'boolean') e.push(`${p}: verdadeiro/falso esperado`); };
const oneOf = (...xs: string[]): Check => (v, p, e) => { if (!xs.includes(v as string)) e.push(`${p}: valor não permitido`); };
const arr = (max: number, item: Check): Check => (v, p, e) => {
  if (!Array.isArray(v)) return void e.push(`${p}: lista esperada`);
  if (v.length > max) e.push(`${p}: no máximo ${max} itens`);
  v.slice(0, max).forEach((x, i) => item(x, `${p}[${i}]`, e));
};
const obj = (shape: Record<string, Check>, optional: string[] = []): Check => (v, p, e) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return void e.push(`${p}: objeto esperado`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in shape)) e.push(`${p}.${k}: campo não permitido`);
  for (const [k, c] of Object.entries(shape)) {
    if (!(k in o)) { if (!optional.includes(k)) e.push(`${p}.${k}: obrigatório`); continue; }
    c(o[k], `${p}.${k}`, e);
  }
};
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const trigger: Check = (v, p, e) => {
  const k = (v as { kind?: unknown } | null)?.kind;
  if (k === 'manual') obj({ kind: oneOf('manual') })(v, p, e);
  else if (k === 'schedule') obj({ kind: oneOf('schedule'), days: arr(7, int(0, 6)), time: str(5, 5, /^([01]\d|2[0-3]):[0-5]\d$/), tz: str(64, 1) }, ['tz'])(v, p, e);
  else e.push(`${p}.kind: manual ou schedule`);
};

const SCHEMA = obj({
  format: oneOf(BLUEPRINT_FORMAT), version: int(1, BLUEPRINT_VERSION), createdAt: str(40, 10), ergonVersion: str(40, 1),
  workspace: obj({ name: str(80, 1) }),
  sectors: arr(40, obj({ key: str(40, 1, KEY), name: str(80, 1), description: nstr(600), instructions: str(4000), createsTasks: oneOf('demands', 'explicit_only') })),
  agents: arr(200, obj({
    name: str(60, 1), role: str(120, 1), sectorKey: str(40, 1, KEY), charter: nstr(4000), bio: nstr(2000), skills: arr(30, str(80, 1)),
    color: str(9, 4, /^#[0-9a-f]{3,8}$/i), lookSeed: nint(0, 2 ** 31 - 1), coordinator: bool, charKey: nstr(40),
  })),
  structures: arr(60, obj({ kind: str(40, 1, KEY), name: str(80, 1), i: int(-200, 200), j: int(-200, 200), floors: int(0, 40) })),
  routines: arr(60, obj({ template: str(40, 3, /^[a-z0-9-]{3,40}$/), name: str(120, 1), trigger, agentName: nstr(60) })),
});

function forbiddenKeys(v: unknown, p: string, e: string[], allowed: Set<string>): void {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${p}[${i}]`, e, allowed));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (!allowed.has(k) && FORBIDDEN_KEY.test(k)) e.push(`${p}.${k}: campo proibido em esqueleto`);
    forbiddenKeys(x, `${p}.${k}`, e, allowed);
  }
}
// nomes permitidos que casariam com a regra geral ("charter" não, "skills" sim; nenhum é segredo)
const ALLOWED_NAMES = new Set(['skills']);

export function validateBlueprint(input: unknown): { ok: true; blueprint: Blueprint } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(input) ?? '').length; } catch { return { ok: false, errors: ['esqueleto ilegível'] }; }
  if (size > BLUEPRINT_MAX_BYTES) return { ok: false, errors: [`esqueleto grande demais (${size} bytes; máximo ${BLUEPRINT_MAX_BYTES})`] };
  forbiddenKeys(input, '$', errors, ALLOWED_NAMES);
  SCHEMA(input, '$', errors);
  if (!errors.length) {
    const b = input as Blueprint;
    const keys = new Set(b.sectors.map((s) => s.key));
    if (keys.size !== b.sectors.length) errors.push('$.sectors: chave de setor repetida');
    if (b.agents.filter((a) => a.coordinator).length > 1) errors.push('$.agents: no máximo uma coordenação');
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)].slice(0, 50) } : { ok: true, blueprint: input as Blueprint };
}

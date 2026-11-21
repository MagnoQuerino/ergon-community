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
/**
 * A parte PRIVADA do esqueleto, só na sincronia cifrada do workspace: vai a TODO aparelho que tem a chave do workspace
 * (os da pessoa dona, a nuvem do World e os dos colaboradores) e só é APLICADA quando vem de um aparelho da conta dona
 * (world/sync-local.ts: o World diz o autor de cada mudança). Ferramentas que executam código só ligam por ela na nuvem
 * do próprio dono; nos computadores, esperam a confirmação com a senha (services/blueprint.ts). Leva: a identidade estável de cada agente e rotina (`ref`, o id no aparelho de origem) e as escolhas da equipe que
 * um arquivo exportado nunca leva — ferramentas de cada agente e da equipe, competências, o modelo do agente e as
 * rotinas com a configuração e o estado. Um esqueleto com esta parte é recusado fora da sincronia (validateBlueprint
 * sem `{ sync: true }`): o arquivo da Loja ou de "Exportar" continua sem nada disso.
 */
export interface BlueprintSyncAgent { ref: string; name: string; tools: string[]; hermesSkills: string[]; model: string | null; provider: string | null }
export interface BlueprintSyncRoutine {
  ref: string; template: string | null; name: string; category: string; trigger: BlueprintTrigger; status: 'active' | 'paused';
  /** a configuração da rotina (o que ela lê, o pedido, o ajuste), sem as contas escolhidas (ids deste aparelho) */
  config: Record<string, unknown>;
}
export interface BlueprintSync {
  agents: BlueprintSyncAgent[]; routines: BlueprintSyncRoutine[];
  /** a escolha da pessoa para cada ferramenta da equipe (Configurações › Ferramentas); ausente = o padrão */
  teamTools: Array<{ id: string; state: 'ligado' | 'desligado' }>;
}
export interface Blueprint {
  format: typeof BLUEPRINT_FORMAT; version: number; createdAt: string; ergonVersion: string;
  workspace: { name: string };
  sectors: BlueprintSector[]; agents: BlueprintAgent[]; structures: BlueprintStructure[]; routines: BlueprintRoutine[];
  sync?: BlueprintSync;
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

/** Um valor JSON comum (texto, número, lista, objeto), raso e curto: a configuração de uma rotina. */
const jsonValue = (depth: number): Check => (v, p, e) => {
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
  if (typeof v === 'string') return str(4000)(v, p, e);
  if (depth <= 0) return void e.push(`${p}: fundo demais`);
  if (Array.isArray(v)) return arr(60, jsonValue(depth - 1))(v, p, e);
  if (typeof v !== 'object') return void e.push(`${p}: valor não permitido`);
  const ks = Object.keys(v as object);
  if (ks.length > 40) e.push(`${p}: campos demais`);
  for (const k of ks.slice(0, 40)) { if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/.test(k)) e.push(`${p}.${k}: nome de campo inválido`); else jsonValue(depth - 1)((v as Record<string, unknown>)[k], `${p}.${k}`, e); }
};
/** Os campos da configuração de uma rotina que viajam (routine-catalog.ts RoutineConfig, menos as contas deste aparelho). */
const ROUTINE_CONFIG_KEYS = ['agent', 'support', 'sources', 'condition', 'instruction', 'extra', 'deliver', 'windowHours', 'staleDays', 'horizonDays', 'maxPerDay', 'params'];
const routineConfig: Check = (v, p, e) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return void e.push(`${p}: objeto esperado`);
  for (const k of Object.keys(v)) if (!ROUTINE_CONFIG_KEYS.includes(k)) e.push(`${p}.${k}: campo não permitido`);
  if (JSON.stringify(v).length > 20_000) e.push(`${p}: configuração grande demais`);
  jsonValue(4)(v, p, e);
};
const REF = /^[a-z]{3}_[A-Za-z0-9_-]{6,60}$/;
const SYNC_SCHEMA = obj({
  agents: arr(200, obj({ ref: str(64, 1, REF), name: str(60, 1), tools: arr(30, str(30, 1, KEY)), hermesSkills: arr(200, str(80, 1)), model: nstr(120), provider: nstr(80) })),
  routines: arr(60, obj({ ref: str(64, 1, REF), template: (v, p, e) => { if (v !== null) str(40, 3, /^[a-z0-9-]{3,40}$/)(v, p, e); }, name: str(120, 1), category: str(40, 1, KEY), trigger,
    status: oneOf('active', 'paused'), config: routineConfig })),
  teamTools: arr(40, obj({ id: str(30, 1, KEY), state: oneOf('ligado', 'desligado') })),
});

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
  // a parte privada: só existe na sincronia (validateBlueprint confere com `sync`); fora dela, é campo não permitido
  sync: SYNC_SCHEMA,
}, ['sync']);

function forbiddenKeys(v: unknown, p: string, e: string[], allowed: Set<string>): void {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${p}[${i}]`, e, allowed));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (!allowed.has(k) && FORBIDDEN_KEY.test(k)) e.push(`${p}.${k}: campo proibido em esqueleto`);
    forbiddenKeys(x, `${p}.${k}`, e, allowed);
  }
}
// nomes permitidos que casariam com a regra geral ("charter" não, "skills" sim; nenhum é segredo)
const ALLOWED_NAMES = new Set(['skills']);

/**
 * Confere um esqueleto. `sync`: veio da sincronia cifrada entre os aparelhos da pessoa e pode trazer a parte privada
 * (BlueprintSync); sem ele (arquivo, Loja), essa parte é recusada.
 */
export function validateBlueprint(input: unknown, opts: { sync?: boolean } = {}): { ok: true; blueprint: Blueprint } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const temSync = !!input && typeof input === 'object' && 'sync' in (input as object);
  if (temSync && !opts.sync) return { ok: false, errors: ['$.sync: campo não permitido (só na sincronia entre os seus aparelhos)'] };
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(input) ?? '').length; } catch { return { ok: false, errors: ['esqueleto ilegível'] }; }
  if (size > BLUEPRINT_MAX_BYTES) return { ok: false, errors: [`esqueleto grande demais (${size} bytes; máximo ${BLUEPRINT_MAX_BYTES})`] };
  // a parte privada leva de propósito ferramentas e modelo (nomes que a regra geral barra); o resto passa pela regra
  forbiddenKeys(temSync ? { ...(input as object), sync: undefined } : input, '$', errors, ALLOWED_NAMES);
  SCHEMA(input, '$', errors);
  if (!errors.length) {
    const b = input as Blueprint;
    const keys = new Set(b.sectors.map((s) => s.key));
    if (keys.size !== b.sectors.length) errors.push('$.sectors: chave de setor repetida');
    if (b.agents.filter((a) => a.coordinator).length > 1) errors.push('$.agents: no máximo uma coordenação');
    if (b.sync) {
      const refs = [...b.sync.agents.map((a) => a.ref), ...b.sync.routines.map((r) => r.ref)];
      if (new Set(refs).size !== refs.length) errors.push('$.sync: referência repetida');
      const nomes = new Set(b.agents.map((a) => a.name.toLowerCase()));
      if (b.sync.agents.some((a) => !nomes.has(a.name.toLowerCase()))) errors.push('$.sync.agents: agente que não está na equipe');
    }
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)].slice(0, 50) } : { ok: true, blueprint: input as Blueprint };
}

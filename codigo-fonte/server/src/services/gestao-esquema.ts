/**
 * O esquema de uma rota da tela, resumido para o coordenador (gestao_listar): cada campo do corpo (ou da consulta, num
 * GET), o tipo ou as opções e o que é obrigatório. Só o que ajuda a montar o pedido; a validação é a da própria rota.
 */
type Esq = Record<string, unknown>;

function tipo(p: Esq | undefined, fundo = 0): string {
  if (!p || typeof p !== 'object') return 'qualquer';
  if ('const' in p) return JSON.stringify(p.const);
  if (Array.isArray(p.enum)) return p.enum.map((x) => JSON.stringify(x)).join(' | ');
  const alt = (p.anyOf ?? p.oneOf) as Esq[] | undefined;
  if (Array.isArray(alt)) return alt.map((x) => tipo(x, fundo)).join(' | ');
  const t = Array.isArray(p.type) ? p.type.join('|') : String(p.type ?? 'qualquer');
  if (t === 'array') return `lista de ${tipo(p.items as Esq | undefined, fundo)}`;
  if (t === 'object' && p.properties && fundo < 1) return `{ ${campos(p, fundo + 1)} }`;
  if (t === 'string' && typeof p.pattern === 'string' && /^\^[a-z]{3}_/.test(p.pattern)) return `id ${p.pattern.slice(1, 4)}_…`;
  if (t === 'string' && typeof p.maxLength === 'number') return `texto (até ${p.maxLength})`;
  if ((t === 'integer' || t === 'number') && (typeof p.minimum === 'number' || typeof p.maximum === 'number')) return `${t === 'integer' ? 'inteiro' : 'número'} ${p.minimum ?? ''}–${p.maximum ?? ''}`;
  return ({ string: 'texto', integer: 'inteiro', number: 'número', boolean: 'sim/não', object: 'objeto' } as Record<string, string>)[t] ?? t;
}

function campos(o: Esq, fundo = 0): string {
  const props = (o.properties ?? {}) as Record<string, Esq>;
  const req = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
  return Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}: ${tipo(v, fundo)}`).join('; ');
}

/** "campo*: tipo; outro: opções" (* = obrigatório); vazio quando a rota não recebe nada. */
export function resumirEsquema(schema: Esq | undefined, metodo: string): string {
  if (!schema) return '';
  const alvo = (metodo === 'GET' || metodo === 'DELETE' ? schema.querystring ?? schema.body : schema.body) as Esq | undefined;
  if (!alvo || typeof alvo !== 'object' || !alvo.properties) return '';
  return `${campos(alvo)}${Object.keys(alvo.properties as Esq).length ? ' (* = obrigatório)' : ''}`.slice(0, 1500);
}

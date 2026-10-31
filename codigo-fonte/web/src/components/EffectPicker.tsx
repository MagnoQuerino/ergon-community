import type { FxSpec } from '../iso/cosmetics.ts';
import { useResource } from '../lib/live.ts';

export type FxTarget = { all: true } | { agentName: string } | { charKey: string };
export interface FxOption { id: string; packageId: string; item: number; title: string; effect: string; label: string; color: string; intensity: number; target: FxTarget }
export type FxChoice = { mode: 'inherit' } | { mode: 'off' } | { mode: 'custom'; option: string };

/** Efeitos que valem para o agente com esta escolha (a mesma regra do servidor: pessoal > alvos dos pacotes). */
export function effectsFor(choice: FxChoice, options: FxOption[], who: { name: string; char_key?: string | null }): FxSpec[] {
  if (choice.mode === 'off') return [];
  if (choice.mode === 'custom') { const o = options.find((x) => x.id === choice.option); return o ? [{ effect: o.effect, color: o.color, intensity: o.intensity }] : []; }
  return options.filter((o) => 'all' in o.target || ('agentName' in o.target && o.target.agentName.toLowerCase() === who.name.trim().toLowerCase())
    || ('charKey' in o.target && !!who.char_key && o.target.charKey === who.char_key)).map((o) => ({ effect: o.effect, color: o.color, intensity: o.intensity }));
}

export function useFxOptions(): FxOption[] {
  return useResource<FxOption[]>('/api/packages/fx-options', ['agents.changed', 'city.changed']).data ?? [];
}

/**
 * Efeitos dos Pacotes instalados para um agente: herdar o padrão da cidade, nenhum, ou um escolhido. Só lista o que
 * está instalado; comprar ou instalar fica na loja (Configurações › Pacotes). Sem pacotes, só diz isso.
 */
export function EffectPicker({ value, onChange, options }: { value: FxChoice; onChange: (c: FxChoice) => void; options: FxOption[] }) {
  if (!options.length) return <p className="hint">Nenhum efeito instalado. Efeitos vêm dos Pacotes (Configurações › Pacotes); o agente funciona igual sem eles.</p>;
  const on = (c: FxChoice) => (c.mode === value.mode && (c.mode !== 'custom' || (value.mode === 'custom' && value.option === c.option)));
  const chip = (c: FxChoice, label: string, title?: string) => (
    <button key={c.mode === 'custom' ? c.option : c.mode} type="button" className={`chip chip--pick ${on(c) ? 'is-on' : ''}`} aria-pressed={on(c)} title={title} onClick={() => onChange(c)}>{label}</button>
  );
  return (
    <div className="chips" role="group" aria-label="Efeitos dos seus Pacotes">
      {chip({ mode: 'inherit' }, 'Padrão da cidade', 'O que os pacotes instalados já aplicam a ele')}
      {chip({ mode: 'off' }, 'Sem efeito')}
      {options.map((o) => chip({ mode: 'custom', option: o.id }, o.label, `${o.label} · ${o.title}`))}
    </div>
  );
}

import { SIMPLE_ICONS } from './simple-icons.ts';

/**
 * Logo de cada conexão: o desenho oficial aberto (Simple Icons) em branco sobre a cor da marca. Sem logo aberto,
 * a inicial na cor da marca — nunca um desenho que imite o logo. Microsoft: o símbolo dos botões "Entrar com a
 * Microsoft", que as diretrizes de login da Microsoft pedem.
 */
const MONOGRAM: Record<string, { hex: string; letter: string }> = {
  nous: { hex: '#16202a', letter: 'N' },
  'openai-codex': { hex: '#10A37F', letter: 'C' },
  openrouter: { hex: '#6467F2', letter: 'O' },
  anthropic: { hex: '#C96442', letter: 'A' },
  gemini: { hex: '#1A73E8', letter: 'G' },
  monday: { hex: '#6161FF', letter: 'm' },
  smartsheet: { hex: '#0073EC', letter: 'S' },
  pipefy: { hex: '#3B5BFD', letter: 'P' },
  wrike: { hex: '#08CF65', letter: 'W' },
  bitrix: { hex: '#2FC6F6', letter: 'B' },
};

export function BrandLogo({ kind, name, size = 40 }: { kind: string; name: string; size?: number }) {
  const r = Math.round(size * 0.22);
  if (kind === 'microsoft') {
    const s = size * 0.2; const g = size * 0.035; const o = (size - 2 * s - g) / 2;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name} className="brand-logo">
        <rect width={size} height={size} rx={r} fill="#fff" stroke="#e3d9c8" />
        <rect x={o} y={o} width={s} height={s} fill="#F25022" /><rect x={o + s + g} y={o} width={s} height={s} fill="#7FBA00" />
        <rect x={o} y={o + s + g} width={s} height={s} fill="#00A4EF" /><rect x={o + s + g} y={o + s + g} width={s} height={s} fill="#FFB900" />
      </svg>
    );
  }
  const icon = SIMPLE_ICONS[kind];
  if (icon) {
    const pad = size * 0.22; const inner = size - 2 * pad;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name} className="brand-logo">
        <rect width={size} height={size} rx={r} fill={icon.hex} />
        <g transform={`translate(${pad} ${pad}) scale(${inner / 24})`}><path d={icon.path} fill="#fff" /></g>
      </svg>
    );
  }
  const m = MONOGRAM[kind] ?? { hex: '#6b6a62', letter: name.slice(0, 1).toUpperCase() };
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name} className="brand-logo">
      <rect width={size} height={size} rx={r} fill={m.hex} />
      <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="#fff" fontSize={size * 0.5} fontWeight="700" fontFamily="system-ui, sans-serif">{m.letter}</text>
    </svg>
  );
}

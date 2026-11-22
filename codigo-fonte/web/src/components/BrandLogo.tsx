import { SIMPLE_ICONS } from './simple-icons.ts';
import { inkOn } from '../lib/contraste.ts';

/**
 * Logo de cada conexão: o desenho oficial aberto (Simple Icons) sobre a cor da marca, em branco ou na tinta escura (a
 * que se lê sobre aquela cor: inkOn). Sem logo aberto,
 * a inicial na cor da marca — nunca um desenho que imite o logo. Microsoft: o símbolo dos botões "Entrar com a
 * Microsoft", que as diretrizes de login da Microsoft pedem.
 */
const MONOGRAM: Record<string, { hex: string; letter: string }> = {
  nous: { hex: '#16202a', letter: 'N' },
  'openai-codex': { hex: '#10A37F', letter: 'C' },
  monday: { hex: '#6161FF', letter: 'm' },
  smartsheet: { hex: '#0073EC', letter: 'S' },
  pipefy: { hex: '#3B5BFD', letter: 'P' },
  bitrix: { hex: '#2FC6F6', letter: 'B' },
  gohighlevel: { hex: '#188BF6', letter: 'HL' },
  salesforce: { hex: '#00A1E0', letter: 'S' },
  pipedrive: { hex: '#1A1A1A', letter: 'p' },
  kommo: { hex: '#2B6CF6', letter: 'K' },
  rdstation: { hex: '#19C1CE', letter: 'RD' },
  freshdesk: { hex: '#25C16F', letter: 'F' },
  asaas: { hex: '#0030B9', letter: 'a' },
  omie: { hex: '#00A6DD', letter: 'O' },
  // rc.45: sem logo aberto (Simple Icons não tem): a inicial na cor da marca
  feishu: { hex: '#3370FF', letter: 'F' },
  dingtalk: { hex: '#0089FF', letter: 'D' },
  // rc.46: WeCom e WeChat, também sem logo aberto aqui: a inicial na cor da marca
  wecom: { hex: '#0082EF', letter: 'W' },
  weixin: { hex: '#07C160', letter: 'W' },
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
  // Teams (Microsoft não abre o logo): o "T" na cor da marca, com o colega ao lado, como no ícone do aplicativo
  if (kind === 'teams') return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={name} className="brand-logo">
      <rect width="24" height="24" rx={r * 24 / size} fill="#4B53BC" />
      <circle cx="17.2" cy="7.4" r="2.1" fill="#9EA4F2" /><rect x="14.3" y="10.2" width="5.9" height="7.4" rx="2.4" fill="#9EA4F2" />
      <rect x="3.8" y="6.6" width="10.4" height="2.8" rx=".6" fill="#fff" /><rect x="7.6" y="6.6" width="2.8" height="11" rx=".6" fill="#fff" />
    </svg>
  );
  // Slack (fora do Simple Icons): as quatro barras nas cores da marca, sobre o branco
  if (kind === 'slack') return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={name} className="brand-logo">
      <rect width="24" height="24" rx={r * 24 / size} fill="#fff" stroke="#e3d9c8" />
      <rect x="4" y="9" width="10" height="3" rx="1.5" fill="#36C5F0" /><rect x="12" y="4" width="3" height="10" rx="1.5" fill="#2EB67D" />
      <rect x="10" y="12" width="10" height="3" rx="1.5" fill="#ECB22E" /><rect x="9" y="10" width="3" height="10" rx="1.5" fill="#E01E5A" />
    </svg>
  );
  const icon = SIMPLE_ICONS[kind];
  if (icon) {
    const pad = size * 0.22; const inner = size - 2 * pad;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name} className="brand-logo">
        <rect width={size} height={size} rx={r} fill={icon.hex} />
        <g transform={`translate(${pad} ${pad}) scale(${inner / 24})`}><path d={icon.path} fill={inkOn(icon.hex)} /></g>
      </svg>
    );
  }
  // sem logo aberto: a inicial na cor da marca; sem cor conhecida, uma cor estável tirada do nome (nunca o cinza de antes)
  const m = MONOGRAM[kind] ?? { hex: corDoNome(kind || name), letter: name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?' };
  const id = `bl-${kind.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name} className="brand-logo">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".18" /><stop offset="1" stopColor="#000" stopOpacity=".08" /></linearGradient></defs>
      <rect width={size} height={size} rx={r} fill={m.hex} /><rect width={size} height={size} rx={r} fill={`url(#${id})`} />
      <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill={inkOn(m.hex)} fontSize={size * (m.letter.length > 1 ? 0.36 : 0.48)} fontWeight="700" letterSpacing={m.letter.length > 1 ? '-.02em' : undefined} fontFamily="system-ui, sans-serif">{m.letter}</text>
    </svg>
  );
}

/** Uma cor da marca do Ergon para o monograma de quem não tem cor conhecida (o mesmo nome dá sempre a mesma). */
const PALETA = ['#3B5BFD', '#0E8A7B', '#B4532A', '#6D4FC2', '#1F7A3E', '#B03A6B', '#2B6CB0'];
function corDoNome(nome: string): string {
  let h = 0;
  for (const c of nome) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETA[h % PALETA.length];
}

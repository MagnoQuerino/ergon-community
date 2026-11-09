/**
 * Os botões dos cartões que dão mais autonomia à equipe (o servidor decide o que vale: server/src/services/conexoes/regras.ts):
 * o cartão de regra ("podem mandar os e-mails sem me pedir aprovação") com o alcance — só neste pedido, por 24 h, sempre —
 * e o cartão de aprovação depois de ler as contas com o prazo — 1 h, 8 h, 72 h, sempre. Um clique aplica; nada de senha.
 * O mesmo cartão na conversa, em "Aguardando você" e no card.
 */
export type Alcance = 'pedido' | '24h' | 'sempre';
export type Prazo = '1h' | '8h' | '72h' | 'sempre';
export const ALCANCES: ReadonlyArray<[Alcance, string]> = [['pedido', 'Só neste pedido'], ['24h', 'Por 24 h'], ['sempre', 'Sempre']];
export const PRAZOS: ReadonlyArray<[Prazo, string]> = [['1h', '1 h'], ['8h', '8 h'], ['72h', '72 h'], ['sempre', 'Sempre']];

/** O alcance que a proposta sugere: o que a pessoa disse ("sempre", "hoje"); sem dizer, só neste pedido. */
export function alcanceSugerido(payload?: string | null): Alcance {
  try { const a = (JSON.parse(payload ?? '{}') as { alcance?: string }).alcance; return a === '24h' || a === 'sempre' ? a : 'pedido'; } catch { return 'pedido'; }
}

/** O cartão de regra: cada botão aplica com aquele alcance; o sugerido vem em destaque. */
export function BotoesRegra({ sugerido, onEscolher, onRecusar, ocupado }: { sugerido: Alcance; onEscolher: (a: Alcance) => void; onRecusar: () => void; ocupado?: boolean }) {
  return (
    <span className="row row--wrap cartao-regra__botoes" role="group" aria-label="Até quando vale">
      {ALCANCES.map(([a, rotulo]) => (
        <button key={a} type="button" className={`btn btn--sm ${a === sugerido ? 'btn--primary' : ''}`} disabled={ocupado} onClick={() => onEscolher(a)}>{rotulo}</button>
      ))}
      <button type="button" className="btn btn--sm btn--ghost" disabled={ocupado} onClick={onRecusar}>Recusar</button>
    </span>
  );
}

/** O cartão de aprovação depois de ler as contas: aprovar por quanto tempo (1 h, o de antes, em destaque). */
export function BotoesPrazo({ onEscolher, onRecusar, ocupado }: { onEscolher: (p: Prazo) => void; onRecusar: () => void; ocupado?: boolean }) {
  return (
    <span className="row row--wrap cartao-regra__botoes" role="group" aria-label="Aprovar por quanto tempo">
      <span className="muted small">Aprovar por</span>
      {PRAZOS.map(([p, rotulo], i) => (
        <button key={p} type="button" className={`btn btn--sm ${i === 0 ? 'btn--primary' : ''}`} disabled={ocupado} onClick={() => onEscolher(p)}>{rotulo}</button>
      ))}
      <button type="button" className="btn btn--sm btn--ghost" disabled={ocupado} onClick={onRecusar}>Recusar</button>
    </span>
  );
}

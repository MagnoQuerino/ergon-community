import { useT } from '../i18n/index.ts';

/**
 * Os botões dos cartões que dão mais autonomia à equipe (o servidor decide o que vale: server/src/services/conexoes/regras.ts):
 * o cartão de regra ("podem mandar os e-mails sem me pedir aprovação") com o alcance — só neste pedido, por 24 h, sempre —
 * e o cartão de aprovação depois de ler as contas com o prazo — 1 h, 8 h, 72 h, sempre. Um clique aplica; nada de senha.
 * O mesmo cartão na conversa, em "Aguardando você" e no card.
 */
export type Alcance = 'pedido' | '24h' | 'sempre';
export type Prazo = '1h' | '8h' | '72h' | 'sempre';
/** cada opção com a chave do rótulo (traduzido na hora de mostrar) */
export const ALCANCES: ReadonlyArray<[Alcance, `conexoes.alcance.${Alcance}`]> = [['pedido', 'conexoes.alcance.pedido'], ['24h', 'conexoes.alcance.24h'], ['sempre', 'conexoes.alcance.sempre']]; // i18n-ok: 'sempre' é o valor interno (a API espera assim); o rótulo vem do dicionário
export const PRAZOS: ReadonlyArray<[Prazo, `conexoes.prazo.${Prazo}`]> = [['1h', 'conexoes.prazo.1h'], ['8h', 'conexoes.prazo.8h'], ['72h', 'conexoes.prazo.72h'], ['sempre', 'conexoes.prazo.sempre']]; // i18n-ok: idem

/** O alcance que a proposta sugere: o que a pessoa disse ("sempre", "hoje"); sem dizer, só neste pedido. */
export function alcanceSugerido(payload?: string | null): Alcance {
  try { const a = (JSON.parse(payload ?? '{}') as { alcance?: string }).alcance; return a === '24h' || a === 'sempre' ? a : 'pedido'; } catch { return 'pedido'; }
}

/** O cartão de regra: cada botão aplica com aquele alcance; o sugerido vem em destaque. */
export function BotoesRegra({ sugerido, onEscolher, onRecusar, ocupado }: { sugerido: Alcance; onEscolher: (a: Alcance) => void; onRecusar: () => void; ocupado?: boolean }) {
  const t = useT();
  return (
    <span className="row row--wrap cartao-regra__botoes" role="group" aria-label={t('conexoes.cartao.ateQuando')}>
      {ALCANCES.map(([a, rotulo]) => (
        <button key={a} type="button" className={`btn btn--sm ${a === sugerido ? 'btn--primary' : ''}`} disabled={ocupado} onClick={() => onEscolher(a)}>{t(rotulo)}</button>
      ))}
      <button type="button" className="btn btn--sm btn--ghost" disabled={ocupado} onClick={onRecusar}>{t('conexoes.cartao.recusar')}</button>
    </span>
  );
}

/** O cartão de aprovação depois de ler as contas: aprovar por quanto tempo (1 h, o de antes, em destaque). */
export function BotoesPrazo({ onEscolher, onRecusar, ocupado }: { onEscolher: (p: Prazo) => void; onRecusar: () => void; ocupado?: boolean }) {
  const t = useT();
  return (
    <span className="row row--wrap cartao-regra__botoes" role="group" aria-label={t('conexoes.cartao.porQuantoTempo')}>
      <span className="muted small">{t('conexoes.cartao.aprovarPor')}</span>
      {PRAZOS.map(([p, rotulo], i) => (
        <button key={p} type="button" className={`btn btn--sm ${i === 0 ? 'btn--primary' : ''}`} disabled={ocupado} onClick={() => onEscolher(p)}>{t(rotulo)}</button>
      ))}
      <button type="button" className="btn btn--sm btn--ghost" disabled={ocupado} onClick={onRecusar}>{t('conexoes.cartao.recusar')}</button>
    </span>
  );
}

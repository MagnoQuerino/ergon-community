// Os níveis de ação dos cartões (rc.28): os botões dos cartões — na conversa, em "Aguardando você", no card aberto e em
// Conexões › Regras — saem das classes pequenas do resto do app e ganham tamanho próprio (styles.css, bloco "ações dos
// cartões"). Os 259 botões pequenos fora dos cartões não mudam.
//   principal  — um por cartão: Aprovar, Responder, Entregar, Autorizar (14 px, peso 600, 40 px; 44 px no toque)
//   secundario — Recusar, Pedir ajustes, Outra resposta: o mesmo tamanho, contorno visível (nunca "fantasma")
//   perigoso   — Apagar de vez: vermelho cheio, com a confirmação que o cartão já tiver
//   leve       — o que era link solto: Abrir card #92, Não responder, ver tudo (32 px de área de clique)
//   opcao      — cada opção de uma pergunta (40 px, largura total no cartão estreito)
// O selo dos estados (Aplicada, Com você) é .card-selo: 12,5–13 px, peso 600, sempre com ícone e texto.

export type NivelAcao = 'principal' | 'secundario' | 'perigoso' | 'leve' | 'opcao';

/** As classes de cada nível. As cores continuam as de sempre (btn--primary, btn--danger): o nível muda o tamanho. */
export const ACAO: Readonly<Record<NivelAcao, string>> = {
  principal: 'btn btn--primary card-act card-act--primary',
  secundario: 'btn card-act card-act--sec',
  perigoso: 'btn btn--danger card-act card-act--danger',
  leve: 'linkish card-act--leve',
  opcao: 'btn card-opt',
};

/** Os botões grandes da faixa do card aberto (44 px, letra 15): o principal e o secundário com contorno visível. */
export const ACAO_GRANDE = {
  principal: 'btn btn--primary btn--big card-act--primary',
  secundario: 'btn btn--big card-act--sec',
} as const;

/** A fileira de botões de um cartão: 8 px entre eles; estreita (gaveta de 380 px), o principal vai sozinho na 1ª linha. */
export const FILEIRA = 'card-acts';

/** Os limites que o CSS cumpre e o teste confere (a medição no Edge confere os mesmos na tela desenhada). */
export const LIMITES = {
  principal: { letra: 14, peso: 600, altura: 40, toque: 44 },
  leve: { altura: 32, toque: 44 },
  opcao: { altura: 40, toque: 44 },
  selo: { letraMin: 12.5, letraMax: 13, peso: 600 },
  mensagem: { icone: 16, area: 32, espaco: 4 },
  miudo: { area: 24, toque: 44 },
  espaco: 8,
} as const;

/** Mais do que isto num cartão e as escolhas se recolhem num principal com seletor ao lado. */
export const MAX_ACOES_SOLTAS = 3;

/**
 * Recolher: um cartão com mais de 3 ações (as escolhas do principal mais as outras, como Recusar) vira um principal com
 * a escolha padrão, um seletor ao lado com todas as escolhas e as outras ações como secundárias. Até 3, ficam soltas.
 */
export function recolhe(escolhas: number, outras: number): boolean {
  return escolhas + outras > MAX_ACOES_SOLTAS;
}

/**
 * O valor que o seletor devolve, de volta ao tipo da escolha: só o que está na lista (o mesmo valor que o botão solto
 * mandava); qualquer outra coisa fica na escolha padrão. É isto que garante que recolher não muda o que é enviado.
 */
export function escolhaDoSeletor<V extends string>(valor: string, escolhas: ReadonlyArray<readonly [V, string]>, padrao: V): V {
  return escolhas.find(([v]) => v === valor)?.[0] ?? padrao;
}

// ---- o cartão de regra e o de aprovação depois de ler (o servidor decide o que vale: server/src/services/conexoes/regras.ts)

export type Alcance = 'pedido' | '24h' | 'sempre';
export type Prazo = '1h' | '8h' | '72h' | 'sempre';
/** cada opção com a chave do rótulo (traduzido na hora de mostrar) */
export const ALCANCES: ReadonlyArray<readonly [Alcance, `conexoes.alcance.${Alcance}`]> = [['pedido', 'conexoes.alcance.pedido'], ['24h', 'conexoes.alcance.24h'], ['sempre', 'conexoes.alcance.sempre']]; // i18n-ok: 'sempre' é o valor interno (a API espera assim); o rótulo vem do dicionário
export const PRAZOS: ReadonlyArray<readonly [Prazo, `conexoes.prazo.${Prazo}`]> = [['1h', 'conexoes.prazo.1h'], ['8h', 'conexoes.prazo.8h'], ['72h', 'conexoes.prazo.72h'], ['sempre', 'conexoes.prazo.sempre']]; // i18n-ok: idem
/** o prazo que o principal já traz escolhido (o plano da rc.28: "Aprovar por 8 h"); o seletor ao lado troca */
export const PRAZO_PADRAO: Prazo = '8h';

/** O alcance que a proposta sugere: o que a pessoa disse ("sempre", "hoje"); sem dizer, só neste pedido. */
export function alcanceSugerido(payload?: string | null): Alcance {
  try { const a = (JSON.parse(payload ?? '{}') as { alcance?: string }).alcance; return a === '24h' || a === 'sempre' ? a : 'pedido'; } catch { return 'pedido'; }
}

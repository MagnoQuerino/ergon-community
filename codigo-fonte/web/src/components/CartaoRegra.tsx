import { useState } from 'react';
import { useT } from '../i18n/index.ts';
import { ACAO, ALCANCES, FILEIRA, PRAZOS, PRAZO_PADRAO, escolhaDoSeletor, type Alcance, type Prazo } from '../lib/cartoes-acoes.ts';

/**
 * Os botões dos cartões que dão mais autonomia à equipe (o servidor decide o que vale: server/src/services/conexoes/regras.ts):
 * o cartão de regra ("podem mandar os e-mails sem me pedir aprovação") com o alcance — só neste pedido, por 24 h, sempre —
 * e o cartão de aprovação depois de ler as contas com o prazo — 1 h, 8 h, 72 h, sempre. Um clique aplica; nada de senha.
 * O mesmo cartão na conversa, em "Aguardando você" e no card.
 *
 * rc.28: com mais de 3 ações o cartão recolhe (lib/cartoes-acoes.ts): um principal com a escolha de agora ("Aprovar por
 * 8 h"), o seletor ao lado (1 h, 8 h, 72 h, sempre) e "Recusar" como secundário — cada escolha manda o mesmo de antes.
 * Enquanto vai, o botão fica ativo, diz "Enviando…" e marca aria-busy; o segundo clique não manda de novo.
 */
export type { Alcance, Prazo };
export { alcanceSugerido } from '../lib/cartoes-acoes.ts';

/** ocupado: a decisão em andamento ('recusar' diz "Recusando…" no Recusar; true ou 'aplicar', "Enviando…" no principal) */
type Ocupado = boolean | 'aplicar' | 'recusar' | undefined;

/**
 * O principal com a escolha e o seletor ao lado, e o Recusar. `rotulo` é o texto do principal para a escolha; `opcoes`,
 * o texto de cada escolha no seletor. O segundo clique, com algo indo, não chama nada.
 */
function Recolhido<V extends string>({ escolhas, inicial, rotulo, opcoes, grupo, seletor, onEscolher, onRecusar, ocupado }: {
  escolhas: ReadonlyArray<readonly [V, string]>; inicial: V; rotulo: (v: V) => string; opcoes: (v: V) => string; grupo: string; seletor: string;
  onEscolher: (v: V) => void; onRecusar: () => void; ocupado: Ocupado;
}) {
  const t = useT();
  const [valor, setValor] = useState<V>(inicial);
  const indo = !!ocupado;
  const aplicando = indo && ocupado !== 'recusar';
  return (
    <span className={`${FILEIRA} cartao-regra__botoes`} role="group" aria-label={grupo}>
      <span className="card-acts__escolha">
        <button type="button" className={ACAO.principal} aria-busy={aplicando} onClick={() => { if (!indo) onEscolher(valor); }}>
          {aplicando ? t('conexoes.cartao.enviando') : rotulo(valor)}
        </button>
        <select className="card-act card-act--sec card-acts__seletor" value={valor} aria-label={seletor} onChange={(e) => setValor(escolhaDoSeletor(e.target.value, escolhas, inicial))}>
          {escolhas.map(([v]) => <option key={v} value={v}>{opcoes(v)}</option>)}
        </select>
      </span>
      <button type="button" className={ACAO.secundario} aria-busy={ocupado === 'recusar'} onClick={() => { if (!indo) onRecusar(); }}>
        {ocupado === 'recusar' ? t('conexoes.cartao.recusando') : t('conexoes.cartao.recusar')}
      </button>
    </span>
  );
}

/** O cartão de regra: o principal aplica com o alcance escolhido (o sugerido já vem escolhido). */
export function BotoesRegra({ sugerido, onEscolher, onRecusar, ocupado }: { sugerido: Alcance; onEscolher: (a: Alcance) => void; onRecusar: () => void; ocupado?: Ocupado }) {
  const t = useT();
  const rotuloDe = (a: Alcance) => t(ALCANCES.find(([x]) => x === a)![1]);
  // 3 alcances + Recusar = 4 ações: recolhe (lib/cartoes-acoes.ts, recolhe)
  return (
    <Recolhido escolhas={ALCANCES} inicial={sugerido} grupo={t('conexoes.cartao.ateQuando')} seletor={t('conexoes.cartao.ateQuando')}
      rotulo={(a) => t(`conexoes.cartao.permitir.${a}`)} opcoes={rotuloDe} onEscolher={onEscolher} onRecusar={onRecusar} ocupado={ocupado} />
  );
}

/** O cartão de aprovação depois de ler as contas: "Aprovar por 8 h", e o seletor ao lado troca o prazo. */
export function BotoesPrazo({ onEscolher, onRecusar, ocupado }: { onEscolher: (p: Prazo) => void; onRecusar: () => void; ocupado?: Ocupado }) {
  const t = useT();
  const rotuloDe = (p: Prazo) => t(PRAZOS.find(([x]) => x === p)![1]);
  return (
    <Recolhido escolhas={PRAZOS} inicial={PRAZO_PADRAO} grupo={t('conexoes.cartao.porQuantoTempo')} seletor={t('conexoes.cartao.prazo')}
      rotulo={(p) => (p === 'sempre' ? t('conexoes.cartao.aprovarSempre') : t('conexoes.cartao.aprovarPorPrazo', { prazo: rotuloDe(p) }))}
      opcoes={rotuloDe} onEscolher={onEscolher} onRecusar={onRecusar} ocupado={ocupado} />
  );
}

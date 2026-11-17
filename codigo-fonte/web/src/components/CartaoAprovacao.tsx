import { limparCaminhos } from '../../../shared/caminhos.ts';
import { useT } from '../i18n/index.ts';

/**
 * O texto do cartão de um comando para aprovar (rc.33, server/src/services/aprovacao-cartao.ts): quem decide lê uma frase
 * simples ("Hipátia quer rodar um pequeno programa em Python para calcular datas."), com a etiqueta do risco quando o
 * servidor sabe dizer ("só calcula", "apaga"…). O comando fica recolhido em "Ver detalhes técnicos": numa caixa de
 * letra fixa, com rolagem, de no máximo umas 12 linhas, e sem os caminhos internos do motor. Nunca no corpo do cartão.
 */
export function TextoDaAprovacao({ resumo, risco, detalhe }: { resumo: string; risco?: string | null; detalhe?: string | null }) {
  return (
    <span className="aprov">
      {risco ? <span className="badge aprov__risco">{risco}</span> : null}
      <span className="aprov__resumo">{resumo}</span>
      {detalhe ? <DetalhesTecnicos texto={detalhe} /> : null}
    </span>
  );
}

/** O comando, recolhido: aberto só por quem quer conferir. */
export function DetalhesTecnicos({ texto }: { texto: string }) {
  const t = useT();
  return (
    <details className="aprov__detalhes">
      <summary>{t('geral.detalhesTecnicos')}</summary>
      {/* rolável pelo teclado também (tabIndex), como toda caixa com rolagem */}
      <pre className="aprov__codigo" tabIndex={0}>{limparCaminhos(texto)}</pre>
    </details>
  );
}

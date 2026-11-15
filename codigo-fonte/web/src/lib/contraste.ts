// Contraste de leitura na tela: a conta e o readableOn vêm de shared/contraste.ts (os mesmos do validador de pacotes);
// aqui fica o que só a tela usa (o estilo do retrato de letra e a leitura das variáveis de um bloco da folha).
// A leitura da folha de estilos (teste que reprova a publicação) fica em contraste-folha.ts.
import { readableOn } from '../../../shared/contraste.ts';

export * from '../../../shared/contraste.ts';

/**
 * Estilo do retrato de letra (a inicial sobre a cor do agente): fundo e letra que se leem. Sem cor (ou cor inválida),
 * devolve `undefined` e vale o padrão da classe `.avatar` (navy com letra branca).
 */
export function letterStyle(color: string | null | undefined): { background: string; color: string } | undefined {
  const r = readableOn(color);
  return r ? { background: r.bg, color: r.fg } : undefined;
}


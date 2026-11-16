// A moeda do World no glossário da tradução (i18n/GLOSSARIO.md tem os outros termos). Fica aqui, no módulo do World,
// porque o World é um módulo à parte (views/world).
//
// Decisão de 09/11: a moeda NÃO se traduz. Em inglês continua "Dracma" / "Dracmas", com o símbolo ₯ (nunca
// "Drachma"); só o número segue o idioma: fmtDracmas(1250) → "₯ 1.250" / "₯ 1,250" (i18n/index.ts).
// O teste de completude (i18n/completude.test.ts) lê esta lista quando ela existe.
import type { Termo } from '../../i18n/glossario.ts';

export const GLOSSARIO_MOEDA: readonly Termo[] = [
  { pt: 'Dracma', en: 'Dracma', conferir: true },
  { pt: 'Dracmas', en: 'Dracmas', conferir: true },
];

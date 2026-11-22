// O inglês da Índia (en-IN): o texto é o do inglês (../en/), inteiro, pela RESERVA de ../idiomas.ts; o que muda são os
// números, as datas e a moeda, pelo locale en-IN (lakh e crore: 12,34,567; ₹; data dd/mm/aaaa em nucleo.ts). Uma chave que
// precise de outra palavra na Índia entra aqui, área por área, com os mesmos tipos do português.
// rc.47 (revisão do en-IN): os exemplos que só fazem sentido no Brasil ou nos EUA (o telefone +55, a amostra do modelo de
// documento em US$, os 750,000 de palavras sem lakh) e a grafia britânica que se usa na Índia nos poucos textos de
// cobrança e de exemplo; o GST, onde couber, nos textos de cobrança do World (views/world/textos.ts, enIN).
import type { Dicionario } from '../pt/index.ts';
import type { TraducaoParcial } from '../tipos.ts';

const conexoes: TraducaoParcial<Dicionario['conexoes']> = {
  'wa.equipe.telefoneExemplo': 'e.g. +91 98123 45678',
  'modelo.preco': 'Price: as published by the account, in US dollars per million units of text, about 7,50,000 words (input / output). Tiers: budget up to US$0.50, mid-range up to US$3, premium above that.',
  'pastas.exemplo': '/home/priya/projects/site or C:\\Users\\Priya\\Projects\\site',
};

const configuracoes: TraducaoParcial<Dicionario['configuracoes']> = {
  'entregas.amostra': '# Sample report\n\nA paragraph with **bold**, *italics* and a [link](https://example.com), to show the font, line spacing and margins.\n\n## Results\n\n| Item | Qty | Amount |\n|:--|--:|--:|\n| Consulting | 12 | ₹4,80,000.00 |\n| Training | 3 | ₹1,95,000.00 |\n\n1. First point.\n2. Second point.\n\n> Long quote: over three lines, 4 cm indent, smaller type and single spacing.\n\n## References\n\nINTERNATIONAL ORGANIZATION FOR STANDARDIZATION. **ISO 690**: guidelines for bibliographic references. Geneva: ISO, 2021.\n',
};

export const enIN: { readonly [A in keyof Dicionario]?: TraducaoParcial<Dicionario[A]> } = { conexoes, configuracoes };

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

// a ficha da biblioteca de rotinas: os valores dos exemplos em rupias, com lakh; o GST na categoria de impostos
const rotinas: TraducaoParcial<Dicionario['rotinas']> = {
  'catalogo.analista-planilhas.exemplo': "Sales 2026: 1,248 rows; total ₹34,12,560.00.\nSeptember: ₹2,48,300.00, −12.4% vs. August.\nConcentration: Client A accounts for 31.2%.\nInconsistencies: row 418 is an outlier (₹98,000.00); 7 duplicate rows.",
  'catalogo.apresentacao-resultados.exemplo': "# Q3 results\n## Key numbers\n- Revenue of ₹34,12,560.00 for the year\n- September: −12.4% vs. August\n## Recommendations\n- Renegotiate with Client A (31.2% of revenue)",
  'catalogo.comparador.exemplo': "Option A (D1): ₹4,12,000.00 · delivery 60 days · 24-month warranty (§D1.14).\nOption B (D2): ₹3,89,500.00 · delivery 120 days · 12-month warranty (§D2.9).\nRecommendation: A, for the warranty and the lead time; still unknown: the cost of the maintenance contract.",
  'catalogo.revisor-documentos.exemplo': "1. §D1.12 says \"delivery in 30 days\", but §D1.40 says 45 days: align them.\n2. §D1.18 adds ₹12,000.00 + ₹8,500.00 = ₹21,500.00 (the right total is ₹20,500.00).\nOpinion: ready with adjustments.",
  'catalogo.planejador-projetos.entradaTextoEx': "E.g. launch the chromatography course by Dec 15, with a ₹4,00,000 budget",
  'catalogo.financeiro-documentos.exemplo': "8 entries: outflows ₹1,42,305.00 · inflows ₹2,20,000.00.\nHeads up: L5 was read from a PDF (check the amount); L7 and L8 may be the same payment.\nWaiting for your approval in \"Waiting for you\".",
  'catalogo.financeiro-documentos.entradaTextoEx': "E.g. Suppliers; Payroll; Taxes (GST); Rent; Sales",
  'catalogo.conferencia-financeira.exemplo': "142 entries checked; 4 discrepancies.\nA L37 ₹12,500.00 on Oct 14 is not in the spreadsheet (a fee? a forgotten payment?).\nA L52 ₹34,000.00 × B L48 ₹30,400.00: probably a typo.",
  'catalogo.radar-regulatorio.param.temas.ex': "E.g. CDSCO labs; NABL accreditation; fertiliser rules",
};

export const enIN: { readonly [A in keyof Dicionario]?: TraducaoParcial<Dicionario[A]> } = { conexoes, configuracoes, rotinas };

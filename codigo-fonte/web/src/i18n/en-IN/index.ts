// O inglês da Índia (en-IN): o texto é o do inglês (../en/), inteiro, pela RESERVA de ../idiomas.ts; o que muda são os
// números, as datas e a moeda, pelo locale en-IN (lakh e crore: 12,34,567; ₹). Uma chave que precise de outra palavra
// na Índia entra aqui, área por área, com os mesmos tipos do português.
import type { Dicionario } from '../pt/index.ts';
import type { TraducaoParcial } from '../tipos.ts';

export const enIN: { readonly [A in keyof Dicionario]?: TraducaoParcial<Dicionario[A]> } = {};

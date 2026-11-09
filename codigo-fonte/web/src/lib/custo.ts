// Custo das chamadas (Configurações › Ferramentas da equipe): do que é feita cada chamada ao modelo, por agente, e o
// máximo de passos por pedido. Os textos ficam aqui, fora do componente, para o teste (custo.test.ts) conferir números e
// palavras (sem as peças por dentro do Ergon).
import type { ComposicaoAgente } from './types.ts';

/** as escolhas da tela (o servidor aceita de 5 a 60; o padrão é 20) */
export const PASSOS_OPCOES = [5, 10, 15, 20, 30, 40, 60];
export const PASSOS_PADRAO = 20;

export const PASSOS_AJUDA = 'Cada passo é uma ida ao modelo de IA: pensar, usar uma ferramenta, conferir o resultado. Com mais passos, a equipe resolve sozinha pedidos longos; com menos, gasta menos. Cada passo conta no consumo. Ao chegar no limite, o pedido para ali. O padrão é 20.';
export const PASSOS_DEPOIS = 'A equipe ainda não recebeu a mudança: ela recebe assim que estiver ligada.';
/** um motor para vários workspaces: a escolha vale para todos eles (a tela mostra o que vale de fato) */
export const passosCompartilhado = (outros: number) => outros > 0 ? `Vale também para ${outros === 1 ? 'o outro workspace que usa' : `os outros ${outros} workspaces que usam`} a mesma equipe: a escolha mais recente é a que vale.` : '';

/** Resumir as conversas longas mais cedo (ligado por padrão): o texto ao lado da escolha */
export const COMPACTAR_ROTULO = 'Resumir as conversas longas';
export const COMPACTAR_AJUDA = 'Quando a conversa de um agente fica longa, a parte mais antiga vira um resumo e cada passo gasta menos; pedidos e anexos muito longos entram encurtados. Desligado, só perto do limite do modelo de IA. Vale a partir do próximo pedido.';
export const COMPACTAR_DEPOIS = 'A equipe ainda não recebeu a mudança: ela recebe assim que estiver ligada.';
/** a equipe é de antes desta opção: a escolha fica guardada e passa a valer quando a equipe for atualizada */
export const COMPACTAR_ATUALIZACAO = 'Chega com a próxima atualização da equipe (veja em Saúde); a sua escolha fica guardada.';

export const COMPOSICAO_INTRO = 'Cada vez que um agente pensa, o modelo de IA recebe tudo de novo: as instruções, a descrição das ferramentas, a memória e a conversa até ali. Esta é a média dos últimos 30 dias, medida nas chamadas de verdade.';
export const COMPOSICAO_VAZIA = 'Ainda sem medições: elas aparecem depois dos próximos pedidos da equipe.';
export const COMPOSICAO_NOTA = 'O total de cada chamada é o que o provedor informou; a divisão entre as partes segue o tamanho de cada uma. “Anexos e dados” é o que o sistema junta ao pedido (arquivos anexados, documentos citados, dados das contas): vai em cada chamada do pedido e continua na conversa nos pedidos seguintes.';
export const COMPOSICAO_ESTIMADA = 'Em alguns pedidos a medição ficou incompleta (o provedor não informou o total, ou faltou o registro de alguma chamada): neles, os números são estimados.';

export interface Fatia { id: 'instrucoes' | 'ferramentas' | 'memoria' | 'anexos' | 'conversa'; rotulo: string; fracao: number; pct: string }
const ROTULOS: Record<Fatia['id'], string> = { instrucoes: 'Instruções', ferramentas: 'Ferramentas', memoria: 'Memória', anexos: 'Anexos e dados', conversa: 'Conversa' };

/** porcentagem como a pessoa lê: inteira; abaixo de 1%, "<1%"; zero, "0%" */
export function pct(f: number): string {
  const p = Math.max(0, Math.min(1, f)) * 100;
  if (p === 0) return '0%';
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/** as cinco partes, na ordem da barra (de servidor antigo, sem os anexos: zero) */
export function fatias(a: Pick<ComposicaoAgente, 'partes'>): Fatia[] {
  return (['instrucoes', 'ferramentas', 'memoria', 'anexos', 'conversa'] as const).map((id) => { const f = a.partes[id] ?? 0; return { id, rotulo: ROTULOS[id], fracao: f, pct: pct(f) }; });
}

/** "≈ 58 mil por chamada" (a média de entrada, na mesma medida do consumo) */
export function tamanhoMedio(n: number): string {
  if (n >= 1_000_000) return `≈ ${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} milhão por chamada`;
  if (n >= 10_000) return `≈ ${Math.round(n / 1000).toLocaleString('pt-BR')} mil por chamada`;
  if (n >= 1000) return `≈ ${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil por chamada`;
  return `≈ ${n.toLocaleString('pt-BR')} por chamada`;
}

/** a linha de baixo: de que são feitas as instruções e quanto o provedor reaproveitou */
export function detalhe(a: Pick<ComposicaoAgente, 'instrucoes' | 'cache' | 'chamadas' | 'resumidas' | 'execucoes'>): string {
  const partes = [`Instruções: ${pct(a.instrucoes.agente)} do agente no Ergon (cargo, equipe, cards e regras), ${pct(a.instrucoes.base)} da base da equipe e ${pct(a.instrucoes.competencias)} da lista de competências.`];
  if (a.cache !== null) partes.push(`${pct(a.cache)} reaproveitado pelo provedor (cobrado mais barato, quando o provedor tem esse desconto).`);
  const r = resumidasTexto(a.resumidas ?? 0, a.execucoes ?? 0);
  if (r) partes.push(r);
  return partes.join(' ');
}

/** em quantos pedidos a conversa foi resumida (vazio quando nenhum: nada a dizer) */
export function resumidasTexto(resumidas: number, pedidos: number): string {
  if (resumidas <= 0) return '';
  const de = pedidos > resumidas ? ` de ${pedidos.toLocaleString('pt-BR')}` : '';
  return `Conversa resumida em ${resumidas.toLocaleString('pt-BR')}${de} ${resumidas === 1 && !de ? 'pedido' : 'pedidos'}: a parte antiga virou um resumo, e as chamadas seguintes ficaram menores (resumir também usa o modelo de IA, uma vez).`;
}

export const chamadasTexto = (n: number) => `${n.toLocaleString('pt-BR')} ${n === 1 ? 'chamada' : 'chamadas'}`;

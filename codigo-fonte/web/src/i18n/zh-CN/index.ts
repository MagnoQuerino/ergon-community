// O dicionário em chinês simplificado (zh-CN): PARCIAL. Tem as áreas principais (entrar e boas-vindas, navegação, conversa e salas,
// configurações básicas, tarefas e entregas); a chave que falta vem do inglês (RESERVA em ../idiomas.ts), nunca crua.
// REVISÃO POR NATIVO PENDENTE em todas as áreas: ver COMO-TRADUZIR.md, "Chinês e hindi".
import type { Dicionario } from '../pt/index.ts';
import type { TraducaoParcial } from '../tipos.ts';
import ajuda from './ajuda.ts';
import conexoes from './conexoes.ts';
import configuracoes from './configuracoes.ts';
import conta from './conta.ts';
import conversas from './conversas.ts';
import geral from './geral.ts';
import quadro from './quadro.ts';
import servidor from './servidor.ts';
import tarefa from './tarefa.ts';
import visuais from './visuais.ts';

export const zhCN: { readonly [A in keyof Dicionario]?: TraducaoParcial<Dicionario[A]> } = { ajuda, conexoes, configuracoes, conta, conversas, geral, quadro, servidor, tarefa, visuais };

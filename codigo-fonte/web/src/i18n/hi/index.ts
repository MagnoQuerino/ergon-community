// O dicionário em hindi (hi): todas as áreas (rc.47, a mesma cobertura do chinês). A chave que falta vem do inglês
// (RESERVA em ../idiomas.ts), nunca crua. Áreas: geral, cidade, quadro, tarefa, conversas, equipe, agente, rotinas, conexoes, documentos, configuracoes, conta, ajuda, servidor, visuais.
// REVISÃO POR NATIVO PENDENTE em todas as áreas: ver COMO-TRADUZIR.md, "Chinês e hindi".
import type { Dicionario } from '../pt/index.ts';
import type { TraducaoParcial } from '../tipos.ts';
import geral from './geral.ts';
import cidade from './cidade.ts';
import quadro from './quadro.ts';
import tarefa from './tarefa.ts';
import conversas from './conversas.ts';
import equipe from './equipe.ts';
import agente from './agente.ts';
import rotinas from './rotinas.ts';
import conexoes from './conexoes.ts';
import documentos from './documentos.ts';
import configuracoes from './configuracoes.ts';
import conta from './conta.ts';
import ajuda from './ajuda.ts';
import servidor from './servidor.ts';
import visuais from './visuais.ts';

export const hi: { readonly [A in keyof Dicionario]?: TraducaoParcial<Dicionario[A]> } = { geral, cidade, quadro, tarefa, conversas, equipe, agente, rotinas, conexoes, documentos, configuracoes, conta, ajuda, servidor, visuais };

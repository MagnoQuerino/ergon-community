// O dicionário em inglês, com TODAS as áreas. Tipado pelo português: área ou chave faltando não compila.
import type { Dicionario } from '../pt/index.ts';
import type { Traducao } from '../tipos.ts';
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

export const en: { readonly [A in keyof Dicionario]: Traducao<Dicionario[A]> } = { geral, cidade, quadro, tarefa, conversas, equipe, agente, rotinas, conexoes, documentos, configuracoes, conta, ajuda, servidor };

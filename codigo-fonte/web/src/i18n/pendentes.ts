// Os arquivos de tela que ainda têm texto em português escrito direto no código (o teste-catraca, catraca.test.ts,
// deixa passar só estes). Cada equipe tira daqui o arquivo da sua área quando ele passar a ler tudo do dicionário; o
// teste também acusa o arquivo que já está limpo e continua na lista. A lista só diminui: arquivo novo nasce traduzido.
// Um arquivo por linha e uma área por bloco, para as equipes não se atropelarem ao tirar cada um o seu.
import type { NomeDaArea } from './pt/index.ts';

export const PENDENTES: { readonly [A in NomeDaArea]: readonly string[] } = {
  geral: [
  ],

  cidade: [],

  quadro: [
  ],

  tarefa: [],

  conversas: [],

  equipe: [],

  agente: [],

  rotinas: [
  ],

  conexoes: [
  ],

  documentos: [],

  configuracoes: [],

  conta: [],

  ajuda: [],

  servidor: [],
};

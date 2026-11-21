/**
 * O idioma das mensagens fixas do motor de IA (display.language no Hermes): segue o idioma que a pessoa escolheu na tela.
 * O que o motor escreve por conta própria (avisos de aprovação, respostas fixas) quase nunca chega à tela — as telas do
 * Ergon têm os próprios textos —, mas quando vaza (um erro repassado, um aviso num canal direto) vem na língua dela.
 */
import type { Db } from '../db/db.ts';
import { readLang, type Idioma } from './prefs.ts';

/** O idioma como o motor guarda (display.language e a língua da voz): pt, en, zh ou hi (rc.45). */
export type IdiomaMotor = 'pt' | 'en' | 'zh' | 'hi';
/** A capacidade do plugin que aceita zh e hi (rc.45); motor de antes só aceita pt e en e recusaria o pedido inteiro. */
export const CAPACIDADE_IDIOMAS = 'idiomas_zh_hi';

/** O idioma do motor para o idioma da tela: o inglês da Índia é inglês (muda só número e data, que o Ergon formata). */
export function motorDoIdioma(lang: Idioma | undefined): IdiomaMotor | undefined {
  return lang === 'pt-BR' ? 'pt' : lang === 'zh-CN' ? 'zh' : lang === 'hi' ? 'hi' : lang ? 'en' : undefined;
}

/**
 * O idioma do motor da pessoa; undefined = ela nunca escolheu idioma (o motor fica como está). Chinês vai como zh (o
 * Hermes tem o catálogo zh); hindi como hi (o Hermes não tem hi: as mensagens fixas dele caem no inglês, a voz e a
 * transcrição ficam em hindi). Motor sem a capacidade idiomas_zh_hi recebe en (ajustes-motor.ts).
 */
export function idiomaDoMotor(db: Db, userId: string | null | undefined): IdiomaMotor | undefined {
  if (!userId || userId === '_') return undefined;
  return motorDoIdioma(readLang(db, userId));
}

/** Um motor só para a instalação (escopo "_"): vale o idioma de quem é dono do workspace mais antigo. */
export function idiomaDaInstalacao(db: Db): IdiomaMotor | undefined {
  const dono = db.get<{ u: string }>("SELECT m.user_id AS u FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.role = 'owner' ORDER BY w.created_at, w.id LIMIT 1")?.u;
  return idiomaDoMotor(db, dono);
}

/**
 * A linha das instruções que diz ao agente o idioma de quem lê (rc.45): sem ela, o agente seguia o português das próprias
 * instruções quando a pessoa mandava uma tarefa curta ou um anexo, e a entrega de um card ou de uma rotina saía em
 * português para quem usa o Ergon em chinês. Português (ou sem escolha): nada muda (as instruções ficam como sempre
 * foram). Vale "a menos que a pessoa escreva em outro idioma": quem escreve em inglês com a tela em chinês recebe inglês.
 */
const NOME_DO_IDIOMA: Partial<Record<Idioma, string>> = {
  en: 'inglês', 'en-IN': 'inglês (da Índia: valores em rupias, agrupados em lakh e crore quando fizer sentido)',
  'zh-CN': 'chinês simplificado (简体中文)', hi: 'hindi, em devanágari (हिन्दी)',
};
export function instrucaoDeIdioma(lang: Idioma | undefined): string {
  const nome = lang ? NOME_DO_IDIOMA[lang] : undefined;
  if (!nome) return '';
  return `Idioma: a pessoa usa o Ergon em ${nome}. Responda, escreva as entregas, os títulos e as perguntas nesse idioma, a menos que ela escreva em outro (então, no idioma dela). Nomes próprios, de arquivos, comandos e termos técnicos ficam como estão; as marcações do Ergon ([[...]], blocos e campos) continuam com as palavras originais.`;
}

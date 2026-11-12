/**
 * O idioma das mensagens fixas do motor de IA (display.language no Hermes): segue o idioma que a pessoa escolheu na tela.
 * O que o motor escreve por conta própria (avisos de aprovação, respostas fixas) quase nunca chega à tela — as telas do
 * Ergon têm os próprios textos —, mas quando vaza (um erro repassado, um aviso num canal direto) vem na língua dela.
 */
import type { Db } from '../db/db.ts';
import { readLang } from './prefs.ts';

/** 'pt' ou 'en' para o motor da pessoa; undefined = ela nunca escolheu idioma (o motor fica como está). */
export function idiomaDoMotor(db: Db, userId: string | null | undefined): 'pt' | 'en' | undefined {
  if (!userId || userId === '_') return undefined;
  const lang = readLang(db, userId);
  return lang === 'pt-BR' ? 'pt' : lang === 'en' ? 'en' : undefined;
}

/** Um motor só para a instalação (escopo "_"): vale o idioma de quem é dono do workspace mais antigo. */
export function idiomaDaInstalacao(db: Db): 'pt' | 'en' | undefined {
  const dono = db.get<{ u: string }>("SELECT m.user_id AS u FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.role = 'owner' ORDER BY w.created_at, w.id LIMIT 1")?.u;
  return idiomaDoMotor(db, dono);
}

/**
 * Chave própria dos provedores de IA que o trabalho na nuvem aceita (OpenAI, Anthropic, DeepSeek, OpenRouter). O motor
 * guarda a chave dele; esta cópia fica no cofre de segredos do workspace (cifrada com a chave do workspace quando o
 * Ergon está protegido) só para o card que vai ao Ergon World continuar com o modelo da pessoa. Lida só no servidor:
 * nunca vai à tela, a log ou a resposta. Login por assinatura não tem chave e nunca sai daqui.
 */
import type { Integrations } from './integrations.ts';

/** provedores com chave de API que o World aceita (WORLD_DELEGATED_PROVIDERS, padrão) */
export const CLOUD_KEY_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'openrouter'] as const;
const KIND = 'chavesmodelo';

export function saveProviderKey(integrations: Integrations, workspaceId: string, provider: string, key: string | null): void {
  if (!(CLOUD_KEY_PROVIDERS as readonly string[]).includes(provider)) return;
  const cur = integrations.secrets.readOwn<Record<string, string>>(workspaceId, KIND) ?? {};
  if (key === null) delete cur[provider]; else cur[provider] = key.trim();
  if (Object.keys(cur).length) integrations.secrets.writeOwn(workspaceId, KIND, cur);
  else integrations.secrets.remove(workspaceId, KIND);
}

export function providerKeyOf(integrations: Integrations, workspaceId: string, provider: string): string | null {
  if (!(CLOUD_KEY_PROVIDERS as readonly string[]).includes(provider)) return null;
  try { return integrations.secrets.readOwn<Record<string, string>>(workspaceId, KIND)?.[provider] ?? null; } catch { return null; }
}

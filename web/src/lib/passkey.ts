// Passkeys (WebAuthn): o navegador assina o desafio com a chave do aparelho; o servidor só guarda a chave pública.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, api } from './api.ts';

type Options = { key: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };
type RegOptions = { key: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] };

/** Passkeys só valem no endereço cadastrado (ex.: "localhost", não "127.0.0.1"). */
export const passkeysHere = (rpId: string) => browserSupportsWebAuthn() && location.hostname === rpId;

/** Cancelar a janela do navegador não é erro do Ergon: mensagem curta e clara. */
function friendly(e: unknown): never {
  if (e instanceof ApiError) throw e;
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('Passkey cancelada ou não reconhecida neste aparelho.');
  if (name === 'InvalidStateError') throw new Error('Esta passkey já está cadastrada.');
  throw new Error(e instanceof Error ? e.message : String(e));
}

/** Entrar com passkey: sozinha (sem senha) ou como 2º fator de um login com senha (challenge). */
export async function passkeyLogin(challenge?: string): Promise<void> {
  const o = await api.post<Options>('/api/auth/passkey/options', challenge ? { challenge } : {});
  const response = await startAuthentication({ optionsJSON: o.options }).catch(friendly);
  await api.post('/api/auth/passkey', { key: o.key, response, ...(challenge ? { challenge } : {}) });
}

/** Destrancar a tela ou confirmar a identidade com a passkey. */
export async function passkeyUnlock(): Promise<void> {
  const o = await api.post<Options>('/api/session/reauth/options');
  const response = await startAuthentication({ optionsJSON: o.options }).catch(friendly);
  await api.post('/api/session/unlock', { key: o.key, response });
}

export async function passkeyRegister(name: string): Promise<void> {
  const o = await api.post<RegOptions>('/api/security/passkeys/options');
  const response = await startRegistration({ optionsJSON: o.options }).catch(friendly);
  await api.post('/api/security/passkeys', { key: o.key, name, response });
}

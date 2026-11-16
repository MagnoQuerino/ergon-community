export const DEFAULT_WORLD_URL = 'https://api.ergonworld.com';
/**
 * O serviço oficial do app do Ergon no Teams (relé). Vale sem ERGON_TEAMS_RELAY_URL e sem o "Ajuste da instalação";
 * ERGON_TEAMS_RELAY_URL vazia desliga. A tela só o oferece depois que a saúde dele responde (services/teams-app).
 */
export const DEFAULT_TEAMS_RELAY_URL = 'https://teams.ergonworld.com';

export interface WorldConfig {
  /** serviço do Ergon World (https; http só para teste local). Vazio = World desligado nesta instalação */
  url: string | null;
  /** de quanto em quanto tempo o resumo do plano é renovado com o World (só leitura; nada local depende disso) */
  refreshSeconds: number;
}

export function loadWorldConfig(env: NodeJS.ProcessEnv): WorldConfig {
  const raw = (env.ERGON_WORLD_URL ?? DEFAULT_WORLD_URL).trim().replace(/\/+$/, '');
  let url: string | null = null;
  if (raw) {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost') || /^[a-z0-9-]+$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('ERGON_WORLD_URL precisa de https:// (http só para teste local)');
    url = u.origin + u.pathname.replace(/\/+$/, '');
  }
  const secs = Number.parseInt(env.ERGON_WORLD_REFRESH_SECONDS ?? '', 10);
  return { url, refreshSeconds: Number.isFinite(secs) && secs >= 60 && secs <= 86400 ? secs : 900 };
}

// Um envio por vez em cada cartão (rc.28). O botão de um cartão fica ativo enquanto a ação vai: diz "enviando", marca
// aria-busy e o segundo clique não envia de novo. É o que fica no lugar do disabled={busy}: nada fica cinza esperando.
// Numa lista de cartões, a trava é por item (criarTravaPorItem): o clique noutro cartão vai de verdade.
import { useRef, useState } from 'react';

export interface Trava {
  /** o nome da ação em andamento (para o botão certo dizer "enviando"); null = nada indo */
  readonly indo: string | null;
  /**
   * Roda fn se nada estiver indo; senão devolve undefined sem chamar fn (o segundo clique). `segurar`: depois de dar
   * certo a trava continua fechada — para o cartão que some quando a tela relê (a resposta já foi; clicar de novo no
   * intervalo mandaria outra). Deu erro, a trava sempre abre para a pessoa tentar de novo.
   */
  rodar<T>(qual: string, fn: () => Promise<T>, segurar?: boolean): Promise<T | undefined>;
}

/** A trava sem a tela (o teste usa esta). `aoMudar` recebe o nome da ação que começou, ou null quando termina. */
export function criarTrava(aoMudar: (indo: string | null) => void = () => {}): Trava {
  let indo: string | null = null;
  const mudar = (v: string | null) => { indo = v; aoMudar(v); };
  return {
    get indo() { return indo; },
    async rodar<T>(qual: string, fn: () => Promise<T>, segurar = false): Promise<T | undefined> {
      if (indo !== null) return undefined;
      mudar(qual);
      let deuCerto = false;
      try { const r = await fn(); deuCerto = true; return r; } finally { if (!(deuCerto && segurar)) mudar(null); }
    },
  };
}

/** No componente: `indo` redesenha o botão (rótulo e aria-busy) e `enviar` não deixa o segundo clique passar. */
export function useEnvio(): { indo: string | null; enviar: Trava['rodar'] } {
  const [indo, setIndo] = useState<string | null>(null);
  const trava = useRef<Trava | null>(null);
  trava.current ??= criarTrava(setIndo);
  return { indo, enviar: trava.current.rodar };
}

/**
 * A trava por item (rc.28): para a lista com vários cartões ("Aguardando você", Conexões › Regras). Cada item tem a sua:
 * o segundo clique no MESMO item não envia de novo, mas o clique noutro cartão enquanto um vai é enviado de verdade
 * (como na rc.27) — nada de clique que some. Guarda, por item, qual ação está indo, para o botão certo dizer "enviando".
 */
export interface TravaPorItem {
  /** item → ação em andamento (uma cópia nova a cada mudança, para a tela redesenhar) */
  readonly indo: ReadonlyMap<string, string>;
  /** Roda fn se nada deste item estiver indo; senão devolve undefined sem chamar fn. `segurar` como em Trava.rodar. */
  rodar<T>(item: string, acao: string, fn: () => Promise<T>, segurar?: boolean): Promise<T | undefined>;
}

export function criarTravaPorItem(aoMudar: (indo: ReadonlyMap<string, string>) => void = () => {}): TravaPorItem {
  let indo: ReadonlyMap<string, string> = new Map();
  const mudar = (item: string, acao: string | null) => {
    const m = new Map(indo);
    if (acao === null) m.delete(item); else m.set(item, acao);
    indo = m; aoMudar(m);
  };
  return {
    get indo() { return indo; },
    async rodar<T>(item: string, acao: string, fn: () => Promise<T>, segurar = false): Promise<T | undefined> {
      if (indo.has(item)) return undefined;
      mudar(item, acao);
      let deuCerto = false;
      try { const r = await fn(); deuCerto = true; return r; } finally { if (!(deuCerto && segurar)) mudar(item, null); }
    },
  };
}

/** Este item (e, se dada, esta ação dele) está indo? É o que o botão usa para o rótulo e o aria-busy. */
export const vaiNo = (indo: ReadonlyMap<string, string>, item: string, acao?: string): boolean =>
  indo.has(item) && (acao === undefined || indo.get(item) === acao);

/** No componente: `vai(item, ação?)` redesenha o botão certo e `enviar` barra só o segundo clique no mesmo item. */
export function useEnvioPorItem(): { indo: ReadonlyMap<string, string>; vai: (item: string, acao?: string) => boolean; enviar: TravaPorItem['rodar'] } {
  const [indo, setIndo] = useState<ReadonlyMap<string, string>>(() => new Map());
  const trava = useRef<TravaPorItem | null>(null);
  trava.current ??= criarTravaPorItem(setIndo);
  return { indo, vai: (item, acao) => vaiNo(indo, item, acao), enviar: trava.current.rodar };
}

/** O campo está vazio, só com espaços, ou curto demais depois de aparar? Aí o clique avisa no cartão, não some. */
export const textoCurto = (v: string, min = 1): boolean => v.trim().length < min;

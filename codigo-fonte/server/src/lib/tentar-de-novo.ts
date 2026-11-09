/**
 * Tentar de novo em segundo plano, com espera crescente: para limpezas que não podem travar quem pediu (apagar o cofre
 * da equipe de uma conta removida, por exemplo). A primeira tentativa sai na hora; se falhar, a próxima espera a
 * primeira pausa da lista, depois a segunda, e assim por diante. Nada fica preso ao processo (os relógios não seguram o
 * servidor ligado) e `cancelar` para tudo (o servidor desligando).
 */
export interface Tentativas {
  /** resolve `true` quando uma tentativa deu certo, `false` quando acabaram as tentativas ou foi cancelado */
  feito: Promise<boolean>;
  cancelar(): void;
}

/** 30 s, 2 min, 10 min, 1 h e 6 h: o motivo comum (o serviço ainda subindo, o disco ocupado) passa bem antes. */
export const ESPERAS_PADRAO = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

export function tentarDeNovo(fn: () => Promise<unknown>, opts: { esperas?: number[]; aoFalhar?: (erro: unknown, tentativa: number, desiste: boolean) => void } = {}): Tentativas {
  const esperas = opts.esperas ?? ESPERAS_PADRAO;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelado = false;
  let acabar: (ok: boolean) => void = () => undefined;
  const feito = new Promise<boolean>((ok) => { acabar = ok; });
  const tentar = async (n: number): Promise<void> => {
    if (cancelado) return acabar(false);
    try {
      await fn();
      acabar(true);
    } catch (e) {
      const desiste = n >= esperas.length || cancelado;
      try { opts.aoFalhar?.(e, n + 1, desiste); } catch { /* o aviso nunca derruba a próxima tentativa */ }
      if (desiste) return acabar(false);
      timer = setTimeout(() => { timer = null; void tentar(n + 1); }, esperas[n]);
      timer.unref?.();
    }
  };
  void tentar(0);
  return { feito, cancelar: () => { cancelado = true; if (timer) { clearTimeout(timer); timer = null; acabar(false); } } };
}

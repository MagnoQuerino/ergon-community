import { useEffect, useState } from 'react';

/**
 * A janela tem pelo menos esta largura? Acompanha o redimensionamento (sem recarregar). É a largura da janela, não o
 * tipo de aparelho: uma janela de 650 px num computador vale o mesmo que um celular dessa largura.
 */
export function useMinWidth(px: number): boolean {
  const q = `(min-width: ${px}px)`;
  const [ok, setOk] = useState(() => typeof matchMedia === 'undefined' || matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return ok;
}

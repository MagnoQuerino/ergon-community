import { useState } from 'react';
import { useT } from '../i18n/index.ts';

/**
 * Texto do cartão de uma ação numa conta: sempre inteiro, nada é cortado. O longo vem recolhido, com o começo à vista
 * (conta, destino e motivo vêm antes do texto) e "Ver o texto inteiro" para abrir o resto.
 */
export function TextoLongo({ texto, limite = 1200 }: { texto: string; limite?: number }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  if (texto.length <= limite) return <>{texto}</>;
  return (
    <>
      {aberto ? texto : `${texto.slice(0, limite).trimEnd()}…`}{' '}
      <button type="button" className="linkish" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>
        {aberto ? t('geral.texto.recolher') : t('geral.texto.verInteiro', { n: texto.length })}
      </button>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

/**
 * O "+" da barra de digitação no celular (rc.43): anexar e a voz num menu pequeno acima do campo, para o campo de texto
 * ficar com a largura. No computador o botão não aparece (os ícones ficam à vista, .chat__extra); as funções são as
 * mesmas dos ícones.
 */
export function MaisDoCampo({ itens }: { itens: Array<{ rotulo: string; icone: string; fazer: () => void }> }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: PointerEvent) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) setAberto(false); };
    window.addEventListener('pointerdown', fora);
    return () => { window.removeEventListener('pointerdown', fora); };
  }, [aberto]);
  return (
    // aberto, o Esc fecha só o menu (data-esc-own: a conversa em volta não fecha junto)
    <span className="chat__mais-caixa" ref={ref} data-esc-own={aberto ? '' : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape' && aberto) { e.stopPropagation(); setAberto(false); } }}>
      <button type="button" className={`icon-btn chat__mais ${aberto ? 'is-on' : ''}`} onClick={() => setAberto((x) => !x)} aria-expanded={aberto} aria-haspopup="menu"
        aria-label={t('conversas.campo.mais')} title={t('conversas.campo.mais')}><Icon name="plus" /></button>
      {aberto && (
        <span className="chat__mais-menu" role="menu">
          {itens.map((x) => <button key={x.rotulo} type="button" role="menuitem" onClick={() => { setAberto(false); x.fazer(); }}><Icon name={x.icone} size={16} />{x.rotulo}</button>)}
        </span>
      )}
    </span>
  );
}

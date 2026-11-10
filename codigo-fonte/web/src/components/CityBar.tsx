import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { proximoNivel, modoCidade, noMenuMais, type Indicador } from '../lib/barra.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';
import { useIdioma, useT } from '../i18n/index.ts';

/**
 * Barra de cima da Cidade, numa linha só e em pílulas iguais (mesma altura, raio, ícone e linha de base):
 * à esquerda o que se escolhe (estruturas), no meio o que se acompanha (indicadores), à direita as ferramentas.
 * Faltando espaço, adapta em degraus (lib/barra.ts) medindo antes de pintar: nada pisca, nada empilha.
 */
export function CityBar({ picker, pickKey, track, onTrack, isOn, editing, onEdit, calm, onCalm }: {
  picker: ReactNode; pickKey: string; track: Indicador[]; onTrack: (k: Indicador['key']) => void; isOn: (k: Indicador['key']) => boolean;
  editing: boolean; onEdit: () => void; calm: boolean; onCalm: () => void;
}) {
  // recolher é escolha da pessoa (vai com as preferências dela, não fica no navegador: na multiconta não passa de uma a outra)
  const t = useT();
  const idioma = useIdioma();
  const recolhida = usePrefs().cityBarCollapsed === true;
  const recolher = (v: boolean) => savePrefs({ cityBarCollapsed: v });
  const bar = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(0);
  // o degrau vale para esta largura e este conteúdo (inclusive o nome no Localizar); mudou qualquer um, recomeça do 0
  // e sobe até caber, antes de pintar
  const assinatura = `${largura}|${pickKey}|${track.map((t) => t.texto).join('|')}|${calm}|${editing}|${recolhida}|${idioma}`;
  const [fit, setFit] = useState({ assinatura: '', nivel: 0 });
  const nivel = fit.assinatura === assinatura ? fit.nivel : 0;
  const [mais, setMais] = useState(false);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setLargura(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [recolhida]); // recolhida troca o elemento da barra
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || recolhida) return;
    // a largura lida aqui mesmo (voltar para a Cidade, abrir a gaveta): o degrau certo já no primeiro quadro pintado
    const w = Math.round(el.clientWidth);
    if (w !== largura) { setLargura(w); return; }
    const grupos = [...el.querySelectorAll<HTMLElement>(':scope > .citybar__group')];
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const precisa = grupos.reduce((n, g) => n + g.getBoundingClientRect().width, 0) + gap * Math.max(0, grupos.length - 1);
    const prox = proximoNivel(nivel, precisa, el.clientWidth);
    if (prox !== nivel || fit.assinatura !== assinatura) setFit({ assinatura, nivel: prox });
  });
  useLayoutEffect(() => { if (nivel < 3) setMais(false); }, [nivel]);

  const modo = modoCidade(calm);
  if (recolhida) {
    return (
      <div ref={bar} className="citybar citybar--recolhida" role="group" aria-label={t('cidade.barra.aria')}>
        <span className="citybar__group citybar__tools">
          <button className="cb-pill cb-pill--icon" onClick={() => recolher(false)} title={t('cidade.barra.mostrar')} aria-label={t('cidade.barra.mostrar')}>
            <Icon name="chevron" size={16} />
          </button>
        </span>
      </div>
    );
  }
  const soIcone = nivel >= 1;
  const compacto = nivel >= 2;
  const noMenu = nivel >= 3;
  // último degrau (janela bem estreita): o indicador de menor prioridade (entregas) também vai para o "Mais"
  const [visiveis, extras] = noMenuMais(track, nivel);
  const ferramentas: Ferramenta[] = [
    { key: 'editar', icon: 'edit', label: t('cidade.barra.editar'), title: t('cidade.barra.editarDica'), on: editing, run: onEdit },
    { key: 'modo', icon: modo.icon, label: modo.label, title: modo.title, on: false, run: onCalm },
    { key: 'recolher', icon: 'chevron-up', label: t('cidade.barra.recolher'), title: t('cidade.barra.recolherDica'), on: false, run: () => recolher(true) },
  ];
  const doMenu: Ferramenta[] = [...extras.map((t) => ({ key: t.key, icon: t.icon, label: t.texto, title: t.title, on: isOn(t.key), run: () => onTrack(t.key) })), ...ferramentas];
  return (
    <div ref={bar} className={`citybar citybar--n${nivel}`} role="group" aria-label={t('cidade.barra.aria')}>
      <span className="citybar__group citybar__pick">{picker}</span>
      {visiveis.length > 0 && (
        <span className="citybar__group citybar__track" role="group" aria-label={t('cidade.barra.trabalho')}>
          {visiveis.map((t) => (
            <button key={t.key} className={`cb-pill ${t.atencao ? 'cb-pill--att' : ''} ${isOn(t.key) ? 'is-on' : ''}`} onClick={() => onTrack(t.key)}
              aria-pressed={t.key === 'voce' ? undefined : isOn(t.key)} title={compacto ? `${t.texto} · ${t.title}` : t.title} aria-label={compacto ? t.texto : undefined}>
              <Icon name={t.icon} size={16} /><span className="cb-pill__txt">{compacto ? t.curto : t.texto}</span>
            </button>
          ))}
        </span>
      )}
      <span className="citybar__group citybar__tools">
        {noMenu ? (
          <MaisMenu open={mais} onToggle={() => setMais((v) => !v)} onClose={() => setMais(false)} items={doMenu} />
        ) : ferramentas.map((f) => (
          <button key={f.key} className={`cb-pill ${soIcone ? 'cb-pill--icon' : ''} ${f.on ? 'is-on' : ''}`} onClick={f.run}
            aria-pressed={f.key === 'editar' ? f.on : undefined} title={f.title} aria-label={soIcone ? f.label : undefined}>
            <Icon name={f.icon} size={16} />{!soIcone && <span className="cb-pill__txt">{f.label}</span>}
          </button>
        ))}
      </span>
    </div>
  );
}

type Ferramenta = { key: string; icon: string; label: string; title: string; on: boolean; run: () => void };

/** Degrau 3: as ferramentas num menu (o nome de cada uma por extenso). */
function MaisMenu({ open, onToggle, onClose, items }: { open: boolean; onToggle: () => void; onClose: () => void; items: Ferramenta[] }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  useSurface(ref, { onClose, outside: true, active: open });
  return (
    <span className="citybar__more" ref={ref}>
      <button className={`cb-pill cb-pill--icon ${open ? 'is-on' : ''}`} onClick={onToggle} aria-haspopup="menu" aria-expanded={open} aria-label={t('cidade.barra.mais')} title={t('cidade.barra.maisDica')}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <span className="citybar__menu" role="menu" aria-label={t('cidade.barra.ferramentas')}>
          {items.map((f) => (
            <button key={f.key} role="menuitem" className={`citybar__mi ${f.on ? 'is-on' : ''}`} onClick={() => { onClose(); f.run(); }} title={f.title}>
              <Icon name={f.icon} size={16} /><span>{f.label}</span>{f.on && <Icon name="check" size={14} />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

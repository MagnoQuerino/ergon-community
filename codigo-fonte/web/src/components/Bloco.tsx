import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

/** Lembrar aberto/fechado neste navegador (some sem armazenamento: vale o padrão). */
const CHAVE = (id: string) => `ergon.bloco.${id}`;
function lerAberto(id: string, padrao: boolean): boolean {
  try { const v = localStorage.getItem(CHAVE(id)); return v === null ? padrao : v === '1'; } catch { return padrao; }
}
function gravarAberto(id: string, v: boolean) {
  try { localStorage.setItem(CHAVE(id), v ? '1' : '0'); } catch { /* sem armazenamento */ }
}

/**
 * Bloco recolhível: o cabeçalho (título e o resumo do estado, ex.: "Piper · transcrição base") fica sempre à vista; o
 * corpo abre e fecha com a altura deslizando (sem movimento para quem pede) e empurra os blocos de baixo. `topo` é o que
 * fica à vista mesmo fechado (o controle principal). `cartao`: o bloco é um cartão inteiro (senão, uma seção dentro de um).
 */
export function Bloco({ id, titulo, resumo, icone, topo, cartao = false, largo = false, abertoPadrao = false, className = '', children, ...resto }: {
  id: string; titulo: ReactNode; resumo?: ReactNode; icone?: string; topo?: ReactNode; cartao?: boolean; largo?: boolean; abertoPadrao?: boolean;
  className?: string; children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'>) {
  const [aberto, setAberto] = useState(() => lerAberto(id, abertoPadrao));
  // assentado: aberto e parado (o corpo deixa de cortar o que passa da borda, como o contorno de foco)
  const [assentado, setAssentado] = useState(aberto);
  const corpo = useId();
  const cab = useId();
  useEffect(() => {
    if (!aberto) { setAssentado(false); return; }
    const t = setTimeout(() => setAssentado(true), 320); // reserva, se o transitionend não vier
    return () => clearTimeout(t);
  }, [aberto]);
  const alternar = () => { const v = !aberto; setAberto(v); gravarAberto(id, v); };
  const H = cartao ? 'h3' : 'h4';
  return (
    <section {...resto} id={`bloco-${id}`} aria-labelledby={cab}
      className={`bloco ${cartao ? 'card bloco--cartao' : 'bloco--secao'} ${largo ? 'mosaico__largo' : ''} ${aberto ? 'bloco--aberto' : ''} ${className}`}>
      <H className="bloco__cab">
        <button type="button" id={cab} className="bloco__botao" aria-expanded={aberto} aria-controls={corpo} onClick={alternar}>
          <span className="bloco__seta" aria-hidden="true" />
          {icone && <Icon name={icone} size={cartao ? 16 : 14} />}
          <span className="bloco__titulo">{titulo}</span>
          {resumo != null && resumo !== '' && <span className="bloco__resumo">{resumo}</span>}
        </button>
      </H>
      {topo && <div className="bloco__topo">{topo}</div>}
      <div id={corpo} className={`bloco__corpo ${assentado ? 'bloco__corpo--solto' : ''}`} inert={!aberto}
        onTransitionEnd={(e) => { if (e.target === e.currentTarget && aberto) setAssentado(true); }}>
        <div className="bloco__dentro">{children}</div>
      </div>
    </section>
  );
}

/** Explicação longa: duas linhas à vista e "Ver mais" para o resto (o botão só aparece quando o texto passa disso). */
export function Sobre({ children, className = '' }: { children: ReactNode; className?: string }) {
  const t = useT();
  const ref = useRef<HTMLParagraphElement>(null);
  const [aberto, setAberto] = useState(false);
  const [corta, setCorta] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const medir = () => { if (!el.classList.contains('sobre--aberto')) setCorta(el.scrollHeight > el.clientHeight + 1); };
    medir();
    const ro = new ResizeObserver(medir); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={`sobre-caixa ${className}`}>
      <p ref={ref} className={`muted small sobre ${aberto ? 'sobre--aberto' : ''}`}>{children}</p>
      {(corta || aberto) && <button type="button" className="linkish small" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>{aberto ? t('geral.texto.recolher') : t('geral.bloco.verMais')}</button>}
    </div>
  );
}

/**
 * Mosaico: os cartões em colunas, sem buracos. Cada filho direto ocupa as linhas (de poucos px) da sua altura, e o
 * próximo cai na coluna mais curta, na ordem de leitura; ao abrir um bloco, só o que está abaixo dele na coluna desce.
 * Filho que não é cartão (avisos, abas, mensagens) ocupa a largura toda; `.mosaico__largo` também.
 */
export function Mosaico({ className = '', children, ...resto }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    el.dataset.mosaico = 'on';
    const ajustar = (filho: Element) => {
      if (!(filho instanceof HTMLElement) || filho.parentElement !== el) return;
      const cs = getComputedStyle(el);
      const linha = parseFloat(cs.gridAutoRows) || 4;
      const vao = parseFloat(cs.getPropertyValue('--mosaico-vao')) || 14;
      const h = filho.getBoundingClientRect().height;
      filho.style.gridRowEnd = h ? `span ${Math.max(1, Math.ceil((h + vao) / linha))}` : 'span 1';
    };
    const ro = new ResizeObserver((itens) => { for (const i of itens) ajustar(i.target); });
    const seguir = () => { for (const f of el.children) { ro.observe(f); ajustar(f); } };
    seguir();
    const mo = new MutationObserver(seguir);
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); delete el.dataset.mosaico; };
  }, []);
  return <div ref={ref} {...resto} className={`mosaico ${className}`}>{children}</div>;
}

/**
 * Sub-abas (controle segmentado): role tablist/tab, as setas e Home/End trocam a aba e levam o foco. O painel é do
 * chamador: `<div role="tabpanel" id={painelId} aria-labelledby={abaId(atual)}>`.
 */
export function SubAbas<K extends string>({ abas, atual, onTroca, rotulo, prefixo }: {
  abas: ReadonlyArray<{ id: K; rotulo: ReactNode; icone?: string }>; atual: K; onTroca: (k: K) => void; rotulo: string; prefixo: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tecla = (e: KeyboardEvent) => {
    const i = abas.findIndex((a) => a.id === atual);
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? abas.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const prox = abas[(n + abas.length) % abas.length];
    onTroca(prox.id);
    ref.current?.querySelector<HTMLButtonElement>(`#${prefixo}-aba-${prox.id}`)?.focus();
  };
  return (
    <div ref={ref} className="subabas" role="tablist" aria-label={rotulo} onKeyDown={tecla}>
      {abas.map((a) => (
        <button key={a.id} type="button" role="tab" id={`${prefixo}-aba-${a.id}`} aria-selected={a.id === atual} aria-controls={`${prefixo}-painel`}
          tabIndex={a.id === atual ? 0 : -1} className={`subabas__aba ${a.id === atual ? 'subabas__aba--on' : ''}`} onClick={() => onTroca(a.id)}>
          {a.icone && <Icon name={a.icone} size={14} />} {a.rotulo}
        </button>
      ))}
    </div>
  );
}

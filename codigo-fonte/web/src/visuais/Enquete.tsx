// A enquete do grupo: uma barra por opção com quem votou, o voto com um clique (vira uma mensagem ```ergon-voto, que
// anda pela mesma sincronia das mensagens) e a decisão em destaque — "Decisão: opção B · 4 de 5 votos".
import { useState, type CSSProperties } from 'react';
import type { BlocoDe } from '../../../shared/visuais/esquema.ts';
import { apurar } from '../../../shared/visuais/cercas.ts';
import { fmtValor } from '../../../shared/visuais/formato.ts';
import { idiomaAtual, useT } from '../i18n/index.ts';
import { Icon } from '../components/Icon.tsx';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { useVisuais, type VotoVisto } from './contexto.ts';

const iniciais = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
/** uma das cores da série, estável por pessoa (a mesma em toda enquete) */
const corDe = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 6, 0) + 1;

function Avatar({ v }: { v: Pick<VotoVisto, 'nome' | 'agente'> }) {
  if (v.agente) return <AgentAvatar agent={{ name: v.agente.name, color: v.agente.color, role: '', char_key: v.agente.char_key ?? null, look_seed: null }} size={22} />;
  return <span className={`vis-av vis-av--${corDe(v.nome)}`} title={v.nome} aria-hidden="true">{iniciais(v.nome)}</span>;
}

export function Enquete({ b }: { b: BlocoDe<'enquete'> }) {
  const t = useT();
  const ctx = useVisuais();
  const [enviando, setEnviando] = useState<number | null>(null);
  const [erro, setErro] = useState(false);
  const estaticos: VotoVisto[] = (b.votos ?? []).map((v) => ({ enquete: b.id, opcao: v.opcao, quem: `fixo:${v.quem}`, nome: v.quem }));
  const todos = [...estaticos, ...ctx.votos.filter((v) => v.enquete === b.id)];
  const { porOpcao, total } = apurar(todos, b.id, b.opcoes.length);
  const quem = new Map(todos.map((v) => [v.quem, v]));
  const eleitores = b.eleitores ?? ctx.eleitores ?? null;
  const meu = ctx.eu ? porOpcao.findIndex((xs) => xs.includes(ctx.eu!)) : -1;
  const max = Math.max(...porOpcao.map((x) => x.length));
  const lider = max > 0 && porOpcao.filter((x) => x.length === max).length === 1 ? porOpcao.findIndex((x) => x.length === max) : -1;
  const fechada = !!b.encerrada || b.decisao !== undefined || (eleitores !== null && total >= eleitores);
  const vencedora = b.decisao ?? (fechada ? lider : -1);
  const pode = !!ctx.votar && !b.encerrada && b.decisao === undefined;
  const votar = async (i: number) => {
    if (!ctx.votar || enviando !== null) return;
    setEnviando(i); setErro(false);
    try { await ctx.votar(b.id, i); } catch { setErro(true); } finally { setEnviando(null); }
  };
  return (
    <div className={`vis-enq ${fechada ? 'is-fechada' : ''}`}>
      <p className="vis-enq__p"><Icon name="flag" size={14} /> {b.pergunta}</p>
      <ul className="vis-enq__ops">
        {b.opcoes.map((o, i) => {
          const n = porOpcao[i].length; const fr = total ? n / total : 0;
          const conteudo = (
            <>
              <span className="vis-enq__barra vis-cresce" style={{ width: `${Math.max(fr * 100, n ? 4 : 0)}%`, '--i': i } as CSSProperties} aria-hidden="true" />
              <span className="vis-enq__o">{meu === i && <Icon name="check" size={13} />}{o}</span>
              <span className="vis-enq__avs" aria-hidden="true">{porOpcao[i].slice(0, 5).map((k) => <Avatar key={k} v={quem.get(k)!} />)}{n > 5 && <span className="vis-av vis-av--mais">+{n - 5}</span>}</span>
              <span className="vis-enq__n">{fmtValor(fr * 100, { formato: 'percentual', locale: idiomaAtual() })}<span className="sr-only">, {t('visuais.enquete.votos', { n })}</span></span>
            </>
          );
          return (
            <li key={i} className={`${vencedora === i ? 'is-vence' : ''} ${meu === i ? 'is-meu' : ''}`}>
              {pode ? <button type="button" className="vis-enq__op" onClick={() => void votar(i)} aria-pressed={meu === i} aria-busy={enviando === i} aria-label={t('visuais.enquete.votar', { opcao: o })}>{conteudo}</button>
                : <div className="vis-enq__op">{conteudo}</div>}
            </li>
          );
        })}
      </ul>
      <p className="vis-enq__pe" role="status">
        {vencedora >= 0 ? <span className="vis-enq__decisao"><Icon name="check" size={13} /> {t('visuais.enquete.decisao', { opcao: b.opcoes[vencedora], n: porOpcao[vencedora].length, total: eleitores ?? total })}</span>
          : <>{eleitores !== null ? t('visuais.enquete.deTotal', { n: total, total: eleitores }) : t('visuais.enquete.votos', { n: total })}{lider >= 0 && <> · {t('visuais.enquete.naFrente', { opcao: b.opcoes[lider] })}</>}</>}
        {erro && <span className="error">{t('visuais.enquete.naoVotou')}</span>}
      </p>
    </div>
  );
}

// Os blocos que são texto com estilo (métrica, tabela, comparativo, prazos, metas, listas, avisos, fichas, prévias…):
// HTML de verdade, que quebra linha, se lê em voz alta e se seleciona. Os gráficos ficam em Visual.tsx (cenas).
import { Fragment, useMemo, useState, type CSSProperties } from 'react';
import type { Bloco, BlocoDe, Celula, Coluna, DadosKpi, Tom } from '../../../shared/visuais/esquema.ts';
import { anel, sparkline } from '../../../shared/visuais/cena.ts';
import { fmtDataIso, fmtValor, fmtVariacao, tomDaVariacao } from '../../../shared/visuais/formato.ts';
import { idiomaAtual, useT } from '../i18n/index.ts';
import { Icon } from '../components/Icon.tsx';
import { CenaSvg } from './Cena.tsx';
import { Enquete } from './Enquete.tsx';
import { RelatorioCompacto } from './Relatorio.tsx';
import { Arquivo, Galeria, LinkPrevia, Mapa, Pessoa, Referencias } from './previas.tsx';

const loc = () => idiomaAtual();
const fv = (v: number | string | null | undefined, o: { formato?: Coluna['formato']; moeda?: Coluna['moeda']; unidade?: string; curto?: boolean } = {}) => fmtValor(v ?? null, { ...o, locale: loc() });
const pct = (v: number) => fmtValor(v * 100, { formato: 'percentual', locale: loc() });
const atraso = (i: number) => ({ '--i': i } as CSSProperties);

// ------------------------------------------------------------------------------------------------ métricas

function Variacao({ v, bom, comparacao }: { v: number; bom?: 'alta' | 'baixa'; comparacao?: string }) {
  const t = useT();
  const tom = tomDaVariacao(v, bom);
  return (
    <span className={`vis-var vis-var--${tom}`}>
      <span aria-hidden="true">{v > 0 ? '▲' : v < 0 ? '▼' : '•'}</span>
      <span className="sr-only">{v > 0 ? t('visuais.kpi.subiu') : v < 0 ? t('visuais.kpi.caiu') : ''}</span>
      {fmtVariacao(v, loc())}{comparacao && <span className="vis-var__c">{comparacao}</span>}
    </span>
  );
}

export function Kpi({ k, i = 0 }: { k: DadosKpi; i?: number }) {
  const t = useT();
  const fr = k.meta !== undefined ? k.valor / (k.meta || 1) : null;
  const spark = useMemo(() => (k.serie && k.serie.length > 1 ? sparkline(k.serie, 120, 32, k.bom ?? 'alta', '') : null), [k.serie, k.bom]);
  return (
    <div className="vis-kpi vis-in" style={atraso(i)}>
      <p className="vis-kpi__r">{k.rotulo}</p>
      <p className="vis-kpi__v">{fv(k.valor, { formato: k.formato, moeda: k.moeda, unidade: k.unidade })}</p>
      {k.variacao !== undefined && <Variacao v={k.variacao} bom={k.bom} comparacao={k.comparacao} />}
      {fr !== null && (
        <div className="vis-kpi__meta">
          <div className="vis-barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fr * 100)} aria-label={t('visuais.kpi.daMeta', { pct: pct(fr) })}>
            <span className={fr >= 1 ? 'is-bom' : ''} style={{ width: `${Math.min(100, Math.max(2, fr * 100))}%` }} />
          </div>
          <span>{t('visuais.kpi.meta', { valor: fv(k.meta!, { formato: k.formato, moeda: k.moeda, curto: true }) })} · {pct(fr)}</span>
        </div>
      )}
      {spark && <CenaSvg cena={spark} className="vis-kpi__spark" rotulo={t('visuais.kpi.serie', { n: k.serie!.length })} />}
    </div>
  );
}

function Nota({ b }: { b: BlocoDe<'nota'> }) {
  return (
    <div className="vis-nota">
      {b.titulo && <h4 className="vis-nota__t">{b.titulo}</h4>}
      {b.rotulo && <p className="vis-nota__r">{b.rotulo}</p>}
      <p className="vis-nota__v"><strong>{fv(b.valor)}<span>/{fv(b.escala ?? 10)}</span></strong>{b.legenda && <span className="vis-nota__l">{b.legenda}</span>}</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ tabela

const TOM_CLASSE: Record<Tom, string> = { bom: 'is-bom', ruim: 'is-ruim', atencao: 'is-atencao', neutro: 'is-neutro', marca: 'is-marca' };

function Tabela({ b, grande }: { b: BlocoDe<'tabela'>; grande: boolean }) {
  const t = useT();
  const [ord, setOrd] = useState<{ j: number; asc: boolean } | null>(null);
  const [todas, setTodas] = useState(false);
  const numerica = (j: number) => b.colunas[j].formato !== 'texto' && b.colunas[j].formato !== 'data' && b.linhas.some((l) => typeof l[j] === 'number');
  const linhas = useMemo(() => {
    const xs = b.linhas.map((l, i) => ({ l, i }));
    if (!ord) return xs;
    const cmp = (a: Celula, c: Celula) => (a === null ? 1 : c === null ? -1 : typeof a === 'number' && typeof c === 'number' ? a - c : String(a).localeCompare(String(c), loc(), { numeric: true }));
    return [...xs].sort((x, y) => (ord.asc ? 1 : -1) * cmp(x.l[ord.j], y.l[ord.j]));
  }, [b.linhas, ord]);
  const totais = useMemo<Celula[] | null>(() => {
    if (Array.isArray(b.totais)) return b.totais;
    if (!b.totais) return null;
    return b.colunas.map((_, j) => (j === 0 ? t('visuais.tabela.total') : numerica(j) && b.colunas[j].formato !== 'percentual' ? b.linhas.reduce((a, l) => a + (typeof l[j] === 'number' ? (l[j] as number) : 0), 0) : null));
  }, [b, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const cel = (x: Celula, j: number) => (typeof x === 'number' || b.colunas[j].formato === 'data' ? fv(x, { formato: b.colunas[j].formato, moeda: b.colunas[j].moeda }) : x ?? '—');
  const alinhar = (j: number) => (b.colunas[j].alinhar === 'direita' || (b.colunas[j].alinhar !== 'esquerda' && b.colunas[j].alinhar !== 'centro' && numerica(j)) ? 'is-dir' : b.colunas[j].alinhar === 'centro' ? 'is-centro' : '');
  const limite = grande ? 60 : 8;
  const vistas = todas ? linhas : linhas.slice(0, limite);
  const ordenavel = b.ordenavel !== false && b.linhas.length > 1;
  return (
    <div className="vis-tabela">
      <table>
        <thead>
          <tr>{b.colunas.map((c, j) => (
            <th key={j} scope="col" className={alinhar(j)} aria-sort={ord?.j === j ? (ord.asc ? 'ascending' : 'descending') : undefined}>
              {ordenavel ? <button type="button" onClick={() => setOrd((o) => (o?.j === j ? { j, asc: !o.asc } : { j, asc: !numerica(j) }))} title={t('visuais.tabela.ordenar', { coluna: c.titulo })}>
                {c.titulo}<Icon name={ord?.j === j ? (ord.asc ? 'chevron-up' : 'chevron') : 'list'} size={11} />
              </button> : c.titulo}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {vistas.map(({ l, i }, n) => (
            <tr key={i} className="vis-in" style={atraso(n)}>
              {l.map((x, j) => {
                const d = b.destaques?.find((z) => z.linha === i && z.coluna === j);
                const C = j === 0 ? 'th' : 'td';
                return <C key={j} scope={j === 0 ? 'row' : undefined} className={`${alinhar(j)} ${b.negrito?.includes(j) ? 'is-forte' : ''} ${d ? `vis-destaque ${TOM_CLASSE[d.tom]}` : ''}`}>{cel(x, j)}</C>;
              })}
            </tr>
          ))}
        </tbody>
        {totais && <tfoot><tr>{totais.map((x, j) => <td key={j} className={alinhar(j)}>{x === null ? '' : cel(x, j)}</td>)}</tr></tfoot>}
      </table>
      {linhas.length > limite && <button type="button" className="btn btn--sm btn--ghost vis-tabela__mais" onClick={() => setTodas((x) => !x)}>{todas ? t('visuais.tabela.menos') : t('visuais.tabela.mais', { n: linhas.length })}</button>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ comparar

function Comparativo({ b }: { b: BlocoDe<'comparativo'> }) {
  const t = useT();
  return (
    <div className="vis-comp" style={{ '--n': b.opcoes.length } as CSSProperties}>
      {b.opcoes.map((o, i) => (
        <section key={i} className={`vis-comp__op vis-in ${o.recomendada ? 'is-rec' : ''}`} style={atraso(i)}>
          <header>
            <h5>{o.nome}</h5>
            {o.recomendada && <span className="vis-selo vis-selo--bom"><Icon name="check" size={11} /> {t('visuais.comparativo.recomendada')}</span>}
          </header>
          {o.subtitulo && <p className="vis-comp__sub">{o.subtitulo}</p>}
          {o.valor !== undefined && <p className="vis-comp__v">{fv(o.valor, { formato: b.formato, moeda: b.moeda })}</p>}
          {!!o.pros?.length && <ul className="vis-comp__l vis-comp__l--pro" aria-label={t('visuais.comparativo.pros')}>{o.pros.map((x, k) => <li key={k}>{x}</li>)}</ul>}
          {!!o.contras?.length && <ul className="vis-comp__l vis-comp__l--contra" aria-label={t('visuais.comparativo.contras')}>{o.contras.map((x, k) => <li key={k}>{x}</li>)}</ul>}
        </section>
      ))}
    </div>
  );
}

function Versus({ b }: { b: BlocoDe<'versus'> }) {
  const tot = Math.abs(b.a.valor) + Math.abs(b.b.valor) || 1;
  const wa = (Math.abs(b.a.valor) / tot) * 100;
  const lado = (x: typeof b.a, k: 'a' | 'b') => (
    <div className={`vis-vs__lado ${b.melhor === k ? 'is-melhor' : ''}`}>
      <p className="vis-vs__r">{x.rotulo}</p>
      <p className="vis-vs__v">{fv(x.valor, { formato: b.formato, moeda: b.moeda })}</p>
      {x.legenda && <p className="vis-vs__l">{x.legenda}</p>}
    </div>
  );
  return (
    <div className="vis-vs">
      <div className="vis-vs__lados">{lado(b.a, 'a')}{lado(b.b, 'b')}</div>
      <div className="vis-vs__barra" aria-hidden="true">
        <span className={`vis-vs__a ${b.melhor === 'a' ? 'is-melhor' : ''}`} style={{ width: `${wa}%` }} />
        <span className={`vis-vs__b ${b.melhor === 'b' ? 'is-melhor' : ''}`} style={{ width: `${100 - wa}%` }} />
      </div>
      {b.pontas && <div className="vis-vs__pontas"><span>{b.pontas[0]}</span><span>{b.pontas[1]}</span></div>}
    </div>
  );
}

function Placar({ b }: { b: BlocoDe<'placar'> }) {
  const e = b.escala ?? 10;
  return (
    <ul className="vis-placar">
      {b.itens.map((x, i) => (
        <li key={i} className="vis-in" style={atraso(i)}>
          <span className="vis-placar__r">{x.rotulo}</span>
          <span className="vis-placar__n">{fv(x.nota)}/{fv(e)}</span>
          <span className="vis-barra vis-barra--fina" role="presentation"><span className="vis-cresce" style={{ width: `${(x.nota / e) * 100}%`, ...atraso(i) }} /></span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ prazos, metas, listas

const ICONE_MARCO = { feito: 'check', em_dia: 'clock', atrasado: 'alert', risco: 'alert', previsto: 'clock' } as const;
function LinhaDoTempo({ b }: { b: BlocoDe<'linha_do_tempo'> }) {
  const t = useT();
  const hoje = b.hoje;
  return (
    <ol className="vis-tempo">
      {b.marcos.map((m, i) => {
        const e = m.estado ?? 'previsto';
        const antesDeHoje = hoje && i > 0 && b.marcos[i - 1].data <= hoje && m.data > hoje;
        return (
          <Fragment key={i}>
          {antesDeHoje && <li className="vis-tempo__hoje" aria-label={t('visuais.tempo.hoje')}>{t('visuais.tempo.hoje')}</li>}
          <li className={`vis-tempo__m is-${e.replace('_', '-')} vis-in`} style={atraso(i)}>
            <span className="vis-tempo__ponto" aria-hidden="true"><Icon name={ICONE_MARCO[e]} size={11} /></span>
            <time dateTime={m.data}>{fmtDataIso(m.data, loc(), true)}</time>
            <div className="vis-tempo__c">
              <p className="vis-tempo__t">{m.titulo} <span className={`vis-selo vis-selo--${e.replace('_', '-')}`}>{t(`visuais.tempo.estado.${e}`)}</span></p>
              {m.detalhe && <p className="vis-tempo__d">{m.detalhe}</p>}
            </div>
          </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

function Progresso({ b }: { b: BlocoDe<'progresso'> }) {
  const t = useT();
  if (b.estilo === 'anel') {
    return (
      <div className="vis-aneis">
        {b.itens.map((x, i) => {
          const fr = x.atual / x.meta;
          return (
            <div key={i} className="vis-anel vis-in" style={atraso(i)}>
              <div className="vis-anel__g"><CenaSvg cena={anel(fr, 96, fr >= 1 ? 'bom' : 'v1')} rotulo={`${x.rotulo}: ${pct(fr)}`} /><span>{pct(fr)}</span></div>
              <p className="vis-anel__r">{x.rotulo}</p>
              <p className="vis-anel__d">{t('visuais.progresso.de', { atual: fv(x.atual, { formato: x.formato, moeda: x.moeda, curto: true }), meta: fv(x.meta, { formato: x.formato, moeda: x.moeda, curto: true }) })}</p>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <ul className="vis-prog">
      {b.itens.map((x, i) => {
        const fr = x.atual / x.meta;
        return (
          <li key={i} className="vis-in" style={atraso(i)}>
            <div className="vis-prog__l"><span className="vis-prog__r">{x.rotulo}</span><span className="vis-prog__d">{t('visuais.progresso.de', { atual: fv(x.atual, { formato: x.formato, moeda: x.moeda }), meta: fv(x.meta, { formato: x.formato, moeda: x.moeda }) })}{x.prazo && ` · ${t('visuais.progresso.ate', { data: fmtDataIso(x.prazo, loc(), true) })}`}</span></div>
            <div className="vis-barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fr * 100)} aria-label={`${x.rotulo}: ${pct(fr)}`}>
              <span className={`vis-cresce ${fr >= 1 ? 'is-bom' : ''}`} style={{ width: `${Math.min(100, Math.max(2, fr * 100))}%`, ...atraso(i) }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const ICONE_CHECK = { feito: 'check', andamento: 'clock', pendente: '', bloqueado: 'x' } as const;
function Checklist({ b }: { b: BlocoDe<'checklist'> }) {
  const t = useT();
  const feitos = b.itens.filter((x) => x.estado === 'feito').length;
  return (
    <div className="vis-check">
      <p className="vis-check__resumo">{t('visuais.checklist.feitos', { n: feitos, total: b.itens.length })}</p>
      <div className="vis-barra vis-barra--fina" aria-hidden="true"><span className="vis-cresce is-bom" style={{ width: `${(feitos / b.itens.length) * 100}%` }} /></div>
      <ul>
        {b.itens.map((x, i) => (
          <li key={i} className={`is-${x.estado} vis-in`} style={atraso(i)}>
            <span className="vis-check__c" aria-hidden="true">{ICONE_CHECK[x.estado] && <Icon name={ICONE_CHECK[x.estado]} size={11} />}</span>
            <span>{x.texto}</span><span className="sr-only">{t(`visuais.checklist.estado.${x.estado}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Status({ b }: { b: BlocoDe<'status'> }) {
  const t = useT();
  return (
    <ul className="vis-status">
      {b.itens.map((x, i) => (
        <li key={i} className="vis-in" style={atraso(i)}>
          <span className={`vis-ponto is-${x.estado}`} aria-hidden="true" />
          <span className="vis-status__r">{x.rotulo}</span>
          <span className={`vis-selo vis-selo--${x.estado}`}>{t(`visuais.status.estado.${x.estado}`)}</span>
          {x.detalhe && <span className="vis-status__d">{x.detalhe}</span>}
        </li>
      ))}
    </ul>
  );
}

function Semaforo({ b }: { b: BlocoDe<'semaforo'> }) {
  const t = useT();
  return (
    <ul className="vis-semaforo">
      {b.itens.map((x, i) => (
        <li key={i} className="vis-in" style={atraso(i)}>
          <span className="vis-semaforo__luzes" role="img" aria-label={t(`visuais.semaforo.cor.${x.cor}`)}>
            {(['vermelho', 'amarelo', 'verde'] as const).map((c) => <span key={c} className={`is-${c} ${x.cor === c ? 'is-on' : ''}`} />)}
          </span>
          <span className="vis-semaforo__t"><b>{x.rotulo}</b>{x.detalhe && <span>{x.detalhe}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

// i18n-ok: nomes de ícone
const ICONE_AVISO = { info: 'help', dica: 'bulb', alerta: 'alert', risco: 'shield', sucesso: 'check' } as const;
function Aviso({ b }: { b: BlocoDe<'aviso'> }) {
  const t = useT();
  return (
    <div className={`vis-aviso is-${b.tom}`} role={b.tom === 'risco' || b.tom === 'alerta' ? 'note' : undefined}>
      <span className="vis-aviso__i" aria-hidden="true"><Icon name={ICONE_AVISO[b.tom]} size={16} /></span>
      <div><p className="vis-aviso__tom">{b.titulo ?? t(`visuais.aviso.tom.${b.tom}`)}</p>{b.texto.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
    </div>
  );
}

function Decisao({ b }: { b: BlocoDe<'decisao'> }) {
  const t = useT();
  return (
    <div className="vis-decisao">
      <span className="vis-decisao__i" aria-hidden="true"><Icon name="check" size={18} /></span>
      <div>
        <p className="vis-decisao__t">{t('visuais.decisao.titulo')}: <strong>{b.escolha}</strong></p>
        {b.votos !== undefined && <p className="vis-decisao__v">{b.total ? t('visuais.decisao.votosDe', { n: b.votos, total: b.total }) : t('visuais.decisao.votos', { n: b.votos })}</p>}
        {b.porque && <p className="vis-decisao__p">{b.porque}</p>}
        {!!b.proximos?.length && <ul>{b.proximos.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      </div>
    </div>
  );
}

function Ficha({ b }: { b: BlocoDe<'ficha'> }) {
  const t = useT();
  const [cab0, cab1] = b.cabecalho ?? [t('visuais.ficha.parametro'), t('visuais.ficha.valor')];
  return (
    <div className={`vis-ficha ${b.imagem ? 'com-imagem' : ''}`}>
      {b.imagem && <div className="vis-ficha__img"><img src={srcDe(b.imagem.src)} alt={b.imagem.alt} loading="lazy" /></div>}
      <table className="vis-ficha__t">
        <thead><tr><th scope="col">{cab0}</th><th scope="col">{cab1}</th></tr></thead>
        <tbody>{b.linhas.map((x, i) => <tr key={i}><th scope="row">{x.parametro}</th><td className={x.destaque ? 'is-forte' : ''}>{x.valor}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** Imagem: do Documentos direto; de fora, sempre pelo servidor (sem o navegador ir ao site). */
export const srcDe = (src: string) => (src.startsWith('art_') ? `/api/artifacts/${encodeURIComponent(src)}/download?inline=1` : `/api/visuais/imagem?url=${encodeURIComponent(src)}`);

/** O corpo dos blocos de texto com estilo. */
export function CorpoHtml({ b, grande }: { b: Bloco; grande: boolean }) {
  switch (b.tipo) {
    case 'kpi': return <Kpi k={b} />;
    case 'kpis': return <div className="vis-kpis" style={{ '--n': b.itens.length } as CSSProperties}>{b.itens.map((k, i) => <Kpi key={i} k={k} i={i} />)}</div>;
    case 'nota': return <Nota b={b} />;
    case 'tabela': return <Tabela b={b} grande={grande} />;
    case 'comparativo': return <Comparativo b={b} />;
    case 'versus': return <Versus b={b} />;
    case 'placar': return <Placar b={b} />;
    case 'linha_do_tempo': return <LinhaDoTempo b={b} />;
    case 'progresso': return <Progresso b={b} />;
    case 'checklist': return <Checklist b={b} />;
    case 'status': return <Status b={b} />;
    case 'semaforo': return <Semaforo b={b} />;
    case 'aviso': return <Aviso b={b} />;
    case 'decisao': return <Decisao b={b} />;
    case 'ficha': return <Ficha b={b} />;
    case 'pessoa': return <Pessoa b={b} />;
    case 'galeria': return <Galeria b={b} />;
    case 'link': return <LinkPrevia b={b} />;
    case 'arquivo': return <Arquivo b={b} />;
    case 'mapa': return <Mapa b={b} />;
    case 'referencias': return <Referencias b={b} />;
    case 'enquete': return <Enquete b={b} />;
    case 'relatorio': return <RelatorioCompacto b={b} />;
    default: return null;
  }
}

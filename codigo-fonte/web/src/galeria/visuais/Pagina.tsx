// Galeria dos blocos visuais (só desenvolvimento): todos os blocos e as cenas dos prints — a conversa com a Hipátia, as
// perguntas rápidas à Aspásia, o relatório aberto por cima da conversa, uma sala com comparativo, prazos e enquete, e o
// que o Discord recebe (texto e PNG).
import { useMemo, useState, type ReactNode } from 'react';
import type { Bloco } from '../../../../shared/visuais/esquema.ts';
import { EXEMPLOS } from '../../../../shared/visuais/exemplos.ts';
import { votoDe } from '../../../../shared/visuais/cercas.ts';
import { visuaisComoTexto } from '../../../../shared/visuais/texto.ts';
import { ChatPanel } from '../../components/ChatPanel.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { AgentAvatar } from '../../components/AgentAvatar.tsx';
import { BlocoVisual } from '../../visuais/Visual.tsx';
import { ContextoVisuais, SEM_CONTEXTO, type VisuaisContexto, type VotoVisto } from '../../visuais/contexto.ts';
import { ASPASIA, HIPATIA, SALA } from './dados.ts';

const E = EXEMPLOS;
const GRUPOS: Array<[string, Bloco[]]> = [
  ['Referências do dono', [E.nota, E.ficha, E.versus, E.placar, E.fontes]],
  ['Métricas', [E.kpi, E.kpis, E.sparkline]],
  ['Gráficos', [E.barras, { ...E.barras, titulo: 'Gastos por categoria (horizontal)', horizontal: true, subtitulo: undefined }, E.linhas,
    { tipo: 'barras', titulo: 'Gastos por mês e categoria', categorias: ['ago', 'set', 'out', 'nov'], series: [{ nome: 'Folha', valores: [9600, 9600, 9800, 9800] }, { nome: 'Aluguel', valores: [4500, 4500, 4500, 4500] }, { nome: 'Software', valores: [1900, 1880, 1880, 1240] }], formato: 'moeda', empilhado: true, fontes: E.barras.fontes },
    { ...E.pizza, lado: undefined, titulo: 'Gastos por categoria', fatias: [{ rotulo: 'Folha', valor: 9800 }, { rotulo: 'Aluguel', valor: 4500 }, { rotulo: 'Impostos', valor: 1320 }, { rotulo: 'Software', valor: 1240 }, { rotulo: 'Outros', valor: 1560.5 }], formato: 'moeda', centro: undefined, fontes: E.barras.fontes }]],
  ['Mini visuais e infográficos', [E.pizza, E.medidor, { ...E.medidor, titulo: 'Satisfação (termômetro)', estilo: 'termometro', lado: { numero: '78%', rotulo: 'satisfeitos', linhas: ['Faixa boa a partir de 75%'] } }, E.icones,
    { tipo: 'icones', titulo: 'E-mails respondidos no prazo', valor: 6.5, total: 10, icone: 'email', rotulo: '6,5 de cada 10 e-mails respondidos em até 4 h', fontes: E.pizza.fontes },
    { tipo: 'icones', titulo: 'Caixa do mês', valor: 4, total: 5, icone: 'moeda', rotulo: '4 de 5 metas de caixa batidas', estimativa: true },
    { tipo: 'icones', titulo: 'Prazo do projeto', valor: 3, total: 8, icone: 'ampulheta', rotulo: '3 de 8 semanas usadas', fontes: E.linha_do_tempo.fontes },
    { tipo: 'icones', titulo: 'Avaliação média', valor: 4.3, total: 5, icone: 'estrela', rotulo: '4,3 de 5 estrelas', fontes: E.medidor.fontes },
    { tipo: 'icones', titulo: 'Clientes satisfeitos', valor: 8, total: 10, icone: 'carinha', rotulo: '8 de 10 clientes satisfeitos', fontes: E.medidor.fontes },
    { tipo: 'icones', titulo: 'Pedidos entregues', valor: 9, total: 12, icone: 'caixa', rotulo: '9 de 12 pedidos entregues hoje', fontes: [{ tipo: 'conexao', titulo: 'Bling · pedidos', periodo: 'hoje' }] },
    { tipo: 'icones', titulo: 'Dias úteis', valor: 14, total: 20, icone: 'calendario', rotulo: '14 de 20 dias úteis de novembro já passaram', estimativa: true },
    { tipo: 'icones', titulo: 'Setores com meta', valor: 3, total: 4, icone: 'predio', rotulo: '3 de 4 setores bateram a meta', fontes: E.progresso.fontes },
    E.semaforo, E.funil, E.calor, E.matriz]],
  ['Decidir em grupo', [E.enquete, E.decisao, E.comparativo]],
  ['Tabelas e fichas', [E.tabela]],
  ['Prazos, metas e listas', [E.linha_do_tempo, E.progresso, { ...E.progresso, titulo: 'Metas (anel)', estilo: 'anel' }, E.checklist, E.status]],
  ['Avisos', [E.aviso, { tipo: 'aviso', tom: 'dica', texto: 'Pagando o DAS pelo Pix hoje, a guia já sai com a multa calculada.' }, { tipo: 'aviso', tom: 'sucesso', texto: 'Nota fiscal reemitida e enviada à Acelen.' }]],
  ['Pré-visualizações', [E.pessoa, E.link, E.arquivo, E.galeria, E.mapa, E.referencias]],
  ['Relatório', [E.relatorio]],
];

/** Galeria: todos os blocos, em grupos, com o contexto de uma conversa (votar e revisar funcionam na hora). */
function Galeria() {
  const [votos, setVotos] = useState<VotoVisto[]>([]);
  const ctx = useMemo<VisuaisContexto>(() => ({ ...SEM_CONTEXTO, votos, eu: 'eu', votar: async (enquete, opcao) => { setVotos((x) => [...x, { enquete, opcao, quem: 'eu', nome: 'Você' }]); } }), [votos]);
  return (
    <ContextoVisuais.Provider value={ctx}>
      <div className="gv">
        <header className="gv__cab"><h1>Blocos visuais</h1><p>O catálogo que os agentes usam na conversa, nas salas e nas entregas.</p></header>
        {GRUPOS.map(([nome, blocos]) => (
          <section key={nome} className="gv__grupo" data-grupo={nome}>
            <h2>{nome}</h2>
            <div className="gv__grade">{blocos.map((b, i) => <div key={i} className="gv__item md" data-tipo={b.tipo}><BlocoVisual b={b} /></div>)}</div>
          </section>
        ))}
      </div>
    </ContextoVisuais.Provider>
  );
}

function Conversa({ agente, conversa }: { agente: typeof HIPATIA; conversa: string }) {
  return <div className="gv-chat"><ChatPanel agent={agente} embedded hidePicker conversationId={conversa} /></div>;
}

const iniciais = (n: string) => n.split(' ').map((p) => p[0]).slice(0, 2).join('');
/** A sala (como a tela das Salas: autor em cada mensagem, a enquete com os votos de todos). */
function Sala() {
  const [meus, setMeus] = useState<VotoVisto[]>([]);
  const votos = useMemo<VotoVisto[]>(() => [...SALA.mensagens.flatMap((m) => { const x = votoDe(m.texto); return x ? [{ ...x, quem: m.quem, nome: m.quem, ...(m.papel === 'agente' ? { agente: { name: m.quem, color: ASPASIA.color, char_key: 'aspasia' } } : {}) }] : []; }), ...meus], [meus]);
  const ctx = useMemo<VisuaisContexto>(() => ({ ...SEM_CONTEXTO, votos, eu: 'Ana Ribeiro', eleitores: 5, votar: async (enquete, opcao) => { setMeus((x) => [...x, { enquete, opcao, quem: 'Ana Ribeiro', nome: 'Ana Ribeiro' }]); } }), [votos]);
  const autoVoto = new URLSearchParams(location.search).get('votado') === '1';
  if (autoVoto && !meus.length) queueMicrotask(() => setMeus([{ enquete: 'enq-crm', opcao: 1, quem: 'Ana Ribeiro', nome: 'Ana Ribeiro' }]));
  const agente = (nome: string) => (nome === 'Aspásia' ? ASPASIA : { ...HIPATIA, id: 'ag-ari', name: 'Aristóteles', color: '#1F5B6B', char_key: 'aristoteles' });
  return (
    <ContextoVisuais.Provider value={ctx}>
      <div className="gv-sala">
        <header className="gv-sala__cab">
          <span className="gv-sala__hash">#</span><h2>{SALA.nome}</h2>
          <span className="gv-sala__membros">{SALA.membros.map((m) => (m === 'Aristóteles' || m === 'Aspásia' ? <AgentAvatar key={m} agent={agente(m)} size={26} /> : <span key={m} className="vis-av vis-av--3" title={m}>{iniciais(m)}</span>))}</span>
        </header>
        <div className="gv-sala__msgs">
          {SALA.mensagens.filter((m) => !votoDe(m.texto)).map((m, i) => (
            <div key={i} className={`gv-sala__m ${m.quem === 'Ana Ribeiro' ? 'is-eu' : ''}`}>
              {m.papel === 'agente' ? <AgentAvatar agent={agente(m.quem)} size={34} /> : <span className="vis-av vis-av--3 gv-sala__av">{iniciais(m.quem)}</span>}
              <div className="gv-sala__c">
                <p className="gv-sala__quem"><b>{m.quem}</b>{m.papel === 'agente' && <span className="badge">agente</span>}<time>{`14:${String(10 + Math.floor(m.min) - 30).padStart(2, '0')}`}</time></p>
                <div className="msg__body"><Markdown text={m.texto} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ContextoVisuais.Provider>
  );
}

/** O que chega no Discord: o texto (os números e a fonte) e o PNG de cada bloco, gerado no servidor. */
function Discord() {
  const msg = `Fechei até o dia 20: **R$ 18,4 mil**, 8,2% abaixo de outubro.\n\n\`\`\`ergon-visual\n${JSON.stringify(EXEMPLOS.barras)}\n\`\`\`\n\n\`\`\`ergon-visual\n${JSON.stringify(EXEMPLOS.kpi)}\n\`\`\``;
  const texto = `**Hipátia:** ${visuaisComoTexto(msg)}`;
  const linha = (l: string, i: number): ReactNode => <p key={i}>{l.split(/(\*\*[^*]+\*\*|_[^_]+_)/).map((p, j) => (p.startsWith('**') ? <b key={j}>{p.slice(2, -2)}</b> : p.startsWith('_') && p.endsWith('_') ? <i key={j}>{p.slice(1, -1)}</i> : p))}</p>;
  return (
    <div className="gv-dc">
      <aside className="gv-dc__lado"><p className="gv-dc__srv">Mensagens diretas</p><p className="gv-dc__dm is-on"><span className="gv-dc__bot">E</span> Ergon da Ana</p></aside>
      <main className="gv-dc__main">
        <header className="gv-dc__cab">@ Ergon da Ana</header>
        <div className="gv-dc__msgs">
          <div className="gv-dc__m"><span className="gv-dc__av gv-dc__av--eu">A</span><div><p className="gv-dc__n">ana.ribeiro <time>hoje às 10:41</time></p><p>como ficaram os gastos de novembro?</p></div></div>
          <div className="gv-dc__m"><span className="gv-dc__av">E</span><div><p className="gv-dc__n">Ergon da Ana <span className="gv-dc__tag">APP</span> <time>hoje às 10:42</time></p><div className="gv-dc__txt">{texto.split('\n').map(linha)}</div></div></div>
          <div className="gv-dc__m gv-dc__m--cont"><span /><div><p className="gv-dc__txt">Gastos por categoria</p><img className="gv-dc__img" src="/__png/barras.png" alt="Gastos por categoria" /></div></div>
          <div className="gv-dc__m gv-dc__m--cont"><span /><div><img className="gv-dc__img" src="/__png/kpi.png" alt="Gastos de novembro" /></div></div>
        </div>
      </main>
    </div>
  );
}

export function Pagina({ cena }: { cena: string }) {
  switch (cena) {
    case 'hipatia': return <Conversa agente={HIPATIA} conversa="c-hipatia" />;
    case 'aspasia': return <Conversa agente={ASPASIA} conversa="c-aspasia" />;
    case 'relatorio': return <Conversa agente={HIPATIA} conversa="c-relatorio" />;
    case 'sala': return <Sala />;
    case 'discord': return <Discord />;
    default: return <Galeria />;
  }
}

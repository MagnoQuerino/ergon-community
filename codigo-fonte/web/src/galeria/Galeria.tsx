import { useEffect, type ReactNode } from 'react';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { DecisionsPanel } from '../components/DecisionsPanel.tsx';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { BotoesPrazo, BotoesRegra } from '../components/CartaoRegra.tsx';
import { Selo } from '../components/Selo.tsx';
import { ACAO, FILEIRA } from '../lib/cartoes-acoes.ts';
import { AGENTE, CARDS } from './simular.ts';

type Largura = 'larga' | '380';
const nada = () => { /* a galeria não navega */ };

/** Uma superfície do app (conversa, painel, card) nas larguras pedidas; a de 380 px é a gaveta estreita. */
function Secao({ id, titulo, larguras, chat, children }: { id: string; titulo: string; larguras: Largura[]; chat?: boolean; children: () => ReactNode }) {
  return (
    <section className="gal__sec" data-gal={id}>
      <h2>{titulo}</h2>
      <div className="gal__cols">
        {larguras.map((l) => (
          <div key={l} className={`gal__col gal__col--${l}`} data-largura={l}>
            <h3>{l === '380' ? '380 px' : '600 px'}</h3>
            <div className={`gal__miolo ${chat ? 'gal__miolo--chat' : ''}`}>{children()}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

const Peca = ({ nome, children }: { nome: string; children: ReactNode }) => <div className="gal__peca" data-peca={nome}><h4>{nome}</h4><div className="dec-card">{children}</div></div>;

export function Galeria({ larguras }: { larguras: Largura[] }) {
  // a medição espera os cartões desenhados (os dados de exemplo chegam num instante)
  useEffect(() => { const h = window.setTimeout(() => { if (window.__galeria) window.__galeria.pronta = true; }, 600); return () => window.clearTimeout(h); }, []);
  return (
    <main className="gal">
      <h1>Galeria dos cartões</h1>
      <p className="gal__nota">Só para desenvolvimento. Cartões de verdade com dados de exemplo; nada é enviado. Medição: scripts/telas/cartoes-medidos.mjs.</p>
      <Secao id="conversa" titulo="Na conversa" larguras={larguras} chat>{() => <ChatPanel agent={AGENTE} embedded hidePicker conversationId="c1" />}</Secao>
      <Secao id="aguardando" titulo="Aguardando você" larguras={larguras}>{() => <DecisionsPanel inline />}</Secao>
      {Object.keys(CARDS).map((id) => (
        <Secao key={id} id={`card-${id}`} titulo={`No card (${id})`} larguras={larguras}>{() => <TaskDetail taskId={id} mode="team" onClose={nada} />}</Secao>
      ))}
      <Secao id="pecas" titulo="Peças soltas e estados" larguras={larguras}>{() => (
        <div className="gal__pecas">
          <Peca nome="prazo (recolhido: principal + seletor + Recusar)"><BotoesPrazo onEscolher={nada} onRecusar={nada} /></Peca>
          <Peca nome="prazo, enviando"><BotoesPrazo ocupado onEscolher={nada} onRecusar={nada} /></Peca>
          <Peca nome="prazo, recusando"><BotoesPrazo ocupado="recusar" onEscolher={nada} onRecusar={nada} /></Peca>
          <Peca nome="regra, sugerido: só neste pedido"><BotoesRegra sugerido="pedido" onEscolher={nada} onRecusar={nada} /></Peca>
          <Peca nome="regra, sugerido: sempre, enviando"><BotoesRegra sugerido="sempre" ocupado onEscolher={nada} onRecusar={nada} /></Peca>
          <Peca nome="níveis: principal, secundário, leve">
            <div className={FILEIRA}><button className={ACAO.principal}>Aprovar</button><button className={ACAO.secundario}>Recusar</button><button className={`${ACAO.leve} card-acts__fim`}>abrir o card #92</button></div>
          </Peca>
          <Peca nome="níveis, enviando (ativo, aria-busy)">
            <div className={FILEIRA}><button className={ACAO.principal} aria-busy>Enviando…</button><button className={ACAO.secundario} aria-busy>Recusando…</button></div>
          </Peca>
          <Peca nome="perigoso, com a confirmação">
            <div className="ask-box ask-box--danger"><p className="ask-box__q"><b>Apagar o card #81?</b> Ele sai do quadro.</p>
              <div className={FILEIRA}><button className={ACAO.perigoso}>Apagar</button><button className={ACAO.secundario}>Voltar</button></div></div>
          </Peca>
          <Peca nome="opções de pergunta (a sugerida com selo)">
            <div className="question-card"><span className="question-card__q">Em que formato?</span>
              <div className="question-card__opts"><button className={ACAO.opcao}>Planilha<Selo icone="bulb">sugerida</Selo></button><button className={ACAO.opcao}>Documento</button></div></div>
          </Peca>
          <Peca nome="selos e estados">
            <div className={FILEIRA}><Selo icone="check" tom="ok">Aplicada</Selo><Selo icone="bell" tom="warn">Com você</Selo><Selo icone="clock">Em andamento</Selo><Selo icone="alert" tom="err">Não deu certo</Selo><Selo icone="x">Recusada</Selo></div>
          </Peca>
        </div>
      )}</Secao>
    </main>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import { coordinatorOf, reviewerOf } from '../lib/team.ts';
import type { AppState, View } from '../lib/types.ts';
import { Icon } from '../components/Icon.tsx';

/**
 * Ajuda: manuais curtos de como fazer as coisas, mais "problemas comuns e como contornar". A coordenação também
 * ajuda na conversa, mas é bom ter uma referência. Os textos usam os nomes de quem coordena e de quem revisa hoje
 * (a equipe pode ter sido renomeada ou trocada por outro tema).
 */
/** coord e reviewer: quem faz hoje; ex: nomes reais de colegas para os exemplos de frases */
interface Ctx { coord: string; reviewer: string; ex: [string, string, string]; go: (v: View, hash?: string) => void }
interface Article { id: string; title: string; icon: string; keywords: string; body: (c: Ctx) => ReactNode }

const Go = ({ c, v, hash, children }: { c: Ctx; v: View; hash?: string; children: ReactNode }) => <button className="link" onClick={() => c.go(v, hash)}>{children}</button>;

const ARTICLES: Article[] = [
  { id: 'inicio', title: 'Primeiros passos', icon: 'compass', keywords: 'começar início tour equipe tarefas primeiros passos',
    body: (c) => <>
      <p>O Ergon é uma equipe de agentes de IA organizada como uma cidade: cada agente tem uma função, um setor, instruções e ferramentas. Você conversa, eles trabalham, e nada importante acontece sem a sua aprovação.</p>
      <ol>
        <li><b>Conecte a assinatura Nous</b> em <Go c={c} v="conexoes">Conexões › Contas de IA</Go> — a melhor escolha: os principais modelos numa conta só, inclusive gratuitos, e um modelo para cada agente. Sem conta de IA, as respostas são simuladas (o chip <i>SIMULAÇÃO</i> aparece no topo).</li>
        <li><b>Converse com {c.coord}</b>, que coordena: conte o que você precisa e o pedido vai para quem faz.</li>
        <li><b>Ative o Briefing Diário</b> em <Go c={c} v="rotinas">Rotinas</Go>: todo dia, um resumo do que importa.</li>
        <li><b>Ajuste a equipe</b> ao seu jeito (veja “Personalizar a equipe”).</li>
      </ol>
      <p>Os primeiros passos também ficam em <Go c={c} v="tarefas">Tarefas</Go>, para você ir marcando.</p>
    </> },
  { id: 'conversar', title: 'Conversar com a equipe', icon: 'chat', keywords: 'conversa chat mensagem pedido encaminhar demanda card proposta aplicar',
    body: (c) => <>
      <p>Clique em qualquer agente (na cidade ou em <Go c={c} v="agentes">Agentes</Go>) para abrir a conversa. Cada agente responde dentro da própria função.</p>
      <ul>
        <li><b>{c.coord}</b> recebe pedidos gerais e diz quem deve fazer (“Encaminhar para: …”). Demandas claras viram card no quadro da equipe.</li>
        <li>Quando a coordenação sugere uma mudança (mover alguém de setor, dar uma ferramenta, criar uma rotina), aparece um <b>cartão com Aplicar e Recusar</b>. Nada muda antes do seu clique. Com várias propostas, dá para <b>aplicar todas</b> de uma vez.</li>
        <li>Às vezes um agente pergunta algo com opções: escolha uma e ele segue.</li>
        <li>Atalhos: <code>/tarefa título</code> cria um card; <code>/pendencias</code> lista o que está aberto.</li>
      </ul>
    </> },
  { id: 'personalizar', title: 'Personalizar a equipe', icon: 'users', keywords: 'renomear nome função papel setor ferramenta instruções métodos bio história desativar reativar criar agente coordenação revisão tema',
    body: (c) => <>
      <p>A equipe que você recebeu é só o ponto de partida. Fora o Coordenador, <b>tudo pode mudar</b> — e você tem quantos agentes quiser: sem vaga, a cidade cresce sozinha. O Ergon continua funcionando porque segue a <b>função</b> de cada agente, não o nome.</p>
      <h4>Pela conversa com {c.coord}</h4>
      <ul>
        <li>“Renomeie {c.ex[0]} para Ana.”</li>
        <li>“Mude a função de {c.ex[1]} para roteirista de vídeos, com foco em YouTube.”</li>
        <li>“Mova {c.ex[2]} para o setor de produção.” · “Dê pesquisa na web para {c.ex[0]}.”</li>
        <li>“Crie um agente chamado Bruno para cuidar do financeiro.” · “Crie um setor de Vendas.”</li>
        <li>“Desative {c.ex[2]}.” · “Traga {c.ex[2]} de volta.”</li>
        <li>“Transforme a equipe num tema de faroeste, com nomes e histórias novas.”</li>
      </ul>
      <p>Cada pedido vira um cartão para você aplicar. Dá para pedir várias mudanças numa frase só.</p>
      <h4>No perfil do agente</h4>
      <p>Em <Go c={c} v="agentes">Agentes</Go>, abra um agente › <b>Perfil</b>: nome, função, setor, construção, modelo de IA, instruções, métodos, ferramentas e história (bio). “Escrever com a coordenação” redige as instruções a partir da função.</p>
      <h4>Funções especiais (são ferramentas, não nomes)</h4>
      <ul>
        <li><b>O Coordenador ({c.coord}) é o único cargo fixo.</b> Ele está sempre na equipe, recebe os pedidos e encaminha — essa função, o setor dele e as ferramentas de coordenação não mudam. Nome, aparência, história e foco mudam à vontade (num tema, ele pode virar Gandalf).</li>
        <li><b>Revisão crítica</b> é de quem tem “Revisão socrática” (hoje: {c.reviewer}). Sem ninguém com ela, o botão de revisão explica o que fazer.</li>
      </ul>
      <p>Mudou de ideia sobre o perfil inteiro? Use <b>Refazer a equipe de partida</b>, no alto desta página.</p>
    </> },
  { id: 'rotinas', title: 'Rotinas', icon: 'repeat', keywords: 'rotina briefing agendar horário recomendação histórico executar',
    body: (c) => <>
      <p>Rotinas são trabalhos que se repetem sozinhos: briefing diário, supervisão de projetos e outros da <Go c={c} v="rotinas">Biblioteca</Go>.</p>
      <ul>
        <li><b>Ativar</b> não pede configuração: {c.coord} estuda o seu jeito de trabalhar, adapta horário, foco e formato e já roda a primeira vez. Se tiver dúvida, pergunta com opções.</li>
        <li><b>Minhas rotinas</b>: pausar, executar agora, mudar o horário ou pedir ajustes à coordenação.</li>
        <li><b>Histórico</b>: cada execução com o resultado e os dados que o Ergon coletou.</li>
        <li><b>Criar rotina com {c.coord}</b>: descreva o que você quer que aconteça sozinho; a prévia aparece para você aprovar.</li>
        <li>Com a <b>recomendação inteligente</b> ligada, sugestões chegam em “aguardando você”; recusar ensina o que não sugerir.</li>
      </ul>
    </> },
  { id: 'tarefas', title: 'Tarefas e Fluxos da equipe', icon: 'tasks', keywords: 'tarefa card quadro fluxo equipe enviar revisão andamento automático fila',
    body: (c) => <>
      <ul>
        <li><Go c={c} v="tarefas">Tarefas</Go> são as suas. Abra uma e use <b>Enviar à equipe</b> quando quiser ajuda (o prazo vai junto).</li>
        <li><b>Prazo</b>: escolha no card ou escreva no pedido (“até sexta”, “até amanhã”, “até 30/10”) — o card já nasce com ele. Atrasadas ficam em vermelho; as de hoje, em dourado. Nos quadros espelhados, o prazo vem do aplicativo.</li>
        <li><b>Quadro ou Lista</b>: a mesma coisa em dois formatos. A lista é uma tabela agrupada pelas mesmas colunas, com situação, responsável, prazo e andamento; clique no cabeçalho para ordenar (por prazo, por exemplo).</li>
        <li><Go c={c} v="equipe">Fluxos da equipe</Go> é o quadro dos agentes: cada card tem responsável e histórico do que foi feito.</li>
        <li>Num card da equipe, peça <b>revisão crítica</b>: {c.reviewer} faz perguntas ao autor, em poucas rodadas, até um veredito.</li>
        <li>O <b>andamento automático</b> vem ligado: a equipe pega as tarefas de “A fazer” sozinha, de cima para baixo, até o limite de trabalhos ao mesmo tempo. Desligue em <Go c={c} v="configuracao">Configurações</Go> se preferir que só trabalhem quando você conversa.</li>
      </ul>
    </> },
  { id: 'decisoes', title: 'Aguardando você', icon: 'bulb', keywords: 'decisão aprovar aguardando proposta pergunta permissão recomendação reconsiderar',
    body: () => <>
      <p>O chip <b>aguardando você</b>, no topo, junta tudo que precisa da sua decisão: propostas da equipe, perguntas, permissões de ferramenta, sugestões de rotina, vínculos de tarefas e regras.</p>
      <p>Recusou algo e se arrependeu? Peça à coordenação (“aquela rotina que recusei ontem”) ou reconsidere pelo próprio painel.</p>
    </> },
  { id: 'conexoes', title: 'Conexões', icon: 'plug', keywords: 'conectar conta ia chatgpt whatsapp microsoft google teams email quadros',
    body: (c) => <>
      <ul>
        <li><b>Contas de IA</b>: a <b>assinatura Nous é a melhor escolha</b> — os principais modelos do mercado numa assinatura só (há plano grátis com modelos gratuitos) e cada agente com o modelo certo, do mais forte ao mais econômico. Quem já paga o ChatGPT pode conectar também: a equipe aproveita a assinatura, sem custo por token, e cada agente usa o modelo que você escolher entre as duas contas.</li>
        <li><b>WhatsApp, Microsoft 365 e Google</b>: o Ergon lê o que chega e prepara rascunhos. Nada é enviado sem a sua aprovação.</li>
        <li><b>Tarefas e quadros</b>: espelhe quadros de outros aplicativos (somente leitura).</li>
      </ul>
      <p>Tudo em <Go c={c} v="conexoes">Conexões</Go>. Conteúdo de mensagens e documentos é tratado como dado, nunca como instrução.</p>
    </> },
  { id: 'cidade', title: 'A cidade (Ambiente)', icon: 'temple', keywords: 'cidade ambiente construção prédio andar vaga loja mover',
    body: (c) => <>
      <p>Em <Go c={c} v="ambiente">Ambiente</Go> você vê a equipe trabalhando. Cada construção tem andares e vagas; quem está executando algo aparece em movimento.</p>
      <ul>
        <li>Clique num agente para conversar; clique numa construção para ver quem está lá.</li>
        <li>Novas construções e andares aumentam a capacidade da equipe.</li>
        <li>A estante abre os arquivos entregues (em Atividade › Arquivos).</li>
      </ul>
    </> },
  { id: 'seguranca', title: 'Segurança e privacidade', icon: 'shield', keywords: 'senha frase recuperação trava inatividade autenticador passkey cifrado backup',
    body: (c) => <>
      <ul>
        <li>Os dados ficam <b>cifrados</b> neste computador, com a sua senha.</li>
        <li>A <b>frase de recuperação</b> (24 palavras) é a única saída se você esquecer a senha. Guarde fora do computador.</li>
        <li><b>Trava por inatividade</b>: desligada por padrão. Ligue e escolha o tempo em <Go c={c} v="configuracao" hash="configuracao?seguranca">Configurações › Segurança</Go>.</li>
        <li><b>Verificação em duas etapas</b>: autenticador ou passkey, no mesmo lugar. O código do autenticador é pedido só ao entrar; para destrancar a tela basta a senha ou a passkey.</li>
        <li>Ferramentas que executam código ficam bloqueadas e pedem a sua senha para liberar.</li>
      </ul>
    </> },
  { id: 'temas', title: 'Temas e personagens', icon: 'palette', keywords: 'tema skin mod personagem nome bio grécia senhor dos anéis gandalf comunidade',
    body: (c) => <>
      <p>A Grécia clássica é o tema de partida. <b>O Ergon é a forma; o conteúdo é seu.</b> Hoje você já pode trocar nomes, funções, histórias e setores de toda a equipe, pedindo a {c.coord} algo como “transforme a equipe num tema do Senhor dos Anéis, com Gandalf coordenando”.</p>
      <p>Nada quebra com outro tema: coordenação, revisão, encaminhamento de demandas e rotinas seguem a função de cada agente, não o nome.</p>
      <p>Quer desfazer um tema? Em <Go c={c} v="agentes">Agentes</Go>, “Voltar aos nomes e histórias gregos” devolve o nome e a história originais de cada personagem (funções e instruções ficam).</p>
      <p className="muted">No roteiro: temas completos da comunidade, com paleta de cores, desenho das construções, nomes e histórias dos personagens.</p>
    </> },
];

const PROBLEMS: Array<{ q: string; a: (c: Ctx) => ReactNode; keywords: string }> = [
  { q: 'As respostas parecem genéricas ou aparece “SIMULAÇÃO”', keywords: 'simulação genérica conta ia',
    a: (c) => <>Nenhuma conta de IA está conectada: as respostas são simuladas. Conecte a assinatura Nous (a melhor escolha) em <Go c={c} v="conexoes">Conexões › Contas de IA</Go>.</> },
  { q: 'Um agente ficou “executando” e não responde', keywords: 'travado executando fila parado cancelar',
    a: () => <>Há um limite de execuções ao mesmo tempo, e o resto espera na fila. Na conversa, use <b>Cancelar</b> e envie de novo. Se continuar, veja em Atividade o que aconteceu.</> },
  { q: 'A demanda foi para a pessoa errada', keywords: 'encaminhou errado responsável trocar',
    a: (c) => <>Troque o responsável no card. Para acertar das próximas vezes, deixe claras a função e os métodos de quem deveria receber: o encaminhamento compara as palavras do pedido com eles. Ou diga a {c.coord} quem cuida de quê.</> },
  { q: 'A revisão crítica não começa', keywords: 'revisão não começa erro revisor',
    a: () => <>Três motivos comuns: ninguém tem a ferramenta “Revisão socrática” (dê a alguém no perfil); a tarefa não tem responsável; ou não há material (peça um resultado ou descreva a entrega no card).</> },
  { q: 'Desativei alguém sem querer', keywords: 'desativado reativar sumiu agente',
    a: (c) => <>Em <Go c={c} v="agentes">Agentes</Go>, abra “Desativados”, escolha o agente e reative. Ou peça a {c.coord}: “traga o X de volta”.</> },
  { q: 'Uma proposta falhou ao aplicar', keywords: 'proposta falhou não encontrei',
    a: (c) => <>Geralmente o nome do agente ou do setor não bate (renomeado, por exemplo). Peça de novo a {c.coord} com o nome atual, ou faça a mudança direto no perfil.</> },
  { q: 'A rotina não rodou no horário', keywords: 'rotina perdida sem novidade horário',
    a: (c) => <>Em <Go c={c} v="rotinas">Rotinas › Histórico</Go>: “Perdida” quando o computador ficou desligado por mais de 6 horas depois do horário; “Sem novidade” quando não havia nada novo para analisar (sem gastar o modelo). Use <b>Executar agora</b> se quiser na hora.</> },
  { q: 'A tela trancou sozinha', keywords: 'trancou trava inatividade',
    a: (c) => <>É a trava por inatividade. Desligue ou mude o tempo em <Go c={c} v="configuracao" hash="configuracao?seguranca">Configurações › Segurança</Go>.</> },
  { q: 'Esqueci a senha', keywords: 'senha esqueci recuperar',
    a: () => <>Na tela de entrada, use <b>Esqueci a senha</b> e digite a frase de recuperação de 24 palavras. Sem a frase, não há como abrir os dados.</> },
  { q: 'Apareceu “NOVA VERSÃO · RECARREGAR”', keywords: 'nova versão recarregar atualizar',
    a: () => <>O Ergon foi atualizado com esta aba aberta. Clique no chip para recarregar; nada se perde.</> },
  { q: 'Quero recomeçar com outro perfil de equipe', keywords: 'recomeçar refazer perfil nicho',
    a: () => <>Use <b>Refazer a equipe de partida</b>, no alto desta página. As funções e os setores mudam; os nomes que você deu e os agentes que você criou ficam.</> },
];

function examples(state: AppState): [string, string, string] {
  const coord = coordinatorOf(state.agents);
  const names = state.agents.filter((a) => a.status === 'active' && a.id !== coord?.id).map((a) => a.name);
  const pick = (i: number, fallback: string) => names[i] ?? names[0] ?? fallback;
  return [pick(0, 'um agente'), pick(1, 'um agente'), pick(2, 'um agente')];
}

/** onRedo só para quem pode refazer a equipe (o proprietário do workspace) */
export function AjudaView({ state, onGo, onTour, onRedo }: { state: AppState; onGo: (v: View) => void; onTour: () => void; onRedo?: () => void }) {
  const prefs = usePrefs();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string>(() => location.hash.match(/ajuda\?(\w+)/)?.[1] ?? 'inicio');
  const [confirmRedo, setConfirmRedo] = useState(false);
  const ctx: Ctx = {
    coord: coordinatorOf(state.agents)?.name ?? 'a coordenação',
    reviewer: reviewerOf(state.agents)?.name ?? 'ninguém por enquanto',
    ex: examples(state),
    go: (v, hash) => { if (hash) history.replaceState(null, '', `#${hash}`); onGo(v); },
  };
  const term = q.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const match = (s: string) => !term || s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').includes(term);
  const arts = useMemo(() => ARTICLES.filter((a) => match(`${a.title} ${a.keywords}`)), [term]); // eslint-disable-line react-hooks/exhaustive-deps
  const probs = PROBLEMS.filter((p) => match(`${p.q} ${p.keywords}`));
  const current = ARTICLES.find((a) => a.id === open);
  const pick = (id: string) => { setOpen(id); history.replaceState(null, '', `#ajuda?${id}`); };

  return (
    <div className="page help">
      <header className="page__head">
        <h2>Ajuda</h2>
        <p className="muted">Como fazer as coisas no Ergon. Para qualquer dúvida, você também pode perguntar a {ctx.coord}.</p>
      </header>
      <div className="help__actions">
        <button className="btn" onClick={onTour}><Icon name="compass" size={15} /> Refazer o tour</button>
        <label className="check"><input type="checkbox" checked={prefs.tips} onChange={(e) => savePrefs({ tips: e.target.checked })} /> Mostrar dicas nas telas</label>
        {prefs.dismissed.length > 0 && <button className="btn btn--ghost btn--sm" onClick={() => savePrefs({ resetTips: true, tips: true })}>Trazer de volta as {prefs.dismissed.length} dica(s) dispensada(s)</button>}
        <span className="help__grow" />
        {!onRedo ? null : confirmRedo ? (
          <span className="row">
            <span className="hint warn">Troca funções e setores da equipe de partida. Seus nomes e agentes criados ficam.</span>
            <button className="btn btn--sm btn--primary" onClick={() => { setConfirmRedo(false); onRedo(); }}>Continuar</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmRedo(false)}>Cancelar</button>
          </span>
        ) : <button className="btn btn--ghost" onClick={() => setConfirmRedo(true)}><Icon name="users" size={15} /> Refazer a equipe de partida</button>}
      </div>
      <div className="help__grid">
        <nav className="help__nav" aria-label="Manuais">
          <label className="help__search"><Icon name="search" size={15} /><input type="search" placeholder="Buscar na ajuda" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar na ajuda" /></label>
          {arts.map((a) => (
            <button key={a.id} className={`help__item ${open === a.id ? 'is-on' : ''}`} onClick={() => pick(a.id)} aria-current={open === a.id ? 'true' : undefined}>
              <Icon name={a.icon} size={16} /> {a.title}
            </button>
          ))}
          <button className={`help__item ${open === 'problemas' ? 'is-on' : ''}`} onClick={() => pick('problemas')}><Icon name="help" size={16} /> Problemas comuns ({probs.length})</button>
        </nav>
        <article className="help__body card">
          {open === 'problemas' || (!current && term) ? (
            <>
              <h3>Problemas comuns e como contornar</h3>
              {probs.length ? probs.map((p) => (
                <details key={p.q} className="help__faq" open={!!term}>
                  <summary>{p.q}</summary>
                  <p>{p.a(ctx)}</p>
                </details>
              )) : <p className="muted">Nada encontrado. Tente outra palavra ou pergunte a {ctx.coord}.</p>}
            </>
          ) : current ? (
            <>
              <h3><Icon name={current.icon} size={18} /> {current.title}</h3>
              {current.body(ctx)}
            </>
          ) : <p className="muted">Escolha um manual ao lado.</p>}
        </article>
      </div>
    </div>
  );
}

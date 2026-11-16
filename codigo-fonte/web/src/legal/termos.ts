/**
 * Termos de uso do Ergon. A versão é a do servidor (server/src/services/termos.ts, TERMOS_VERSAO): mudar o que a pessoa
 * aceita = mudar o texto aqui E a versão lá (quem já aceitou vê o aviso de novo). Rascunho de 16/11/2026: revisar com
 * um advogado antes de distribuir amplamente.
 */
import type { Idioma } from '../i18n/idiomas.ts';

export interface Secao { titulo: string; paragrafos: string[] }
export interface Termos { titulo: string; resumo: string; secoes: Secao[] }

const PT: Termos = {
  titulo: 'Termos de uso do Ergon',
  resumo: 'O Ergon é uma equipe de agentes de IA que trabalha no seu computador, com a sua conta de IA. Por padrão, os agentes podem executar programas num ambiente isolado. Leia os pontos abaixo; você pode mudar quase tudo em Configurações.',
  secoes: [
    { titulo: '1. O que é o Ergon', paragrafos: [
      'O Ergon é um programa que roda no seu computador. Ele organiza pedidos, tarefas e rotinas e os entrega a agentes de inteligência artificial (IA), que usam o modelo de IA da conta que você conectar (Nous Portal, ChatGPT, chave própria ou outra).',
      'Os seus dados ficam guardados no seu computador, cifrados com a sua senha. O conteúdo de cada pedido (o que você escreve, os arquivos e os dados das contas que o agente precisa ler) é enviado ao provedor de IA que você escolheu, sob os termos dele.',
    ] },
    { titulo: '2. Executar código e Terminal vêm ligados', paragrafos: [
      'Para entregar planilhas, gráficos, análises e arquivos, os agentes podem executar programas (Python e comandos de terminal) num ambiente isolado da equipe, dentro do Ergon. Estas ferramentas vêm LIGADAS por padrão.',
      'Riscos: um agente pode errar, ou ser induzido por um conteúdo de terceiros (um e-mail, uma página, um documento com instruções escondidas) a executar programas que gravam, alteram ou apagam arquivos do ambiente da equipe, consomem mais da sua conta de IA ou enviam dados pela internet. O Ergon reduz esses riscos (ambiente isolado, confirmação para criar, enviar e apagar nas suas contas, aviso de instruções suspeitas), mas não os elimina.',
      'Você pode desligar Executar código e Terminal a qualquer momento em Configurações › Ferramentas da equipe, para a equipe inteira ou para um agente no perfil dele.',
    ] },
    { titulo: '3. Contas conectadas e ações', paragrafos: [
      'Quando você conecta contas (e-mail, agenda, tarefas, mensagens e outros aplicativos), os agentes podem ler o que essas contas permitem e, conforme as regras que você define em Conexões, criar, alterar, enviar ou apagar. Ler vai direto; criar, enviar e apagar pedem a sua confirmação, a menos que você libere.',
      'Você é responsável pelo que autoriza e pelo que é feito nas suas contas com essa autorização.',
    ] },
    { titulo: '4. A IA pode errar', paragrafos: [
      'Respostas, números, datas, cálculos, documentos e resumos produzidos por IA podem conter erros, omissões ou informações inventadas. Confira antes de usar, principalmente em decisões financeiras, jurídicas, médicas, contratuais ou que envolvam outras pessoas. O Ergon marca o que conferiu e o que não conferiu, mas a conferência final é sua.',
    ] },
    { titulo: '5. Arquivos de terceiros', paragrafos: [
      'Arquivos recebidos de outras pessoas podem conter vírus ou instruções maliciosas. O Ergon nunca executa nem abre arquivos executáveis que você enviar; ao baixar um, você é avisado. Abra arquivos de terceiros só quando confiar na origem.',
    ] },
    { titulo: '6. Custos', paragrafos: [
      'O uso dos modelos de IA, de imagens, vídeos, voz e de serviços conectados é cobrado pelos respectivos provedores, na sua conta. O Ergon mostra o consumo que consegue medir, mas não controla os preços nem as cobranças deles.',
    ] },
    { titulo: '7. Sem garantia', paragrafos: [
      'O Ergon é fornecido "como está", em versão de teste, sem garantia de funcionamento contínuo, de adequação a um fim específico ou de ausência de erros. Na extensão permitida pela lei, os autores do Ergon não respondem por perdas de dados, lucros cessantes, danos indiretos ou por atos praticados pelos agentes com as permissões e ferramentas que você manteve ligadas. Faça backups (o Ergon faz cópias automáticas e você pode pedir uma a qualquer momento).',
    ] },
    { titulo: '8. Mudanças nestes termos', paragrafos: [
      'Quando estes termos mudarem, o Ergon mostra a versão nova e pede o seu aceite antes de aplicar o que mudou.',
    ] },
  ],
};

const EN: Termos = {
  titulo: 'Ergon terms of use',
  resumo: 'Ergon is a team of AI agents that works on your computer, with your AI account. By default, agents can run programs in an isolated environment. Read the points below; you can change almost everything in Settings.',
  secoes: [
    { titulo: '1. What Ergon is', paragrafos: [
      'Ergon is a program that runs on your computer. It organizes requests, tasks and routines and hands them to artificial intelligence (AI) agents, which use the AI model of the account you connect (Nous Portal, ChatGPT, your own key or another).',
      'Your data is stored on your computer, encrypted with your password. The content of each request (what you write, the files, and the data from accounts the agent needs to read) is sent to the AI provider you chose, under its terms.',
    ] },
    { titulo: '2. Run code and Terminal are on', paragrafos: [
      'To deliver spreadsheets, charts, analyses and files, agents can run programs (Python and terminal commands) in the team\'s isolated environment, inside Ergon. These tools come ON by default.',
      'Risks: an agent may make mistakes, or be led by third-party content (an e-mail, a web page, a document with hidden instructions) to run programs that write, change or delete files in the team environment, use more of your AI account, or send data over the internet. Ergon reduces these risks (isolated environment, confirmation before creating, sending and deleting in your accounts, warnings about suspicious instructions), but does not eliminate them.',
      'You can turn Run code and Terminal off at any time in Settings › Team tools, for the whole team or for one agent in its profile.',
    ] },
    { titulo: '3. Connected accounts and actions', paragrafos: [
      'When you connect accounts (e-mail, calendar, tasks, messages and other apps), agents can read what those accounts allow and, following the rules you set in Connections, create, change, send or delete. Reading goes straight through; creating, sending and deleting ask for your confirmation unless you allow them.',
      'You are responsible for what you authorize and for what is done in your accounts under that authorization.',
    ] },
    { titulo: '4. AI can be wrong', paragrafos: [
      'Answers, numbers, dates, calculations, documents and summaries produced by AI may contain errors, omissions or made-up information. Check before using them, especially for financial, legal, medical or contractual decisions or anything involving other people. Ergon marks what it checked and what it did not, but the final check is yours.',
    ] },
    { titulo: '5. Third-party files', paragrafos: [
      'Files received from other people may contain viruses or malicious instructions. Ergon never runs or opens executable files you upload; you are warned when downloading one. Open third-party files only when you trust where they came from.',
    ] },
    { titulo: '6. Costs', paragrafos: [
      'Use of AI models, images, video, voice and connected services is billed by the respective providers, to your account. Ergon shows the usage it can measure, but does not control their prices or charges.',
    ] },
    { titulo: '7. No warranty', paragrafos: [
      'Ergon is provided "as is", as a test version, with no warranty of continuous operation, fitness for a particular purpose or freedom from errors. To the extent permitted by law, Ergon\'s authors are not liable for data loss, lost profits, indirect damages, or actions taken by agents with the permissions and tools you kept on. Keep backups (Ergon makes automatic copies and you can ask for one at any time).',
    ] },
    { titulo: '8. Changes to these terms', paragrafos: [
      'When these terms change, Ergon shows the new version and asks for your acceptance before applying what changed.',
    ] },
  ],
};

export const termosEm = (idioma: Idioma): Termos => (idioma === 'en' ? EN : PT);

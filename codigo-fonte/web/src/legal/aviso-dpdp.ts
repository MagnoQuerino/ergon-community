/**
 * rc.47: o aviso de privacidade e consentimento da Lei DPDP da Índia (Digital Personal Data Protection Act, 2023, seção 5,
 * e as Regras de 2025, Regra 3): em linguagem clara, separado dos termos de uso, com a versão do servidor
 * (server/src/services/dpdp.ts, AVISO_DPDP_VERSAO: mudar o texto aqui = mudar a versão lá). A lei pede o aviso em inglês
 * ou numa língua da 8ª Lista da Constituição: aqui em inglês (também o da Índia) e hindi, além de português e chinês.
 * Os dados do dono do serviço (quem responde, o Grievance Officer, o Consent Manager e o prazo) entram nos marcadores.
 * TRADUÇÃO DO HINDI COM REVISÃO NATIVA PENDENTE (como as telas: COMO-TRADUZIR.md); e revisar com um advogado na Índia
 * antes de 13 de maio de 2027, quando valem as obrigações de aviso e consentimento.
 */
import type { Idioma } from '../i18n/idiomas.ts';

export const REVISAO_NATIVA_PENDENTE = true;

export interface ConfigDoAviso {
  responsavel: string;
  grievance: { nome: string; email: string; telefone: string; endereco: string };
  consentManager: { nome: string; registro: string; url: string } | null;
  prazoDias: number;
}
export interface SecaoDoAviso { titulo: string; paragrafos: string[] }
export interface AvisoDpdp { titulo: string; intro: string; secoes: SecaoDoAviso[] }

type Textos = {
  titulo: string; intro: (r: string) => string;
  dados: [string, string[]]; finalidade: [string, string[]]; onde: [string, string[]]; direitos: [string, string[]];
  reclamar: [string, (g: string, prazo: number) => string[]]; cm: [string, (nome: string, reg: string, url: string) => string];
  retirar: [string, string[]];
};

const contato = (c: ConfigDoAviso) => [c.grievance.nome, c.grievance.email, c.grievance.telefone, c.grievance.endereco].filter(Boolean).join(' · ');

const PT: Textos = {
  titulo: 'Aviso de privacidade e consentimento',
  intro: (r) => `${r} usa o Ergon para organizar o trabalho com uma equipe de IA. Antes de continuar, veja quais dados pessoais seus são usados e para quê. A decisão é sua: você pode consentir agora e retirar o consentimento quando quiser.`,
  dados: ['Quais dados', ['O seu nome, usuário e foto de perfil.', 'O que você escreve nas conversas, tarefas e rotinas, e os arquivos que envia.', 'Se você conectar contas (e-mail, agenda, mensagens, outros aplicativos): só o que a equipe ler nelas a seu pedido.']],
  finalidade: ['Para quê', ['Só para fazer o que você pede à equipe de IA: responder, organizar tarefas e rotinas e preparar entregas.', 'Os seus dados não são vendidos nem usados para anúncios.']],
  onde: ['Onde ficam', ['Neste Ergon, cifrados. O trecho de cada pedido necessário para responder vai ao provedor de IA escolhido pelo serviço, sob as regras dele.']],
  direitos: ['Os seus direitos', ['Ver e baixar os seus dados (Minha conta › Baixar meus dados).', 'Pedir correção e apagamento (Minha conta › Excluir minha conta, ou pelo contato abaixo).', 'Retirar o consentimento a qualquer momento, com o mesmo esforço de dar (Minha conta › Privacidade).', 'Nomear uma pessoa para exercer esses direitos em seu nome em caso de morte ou incapacidade (Minha conta › Privacidade).']],
  reclamar: ['Dúvidas e reclamações', (g, prazo) => [`Fale com quem responde por este serviço: ${g}.`, `A resposta vem em até ${prazo} dias. Se não ficar satisfeito, você pode reclamar ao Data Protection Board of India.`]],
  cm: ['Consent Manager', (n, reg, url) => `Você também pode dar, ver e retirar este consentimento pelo Consent Manager ${n}${reg ? ` (registro ${reg})` : ''}${url ? `: ${url}` : ''}.`],
  retirar: ['Se você retirar', ['O que foi feito antes continua válido. Depois, a equipe deixa de usar os seus dados para novos pedidos, e você pode baixá-los e pedir o apagamento.']],
};
const EN: Textos = {
  titulo: 'Privacy and consent notice',
  intro: (r) => `${r} uses Ergon to organise work with a team of AI agents. Before you continue, see which of your personal data is used and why. It is your choice: you can consent now and withdraw your consent whenever you want.`,
  dados: ['What data', ['Your name, username and profile photo.', 'What you write in chats, tasks and routines, and the files you upload.', 'If you connect accounts (e-mail, calendar, messages, other apps): only what the team reads in them at your request.']],
  finalidade: ['What for', ['Only to do what you ask the AI team: answer, organise tasks and routines, and prepare deliverables.', 'Your data is not sold or used for advertising.']],
  onde: ['Where it is kept', ['In this Ergon, encrypted. The part of each request needed to answer goes to the AI provider chosen by the service, under its rules.']],
  direitos: ['Your rights', ['See and download your data (My account › Download my data).', 'Ask for correction and erasure (My account › Delete my account, or through the contact below).', 'Withdraw your consent at any time, as easily as you gave it (My account › Privacy).', 'Nominate a person to exercise these rights for you in case of death or incapacity (My account › Privacy).']],
  reclamar: ['Questions and grievances', (g, prazo) => [`Contact the person responsible for this service: ${g}.`, `You will get an answer within ${prazo} days. If you are not satisfied, you can complain to the Data Protection Board of India.`]],
  cm: ['Consent Manager', (n, reg, url) => `You can also give, review and withdraw this consent through the Consent Manager ${n}${reg ? ` (registration ${reg})` : ''}${url ? `: ${url}` : ''}.`],
  retirar: ['If you withdraw', ['What was done before stays valid. After that, the team stops using your data for new requests, and you can download it and ask for it to be erased.']],
};
const HI: Textos = {
  titulo: 'गोपनीयता और सहमति सूचना',
  intro: (r) => `${r} AI एजेंटों की टीम के साथ काम व्यवस्थित करने के लिए Ergon का उपयोग करता है। आगे बढ़ने से पहले देखें कि आपके कौन-से व्यक्तिगत डेटा का उपयोग होता है और क्यों। फ़ैसला आपका है: आप अभी सहमति दे सकते हैं और जब चाहें उसे वापस ले सकते हैं।`,
  dados: ['कौन-सा डेटा', ['आपका नाम, यूज़रनेम और प्रोफ़ाइल फ़ोटो।', 'चैट, कार्यों और रूटीन में आप जो लिखते हैं, और जो फ़ाइलें आप भेजते हैं।', 'अगर आप खाते जोड़ते हैं (ईमेल, कैलेंडर, संदेश, अन्य ऐप): सिर्फ़ वही जो टीम आपके कहने पर उनमें पढ़ती है।']],
  finalidade: ['किसलिए', ['सिर्फ़ वही करने के लिए जो आप AI टीम से कहते हैं: जवाब देना, कार्य और रूटीन व्यवस्थित करना, और डिलीवरी तैयार करना।', 'आपका डेटा बेचा नहीं जाता और विज्ञापनों के लिए उपयोग नहीं होता।']],
  onde: ['डेटा कहाँ रहता है', ['इसी Ergon में, एन्क्रिप्ट करके। हर अनुरोध का जवाब देने के लिए ज़रूरी हिस्सा सेवा द्वारा चुने गए AI प्रदाता के पास, उसके नियमों के तहत, जाता है।']],
  direitos: ['आपके अधिकार', ['अपना डेटा देखना और डाउनलोड करना (मेरा खाता › मेरा डेटा डाउनलोड करें)।', 'सुधार और मिटाने का अनुरोध करना (मेरा खाता › मेरा खाता हटाएँ, या नीचे दिए संपर्क से)।', 'किसी भी समय सहमति वापस लेना, उतनी ही आसानी से जितनी आसानी से दी थी (मेरा खाता › गोपनीयता)।', 'मृत्यु या अक्षमता की स्थिति में आपकी ओर से इन अधिकारों का उपयोग करने के लिए किसी व्यक्ति को नामित करना (मेरा खाता › गोपनीयता)।']],
  reclamar: ['प्रश्न और शिकायतें', (g, prazo) => [`इस सेवा के लिए ज़िम्मेदार व्यक्ति से संपर्क करें: ${g}।`, `आपको ${prazo} दिनों के भीतर जवाब मिलेगा। अगर आप संतुष्ट नहीं हैं, तो आप भारतीय डेटा संरक्षण बोर्ड (Data Protection Board of India) में शिकायत कर सकते हैं।`]],
  cm: ['कंसेंट मैनेजर (Consent Manager)', (n, reg, url) => `आप यह सहमति कंसेंट मैनेजर ${n}${reg ? ` (पंजीकरण ${reg})` : ''} के ज़रिए भी दे, देख और वापस ले सकते हैं${url ? `: ${url}` : ''}।`],
  retirar: ['अगर आप सहमति वापस लेते हैं', ['पहले जो किया गया, वह मान्य रहता है। उसके बाद टीम नए अनुरोधों के लिए आपके डेटा का उपयोग बंद कर देती है, और आप उसे डाउनलोड करके मिटाने का अनुरोध कर सकते हैं।']],
};
const ZH: Textos = {
  titulo: '隐私与同意通知',
  intro: (r) => `${r} 使用 Ergon 与 AI 智能体团队一起组织工作。继续之前，请了解你的哪些个人数据会被使用、用于什么目的。决定权在你：你可以现在同意，也可以随时撤回同意。`,
  dados: ['哪些数据', ['你的姓名、用户名和头像。', '你在对话、任务和例行任务中写下的内容，以及你上传的文件。', '如果你连接了账号（邮箱、日历、消息、其他应用）：只有团队应你的要求在其中读取的内容。']],
  finalidade: ['用于什么', ['只用于完成你交给 AI 团队的事：回答、整理任务和例行任务、准备交付。', '你的数据不会被出售，也不会用于广告。']],
  onde: ['存放在哪里', ['加密存放在这个 Ergon 中。每个请求中回答所需的部分，会按照服务所选 AI 提供商的规则发送给它。']],
  direitos: ['你的权利', ['查看并下载你的数据（我的账号 › 下载我的数据）。', '要求更正和删除（我的账号 › 删除我的账号，或通过下方的联系方式）。', '随时撤回同意，和给出同意一样简单（我的账号 › 隐私）。', '指定一个人，在你去世或无行为能力时代你行使这些权利（我的账号 › 隐私）。']],
  reclamar: ['疑问与投诉', (g, prazo) => [`请联系本服务的负责人：${g}。`, `你会在 ${prazo} 天内收到答复。如果不满意，你可以向印度数据保护委员会（Data Protection Board of India）投诉。`]],
  cm: ['同意管理者（Consent Manager）', (n, reg, url) => `你也可以通过同意管理者 ${n}${reg ? `（注册号 ${reg}）` : ''}给出、查看和撤回此同意${url ? `：${url}` : ''}。`],
  retirar: ['如果你撤回同意', ['此前已完成的处理依然有效。之后，团队不再将你的数据用于新的请求，你可以下载数据并要求删除。']],
};

const POR_IDIOMA: Record<Idioma, Textos> = { 'pt-BR': PT, en: EN, 'en-IN': EN, hi: HI, 'zh-CN': ZH };

/** O aviso no idioma da tela, com os dados do dono do serviço. */
export function avisoDpdp(idioma: Idioma, c: ConfigDoAviso): AvisoDpdp {
  const x = POR_IDIOMA[idioma] ?? EN;
  const secoes: SecaoDoAviso[] = [
    { titulo: x.dados[0], paragrafos: x.dados[1] },
    { titulo: x.finalidade[0], paragrafos: x.finalidade[1] },
    { titulo: x.onde[0], paragrafos: x.onde[1] },
    { titulo: x.direitos[0], paragrafos: x.direitos[1] },
    { titulo: x.reclamar[0], paragrafos: x.reclamar[1](contato(c), c.prazoDias) },
    ...(c.consentManager ? [{ titulo: x.cm[0], paragrafos: [x.cm[1](c.consentManager.nome, c.consentManager.registro, c.consentManager.url)] }] : []),
    { titulo: x.retirar[0], paragrafos: x.retirar[1] },
  ];
  return { titulo: x.titulo, intro: x.intro(c.responsavel), secoes };
}

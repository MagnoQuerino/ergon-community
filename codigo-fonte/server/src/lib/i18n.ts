/**
 * O mínimo de idioma do servidor (rc.44): o que chega à pessoa SEM passar pela tela — os avisos dos canais (Telegram,
 * Discord, WhatsApp, Teams) e o PDF — no idioma que ela escolheu (users.lang), mais o formatador de número, moeda e
 * data por locale, no lugar do 'pt-BR' e do "R$" escritos no código. O que vai para a tela continua indo com código
 * (lib/textos.ts) e a tela traduz; aqui fica só o que o servidor escreve por inteiro.
 *
 * Sem escolha (conta antiga, membro sem conta) vale o português, como sempre foi: nenhum texto existente muda para quem
 * usa o Ergon em português. en-IN usa o texto do inglês (muda só número, data e moeda: lakh e crore). Chinês e hindi:
 * REVISÃO POR NATIVO PENDENTE, como os dicionários da tela (web/src/i18n/zh-CN|hi).
 */
import type { Idioma } from '../services/prefs.ts';

export type { Idioma };
type Texto4 = { readonly 'pt-BR': string; readonly en: string; readonly 'zh-CN': string; readonly hi: string };

/** O locale do Intl de cada idioma (hi e en-IN agrupam em lakh e crore: 12,34,567). */
export const LOCALE: Record<Idioma, string> = { 'pt-BR': 'pt-BR', en: 'en-US', 'en-IN': 'en-IN', 'zh-CN': 'zh-CN', hi: 'hi-IN' };
const doTexto = (l: Idioma): keyof Texto4 => (l === 'en-IN' ? 'en' : l);

export const MENSAGENS = {
  // ——— canais: as respostas da camada comum (services/canais/externo.ts) ———
  'canal.pausado': {
    'pt-BR': 'Este canal está pausado para você. Quem administra o workspace precisa retomar no Ergon.',
    en: 'This channel is paused for you. The workspace admin needs to resume it in Ergon.',
    'zh-CN': '此渠道已对你暂停。需要工作区管理员在 Ergon 中恢复。',
    hi: 'यह चैनल आपके लिए रुका हुआ है। वर्कस्पेस के एडमिन को इसे Ergon में फिर से शुरू करना होगा।',
  },
  'canal.volume': {
    'pt-BR': 'Muitos pedidos em pouco tempo: este canal foi pausado para você, e o dono do workspace foi avisado no Ergon.',
    en: 'Too many requests in a short time: this channel was paused for you, and the workspace owner was told in Ergon.',
    'zh-CN': '短时间内请求过多：此渠道已对你暂停，并已在 Ergon 中通知工作区所有者。',
    hi: 'कम समय में बहुत ज़्यादा अनुरोध: यह चैनल आपके लिए रोक दिया गया है, और वर्कस्पेस के मालिक को Ergon में बताया गया है।',
  },
  'canal.segredo': {
    'pt-BR': 'Senhas, chaves, tokens e códigos nunca passam por aqui. Veja no Ergon.',
    en: 'Passwords, keys, tokens and codes never go through here. See them in Ergon.',
    'zh-CN': '密码、密钥、令牌和验证码绝不会经过这里。请在 Ergon 中查看。',
    hi: 'पासवर्ड, कुंजियाँ, टोकन और कोड यहाँ से कभी नहीं जाते। इन्हें Ergon में देखें।',
  },
  'canal.somenteLeitura': {
    'pt-BR': 'O seu papel neste workspace é de leitura: por aqui, só consultas.',
    en: 'Your role in this workspace is read-only: here, you can only ask questions.',
    'zh-CN': '你在此工作区中是只读角色：在这里只能查询。',
    hi: 'इस वर्कस्पेस में आपकी भूमिका सिर्फ़ पढ़ने की है: यहाँ से सिर्फ़ जानकारी माँग सकते हैं।',
  },
  'canal.aprovarNoApp': {
    'pt-BR': 'Este pedido ({categoria}) precisa de aprovação no app do Ergon, por segurança. Assim que for aprovado lá, a equipe começa.',
    en: 'This request ({categoria}) needs approval in the Ergon app, for safety. As soon as it is approved there, the team starts.',
    'zh-CN': '为了安全，这个请求（{categoria}）需要在 Ergon 应用中批准。一旦在那里获批，团队就会开始。',
    hi: 'सुरक्षा के लिए इस अनुरोध ({categoria}) को Ergon ऐप में मंज़ूरी चाहिए। वहाँ मंज़ूर होते ही टीम शुरू कर देगी।',
  },
  'canal.naoAprovado': {
    'pt-BR': 'O pedido não foi aprovado no Ergon.',
    en: 'The request was not approved in Ergon.',
    'zh-CN': '该请求未在 Ergon 中获批。',
    hi: 'अनुरोध Ergon में मंज़ूर नहीं हुआ।',
  },
  'canal.categoria.exportar': { 'pt-BR': 'exportar dados em massa', en: 'exporting data in bulk', 'zh-CN': '批量导出数据', hi: 'बड़ी मात्रा में डेटा निर्यात करना' },
  'canal.categoria.terceiros': { 'pt-BR': 'mandar dados a terceiros', en: 'sending data to third parties', 'zh-CN': '向第三方发送数据', hi: 'तीसरे पक्ष को डेटा भेजना' },
  'canal.categoria.apagar': { 'pt-BR': 'apagar', en: 'deleting', 'zh-CN': '删除', hi: 'हटाना' },
  'canal.categoria.config': { 'pt-BR': 'mudar configurações, conexões ou permissões', en: 'changing settings, connections or permissions', 'zh-CN': '更改设置、连接或权限', hi: 'सेटिंग्स, कनेक्शन या अनुमतियाँ बदलना' },
  // ——— canais: os avisos de "Com você" e da conversa do canal (services/canais/servico.ts) ———
  'canal.aprovado': {
    'pt-BR': 'Aprovado no Ergon: a equipe começou o seu pedido.',
    en: 'Approved in Ergon: the team has started your request.',
    'zh-CN': '已在 Ergon 中批准：团队已开始处理你的请求。',
    hi: 'Ergon में मंज़ूर: टीम ने आपका अनुरोध शुरू कर दिया है।',
  },
  'canal.aEquipe': { 'pt-BR': 'A equipe', en: 'The team', 'zh-CN': '团队', hi: 'टीम' },
  'canal.esperaRespostaAqui': {
    'pt-BR': '{quem} espera uma resposta sua: responda aqui mesmo.',
    en: '{quem} is waiting for your reply: answer right here.',
    'zh-CN': '{quem} 在等你回复：直接在这里回复即可。',
    hi: '{quem} आपके जवाब की प्रतीक्षा में है: यहीं जवाब दें।',
  },
  'canal.esperaResposta': { 'pt-BR': '{quem} espera uma resposta sua', en: '{quem} is waiting for your reply', 'zh-CN': '{quem} 在等你回复', hi: '{quem} आपके जवाब की प्रतीक्षा में है' },
  'canal.precisaDeVoce': { 'pt-BR': 'Precisa de você', en: 'Needs you', 'zh-CN': '需要你', hi: 'आपकी ज़रूरत है' },
  'canal.card.info': { 'pt-BR': 'precisa de uma informação sua', en: 'needs some information from you', 'zh-CN': '需要你提供信息', hi: 'आपसे कुछ जानकारी चाहिए' },
  'canal.card.review': { 'pt-BR': 'está pronto para você revisar', en: 'is ready for your review', 'zh-CN': '已可供你复核', hi: 'आपकी समीक्षा के लिए तैयार है' },
  'canal.card.approval': { 'pt-BR': 'espera a sua aprovação', en: 'is waiting for your approval', 'zh-CN': '在等你批准', hi: 'आपकी मंज़ूरी की प्रतीक्षा में है' },
  'canal.card.esperaVoce': { 'pt-BR': 'espera você', en: 'is waiting for you', 'zh-CN': '在等你', hi: 'आपकी प्रतीक्षा में है' },
  'canal.card.titulo': { 'pt-BR': 'Card #{numero} — {titulo}:', en: 'Card #{numero} — {titulo}:', 'zh-CN': '卡片 #{numero} — {titulo}：', hi: 'कार्ड #{numero} — {titulo}:' },
  'canal.card.linha': { 'pt-BR': 'Card #{numero}: {titulo} — {resto}', en: 'Card #{numero}: {titulo} — {resto}', 'zh-CN': '卡片 #{numero}：{titulo} — {resto}', hi: 'कार्ड #{numero}: {titulo} — {resto}' },
  'canal.verDetalhes': { 'pt-BR': 'Ver detalhes: {link}', en: 'See details: {link}', 'zh-CN': '查看详情：{link}', hi: 'विवरण देखें: {link}' },
  'canal.ligarCards': { 'pt-BR': 'Ligar o card #{a} ao #{b}?', en: 'Link card #{a} to #{b}?', 'zh-CN': '将卡片 #{a} 关联到 #{b}？', hi: 'कार्ड #{a} को #{b} से जोड़ें?' },
  'canal.regraSugerida': { 'pt-BR': 'Regra sugerida: {texto}', en: 'Suggested rule: {texto}', 'zh-CN': '建议的规则：{texto}', hi: 'सुझाया गया नियम: {texto}' },
  // ——— PDF (lib/pdf-documento.ts): a numeração das páginas ———
  // rc.45: Feishu e DingTalk não têm botões pelo gateway: o cartão diz onde decidir
  'canal.decidaNoApp': {
    'pt-BR': 'Para aprovar ou recusar, abra o Ergon: neste canal a decisão é no app.',
    en: 'To approve or decline, open Ergon: on this channel the decision is made in the app.',
    'zh-CN': '如需批准或拒绝，请打开 Ergon：在此渠道中需在应用内做决定。',
    hi: 'मंज़ूर या अस्वीकार करने के लिए Ergon खोलें: इस चैनल पर फ़ैसला ऐप में होता है।',
  },
  'pdf.pagina': { 'pt-BR': '{pagina} / {total}', en: '{pagina} / {total}', 'zh-CN': '第 {pagina} / {total} 页', hi: '{pagina} / {total}' },
} as const satisfies Record<string, Texto4>;

export type CodigoServidor = keyof typeof MENSAGENS;

/** O texto do código no idioma, com os valores nos marcadores {nome}. Idioma desconhecido ou ausente: o português. */
export function msg(l: Idioma | null | undefined, codigo: CodigoServidor, valores: Readonly<Record<string, string | number>> = {}): string {
  const m: Texto4 = MENSAGENS[codigo];
  const s = m[doTexto(l && l in LOCALE ? l : 'pt-BR')] ?? m['pt-BR'];
  return s.replace(/\{(\w+)\}/g, (todo, k: string) => (valores[k] === undefined ? todo : String(valores[k])));
}

// ——— número, moeda e data por locale (no lugar de toLocaleString('pt-BR') e do "R$" escritos no código) ———
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
const loc = (l: Idioma | null | undefined): string => LOCALE[l ?? 'pt-BR'] ?? 'pt-BR';
function nf(l: Idioma | null | undefined, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `n|${loc(l)}|${JSON.stringify(o)}`;
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) { f = new Intl.NumberFormat(loc(l), o); if (cache.size > 200) cache.clear(); cache.set(k, f); }
  return f;
}

/** As moedas que o servidor escreve: BRL, USD, EUR, CNY e INR. */
export type Moeda = 'BRL' | 'USD' | 'EUR' | 'CNY' | 'INR';

/** O espaço fixo do Intl (U+00A0, U+202F) vira espaço comum: o texto vai a canais e PDFs que nem sempre o mostram. */
const espaco = (s: string) => s.replace(/[  ]/g, ' ');

/** Número: 1.250,5 (pt-BR) · 1,250.5 (en) · 12,34,567 (en-IN, hi). */
export const fmtNumero = (l: Idioma | null | undefined, n: number, o: Intl.NumberFormatOptions = {}): string => espaco(nf(l, o).format(n));

/** Dinheiro: R$ 1.250,00 · $1,250.00 · ¥1,250.00 · ₹12,34,567.00. */
export const fmtMoeda = (l: Idioma | null | undefined, v: number, moeda: Moeda, o: Intl.NumberFormatOptions = {}): string =>
  espaco(nf(l, { style: 'currency', currency: moeda, ...o }).format(v));

/** Data: 21/11/2026 · 11/21/2026 · 2026/11/21 · 21/11/2026 (hi). Inválida: texto vazio. */
export function fmtData(l: Idioma | null | undefined, d: Date | number | string, o: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }): string {
  const v = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(v.getTime())) return '';
  const k = `d|${loc(l)}|${JSON.stringify(o)}`;
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) { f = new Intl.DateTimeFormat(loc(l), o); cache.set(k, f); }
  return espaco(f.format(v));
}

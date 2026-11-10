// Textos de tela que dependem do que o servidor mandou: o erro do login da Microsoft ou do Google, a volta do pedido ao
// administrador, a limpeza das versões antigas da equipe e o motivo de um card em falha. Ficam aqui, fora dos componentes,
// para o teste (textos-tela.test.ts) conferir que a pessoa nunca lê o erro cru, em inglês, nem as peças por dentro do Ergon.
//
// E o tradutor do que o servidor manda com CÓDIGO + VALORES (server/src/lib/textos.ts): o campo de sempre, em português,
// e ao lado o mesmo nome com "_t" ({ message, message_t }, { frase, frase_t }). Em outro idioma, a tela troca o texto
// pelo do dicionário (área "servidor"); sem código, ou com um código que esta tela não conhece, fica o português.
import { fmtData, fmtLista, fmtNumero, idiomaAtual, onIdioma, t, type Chave } from '../i18n/index.ts';
import { IDIOMA_PADRAO } from '../i18n/idiomas.ts';
import { pt } from '../i18n/pt/index.ts';
import type { Mensagem } from '../i18n/tipos.ts';
import type { EtapaConsentimento } from './types.ts';
// live.ts usa api.ts, que usa este arquivo: o ciclo é só de chamadas (nada dele roda ao carregar)
import { emitLocal } from './live.ts';

// ---------------------------------------------------------------- o que vem do servidor com código

/** Um valor de um texto do servidor: texto cru (nome, título, o que o agente escreveu), número, outro texto ou lista. */
export type ValorServidor = string | number | TextoServidor | readonly ValorServidor[];
/** Um texto do servidor: o código (a chave da área "servidor") e os valores dos marcadores. */
export interface TextoServidor { readonly codigo: string; readonly valores?: Readonly<Record<string, ValorServidor>>; readonly forma?: 'maiuscula' | 'frase' }

const SERVIDOR = pt.servidor as unknown as Readonly<Record<string, Mensagem>>;
const ehTexto = (v: unknown): v is TextoServidor => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as TextoServidor).codigo === 'string';
const marcadores = (m: Mensagem) => new Set((typeof m === 'string' ? [m] : Object.values(m)).flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1])));
const maiusc = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const comPonto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const traduzir = t as (chave: Chave, valores?: Readonly<Record<string, string | number>>) => string;

/** Monta o texto no idioma atual; null quando algum código é desconhecido (aí vale o português inteiro). */
function montar(v: unknown, fundo = 0): string | null {
  if (fundo > 12) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const partes = v.map((x) => montar(x, fundo + 1));
    return partes.every((x): x is string => x !== null) ? fmtLista(partes) : null;
  }
  if (!ehTexto(v)) return null;
  const vals = v.valores ?? {};
  let s: string;
  if (v.codigo === 'decimal') {
    // o tamanho da Saúde ("51,4 MB"): o número no formato do idioma, com as mesmas casas
    const n = Number(vals.v); const casas = Math.min(6, Math.max(0, Math.trunc(Number(vals.casas ?? 1)) || 0));
    if (!Number.isFinite(n)) return null;
    return fmtNumero(n, { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }
  if (v.codigo === 'junto') {
    const itens = Array.isArray(vals.itens) ? (vals.itens as readonly unknown[]).map((x) => montar(x, fundo + 1)) : [];
    if (!itens.every((x): x is string => x !== null)) return null;
    s = itens.join(typeof vals.sep === 'string' ? vals.sep : ' ');
  } else {
    const m = SERVIDOR[v.codigo];
    if (m === undefined) return null;
    const pronto: Record<string, string | number> = {};
    for (const k of marcadores(m)) {
      const x = vals[k];
      if (k === 'n') {
        const n = typeof x === 'number' ? x : Number(x);
        if (!Number.isFinite(n)) return null;
        pronto.n = n;
        continue;
      }
      const r = x === undefined ? '' : montar(x, fundo + 1);
      if (r === null) return null;
      pronto[k] = r;
    }
    // plural sem o {n} no texto ("um e-mail"): o número decide a forma do mesmo jeito
    if (typeof m !== 'string' && pronto.n === undefined) pronto.n = Number(vals.n ?? 0);
    s = traduzir(`servidor.${v.codigo}` as Chave, pronto);
  }
  return v.forma === 'frase' ? comPonto(maiusc(s)) : v.forma === 'maiuscula' ? maiusc(s) : s;
}

/**
 * O texto que veio do servidor, no idioma da tela: pelo código (o campo _t); em português, ou sem código conhecido, o
 * português que veio (a reserva). Quem atualiza a tela antes do servidor, ou o contrário, nunca vê um texto quebrado.
 */
export function textoDoServidor(codigo: unknown, reserva: string): string {
  if (idiomaAtual() === IDIOMA_PADRAO || codigo === null || codigo === undefined) return reserva;
  return montar(codigo) ?? reserva;
}

/**
 * O português que veio em cada campo traduzido (a reserva), por objeto da resposta. Ele nunca se perde: a troca de
 * idioma, que é feita na hora e sem recarregar (i18n/index.ts: setIdioma), refaz a tradução a partir dele.
 */
const RESERVAS = new WeakMap<object, Map<string, string | readonly unknown[]>>();
/** os objetos com campo traduzido que a tela ainda guarda (useResource, o cache de live.ts, o estado das telas) */
const VIVOS = new Set<WeakRef<object>>();
let desdeAPoda = 0;

/** o campo no idioma atual, a partir do português guardado (em português, o próprio) */
function aplicarReservas(r: Record<string, unknown>, reservas: Map<string, string | readonly unknown[]>): void {
  for (const [base, orig] of reservas) {
    const cod = r[`${base}_t`];
    if (typeof orig === 'string') r[base] = textoDoServidor(cod, orig);
    else r[base] = Array.isArray(cod) ? orig.map((x, i) => (typeof x === 'string' ? textoDoServidor(cod[i], x) : x)) : [...orig];
  }
}

function lembrar(o: object): void {
  VIVOS.add(new WeakRef(o));
  // o que a tela já soltou sai da lista de tempos em tempos (a lista não cresce sem fim numa sessão longa)
  if (++desdeAPoda < 500) return;
  desdeAPoda = 0;
  for (const w of VIVOS) if (!w.deref()) VIVOS.delete(w);
}

/**
 * A resposta do servidor com os textos já no idioma da tela: cada campo que tem o seu "_t" ao lado (message_t,
 * frase_t, itens_t, result_t…) é trocado pela tradução; o resto fica como veio. O português que veio fica guardado:
 * ao trocar de idioma, tudo o que já foi carregado é refeito no idioma novo (e volta ao português ao voltar). Usado em
 * lib/api.ts, para toda resposta (e todo erro) chegar traduzida a qualquer tela.
 */
export function traduzirResposta<T>(json: T): T {
  if (json === null || typeof json !== 'object') return json;
  const andar = (o: unknown, fundo: number): void => {
    if (fundo > 30 || o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) andar(x, fundo + 1); return; }
    const r = o as Record<string, unknown>;
    let reservas = RESERVAS.get(r);
    const nova = !reservas;
    for (const k of Object.keys(r)) {
      if (k.endsWith('_t') && k.length > 2) {
        const base = k.slice(0, -2); const atual = r[base];
        if ((typeof atual === 'string' || Array.isArray(atual)) && !reservas?.has(base)) {
          reservas ??= new Map();
          reservas.set(base, typeof atual === 'string' ? atual : [...atual]);
        }
        continue;
      }
      andar(r[k], fundo + 1);
    }
    if (!reservas) return;
    if (nova) { RESERVAS.set(r, reservas); lembrar(r); }
    aplicarReservas(r, reservas);
  };
  andar(json, 0);
  return json;
}

/** Refaz no idioma atual tudo o que já veio do servidor e ainda está na tela. */
export function retraduzirCarregados(): void {
  for (const w of VIVOS) {
    const o = w.deref();
    const reservas = o && RESERVAS.get(o);
    if (!o || !reservas) { VIVOS.delete(w); continue; }
    aplicarReservas(o as Record<string, unknown>, reservas);
  }
}

// Ao trocar de idioma: o que já está carregado muda na hora (antes do redesenho), e as telas abertas buscam de novo
// (o que o servidor gera na hora segue o idioma do pedido).
onIdioma(() => {
  retraduzirCarregados();
  emitLocal('resync');
});

// ---------------------------------------------------------------- login da Microsoft e do Google

type Provedor = 'microsoft' | 'google';
const NOME: Record<Provedor, string> = { microsoft: 'Microsoft', google: 'Google' };

/** primeira letra maiúscula e ponto final */
const frase = (s0: string) => comPonto(maiusc(s0.trim()));

/** a empresa exige o administrador (Microsoft: AADSTS90094/90095/65001; Google: admin_policy_enforced) */
const PRECISA_ADMIN = /AADSTS(?:90094|90095|65001)\b|\bconsent_required\b|\badmin_policy_enforced\b/i;
/** a própria pessoa recusou na página da conta */
const RECUSOU = /AADSTS65004\b|\baccess_denied\b/i;
const CODIGO_MS = /\b(AADSTS\d+)\b/;
/** o formato que o servidor grava com o erro do provedor: "prefixo: código (descrição em inglês)" */
const CRU_OAUTH = /^(?:A conta não concluiu o login|O administrador não aprovou|O login não terminou):\s*([a-z][a-z_]+)(?:\s*\(|$)/i; // i18n-ok: reconhece o texto que o servidor grava
/** o pedido recusado pelo administrador (o servidor grava assim) */
const ADMIN_NAO_APROVOU = /^O administrador não aprovou\b/i; // i18n-ok: reconhece o texto que o servidor grava

/**
 * O motivo de um login que não terminou, em palavras da pessoa: nunca o erro cru do provedor (inglês e código). Um
 * código que não diz nada à pessoa fica só como referência para o suporte. Texto que já está em português passa como está.
 */
export function motivoDoLogin(erro: string | null | undefined, provedor: Provedor = 'microsoft'): string | null {
  const s = (erro ?? '').trim();
  if (!s) return null;
  if (ADMIN_NAO_APROVOU.test(s)) return t('servidor.tela.login.adminNaoAprovou');
  if (PRECISA_ADMIN.test(s)) return t('servidor.tela.login.exigeAdmin');
  if (RECUSOU.test(s)) return provedor === 'google' ? t('servidor.tela.login.recusadaGoogle') : t('servidor.tela.login.recusadaMicrosoft');
  const codigo = CODIGO_MS.exec(s)?.[1] ?? CRU_OAUTH.exec(s)?.[1];
  if (codigo) return provedor === 'google' ? t('servidor.tela.login.naoConcluiuGoogle', { codigo }) : t('servidor.tela.login.naoConcluiuMicrosoft', { codigo });
  return frase(s);
}

/**
 * O problema gravado na conexão, como o cartão mostra: no pedido ao administrador já no primeiro acesso, nada em vermelho
 * (é um passo esperado, que o próprio cartão explica); na Microsoft e no Google, o motivo em palavras da pessoa.
 */
export function erroDaConexao(i: { kind: string; error?: string | null; adminBase?: unknown }): string | null {
  if (i.adminBase || !i.error) return null;
  return i.kind === 'microsoft' || i.kind === 'google' ? motivoDoLogin(i.error, i.kind) : i.error;
}

/**
 * O aviso da volta do login (a Microsoft entra em etapas: o que voltou sem a leitura ou sem os canais diz o que fazer).
 * conectada: a conta já está ligada neste workspace. Sem ela, a aprovação do administrador foi a do primeiro acesso, e o
 * botão que existe no cartão é "Já aprovaram? Entrar de novo" (com ela, a etapa aprovada mostra "Autorizar agora").
 */
export function textoDaVolta(kind: Provedor, status: string, conectada: boolean): string {
  const nome = NOME[kind];
  switch (status) {
    case 'conectado': return t('servidor.tela.volta.conectado', { nome });
    case 'parcial': return t('servidor.tela.volta.parcial', { nome });
    case 'sem-leitura': return t('servidor.tela.volta.semLeitura', { nome });
    // o Teams que a empresa só libera com o administrador: o que a pessoa já deu continua valendo
    case 'precisa-admin': return t('servidor.tela.volta.precisaAdmin', { nome });
    // o login seguiu sozinho até o fim: só os canais (opcionais) esperam o administrador
    case 'sem-canais': return t('servidor.tela.volta.semCanais', { nome });
    case 'admin-aprovou': return conectada ? t('servidor.tela.volta.adminAprovouConectada') : t('servidor.tela.volta.adminAprovouSemConta');
    case 'admin-aprovou-base': return t('servidor.tela.volta.adminAprovouSemConta');
    case 'admin-recusou': return t('servidor.tela.volta.adminRecusou');
    // o pedido aprovado não era deste Ergon (por exemplo, quem aprovou também usa o Ergon neste computador)
    case 'admin-aprovou-outro': return t('servidor.tela.volta.adminAprovouOutro');
    case 'admin-recusou-outro': return t('servidor.tela.volta.adminRecusouOutro');
    case 'admin-base': return t('servidor.tela.volta.adminBase');
    case 'recusado': return kind === 'google' ? t('servidor.tela.volta.canceladoGoogle') : t('servidor.tela.volta.canceladoMicrosoft');
    default: return kind === 'google' ? t('servidor.tela.volta.naoConcluiuGoogle') : t('servidor.tela.volta.naoConcluiuMicrosoft');
  }
}

/** O que a mensagem pronta ao administrador diz que ele aprova: o mesmo que o link de cada etapa pede (sso.ts). */
export function oQuePedirAoAdministrador(etapa: EtapaConsentimento['id']): string {
  if (etapa === 'canais') return t('servidor.tela.admin.canais');
  // o primeiro acesso já bloqueado pela empresa: o link pede tudo de uma vez (envio, escrita, leitura e Teams)
  if (etapa === 'base') return t('servidor.tela.admin.base');
  // o Teams bloqueado pela empresa: o link é o da leitura, que pede também o Teams
  if (etapa === 'trabalho') return t('servidor.tela.admin.trabalho');
  return t('servidor.tela.admin.leitura');
}

/**
 * O próximo passo de uma conexão de tarefas. Na Microsoft, escolher o plano ou a lista depende da leitura (Tasks.ReadWrite é
 * dela): antes de liberada, o cartão diz isso em vez de mandar a pessoa a uma escolha que falharia. link: Tarefas já serve.
 */
export function proximoPassoTarefas(kind: string, etapas: EtapaConsentimento[]): { texto: string; link: boolean } {
  const leitura = kind === 'microsoft' ? etapas.find((e) => e.id === 'leitura') : undefined;
  if (leitura && leitura.estado !== 'ok') return { texto: t('servidor.tela.tarefas.depoisDaLeitura'), link: false };
  return { texto: t('servidor.tela.tarefas.proximoPasso'), link: true };
}

// ---------------------------------------------------------------- as frases fixas (mudam junto com o idioma)
// `export let` + onIdioma: quem importa lê sempre o texto do idioma atual (a ligação do módulo acompanha a troca)

/** Enquanto a equipe é atualizada para a versão nova (a conta de IA fica fora por alguns minutos). */
export let FRASE_RENOVANDO = t('servidor.tela.renovando');
/** Depois de "Manter a cópia": nada foi apagado, e dá para mudar de ideia ali mesmo. */
export let TEXTO_MANTIDOS_DADOS_ANTIGOS = t('servidor.tela.dadosAntigos.mantidos');
export let TEXTO_CONFIRMAR_DADOS_ANTIGOS = t('servidor.tela.dadosAntigos.confirmar');
/** Conexões › O que pede a sua confirmação: as duas escolhas de cuidado (desligadas por padrão). */
export let ROTULO_CONFIRMAR_ORGANIZAR = t('servidor.tela.cuidado.confirmarOrganizar');
export let ROTULO_APROVAR_DEPOIS_DE_LER = t('servidor.tela.cuidado.aprovarDepoisDeLer');
/** A equipe ainda não foi atualizada para pedir aprovação: com a opção ligada, ela fica sem abrir sites e rodar programas (sem cartão). */
export let AVISO_APROVAR_SEM_CARTAO = t('servidor.tela.cuidado.semCartao');
/**
 * A dica do card da equipe com nome provisório (nasceu sem plano, com um nome tirado da conversa). Não promete prazo:
 * nada obriga a coordenação a rodar só para dar o nome — ela troca quando volta a cuidar do card, e a pessoa pode dar
 * outro pelo lápis a qualquer hora.
 */
export let DICA_NOME_PROVISORIO = t('servidor.tela.nomeProvisorio');
/** o que a pessoa lê junto do botão "Baixar meus dados" (Minha conta e antes de excluir a conta) */
export let TEXTO_BAIXAR_DADOS = t('servidor.tela.meusDados.baixar');
/** antes de excluir: o passo de baixar */
export let TEXTO_ANTES_DE_EXCLUIR = t('servidor.tela.meusDados.antesDeExcluir');
/** excluir a própria conta: o que acontece (inclusive com os backups feitos antes) */
export let TEXTO_EXCLUIR_CONTA = t('servidor.tela.meusDados.excluirConta');
onIdioma(() => {
  FRASE_RENOVANDO = t('servidor.tela.renovando');
  TEXTO_MANTIDOS_DADOS_ANTIGOS = t('servidor.tela.dadosAntigos.mantidos');
  TEXTO_CONFIRMAR_DADOS_ANTIGOS = t('servidor.tela.dadosAntigos.confirmar');
  ROTULO_CONFIRMAR_ORGANIZAR = t('servidor.tela.cuidado.confirmarOrganizar');
  ROTULO_APROVAR_DEPOIS_DE_LER = t('servidor.tela.cuidado.aprovarDepoisDeLer');
  AVISO_APROVAR_SEM_CARTAO = t('servidor.tela.cuidado.semCartao');
  DICA_NOME_PROVISORIO = t('servidor.tela.nomeProvisorio');
  TEXTO_BAIXAR_DADOS = t('servidor.tela.meusDados.baixar');
  TEXTO_ANTES_DE_EXCLUIR = t('servidor.tela.meusDados.antesDeExcluir');
  TEXTO_EXCLUIR_CONTA = t('servidor.tela.meusDados.excluirConta');
});

// ---------------------------------------------------------------- Saúde: liberar espaço e a cópia antiga

/** peças por dentro do Ergon e erros de rede: não dizem nada à pessoa (ficam no registro e no diagnóstico) */
const JARGAO = /\bmotor(?:es)?\b|\bgerente\b|ponte de controle|cont[eê]iner|\bpodman\b|\bdocker\b|\bimagem\b|respondeu \d{3}|fetch failed|\b\d{1,3}(?:\.\d{1,3}){3}\b|\bsocket\b|\btimeout\b/i;
/** códigos de erro do sistema (ECONNREFUSED, ETIMEDOUT…): em maiúsculas, para não pegar palavras como "está" (sem /i) */
const ERRO_DE_REDE = /\bE[A-Z]{4,}\b/;

/** O motivo de uma demora, só se ele for dito para a pessoa; com peça interna (motor, gerente, endereço…), nada. */
export function semJargao(texto: string | null | undefined): string | null {
  const s = (texto ?? '').trim();
  return s && !JARGAO.test(s) && !ERRO_DE_REDE.test(s) ? s : null;
}

export const tamanho = (b: number) => (b >= 1024 ** 3 ? t('servidor.tela.espaco.gb', { gb: fmtNumero(b / 1024 ** 3, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
  : b >= 1024 ** 2 ? t('servidor.tela.espaco.mb', { mb: fmtNumero(Math.round(b / 1024 ** 2)) }) : t('servidor.tela.espaco.menosDe1Mb'));
/** No Windows o Ergon roda num ambiente próprio: o espaço sai de dentro dele (o disco do Windows não encolhe na hora). */
export const ondeLibera = (noWindows: boolean) => (noWindows ? t('servidor.tela.espaco.dentroDoAmbiente') : '');
/** o que saiu, sem inventar número quando não deu para medir */
const saiu = (liberado: number | null, noWindows: boolean) => (liberado === null
  ? (noWindows ? t('servidor.tela.espaco.liberadoNoAmbiente') : t('servidor.tela.espaco.liberado'))
  : t('servidor.tela.espaco.liberados', { tamanho: tamanho(liberado), onde: ondeLibera(noWindows) }));

/** O resultado de "Liberar espaço" (Saúde). */
export function textoDoLiberado(r: { liberado: number | null; removidas: number }, noWindows: boolean): string {
  return r.removidas ? t('servidor.tela.espaco.removidas', { saiu: saiu(r.liberado, noWindows), n: r.removidas }) : t('servidor.tela.espaco.nadaParaLiberar');
}

/** A última limpeza, enquanto não há resultado novo na tela. */
export function textoUltimaLimpeza(u: { at: string; liberado: number | null; removidas: number }, noWindows: boolean): string {
  return t('servidor.tela.espaco.ultimaLimpeza', { data: fmtData(u.at), saiu: u.removidas ? saiu(u.liberado, noWindows) : t('servidor.tela.espaco.nadaParaLiberarCurto') });
}

/** A pergunta antes de liberar espaço. */
export function textoConfirmarLiberar(noWindows: boolean): string {
  return t('servidor.tela.espaco.confirmar', { onde: ondeLibera(noWindows) });
}

/**
 * A cópia antiga dos dados da equipe (sem cifra, de antes do cofre) que o cofre não confirmou ter recebido: a pergunta
 * deixa claro que não tem volta; a frase vai no corpo do pedido (o servidor só apaga com ela, em português).
 */
export const CONFIRMAR_DADOS_ANTIGOS = 'apagar sem volta'; // i18n-ok: o código que o servidor confere no pedido (não aparece na tela)

/** De quem é um cofre sem conta, para "Cofre de …": sem repetir "cofre de" e com "uma conta" (aceita o texto antigo do servidor). */
export function rotuloDoCofre(conta: string): string {
  const s = conta.trim().replace(/^cofre de\s+/i, ''); // i18n-ok: tira o prefixo que o servidor antigo mandava
  return /^conta\b/i.test(s) ? t('servidor.tela.cofreDeUma', { conta: s }) : s; // i18n-ok: reconhece o texto do servidor
}

/** O card em falha: o motivo (a entrega honesta diz o que não foi feito) e o que a pessoa pode fazer. */
export function motivoDaFalha(justificativa: string | null | undefined): string {
  const j = (justificativa ?? '').trim();
  return t('servidor.tela.falha', { motivo: j || t('servidor.tela.naoDeuCerto') });
}

// ---------------------------------------------------------------- baixar os próprios dados e excluir a conta
/** quem administra, ao remover a conta de outra pessoa */
export function textoRemoverPessoa(usuario: string): string {
  return t('servidor.tela.meusDados.removerPessoa', { usuario });
}
/** a mensagem depois que o arquivo baixou (com quantos arquivos ficaram de fora, por qualquer motivo: o LEIA-ME diz qual) */
export function textoBaixado(deFora: number): string {
  return deFora > 0 ? t('servidor.tela.meusDados.baixadoComFora', { n: deFora }) : t('servidor.tela.meusDados.baixado');
}

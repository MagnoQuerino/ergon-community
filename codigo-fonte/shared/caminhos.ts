/**
 * Para a pessoa só existem o Ergon e os Documentos do app (rc.33). O que o motor deixa escapar na resposta — o caminho de
 * um arquivo dentro dele ("/opt/data/profiles/erg-…/home/.config/…/shot.png"), uma pasta temporária, HERMES_HOME, o id do
 * perfil de um agente — sai antes de a mensagem aparecer: na conversa do app, no Telegram, no Discord, no Teams e no
 * WhatsApp. O arquivo que está em Documentos vira o link dele; o resto vira "(arquivo interno)".
 */

/** um arquivo de Documentos achado pelo nome (o último pedaço do caminho) */
export interface DocAchado { id: string; filename: string }
export type AcharDoc = (nome: string) => DocAchado | null;

export const ARQUIVO_INTERNO = '(arquivo interno)';

/** "[documento: art_<id> nome do arquivo]": o link para um arquivo de Documentos (a conversa mostra o nome, clicável) */
export const DOC_TOKEN = /\[documento: (art_[a-f0-9]{32}) ([^\]\n]{1,200})\]/g;
export const docToken = (d: DocAchado): string => `[documento: ${d.id} ${d.filename.replace(/[\]\n]/g, ' ').slice(0, 200).trim() || 'arquivo'}]`;

// o que um caminho pode ter até acabar: espaço, aspas, parênteses, colchetes, chaves, sinais de tabela e de lista
const CORPO = String.raw`[^\s'"\`<>()\[\]{}|,;]*`;
/**
 * Um caminho do motor: as raízes de dentro do contêiner (dados, programa, temporários, pastas pessoais) e o HERMES_HOME
 * (com ou sem $ e chaves). Não começa colado a letra, número, ponto, barra ou dois-pontos: "https://site/tmp/x" fica.
 */
const CAMINHO = new RegExp(String.raw`(?<![\w./:~$-])(?:\/(?:opt\/(?:data|hermes)|tmp|var\/tmp|home|root)(?=\/|\b)${CORPO}|~\/${CORPO}|\$?\{?HERMES_HOME\}?${CORPO})`, 'g');
/** o id do perfil de um agente no motor (services/perfis.ts: "erg-" + 20 hexadecimais) */
const PERFIL = /(?<![\w./-])erg-[a-f0-9]{12,64}(?![\w-])/g;
/** "MEDIA:<algo>" que sobrou (a imagem não pôde ser trazida): a linha sai, o resto do texto fica */
const MEDIA = /MEDIA:\s*\S*/g;

/** o nome do arquivo no fim do caminho ("" = pasta) */
function nomeDe(caminho: string): string {
  const ultimo = caminho.replace(/\/+$/, '').split('/').pop() ?? '';
  let nome = ultimo;
  try { nome = decodeURIComponent(ultimo); } catch { /* fica como veio */ }
  return /\.[A-Za-z0-9]{1,8}$/.test(nome) && !nome.startsWith('.') ? nome : '';
}

/**
 * Tira do texto os caminhos e nomes internos do motor. `acharDoc` (opcional) procura o arquivo em Documentos pelo nome:
 * achou, vira o link dele; senão, "(arquivo interno)". Linhas que ficam vazias (um MEDIA: perdido) saem.
 */
export function limparCaminhos(texto: string, acharDoc?: AcharDoc | null): string {
  const src = String(texto ?? '');
  if (!/MEDIA:|\/(?:opt|tmp|var|home|root)\/|~\/|HERMES_HOME|erg-[a-f0-9]/.test(src)) return src;
  let mudou = false;
  const linhas = src.split('\n').map((linha) => {
    if (!/MEDIA:|\/|HERMES_HOME|erg-/.test(linha)) return linha;
    let l = linha.replace(MEDIA, () => { mudou = true; return ''; });
    l = l.replace(CAMINHO, (m) => {
      mudou = true;
      // pontuação do fim da frase não é do caminho
      const fim = m.match(/[.:!?]+$/)?.[0] ?? '';
      const caminho = fim ? m.slice(0, -fim.length) : m;
      const nome = nomeDe(caminho);
      const doc = nome && acharDoc ? acharDoc(nome) : null;
      return (doc ? docToken(doc) : ARQUIVO_INTERNO) + fim;
    });
    l = l.replace(PERFIL, () => { mudou = true; return ''; });
    if (l === linha) return l;
    // `(arquivo interno)` em código vira texto; espaços que sobraram juntos
    l = l.replace(/`(\(arquivo interno\)|\[documento: [^\]\n]+\])`/g, '$1').replace(/\(\(arquivo interno\)\)/g, ARQUIVO_INTERNO).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
    return l.trim() ? l : null;
  });
  if (!mudou) return src;
  return linhas.filter((l): l is string => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** O link de um documento como texto simples (canais externos, prévias): só o nome. */
export const docsComoTexto = (t: string): string => String(t ?? '').replace(DOC_TOKEN, (_m, _id: string, nome: string) => nome);

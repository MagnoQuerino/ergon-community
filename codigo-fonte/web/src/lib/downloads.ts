/**
 * Downloads (rc.33). No Ergon Desktop, o aplicativo guarda o arquivo na pasta de downloads do Ergon (escolhida em
 * Configurações › Minha conta; sem escolha, a Downloads do sistema) e avisa a página por um evento no window, com o nome,
 * a pasta e um número: "Abrir pasta" e "Mostrar arquivo" pedem pelo número, nunca por um caminho (janela.rs). No
 * navegador, quem escolhe a pasta é o navegador: o aviso diz só o nome e isso.
 */
export const EVENTO_DOWNLOAD = 'ergon:download';
export const EVENTO_PASTA = 'ergon:downloads-pasta';

/** Pedidos ao aplicativo (a navegação para estes endereços nunca sai da tela: o aplicativo atende e cancela). */
export const PEDIDO = {
  pasta: '/__desktop/downloads/pasta',
  escolher: '/__desktop/downloads/escolher',
  padrao: '/__desktop/downloads/padrao',
  abrirPasta: (id: number) => `/__desktop/downloads/abrir-pasta?id=${id}`,
  mostrar: (id: number) => `/__desktop/downloads/mostrar?id=${id}`,
} as const;

export interface AvisoDownload { id: number | null; nome: string; pasta: string | null }
export interface PastaDownloads { pasta: string; padrao: boolean }

const texto = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** O detalhe do evento do aplicativo, conferido (vem de fora da página: só o que tem a forma esperada passa). */
export function lerAviso(detalhe: unknown): AvisoDownload | null {
  const d = detalhe as Record<string, unknown> | null;
  const nome = texto(d?.nome, 260);
  if (!d || !nome) return null;
  const id = typeof d.id === 'number' && Number.isInteger(d.id) && d.id >= 0 ? d.id : null;
  return { id, nome, pasta: texto(d.pasta, 1000) };
}

export function lerPasta(detalhe: unknown): PastaDownloads | null {
  const d = detalhe as Record<string, unknown> | null;
  const pasta = texto(d?.pasta, 1000);
  return d && pasta ? { pasta, padrao: d.padrao === true } : null;
}

/**
 * O link é um download de um arquivo do Ergon? Devolve o nome (o do atributo download, ou o texto do link), ou null.
 * Vale o atributo download (também o de um arquivo montado na página) e o endereço de baixar um arquivo de Documentos
 * sem "?inline=1" (a prévia abre, não baixa).
 */
export function nomeDoDownload(link: { href: string; download: string | null; texto: string }, origem: string): string | null {
  let u: URL;
  try { u = new URL(link.href, origem); } catch { return null; }
  const doErgon = u.origin === origem || u.protocol === 'blob:';
  if (!doErgon) return null;
  const arquivo = /^\/api\/artifacts\/art_[a-f0-9]{32}\/download$/.test(u.pathname) && u.searchParams.get('inline') !== '1';
  if (link.download === null && !arquivo) return null;
  return texto(link.download, 260) ?? texto(link.texto.replace(/\s+/g, ' '), 260) ?? '';
}

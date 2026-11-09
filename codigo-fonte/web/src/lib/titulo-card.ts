/**
 * O nome que a pessoa dá ao card da equipe (o lápis ao lado do título). O nome dela fica: a coordenação não troca
 * mais sozinho (server/src/services/card-title.ts).
 */

/** O nome digitado, pronto para gravar; null quando está vazio ou igual ao de agora (só fecha o campo). */
export function nomeParaGravar(texto: string | null, atual: string): string | null {
  const nome = (texto ?? '').trim().replace(/\s+/g, ' ');
  return nome && nome !== atual ? nome : null;
}

export type Gravacao = { fechar: true; salvo: boolean; revision?: number } | { fechar: false; salvo: false; erro: unknown };

/**
 * Grava o nome. Só o título muda (não há o que mesclar), então vai sem a revisão: a equipe mover o card ou a
 * coordenação mexer nele enquanto a pessoa digita não faz a gravação falhar. Se falhar mesmo assim, o campo continua
 * aberto com o que foi digitado (fechar: false) e só então aparece o erro; "Salvo" só quando gravou.
 */
export async function gravarNome(enviar: (corpo: { title: string }) => Promise<{ revision: number }>, texto: string | null, atual: string): Promise<Gravacao> {
  const nome = nomeParaGravar(texto, atual);
  if (!nome) return { fechar: true, salvo: false };
  try {
    const r = await enviar({ title: nome });
    return { fechar: true, salvo: true, revision: r.revision };
  } catch (erro) {
    return { fechar: false, salvo: false, erro };
  }
}

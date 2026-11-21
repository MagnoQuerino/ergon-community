/**
 * Os Documentos do Ergon como conexão dos agentes (rc.42, "mãos na massa"): achar, ler e editar planilhas e textos que
 * estão nos arquivos do workspace (o que a pessoa trouxe do computador, as entregas, os anexos) — xlsx, csv, docx, md e
 * txt. O motor não enxerga o disco do computador (só o cofre dele): é por aqui que um agente mexe num arquivo local que a
 * pessoa pôs nos Documentos.
 *
 * Editar nunca apaga: o arquivo novo nasce na mesma pasta, com o mesmo nome, e o de antes vai para a Lixeira dos
 * Documentos (a pessoa restaura de lá). Por isso editar é "organizar" e segue a mesma regra das contas para quem pediu:
 * vai direto quando o pedido é da pessoa (ou com "Liberar tudo"); pedido de fora (rotina, mensagem recebida, colega)
 * não edita — a pessoa pede na conversa. Ler vai sempre direto; o conteúdo lido é marcado como de fora (pode ter vindo de
 * um anexo de e-mail).
 */
import type { Db } from '../../db/db.ts';
import { clip } from '../../lib/util.ts';
import { acrescentarNoDocx, ErroEdicao, escreverNoCsv, escreverNoXlsx, trocarNoDocx, valoresDe } from '../../lib/office-editar.ts';
import { openArtifact, saveArtifact } from '../artifacts.ts';
import type { Bus } from '../bus.ts';
import { audit } from '../bus.ts';
import { readDocument } from '../doc-isolated.ts';
import { sheetText } from '../doc-text.ts';
import { searchFiles, trash } from '../documents.ts';
import { neutral } from '../operations.ts';
import { ErroAcao, precisa, txt, type Args, type Param, type Risco } from './tipos.ts';

export const KIND_DOCUMENTOS = 'documentos';
interface Ctx { db: Db; bus: Bus; filesDir: string; maxBytes: number; ws: string; agentId: string | null; userId: string | null }
interface AcaoDoc { id: string; risco: Risco; descricao: string; params: Record<string, Param>; run(c: Ctx, a: Args): Promise<{ texto: string; url?: string | null; deFora?: boolean }> }

const P_ID: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do arquivo (art_..., vem de documentos.buscar)' };
const MAX_LIDO = 20_000;
const ext = (nome: string) => /\.([a-z0-9]{1,5})$/i.exec(nome)?.[1]?.toLowerCase() ?? '';
const link = (db: Db, ws: string, id: string): string => {
  const f = db.get<{ folder_id: string | null }>('SELECT folder_id FROM artifacts WHERE id = ? AND workspace_id = ?', id, ws)?.folder_id;
  return `#documentos?pasta=${f || 'root'}`;
};
const arquivo = (c: Ctx, id: string) => {
  if (!/^art_[0-9a-f]{32}$/.test(id)) throw new ErroAcao('"id" inválido: use o id que veio de documentos.buscar (art_...)');
  const row = c.db.get<{ deleted_at: string | null; folder_id: string | null; task_id: string | null; owner_user_id: string }>('SELECT deleted_at, folder_id, task_id, owner_user_id FROM artifacts WHERE id = ? AND workspace_id = ?', id, c.ws);
  if (!row || row.deleted_at) throw new ErroAcao(`o arquivo ${id} não existe (ou está na Lixeira)`);
  return { ...openArtifact(c.db, c.filesDir, c.ws, id), ...row };
};
/** A versão nova no lugar da antiga: mesmo nome, mesma pasta e card; a antiga vai para a Lixeira (dá para restaurar). */
function novaVersao(c: Ctx, antigo: ReturnType<typeof arquivo>, data: Buffer, oQue: string): { id: string; url: string } {
  const novo = saveArtifact(c.db, c.bus, c.filesDir, c.maxBytes, c.ws, c.userId ?? antigo.owner_user_id, { filename: antigo.filename, mime: antigo.mime, data, folderId: antigo.folder_id || null, taskId: antigo.task_id });
  trash(c.db, c.bus, c.ws, { type: 'agent', id: c.agentId ?? 'ergon' }, { artifactId: antigo.id });
  audit(c.db, c.bus, { workspaceId: c.ws, actorType: 'agent', actorId: c.agentId, action: 'documents.file.edit', targetType: 'artifact', targetId: novo.id,
    evidence: { antes: antigo.id, filename: antigo.filename }, result: `${antigo.filename}: ${oQue} (a versão de antes está na Lixeira)` });
  return { id: novo.id, url: link(c.db, c.ws, novo.id) };
}
const vals = (a: Args) => { try { return valoresDe(a.valores); } catch (e) { throw new ErroAcao(e instanceof Error ? e.message : 'valores inválidos'); } };

export const ACOES_DOCUMENTOS: AcaoDoc[] = [
  { id: 'documentos.buscar', risco: 'ler', descricao: 'procura arquivos nos Documentos do Ergon pelo nome (o que a pessoa trouxe do computador, entregas, anexos)', params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'parte do nome' } },
    async run(c, a) {
      const l = searchFiles(c.db, c.ws, precisa(a, 'texto', 200)).slice(0, 50);
      return { texto: l.length ? l.map((f) => `- id=${f.id} | ${neutral(f.filename, 200)} | ${f.path ? `pasta: ${neutral(f.path, 200)} | ` : ''}${Math.max(1, Math.round(f.size / 1024))} KB`).join('\n') : 'Nenhum arquivo encontrado.', deFora: true };
    } },
  { id: 'documentos.ler', risco: 'ler', descricao: `lê um arquivo dos Documentos: texto, ou as abas de uma planilha com as linhas numeradas (até ${MAX_LIDO} caracteres)`, params: { id: P_ID },
    async run(c, a) {
      const f = arquivo(c, precisa(a, 'id', 40));
      const doc = await readDocument(f.filename, f.mime, f.data);
      if (doc.status !== 'ok') throw new ErroAcao(`não deu para ler ${f.id}: ${neutral(doc.detail ?? doc.status, 200)}`);
      const texto = doc.sheets?.length ? doc.sheets.map((s) => `Aba ${neutral(s.name, 80)}:\n${sheetText(s, 300)}`).join('\n\n') : doc.text;
      return { texto: `Arquivo ${neutral(f.filename, 200)}${texto.length > MAX_LIDO ? ` (só os primeiros ${MAX_LIDO} caracteres)` : ''}:\n${clip(texto, MAX_LIDO)}`, url: link(c.db, c.ws, f.id), deFora: true };
    } },
  { id: 'documentos.editar_planilha', risco: 'organizar', descricao: 'escreve valores em células de uma planilha dos Documentos (xlsx ou csv), a partir de uma célula; fórmulas começam com =. A versão de antes vai para a Lixeira',
    params: { id: P_ID, aba: { tipo: 'texto', descricao: 'nome da aba (xlsx; padrão: a primeira)' }, celula: { tipo: 'texto', obrigatorio: true, descricao: 'onde começa, como B2' }, valores: { tipo: 'texto', obrigatorio: true, descricao: 'JSON [["a", 1], ["b", 2]] ou uma linha por linha com | entre as células' } },
    async run(c, a) {
      const f = arquivo(c, precisa(a, 'id', 40)); const e = ext(f.filename);
      try {
        if (e === 'xlsx') { const r = escreverNoXlsx(f.data, txt(a, 'aba', 31), precisa(a, 'celula', 20), vals(a)); const n = novaVersao(c, f, r.data, `células ${r.aba}!${r.intervalo}`); return { texto: `Planilha ${neutral(f.filename, 200)}: escrito em ${r.aba}!${r.intervalo}. Novo id=${n.id}; a versão de antes está na Lixeira dos Documentos.`, url: n.url }; }
        if (e === 'csv') { const t = escreverNoCsv(f.data.toString('utf8'), precisa(a, 'celula', 20), vals(a)); const n = novaVersao(c, f, Buffer.from(t, 'utf8'), `células a partir de ${String(a.celula).toUpperCase()}`); return { texto: `CSV ${neutral(f.filename, 200)} atualizado. Novo id=${n.id}; a versão de antes está na Lixeira dos Documentos.`, url: n.url }; }
      } catch (x) { if (x instanceof ErroEdicao) throw new ErroAcao(x.message); throw x; }
      throw new ErroAcao('só planilhas .xlsx e .csv');
    } },
  { id: 'documentos.editar_texto', risco: 'organizar', descricao: 'edita um documento dos Documentos (docx, md, txt): troca um texto exato por outro e/ou acrescenta no fim. A versão de antes vai para a Lixeira',
    params: { id: P_ID, procurar: { tipo: 'texto', descricao: 'o texto a trocar' }, trocar_por: { tipo: 'texto', descricao: 'o texto novo (vazio apaga)' }, acrescentar: { tipo: 'texto', descricao: 'texto para pôr no fim' } },
    async run(c, a) {
      const f = arquivo(c, precisa(a, 'id', 40)); const e = ext(f.filename);
      const procurar = txt(a, 'procurar', 5000); const acrescentar = txt(a, 'acrescentar', 50_000); const por = txt(a, 'trocar_por', 50_000) ?? '';
      if (!procurar && !acrescentar) throw new ErroAcao('diga "procurar" (com "trocar_por") ou "acrescentar"');
      let data: Buffer; let vezes = 0;
      try {
        if (e === 'docx') {
          data = f.data;
          if (procurar) { const r = trocarNoDocx(data, procurar, por); data = r.data; vezes = r.vezes; }
          if (acrescentar) data = acrescentarNoDocx(data, acrescentar);
        } else if (['md', 'txt', 'markdown'].includes(e)) {
          let t = f.data.toString('utf8');
          if (procurar) { vezes = t.split(procurar).length - 1; t = t.split(procurar).join(por); }
          if (acrescentar) t = `${t.replace(/\n*$/, '\n')}${acrescentar}\n`;
          data = Buffer.from(t, 'utf8');
        } else throw new ErroAcao('só documentos .docx, .md e .txt');
      } catch (x) { if (x instanceof ErroEdicao) throw new ErroAcao(x.message); throw x; }
      if (procurar && !vezes && !acrescentar) throw new ErroAcao(`o texto "${neutral(procurar, 80)}" não está no documento: nada mudou`);
      const n = novaVersao(c, f, data, `${procurar ? `${vezes} troca(s)` : ''}${procurar && acrescentar ? ' e ' : ''}${acrescentar ? 'texto acrescentado' : ''}`);
      return { texto: `Documento ${neutral(f.filename, 200)} editado${procurar ? `: ${vezes} troca(s)` : ''}. Novo id=${n.id}; a versão de antes está na Lixeira dos Documentos.`, url: n.url };
    } },
];

/** Para o prompt e o conexoes_listar: as ações e os parâmetros. */
export function listarDocumentos(): string {
  return `Documentos do Ergon (conexao="documentos"):\n${ACOES_DOCUMENTOS.map((x) => `- ${x.id} (${x.risco}): ${x.descricao}. Parâmetros: ${Object.entries(x.params).map(([n, p]) => `${n}${p.obrigatorio ? ' (obrigatório)' : ''}: ${p.descricao}`).join('; ')}`).join('\n')}`;
}

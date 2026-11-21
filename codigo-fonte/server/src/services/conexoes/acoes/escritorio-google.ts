/**
 * Escritório no Google Drive (rc.42, "mãos na massa"): organizar (pasta, mover, renomear, copiar), editar Documentos e
 * Planilhas que já existem (conteúdo e células, pelas APIs Docs e Sheets), comentar, compartilhar, mandar para a lixeira
 * e apagar de vez. Os endereços são fixos aqui; ids passam por seg(). Mesmos ids de ação da Microsoft.
 *
 * Permissão: `drive` (ver, editar, criar e apagar todos os arquivos do Drive). É a única nova: Docs (batchUpdate) e
 * Sheets (values) aceitam a mesma permissão, e é ela que deixa mover, renomear, comentar e compartilhar o que a pessoa já
 * tinha (drive.file só alcança o que o próprio Ergon criou). É uma permissão "restrita" para o Google: um aplicativo
 * publicado precisa da verificação de segurança (restricted-scope-verification). Quem conectou antes segue lendo; as
 * ações novas pedem "Autorizar de novo" em Conexões (servico.ts, faltamTudo), sem derrubar nada.
 *
 * Riscos: organizar e editar = 'organizar' (tudo volta: o Drive guarda as versões e a lixeira); comentar e compartilhar =
 * 'enviar' (avisa outras pessoas); compartilhar com alguém de FORA do domínio da conta pede a aprovação (preparar,
 * confirmar) salvo "Liberar tudo"; lixeira = 'apagar'; apagar de vez = sempre-protegida.
 *
 * Referências (conferidas em 21/11/2026):
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update (addParents, removeParents, name, trashed)
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy   .../files/create (pasta: mimeType folder)
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete (apaga de vez, sem lixeira)
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/comments/create (fields obrigatório)
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create (sendNotificationEmail)
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get (user.emailAddress)
 *   https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate (replaceAllText, insertText endOfSegmentLocation)
 *   https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get   .../update   .../append (valueInputOption USER_ENTERED)
 *   https://developers.google.com/identity/protocols/oauth2/scopes#drive (drive, documents, spreadsheets)
 */
import { neutral } from '../../operations.ts';
import { valoresDe, ErroEdicao } from '../../../lib/office-editar.ts';
import { semControle } from '../texto.ts';
import { ErroAcao, emails, precisa, seg, txt, type Acao, type Args, type CtxAcao, type Param } from '../tipos.ts';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export const ESCOPO_DRIVE_TUDO = 'https://www.googleapis.com/auth/drive';
const TUDO = [ESCOPO_DRIVE_TUDO];
const PASTA = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const PLANILHA = 'application/vnd.google-apps.spreadsheet';

const s = (a: Args, k: string): string => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
const d = (v: unknown, max = 200) => neutral(semControle(v), max);
const P_ID: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do arquivo ou pasta (vem de arquivos.buscar)' };
const P_PASTA: Param = { tipo: 'texto', descricao: 'id da pasta de destino (vem de arquivos.buscar); "raiz" = Meu Drive' };
const CAMPOS = 'id,name,mimeType,parents,webViewLink';
const meta = (ctx: CtxAcao, id: string) => ctx.http(`${DRIVE}/files/${seg(id)}?fields=${CAMPOS}&supportsAllDrives=true`);
const pastaDe = async (ctx: CtxAcao, v: string | undefined): Promise<string> => {
  if (!v || /^(raiz|root|meu drive)$/i.test(v.trim())) return 'root';
  const m = await meta(ctx, v.trim());
  if (m.mimeType !== PASTA) throw new ErroAcao(`o destino id=${d(v, 120)} não é uma pasta`);
  return String(m.id);
};
const semQuebra = (v: string) => v.replace(/[\r\n\0]+/g, ' ').trim();
const nomeOk = (a: Args, k: string) => { const n = semQuebra(precisa(a, k, 300)); if (!n) throw new ErroAcao(`falta "${k}"`); return n; };
const feito = (texto: string, j: any) => ({ texto, url: j?.webViewLink ? String(j.webViewLink) : null });
/** O intervalo das planilhas: "Aba!A1:B2" ou "A1"; aspas no nome da aba como a API pede. */
const intervalo = (a: Args): string => {
  const v = precisa(a, 'intervalo', 200);
  const aba = String.raw`(?:'[^']{1,100}'|[\p{L}\p{N} _.-]{1,100})`; const cel = String.raw`[A-Za-z]{1,3}\d{0,7}(?::[A-Za-z]{1,3}\d{0,7})?`;
  if (!new RegExp(`^(?:${aba}!)?${cel}$|^${aba}$`, 'u').test(v)) throw new ErroAcao('"intervalo" inválido: use como Página1!A1:C10 ou A1');
  return v;
};
const valores = (a: Args): unknown[][] => { try { return valoresDe(a.valores); } catch (e) { throw new ErroAcao(e instanceof ErroEdicao ? e.message : 'valores inválidos'); } };

export const ACOES_ESCRITORIO_GOOGLE: Acao[] = [
  { id: 'arquivos.pasta', risco: 'organizar', escopos: TUDO, descricao: 'cria uma pasta no Drive (dentro de outra, ou na raiz)', rotulo: 'cria uma pasta no Drive',
    params: { nome: { tipo: 'texto', obrigatorio: true, descricao: 'nome da pasta' }, dentro: P_PASTA },
    resumo: (a) => `Criar no Drive a pasta "${semQuebra(s(a, 'nome'))}"${a.dentro ? ` dentro da pasta ${s(a, 'dentro')}` : ''}`,
    async run(ctx, a) {
      const j = await ctx.http(`${DRIVE}/files?supportsAllDrives=true&fields=${CAMPOS}`, { method: 'POST', kind: 'write', body: { name: nomeOk(a, 'nome'), mimeType: PASTA, parents: [await pastaDe(ctx, txt(a, 'dentro', 200))] } });
      return feito(`Pasta criada: ${d(j.name)} (id=${j.id}).`, j);
    } },
  { id: 'arquivos.mover', risco: 'organizar', escopos: TUDO, descricao: 'move um arquivo ou pasta para outra pasta do Drive', params: { id: P_ID, para: { ...P_PASTA, obrigatorio: true } },
    resumo: (a) => `Mover no Drive o item ${s(a, 'id')} para a pasta ${s(a, 'para')}`,
    async preparar(ctx, a) { const m = await meta(ctx, precisa(a, 'id', 300)); return { detalhe: `Arquivo: ${d(m.name)}` }; },
    async run(ctx, a) {
      const m = await meta(ctx, precisa(a, 'id', 300)); const para = await pastaDe(ctx, precisa(a, 'para', 300));
      const q = new URLSearchParams({ addParents: para, supportsAllDrives: 'true', fields: CAMPOS });
      if (m.parents?.length) q.set('removeParents', (m.parents as string[]).join(','));
      const j = await ctx.http(`${DRIVE}/files/${seg(m.id)}?${q}`, { method: 'PATCH', kind: 'write', body: {} });
      return feito(`Movido: ${d(j.name)}.`, j);
    } },
  { id: 'arquivos.renomear', risco: 'organizar', escopos: TUDO, descricao: 'muda o nome de um arquivo ou pasta do Drive', params: { id: P_ID, nome: { tipo: 'texto', obrigatorio: true, descricao: 'o nome novo' } },
    resumo: (a) => `Renomear no Drive o item ${s(a, 'id')} para "${semQuebra(s(a, 'nome'))}"`,
    async preparar(ctx, a) { const m = await meta(ctx, precisa(a, 'id', 300)); return { detalhe: `Nome atual: ${d(m.name)}` }; },
    async run(ctx, a) {
      const j = await ctx.http(`${DRIVE}/files/${seg(precisa(a, 'id', 300))}?supportsAllDrives=true&fields=${CAMPOS}`, { method: 'PATCH', kind: 'write', body: { name: nomeOk(a, 'nome') } });
      return feito(`Renomeado para ${d(j.name)}.`, j);
    } },
  { id: 'arquivos.copiar', risco: 'organizar', escopos: TUDO, descricao: 'faz uma cópia de um arquivo (não de pasta), com outro nome e/ou em outra pasta',
    params: { id: P_ID, nome: { tipo: 'texto', descricao: 'nome da cópia (padrão: "Cópia de ...")' }, para: P_PASTA },
    resumo: (a) => `Copiar no Drive o arquivo ${s(a, 'id')}${a.nome ? ` com o nome "${semQuebra(s(a, 'nome'))}"` : ''}${a.para ? ` para a pasta ${s(a, 'para')}` : ''}`,
    async run(ctx, a) {
      const corpo: Record<string, unknown> = {};
      if (txt(a, 'nome')) corpo.name = nomeOk(a, 'nome');
      if (txt(a, 'para')) corpo.parents = [await pastaDe(ctx, txt(a, 'para', 300))];
      const j = await ctx.http(`${DRIVE}/files/${seg(precisa(a, 'id', 300))}/copy?supportsAllDrives=true&fields=${CAMPOS}`, { method: 'POST', kind: 'write', body: corpo });
      return feito(`Cópia criada: ${d(j.name)} (id=${j.id}).`, j);
    } },
  { id: 'documento.editar', risco: 'organizar', escopos: TUDO, descricao: 'edita um Documento Google que já existe: troca um texto por outro (em todo o documento) e/ou acrescenta texto no fim. Leia antes com arquivos.ler; o Drive guarda a versão anterior',
    rotulo: 'edita um Documento Google: troca textos e acrescenta no fim',
    params: { id: P_ID, procurar: { tipo: 'texto', descricao: 'o texto a trocar (exatamente como está)' }, trocar_por: { tipo: 'texto', descricao: 'o texto novo (vazio apaga o trecho)' }, acrescentar: { tipo: 'texto', descricao: 'texto para pôr no fim' } },
    resumo: (a) => [`Editar o Documento ${s(a, 'id')} no Drive:`, ...(a.procurar ? [`trocar "${s(a, 'procurar')}" por "${s(a, 'trocar_por')}"`] : []), ...(a.acrescentar ? [`acrescentar no fim: "${s(a, 'acrescentar')}"`] : [])].join('\n'),
    async run(ctx, a) {
      const id = precisa(a, 'id', 300); const m = await meta(ctx, id);
      if (m.mimeType !== DOC) throw new ErroAcao(`o arquivo id=${d(id, 120)} não é um Documento Google (para Word no Drive, converta antes ou use arquivos.copiar)`);
      const procurar = txt(a, 'procurar', 5000); const acrescentar = txt(a, 'acrescentar', 50_000);
      if (!procurar && !acrescentar) throw new ErroAcao('diga "procurar" (com "trocar_por") ou "acrescentar"');
      const reqs: unknown[] = [];
      if (procurar) reqs.push({ replaceAllText: { containsText: { text: procurar, matchCase: true }, replaceText: txt(a, 'trocar_por', 50_000) ?? '' } });
      if (acrescentar) reqs.push({ insertText: { endOfSegmentLocation: {}, text: `\n${acrescentar}` } });
      const j = await ctx.http(`${DOCS}/${seg(id)}:batchUpdate`, { method: 'POST', kind: 'write', body: { requests: reqs } });
      const vezes = Number(j?.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0);
      if (procurar && !vezes && !acrescentar) throw new ErroAcao(`o texto "${d(procurar, 80)}" não está no documento: nada mudou (confira com arquivos.ler)`);
      return feito(`Documento ${d(m.name)} editado${procurar ? `: ${vezes} troca(s)` : ''}${acrescentar ? `${procurar ? ' e' : ':'} texto acrescentado no fim` : ''}.`, m);
    } },
  { id: 'planilha.ler', risco: 'ler', escopos: TUDO, descricao: 'lê as células de um intervalo de uma Planilha Google, com os endereços (A1)', params: { id: P_ID, intervalo: { tipo: 'texto', obrigatorio: true, descricao: 'como Página1!A1:D20' } },
    resumo: (a) => `Ler ${s(a, 'intervalo')} da planilha ${s(a, 'id')}`,
    async run(ctx, a) {
      const j = await ctx.http(`${SHEETS}/${seg(precisa(a, 'id', 300))}/values/${encodeURIComponent(intervalo(a))}`);
      const linhas = ((j.values ?? []) as unknown[][]).slice(0, 500).map((l, i) => `${i + 1}: ${l.map((v) => d(v, 300)).join(' | ')}`);
      return { texto: `Intervalo ${d(j.range ?? '', 100)}:\n${linhas.join('\n') || '(vazio)'}`, deFora: true, privado: true };
    } },
  { id: 'planilha.editar', risco: 'organizar', escopos: TUDO, descricao: 'escreve valores em células de uma Planilha Google (fórmulas começam com =); o Drive guarda a versão anterior',
    rotulo: 'escreve valores e fórmulas em células de uma Planilha Google',
    params: { id: P_ID, intervalo: { tipo: 'texto', obrigatorio: true, descricao: 'onde começa ou o intervalo, como Página1!B2' }, valores: { tipo: 'texto', obrigatorio: true, descricao: 'linhas de células: JSON [["a", 1], ["b", 2]] ou texto com uma linha por linha e | entre as células' } },
    resumo: (a) => `Escrever na planilha ${s(a, 'id')}, a partir de ${s(a, 'intervalo')}: ${typeof a.valores === 'string' ? a.valores : JSON.stringify(a.valores)}`,
    async run(ctx, a) {
      const id = precisa(a, 'id', 300); const m = await meta(ctx, id);
      if (m.mimeType !== PLANILHA) throw new ErroAcao(`o arquivo id=${d(id, 120)} não é uma Planilha Google`);
      const j = await ctx.http(`${SHEETS}/${seg(id)}/values/${encodeURIComponent(intervalo(a))}?valueInputOption=USER_ENTERED`, { method: 'PUT', kind: 'write', body: { values: valores(a) } });
      return feito(`Planilha ${d(m.name)}: ${Number(j.updatedCells ?? 0)} célula(s) escritas em ${d(j.updatedRange ?? '', 100)}.`, m);
    } },
  { id: 'planilha.acrescentar', risco: 'organizar', escopos: TUDO, descricao: 'acrescenta linhas no fim da tabela de uma aba da Planilha Google', params: { id: P_ID, intervalo: { tipo: 'texto', obrigatorio: true, descricao: 'a aba, como Página1' }, valores: { tipo: 'texto', obrigatorio: true, descricao: 'as linhas novas, como em planilha.editar' } },
    resumo: (a) => `Acrescentar linhas na planilha ${s(a, 'id')} (${s(a, 'intervalo')}): ${typeof a.valores === 'string' ? a.valores : JSON.stringify(a.valores)}`,
    async run(ctx, a) {
      const id = precisa(a, 'id', 300); const m = await meta(ctx, id);
      const j = await ctx.http(`${SHEETS}/${seg(id)}/values/${encodeURIComponent(intervalo(a))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', kind: 'write', body: { values: valores(a) } });
      return feito(`Planilha ${d(m.name)}: linhas acrescentadas em ${d(j.updates?.updatedRange ?? '', 100)}.`, m);
    } },
  { id: 'arquivos.comentar', risco: 'enviar', escopos: TUDO, descricao: 'deixa um comentário num arquivo do Drive; quem acompanha o arquivo recebe', params: { id: P_ID, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o comentário' } },
    resumo: (a) => `Comentar no arquivo ${s(a, 'id')} do Drive: "${s(a, 'texto')}"`,
    async preparar(ctx, a) { const m = await meta(ctx, precisa(a, 'id', 300)); return { detalhe: `Arquivo: ${d(m.name)}` }; },
    async run(ctx, a) {
      const id = precisa(a, 'id', 300);
      await ctx.http(`${DRIVE}/files/${seg(id)}/comments?fields=id`, { method: 'POST', kind: 'write', body: { content: precisa(a, 'texto', 4000) } });
      return feito('Comentário publicado.', await meta(ctx, id));
    } },
  { id: 'arquivos.compartilhar', risco: 'enviar', escopos: TUDO, descricao: 'compartilha um arquivo ou pasta com uma pessoa pelo e-mail (ver, comentar ou editar); fora do domínio da conta, pede a aprovação da pessoa',
    params: { id: P_ID, email: { tipo: 'texto', obrigatorio: true, descricao: 'e-mail de quem recebe' }, papel: { tipo: 'texto', descricao: 'o que a pessoa pode', opcoes: ['ver', 'comentar', 'editar'], padrao: 'ver' }, avisar: { tipo: 'booleano', descricao: 'mandar o e-mail de aviso (padrão: sim)' } },
    resumo: (a) => `Compartilhar o item ${s(a, 'id')} do Drive com ${s(a, 'email')}, para ${s(a, 'papel') || 'ver'}`,
    async preparar(ctx, a) {
      const [email] = emails(a, 'email', 1); if (!email) throw new ErroAcao('falta "email"');
      const [m, eu] = await Promise.all([meta(ctx, precisa(a, 'id', 300)), ctx.http(`${DRIVE}/about?fields=user(emailAddress)`)]);
      const meu = String(eu?.user?.emailAddress ?? '').split('@')[1]?.toLowerCase() ?? '';
      const dele = email.split('@')[1].toLowerCase();
      // conta pessoal (gmail.com): todo mundo é "de fora"
      const fora = !meu || meu === 'gmail.com' || meu !== dele;
      return { detalhe: `Arquivo: ${d(m.name)}`, ...(fora ? { confirmar: `compartilhar com alguém de fora do seu domínio (${dele}) pede a sua aprovação` } : {}) };
    },
    async run(ctx, a) {
      const [email] = emails(a, 'email', 1); if (!email) throw new ErroAcao('falta "email"');
      const papel = ({ ver: 'reader', comentar: 'commenter', editar: 'writer' } as Record<string, string>)[s(a, 'papel') || 'ver'];
      if (!papel) throw new ErroAcao('"papel" precisa ser ver, comentar ou editar');
      const avisar = a.avisar !== false && a.avisar !== 'false';
      const id = precisa(a, 'id', 300);
      await ctx.http(`${DRIVE}/files/${seg(id)}/permissions?supportsAllDrives=true&sendNotificationEmail=${avisar}`, { method: 'POST', kind: 'write', body: { type: 'user', role: papel, emailAddress: email } });
      return feito(`Compartilhado com ${email} (${s(a, 'papel') || 'ver'}).`, await meta(ctx, id));
    } },
  { id: 'arquivos.apagar', risco: 'apagar', escopos: TUDO, descricao: 'manda um arquivo ou pasta para a Lixeira do Drive (dá para recuperar de lá por 30 dias)', params: { id: P_ID },
    resumo: (a) => `Mandar para a Lixeira do Drive o item ${s(a, 'id')}`,
    async preparar(ctx, a) { const m = await meta(ctx, precisa(a, 'id', 300)); return { detalhe: `${m.mimeType === PASTA ? 'Pasta' : 'Arquivo'}: ${d(m.name)}` }; },
    async run(ctx, a) {
      const j = await ctx.http(`${DRIVE}/files/${seg(precisa(a, 'id', 300))}?supportsAllDrives=true&fields=${CAMPOS}`, { method: 'PATCH', kind: 'write', body: { trashed: true } });
      return { texto: `${d(j.name)} foi para a Lixeira (dá para recuperar).` };
    } },
  { id: 'arquivos.apagar_de_vez', risco: 'apagar', protegida: 'apagar de vez não tem volta: pede a sua aprovação sempre, mesmo com "Liberar tudo"', escopos: TUDO,
    descricao: 'apaga um arquivo do Drive DE VEZ, sem passar pela Lixeira. Só quando a pessoa pediu com todas as letras', rotulo: 'apaga um arquivo de vez, sem lixeira (sempre pede a sua aprovação)', params: { id: P_ID },
    resumo: (a) => `APAGAR DE VEZ, sem Lixeira, o item ${s(a, 'id')} do Drive`,
    async preparar(ctx, a) { const m = await meta(ctx, precisa(a, 'id', 300)); return { detalhe: `${m.mimeType === PASTA ? 'Pasta (com tudo dentro)' : 'Arquivo'}: ${d(m.name)}` }; },
    async run(ctx, a) {
      await ctx.http(`${DRIVE}/files/${seg(precisa(a, 'id', 300))}?supportsAllDrives=true`, { method: 'DELETE', kind: 'write' });
      return { texto: 'Apagado de vez.' };
    } },
];

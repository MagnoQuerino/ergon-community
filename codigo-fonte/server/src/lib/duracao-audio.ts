/**
 * Duração de um áudio lida dos próprios bytes, sem programa externo (rc.33: a mensagem de áudio tem teto de 10 minutos, e o
 * servidor confere — a tela também para sozinha em 10:00, mas quem manda o arquivo pode ser outra coisa).
 *
 * Formatos: WebM/Matroska (o que o MediaRecorder grava; o Chrome não escreve a duração no cabeçalho, então vale o tempo do
 * último bloco), Ogg (Opus e Vorbis: a posição do último quadro), WAV (tamanho dos dados pela taxa), MP3 (o quadro Xing/Info
 * ou a taxa do primeiro quadro) e M4A/MP4 (a caixa mvhd). Desconhecido ou ilegível: null (quem chama usa o teto de tamanho).
 */

/** Segundos; null = não deu para saber. */
export function duracaoDoAudio(b: Buffer): number | null {
  try {
    if (b.length < 12) return null;
    if (b.readUInt32BE(0) === 0x1a45dfa3) return webm(b);
    if (b.toString('latin1', 0, 4) === 'OggS') return ogg(b);
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return wav(b);
    if (b.toString('latin1', 4, 8) === 'ftyp') return mp4(b);
    return mp3(b);
  } catch { return null; }
}

const ok = (s: number | null): number | null => (s !== null && Number.isFinite(s) && s >= 0 ? s : null);

// ---------------------------------------------------------------- WebM / Matroska (EBML)
/** Um número de tamanho variável do EBML: [valor, bytes]. Com `id`, mantém o marcador do tamanho (é o jeito dos IDs). */
function vint(b: Buffer, p: number, id = false): [number, number] | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1; let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > b.length) return null;
  let v = id ? first : first & (mask - 1);
  let todos1 = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) todos1 = false; }
  // tamanho "desconhecido" (todos os bits 1): o elemento vai até o próximo do mesmo nível
  if (!id && todos1) return [-1, len];
  return [v, len];
}
const uint = (b: Buffer, p: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };

const SEGMENTO = 0x18538067, CLUSTER = 0x1f43b675, INFO = 0x1549a966, GRUPO = 0xa0;
const ENTRA = new Set([SEGMENTO, CLUSTER, INFO, GRUPO]);
const ESCALA = 0x2ad7b1, DURACAO = 0x4489, TEMPO_CLUSTER = 0xe7, BLOCO_SIMPLES = 0xa3, BLOCO = 0xa1;

function webm(b: Buffer): number | null {
  let p = 0; let escala = 1_000_000; let declarada: number | null = null; let cluster = 0; let ultimo = -1;
  // caminho plano: os elementos-mãe que interessam são abertos (também os de tamanho desconhecido, como o Chrome grava);
  // o resto é pulado pelo tamanho
  for (let passos = 0; p < b.length && passos < 2_000_000; passos++) {
    const i = vint(b, p, true); if (!i) break;
    const s = vint(b, p + i[1]); if (!s) break;
    const id = i[0]; const dados = p + i[1] + s[1]; const tam = s[0];
    if (ENTRA.has(id)) { p = dados; continue; }
    const bloco = id === BLOCO_SIMPLES || id === BLOCO;
    // elemento cortado no fim (arquivo truncado): um bloco ainda dá o tempo dele; o resto encerra
    if ((tam < 0 || dados + tam > b.length) && !(bloco && tam >= 0)) break;
    if (id === ESCALA) escala = uint(b, dados, Math.min(tam, 8)) || escala;
    else if (id === DURACAO) declarada = tam === 4 ? b.readFloatBE(dados) : tam === 8 ? b.readDoubleBE(dados) : null;
    else if (id === TEMPO_CLUSTER) cluster = uint(b, dados, Math.min(tam, 8));
    else if (bloco) {
      const trilha = vint(b, dados);
      if (trilha && dados + trilha[1] + 2 <= b.length) ultimo = Math.max(ultimo, cluster + b.readInt16BE(dados + trilha[1]));
    }
    p = dados + tam;
  }
  const unidades = Math.max(declarada ?? 0, ultimo);
  if (unidades <= 0 && declarada === null) return null;
  return ok((unidades * escala) / 1e9);
}

// ---------------------------------------------------------------- Ogg (Opus, Vorbis)
function ogg(b: Buffer): number | null {
  let taxa = 48000; let preSkip = 0;
  const opus = b.indexOf('OpusHead', 0, 'latin1');
  if (opus >= 0 && opus < 512) preSkip = b.readUInt16LE(opus + 10);
  else {
    const vorbis = b.indexOf('\x01vorbis', 0, 'latin1');
    if (vorbis < 0 || vorbis > 512) return null;
    taxa = b.readUInt32LE(vorbis + 12);
    if (!taxa) return null;
  }
  // a última página: a posição do último quadro (granule), em amostras
  let p = b.lastIndexOf('OggS', b.length - 27, 'latin1');
  while (p >= 0) {
    if (p + 14 <= b.length && b[p + 4] === 0) {
      const g = Number(b.readBigInt64LE(p + 6));
      if (g >= 0) return ok(Math.max(0, g - preSkip) / taxa);
    }
    p = b.lastIndexOf('OggS', p - 1, 'latin1');
  }
  return null;
}

// ---------------------------------------------------------------- WAV
function wav(b: Buffer): number | null {
  let p = 12; let porSegundo = 0;
  while (p + 8 <= b.length) {
    const nome = b.toString('latin1', p, p + 4); const tam = b.readUInt32LE(p + 4);
    if (nome === 'fmt ' && p + 16 <= b.length) porSegundo = b.readUInt32LE(p + 16);
    if (nome === 'data') return porSegundo ? ok(Math.min(tam, b.length - p - 8) / porSegundo) : null;
    p += 8 + tam + (tam & 1);
  }
  return null;
}

// ---------------------------------------------------------------- MP4 / M4A
function mp4(b: Buffer): number | null {
  const m = b.indexOf('mvhd', 0, 'latin1');
  if (m < 4) return null;
  const v = b[m + 4];
  if (v === 1) { const escala = b.readUInt32BE(m + 24); return escala ? ok(Number(b.readBigUInt64BE(m + 28)) / escala) : null; }
  const escala = b.readUInt32BE(m + 16);
  return escala ? ok(b.readUInt32BE(m + 20) / escala) : null;
}

// ---------------------------------------------------------------- MP3
const TAXAS_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const TAXAS_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const AMOSTRAGEM: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3(b: Buffer): number | null {
  let p = 0;
  if (b.toString('latin1', 0, 3) === 'ID3') p = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  for (const fim = Math.min(b.length - 4, p + 64 * 1024); p < fim; p++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) continue;
    const versao = (b[p + 1] >> 3) & 3; const camada = (b[p + 1] >> 1) & 3;
    const iTaxa = b[p + 2] >> 4; const iAmostra = (b[p + 2] >> 2) & 3;
    if (versao === 1 || camada !== 1 || iTaxa === 0 || iTaxa === 15 || iAmostra === 3) continue; // só MPEG Layer III
    const kbps = (versao === 3 ? TAXAS_MPEG1 : TAXAS_MPEG2)[iTaxa];
    const amostragem = AMOSTRAGEM[versao][iAmostra];
    const porQuadro = versao === 3 ? 1152 : 576;
    // VBR: o quadro Xing/Info diz quantos quadros há
    const janela = b.toString('latin1', p + 4, Math.min(b.length, p + 60));
    const x = Math.max(janela.indexOf('Xing'), janela.indexOf('Info'));
    if (x >= 0) {
      const q = p + 4 + x;
      if (q + 12 <= b.length && (b.readUInt32BE(q + 4) & 1)) return ok((b.readUInt32BE(q + 8) * porQuadro) / amostragem);
    }
    return ok(((b.length - p) * 8) / (kbps * 1000));
  }
  return null;
}

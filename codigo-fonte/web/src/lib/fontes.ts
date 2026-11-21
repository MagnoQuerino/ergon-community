// As fontes do chinês e do hindi na tela (rc.44): só quando o idioma pede e só se o sistema não tiver a sua. Quem usa o
// Ergon em português ou inglês não baixa nada: o bundle não muda e nenhuma @font-face existe até a troca de idioma.
//
// Como: ao escolher o chinês ou o hindi, a face "Ergon Noto Sans SC" / "Ergon Noto Sans Devanagari" entra em
// document.fonts SEM load(). O navegador só busca o arquivo quando um caractere da faixa dela (unicode-range) cai nela,
// isto é, quando as fontes do sistema que vêm antes no --font (PingFang SC, Microsoft YaHei, Nirmala UI, Noto…) não
// estão instaladas (styles.css, html[data-escrita]). Os arquivos (Noto, licença OFL) são subconjuntos em woff2 em
// public/fontes: GB2312 no chinês (cerca de 1 MB por peso) e a faixa devanágari inteira no hindi (cerca de 50 KB).
// FontFace e não <style>: a proteção da página aceita fontes do próprio Ergon (font-src 'self').

type Escrita = 'latina' | 'cjk' | 'devanagari';

const FACES: Record<Exclude<Escrita, 'latina'>, { familia: string; arquivo: string; faixa: string }> = {
  cjk: {
    familia: 'Ergon Noto Sans SC', // i18n-ok: nome da fonte (família no CSS), não é texto de tela
    arquivo: 'NotoSansSC',
    // ideogramas, pontuação CJK e as formas de largura cheia (as letras latinas ficam com a fonte da tela)
    faixa: 'U+2E80-2FDF, U+3000-303F, U+3100-312F, U+31C0-31EF, U+3200-33FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF',
  },
  devanagari: {
    familia: 'Ergon Noto Sans Devanagari', // i18n-ok: nome da fonte
    arquivo: 'NotoSansDevanagari',
    faixa: 'U+0900-097F, U+1CD0-1CFF, U+200C-200D, U+20B9, U+25CC, U+A8E0-A8FF',
  },
};

const prontas = new Set<Escrita>();

/** Põe à disposição a fonte da escrita (uma vez por escrita); fora do navegador ou sem FontFace, não faz nada. */
export function carregarFonteDa(escrita: Escrita): void {
  if (escrita === 'latina' || prontas.has(escrita)) return;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return;
  const f = FACES[escrita];
  // i18n-ok: os nomes dos arquivos das fontes (Regular, Bold)
  for (const [peso, nome] of [['400', 'Regular'], ['700', 'Bold']] as const) {
    try {
      document.fonts.add(new FontFace(f.familia, `url(/fontes/${f.arquivo}-${nome}.woff2) format("woff2")`, { weight: peso, style: 'normal', display: 'swap', unicodeRange: f.faixa }));
    } catch { /* navegador sem a face: fica a fonte do sistema */ }
  }
  prontas.add(escrita);
}

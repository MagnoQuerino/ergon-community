/**
 * Os textos de um aplicativo do catálogo das Conexões (descrição, passo a passo, campos) no idioma da tela. O servidor
 * manda o português (integrations.ts e conexoes/conectores); o aplicativo listado aqui ganha as frases do dicionário
 * (i18n/<idioma>/conexoes.ts, "app.<kind>.*"), e o que não está aqui segue como veio. Para traduzir outro aplicativo,
 * acrescente as chaves no dicionário e a linha abaixo.
 */
import type { Chave } from '../i18n/index.ts';
import type { Integration } from './types.ts';

interface TextosDoApp {
  sobre: Chave;
  passos?: Chave;
  /** por campo da credencial (o nome dele): o rótulo e o exemplo */
  campos?: Record<string, { rotulo: Chave; exemplo?: Chave }>;
  /** os rótulos dos links da ajuda, na ordem em que o servidor manda */
  extras?: Chave[];
}

export const TEXTOS_DE_APP: Readonly<Record<string, TextosDoApp>> = {
  gohighlevel: {
    sobre: 'conexoes.app.gohighlevel.sobre', passos: 'conexoes.app.gohighlevel.passos',
    campos: {
      location: { rotulo: 'conexoes.app.gohighlevel.campo.location', exemplo: 'conexoes.app.gohighlevel.campo.locationExemplo' },
      token: { rotulo: 'conexoes.app.gohighlevel.campo.token', exemplo: 'conexoes.app.gohighlevel.campo.tokenExemplo' },
    },
    extras: ['conexoes.app.gohighlevel.ajuda'],
  },
};

/** O aplicativo com os textos no idioma da tela (o mesmo objeto, quando não há tradução para ele). */
export function noIdioma(i: Integration, t: (k: Chave) => string): Integration {
  const x = TEXTOS_DE_APP[i.kind];
  if (!x) return i;
  return {
    ...i,
    about: t(x.sobre),
    help: i.help ? {
      ...i.help,
      steps: x.passos ? t(x.passos) : i.help.steps,
      ...(i.help.extras ? { extras: i.help.extras.map((e, n) => (x.extras?.[n] ? { ...e, rotulo: t(x.extras[n]) } : e)) } : {}),
    } : null,
    fields: i.fields.map((f) => {
      const c = x.campos?.[f.name];
      return c ? { ...f, label: t(c.rotulo), ...(c.exemplo ? { placeholder: t(c.exemplo) } : {}) } : f;
    }),
  };
}

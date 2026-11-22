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
  /** o motivo de estar indisponível aqui (rc.48: o Tally na nuvem) */
  soon?: Chave;
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
  // rc.48: os conectores da Índia
  zoho: { sobre: 'conexoes.app.zoho.sobre' },
  razorpay: {
    sobre: 'conexoes.app.razorpay.sobre', passos: 'conexoes.app.razorpay.passos',
    campos: {
      key_id: { rotulo: 'conexoes.app.razorpay.campo.keyId', exemplo: 'conexoes.app.razorpay.campo.keyIdExemplo' },
      key_secret: { rotulo: 'conexoes.app.razorpay.campo.keySecret', exemplo: 'conexoes.app.razorpay.campo.keySecretExemplo' },
    },
  },
  freshsales: {
    sobre: 'conexoes.app.freshsales.sobre', passos: 'conexoes.app.freshsales.passos',
    campos: {
      dominio: { rotulo: 'conexoes.app.freshsales.campo.dominio', exemplo: 'conexoes.app.freshsales.campo.dominioExemplo' },
      chave: { rotulo: 'conexoes.app.freshsales.campo.chave', exemplo: 'conexoes.app.freshsales.campo.chaveExemplo' },
    },
  },
  tally: {
    sobre: 'conexoes.app.tally.sobre', passos: 'conexoes.app.tally.passos', soon: 'conexoes.app.tally.soNuvem',
    campos: {
      host: { rotulo: 'conexoes.app.tally.campo.host', exemplo: 'conexoes.app.tally.campo.hostExemplo' },
      porta: { rotulo: 'conexoes.app.tally.campo.porta', exemplo: 'conexoes.app.tally.campo.portaExemplo' },
      empresa: { rotulo: 'conexoes.app.tally.campo.empresa', exemplo: 'conexoes.app.tally.campo.empresaExemplo' },
    },
  },
};

/** O aplicativo com os textos no idioma da tela (o mesmo objeto, quando não há tradução para ele). */
export function noIdioma(i: Integration, t: (k: Chave) => string): Integration {
  const x = TEXTOS_DE_APP[i.kind];
  if (!x) return i;
  return {
    ...i,
    about: t(x.sobre),
    ...(x.soon && i.soon ? { soon: t(x.soon) } : {}),
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

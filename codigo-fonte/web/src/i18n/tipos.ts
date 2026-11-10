// Os tipos do dicionário. O português (pt/) é a origem; o inglês (en/) é tipado por ele: chave faltando ou sobrando,
// ou um plural escrito como texto simples, e o TypeScript recusa (a versão nem compila).

/**
 * Texto com número: uma forma para cada caso do idioma (Intl.PluralRules). Só `other` é obrigatório; um caso que faltar
 * usa o `other`. O 0 exato usa `zero` quando há ("Nada aguardando você"); sem ela, SEMPRE o `other` ("0 avisos"),
 * mesmo em português, onde o Intl põe o 0 no singular. O número entra no marcador {n}, já formatado no idioma
 * (1.250 / 1,250); os outros marcadores recebem o número cru.
 */
export interface Plural {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Mensagem = string | Plural;
/** Uma área do dicionário: nome da chave → texto. */
export type Area = { readonly [chave: string]: Mensagem };

/** A mesma área noutro idioma: as mesmas chaves; texto onde o português tem texto, plural onde tem plural. */
export type Traducao<T extends Area> = { readonly [K in keyof T]: T[K] extends string ? string : Plural };

/** Os marcadores {nome} de um texto. */
export type Marcadores<S> = S extends `${string}{${infer N}}${infer R}` ? N | Marcadores<R> : never;

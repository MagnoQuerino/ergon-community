/** Pedaços de esquema JSON das rotas (validação do Fastify). */
export const S = {
  str: (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max }),
  id: (prefix: string) => ({ type: 'string', pattern: `^${prefix}_[a-f0-9]{32}$` }),
};
export const idParams = (prefix: string) => ({ type: 'object', required: ['id'], properties: { id: S.id(prefix) } });
export const strList = (max: number, len: number) => ({ type: 'array', maxItems: max, items: S.str(len, 1) });

// Faz as conferências do dicionário do World (views/world/textos.test.ts) rodarem pelo npm test e pela CI. O módulo
// do World não vai para a Community: lá o arquivo não existe e este teste não faz nada (um padrão a mais no script
// de teste do package.json quebraria, porque não acharia arquivo nenhum).
import fs from 'node:fs';

const world = new URL('../views/world/textos.test.ts', import.meta.url);
if (fs.existsSync(world)) await import(world.href);

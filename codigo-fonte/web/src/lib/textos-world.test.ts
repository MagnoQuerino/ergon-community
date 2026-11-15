// Faz as conferências do dicionário do World (views/world/textos.test.ts) rodarem pelo npm test e pela CI (o script de
// teste do package.json não varre views/world).
await import('../views/world/textos.test.ts');

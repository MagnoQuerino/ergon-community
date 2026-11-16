// Faz as conferências do "Rodar na nuvem" (views/world/nuvem-cartao.test.ts) rodarem pelo npm test e pela CI (o script
// de teste do package.json não varre views/world).
await import('../views/world/nuvem-cartao.test.ts');

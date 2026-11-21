// Faz as conferências do estado da sincronia e da nuvem (views/world/sinc-estado.test.ts) rodarem pelo npm test e pela CI
// (o script de teste do package.json não varre views/world).
await import('../views/world/sinc-estado.test.ts');

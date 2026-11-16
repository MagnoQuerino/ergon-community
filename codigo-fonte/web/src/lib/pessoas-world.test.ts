// Faz as conferências de Pessoas no Ergon World e do carrinho (views/world/pessoas.test.ts) rodarem pelo npm test e
// pela CI (o script de teste do package.json não varre views/world).
await import('../views/world/pessoas.test.ts');

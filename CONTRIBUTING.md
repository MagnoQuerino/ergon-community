# Contribuir

Obrigado pelo interesse no Ergon Community.

## Modelos da comunidade (temas, efeitos, pets, equipes)

É o jeito mais simples de contribuir e não exige programar: veja [docs/LOJA.md](docs/LOJA.md).

## Código

1. Abra uma issue descrevendo o problema ou a ideia antes de um pull request grande.
2. Prepare o ambiente: Node.js 24, Docker e `npm ci` na raiz.
3. Antes de enviar: `npm run typecheck`, `npm test` e, se mexeu no motor ou no Dockerfile, `docker build --target test .`.
4. Mantenha o estilo do código ao redor: TypeScript sem dependências novas sem necessidade, textos da interface em
   português, sem chamadas de rede escondidas (nada sai do computador sem a pessoa pedir).
5. Nunca inclua segredos, tokens ou dados pessoais em código, testes ou capturas. `node scripts/scan-segredos.mjs`
   confere os arquivos versionados.

Ao enviar uma contribuição, você concorda que ela seja distribuída sob a [licença Apache-2.0](LICENSE).

## Segurança

Achou uma falha de segurança? Não abra issue pública: veja [SECURITY.md](SECURITY.md).

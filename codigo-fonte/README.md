# Código-fonte do Ergon Community

Para usar o Ergon, não precisa desta pasta: veja o [README da raiz](../README.md).

```
npm ci
npm test            # servidor e interface
docker build --target test .
```

Rode os comandos aqui, em `codigo-fonte/`. O `ergon.cmd` / `ergon.sh` desta pasta constrói as imagens a partir do
código; o de `instalador/` é o pacote da versão publicada, que baixa as imagens prontas (é o que os instaladores
da raiz usam).

| Pasta | O que é |
|---|---|
| `server/` | servidor Node.js (TypeScript, Fastify, SQLite) |
| `web/` | interface React, com a cidade em Canvas 2D |
| `shared/` | tipos e dados usados pelos dois |
| `hermes/` | motor dos agentes ([Hermes Agent](https://github.com/NousResearch/hermes-agent)) com o plugin do Ergon |
| `desktop/` | aplicativo desktop (Tauri 2) |
| `connectors/` | conectores opcionais (Microsoft Teams) |
| `deploy/local/` | modelo do pacote local publicado a cada versão |
| `instalador/` | o pacote local desta versão, usado pelos instaladores da raiz |
| `scripts/` | backup, restauração, testes do lançador, varredura de segredos, arquivos da marca |
| `docs/` | formato dos pacotes `.ergon` e arquivos da marca |

Como contribuir: [CONTRIBUTING](../.github/CONTRIBUTING.md).

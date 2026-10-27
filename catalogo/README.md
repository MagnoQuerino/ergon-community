# Catálogo dos modelos da comunidade

A aba **Modelos da comunidade** da loja do Ergon lê `index.json` desta pasta e baixa os pacotes de `pacotes/`, sempre
conferindo o tamanho e o SHA-256 listados.

- `pacotes/<criador>/<nome>.ergon`: os modelos enviados.
- `index.json`: gerado por `node catalogo/conferir.mjs --gravar` (não edite à mão).
- `conferir.mjs`: valida cada pacote com as mesmas regras da instalação; a CI roda em cada envio.

Como enviar o seu: [docs/LOJA.md](../docs/LOJA.md).

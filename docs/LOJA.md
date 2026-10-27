# Loja de pacotes e modelos da comunidade

Pacotes `.ergon` mudam a aparência e o ponto de partida do Ergon sem mexer em código: skins da cidade, temas de cores,
efeitos em volta dos personagens, pets e equipes prontas por área.

## Skins oficiais

| Skin | Clima |
| --- | --- |
| Distrito Platina | centro financeiro: torres de vidro, asfalto e a equipe de terno |
| Reino de Brumaverde | fantasia medieval: enxaimel, elfos, duendes, orcs, cogumelos e lagos |
| Base Siroco | quartel no deserto: barracas, sacos de areia, antenas e fardas |
| Enseada Coral | praia: mar, coqueiros, palha, guarda-sóis e roupa de banho |
| Vila Ronrom | tranquilidade: casinhas, cerejeiras, postes acesos e gatos |
| Cromo-9 | futuro de néon: torres escuras, letreiros, implantes e jaquetas iluminadas |

Cada skin muda a cidade de dia e de noite, os prédios, as roupas e a paisagem que nasce quando a cidade cresce, e veste
até 10 agentes com personagens próprios (nome e bio). A função de cada agente não muda. Uma skin por vez; desfazer
devolve os nomes e a cidade de antes. O formato está em [FORMATOS_ERGON.md](FORMATOS_ERGON.md).

## Na loja (Configurações › Pacotes)

- **Oficiais.** Vêm junto com o Ergon, assinados (selo "verificado") e funcionam sem internet.
- **Modelos da comunidade.** Enviados por quem usa o Ergon, listados em [`catalogo/index.json`](../catalogo/index.json)
  deste repositório. A lista só é lida quando você abre a aba; nada sai do computador sozinho. Cada pacote baixado
  precisa ter o tamanho e o SHA-256 do catálogo e passa pela mesma validação de qualquer `.ergon`. Aparece como
  "não verificado": é um pacote de dados (cores, efeitos, pets, equipes), sem código.
- **Sem internet.** A aba da comunidade avisa que não há conexão; tudo o que já está instalado continua igual.
- **Desfazer.** Cada instalação pode ser desfeita em Configurações › Pacotes; conversas, tarefas e rotinas não são
  tocadas.

Também dá para instalar um `.ergon` recebido de alguém (botão "Escolher arquivo .ergon") e criar o seu no editor
(Configurações › Pacotes › Criar), com prévia num agente de verdade.

## Enviar um modelo para a comunidade

1. Crie o pacote no editor do Ergon e baixe o `.ergon`. O `package_id` deve ser `comunidade.<você>.<nome>`, em
   minúsculas (letras, números e hífen).
2. Faça um fork deste repositório e coloque o arquivo em `catalogo/pacotes/<você>/<nome>.ergon`.
3. Rode `node catalogo/conferir.mjs --gravar`: ele valida o pacote como a instalação valida e atualiza
   `catalogo/index.json` (tamanho e SHA-256).
4. Abra um pull request com uma frase sobre o modelo e uma captura de tela da cidade com ele aplicado.

Entram pela loja os tipos `skin`, `city-theme`, `fx`, `pet`, `character-look` e `team-blueprint`. Pacotes com permissões
(skill, plugin) não entram no catálogo. O pacote precisa ter licença compatível com a distribuição livre (por
exemplo Apache-2.0, MIT ou CC-BY-4.0) e não pode usar marcas, nomes ou imagens de terceiros sem permissão.

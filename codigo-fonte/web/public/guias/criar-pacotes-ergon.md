# Como criar um pacote `.ergon`

Guia técnico para quem programa. Um pacote `.ergon` muda a **aparência** da cidade do Ergon (skin, tema de cores,
efeitos, pets, aparência dos bonecos) ou traz uma **equipe pronta** (setores, funções e jeito de trabalhar). Ele é
**só dados**: nada de script, HTML, SVG ou programa, nenhuma permissão, nenhuma senha ou conta.

Para testar: no Ergon, **Configurações › Pacotes › Instalar um pacote .ergon**. A prévia mostra o que muda ou a
lista exata do que está errado. Tudo que você instala pode ser desfeito em **Instalados**.

---

## 1. Estrutura do arquivo

Um `.ergon` é um **ZIP** com esta estrutura:

```
meu-pacote.ergon
├── manifest.json          obrigatório, na raiz
├── data/package.json      os dados do pacote (obrigatório)
└── preview/capa.png       opcional: imagens de prévia (PNG ou WebP, até 1024 px)
```

Regras do ZIP (o Ergon recusa o pacote inteiro se qualquer uma falhar):

- nomes só com minúsculas, números, `.`, `_` e `-`; até 4 níveis de pasta; sem acento, espaço, `..`, `\` ou caminho absoluto;
- só `.json`, `.png` e `.webp` (além do `manifest.json`); PNG/WebP precisam ser de verdade (os bytes são conferidos);
- até 200 arquivos, 20 MB compactado, 40 MB descompactado, compressão no máximo 100×;
- sem link simbólico, sem nome repetido (nem trocando maiúsculas), **nenhum arquivo fora do manifesto**.

## 2. `manifest.json`

```json
{
  "manifest_version": 2,
  "package_id": "comunidade.seunome.cidade-do-por-do-sol",
  "version": "1.0.0",
  "title": "Cidade do pôr do sol",
  "summary": "Tons de laranja e lilás, como no fim da tarde.",
  "creator_id": "seunome",
  "license": "CC-BY-4.0",
  "ergon": { "min": "1.0.0" },
  "kind": "city-theme",
  "tags": ["tema", "pôr do sol"],
  "preview": ["preview/capa.png"],
  "components": [
    { "path": "data/package.json", "sha256": "<sha256 do arquivo, em hex>", "size": 1234, "type": "application/json" },
    { "path": "preview/capa.png", "sha256": "<sha256>", "size": 45678, "type": "image/png" }
  ]
}
```

| campo | regra |
| --- | --- |
| `package_id` | `espaço.criador.nome` (minúsculas, números e hífen). Use `comunidade.<você>.<nome>`; `ergon.oficial.*` é só da loja oficial |
| `version` | semver simples: `1.0.0` |
| `title` / `summary` | até 80 / 600 caracteres; sem HTML |
| `kind` | `skin`, `city-theme`, `fx`, `pet`, `character-look` ou `team-blueprint` |
| `ergon.min` | versão mínima do Ergon (`1.0.0` serve) |
| `components` | **todos** os arquivos do ZIP (menos o manifesto), com `sha256` e `size` exatos |
| `preview` | imagens que aparecem na loja (precisam estar em `components`) |
| `permissions` | **não use**: pacote visual ou de equipe que pede permissão é recusado |
| `signature` | só a loja oficial assina. Sem assinatura, o pacote aparece como "não verificado" (funciona normalmente) |

## 3. `data/package.json` por tipo

`target` (quem recebe): `{ "all": true }`, `{ "agentName": "Hipátia" }` ou `{ "charKey": "hipatia" }`.
Cor: sempre `#rrggbb`.

### `city-theme`: cores da cidade

```json
{ "theme": { "base": "dia", "colors": { "bg": "#e9c9a0", "sky": "#f2a07a", "gold": "#ffcf6a", "outline": "#3a2430" } } }
```

`base`: `dia` ou `noite`. `colors` troca cores do tema (só as que existem). As principais: `bg` (chão), `pebble`,
`grass`, `sky`, `earth` (lotes livres), `outline` (contorno), `shadow`, `gold`, `trim`, `wallBack`, `wallSide`,
`dado`, `grout`, `plazaGrout`.

### `fx`: efeitos nos agentes

```json
{ "effects": [ { "target": { "agentName": "Aristóteles" }, "effect": "aura", "color": "#ffd76a", "intensity": 0.7 } ] }
```

`effect`: `aura`, `fire_circle`, `celestial_glow`, `fire_trail`. `intensity`: 0 a 1. Até 50.

### `pet`: bichos que acompanham os agentes

```json
{ "pets": [ { "target": { "charKey": "arquimedes" }, "species": "gato", "color": "#e8a050" } ] }
```

`species`: `gato`, `coruja`, `cao`, `tartaruga`. Até 50.

### `character-look`: outra aparência sorteada

```json
{ "looks": [ { "target": { "all": true }, "seed": 123456 } ] }
```

`seed`: inteiro de 0 a 2147483647; a mesma semente dá sempre o mesmo boneco.

### `skin`: a cidade inteira com outra cara

A skin é o pacote mais completo: paleta de dia e de noite, arquitetura, roupas, espécies, acessórios, decoração,
água, pets, nomes das estruturas na loja de construção e até 10 personagens que "vestem" os agentes (nome, bio e
aparência; função, regras e ferramentas não mudam). Tudo é escolha num vocabulário fechado:

```json
{ "skin": {
  "id": "cidade-do-por-do-sol",
  "name": "Cidade do Pôr do Sol",
  "tagline": "Telhados de barro, ruas de pedra e a equipe de linho.",
  "structures": { "stoa": { "name": "Casa de Comércio", "common": "prédio de escritórios" } },
  "palette": {
    "dia":   { "seeds": { "ground": "#c9b48a", "ground2": "#b8a57c", "grass": "#8a9a5a", "road": "#8a7660", "plaza": "#e2d4b8", "wall": "#efe2c8", "wallAlt": "#d9b48a", "stone": "#d8ccb4", "marble": "#f4ecdc", "roof": "#b4553a", "wood": "#8a6040", "accent": "#e07a3a", "accent2": "#7a3a5a", "metal": "#a8a0a0", "foliage": "#7a9a4a", "foliage2": "#5a7a3a", "sky": "#f2b48a", "water": "#6aa8c8", "window": "#5a7890", "windowDark": "#3a4a5a", "cloth": "#f2ead8", "flame": "#ffd27a", "outline": "#2a1e1a", "shadow": "#2a1e1a", "flowers": ["#f2a0b0", "#ffd27a"] } },
    "noite": { "seeds": { "...": "as mesmas chaves, com as cores da noite" } }
  },
  "arch": { "roof": "gable", "columns": "classic", "frieze": false, "trim": "timber", "windows": { "extra": 1, "glow": false }, "rooftop": [["nada", 4], ["chimney", 2]] },
  "figures": {
    "species": [["human", 1]], "speciesSkins": {},
    "hairStyles": [["short", 3], ["long", 2]], "beards": [["none", 5], ["short", 1]],
    "headwear": [["none", 6], ["sunhat", 1]], "faces": [["none", 6], ["glasses", 1]],
    "outfits": [ { "id": "linho", "weight": 3, "kit": { "top": "shirt", "bottom": "pants", "sleeves": "short", "shoes": "sandals", "detail": "none", "colors": { "top": "agente", "bottom": "#e8dcc4", "accent": "#ffffff" } } } ],
    "items": [["none", 4], ["book", 1]], "extraHairs": ["#3a2a20", "#c8a070"]
  },
  "decor": { "border": [["olive", 3], ["bush", 2]], "lot": [["nada", 4], ["rock", 1]], "junction": "lamppost", "swap": {} },
  "ground": { "water": 0.1, "roadLine": false },
  "pets": { "chance": 0.15, "species": [["gato", 2], ["cao", 1]] },
  "characters": [
    { "charKey": "aristoteles", "name": "Dona Clara", "bio": "Coordena a casa de comércio com calma e lista na mão.",
      "look": { "species": "human", "skin": 1, "hair": "#3a2a20", "hairStyle": "bun", "beard": "none", "headwear": "none", "face": "glasses", "outfit": "linho", "item": "book" } }
  ],
  "npc": null
} }
```

Pesos: listas de `[valor, peso]` (peso maior = aparece mais). `"agente"` como cor = a cor de identidade do agente.

Vocabulário aceito:

| campo | valores |
| --- | --- |
| espécie (`species`) | `human`, `elf`, `orc`, `gnome` |
| pele (`look.skin`) | 0 a 7 |
| cabelo (`hairStyle`) | `short`, `long`, `bun`, `curly`, `bald`, `ponytail`, `cropped`, `mohawk`, `spiky`, `afro` |
| barba | `none`, `full`, `short` |
| chapéu (`headwear`) | `none`, `wreath`, `fillet`, `petasos`, `helmet`, `beret`, `cap`, `beanie`, `sunhat`, `wizard`, `hood`, `circlet`, `headphones`, `bandana`, `crown`, `visor` |
| rosto (`face`) | `none`, `glasses`, `sunglasses`, `goggles`, `mask`, `implant` |
| item na mão | `none`, `scroll`, `tablet`, `abacus`, `compass`, `satchel`, `staff`, `spear`, `lamp`, `briefcase`, `laptop`, `coffee`, `sword`, `shield`, `book`, `potion`, `radio`, `binoculars`, `clipboard`, `surfboard`, `icecream`, `coconut`, `cat`, `datapad` |
| parte de cima (`kit.top`) | `suit`, `jacket`, `shirt`, `tee`, `tank`, `hoodie`, `sweater`, `robe`, `plate`, `leather`, `uniform`, `swim`, `coat`, `tunic` |
| parte de baixo (`kit.bottom`) | `pants`, `shorts`, `skirt`, `robe`, `trunks` |
| mangas | `long`, `short`, `none` |
| calçado | `shoes`, `boots`, `sneakers`, `sandals`, `bare` |
| detalhe da roupa | `none`, `tie`, `camo`, `neon`, `stripes`, `belt`, `cape`, `trim`, `dots`, `apron` |
| telhado (`arch.roof`) | `keep`, `hip`, `gable`, `parapet`, `flat`, `thatch`, `steep` |
| colunas | `classic`, `pillar`, `post` |
| acabamento (`arch.trim`) | `none`, `timber`, `neon`, `camo`, `stripes`, `glass` |
| no telhado (`rooftop`) | `nada`, `antenna`, `satellite`, `chimney`, `flag`, `solar`, `tank`, `sign`, `lights` |
| decoração | `cypress`, `olive`, `pine`, `bush`, `rock`, `brazier`, `palm`, `parasol`, `cactus`, `tent`, `crates`, `sandbags`, `tower`, `lamppost`, `neon`, `mushroom`, `bigtree`, `crystal`, `menhir`, `cottage`, `cherry`, `watchtower` |
| trocas nas áreas (`decor.swap`) | chaves `olive`, `cypress`, `herm`, `brazier`, `amphora`, `plant` → um item da decoração ou `nada` |
| pets | `gato`, `coruja`, `cao`, `tartaruga` |

`structures` (opcional): nome e tipo de cada estrutura na janela "Construir neste lote", pelo id: `stoa`, `oikos`,
`ergasterion`, `pharmakopoleion`, `didaskaleion`, `oikia`, `emporion`, `bouleuterion`, `agora`, `teatro`, `termas`,
`ginasio`, `bairro`. Só o nome muda; a função é a mesma.

`charKey` dos personagens (quem cada um veste): `aristoteles` (coordenação), `hipatia`, `arquimedes`, `fidias`,
`hesiodo`, `diogenes`, `aspasia`, `hipodamo`, `socrates`, `herodoto`, `euclides`, `platao`.

Limites: id em minúsculas com hífen; `name` até 60; `tagline` até 200; até 10 personagens; a skin inteira até 200 KB.

### `team-blueprint`: uma equipe pronta

A equipe é o "esqueleto" de um workspace: **setores** (com as regras de cada um), **agentes** (nome, função, setor,
jeito de trabalhar, métodos, cor) e **rotinas** sugeridas. Não traz dados, conversas, contas nem ferramentas: os
agentes chegam sem ferramentas novas e as rotinas chegam pausadas. O jeito mais fácil é partir de uma equipe montada:
com o Ergon aberto e você conectado, `GET /api/blueprint/export` devolve o esqueleto do workspace atual nesse formato;
depois ajuste o JSON.

```json
{ "blueprint": {
  "format": "ergon.blueprint", "version": 1, "createdAt": "2026-10-29T12:00:00Z", "ergonVersion": "1.1.0",
  "workspace": { "name": "Escritório de arquitetura" },
  "sectors": [ { "key": "projetos", "name": "Projetos", "description": "Estudos e projetos", "instructions": "Sempre com prazo e escopo.", "createsTasks": "demands" } ],
  "agents": [ { "name": "Vitrúvio", "role": "Projetos e memoriais", "sectorKey": "projetos", "charter": "Você...", "bio": null, "skills": ["Memorial descritivo"], "color": "#2f6f8f", "lookSeed": null, "coordinator": false, "charKey": null } ],
  "structures": [], "routines": []
} }
```

No máximo um agente com `coordinator: true`.

## 4. Montar o arquivo

1. Escreva `data/package.json` (e as imagens de prévia, se quiser).
2. Calcule `sha256` e `size` de cada arquivo. Em Node:

   ```js
   import { createHash } from 'node:crypto';
   import { readFileSync } from 'node:fs';
   for (const p of ['data/package.json', 'preview/capa.png']) {
     const b = readFileSync(p);
     console.log(p, createHash('sha256').update(b).digest('hex'), b.length);
   }
   ```

   No terminal: `sha256sum data/package.json` (Linux), `shasum -a 256 data/package.json` (Mac) ou
   `Get-FileHash data\package.json` (Windows, em minúsculas no manifesto).
3. Preencha `components` no `manifest.json`.
4. Compacte **o conteúdo** da pasta (não a pasta): `zip -X -r meu-pacote.ergon manifest.json data preview`.
5. No Ergon: Configurações › Pacotes › Instalar um pacote .ergon. A prévia lista o que muda ou o que corrigir.

## 5. Erros comuns

- `sha256 não confere` / `tamanho diferente do manifesto`: o arquivo mudou depois de calcular; calcule de novo.
- `arquivo fora do manifesto`: o ZIP tem algo a mais (`.DS_Store`, `Thumbs.db`, pasta `__MACOSX`).
- `nome fora do padrão`: maiúscula, acento ou espaço no nome do arquivo.
- `campo X não permitido`: um campo que não existe nesse tipo de pacote.
- `pacote visual/equipe não pede permissões`: tire `permissions` do manifesto.

## 6. Compartilhar

Mande o `.ergon` para quem quiser. Para aparecer na aba **Comunidade** da loja, publique no catálogo público da
comunidade do Ergon (repositório público, com revisão). Pacotes da comunidade aparecem como "não verificados".

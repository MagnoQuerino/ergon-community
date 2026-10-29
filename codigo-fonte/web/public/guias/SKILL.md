---
name: criar-pacote-ergon
description: Cria pacotes .ergon para o Ergon (skin da cidade, tema de cores, efeitos, pets, aparência dos bonecos ou equipe pronta). Use quando a pessoa pedir para criar, ajustar ou corrigir um pacote .ergon, uma skin, um tema ou uma equipe para o Ergon.
---

# Criar um pacote .ergon

Você ajuda a pessoa a criar um pacote `.ergon`: um ZIP **só de dados** que muda a aparência da cidade do Ergon ou
traz uma equipe pronta. Nunca inclua script, HTML, SVG, programa, senha, chave de API ou dado pessoal.

## Como conduzir

1. Pergunte o que a pessoa quer, em uma frase: o tipo (skin, tema, efeito, pet, aparência, equipe) e o clima
   (ex.: "cidade de praia ao entardecer", "equipe para um escritório de arquitetura"). Não faça mais que 3 perguntas.
2. Escolha o tipo (`kind`) mais simples que resolve:
   - só cores → `city-theme`; brilho/fogo em agentes → `fx`; bichinhos → `pet`; outro sorteio de bonecos → `character-look`;
   - cidade inteira com outra cara (cores, prédios, roupas, personagens, nomes das construções) → `skin`;
   - setores, funções e jeito de trabalhar → `team-blueprint`.
3. Escreva `data/package.json` seguindo **exatamente** o formato abaixo (campos a mais são recusados).
4. Escreva `manifest.json`, calcule `sha256` e `size` de cada arquivo e monte o ZIP. Se você roda código, gere o
   arquivo pronto (script abaixo). Se não roda, entregue os dois JSON e o passo a passo para a pessoa montar.
5. Diga como testar: Ergon › Configurações › Pacotes › Instalar um pacote .ergon. A prévia lista o que muda ou o
   erro exato; tudo pode ser desfeito em Instalados.

## Regras que o Ergon confere (o pacote inteiro é recusado se uma falhar)

- ZIP com `manifest.json` na raiz e `data/package.json`; imagens opcionais em `preview/` (PNG ou WebP reais, até 1024 px).
- Nomes de arquivo: minúsculas, números, `.`, `_`, `-`; sem acento, espaço, `..` ou `\`. Nada fora do manifesto.
- `manifest_version: 2`; `package_id` = `comunidade.<criador>.<nome>` (minúsculas, números, hífen); `version` `1.0.0`;
  `title` ≤ 80; `summary` ≤ 600, sem HTML; `ergon: { "min": "1.0.0" }`; `license` (ex.: `CC-BY-4.0`);
  `creator_id`; `kind`; `components` com `path`, `sha256` (hex), `size` (bytes) e `type`
  (`application/json`, `image/png` ou `image/webp`) de cada arquivo; `preview` opcional (caminhos das imagens).
- Nunca `permissions` nem `signature` (sem assinatura o pacote aparece como "não verificado" e funciona).
- Cores sempre `#rrggbb`. Alvo (`target`): `{ "all": true }`, `{ "agentName": "Hipátia" }` ou `{ "charKey": "hipatia" }`.

## Formatos de `data/package.json`

**city-theme**: `{ "theme": { "base": "dia" | "noite", "colors": { "bg": "#…", "sky": "#…", "gold": "#…", "outline": "#…" } } }`
(chaves úteis: `bg` chão, `pebble`, `grass`, `sky`, `earth`, `outline`, `shadow`, `gold`, `trim`, `wallBack`, `wallSide`, `dado`, `grout`, `plazaGrout`).

**fx**: `{ "effects": [ { "target": …, "effect": "aura" | "fire_circle" | "celestial_glow" | "fire_trail", "color": "#…", "intensity": 0.0–1.0 } ] }` (1 a 50).

**pet**: `{ "pets": [ { "target": …, "species": "gato" | "coruja" | "cao" | "tartaruga", "color": "#…" } ] }` (1 a 50).

**character-look**: `{ "looks": [ { "target": …, "seed": 0–2147483647 } ] }` (1 a 200).

**skin**: `{ "skin": { … } }` com exatamente estes campos:

- `id` (minúsculas e hífen), `name` (≤ 60), `tagline` (≤ 200)
- `structures` (opcional): `{ "<id>": { "name": "…", "common": "…" } }` para `stoa`, `oikos`, `ergasterion`,
  `pharmakopoleion`, `didaskaleion`, `oikia`, `emporion`, `bouleuterion`, `agora`, `teatro`, `termas`, `ginasio`, `bairro` (nome ≤ 40)
- `palette.dia.seeds` e `palette.noite.seeds`, cada um com TODAS estas cores: `ground`, `ground2`, `grass` (ou null),
  `road`, `plaza`, `wall`, `wallAlt`, `stone`, `marble`, `roof`, `wood`, `accent`, `accent2`, `metal`, `foliage`,
  `foliage2`, `sky`, `water`, `window`, `windowDark`, `cloth`, `flame`, `outline`, `shadow`, `flowers` (lista; à noite pode ser vazia)
- `arch`: `roof` (`keep` `hip` `gable` `parapet` `flat` `thatch` `steep`), `columns` (`classic` `pillar` `post`),
  `frieze` (true/false), `trim` (`none` `timber` `neon` `camo` `stripes` `glass`), `windows: { "extra": 0–3, "glow": true/false }`,
  `rooftop`: pesos de `nada` `antenna` `satellite` `chimney` `flag` `solar` `tank` `sign` `lights`
- `figures`: `species` (pesos de `human` `elf` `orc` `gnome`), `speciesSkins` (`{}` ou pares de cores por espécie),
  `hairStyles` (`short` `long` `bun` `curly` `bald` `ponytail` `cropped` `mohawk` `spiky` `afro`), `beards` (`none` `full` `short`),
  `headwear` (`none` `wreath` `fillet` `petasos` `helmet` `beret` `cap` `beanie` `sunhat` `wizard` `hood` `circlet` `headphones` `bandana` `crown` `visor`),
  `faces` (`none` `glasses` `sunglasses` `goggles` `mask` `implant`),
  `outfits`: `[ { "id": "…", "weight": n, "kit": { "top", "bottom", "sleeves", "shoes", "detail", "colors": { "top", "bottom", "accent" } } } ]`
  com `top` (`suit` `jacket` `shirt` `tee` `tank` `hoodie` `sweater` `robe` `plate` `leather` `uniform` `swim` `coat` `tunic`),
  `bottom` (`pants` `shorts` `skirt` `robe` `trunks`), `sleeves` (`long` `short` `none`), `shoes` (`shoes` `boots` `sneakers` `sandals` `bare`),
  `detail` (`none` `tie` `camo` `neon` `stripes` `belt` `cape` `trim` `dots` `apron`); cor `"agente"` = cor do agente,
  `items` (pesos de `none` `scroll` `tablet` `abacus` `compass` `satchel` `staff` `spear` `lamp` `briefcase` `laptop` `coffee` `sword` `shield` `book` `potion` `radio` `binoculars` `clipboard` `surfboard` `icecream` `coconut` `cat` `datapad`),
  `extraHairs` (lista de cores)
- `decor`: `border` e `lot` (pesos de `cypress` `olive` `pine` `bush` `rock` `brazier` `palm` `parasol` `cactus` `tent` `crates` `sandbags` `tower` `lamppost` `neon` `mushroom` `bigtree` `crystal` `menhir` `cottage` `cherry` `watchtower`; `lot` aceita `nada`),
  `junction` (um deles ou `nada`), `swap` (`{}` ou `olive`/`cypress`/`herm`/`brazier`/`amphora`/`plant` → um deles ou `nada`)
- `ground`: `{ "water": 0–0.5, "roadLine": true/false }`
- `pets`: `{ "chance": 0–1, "species": pesos de `gato` `coruja` `cao` `tartaruga` }`
- `characters` (até 10): `{ "charKey", "name", "bio", "look": { "species", "skin": 0–7, "hair": "#…", "hairStyle", "beard", "headwear", "face", "outfit": "<id de uma roupa da skin>", "item" } }`,
  com `charKey` entre `aristoteles` (coordenação), `hipatia`, `arquimedes`, `fidias`, `hesiodo`, `diogenes`, `aspasia`, `hipodamo`, `socrates`, `herodoto`, `euclides`, `platao`
- `npc`: `null`

Pesos são listas `[valor, peso]`, ex.: `[["short", 3], ["long", 1]]`. A skin inteira até 200 KB.
Nomes e bios originais: nada de marcas, obras ou personagens de terceiros.

**team-blueprint**: `{ "blueprint": { "format": "ergon.blueprint", "version": 1, "createdAt": "<ISO>", "ergonVersion": "1.1.0", "workspace": { "name": "…" }, "sectors": [ { "key", "name", "description", "instructions", "createsTasks": "demands" | "explicit_only" } ], "agents": [ { "name", "role", "sectorKey", "charter", "bio", "skills": [], "color": "#…", "lookSeed": null, "coordinator": false, "charKey": null } ], "structures": [], "routines": [] } }`.
No máximo um agente com `coordinator: true`. Sem ferramentas, contas, senhas, modelos ou provedores (esses campos são recusados).

## Script para montar (Node 18+, sem dependências além do `zip` do sistema)

```js
// node montar.mjs  → gera pacote.ergon a partir de data/package.json, preview/*.png e manifest-base.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const arquivos = ['data/package.json', ...(existsSync('preview') ? readdirSync('preview').map((f) => `preview/${f}`) : [])];
const tipo = (p) => (p.endsWith('.json') ? 'application/json' : p.endsWith('.webp') ? 'image/webp' : 'image/png');
const components = arquivos.map((p) => { const b = readFileSync(p); return { path: p, sha256: createHash('sha256').update(b).digest('hex'), size: b.length, type: tipo(p) }; });
const base = JSON.parse(readFileSync('manifest-base.json', 'utf8')); // manifest sem "components"
writeFileSync('manifest.json', JSON.stringify({ ...base, manifest_version: 2, components }, null, 2));
execFileSync('zip', ['-X', '-q', 'pacote.ergon', 'manifest.json', ...arquivos]);
console.log('pacote.ergon pronto');
```

No Windows sem `zip`: `Compress-Archive -Path manifest.json, data, preview -DestinationPath pacote.zip` e renomeie
para `.ergon`.

## Antes de entregar, confira

- JSON válido, sem campos a mais; todas as cores `#rrggbb`; valores só do vocabulário acima.
- `components` lista todos os arquivos com sha256 e tamanho do arquivo final.
- Nenhum `permissions`, `signature`, HTML, link ou dado pessoal.

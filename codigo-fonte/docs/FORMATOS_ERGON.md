# Formato `.ergon` (versão 2)

Código: `server/src/services/ergon-package.ts` (validar e montar), `server/src/services/packages.ts` (instalar e
desfazer); testes: `server/test/pacotes.test.ts`.

## Conteúdo

```
nome.ergon (ZIP)
├── manifest.json          obrigatório
├── data/package.json      dados do tipo (obrigatório nos visuais e de equipe)
└── preview/*.png|webp     prévia (até 1024 px)
```

`manifest.json`: `manifest_version` 2 (sem assinatura: comunidade, exportar do editor) ou 3 (assinado pela loja
oficial; veja abaixo), `package_id` (`comunidade.<criador>.<nome>` ou `ergon.oficial.<nome>`),
`version` (semver), `title`, `summary`, `creator_id`, `license`, `ergon.min`, `kind`, `components` (caminho, sha256,
tamanho e tipo de cada arquivo), `preview`, `dependencies`, `capability_requirements`, `permissions` (só skill/plugin)
e `signature` opcional (`{ alg: "ed25519", key_id, sig }`).

### Assinatura (versão 3)

A assinatura é Ed25519 sobre o SHA-256 de `ergon-package-v3\n` seguido do manifesto inteiro, sem `signature`, em JSON
canônico **profundo**: chaves em ordem em todos os níveis (inclusive dentro de `components`, `ergon`, `dependencies`),
listas na ordem delas, sem espaços (`canonicalJson` em `server/src/services/ergon-package.ts`). Como cada componente
leva o sha256 e o tamanho do arquivo, a assinatura cobre todos os arquivos do pacote.

A versão 2 assinava com um replacer em lista no `JSON.stringify`, que apagava as chaves dos objetos aninhados (os
`components` viravam `{}`): dava para trocar um arquivo e o sha256 dele sem a assinatura perceber. Por isso:

- pacote v2 **assinado** é recusado ("pacote oficial de uma versão antiga"): só a loja oficial assina, a versão nova
  vem com o Ergon, e o que já estava instalado continua funcionando (fica guardado no banco, não é conferido de novo);
- pacote v2 **sem assinatura** continua entrando como "não verificado", como qualquer pacote da comunidade;
- trocar o número da versão não aproveita a assinatura antiga: `manifest_version` faz parte do que é assinado;
- `signature` ausente, `null` ou outro valor falso conta como sem assinatura ("não verificado"), nos dois formatos.

O formato 3 é só do pacote **assinado**. Sem assinatura não há nada a proteger, e as versões anteriores do Ergon
recusam qualquer número diferente de 2; por isso pacote sem assinatura (modelos da comunidade, exportar do editor)
continua saindo no formato 2, e `catalogo/conferir.mjs` da Community recusa modelo no formato 3 (o catálogo é um só
para todas as versões).

Os oficiais são reassinados sem mudar o conteúdo com
`ERGON_SECRETS_DIR=<pasta da chave> node scripts/catalogo/gerar-oficiais.mjs --reassinar`. Um pacote no formato 2 só
é reassinado se for byte a byte igual ao que está no Git (`--base=<ref>`, padrão `HEAD`): a assinatura antiga não
cobria os arquivos, então ela sozinha não prova que o conteúdo é o oficial. Use como base uma versão publicada (por
exemplo a tag da última versão) quando houver dúvida sobre o `HEAD`.

O World guarda o selo `verified` de cada versão no envio. Na partida ele confere de novo os pacotes guardados
(`Marketplace.revalidateStored`) e tira o selo de quem não passa mais (os oficiais antigos no formato 2). Para enviar
os oficiais reassinados ao World, suba a versão deles (ex.: `1.0.1`): a mesma versão não pode ser enviada duas vezes.

## Tipos e dados

| kind | data/package.json | instala nesta versão |
| --- | --- | --- |
| `skin` | `skin` (shared/skin.ts): cores-semente de dia e de noite, arquitetura, roupas por peças, espécies, acessórios, decoração, água, pets e até 10 personagens (nome, bio e aparência) | sim (uma por vez; trocar devolve os nomes da anterior; desfazer volta tudo) |
| `city-theme` | `theme: { base: dia|noite, colors: { chave: #rrggbb } }` | sim (um por vez; desfazer devolve o anterior) |
| `fx` | `effects: [{ target, effect: aura|fire_circle|celestial_glow|fire_trail, color, intensity 0..1 }]` | sim |
| `pet` | `pets: [{ target, species: gato|coruja|cao|tartaruga, color }]` | sim |
| `character-look` | `looks: [{ target, seed }]` (aparência pela semente, sem trocar o renderizador) | sim |
| `team-blueprint` | `blueprint` (esqueleto do workspace: setores, funções e rotinas, sem dados) | sim (agentes sem ferramentas, rotinas pausadas) |
| `building-pack`, `clothing`, `accessory`, `routine-blueprint` | — | valida o manifesto; instalação em versão futura |
| `skill`, `plugin` | permissões declaradas | **não** (exigem revisão, isolamento e consentimento próprios) |

`target`: `{ all: true }`, `{ agentName }` ou `{ charKey }`.

## Skins

Uma skin é só aparência: muda as cores, os prédios (telhado, colunas, acabamento, o que fica no telhado), as roupas
e os bonecos que o gerador sorteia, a paisagem que nasce conforme a cidade cresce e veste até 10 agentes com um
personagem (nome e bio; função, regras e ferramentas não mudam). Tudo é parâmetro sobre um vocabulário fechado
(`shared/skin.ts`): pesos e partes. Uma skin nova é só dado; uma peça nova do vocabulário ganha o desenho em
`web/src/iso/figureParts.ts`, `buildingArt.ts` ou `decorArt.ts`. As seis oficiais estão em `shared/skins-oficiais.ts`.

## Segurança

Recusado: caminho absoluto, `..`, barra invertida, caractere fora do ASCII simples, mais de 4 níveis, nome repetido
(ignorando maiúsculas), link simbólico, mais de 200 arquivos, pacote > 20 MB ou > 40 MB descompactado, taxa de
compressão > 100 (bomba de ZIP), extensão fora de json/png/webp (SVG, HTML, JS…), PNG/WebP que não são, imagem acima
de 1024 px, sha256/tamanho diferente do manifesto, arquivo fora do manifesto, permissão em pacote visual, texto com
conteúdo ativo, assinatura de chave desconhecida, em formato desconhecido, que não confere ou do formato antigo
(v2). Sem assinatura = "não verificado" (escolha
consciente, só dados).

## Desfazer

Cada instalação guarda o que mudou (tema anterior, sementes anteriores, coordenação anterior, agentes e rotinas
criados). Desfazer devolve isso; conversas, tarefas e rotinas da pessoa não são tocadas.

## Criar um pacote

Configurações › Pacotes › Criar o seu pacote oferece dois arquivos para baixar (em `web/public/guias/`): o guia técnico
(`criar-pacotes-ergon.md`, para quem programa: formato, cada tipo, vocabulário da skin e como montar o ZIP) e um
`SKILL.md` para colocar numa IA, que passa a saber criar e conferir o pacote. O editor de efeitos que existia na tela
saiu; `POST /api/packages/build` continua para os testes e para exportar.

## Prévias na loja

Skins e temas aparecem como uma "foto" da cidade (`web/src/iso/cityThumb.ts`: chão, rua, três prédios e três
moradores desenhados pelo mesmo código da cidade com a paleta e a arquitetura do pacote); equipes, com os setores e os
retratos; efeitos e pets, num agente animado. O catálogo manda os dados para isso em `preview` (`skin`, `theme`,
`agents`, `sectors`).

## Nomes das estruturas na skin

`skin.structures` (opcional) dá nome e tipo a cada estrutura na janela "Construir neste lote", pelo id do catálogo
(`shared/city.ts`); a miniatura usa a arquitetura e as cores da skin. Só aparência. As skins oficiais instaladas antes
desse campo pegam os nomes da versão atual pelo id.

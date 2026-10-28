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

`manifest.json`: `manifest_version` 2, `package_id` (`comunidade.<criador>.<nome>` ou `ergon.oficial.<nome>`),
`version` (semver), `title`, `summary`, `creator_id`, `license`, `ergon.min`, `kind`, `components` (caminho, sha256,
tamanho e tipo de cada arquivo), `preview`, `dependencies`, `capability_requirements`, `permissions` (só skill/plugin)
e `signature` opcional (Ed25519 sobre o manifesto canônico sem a assinatura).

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
conteúdo ativo, assinatura de chave desconhecida ou que não confere. Sem assinatura = "não verificado" (escolha
consciente, só dados).

## Desfazer

Cada instalação guarda o que mudou (tema anterior, sementes anteriores, coordenação anterior, agentes e rotinas
criados). Desfazer devolve isso; conversas, tarefas e rotinas da pessoa não são tocadas.

## Editor simples

Configurações › Pacotes › Criar monta um efeito, um pet ou as cores da cidade sem sair do aplicativo, com uma prévia
animada num agente de verdade (o mesmo desenho da cidade, `web/src/iso/cosmetics.ts`, a qualquer hora do dia). O servidor
(`POST /api/packages/build`, só com sessão) gera o `.ergon` com `package_id` `comunidade.local.<nome>`, valida com as
mesmas regras da instalação e devolve o arquivo. "Ver na cidade" instala (com desfazer); "Baixar .ergon" salva para
guardar ou compartilhar. Sai sem assinatura da loja ("não verificado"). O editor só monta tipos visuais: aparência,
equipe, skill e plugin ficam de fora.

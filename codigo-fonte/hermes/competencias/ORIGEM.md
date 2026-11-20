# Competências de terceiros na biblioteca do motor

Estas pastas entram na imagem do motor em `/opt/hermes/skills/<categoria>/<nome>` e chegam à biblioteca de competências
de cada instalação pela sincronia do próprio motor. Ficam DESLIGADAS: nenhum agente as carrega (nem gasta tokens com
elas) até a pessoa ligar a competência no agente, no Ergon. Só texto (Markdown e roteiros curtos de apoio); nenhuma
exige chave de terceiros nem roda sozinha.

| Origem | Commit | Licença | O que entrou |
|---|---|---|---|
| github.com/addyosmani/agent-skills | 8c99fa36d90068c82d547f7c12a9d67a3e95f4ee | MIT (`licencas/addyosmani-agent-skills.LICENSE`) | `skills/*` em `software-development/`, sem `test-driven-development` (o motor já traz uma com esse nome) e sem `browser-testing-with-devtools` e `source-driven-development` (a varredura de segurança do motor as marca como perigosas) |
| github.com/moonlight-lupin/agent-skills | e943e3285cd03c44b2c762a9a52328e3d16444b1 | MIT (`licencas/moonlight-lupin-agent-skills.LICENSE`) | `productivity/task-brief` e `mlops/paired-agent-eval` (em `software-development/`); `devops/disk-triage` ficou de fora (comandos de apagar: a varredura do motor a marca como perigosa) |

Sem alterações no conteúdo; cada pasta ganhou só o arquivo vazio `.ergon-de-fora` (marca o que a construção da imagem confere). Para atualizar: copie as pastas do commit novo, atualize esta tabela e rode os testes da
imagem (o Dockerfile recusa nome repetido na biblioteca, competência sem cabeçalho e o que a varredura de segurança do motor marcar como perigoso).

Ficou de fora, de propósito:
- do moonlight-lupin, o que traz programas em Python, pede chaves de outros serviços ou mexe em dados pessoais
  (enriquecimento de pessoas, raspagem de sites, organizador de arquivos…), e os plugins (lumen, skill-retrieval,
  skill-governance, dev-pipeline), que rodam código dentro do motor: cada um precisa de revisão própria antes de ir a
  clientes;
- github.com/OthmanAdi/planning-with-files: depende de roteiros e ganchos feitos para outros agentes (Claude Code,
  Codex…); o motor já tem a lista de tarefas e os planos próprios;
- github.com/rtk-ai/rtk: já está no motor desde a rc.36 (edição OSS, Apache-2.0), ver o Dockerfile.

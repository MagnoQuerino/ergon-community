# Motor dos agentes

O motor que executa os agentes do Ergon é o [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT, Nous
Research), numa imagem estendida por este diretório:

- **Imagem base fixada** por versão e digest em `Dockerfile`.
- **Cofre** (`vault/ergon-vault.py`): antes do ponto de entrada, abre um volume cifrado (gocryptfs) com a chave do
  Ergon; os dados do motor ficam cifrados no volume e só abertos na memória do contêiner. Depois de montar, o
  processo abre mão do privilégio de montagem, e nada que roda depois (o motor, ou o que um agente executar) o recupera.
- **Plugin `ergon_bridge`** (`plugins/ergon_bridge`): liga o motor ao Ergon (eventos dos canais, tarefas) e trava, por
  agente, as ferramentas que ele pode usar. Ferramentas como Terminal e Executar código só são liberadas com a senha
  de quem administra o Ergon.
- **Sem portas publicadas.** A API do motor só é alcançável pelo Ergon, na rede interna do Docker. A chave da API vem
  de `~/.ergon/secrets`, gerada na instalação.
- **Um motor por pessoa.** Cada conta do Ergon neste computador tem o próprio contêiner do motor, com cofre e conta de
  IA próprios, criado pelo gerente de motores.

A conta de IA (Nous Portal ou a assinatura do ChatGPT) é conectada pela interface, em **Configurações › IA da
equipe**. A telemetria compartilhada do motor vem desligada na versão fixada.

Testes do plugin e do cofre: `tests/` (rodam na CI, dentro da imagem).

# Segurança

## Relatar uma falha

Use **Security › Report a vulnerability** neste repositório (aviso privado do GitHub). Descreva o que encontrou, a
versão e, se puder, os passos para reproduzir. Não publique detalhes antes da correção.

## Como o Ergon se protege

- **Só neste computador.** O Ergon responde em `http://localhost:8787`; os contêineres não ficam expostos na rede.
- **Dados cifrados.** Banco, campos sensíveis, arquivos e credenciais das conexões são cifrados com uma chave
  protegida pela sua senha. A frase de recuperação de 24 palavras é a única outra forma de abrir os dados.
- **Acesso.** Sessões com expiração, 2º fator opcional (autenticador TOTP ou passkey), confirmação da senha para
  ações sensíveis e trava por inatividade (opcional).
- **Motor isolado.** O motor dos agentes roda em contêiner próprio, com volume cifrado e sem privilégios extras;
  ferramentas como Terminal e Executar código só são liberadas com a sua senha, agente por agente.
- **Documentos hostis.** Arquivos enviados às rotinas são lidos num processo isolado, com limites de tamanho, tempo e
  memória.
- **Pacotes.** `.ergon` são só dados (sem scripts), validados arquivo por arquivo; os oficiais são assinados.
- **Nada seu sai sozinho.** Fora a conta de IA e as conexões que você liga, a única consulta automática é o aviso de
  versão nova: o `latest.json` da página de versões no GitHub, no máximo a cada 6 h, sem nenhum dado seu. O catálogo
  da comunidade só é lido quando você abre a aba.

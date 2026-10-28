# Novidades

## 1.1.0-rc.1 (pré-versão de teste)

- **Windows sem Docker:** o Ergon Desktop instala o Ergon inteiro sozinho. Ele cria um ambiente próprio no WSL do
  Windows (com o Docker dentro, sem Docker Desktop), baixa os componentes conferindo a assinatura de cada um,
  retoma downloads interrompidos e continua sozinho depois de um reinício. O Ergon só aparece para este computador.
- Pré-versão: não aparece para quem usa `ergon atualizar` nem como "versão mais recente". Para testar, baixe o
  instalador `.exe` desta página.
- Repositório organizado: na raiz ficam os instaladores e os guias; o código foi para `codigo-fonte/`.

## 1.0.1

- `ergon instalar` instala o Ergon numa pasta sua e põe o comando `ergon` no PATH: depois disso, `ergon` funciona
  de qualquer terminal e a pasta do zip pode ser apagada.
- `ergon remover` tira o Ergon do computador e guarda os dados (instalar de novo volta de onde parou);
  `ergon remover --tudo` apaga tudo, com confirmação.

## 1.0.0

Primeira versão pública do Ergon Community.

- Equipe de doze agentes com coordenação, conversa, quadro de tarefas e conclusão só com evidência.
- Cidade em pixel art com os agentes trabalhando, prédios, andares e personalização.
- Rotinas prontas (briefing, prazos, compromissos, contratos, conferência financeira e outras), com o que foi lido e
  conferido sempre à vista.
- Treinar: competências ensinadas a um agente, com revisão e aprovação antes do uso.
- Conexões com apps de tarefas, Microsoft 365 e Google (leitura) e WhatsApp experimental (somente leitura, com
  informações e riscos antes de conectar).
- Seis skins da cidade: Distrito Platina, Reino de Brumaverde, Base Siroco, Enseada Coral, Vila Ronrom e Cromo-9, com
  prédios, roupas, paisagem e personagens próprios.
- Loja de pacotes: oficiais assinados que vêm junto e funcionam sem internet; modelos da comunidade sob demanda.
- Dados cifrados com a sua senha, frase de recuperação, 2º fator opcional, backup conferido e restauração com desfazer.
- Instalação em Docker (Windows, macOS e Linux) e aplicativo desktop (Windows e Linux) na mesma versão.

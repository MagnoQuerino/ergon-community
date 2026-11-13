-- Aplicativos conectados pela pessoa (rc.29, services/mcp-proprio.ts): um servidor MCP que o catálogo de aplicativos
-- prontos não traz, ligado em Conexões › Conectar outro aplicativo. O servidor em si fica no motor de IA (mcp_servers do
-- config.yaml, dentro do cofre); as chaves (cabeçalhos e variáveis) ficam só no .env do cofre do motor. Aqui fica o que a
-- tela mostra e o que a trava de ferramentas precisa: o nome do aplicativo e o apelido da conta (o mesmo aplicativo pode
-- ser conectado várias vezes, uma conta por linha), o ícone, como conecta (endereço ou programa, cifrados como os outros
-- dados da pessoa), os NOMES das chaves (nunca os valores) e as ferramentas que o último teste encontrou, cada uma com a
-- classe sugerida e a escolhida pela pessoa (leitura, escrita ou envio em nome dela).
-- Várias contas do mesmo aplicativo seguem o modelo geral das Conexões (0046): chave_app junta as contas de um aplicativo
-- (o nome sem acento nem maiúscula); conta = '' é a principal (a que vale quando ninguém diz qual), as outras têm o id
-- curto ("c" + 8 letras e números); apelido é o nome que a pessoa deu à conta (cifrado), único dentro do aplicativo.
CREATE TABLE mcp_proprios (
  workspace_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  app TEXT NOT NULL,
  chave_app TEXT NOT NULL,
  conta TEXT NOT NULL DEFAULT '' CHECK (conta = '' OR (length(conta) = 9 AND substr(conta, 1, 1) = 'c' AND substr(conta, 2) NOT GLOB '*[^0-9a-f]*')),
  apelido TEXT,
  icone TEXT,
  transporte TEXT NOT NULL,
  endereco TEXT,
  comando TEXT,
  argumentos TEXT NOT NULL DEFAULT '[]',
  segredos TEXT NOT NULL DEFAULT '[]',
  ferramentas TEXT NOT NULL DEFAULT '[]',
  testado_em TEXT,
  erro TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, nome),
  UNIQUE (workspace_id, chave_app, conta)
);

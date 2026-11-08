# WhatsApp (experimental)

O Ergon pode ler conversas do WhatsApp para transformar pedidos em tarefas para a equipe. O recurso é
**experimental** e fica desligado até você ler as informações e os riscos e confirmar, em **Conexões**.

## Como funciona

- Você lê um QR code com o celular (WhatsApp › Aparelhos conectados › Conectar um aparelho) e este computador vira
  um aparelho conectado da sua conta, como o WhatsApp Web.
- A conexão usa o [Baileys](https://github.com/WhiskeySockets/Baileys), uma biblioteca de código aberto que **não é
  oficial** nem aprovada pelo WhatsApp ou pela Meta.
- **Envio só quando pedido:** os agentes enviam da sua conta quando você pede ou confirma num cartão. Se você ligar
  "Liberar tudo" em Conexões, o que não partiu de você (uma rotina, uma mensagem recebida) também pode sair sem cartão.
  Ler não marca como lido e você não aparece "online".
- Filtros: conversas individuais, grupos (desligados no começo), etiquetas do WhatsApp Business e exceções por nome
  ou número ("Família", por exemplo).

## Riscos

- **Enviar aumenta o risco:** mensagens automáticas e denúncias de quem recebe podem levar a restrição ou banimento. Evite escrever a quem nunca falou com você.
- **O número pode ser restringido ou banido.** Os termos do WhatsApp não permitem clientes não oficiais. Use um
  número de trabalho ou secundário.
- **Pode parar de funcionar sem aviso** quando o WhatsApp muda a forma de conectar.
- **A sessão fica neste computador**, cifrada com os seus dados. Quem tiver acesso a ela lê as suas conversas como
  aparelho conectado. Os backups do Ergon levam a sessão junto (cifrada).
- **As mensagens lidas vão para o modelo de IA** que você configurou, para identificar pedidos. Respeite a
  privacidade de quem fala com você (LGPD).
- **Licença diferente:** a biblioteca depende da libsignal-node, sob GPL-3.0, distribuída junto com este recurso
  (veja o [NOTICE](../NOTICE)).

## Parar

Em Conexões, "Desconectar (sai do aparelho)" encerra a sessão e apaga a cópia local. Você também pode remover o
aparelho no celular, em Aparelhos conectados.

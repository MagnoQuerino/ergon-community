// Carregado antes de todo arquivo de teste: sem endereço do Ergon World, salvo quando o teste liga um World falso.
process.env.ERGON_WORLD_URL ??= '';
// nem do receptor de relatos ("Relatar um problema"): vazio = envio indisponível; os testes usam um receptor falso
process.env.ERGON_RELATOS_URL ??= '';

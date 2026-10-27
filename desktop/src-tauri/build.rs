fn main() {
    // Os comandos nativos passam a exigir permissão explícita (capabilities/principal.json): só a tela de abertura,
    // que vem de dentro do aplicativo, recebe. A interface do Ergon, carregada de localhost, não recebe nenhum.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "diagnosticar",
            "subir_servicos",
            "abrir_ergon",
            "abrir_no_navegador",
            "abrir_ajuda",
            "abrir_registros",
        ]),
    ))
    .expect("falha ao preparar o Tauri");
}

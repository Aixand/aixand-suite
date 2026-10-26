fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connection_settings",
            "save_connection_settings",
            "connect_workspace",
            "local_runtime_info",
            "local_runtime_setup",
            "select_local_workspace",
            "cleanup_context",
            "cleanup_components",
            "cleanup_finish",
        ]),
    ))
    .expect("could not build Aixand desktop permissions");
}

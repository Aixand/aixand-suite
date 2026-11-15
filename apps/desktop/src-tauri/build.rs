#[path = "native-updater/src/build_metadata.rs"]
mod build_metadata;

fn main() {
    for name in [
        "AIXAND_CLIENT_UPDATE_CONFIG",
        "AIXAND_CLIENT_VERSION",
        "AIXAND_CLIENT_SEQUENCE",
        "AIXAND_CLIENT_UPDATE_METADATA",
        "TAURI_CONFIG",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let base: serde_json::Value =
        serde_json::from_slice(&std::fs::read("tauri.conf.json").unwrap()).unwrap();
    let overlay: serde_json::Value = std::env::var("TAURI_CONFIG")
        .map(|v| serde_json::from_str(&v).expect("valid selected Tauri config"))
        .unwrap_or(serde_json::Value::Null);
    let selected = overlay
        .get("version")
        .unwrap_or(&base["version"])
        .as_str()
        .expect("selected Tauri version must be an exact version string");
    let config = std::env::var("AIXAND_CLIENT_UPDATE_CONFIG")
        .unwrap_or_else(|_| "client-update-config.json".into());
    println!("cargo:rerun-if-changed={config}");
    let version = std::env::var("AIXAND_CLIENT_VERSION").ok();
    let sequence = std::env::var("AIXAND_CLIENT_SEQUENCE").ok();
    let (metadata, baked) = build_metadata::metadata(
        selected,
        version.as_deref(),
        sequence.as_deref(),
        &std::fs::read(config).expect("read public Client trust config"),
    )
    .expect("valid baked Client release identity");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(output.join("client-update-config.json"), baked).unwrap();
    let metadata_bytes = serde_json::to_vec_pretty(&metadata).unwrap();
    std::fs::write(output.join("client-update-metadata.json"), &metadata_bytes).unwrap();
    if let Some(destination) = std::env::var_os("AIXAND_CLIENT_UPDATE_METADATA") {
        std::fs::write(destination, &metadata_bytes)
            .expect("write public Client packaging metadata");
    }
    println!(
        "cargo:rustc-env=AIXAND_CLIENT_VERSION={}",
        metadata["version"].as_str().unwrap()
    );
    println!(
        "cargo:rustc-env=AIXAND_CLIENT_SEQUENCE={}",
        metadata["sequence"].as_u64().unwrap()
    );
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "client_request",
            "client_socket_open",
            "client_socket_send",
            "client_reset",
            "connection_settings",
            "save_connection_settings",
            "connect_workspace",
            "local_runtime_info",
            "local_runtime_setup",
            "select_local_workspace",
            "cleanup_context",
            "cleanup_components",
            "cleanup_finish",
            "application_updates",
            "component_updates",
        ]),
    ))
    .expect("could not build Aixand desktop permissions");
}

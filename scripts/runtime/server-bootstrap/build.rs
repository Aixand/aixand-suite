use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=AIXAND_SERVER_PAYLOAD");
    println!("cargo:rerun-if-env-changed=AIXAND_SERVER_PAYLOAD_SHA256");
    let generated = if let Ok(path) = env::var("AIXAND_SERVER_PAYLOAD") {
        println!("cargo:rerun-if-changed={path}");
        let hash = env::var("AIXAND_SERVER_PAYLOAD_SHA256").expect("Payload SHA256 required");
        assert!(hash.len() == 64 && hash.bytes().all(|value| value.is_ascii_hexdigit()));
        let bytes: Vec<u8> = (0..32)
            .map(|index| u8::from_str_radix(&hash[index * 2..index * 2 + 2], 16).unwrap())
            .collect();
        format!(
            "const EMBEDDED_PAYLOAD: &[u8] = include_bytes!({path:?});\nconst EMBEDDED_SHA256: [u8; 32] = {bytes:?};\n"
        )
    } else {
        "const EMBEDDED_PAYLOAD: &[u8] = &[];\nconst EMBEDDED_SHA256: [u8; 32] = [0; 32];\n".into()
    };
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("payload.rs"),
        generated,
    )
    .unwrap();
}

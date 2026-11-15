fn main() {
    println!("cargo:rerun-if-changed=auth_directory.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new()
            .file("auth_directory.c")
            .compile("auth_directory");
        println!("cargo:rustc-link-lib=advapi32");
    }
}

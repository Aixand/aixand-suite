//! Signed full Client packages are handed to the owning operating system.
pub mod build_metadata;
#[cfg(test)]
#[path = "../../src/component_refresh.rs"]
mod component_refresh;
pub mod engine;
#[cfg(test)]
#[path = "../../src/launcher.rs"]
mod launcher_authorization;
mod private_files;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.into()) }
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub schema: u8,
    pub enabled: bool,
    pub origin: String,
    pub keys: BTreeMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Envelope {
    schema: u8,
    key_id: String,
    payload: String,
    signature: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct License {
    pub product: String,
    pub text: String,
    pub sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub build: String,
    pub kind: String,
    pub licenses: Vec<License>,
    pub products: Vec<Value>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Release {
    schema: u8,
    api_protocol: u8,
    product: String,
    pub sequence: u64,
    pub version: String,
    path_version: String,
    published_at: String,
    issued_at: String,
    expires_at: String,
    pub notes: String,
    pub artifacts: BTreeMap<String, Artifact>,
}
impl Trust {
    pub fn url(&self, address: &str) -> Result<Url, String> {
        let origin = Url::parse(&self.origin).map_err(|e| e.to_string())?;
        let url = Url::parse(address).map_err(|e| e.to_string())?;
        ensure(
            self.schema == 1
                && origin.scheme() == "https"
                && origin.origin().ascii_serialization() == self.origin
                && url.scheme() == "https"
                && url.origin() == origin.origin()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Update address is outside the trusted release origin.",
        )?;
        Ok(url)
    }
}
impl Release {
    pub fn identity(&self) -> String {
        let mut value = serde_json::to_value(self).unwrap();
        value.as_object_mut().unwrap().remove("issuedAt");
        value.as_object_mut().unwrap().remove("expiresAt");
        digest(&serde_json::to_vec(&value).unwrap())
    }
}
pub fn verify(
    envelope: &Envelope,
    trust: &Trust,
    target: &str,
    floor: u64,
    previous: Option<&str>,
    now: i64,
) -> Result<Release, String> {
    ensure(
        trust.enabled,
        "Client updates are not published for this installation.",
    )?;
    trust.url(&trust.origin)?;
    ensure(
        envelope.schema == 1
            && envelope.payload.len() <= 1024 * 1024
            && envelope.signature.len() <= 128,
        "Invalid signed release envelope.",
    )?;
    let key = trust
        .keys
        .get(&envelope.key_id)
        .ok_or("Unknown update signing key.")?;
    let key = VerifyingKey::from_public_key_pem(key).map_err(|_| "Invalid Ed25519 public key.")?;
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "Invalid release signature encoding.")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "Invalid Ed25519 signature.")?;
    key.verify_strict(envelope.payload.as_bytes(), &signature)
        .map_err(|_| "Release signature verification failed.")?;
    let release: Release = serde_json::from_str(&envelope.payload).map_err(|e| e.to_string())?;
    ensure(
        release.schema == 1
            && release.api_protocol == 1
            && release.product == "aixand-client"
            && release.sequence > 0
            && release.sequence <= 9_007_199_254_740_991
            && release.sequence >= floor,
        "Release role or sequence mismatch; rollback refused.",
    )?;
    let version = &release.version;
    let (core, prerelease) = version
        .split_once('-')
        .map_or((version.as_str(), None), |(core, pre)| (core, Some(pre)));
    let numeric = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|c| c.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    };
    ensure(
        version.len() <= 100
            && core.split('.').count() == 3
            && core.split('.').all(numeric)
            && prerelease.is_none_or(|pre| {
                pre.split('.').all(|part| {
                    !part.is_empty()
                        && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                        && (!part.bytes().all(|c| c.is_ascii_digit()) || numeric(part))
                })
            }),
        "Invalid release version.",
    )?;
    let expected = format!(
        "{version}{}r{}",
        if version.contains('-') { "." } else { "-" },
        release.sequence
    );
    ensure(
        release.path_version == expected,
        "Invalid immutable release path.",
    )?;
    let timestamp = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|t| t.timestamp_millis())
            .map_err(|_| "Invalid release timestamp.")
    };
    let published = timestamp(&release.published_at)?;
    let issued = timestamp(&release.issued_at)?;
    let expires = timestamp(&release.expires_at)?;
    ensure(
        published <= issued
            && issued <= now + 300_000
            && expires > now
            && expires > issued
            && expires - issued <= 90 * 86_400_000,
        "Release metadata expired or has invalid dates.",
    )?;
    ensure(
        release.notes.len() <= 32_000
            && !release.artifacts.is_empty()
            && release.artifacts.len() <= 32,
        "Invalid release description.",
    )?;
    for (target, artifact) in &release.artifacts {
        let extension = match artifact.kind.as_str() {
            "nsis" if target == "windows-x86_64" || target == "windows-arm64" => ".exe",
            "deb" if target == "linux-x86_64-deb" || target == "linux-arm64-deb" => ".deb",
            "rpm" if target == "linux-x86_64-rpm" || target == "linux-arm64-rpm" => ".rpm",
            "macos-dmg" if target == "macos-x86_64" || target == "macos-arm64" => ".dmg",
            "macos-pkg" if target == "macos-x86_64" || target == "macos-arm64" => ".pkg",
            _ => return Err("Unsupported native Client package target or kind.".into()),
        };
        let url = trust.url(&artifact.url)?;
        let prefix = format!("/aixand-client/{}/", release.path_version);
        let filename = url
            .path()
            .strip_prefix(&prefix)
            .ok_or("Package is outside its immutable release path.")?;
        ensure(
            !filename.is_empty()
                && filename.len() <= 255
                && filename
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))
                && filename.ends_with(extension),
            "Invalid immutable package filename.",
        )?;
        ensure(
            hex(&artifact.sha256)
                && hex(&artifact.build)
                && artifact.size > 0
                && artifact.size <= 8 * 1024 * 1024 * 1024,
            "Invalid package size or digest.",
        )?;
        ensure(
            artifact.products.is_empty(),
            "Client cannot install shared backend products.",
        )?;
        ensure(
            artifact.licenses.len() <= 32
                && artifact.licenses.iter().all(|l| {
                    !l.product.is_empty()
                        && l.product.len() <= 200
                        && l.text.len() <= 100_000
                        && digest(l.text.as_bytes()) == l.sha256
                }),
            "Invalid release license inventory.",
        )?;
    }
    ensure(
        release.artifacts.contains_key(target),
        "This release has no package for this installation.",
    )?;
    ensure(
        release.sequence != floor || previous.is_none_or(|p| p == release.identity()),
        "An immutable release sequence changed.",
    )?;
    Ok(release)
}
pub fn verify_package(path: &std::path::Path, artifact: &Artifact) -> Result<(), String> {
    use std::io::Read;
    private_files::regular(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    ensure(
        metadata.is_file() && metadata.len() == artifact.size,
        "The downloaded package size changed.",
    )?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut block = [0; 65536];
    loop {
        let length = file.read(&mut block).map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        hash.update(&block[..length]);
    }
    ensure(
        format!("{:x}", hash.finalize()) == artifact.sha256,
        "The downloaded package checksum changed.",
    )
}
/// No arguments originate in the UI or feed. The executable belongs to the OS,
/// except for Windows' signature-bound, fully verified native installer.
pub fn handoff_command(
    path: &std::path::Path,
    kind: &str,
) -> Result<std::process::Command, String> {
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let mut command;
    match kind {
        "nsis" if cfg!(target_os = "windows") => {
            command = std::process::Command::new(path);
        }
        "deb" if cfg!(target_os = "linux") => {
            command = std::process::Command::new("/usr/bin/pkexec");
            command.args(["/usr/bin/dpkg", "--install"]).arg(path);
        }
        "rpm" if cfg!(target_os = "linux") => {
            command = std::process::Command::new("/usr/bin/pkexec");
            command.args(["/usr/bin/rpm", "--upgrade"]).arg(path);
        }
        "macos-pkg" | "macos-dmg" if cfg!(target_os = "macos") => {
            command = std::process::Command::new("/usr/bin/open");
            command.arg("--wait-apps").arg(path);
        }
        _ => return Err("The package does not belong to this operating system.".into()),
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    pub(super) fn fixture() -> (Envelope, Trust, i64) {
        let key = SigningKey::from_bytes(&[42; 32]);
        let trust = Trust {
            schema: 1,
            enabled: true,
            origin: "https://updates.example".into(),
            keys: BTreeMap::from([(
                "test".into(),
                key.verifying_key()
                    .to_public_key_pem(Default::default())
                    .unwrap(),
            )]),
        };
        let release = serde_json::json!({"schema":1,"apiProtocol":1,"product":"aixand-client","sequence":2,"version":"0.1.0-beta","pathVersion":"0.1.0-beta.r2",
            "publishedAt":"2026-01-01T00:00:00Z","issuedAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-02T00:00:00Z","notes":"Fixture release",
            "artifacts":{"linux-x86_64-deb":{"url":"https://updates.example/aixand-client/0.1.0-beta.r2/client.deb","sha256":digest(b"fixture"),"build":"b".repeat(64),"size":7,"kind":"deb","licenses":[],"products":[]}}});
        let payload = release.to_string();
        let envelope = Envelope {
            schema: 1,
            key_id: "test".into(),
            signature: STANDARD.encode(key.sign(payload.as_bytes()).to_bytes()),
            payload,
        };
        (envelope, trust, 1767225600000)
    }
    fn resign(envelope: &mut Envelope, change: impl FnOnce(&mut Value)) {
        let mut value: Value = serde_json::from_str(&envelope.payload).unwrap();
        change(&mut value);
        envelope.payload = value.to_string();
        envelope.signature = STANDARD.encode(
            SigningKey::from_bytes(&[42; 32])
                .sign(envelope.payload.as_bytes())
                .to_bytes(),
        );
    }
    #[test]
    fn fixed_handoff_and_operation_lock_never_execute_fixture_packages() {
        let directory =
            std::env::temp_dir().join(format!("aixand-fixed-handoff-{}", std::process::id()));
        private_files::directory(&directory).unwrap();
        let first = private_files::operation_lock(&directory).unwrap();
        assert!(private_files::operation_lock(&directory).is_err());
        drop(first);
        let second = private_files::operation_lock(&directory).unwrap();
        drop(second);
        let path = directory.join("-not-an-option.deb");
        std::fs::write(&path, b"fixture").unwrap();
        assert!(handoff_command(&path, "arbitrary-command").is_err());
        #[cfg(target_os = "linux")]
        {
            let command = handoff_command(&path, "deb").unwrap();
            assert_eq!(command.get_program(), "/usr/bin/pkexec");
            let args: Vec<_> = command.get_args().map(|s| s.to_owned()).collect();
            assert_eq!(
                args,
                vec![
                    std::ffi::OsString::from("/usr/bin/dpkg"),
                    std::ffi::OsString::from("--install"),
                    std::fs::canonicalize(&path).unwrap().into_os_string()
                ]
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn verifies_signed_fixture_and_immutable_identity() {
        let (envelope, trust, now) = fixture();
        let release = verify(&envelope, &trust, "linux-x86_64-deb", 1, None, now).unwrap();
        assert!(
            verify(
                &envelope,
                &trust,
                "linux-x86_64-deb",
                2,
                Some(&release.identity()),
                now
            )
            .is_ok()
        );
        assert!(
            verify(
                &envelope,
                &trust,
                "linux-x86_64-deb",
                2,
                Some(&"f".repeat(64)),
                now
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_bad_signature_key_role_target_expiry_and_rollback() {
        let (envelope, mut trust, now) = fixture();
        assert!(verify(&envelope, &trust, "linux-x86_64-deb", 3, None, now).is_err());
        assert!(verify(&envelope, &trust, "windows-x86_64", 0, None, now).is_err());
        assert!(
            verify(
                &envelope,
                &trust,
                "linux-x86_64-deb",
                0,
                None,
                now + 86400000
            )
            .is_err()
        );
        let mut bad = envelope.clone();
        bad.payload.push(' ');
        assert!(verify(&bad, &trust, "linux-x86_64-deb", 0, None, now).is_err());
        let mut bad = envelope.clone();
        resign(&mut bad, |v| v["product"] = "aixand-desktop".into());
        assert!(verify(&bad, &trust, "linux-x86_64-deb", 0, None, now).is_err());
        trust.keys.clear();
        assert!(verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).is_err());
    }
    #[test]
    fn rejects_foreign_mutable_urls_commands_and_invalid_licenses() {
        for url in [
            "http://updates.example/aixand-client/0.1.0-beta.r2/client.deb",
            "https://evil.example/client.deb",
            "https://updates.example/latest/client.deb",
            "https://updates.example/aixand-client/0.1.0-beta.r2/client.deb?args=evil",
        ] {
            let (mut envelope, trust, now) = fixture();
            resign(&mut envelope, |v| {
                v["artifacts"]["linux-x86_64-deb"]["url"] = url.into()
            });
            assert!(verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).is_err());
        }
        for field in ["command", "args"] {
            let (mut envelope, trust, now) = fixture();
            resign(&mut envelope, |v| {
                v["artifacts"]["linux-x86_64-deb"][field] = "evil".into()
            });
            assert!(verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).is_err());
        }
        let (mut envelope, trust, now) = fixture();
        resign(
            &mut envelope,
            |v| {
                v["artifacts"]["linux-x86_64-deb"]["licenses"] =
                    serde_json::json!([{"product":"tool","text":"changed","sha256":"a".repeat(64)}])
            },
        );
        assert!(verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).is_err());
    }
    #[test]
    fn disabled_public_trust_never_accepts_releases() {
        let (envelope, mut trust, now) = fixture();
        trust.enabled = false;
        assert!(verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).is_err());
    }
    #[test]
    fn package_hash_and_size_are_verified_without_installation() {
        let (envelope, trust, now) = fixture();
        let release = verify(&envelope, &trust, "linux-x86_64-deb", 0, None, now).unwrap();
        let artifact = &release.artifacts["linux-x86_64-deb"];
        let path =
            std::env::temp_dir().join(format!("aixand-update-fixture-{}", std::process::id()));
        std::fs::write(&path, b"fixture").unwrap();
        assert!(verify_package(&path, artifact).is_ok());
        std::fs::write(&path, b"changed").unwrap();
        assert!(verify_package(&path, artifact).is_err());
        std::fs::write(&path, b"short").unwrap();
        assert!(verify_package(&path, artifact).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

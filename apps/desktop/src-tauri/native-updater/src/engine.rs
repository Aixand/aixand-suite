use crate::{
    Envelope, Release, Trust, digest, handoff_command, private_files, verify, verify_package,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    floor: u64,
    identity: Option<String>,
    envelope: Option<Envelope>,
    downloaded: Option<String>,
    checked_at: u64,
    attempted_at: u64,
    daily: Option<bool>,
    #[serde(default)]
    automatic_download: bool,
    #[serde(default)]
    download_error: Option<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn load(directory: &Path) -> Result<Saved, String> {
    let path = directory.join("state.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => private_files::regular(&path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Saved::default()),
        Err(e) => return Err(e.to_string()),
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
        return Err("Client update state exceeds its size limit.".into());
    }
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => {
            serde_json::from_slice(&bytes).map_err(|_| "Cannot read Client update state.".into())
        }
        Ok(_) => Err("Client update state exceeds its size limit.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn save(directory: &Path, state: &Saved) -> Result<(), String> {
    let temporary = private_files::temporary(directory);
    let result = (|| {
        let mut file = private_files::create(&temporary)?;
        file.write_all(&serde_json::to_vec(state).map_err(|e| e.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        private_files::replace(&temporary, &directory.join("state.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn release(
    state: &Saved,
    trust: &Trust,
    target: &str,
    installed: &Installed,
) -> Result<Release, String> {
    verify(
        state
            .envelope
            .as_ref()
            .ok_or("Check for Client updates first.")?,
        trust,
        target,
        state.floor.max(installed.sequence),
        state.identity.as_deref(),
        now() as i64,
    )
}
fn status(
    state: &Saved,
    trust: &Trust,
    target: Result<String, String>,
    installed: &Installed,
) -> Value {
    let result = target
        .as_ref()
        .ok()
        .and_then(|t| release(state, trust, t, installed).ok());
    let artifact = result
        .as_ref()
        .and_then(|r| target.as_ref().ok().and_then(|t| r.artifacts.get(t)));
    let newer = result
        .as_ref()
        .is_some_and(|r| r.sequence > installed.sequence);
    json!({ "available": trust.enabled && target.is_ok(), "daily": state.daily != Some(false), "automaticDownload": state.automatic_download, "error": state.download_error, "checkedAt": state.checked_at,
        "installed": { "version": installed.version, "sequence": installed.sequence },
        "release": result.as_ref().map(|r| json!({"version": r.version, "sequence": r.sequence, "notes": r.notes})),
        "artifact": artifact.map(|a| json!({"size": a.size, "kind": a.kind})), "updateAvailable": newer,
        "phase": if newer && state.downloaded.as_ref() == artifact.map(|a| &a.sha256) { "downloaded" } else if newer { "available" } else { "idle" },
        "message": if !trust.enabled { "Client updates are not published for this installation.".to_owned() } else if let Err(e) = target { e } else if newer { "A Client update is available.".into() } else { "No newer verified Client release is available.".into() } })
}
async fn fetch(client: &reqwest::Client, url: &str, maximum: u64) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() as u64 + chunk.len() as u64 > maximum {
            return Err("Update response exceeded its signed size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn package(directory: &Path, artifact: &crate::Artifact) -> PathBuf {
    let extension = match artifact.kind.as_str() {
        "nsis" => "exe",
        "deb" => "deb",
        "rpm" => "rpm",
        "macos-pkg" => "pkg",
        _ => "dmg",
    };
    directory.join(format!("{}.{}", artifact.sha256, extension))
}
const MAX_AUTOMATIC_BYTES: u64 = 512 * 1024 * 1024;
const AUTOMATIC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const EXPLICIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
fn automatic_candidate<'a>(
    state: &Saved,
    release: &'a Release,
    installed: &Installed,
    target: &str,
) -> Option<&'a crate::Artifact> {
    let artifact = release.artifacts.get(target)?;
    (state.automatic_download
        && release.sequence > installed.sequence
        && artifact.size <= MAX_AUTOMATIC_BYTES)
        .then_some(artifact)
}
fn write_chunk(
    file: &mut fs::File,
    length: &mut u64,
    chunk: &[u8],
    maximum: u64,
) -> Result<(), String> {
    *length = length
        .checked_add(chunk.len() as u64)
        .ok_or("Client package size overflow.")?;
    if *length > maximum {
        return Err("Client package exceeded its signed size.".into());
    }
    file.write_all(chunk).map_err(|e| e.to_string())
}
async fn download(
    client: &reqwest::Client,
    directory: &Path,
    state: &mut Saved,
    artifact: &crate::Artifact,
    automatic: bool,
) -> Result<(), String> {
    let destination = package(directory, artifact);
    if verify_package(&destination, artifact).is_ok() {
        state.downloaded = Some(artifact.sha256.clone());
        state.download_error = None;
        return save(directory, state);
    }
    let temporary = private_files::temporary(directory);
    let result = tokio::time::timeout(
        if automatic {
            AUTOMATIC_TIMEOUT
        } else {
            EXPLICIT_TIMEOUT
        },
        async {
            let mut file = private_files::create(&temporary)?;
            let mut response = client
                .get(&artifact.url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let mut length = 0;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                write_chunk(&mut file, &mut length, &chunk, artifact.size)?;
            }
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            verify_package(&temporary, artifact)?;
            private_files::replace(&temporary, &destination)
        },
    )
    .await
    .unwrap_or_else(|_| Err("Client package download timed out. Retry when ready.".into()));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        state.download_error = Some(error.clone());
        save(directory, state)?;
        return Err(error);
    }
    state.downloaded = Some(artifact.sha256.clone());
    state.download_error = None;
    save(directory, state)
}
pub struct Installed<'a> {
    pub version: &'a str,
    pub sequence: u64,
}

pub async fn action(
    directory: &Path,
    trust: &Trust,
    target: Result<String, String>,
    installed: &Installed<'_>,
    action: &str,
    options: &Value,
) -> Result<Value, String> {
    private_files::directory(directory)?;
    let _operation = if action == "status" {
        None
    } else {
        Some(private_files::operation_lock(directory)?)
    };
    let mut state = load(&directory)?;
    if action == "status" {
        return Ok(status(&state, &trust, target.clone(), installed));
    }
    if action == "settings" {
        if options.as_object().is_none_or(|o| {
            o.is_empty()
                || o.keys()
                    .any(|k| !["daily", "automaticDownload"].contains(&k.as_str()))
                || o.values().any(|v| !v.is_boolean())
        }) {
            return Err("Invalid Client update preferences.".into());
        }
        if let Some(daily) = options["daily"].as_bool() {
            state.daily = Some(daily);
        }
        if let Some(automatic) = options["automaticDownload"].as_bool() {
            state.automatic_download = automatic;
        }
        save(&directory, &state)?;
        return Ok(status(&state, &trust, target.clone(), installed));
    }
    if !trust.enabled {
        return Ok(status(&state, &trust, target.clone(), installed));
    }
    let target = target?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    match action {
        "check" | "due" => {
            if !options.as_object().is_some_and(|o| o.is_empty()) {
                return Err("Invalid Client check options.".into());
            }
            if action == "due"
                && (state.daily == Some(false)
                    || now().saturating_sub(state.checked_at) < 86_400_000
                    || now().saturating_sub(state.attempted_at) < 3_600_000)
            {
                return Ok(status(&state, &trust, Ok(target), installed));
            }
            state.attempted_at = now();
            save(&directory, &state)?;
            let url = format!("{}/aixand-client/latest.json", trust.origin);
            trust.url(&url)?;
            let bytes = tokio::time::timeout(
                std::time::Duration::from_secs(25),
                fetch(&client, &url, 1_500_000),
            )
            .await
            .map_err(|_| "Client update check timed out.")??;
            let envelope = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let verified = verify(
                &envelope,
                &trust,
                &target,
                state.floor.max(installed.sequence),
                state.identity.as_deref(),
                now() as i64,
            )?;
            state.floor = verified.sequence;
            state.identity = Some(verified.identity());
            state.envelope = Some(envelope);
            state.checked_at = now();
            save(&directory, &state)?;
            state.download_error = None;
            if automatic_candidate(&state, &verified, installed, &target).is_some() {
                download(
                    &client,
                    directory,
                    &mut state,
                    &verified.artifacts[&target],
                    true,
                )
                .await?;
            } else if state.automatic_download
                && verified.sequence > installed.sequence
                && verified.artifacts[&target].size > MAX_AUTOMATIC_BYTES
            {
                state.download_error = Some("This package exceeds the automatic download limit. Choose Download update to continue.".into());
            }
            save(directory, &state)?;
        }
        "download" => {
            if !options.as_object().is_some_and(|o| o.is_empty()) {
                return Err("Invalid Client download options.".into());
            }
            let verified = release(&state, &trust, &target, installed)?;
            if verified.sequence <= installed.sequence {
                return Err("There is no newer Client release to download.".into());
            }
            download(
                &client,
                directory,
                &mut state,
                &verified.artifacts[&target],
                false,
            )
            .await?;
        }

        "plan" | "install" => {
            let verified = release(&state, &trust, &target, installed)?;
            let artifact = &verified.artifacts[&target];
            if verified.sequence <= installed.sequence
                || state.downloaded.as_ref() != Some(&artifact.sha256)
            {
                return Err("Download a newer verified Client package before review.".into());
            }
            let path = package(&directory, artifact);
            verify_package(&path, artifact)?;
            let revision = digest(
                format!(
                    "{}:{}:{}:{}",
                    verified.identity(),
                    artifact.sha256,
                    installed.version,
                    installed.sequence
                )
                .as_bytes(),
            );
            let plan = json!({ "revision": revision, "ready": true, "sessions": [], "requiredProducts": [], "licenses": artifact.licenses,
                "restartRequired": true, "version": verified.version, "packageKind": artifact.kind });
            if action == "plan" {
                if !options.as_object().is_some_and(|o| o.is_empty()) {
                    return Err("Invalid Client review options.".into());
                }
                return Ok(plan);
            }
            let allowed = [
                "confirmed",
                "revision",
                "acceptedLicenses",
                "restartConsent",
            ];
            if options.as_object().is_none_or(|o| {
                o.len() != allowed.len() || o.keys().any(|k| !allowed.contains(&k.as_str()))
            }) || options["confirmed"] != true
                || options["restartConsent"] != true
                || options["revision"] != revision
            {
                return Err(
                    "Review and explicitly confirm the current Client update and restart impact."
                        .into(),
                );
            }
            let accepted = options["acceptedLicenses"]
                .as_array()
                .ok_or("Accept the reviewed licenses.")?;
            if accepted.len() > 32
                || accepted.iter().any(|v| !v.is_string())
                || artifact
                    .licenses
                    .iter()
                    .any(|l| !accepted.iter().any(|v| v == &l.sha256))
            {
                return Err("Accept every reviewed Client license.".into());
            }
            // Recheck immediately before the native handoff. Never execute renderer
            // paths, feed commands, or installer arguments.
            verify_package(&path, artifact)?;
            handoff_command(&path, &artifact.kind)?
                .spawn()
                .map_err(|e| format!("Could not open the native installer: {e}"))?;
            return Ok(json!({"started": true, "nativeInstaller": true}));
        }
        _ => return Err("Unknown Client update operation.".into()),
    }
    Ok(status(&state, &trust, Ok(target), installed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signer, SigningKey};
    #[tokio::test]
    async fn rejects_stale_revision_missing_consent_and_caller_commands_before_handoff() {
        let (mut envelope, trust, _) = crate::tests::fixture();
        let mut value: Value = serde_json::from_str(&envelope.payload).unwrap();
        value["issuedAt"] = chrono::DateTime::from_timestamp_millis(now() as i64)
            .unwrap()
            .to_rfc3339()
            .into();
        value["expiresAt"] = chrono::DateTime::from_timestamp_millis(now() as i64 + 86400000)
            .unwrap()
            .to_rfc3339()
            .into();
        envelope.payload = value.to_string();
        envelope.signature = STANDARD.encode(
            SigningKey::from_bytes(&[42; 32])
                .sign(envelope.payload.as_bytes())
                .to_bytes(),
        );
        let verified =
            verify(&envelope, &trust, "linux-x86_64-deb", 1, None, now() as i64).unwrap();
        let directory =
            std::env::temp_dir().join(format!("aixand-client-consent-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let artifact = &verified.artifacts["linux-x86_64-deb"];
        fs::write(package(&directory, artifact), b"fixture").unwrap();
        let state = Saved {
            floor: 2,
            identity: Some(verified.identity()),
            envelope: Some(envelope),
            downloaded: Some(artifact.sha256.clone()),
            ..Saved::default()
        };
        save(&directory, &state).unwrap();
        let installed = Installed {
            version: "0.1.0-beta",
            sequence: 1,
        };
        let plan = action(
            &directory,
            &trust,
            Ok("linux-x86_64-deb".into()),
            &installed,
            "plan",
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(plan["ready"], true);
        for options in [
            json!({"confirmed":true,"revision":plan["revision"],"acceptedLicenses":[]}),
            json!({"confirmed":false,"revision":plan["revision"],"acceptedLicenses":[],"restartConsent":true}),
            json!({"confirmed":true,"revision":"stale","acceptedLicenses":[],"restartConsent":true}),
            json!({"confirmed":true,"revision":plan["revision"],"acceptedLicenses":[],"restartConsent":true,"command":"other"}),
        ] {
            assert!(
                action(
                    &directory,
                    &trust,
                    Ok("linux-x86_64-deb".into()),
                    &installed,
                    "install",
                    &options
                )
                .await
                .unwrap_err()
                .contains("explicitly confirm")
            );
        }
        fs::write(package(&directory, artifact), b"changed").unwrap();
        assert!(
            action(
                &directory,
                &trust,
                Ok("linux-x86_64-deb".into()),
                &installed,
                "plan",
                &json!({})
            )
            .await
            .is_err()
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn disabled_config_and_daily_preferences_do_not_contact_a_feed() {
        let (_, mut trust, _) = crate::tests::fixture();
        trust.enabled = false;
        let directory =
            std::env::temp_dir().join(format!("aixand-client-disabled-{}", std::process::id()));
        let installed = Installed {
            version: "0.1.0-beta",
            sequence: 0,
        };
        for operation in ["status", "check", "due", "download"] {
            let value = action(
                &directory,
                &trust,
                Ok("linux-x86_64-deb".into()),
                &installed,
                operation,
                &json!({}),
            )
            .await
            .unwrap();
            assert_eq!(value["available"], false);
        }
        action(
            &directory,
            &trust,
            Ok("linux-x86_64-deb".into()),
            &installed,
            "settings",
            &json!({"daily":false}),
        )
        .await
        .unwrap();
        assert_eq!(load(&directory).unwrap().daily, Some(false));
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod followup_tests {
    use super::*;
    #[test]
    fn automatic_download_policy_is_opt_in_newer_and_bounded() {
        let (envelope, trust, now) = crate::tests::fixture();
        let mut release = verify(&envelope, &trust, "linux-x86_64-deb", 1, None, now).unwrap();
        let mut state = Saved::default();
        let installed = Installed {
            version: "0.1.0-beta",
            sequence: 1,
        };
        assert!(!state.automatic_download);
        assert!(automatic_candidate(&state, &release, &installed, "linux-x86_64-deb").is_none());
        state.automatic_download = true;
        assert!(automatic_candidate(&state, &release, &installed, "linux-x86_64-deb").is_some());
        release.artifacts.get_mut("linux-x86_64-deb").unwrap().size = MAX_AUTOMATIC_BYTES + 1;
        assert!(automatic_candidate(&state, &release, &installed, "linux-x86_64-deb").is_none());
        release.artifacts.get_mut("linux-x86_64-deb").unwrap().size = 7;
        release.sequence = installed.sequence;
        assert!(automatic_candidate(&state, &release, &installed, "linux-x86_64-deb").is_none());
        assert_eq!(AUTOMATIC_TIMEOUT.as_secs(), 300);
    }
    #[tokio::test]
    async fn preference_and_private_state_survive_repeated_atomic_replacement() {
        let (_, mut trust, _) = crate::tests::fixture();
        trust.enabled = false;
        let directory =
            std::env::temp_dir().join(format!("aixand-auto-state-{}", std::process::id()));
        let installed = Installed {
            version: "0.1.0-beta",
            sequence: 0,
        };
        for value in [true, false, true] {
            let status = action(
                &directory,
                &trust,
                Ok("linux-x86_64-deb".into()),
                &installed,
                "settings",
                &json!({"automaticDownload":value}),
            )
            .await
            .unwrap();
            assert_eq!(status["automaticDownload"], value);
            assert_eq!(load(&directory).unwrap().automatic_download, value);
        }
        for invalid in [
            json!({}),
            json!({"automaticDownload":"yes"}),
            json!({"automaticDownload":true,"command":"other"}),
        ] {
            assert!(
                action(
                    &directory,
                    &trust,
                    Ok("linux-x86_64-deb".into()),
                    &installed,
                    "settings",
                    &invalid
                )
                .await
                .is_err()
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(directory.join("state.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let path = private_files::temporary(&directory);
        let mut file = private_files::create(&path).unwrap();
        let mut length = 0;
        write_chunk(&mut file, &mut length, b"small", 7).unwrap();
        assert!(write_chunk(&mut file, &mut length, b"overflow", 7).is_err());
        drop(file);
        fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn current_license_hash_is_required_before_any_native_handoff() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use ed25519_dalek::{Signer, SigningKey};
        let (mut envelope, trust, _) = crate::tests::fixture();
        let mut value: Value = serde_json::from_str(&envelope.payload).unwrap();
        value["issuedAt"] = chrono::DateTime::from_timestamp_millis(now() as i64)
            .unwrap()
            .to_rfc3339()
            .into();
        value["expiresAt"] = chrono::DateTime::from_timestamp_millis(now() as i64 + 86400000)
            .unwrap()
            .to_rfc3339()
            .into();
        value["artifacts"]["linux-x86_64-deb"]["licenses"] =
            json!([{"product":"Client","text":"current terms","sha256":digest(b"current terms")}]);
        envelope.payload = value.to_string();
        envelope.signature = STANDARD.encode(
            SigningKey::from_bytes(&[42; 32])
                .sign(envelope.payload.as_bytes())
                .to_bytes(),
        );
        let release = verify(&envelope, &trust, "linux-x86_64-deb", 1, None, now() as i64).unwrap();
        let directory =
            std::env::temp_dir().join(format!("aixand-current-license-{}", std::process::id()));
        private_files::directory(&directory).unwrap();
        let artifact = &release.artifacts["linux-x86_64-deb"];
        fs::write(package(&directory, artifact), b"fixture").unwrap();
        save(
            &directory,
            &Saved {
                floor: 2,
                identity: Some(release.identity()),
                envelope: Some(envelope),
                downloaded: Some(artifact.sha256.clone()),
                ..Saved::default()
            },
        )
        .unwrap();
        let installed = Installed {
            version: "0.1.0-beta",
            sequence: 1,
        };
        let plan = action(
            &directory,
            &trust,
            Ok("linux-x86_64-deb".into()),
            &installed,
            "plan",
            &json!({}),
        )
        .await
        .unwrap();
        for accepted in [json!([]), json!([digest(b"old terms")])] {
            let error = action(&directory,&trust,Ok("linux-x86_64-deb".into()),&installed,"install",&json!({"confirmed":true,"restartConsent":true,"revision":plan["revision"],"acceptedLicenses":accepted})).await.unwrap_err();
            assert!(error.contains("every reviewed Client license"));
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_redirected_state_without_overwriting_the_destination() {
        let directory =
            std::env::temp_dir().join(format!("aixand-state-link-{}", std::process::id()));
        private_files::directory(&directory).unwrap();
        let destination = directory.join("unrelated.json");
        fs::write(&destination, b"keep").unwrap();
        std::os::unix::fs::symlink(&destination, directory.join("state.json")).unwrap();
        assert!(load(&directory).is_err());
        assert!(save(&directory, &Saved::default()).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"keep");
        fs::remove_dir_all(directory).unwrap();
    }
}

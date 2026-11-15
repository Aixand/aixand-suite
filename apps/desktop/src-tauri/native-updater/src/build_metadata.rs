//! Public release identity shared by native build validation and fixture tests.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

pub fn metadata(
    selected_version: &str,
    version: Option<&str>,
    sequence: Option<&str>,
    trust_bytes: &[u8],
) -> Result<(Value, Vec<u8>), String> {
    let version = version.unwrap_or(selected_version);
    if version != selected_version {
        return Err(
            "Client update version must equal the selected Tauri application version.".into(),
        );
    }
    let (core, pre) = version
        .split_once('-')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    let numeric = |p: &str| {
        !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) && (p == "0" || !p.starts_with('0'))
    };
    if version.len() > 100
        || core.split('.').count() != 3
        || !core.split('.').all(numeric)
        || pre.is_some_and(|pre| {
            !pre.split('.').all(|p| {
                !p.is_empty()
                    && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    && (!p.bytes().all(|c| c.is_ascii_digit()) || numeric(p))
            })
        })
    {
        return Err("Invalid selected Client version.".into());
    }
    let sequence = sequence.unwrap_or("0");
    if !sequence.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Client sequence.".into());
    }
    let sequence = sequence
        .parse::<u64>()
        .map_err(|_| "Invalid Client sequence.")?;
    let trust: Value = serde_json::from_slice(trust_bytes).map_err(|e| e.to_string())?;
    if trust.as_object().is_none_or(|v| {
        v.len() != 4
            || v.keys()
                .any(|k| !["schema", "enabled", "origin", "keys"].contains(&k.as_str()))
    }) || trust["schema"] != 1
        || !trust["enabled"].is_boolean()
    {
        return Err("Invalid public Client trust configuration.".into());
    }
    let origin = trust["origin"]
        .as_str()
        .ok_or("Missing Client trust origin.")?;
    let origin_url = url::Url::parse(origin).map_err(|e| e.to_string())?;
    if origin_url.scheme() != "https" || origin_url.origin().ascii_serialization() != origin {
        return Err("Client release origin must be exact HTTPS.".into());
    }
    let keys = trust["keys"]
        .as_object()
        .ok_or("Missing public Client signing keys.")?;
    if keys.len() > 32
        || keys.iter().any(|(id, key)| {
            id.is_empty()
                || id.len() > 128
                || key.as_str().is_none_or(|pem| {
                    pem.len() > 4096
                        || !pem.starts_with("-----BEGIN PUBLIC KEY-----\n")
                        || !pem.trim_end().ends_with("-----END PUBLIC KEY-----")
                        || pem.contains("PRIVATE")
                })
        })
    {
        return Err("Only bounded public signing keys may be baked into Client.".into());
    }
    if sequence > MAX_SEQUENCE || trust["enabled"] == true && (sequence == 0 || keys.is_empty()) {
        return Err(
            "Enabled Client trust requires a positive safe release sequence and public keys."
                .into(),
        );
    }
    let baked = serde_json::to_vec(&trust).map_err(|e| e.to_string())?;
    let metadata = json!({"schema":1,"product":"aixand-client","version":version,"sequence":sequence,"trust":trust,"trustSha256":format!("{:x}", Sha256::digest(&baked))});
    Ok((metadata, baked))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trust(enabled: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({"schema":1,"enabled":enabled,"origin":"https://updates.example","keys":{"test":"-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n"}})).unwrap()
    }
    #[test]
    fn enabled_identity_requires_matching_selected_version_and_positive_safe_sequence() {
        assert!(metadata("0.2.0-beta", Some("0.1.0-beta"), Some("1"), &trust(true)).is_err());
        for sequence in ["0", "-1", "9007199254740992", "18446744073709551616"] {
            assert!(metadata("0.2.0-beta", None, Some(sequence), &trust(true)).is_err());
        }
        let (value, baked) =
            metadata("0.2.0-beta", Some("0.2.0-beta"), Some("2"), &trust(true)).unwrap();
        assert_eq!(value["sequence"], 2);
        assert_eq!(value["version"], "0.2.0-beta");
        assert_eq!(value["trustSha256"], format!("{:x}", Sha256::digest(baked)));
    }
    #[test]
    fn disabled_defaults_are_public_and_private_material_is_refused() {
        let (value, _) = metadata("0.1.0-beta", None, None, &trust(false)).unwrap();
        assert_eq!(value["sequence"], 0);
        assert_eq!(value["trust"]["enabled"], false);
        let mut secret: Value = serde_json::from_slice(&trust(false)).unwrap();
        secret["privateKey"] = "secret".into();
        assert!(
            metadata(
                "0.1.0-beta",
                None,
                None,
                &serde_json::to_vec(&secret).unwrap()
            )
            .is_err()
        );
    }
}

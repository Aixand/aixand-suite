//! Requested routing policy only. Suite/Agent Manager resolve provider quotas.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

/// Resource identity capture is independent of profile/quota selection timing.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceCapture {
    Stage,
    Workflow,
}

/// Strict workflow capture contains explicit stores and immutable managed IDs.
pub fn captured_resources(value: &serde_json::Value) -> bool {
    let target = |value: &serde_json::Value| {
        let store = value["store"]
            .as_str()
            .is_some_and(|s| std::path::Path::new(s).is_absolute());
        let pinned = value["revision"].as_str().is_some_and(|s| {
            s.len() == 71
                && s.starts_with("sha256:")
                && s[7..]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        });
        store
            && (value["kind"] == "managed" && pinned
                || value["kind"] == "release"
                    && value["reference"].as_str().is_some_and(|s| s.contains('@')))
    };
    if value["inherit_profile"] != false
        || !matches!(
            value["schema"].as_str(),
            Some("agent-manager/resource-request-1" | "agent-manager/resource-request-2")
        )
    {
        return false;
    }
    if value["instructions"]["mode"] != "off"
        && !(value["instructions"]["mode"] == "replace" && target(&value["instructions"]["target"]))
    {
        return false;
    }
    ["skills", "mcp"].iter().all(|kind| {
        value[*kind]["add"]
            .as_array()
            .is_some_and(|items| items.iter().all(|item| target(&item["target"])))
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum ProfileSelection {
    Controller,
    Auto {
        #[serde(
            default,
            rename = "eligibleProfiles",
            skip_serializing_if = "Option::is_none"
        )]
        eligible_profiles: Option<Vec<String>>,
    },
    Specific {
        profile: String,
    },
}

impl ProfileSelection {
    pub fn validate(&self) -> Result<()> {
        let valid = |name: &str| {
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        };
        match self {
            Self::Specific { profile } if !valid(profile) => {
                Err(Error::new("validation", "Invalid selected profile"))
            }
            Self::Auto {
                eligible_profiles: Some(pool),
            } if pool.is_empty()
                || pool.len() > 128
                || pool.iter().any(|name| !valid(name))
                || pool.iter().collect::<std::collections::BTreeSet<_>>().len() != pool.len() =>
            {
                Err(Error::new(
                    "validation",
                    "Auto needs a nonempty pool of distinct profile names",
                ))
            }
            _ => Ok(()),
        }
    }
}

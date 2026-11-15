//! Suite enforces these presets; Runner validates and durably carries them.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    WorkspaceAuto,
    FullAccess,
}

pub const MODES: [PermissionMode; 4] = [
    PermissionMode::ReadOnly,
    PermissionMode::WorkspaceWrite,
    PermissionMode::WorkspaceAuto,
    PermissionMode::FullAccess,
];

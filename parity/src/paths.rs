//! Where things are.

use std::path::PathBuf;

/// The repository's root.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("parity/ is in the repository")
        .to_path_buf()
}

pub fn contract_dir() -> PathBuf {
    repo_root().join("contract")
}

pub fn parity_dir() -> PathBuf {
    repo_root().join("parity")
}

pub fn scenarios_dir() -> PathBuf {
    parity_dir().join("scenarios")
}

//! Where things are.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The repository's root, found at run time: the checkout whose code runs
/// is the one cargo names (`CARGO_MANIFEST_DIR` of the test or `cargo run`),
/// else the one around the current directory, else the one this binary was
/// built in. Worktrees sharing a `CARGO_TARGET_DIR` may run a binary built
/// in another worktree: the root must still be the caller's, never the
/// builder's, or parity-ledger would rewrite another checkout's ledger.
pub fn repo_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let manifest = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from);
        let current = std::env::current_dir().ok();
        manifest
            .iter()
            .chain(current.iter())
            .find_map(|start| find_root(start))
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("parity/ is in the repository")
                    .to_path_buf()
            })
    })
    .clone()
}

/// The nearest directory from `start` up holding the contract and the
/// parity crate.
pub fn find_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| {
            dir.join("contract/contract.json").is_file() && dir.join("parity/Cargo.toml").is_file()
        })
        .map(Path::to_path_buf)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_the_checkout_around_the_start_not_the_builder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("other-worktree");
        std::fs::create_dir_all(root.join("contract")).unwrap();
        std::fs::create_dir_all(root.join("parity/src")).unwrap();
        std::fs::write(root.join("contract/contract.json"), "{}").unwrap();
        std::fs::write(root.join("parity/Cargo.toml"), "").unwrap();
        assert_eq!(find_root(&root.join("parity/src")), Some(root.clone()));
        assert_eq!(find_root(&root), Some(root));
        assert_eq!(find_root(dir.path()), None);
    }
}

//! Where things are.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The POSIX shell of `sh:` steps, spawned processes, pane jobs and the
/// fake ssh: `sh`, or on Windows Git for Windows' bash, found as the server
/// finds it (roamgate_base::posix_shell).
pub fn posix_shell() -> String {
    static SHELL: OnceLock<String> = OnceLock::new();
    SHELL
        .get_or_init(|| {
            roamgate_base::posix_shell::posix_shell().unwrap_or_else(|_| "sh".to_owned())
        })
        .clone()
}

/// The repository's root, found at run time, never the one this binary was
/// built in: worktrees sharing a `CARGO_TARGET_DIR` run the same binaries,
/// and a run must read and write its own checkout (its ledger, contract and
/// Bun server). In order: `PARITY_REPO`, the checkout around the current
/// directory (cargo and nextest run tests from the package's directory),
/// the one around `CARGO_MANIFEST_DIR` as cargo sets it for the run, then
/// the builder's as a last resort.
pub fn repo_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        root_from(
            std::env::var_os("PARITY_REPO").map(PathBuf::from),
            std::env::current_dir().ok(),
            std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from),
        )
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("parity/ is in the repository")
                .to_path_buf()
        })
    })
    .clone()
}

/// The root `repo_root` picks from these places, in this order.
pub fn root_from(
    explicit: Option<PathBuf>,
    current: Option<PathBuf>,
    manifest: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(explicit) = explicit.and_then(|dir| find_root(&dir)) {
        return Some(explicit);
    }
    current
        .iter()
        .chain(manifest.iter())
        .find_map(|start| find_root(start))
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

    #[test]
    fn one_binary_run_from_two_worktrees_reads_each_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let make = |name: &str| {
            let root = dir.path().join(name);
            std::fs::create_dir_all(root.join("contract")).unwrap();
            std::fs::create_dir_all(root.join("parity")).unwrap();
            std::fs::write(root.join("contract/contract.json"), "{}").unwrap();
            std::fs::write(root.join("parity/Cargo.toml"), "").unwrap();
            root
        };
        let (a, b) = (make("a"), make("b"));
        // The builder's manifest directory names worktree a; run from b.
        let built_in_a = Some(a.join("parity"));
        assert_eq!(
            root_from(None, Some(b.join("parity")), built_in_a.clone()),
            Some(b.clone())
        );
        assert_eq!(
            root_from(None, Some(a.join("parity")), built_in_a.clone()),
            Some(a.clone())
        );
        // PARITY_REPO wins over the directory a run starts in.
        assert_eq!(
            root_from(Some(b.clone()), Some(a.join("parity")), built_in_a),
            Some(b)
        );
    }
}

//! The build this Roamgate runs (server/src/work/deployed.ts): the deploy
//! script writes the commit it built into `server/public/.built-from` next
//! to the server, read again every minute by the board. Without the file
//! (a dev server), the checkout's HEAD stands in.

use std::path::{Path, PathBuf};

fn is_sha(text: &str) -> bool {
    text.len() == 40
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `server/public/.built-from` of a checkout.
pub fn built_from_path(checkout: &Path) -> PathBuf {
    checkout.join("server").join("public").join(".built-from")
}

/// The deployed commit, or None when no build says.
pub fn read_deployed(path: &Path) -> Option<String> {
    let sha = std::fs::read_to_string(path).ok()?.trim().to_lowercase();
    is_sha(&sha).then_some(sha)
}

/// The checkout's HEAD, read from .git without running git (a dev server).
pub fn read_head(checkout: &Path) -> Option<String> {
    let mut git_dir = checkout.join(".git");
    if !git_dir.exists() {
        return None;
    }
    // A worktree: .git is a file naming its git dir.
    if git_dir.is_file() {
        let text = std::fs::read_to_string(&git_dir).ok()?;
        let text = text.trim();
        if let Some(rest) = text.strip_prefix("gitdir: ") {
            git_dir = checkout.join(rest);
        }
    }
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if is_sha(head) {
        return Some(head.to_owned());
    }
    let reference = head.strip_prefix("ref: ")?;
    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) => git_dir.join(text.trim()),
        Err(_) => git_dir.clone(),
    };
    let loose = common.join(reference);
    if loose.exists() {
        let sha = std::fs::read_to_string(loose).ok()?.trim().to_owned();
        return is_sha(&sha).then_some(sha);
    }
    let packed = std::fs::read_to_string(common.join("packed-refs")).ok()?;
    packed.split('\n').find_map(|line| {
        let mut parts = line.split(' ');
        let sha = parts.next()?;
        let name = parts.next()?;
        (name == reference && is_sha(sha)).then(|| sha.to_owned())
    })
}

/// What the deployed rule reads: the build's commit, else HEAD.
pub fn deployed_of(checkout: &Path) -> Option<String> {
    read_deployed(&built_from_path(checkout)).or_else(|| read_head(checkout))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0123456789abcdef0123456789abcdef01234567";
    const B: &str = "89abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn the_build_file_says_the_deployed_commit_else_head_loose_packed_or_a_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("repo");
        let git = checkout.join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git.join("refs/heads/main"), format!("{A}\n")).unwrap();
        assert_eq!(deployed_of(&checkout).as_deref(), Some(A));
        std::fs::write(git.join("HEAD"), "ref: refs/heads/packed\n").unwrap();
        std::fs::write(
            git.join("packed-refs"),
            format!("# pack-refs\n{B} refs/heads/packed\n"),
        )
        .unwrap();
        assert_eq!(read_head(&checkout).as_deref(), Some(B));
        // A worktree of it.
        let worktree = dir.path().join("wt");
        let admin = git.join("worktrees/wt");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        std::fs::write(admin.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        assert_eq!(read_head(&worktree).as_deref(), Some(A));
        // The deployed build wins.
        std::fs::create_dir_all(checkout.join("server/public")).unwrap();
        std::fs::write(
            built_from_path(&checkout),
            format!("{}\n", B.to_uppercase()),
        )
        .unwrap();
        assert_eq!(deployed_of(&checkout).as_deref(), Some(B));
        std::fs::write(built_from_path(&checkout), "not a sha").unwrap();
        assert_eq!(read_deployed(&built_from_path(&checkout)), None);
    }
}

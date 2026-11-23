//! Which names of a listed directory Git ignores (workspace/git-ignore.ts),
//! with a short cache of directories that are not in a work tree.

use std::collections::{BTreeSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::exec::{GitContext, Invocation};
use crate::shell_quote;

/// file-constants.ts `LIST_TIMEOUT_MS`.
pub const LIST_TIMEOUT: Duration = Duration::from_millis(10_000);
const NOT_A_REPO_TTL: Duration = Duration::from_millis(4000);
const NOT_A_REPO_CACHE_LIMIT: usize = 512;

/// Directories git said are outside a work tree (exit 128), by host and
/// path, kept a few seconds so repeated expands skip the spawn. Positive
/// answers are never kept: the ignored set depends on the names.
#[derive(Debug, Default)]
pub struct NotARepoCache {
    entries: Mutex<VecDeque<(String, Instant)>>,
}

impl NotARepoCache {
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }

    fn read(&self, key: &str) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let Some(index) = entries.iter().position(|(k, _)| k == key) else {
            return false;
        };
        if entries[index].1.elapsed() >= NOT_A_REPO_TTL {
            entries.remove(index);
            return false;
        }
        true
    }

    fn write(&self, key: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|(k, _)| k != key);
        entries.push_back((key.to_owned(), Instant::now()));
        while entries.len() > NOT_A_REPO_CACHE_LIMIT {
            entries.pop_front();
        }
    }
}

/// The server's cache.
pub static NOT_A_REPO: LazyLock<NotARepoCache> = LazyLock::new(NotARepoCache::default);

/// The names of `names` Git ignores in `directory`. Anything that keeps
/// it from telling (not a repository, git missing, a transport failure)
/// is an empty set: a listing never fails for its ignore marks.
pub async fn collect_ignored_names(
    cx: &GitContext,
    cache: &NotARepoCache,
    directory: &str,
    names: &[String],
) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let unique: Vec<&String> = names
        .iter()
        .filter(|name| !name.is_empty() && !name.contains('\0'))
        .filter(|name| seen.insert(name.as_str()))
        .collect();
    if unique.is_empty() {
        return BTreeSet::new();
    }
    let key = format!("{} {directory}", cx.host().unwrap_or("local"));
    if cache.read(&key) {
        return BTreeSet::new();
    }
    let invocation = match cx.host() {
        Some(host) => Invocation::ssh(
            host,
            &format!("git -C {} check-ignore -z --stdin", shell_quote(directory)),
            None,
        ),
        None => Invocation::local(["git", "-C", directory, "check-ignore", "-z", "--stdin"]),
    };
    let input: String = unique.iter().map(|name| format!("{name}\0")).collect();
    let Ok(ran) = cx.run_input(invocation, input, LIST_TIMEOUT).await else {
        // Transient (an SSH drop, no git): not cached.
        return BTreeSet::new();
    };
    // 0: some are ignored; 1: none; 128: not in a work tree (cached).
    if ran.code == 128 {
        cache.write(&key);
        return BTreeSet::new();
    }
    if ran.code != 0 && ran.code != 1 {
        return BTreeSet::new();
    }
    ran.stdout
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

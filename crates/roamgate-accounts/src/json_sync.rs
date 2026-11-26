//! Claude Code's `.claude.json` kept in step between the user's own and
//! each Claude account's: the newest write wins for every shared key, and
//! each file keeps its own account's keys ([`CLAUDE_JSON_OWN`]).
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy), src/claude_json.rs and src/jsonsync.rs:
//! "newest Claude Code write wins" at file granularity, the source's
//! shared fields overlaid on every other file with that file's own
//! per-account fields kept, written only on change, and a file caught
//! mid-write (not JSON) skipped until the next pass.

use std::io;
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::{Map, Value};

use crate::files::{read_object, write_private};
use crate::prepare::CLAUDE_JSON_OWN;

fn is_own(key: &str) -> bool {
    CLAUDE_JSON_OWN.contains(&key)
}

/// `member` with the shared keys of `source`, its own account's keys kept
/// (in its own order first, then the source's order).
fn overlay(source: &Map<String, Value>, member: &Map<String, Value>) -> Map<String, Value> {
    let mut next = Map::new();
    for (key, value) in source {
        if !is_own(key) {
            next.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in member {
        if is_own(key) {
            next.insert(key.clone(), value.clone());
        }
    }
    next
}

fn shared_equal(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    let shared = |map: &Map<String, Value>| {
        map.iter()
            .filter(|(key, _)| !is_own(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    shared(a) == shared(b)
}

/// One pass over `members` (the user's `.claude.json` first, then the
/// accounts'): the most recently modified one is the source of the shared
/// keys. Members that are missing are left out; a member that does not
/// parse stops the pass (it is being written). Returns how many files it
/// wrote.
pub fn sync_claude_json(members: &[PathBuf]) -> io::Result<usize> {
    let mut read: Vec<(PathBuf, Map<String, Value>, SystemTime)> = Vec::new();
    for path in members {
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        let Some(object) = read_object(path) else {
            return Ok(0);
        };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        read.push((path.clone(), object, modified));
    }
    if read.len() < 2 {
        return Ok(0);
    }
    let newest = read
        .iter()
        .enumerate()
        .max_by_key(|(index, (_, _, modified))| (*modified, std::cmp::Reverse(*index)))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let source = read[newest].1.clone();
    let mut written = 0;
    for (index, (path, member, _)) in read.iter().enumerate() {
        if index == newest || shared_equal(&source, member) {
            continue;
        }
        write_private(path, &overlay(&source, member))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &std::path::Path, value: Value) {
        std::fs::write(path, value.to_string()).unwrap();
    }

    fn read(path: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn age(path: &std::path::Path, seconds: u64) {
        let at = SystemTime::now() - std::time::Duration::from_secs(seconds);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[test]
    fn the_newest_write_wins_and_each_keeps_its_account() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user.json");
        let work = temp.path().join("work.json");
        write(
            &user,
            json!({"oauthAccount": {"e": "me"}, "projects": {"/a": {}}, "tips": 1}),
        );
        write(
            &work,
            json!({"oauthAccount": {"e": "work"}, "projects": {"/a": {}, "/b": {"trusted": true}}}),
        );
        age(&user, 60);
        assert_eq!(sync_claude_json(&[user.clone(), work.clone()]).unwrap(), 1);
        let user_now = read(&user);
        assert_eq!(user_now["oauthAccount"]["e"], "me");
        assert_eq!(user_now["projects"]["/b"]["trusted"], true);
        assert!(user_now.get("tips").is_none());
        assert_eq!(read(&work)["oauthAccount"]["e"], "work");
        // Nothing left to do.
        assert_eq!(sync_claude_json(&[user.clone(), work.clone()]).unwrap(), 0);
    }

    #[test]
    fn a_file_being_written_stops_the_pass() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user.json");
        let work = temp.path().join("work.json");
        write(&user, json!({"a": 1}));
        std::fs::write(&work, "{\"a\": ").unwrap();
        assert_eq!(sync_claude_json(&[user.clone(), work.clone()]).unwrap(), 0);
        assert_eq!(read(&user), json!({"a": 1}));
        // A missing member is left out.
        let gone = temp.path().join("gone.json");
        assert_eq!(sync_claude_json(&[user, gone]).unwrap(), 0);
    }
}

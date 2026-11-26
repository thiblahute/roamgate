//! MCP server logins shared between the user's Claude Code and each Claude
//! account. Claude Code keeps them in `.credentials.json` (`mcpOAuth`),
//! beside the account's own sign-in, which never moves.
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy), src/mcp_sync.rs, simplified: every pass
//! reads each source's logins; a source that held a server's login on the
//! previous pass and lacks it now (its file read cleanly) signed out of
//! it, so that login (by fingerprint) is removed from every store and
//! never brought back while any source still holds it; otherwise each
//! server's freshest login (the latest `expiresAt`) reaches every store
//! that lacks it or holds an older one. The record keeps fingerprints,
//! never tokens.
//!
//! The user's own `.credentials.json` is only read: while clauth manages
//! it (its global account link), Roamgate never writes there.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::files::{fingerprint, read_object, write_private};

const KEY: &str = "mcpOAuth";

fn login_fingerprint(login: &Value) -> String {
    let token = login
        .get("refreshToken")
        .or_else(|| login.get("accessToken"))
        .and_then(Value::as_str)
        .map_or_else(|| login.to_string(), str::to_owned);
    fingerprint(&token)
}

fn expires(login: &Value) -> i64 {
    login.get("expiresAt").and_then(Value::as_i64).unwrap_or(0)
}

/// The record of the previous pass: what each source held (server to
/// fingerprint) and the logins signed out of.
#[derive(Default)]
struct Record {
    held: BTreeMap<String, BTreeMap<String, String>>,
    tombstones: BTreeSet<String>,
}

impl Record {
    fn read(path: &Path) -> Self {
        let Some(object) = read_object(path) else {
            return Self::default();
        };
        let held = object
            .get("held")
            .and_then(Value::as_object)
            .map(|held| {
                held.iter()
                    .map(|(source, servers)| {
                        let servers = servers
                            .as_object()
                            .map(|servers| {
                                servers
                                    .iter()
                                    .filter_map(|(server, fp)| {
                                        Some((server.clone(), fp.as_str()?.to_owned()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        (source.clone(), servers)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tombstones = object
            .get("tombstones")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|fp| fp.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Self { held, tombstones }
    }

    fn write(&self, path: &Path) -> io::Result<()> {
        let mut object = Map::new();
        object.insert("version".into(), json!(1));
        object.insert("held".into(), json!(self.held));
        object.insert("tombstones".into(), json!(self.tombstones));
        write_private(path, &object)
    }
}

/// A source's logins: None when its file is missing or holds no
/// `mcpOAuth` (nothing to learn a sign-out from).
fn logins_of(path: &Path) -> Result<Option<Map<String, Value>>, ()> {
    if !path.exists() {
        return Ok(None);
    }
    let Some(credentials) = read_object(path) else {
        return Err(());
    };
    Ok(credentials.get(KEY).and_then(Value::as_object).cloned())
}

/// One pass. `user` is read only; `stores` (the accounts' credentials
/// files) are read and written; `record` is this sync's own file.
/// Returns how many stores it wrote.
pub fn sync_mcp_logins(user: &Path, stores: &[PathBuf], record_path: &Path) -> io::Result<usize> {
    let mut record = Record::read(record_path);
    let sources: Vec<(PathBuf, bool)> = std::iter::once((user.to_path_buf(), false))
        .chain(stores.iter().map(|store| (store.clone(), true)))
        .collect();
    let mut current: Vec<Option<Map<String, Value>>> = Vec::new();
    for (path, _) in &sources {
        // A file caught being written: the next pass.
        let Ok(logins) = logins_of(path) else {
            return Ok(0);
        };
        current.push(logins);
    }
    // Sign-outs since the previous pass.
    for ((path, _), logins) in sources.iter().zip(&current) {
        let (Some(logins), Some(held)) = (
            logins,
            record.held.get(&path.to_string_lossy().into_owned()),
        ) else {
            continue;
        };
        for (server, fp) in held {
            if !logins.contains_key(server) {
                record.tombstones.insert(fp.clone());
            }
        }
    }
    // Each server's freshest login nobody signed out of.
    let mut best: BTreeMap<String, Value> = BTreeMap::new();
    for logins in current.iter().flatten() {
        for (server, login) in logins {
            if record.tombstones.contains(&login_fingerprint(login)) {
                continue;
            }
            if best
                .get(server)
                .is_none_or(|kept| expires(login) > expires(kept))
            {
                best.insert(server.clone(), login.clone());
            }
        }
    }
    let mut written = 0;
    for ((path, writable), logins) in sources.iter().zip(current.iter_mut()) {
        if !*writable || path.parent().is_none_or(|dir| !dir.is_dir()) {
            continue;
        }
        let mut next = logins.clone().unwrap_or_default();
        next.retain(|_, login| !record.tombstones.contains(&login_fingerprint(login)));
        for (server, login) in &best {
            if next
                .get(server)
                .is_none_or(|kept| expires(kept) < expires(login))
            {
                next.insert(server.clone(), login.clone());
            }
        }
        if Some(&next) == logins.as_ref() || (logins.is_none() && next.is_empty()) {
            continue;
        }
        let mut credentials = read_object(path).unwrap_or_default();
        credentials.insert(KEY.into(), Value::Object(next.clone()));
        write_private(path, &credentials)?;
        *logins = Some(next);
        written += 1;
    }
    // What each source holds now; a tombstone ends once nobody holds it.
    let mut held_now = BTreeSet::new();
    record.held.clear();
    for ((path, _), logins) in sources.iter().zip(&current) {
        let Some(logins) = logins else { continue };
        let servers: BTreeMap<String, String> = logins
            .iter()
            .map(|(server, login)| (server.clone(), login_fingerprint(login)))
            .collect();
        held_now.extend(servers.values().cloned());
        record
            .held
            .insert(path.to_string_lossy().into_owned(), servers);
    }
    record.tombstones.retain(|fp| held_now.contains(fp));
    record.write(record_path)?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, logins: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            json!({"claudeAiOauth": {"refreshToken": "own"}, "mcpOAuth": logins}).to_string(),
        )
        .unwrap();
    }

    fn logins(path: &Path) -> Value {
        read_object(path).unwrap()[KEY].clone()
    }

    #[test]
    fn logins_reach_every_account_and_sign_outs_spread() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user/.credentials.json");
        let work = temp.path().join("work/.credentials.json");
        let perso = temp.path().join("perso/.credentials.json");
        let record = temp.path().join("record.json");
        write(
            &user,
            json!({"gh": {"refreshToken": "g1", "expiresAt": 10}}),
        );
        write(
            &work,
            json!({"gh": {"refreshToken": "g0", "expiresAt": 5}, "lin": {"refreshToken": "l1", "expiresAt": 1}}),
        );
        std::fs::create_dir_all(perso.parent().unwrap()).unwrap();
        let stores = [work.clone(), perso.clone()];

        assert_eq!(sync_mcp_logins(&user, &stores, &record).unwrap(), 2);
        assert_eq!(logins(&work)["gh"]["refreshToken"], "g1");
        assert_eq!(logins(&perso)["lin"]["refreshToken"], "l1");
        // The account's own sign-in is never touched; the user's file never
        // written.
        assert_eq!(
            read_object(&work).unwrap()["claudeAiOauth"]["refreshToken"],
            "own"
        );
        assert!(logins(&user).get("lin").is_none());
        assert_eq!(sync_mcp_logins(&user, &stores, &record).unwrap(), 0);

        // perso signs out of lin: it leaves work too, and does not come back.
        let mut credentials = read_object(&perso).unwrap();
        credentials[KEY].as_object_mut().unwrap().remove("lin");
        write_private(&perso, &credentials).unwrap();
        assert_eq!(sync_mcp_logins(&user, &stores, &record).unwrap(), 1);
        assert!(logins(&work).get("lin").is_none());
        assert_eq!(sync_mcp_logins(&user, &stores, &record).unwrap(), 0);

        // A new login to lin is shared again.
        let mut credentials = read_object(&work).unwrap();
        credentials[KEY]["lin"] = json!({"refreshToken": "l2", "expiresAt": 2});
        write_private(&work, &credentials).unwrap();
        sync_mcp_logins(&user, &stores, &record).unwrap();
        assert_eq!(logins(&perso)["lin"]["refreshToken"], "l2");
    }

    #[test]
    fn a_file_being_written_stops_the_pass() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user.json");
        let work = temp.path().join("work.json");
        std::fs::write(&user, "{").unwrap();
        write(&work, json!({}));
        assert_eq!(
            sync_mcp_logins(&user, &[work], &temp.path().join("r.json")).unwrap(),
            0
        );
    }
}

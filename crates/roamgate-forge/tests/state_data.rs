//! mr-cache/state.json between the Bun server and the Rust core (the plan's
//! section 5.7): forward (a file of the shapes Bun writes and older ones is
//! read the same by both), backward (what Rust writes, Bun reads the same,
//! and the reverse), and coexistence (around a flip only the owner writes,
//! and each side picks up what the other wrote). Skipped, saying why, when
//! bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::TestClock;
use roamgate_base::paths::{DataContext, Platform};
use roamgate_forge::mr_cache::{Loaded, MrCache, Persist, mr_cache_path, reader_options};
use serde_json::{Value, json};

const NOW: i64 = 1_790_000_000_000;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the Bun side of the cache cannot run");
    }
    found
}

/// Runs `source` in Bun with mr-cache/cache.ts as `cache` and the file's
/// path as `path`; its last stdout line, parsed.
fn bun_run(bun: &Path, home: &Path, path: &Path, source: &str) -> Value {
    let module = serde_json::to_string(&repo().join("server/src/mr-cache/cache.ts")).unwrap();
    let script = format!(
        "import * as cache from {module};\nconst path = {};\nconst now = {NOW};\n{source}",
        serde_json::to_string(path).unwrap()
    );
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.lines().last().unwrap_or("null")).unwrap()
}

/// What Bun's cache answers for each key, read from the file.
const BUN_PEEK: &str = r#"
const keys = JSON.parse(process.argv[1] ?? "[]");
const c = cache.createMrCache({ path, now: () => now });
console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, c.peek(k) ?? null]))));
"#;

fn bun_peek(bun: &Path, home: &Path, path: &Path, keys: &[&str]) -> Value {
    let source = BUN_PEEK.replace(
        "process.argv[1] ?? \"[]\"",
        &serde_json::to_string(&serde_json::to_string(keys).unwrap()).unwrap(),
    );
    bun_run(bun, home, path, &source)
}

fn persist(root: &Path, may_write: bool) -> Persist {
    Persist {
        context: DataContext::new(root, Platform::current(), None),
        path: mr_cache_path(root),
        may_write: Arc::new(move || may_write),
        delay: Duration::ZERO,
    }
}

fn rust_peek(cache: &MrCache, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| {
                (
                    (*key).to_owned(),
                    cache.peek(key).map_or(Value::Null, |answer| {
                        json!({"value": answer.value.value, "fetchedAt": answer.fetched_at, "stale": answer.stale})
                    }),
                )
            })
            .collect(),
    )
}

fn open(root: &Path, clock: &TestClock, may_write: bool) -> MrCache {
    MrCache::open(
        Arc::new(clock.clone()),
        Some(persist(root, may_write)),
        None,
    )
}

const KEYS: [&str; 6] = [
    "chip\0\0gitlab\ngitlab.example.com\ngroup/project\n12",
    "card\0[\"\",\"/home/u/src/app\"]\0[[\"summary\",false]]",
    "session\0\0/home/u/src/app\0",
    "chip\0ssh-host\0github\ngithub.com\nowner/repo\n7",
    "old",
    "broken",
];

/// The shapes Bun writes today (a chip, a card with its HEAD, a session, a
/// remote checkout's chip) and older or damaged entries: no version, an
/// answer kept before cards had a HEAD, a fractional time, an entry
/// without times.
fn sample_state() -> String {
    let chip = json!({"ref": {"provider": "gitlab", "host": "gitlab.example.com", "project": "group/project", "number": 12},
        "state": "ready", "fetchedAt": "2026-09-21T10:00:00.000Z",
        "request": {"state": "open", "title": "Make it faster", "url": "https://gitlab.example.com/group/project/-/merge_requests/12",
            "pipeline": {"status": "running"}}});
    let card = json!({"state": "ready", "root": "/home/u/src/app", "branch": "feature", "remotes": [],
        "refreshedAt": "2026-09-21T10:00:00.000Z", "request": {"state": "opened", "url": "https://gitlab.example.com/group/project/-/merge_requests/12"}, "ci": "success"});
    let session = json!({"repos": [{"root": "/home/u/src/app", "branch": "feature", "requests": []}], "fetchedAt": "2026-09-21T10:00:00.000Z"});
    let gh = json!({"ref": {"provider": "github", "host": "github.com", "project": "owner/repo", "number": 7}, "state": "not_found", "fetchedAt": "x"});
    json!({"version": 1, "entries": [
        [KEYS[0], {"value": chip, "fetchedAt": NOW - 10_000, "ttlMs": 75_000}],
        [KEYS[1], {"value": card, "fetchedAt": NOW - 700_000, "ttlMs": 600_000, "head": "refs/heads/feature\nabc123"}],
        [KEYS[2], {"value": session, "fetchedAt": NOW - 1000, "ttlMs": 300_000}],
        [KEYS[3], {"value": gh, "fetchedAt": NOW - 2, "ttlMs": 900_000}],
        [KEYS[4], {"value": "kept before cards had a HEAD", "fetchedAt": NOW - 5000, "ttlMs": 60_000, "head": ""}],
        [KEYS[5], {"value": 1}],
    ]})
    .to_string()
}

#[tokio::test]
async fn forward_both_read_a_file_of_every_shape_the_same() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("data");
    let path = mr_cache_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, sample_state()).unwrap();
    let clock = TestClock::new(NOW);
    let rust = rust_peek(&open(&root, &clock, false), &KEYS);
    let seen = bun_peek(&bun, home.path(), &path, &KEYS);
    assert_eq!(rust, seen);
    assert_eq!(seen[KEYS[1]]["stale"], json!(true));
    assert_eq!(seen[KEYS[5]], Value::Null);
    // An older file without a version, and a broken one: the same.
    std::fs::write(&path, sample_state().replace("\"version\":1,", "")).unwrap();
    assert_eq!(
        rust_peek(&open(&root, &clock, false), &KEYS),
        bun_peek(&bun, home.path(), &path, &KEYS)
    );
    std::fs::write(&path, "{\"entries\": [").unwrap();
    assert_eq!(
        rust_peek(&open(&root, &clock, false), &KEYS),
        bun_peek(&bun, home.path(), &path, &KEYS)
    );
}

#[tokio::test]
async fn backward_what_one_writes_the_other_reads_the_same() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("data");
    let path = mr_cache_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, sample_state()).unwrap();
    let clock = TestClock::new(NOW);
    // Rust reads Bun's file, reads a key again and adds one, and writes.
    let rust = open(&root, &clock, true);
    for (key, value, head) in [
        (
            KEYS[1],
            json!({"state": "no_match", "root": "/home/u/src/app"}),
            Some("refs/heads/feature\ndef456"),
        ),
        (
            "chip\0\0gitlab\ngitlab.example.com\ngroup/project\n13",
            json!({"state": "ready", "request": {"state": "merged"}}),
            None,
        ),
    ] {
        let options = reader_options(
            move || {
                let value = value.clone();
                Box::pin(async move {
                    Ok(Loaded {
                        value,
                        ttl_ms: 900_000,
                        failed: false,
                        paused_until: None,
                    })
                })
            },
            true,
            head.map(|head| Some(head.to_owned())),
            0,
        );
        rust.get(key, &options).await.unwrap();
    }
    rust.flush().await;
    let keys: Vec<&str> = KEYS
        .iter()
        .copied()
        .chain(["chip\0\0gitlab\ngitlab.example.com\ngroup/project\n13"])
        .collect();
    assert_eq!(
        rust_peek(&rust, &keys),
        bun_peek(&bun, home.path(), &path, &keys)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Bun writes what it read and one more answer; Rust reads it the same.
    let written = bun_run(
        &bun,
        home.path(),
        &path,
        r#"
const c = cache.createMrCache({ path, now: () => now + 1000, saveDelayMs: 0 });
await c.get("session\0\0/other\0", { ttl: () => 300000, load: async () => ({ repos: [] }), head: async () => "refs/heads/x\n1" });
c.flush();
console.log(JSON.stringify(c.size()));
"#,
    );
    assert_eq!(written, json!(keys.len()));
    let mut all = keys.clone();
    all.push("session\0\0/other\0");
    let reread = open(&root, &clock, false);
    assert_eq!(
        rust_peek(&reread, &all),
        bun_peek(&bun, home.path(), &path, &all)
    );
    assert_eq!(
        reread
            .entries()
            .iter()
            .find(|(k, _)| k == "session\0\0/other\0")
            .unwrap()
            .1
            .head
            .as_deref(),
        Some("refs/heads/x\n1")
    );
}

#[tokio::test]
async fn coexistence_only_the_owner_writes_around_a_flip() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("data");
    let path = mr_cache_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, sample_state()).unwrap();
    let clock = TestClock::new(NOW);
    // Rust owns it: Bun's cache, asked to write, leaves the file alone.
    let rust = open(&root, &clock, true);
    let before = std::fs::read(&path).unwrap();
    bun_run(
        &bun,
        home.path(),
        &path,
        r#"
const c = cache.createMrCache({ path, now: () => now, saveDelayMs: 0, mayWrite: () => false });
await c.get("bun-only", { ttl: () => 60000, load: async () => "late Bun read" });
c.flush();
console.log("null");
"#,
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    // A Rust cache that lost the family writes nothing either.
    let given_back = open(&root, &clock, false);
    given_back
        .get(
            "rust-late",
            &reader_options(
                || Box::pin(async { Ok(Loaded::kept(json!(1), 60_000)) }),
                true,
                None,
                0,
            ),
        )
        .await
        .unwrap();
    given_back.close().await;
    assert_eq!(std::fs::read(&path).unwrap(), before);
    // Rust writes, gives the family back (close), Bun reads it and writes.
    rust.get(
        "rust-owned",
        &reader_options(
            || Box::pin(async { Ok(Loaded::kept(json!("from Rust"), 60_000)) }),
            true,
            None,
            0,
        ),
    )
    .await
    .unwrap();
    rust.close().await;
    let seen = bun_run(
        &bun,
        home.path(),
        &path,
        r#"
const c = cache.createMrCache({ path, now: () => now, saveDelayMs: 0, mayWrite: () => true });
const known = c.peek("rust-owned")?.value ?? null;
await c.get("bun-owned", { ttl: () => 60000, load: async () => "from Bun" });
c.flush();
console.log(JSON.stringify(known));
"#,
    );
    assert_eq!(seen, json!("from Rust"));
    // Rust takes it again: it reads what Bun wrote.
    let again = open(&root, &clock, true);
    assert_eq!(
        again.peek("bun-owned").unwrap().value.value,
        json!("from Bun")
    );
    assert_eq!(
        again.peek("rust-owned").unwrap().value.value,
        json!("from Rust")
    );
    assert!(again.peek("bun-only").is_none() && again.peek("rust-late").is_none());
}

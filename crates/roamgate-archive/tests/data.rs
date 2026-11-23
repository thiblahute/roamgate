//! The archive's data against the Bun server's (the plan's section 5.7):
//!
//! - forward: an archive Bun wrote (raw/ frames, archive.sqlite, the text
//!   repo) and an old index.sqlite from before the archive's step 5 read by
//!   both, with identical search, lookup, open, health and status answers;
//! - backward: what Rust writes (sync, the text pass, rebuild-db) read by
//!   Bun identically, and Bun carrying on from it;
//! - coexistence: the writers take turns on one archive around a flip and
//!   back, and the per-host lock excludes the other side;
//! - cost (section 5.9): sync and search of a fixed corpus not slower.
//!
//! Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

use roamgate_archive::engine::{SyncOptions, rebuild_archive_db, run_sync};
use roamgate_archive::health::archive_health;
use roamgate_archive::hosts::{ArchiveRuntime, SystemExec};
use roamgate_archive::lock::acquire_host_lock;
use roamgate_archive::open::{OpenRequest, open_archived};
use roamgate_archive::search::{SearchOptions, SearchQuery, search_archive};
use roamgate_archive::session::{LookupOptions, lookup_session};
use roamgate_archive::settings::normalize_archive_settings;
use roamgate_archive::store::open_archive_db;
use roamgate_archive::text_repo::{TextPassOptions, text_repo_status, update_text_repo};
use serde_json::{Value, json};

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
        eprintln!("skipped: bun is not on PATH, the Bun side of the archive cannot run");
    }
    found
}

fn module(name: &str) -> String {
    serde_json::to_string(&repo().join(format!("server/src/archive/{name}.ts"))).unwrap()
}

/// The Bun side: `read` prints what it reads, `sync` syncs and renders,
/// `hold` holds a host lock until killed, `try` tries one.
fn bun_script() -> String {
    format!(
        r#"
import {{ runSync, rebuildArchiveDb }} from {engine};
import {{ archiveHealth }} from {health};
import {{ acquireHostLock }} from {lock};
import {{ openArchived }} from {open};
import {{ searchArchive }} from {search};
import {{ lookupSession }} from {session};
import {{ normalizeArchiveSettings }} from {settings};
import {{ openArchiveDb }} from {store};
import {{ textRepoStatus, updateTextRepo }} from {textRepo};
import {{ writeFileSync }} from "node:fs";
const [mode, home, archiveDir, rawSettings, extra] = process.argv.slice(1);
const settings = normalizeArchiveSettings(JSON.parse(rawSettings));
const runtime = {{ homeDir: home, platform: "linux", env: {{}}, dataDir: home + "/.config/roamgate" }};
if (mode === "sync") {{
  await runSync({{ settings, runtime, archiveDir, localOnly: true, log: () => {{}} }});
  const text = await updateTextRepo({{ archiveDir, settings, host: "testhost", log: () => {{}}, repack: false }});
  console.log(JSON.stringify({{ text: text.status }}));
}} else if (mode === "rebuild-db") {{
  (await rebuildArchiveDb(archiveDir, settings, () => {{}})).close(false);
}} else if (mode === "hold") {{
  const release = acquireHostLock(archiveDir, extra);
  writeFileSync(archiveDir + "/held", release ? "yes" : "no");
  await Bun.sleep(60_000);
}} else if (mode === "try") {{
  const release = acquireHostLock(archiveDir, extra);
  console.log(release ? "acquired" : "refused");
  release?.();
}} else {{
  const plan = JSON.parse(extra);
  const searches = [];
  for (const query of plan.searches) searches.push(await searchArchive(archiveDir, query, settings));
  const opened = openArchiveDb(archiveDir, {{ readonly: true }});
  const lookups = plan.lookups.map((id) => lookupSession(opened.db, id));
  const health = archiveHealth(opened.db, archiveDir, settings, runtime, 0);
  opened.db.close(false);
  const opens = [];
  for (const request of plan.opens) opens.push(await openArchived(archiveDir, settings, request));
  console.log(JSON.stringify({{ searches, lookups, opens, health, status: textRepoStatus(archiveDir, settings) }}));
}}
"#,
        engine = module("engine"),
        health = module("health"),
        lock = module("lock"),
        open = module("open"),
        search = module("search"),
        session = module("session"),
        settings = module("settings"),
        store = module("store"),
        textRepo = module("text-repo"),
    )
}

fn run_bun(bun: &Path, args: &[&str]) -> String {
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .env_remove("ROAMGATE_ARCHIVE_HOST")
        .arg("-e")
        .arg(bun_script())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

struct Machine {
    _dir: tempfile::TempDir,
    home: PathBuf,
    archive: PathBuf,
    runtime: ArchiveRuntime,
}

fn settings_json() -> Value {
    json!({"host": "testhost", "hide": [{"project": "hidden"}]})
}

fn machine() -> Machine {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    Machine {
        archive: home.join(".config/roamgate/archive"),
        runtime: ArchiveRuntime {
            home_dir: home.clone(),
            platform: "linux".into(),
            env: Arc::new(|_| None),
            data_dir: home.join(".config/roamgate"),
            context: roamgate_base::paths::DataContext::new(
                &home,
                roamgate_base::paths::Platform::current(),
                None,
            ),
            hostname: "testhost".into(),
        },
        home,
        _dir: dir,
    }
}

const SESSION: &str = "11111111-2222-3333-4444-555555555555";
const CODEX: &str = "019e460d-9751-78d0-8c76-e6d9c9f466b4";

fn line(value: Value) -> String {
    format!("{value}\n")
}

/// Claude (with a subagent, a title, a cost, tool output, a hidden
/// project, the prompt history), Codex and Pi sessions; `extra` grows the
/// main transcript.
fn write_sessions(home: &Path, extra: usize) {
    let project = home.join(".claude/projects/-Users-tester-devel-proj");
    std::fs::create_dir_all(project.join(SESSION).join("subagents")).unwrap();
    let mut main = String::new();
    main += &line(json!({"type": "ai-title", "aiTitle": "Zoo \u{e9}t\u{e9} planning"}));
    main += &line(json!({"type": "cost-state", "totalCostUSD": 1.25}));
    for i in 0..(20 + extra) {
        let content = match i % 4 {
            0 => json!(format!("the flamingo number {i} \u{1f9a9} and the walrus")),
            1 => {
                json!([{"type": "text", "text": format!("answer {i}")}, {"type": "tool_use", "name": "Bash", "input": {"command": format!("grep flamingo {i}")}}])
            }
            2 => {
                json!([{"type": "tool_result", "content": format!("quokka in tool output {i}\nsecond line")}])
            }
            _ => json!(format!(
                "multi\nline\tmessage {i} glpat-abcdefghijklmnopqrst"
            )),
        };
        main += &line(json!({
            "type": if i % 2 == 0 { "user" } else { "assistant" },
            "timestamp": format!("2026-11-{:02}T10:{:02}:00.000Z", 10 + i / 30, i % 60),
            "cwd": "/Users/tester/devel/proj",
            "uuid": format!("u{i}"),
            "message": {"role": "user", "content": content},
        }));
    }
    std::fs::write(project.join(format!("{SESSION}.jsonl")), main).unwrap();
    std::fs::write(
        project.join(SESSION).join("subagents/agent-1.jsonl"),
        line(json!({"type": "user", "timestamp": "2026-11-10T11:00:00Z", "message": {"content": "subagent walrus task"}})),
    )
    .unwrap();
    let hidden = home.join(".claude/projects/-Users-tester-hidden");
    std::fs::create_dir_all(&hidden).unwrap();
    std::fs::write(
        hidden.join("aaaaaaaa-2222-3333-4444-555555555555.jsonl"),
        line(json!({"type": "user", "timestamp": "2026-11-09T10:00:00Z", "message": {"content": "secret flamingo"}})),
    )
    .unwrap();
    std::fs::write(
        home.join(".claude/history.jsonl"),
        line(json!({"display": "find the flamingo", "timestamp": 1_762_000_000_000_i64, "project": "/Users/tester/devel/proj"})),
    )
    .unwrap();
    let codex = home.join(format!(
        ".codex/sessions/2026/05/20/rollout-2026-05-20T11-42-36-{CODEX}.jsonl"
    ));
    std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
    std::fs::write(
        &codex,
        [
            json!({"timestamp": "2026-05-20T09:42:36Z", "type": "session_meta", "payload": {"id": CODEX, "cwd": "/tmp/work"}}),
            json!({"timestamp": "2026-05-20T09:42:37Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "find the capybara flamingo"}]}}),
            json!({"timestamp": "2026-05-20T09:42:39Z", "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c", "output": "capybara.txt"}}),
            json!({"timestamp": "2026-05-20T09:42:40Z", "type": "brand_new_kind"}),
        ]
        .into_iter()
        .map(line)
        .collect::<String>(),
    )
    .unwrap();
    let pi = home.join(".pi/agent/sessions/--tmp-work--/2026-07-14T14-26-46-608Z_019f6105-eecf-7d83-b4bf-37244d32b16a.jsonl");
    std::fs::create_dir_all(pi.parent().unwrap()).unwrap();
    std::fs::write(
        &pi,
        [
            json!({"type": "session", "cwd": "/tmp/work", "timestamp": "2026-07-14T14:26:46Z"}),
            json!({"type": "message", "timestamp": "2026-07-14T14:27:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "hello quokka flamingo"}]}}),
        ]
        .into_iter()
        .map(line)
        .collect::<String>(),
    )
    .unwrap();
}

fn plan() -> Value {
    json!({
        "searches": [
            {"terms": ["flamingo"], "limit": 50},
            {"terms": ["flamingo"], "limit": 2, "recent": true},
            {"terms": ["\"the walrus\""], "limit": 50},
            {"terms": ["walrus", "NOT", "subagent"], "limit": 50},
            {"terms": ["fl[a-z]+go"], "limit": 50, "regex": true},
            {"terms": ["flamingo"], "limit": 50, "history": true, "role": "user"},
            {"terms": ["flamingo"], "limit": 50, "project": "proj", "since": "2026-11-10"},
            {"terms": ["quokka"], "limit": 50, "toolOutput": true},
            {"terms": ["glpat-abcdefghijklmnopqrst"], "limit": 50},
            {"terms": ["AND"], "limit": 50},
        ],
        "lookups": ["11111111", SESSION, "019e460d", "nothing-here", "0"],
        "opens": [
            {"key": format!("testhost/claude/-Users-tester-devel-proj/{SESSION}.jsonl"), "line": 5},
            {"key": format!("testhost/claude/-Users-tester-devel-proj/{SESSION}.jsonl"), "line": 8, "raw": true},
            {"key": format!("testhost/codex/2026/05/20/rollout-2026-05-20T11-42-36-{CODEX}.jsonl"), "line": 2},
            {"key": "testhost/claude/../../x", "line": 1},
        ],
    })
}

/// What the Rust side reads, in the Bun script's shape.
fn rust_read(m: &Machine) -> Value {
    let settings = normalize_archive_settings(Some(&settings_json()));
    let plan = plan();
    let searches: Vec<Value> = plan["searches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|query| {
            let query: SearchQuery = serde_json::from_value(query.clone()).unwrap();
            serde_json::to_value(
                search_archive(&m.archive, &query, &settings, SearchOptions::default()).unwrap(),
            )
            .unwrap()
        })
        .collect();
    let db = open_archive_db(&m.runtime.context, &m.archive, true).unwrap();
    let lookups: Vec<Value> = plan["lookups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            serde_json::to_value(
                lookup_session(&db.conn, id.as_str().unwrap(), &LookupOptions::default()).unwrap(),
            )
            .unwrap()
        })
        .collect();
    let health = serde_json::to_value(
        archive_health(
            &db.conn,
            &m.archive,
            &settings,
            &m.runtime,
            0,
            roamgate_archive::now_ms(),
        )
        .unwrap(),
    )
    .unwrap();
    drop(db);
    let opens: Vec<Value> = plan["opens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|request| {
            let request = OpenRequest {
                key: request["key"].as_str().unwrap().into(),
                line: request["line"].as_i64().unwrap(),
                raw: request["raw"] == json!(true),
                context: None,
            };
            serde_json::to_value(open_archived(&m.archive, &settings, &request, None).unwrap())
                .unwrap()
        })
        .collect();
    json!({
        "searches": searches,
        "lookups": lookups,
        "opens": opens,
        "health": health,
        "status": text_repo_status(&m.archive, &settings),
    })
}

fn bun_read(bun: &Path, m: &Machine) -> Value {
    let out = run_bun(
        bun,
        &[
            "read",
            &m.home.to_string_lossy(),
            &m.archive.to_string_lossy(),
            &settings_json().to_string(),
            &plan().to_string(),
        ],
    );
    serde_json::from_str(&out).unwrap()
}

/// What depends on the moment or the disk, not on the data.
fn comparable(mut value: Value) -> Value {
    let health = &mut value["health"];
    health.as_object_mut().unwrap().remove("now");
    health.as_object_mut().unwrap().remove("disk");
    // The free disk warning depends on the moment too.
    if let Some(warnings) = health["warnings"].as_array_mut() {
        warnings.retain(|w| !w.as_str().unwrap_or("").contains("GB free"));
    }
    for host in health["hosts"].as_array_mut().unwrap() {
        host.as_object_mut().unwrap().remove("age_hours");
    }
    health.as_object_mut().unwrap().remove("ok");
    value
}

fn assert_same(bun: Value, rust: Value) {
    let (bun, rust) = (comparable(bun), comparable(rust));
    for key in ["searches", "lookups", "opens", "health", "status"] {
        assert_eq!(
            bun[key], rust[key],
            "{key} differs:\nbun  {}\nrust {}",
            bun[key], rust[key]
        );
    }
}

fn rust_sync(m: &Machine) {
    let settings = normalize_archive_settings(Some(&settings_json()));
    let started = Instant::now();
    run_sync(SyncOptions {
        settings: &settings,
        runtime: &m.runtime,
        archive_dir: &m.archive,
        hosts: None,
        agents: None,
        local_only: true,
        exec: &SystemExec,
        log: &mut |_| {},
    })
    .unwrap();
    let synced = started.elapsed();
    update_text_repo(TextPassOptions {
        archive_dir: &m.archive,
        settings: &settings,
        host: "testhost",
        log: &mut |_| {},
        busy: None,
        now_ms: None,
        repack: false,
    })
    .unwrap();
    if std::env::var("ARCHIVE_PERF").as_deref() == Ok("1") {
        eprintln!(
            "rust sync {synced:?}, text pass {:?}",
            started.elapsed() - synced
        );
    }
}

fn bun_sync(bun: &Path, m: &Machine) {
    run_bun(
        bun,
        &[
            "sync",
            &m.home.to_string_lossy(),
            &m.archive.to_string_lossy(),
            &settings_json().to_string(),
            "",
        ],
    );
}

#[test]
fn forward_an_archive_bun_wrote_reads_the_same_in_both() {
    let Some(bun) = bun() else { return };
    let m = machine();
    write_sessions(&m.home, 0);
    bun_sync(&bun, &m);
    assert_same(bun_read(&bun, &m), rust_read(&m));
}

#[test]
fn forward_an_old_index_sqlite_is_read_by_both_then_migrated_by_either() {
    let Some(bun) = bun() else { return };
    let m = machine();
    write_sessions(&m.home, 0);
    bun_sync(&bun, &m);
    // The archive before step 5: version 1 in index.sqlite, FTS tables
    // beside the same files and meta.
    let db = m.archive.join("archive.sqlite");
    let legacy = m.archive.join("index.sqlite");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
    }
    std::fs::rename(&db, &legacy).unwrap();
    let _ = std::fs::remove_file(m.archive.join("archive.sqlite-wal"));
    let _ = std::fs::remove_file(m.archive.join("archive.sqlite-shm"));
    {
        let conn = rusqlite::Connection::open(&legacy).unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='trigram');
             CREATE TABLE docs(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, ts TEXT, role TEXT, kind TEXT, tool TEXT) STRICT;
             INSERT INTO fts(text) VALUES ('old index text');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    assert_same(bun_read(&bun, &m), rust_read(&m));
    assert!(legacy.exists(), "a reader migrates nothing");
    // A Rust writer migrates it; Bun reads the result the same.
    rust_sync(&m);
    assert!(!legacy.exists());
    assert!(db.exists());
    assert_same(bun_read(&bun, &m), rust_read(&m));
}

#[test]
fn backward_bun_reads_what_rust_wrote_and_carries_on() {
    let Some(bun) = bun() else { return };
    let m = machine();
    write_sessions(&m.home, 0);
    rust_sync(&m);
    assert_same(bun_read(&bun, &m), rust_read(&m));
    // Bun's sync carries on from Rust's offsets and text state.
    write_sessions(&m.home, 9);
    bun_sync(&bun, &m);
    assert_same(bun_read(&bun, &m), rust_read(&m));
    // A Rust rebuild-db, then Bun's text pass has nothing new.
    let settings = normalize_archive_settings(Some(&settings_json()));
    drop(rebuild_archive_db(&m.runtime, &m.archive, Some(&settings), &mut |_| {}).unwrap());
    let out = run_bun(
        &bun,
        &[
            "sync",
            &m.home.to_string_lossy(),
            &m.archive.to_string_lossy(),
            &settings_json().to_string(),
            "",
        ],
    );
    assert_eq!(out, r#"{"text":"unchanged"}"#);
    assert_same(bun_read(&bun, &m), rust_read(&m));
}

#[test]
fn coexistence_writers_take_turns_around_a_flip_and_back() {
    let Some(bun) = bun() else { return };
    let rust_first = machine();
    let bun_only = machine();
    for m in [&rust_first, &bun_only] {
        write_sessions(&m.home, 0);
    }
    // Bun owns, then Rust (the flip), then Bun again (the flip back),
    // against Bun alone throughout: the same archive at each step.
    bun_sync(&bun, &rust_first);
    bun_sync(&bun, &bun_only);
    for (step, extra) in [(0, 4), (1, 8), (2, 12)] {
        write_sessions(&rust_first.home, extra);
        write_sessions(&bun_only.home, extra);
        if step == 1 {
            rust_sync(&rust_first);
        } else {
            bun_sync(&bun, &rust_first);
        }
        bun_sync(&bun, &bun_only);
        let mut expected = comparable(bun_read(&bun, &bun_only));
        let mut got = comparable(bun_read(&bun, &rust_first));
        // The archive directories differ by path only.
        for value in [&mut expected, &mut got] {
            value["health"]
                .as_object_mut()
                .unwrap()
                .remove("archive_dir");
            for key in ["path", "head", "last_commit", "pack_bytes"] {
                value["status"].as_object_mut().unwrap().remove(key);
                value["health"]["text"].as_object_mut().unwrap().remove(key);
            }
            for host in value["health"]["hosts"].as_array_mut().unwrap() {
                for key in ["last_sync", "last_attempt"] {
                    host.as_object_mut().unwrap().remove(key);
                }
                for agent in host["agents"].as_array_mut().unwrap() {
                    for key in ["last_sync", "last_attempt"] {
                        agent.as_object_mut().unwrap().remove(key);
                    }
                }
            }
            value["health"]["sizes"]
                .as_object_mut()
                .unwrap()
                .remove("raw_bytes");
            value["health"]["sizes"]
                .as_object_mut()
                .unwrap()
                .remove("db_bytes");
        }
        for key in ["searches", "lookups", "opens", "health", "status"] {
            assert_eq!(expected[key], got[key], "step {step}: {key} differs");
        }
    }
}

#[test]
fn coexistence_the_host_lock_excludes_the_other_side() {
    let Some(bun) = bun() else { return };
    let m = machine();
    std::fs::create_dir_all(&m.archive).unwrap();
    let args = |mode: &str| -> Vec<String> {
        vec![
            mode.into(),
            m.home.to_string_lossy().into_owned(),
            m.archive.to_string_lossy().into_owned(),
            "{}".into(),
            "testhost".into(),
        ]
    };
    let held = acquire_host_lock(&m.archive, "testhost").unwrap().unwrap();
    let refs: Vec<String> = args("try");
    let refs: Vec<&str> = refs.iter().map(String::as_str).collect();
    assert_eq!(run_bun(&bun, &refs), "refused");
    drop(held);
    assert_eq!(run_bun(&bun, &refs), "acquired");
    let mut holder = Command::new(&bun)
        .current_dir(repo().join("server"))
        .arg("-e")
        .arg(bun_script())
        .args(args("hold"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let flag = m.archive.join("held");
    let started = Instant::now();
    while !flag.exists() && started.elapsed().as_secs() < 30 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(std::fs::read_to_string(&flag).unwrap(), "yes");
    assert!(acquire_host_lock(&m.archive, "testhost").unwrap().is_none());
    holder.kill().unwrap();
    holder.wait().unwrap();
    // A dead holder's lock is taken over.
    assert!(acquire_host_lock(&m.archive, "testhost").unwrap().is_some());
}

/// Section 5.9: the archive's ingest and search on a fixed corpus are not
/// slower than Bun's. Run with `ARCHIVE_PERF=1`: the two sides alternate
/// round by round under whatever load the machine has, and their medians
/// are compared.
#[test]
fn cost_sync_and_search_of_a_fixed_corpus_are_not_slower() {
    let Some(bun) = bun() else { return };
    if std::env::var("ARCHIVE_PERF").as_deref() != Ok("1") {
        eprintln!("skipped: set ARCHIVE_PERF=1 to time the archive against Bun");
        return;
    }
    let corpus = |home: &Path| {
        for s in 0..120 {
            let dir = home.join(format!(".claude/projects/-Users-tester-p{}", s % 6));
            std::fs::create_dir_all(&dir).unwrap();
            let body: String = (0..150)
                .map(|i| {
                    line(json!({"type": if i % 2 == 0 { "user" } else { "assistant" },
                        "timestamp": format!("2026-11-{:02}T10:{:02}:00Z", 1 + s % 28, i % 60),
                        "message": {"content": format!("session {s} message {i} about the flamingo and {}", "lorem ipsum ".repeat(20))}}))
                })
                .collect();
            std::fs::write(
                dir.join(format!("{s:08}-2222-3333-4444-555555555555.jsonl")),
                body,
            )
            .unwrap();
        }
    };
    // Both sides alternate under the same load, each first every other
    // round, and are judged on their medians (ARCHIVE_PERF_ROUNDS, 11 by
    // default): a busy machine slows both alike. A sync round starts from
    // fresh archives of the same corpus.
    let rounds: usize = std::env::var("ARCHIVE_PERF_ROUNDS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(11)
        .max(1);
    let (mut bun_syncs, mut rust_syncs) = (Vec::new(), Vec::new());
    let mut last = None;
    for round in 0..rounds {
        let rust_side = machine();
        let bun_side = machine();
        corpus(&rust_side.home);
        corpus(&bun_side.home);
        let mut time_bun = || {
            let started = Instant::now();
            bun_sync(&bun, &bun_side);
            bun_syncs.push(started.elapsed().as_secs_f64());
        };
        let mut time_rust = || {
            let started = Instant::now();
            rust_sync(&rust_side);
            rust_syncs.push(started.elapsed().as_secs_f64());
        };
        if round % 2 == 0 {
            time_bun();
            time_rust();
        } else {
            time_rust();
            time_bun();
        }
        last = Some((rust_side, bun_side));
    }
    let (rust_side, bun_side) = last.unwrap();
    let (mut bun_reads, mut rust_reads) = (Vec::new(), Vec::new());
    for round in 0..rounds {
        let mut time_bun = || {
            let started = Instant::now();
            bun_read(&bun, &bun_side);
            bun_reads.push(started.elapsed().as_secs_f64());
        };
        let mut time_rust = || {
            let started = Instant::now();
            rust_read(&rust_side);
            rust_reads.push(started.elapsed().as_secs_f64());
        };
        if round % 2 == 0 {
            time_bun();
            time_rust();
        } else {
            time_rust();
            time_bun();
        }
    }
    let quantile = |times: &mut Vec<f64>, q: f64| {
        times.sort_by(f64::total_cmp);
        times[((times.len() - 1) as f64 * q).round() as usize]
    };
    let (bun_median, bun_p90) = (quantile(&mut bun_reads, 0.5), quantile(&mut bun_reads, 0.9));
    let (rust_median, rust_p90) = (
        quantile(&mut rust_reads, 0.5),
        quantile(&mut rust_reads, 0.9),
    );
    let (bun_sync_median, bun_sync_p90) =
        (quantile(&mut bun_syncs, 0.5), quantile(&mut bun_syncs, 0.9));
    let (rust_sync_median, rust_sync_p90) = (
        quantile(&mut rust_syncs, 0.5),
        quantile(&mut rust_syncs, 0.9),
    );
    eprintln!(
        "archive cost over {rounds} rounds: sync bun median {bun_sync_median:.3} s p90 {bun_sync_p90:.3} s, rust median {rust_sync_median:.3} s p90 {rust_sync_p90:.3} s; reads bun median {bun_median:.3} s p90 {bun_p90:.3} s, rust median {rust_median:.3} s p90 {rust_p90:.3} s"
    );
    assert!(
        rust_sync_median <= bun_sync_median,
        "sync slower than Bun's"
    );
    // Bun's reads include its start: within 10% is the gate of 5.9.
    assert!(rust_median <= bun_median * 1.1, "search slower than Bun's");
}

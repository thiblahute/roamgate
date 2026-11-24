//! The history repo written both ways (the plan's section 5.7): Bun's
//! history (server/src/history) and Rust's render the same stores into the
//! same files, byte for byte, with the same commits (authors, dates of the
//! Work changes, messages and trailers); each finds nothing to commit in a
//! repo the other wrote, and each change after that gives both the same
//! commit. Skipped, saying why, when bun is not on PATH.
//!
//! `ROAMGATE_HISTORY_REAL_COPY=<home>` runs the same against a scratch
//! copy of a real data root (`<home>/.config/roamgate`, its `history/` the
//! repo both start from, copied twice): never the user's own.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use roamgate_base::paths::{DataContext, Platform};
use roamgate_history::area::{ReviewSource, history_paths};
use roamgate_history::place::history_areas;
use roamgate_history::repo::{HistoryRepo, PassInput, PassResult};
use roamgate_history::reviews::SqliteReviews;
use roamgate_history::work::{WorkChange, local_user, work_commit, work_description_of};
use serde_json::{Value, json};

fn root() -> PathBuf {
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
        eprintln!("skipped: bun is not on PATH, the Bun side of the history cannot run");
    }
    found
}

/// Runs a Bun script with `args`, in the server's directory, HOME `home`.
fn run_bun(bun: &Path, home: &Path, source: &str, args: &[&str]) -> String {
    let output = Command::new(bun)
        .current_dir(root().join("server"))
        .env("HOME", home)
        .env("ROAMGATE_ROOT", root())
        .env_remove("ROAMGATE_DATA_DIR")
        .env_remove("ROAMGATE_SETTINGS_PATH")
        .env_remove("ROAMGATE_CONNECTIONS_PATH")
        .env_remove("ROAMGATE_REVIEW_DIR")
        .env_remove("ROAMGATE_WORK_DIR")
        .arg("-e")
        .arg(source)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Bun's pass: every area of `home`'s data, then the Work changes given.
const BUN_PASS: &str = r#"
    const root = process.env.ROAMGATE_ROOT;
    const { historyPaths } = await import(`${root}/server/src/history/area.ts`);
    const { historyAreas } = await import(`${root}/server/src/history/place.ts`);
    const { HistoryRepo } = await import(`${root}/server/src/history/repo.ts`);
    const { workCommit, workDescriptionOf } = await import(`${root}/server/src/history/work.ts`);
    const { openReviewStorage } = await import(`${root}/server/src/review/storage.ts`);
    const [home, dir, changes] = process.argv.slice(1);
    const paths = historyPaths({}, home, "linux");
    const reviews = openReviewStorage(paths.reviews);
    const work = JSON.parse(changes).map((change) =>
      workCommit(change, change.item ? workDescriptionOf(reviews, change.item) : null, "desk"));
    const repo = new HistoryRepo({ dir, host: "desk" });
    const result = await repo.pass({
      areas: historyAreas(paths, () => reviews).map((area) => ({ area, ids: null })),
      work,
    });
    reviews.close?.();
    console.log(JSON.stringify(result));
"#;

/// Bun's review store, seeded: sessions and threads as given.
const BUN_SEED_REVIEWS: &str = r#"
    const root = process.env.ROAMGATE_ROOT;
    const { openReviewStorage } = await import(`${root}/server/src/review/storage.ts`);
    const [dir, seed] = process.argv.slice(1);
    const storage = openReviewStorage(dir);
    const { sessions, threads, deleted } = JSON.parse(seed);
    for (const session of sessions) storage.saveSession(session);
    for (const thread of threads) storage.saveThread(thread);
    for (const id of deleted ?? []) storage.deleteThread(id);
    storage.close?.();
    console.log("ok");
"#;

fn rust_pass(home: &Path, dir: &Path, changes: &[WorkChange]) -> PassResult {
    let env: [(&str, &str); 0] = [];
    let context = DataContext::new(home, Platform::Unix, None);
    let paths = history_paths(&env, &context);
    let reviews: Arc<dyn ReviewSource> = Arc::new(SqliteReviews::new(&paths.reviews));
    let user = local_user();
    let work = changes
        .iter()
        .map(|change| {
            let description = change
                .item
                .as_ref()
                .and_then(|item| work_description_of(Some(reviews.as_ref()), item));
            work_commit(change, description.as_deref(), "desk", &user)
        })
        .collect();
    let source = reviews.clone();
    let areas = history_areas(&paths, Arc::new(move || Some(source.clone())));
    HistoryRepo::new(dir, "desk", false, None)
        .pass(&PassInput {
            areas: areas.into_iter().map(|area| (area, None)).collect(),
            work,
            light: true,
        })
        .unwrap()
}

fn bun_pass(bun: &Path, home: &Path, dir: &Path, changes: &[WorkChange]) -> Value {
    let changes = serde_json::to_string(changes).unwrap();
    let out = run_bun(
        bun,
        home,
        BUN_PASS,
        &[
            &home.display().to_string(),
            &dir.display().to_string(),
            &changes,
        ],
    );
    serde_json::from_str(out.lines().last().unwrap_or("null")).unwrap()
}

/// The repo's files (not .git), path to bytes.
fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                if entry.file_name() != ".git" {
                    walk(base, &path, out);
                }
            } else {
                let relative = path.strip_prefix(base).unwrap().display().to_string();
                out.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The commits since `since` (all when None): author, its date for a
/// Work change (Roamgate's own are dated when they ran), committer, the
/// whole message.
fn log(dir: &Path, since: Option<&str>) -> Vec<String> {
    let range = since.map(|since| format!("{since}..HEAD"));
    let mut args = vec!["log", "--format=%an|%ae|%aI|%cn|%ce|%B%x00"];
    if let Some(range) = &range {
        args.push(range);
    }
    git(dir, &args)
        .split('\0')
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let fields: Vec<&str> = entry.splitn(6, '|').collect();
            let date = if fields[0] == "Roamgate" {
                ""
            } else {
                fields[2]
            };
            format!(
                "{}|{}|{date}|{}|{}|{}",
                fields[0], fields[1], fields[3], fields[4], fields[5]
            )
        })
        .collect()
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

fn assert_same_trees(bun_repo: &Path, rust_repo: &Path) {
    let (a, b) = (tree(bun_repo), tree(rust_repo));
    let a_paths: Vec<&String> = a.keys().collect();
    let b_paths: Vec<&String> = b.keys().collect();
    assert_eq!(a_paths, b_paths, "the same files");
    for (path, bytes) in &a {
        assert!(
            b[path] == *bytes,
            "{path} differs:\n--- Bun\n{}\n--- Rust\n{}",
            String::from_utf8_lossy(bytes),
            String::from_utf8_lossy(&b[path])
        );
    }
}

fn write(path: PathBuf, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

const S1: &str = "00087e46c486e70c";
const S2: &str = "4e6b9c5f4b89b44b";
const ITEM: &str = "8a057f17bc9203bc";

fn item(state: &str, updated: &str) -> Value {
    json!({
        "id": ITEM,
        "project": "roamgate",
        "title": "History and backup, a long title that goes past the sixty characters",
        "state": state,
        "tags": ["history", "été"],
        "owner": {"session": "desktop/w35:p1"},
        "links": [{"kind": "file", "path": "plans/data-history.md"}],
        "createdAt": "2026-11-22T11:12:26.494Z",
        "updatedAt": updated,
        "by": "agent",
        "review": S1,
    })
}

fn thread(id: &str, session: &str, anchor: Value, bodies: &[&str]) -> Value {
    json!({
        "id": id,
        "sessionId": session,
        "kind": "discussion",
        "anchor": anchor,
        "comments": bodies.iter().enumerate().map(|(index, body)| json!({
            "id": format!("{id}c{index}"),
            "author": if index > 0 { "Claude" } else { "you" },
            "body": body,
            "createdAt": "2026-11-22T11:12:26.600Z",
            "updatedAt": "2026-11-22T11:12:26.600Z",
            "ratio": 0.5,
        })).collect::<Vec<_>>(),
        "resolved": false,
        "createdAt": "2026-11-22T11:12:26.600Z",
        "updatedAt": "2026-11-22T11:12:26.600Z",
    })
}

/// A data root shaped like a real one: every area, secrets, odd ids,
/// integer-like keys, numbers JavaScript prints its own way, images.
fn seed(bun: &Path, home: &Path) {
    let data = home.join(".config").join("roamgate");
    write(
        data.join("settings.json"),
        &json!({
            "version": 1,
            "title_suffix": "desk",
            "api_token": "x",
            "ui": {"10": "ten", "9": "nine", "zoom": 1.0, "big": 1e21, "small": 0.000001, "note": "glpat-abcdefghijklmnopqr"},
            "profiles": {"list": [{"id": "p", "env": {"ANTHROPIC_AUTH_TOKEN": "t", "HOME": "/h"}}]},
            "history": {"enabled": true},
            "mr_reviews": {
                "order": ["a", "b"],
                "efforts": [{"id": "e1", "name": "Big"}],
                "hints": "token glpat-abcdefghijklmnopqrst",
                "clones": {"x": 1},
            },
            "something_new": {"x": 1},
        })
        .to_string(),
    );
    write(
        data.join("work").join("work.json"),
        &json!({
            "version": 1,
            "projects": [{"id": "roamgate", "name": "Roamgate", "roots": [], "done": {"kind": "deployed"}}, {"id": "a/b", "name": "Odd"}],
            "items": [item("doing", "2026-11-22T12:00:00.000Z"), {
                "id": "0000000000000001", "project": "a/b", "title": "T", "state": "open", "tags": [],
                "links": [], "createdAt": "2026-11-20T08:00:00.000Z", "updatedAt": "2026-11-20T08:00:00.000Z", "by": "user"
            }],
        })
        .to_string(),
    );
    write(
        data.join("work").join("history.jsonl"),
        &format!(
            "{}\n{}\n{{\"torn",
            json!({"at": "x", "item": ITEM, "by": "user", "change": {"state": "doing", "2": 1}}),
            json!({"at": "y", "item": ITEM, "by": "user", "change": {"note": "sk-ant-abcdefghijklmnopqrstuvwx"}})
        ),
    );
    write(
        data.join("connections.json"),
        r#"{"version":1,"profiles":[{"id":"mac","password":"x","port":22.0}]}"#,
    );
    write(
        data.join("move-hosts.json"),
        r#"{"serving":"desk","hosts":[]}"#,
    );
    write(
        data.join("session-profiles.json"),
        r#"{"version":1,"sessions":{}}"#,
    );
    write(data.join("companion-memory.json"), r#"{"summary":"s"}"#);
    write(
        data.join("companion-memories").join("home.md"),
        "---\nname: home\n---\nLives here.\n",
    );
    write(
        data.join("companion-memories").join("notes.txt"),
        "not a memory",
    );
    write(
        data.join("taste.json"),
        r#"{"version":1,"profile":{"top":["a"]},"avoid":["x"],"picks":["y"],"updated":5}"#,
    );
    write(
        data.join("voice.json"),
        r#"{"speech_rate":1.1,"helper":"/h"}"#,
    );
    write(
        data.join("voice-profiles").join("anna.json"),
        r#"{"name":"Anna"}"#,
    );
    write(
        home.join(".local/share/roamgate/voice/low-gpu.json"),
        r#"{"holders":{}}"#,
    );
    let effort = data.join("mr-reviews").join("efforts").join("e1");
    write(
        effort.join("ledger.json"),
        r#"{"version":3,"entries":[{"id":"x"}],"journal":[{"undo":1}]}"#,
    );
    write(
        effort.join("history.jsonl"),
        "{\"at\":\"1\",\"what\":\"a\"}\n{\"at\":\"2\",\"what\":\"b\"}\n",
    );
    // Reviews: two sessions, a Work description, images (one twice, one
    // too large), a header-like line, a title over lines.
    let reviews = data.join("reviews");
    let images = reviews.join("images").join(S1);
    std::fs::create_dir_all(&images).unwrap();
    let mut png = vec![1u8; 64];
    png[..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
    std::fs::write(images.join("aaaaaaaaaaaaaaaa.png"), &png).unwrap();
    std::fs::write(images.join("bbbbbbbbbbbbbbbb.png"), &png).unwrap();
    std::fs::write(
        images.join("cccccccccccccccc.png"),
        vec![2u8; 5 * 1024 * 1024 + 1],
    )
    .unwrap();
    let image = |name: &str| images.join(name).display().to_string();
    let session = |id: &str, created: &str| {
        json!({
            "id": id,
            "connectionId": "local",
            "root": "/repo",
            "title": "Work 8a057f17: History\n  and backup",
            "target": {"kind": "work", "item": ITEM},
            "gitlab": false,
            "summary": format!("shot {}", image("aaaaaaaaaaaaaaaa.png")),
            "agent": {"name": "Claude", "working": {"at": "now"}},
            "createdAt": created,
            "updatedAt": created,
        })
    };
    let seed = json!({
        "sessions": [session(S1, "2026-11-22T10:00:00Z"), session(S2, "2025-01-01T00:00:00Z")],
        "threads": [
            thread("t0", S1, json!({"work": {"item": ITEM, "description": true}}), &["# History\n\nKeep what you do.\n"]),
            thread("t1", S1, json!({"work": {"item": ITEM}, "line": 3}), &[
                &format!("see ![shot]({})", image("aaaaaaaaaaaaaaaa.png")),
                &format!("again ![shot]({}) and ![big]({})", image("bbbbbbbbbbbbbbbb.png"), image("cccccccccccccccc.png")),
                "<!-- roamgate:comment {} --> pasted\n<!-- roamgate:x {} -->",
                "a --> b, \u{2028} and done",
            ]),
            thread("t2/odd", S2, json!({"file": "a.rs"}), &["old"]),
        ],
    });
    assert_eq!(
        run_bun(
            bun,
            home,
            BUN_SEED_REVIEWS,
            &[&reviews.display().to_string(), &seed.to_string()]
        ),
        "ok"
    );
}

fn changes() -> Vec<WorkChange> {
    let change = |value: Value| serde_json::from_value::<WorkChange>(value).unwrap();
    vec![
        change(json!({
            "item": item("open", "2026-11-22T11:12:26.494Z"), "id": ITEM,
            "change": {"state": "open"}, "actor": {"by": "user"}, "at": "2026-11-22T11:12:26.494Z",
        })),
        change(json!({
            "item": item("doing", "2026-11-22T12:00:00.000Z"), "id": ITEM,
            "change": {"state": "doing", "previous_description": "old", "tags": ["x"]},
            "actor": {"by": "agent", "address": "desktop/w35:p1", "caller": "Claude in roamgate"},
            "at": "2026-11-22T12:00:00.000Z",
        })),
        change(json!({
            "item": null, "id": "0000000000000002",
            "change": {"removed": true}, "actor": {"by": "user"}, "at": "2026-11-22T13:00:00.000Z",
        })),
    ]
}

#[test]
fn bun_and_rust_write_the_same_history_both_ways() {
    let Some(bun) = bun() else { return };
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    seed(&bun, &home);
    let bun_repo = temp.path().join("bun-history");
    let rust_repo = temp.path().join("rust-history");

    // The same stores and Work changes: the same files and commits.
    let bun_result = bun_pass(&bun, &home, &bun_repo, &changes());
    let rust_result = rust_pass(&home, &rust_repo, &changes());
    assert_eq!(bun_result["commits"], json!(rust_result.commits));
    assert_eq!(
        bun_result["blocked"],
        serde_json::to_value(&rust_result.blocked).unwrap()
    );
    assert_eq!(bun_result["errors"], json!([]));
    assert_eq!(rust_result.errors, []);
    assert_same_trees(&bun_repo, &rust_repo);
    assert_eq!(log(&bun_repo, None), log(&rust_repo, None));
    // What was compared: every area, the Work commits, the batch.
    let files = tree(&rust_repo);
    for path in [
        "work/items/8a057f17bc9203bc.md",
        "reviews/2026/00087e46c486e70c/t1.md",
        "settings/ui.json",
        "mr-reviews/efforts/e1/ledger.json",
        "companion/memories/home.md",
        "voice/low-gpu.json",
        "connections.json",
    ] {
        assert!(files.contains_key(path), "{path} written");
    }
    assert_eq!(
        log(&rust_repo, None).len(),
        4,
        "start, two Work commits, the batch"
    );

    // Each finds nothing to do in the other's repo.
    let (bun_head, rust_head) = (head(&bun_repo), head(&rust_repo));
    assert_eq!(rust_pass(&home, &bun_repo, &[]).commits, 0);
    assert_eq!(bun_pass(&bun, &home, &rust_repo, &[])["commits"], 0);
    assert_eq!(
        (head(&bun_repo), head(&rust_repo)),
        (bun_head.clone(), rust_head.clone())
    );

    // A change after that: Rust on Bun's repo, Bun on Rust's, the same commit.
    let data = home.join(".config").join("roamgate");
    let mut settings: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap())
            .unwrap();
    settings["title_suffix"] = json!("laptop");
    settings["mr_reviews"]["order"] = json!(["b", "a"]);
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    std::fs::remove_file(data.join("companion-memories").join("home.md")).unwrap();
    std::fs::write(
        data.join("voice-profiles").join("bob.json"),
        r#"{"name":"Bob","key":"ghp_abcdefghijklmnopqrstuvwxyz0123"}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("companion-memories").join("leak.md"),
        "a token glpat-abcdefghijklmnopqrst here\n",
    )
    .unwrap();
    let seed = json!({
        "sessions": [],
        "threads": [thread("t3", S2, json!({"work": {"item": ITEM}}), &["new"])],
        "deleted": ["t1"],
    });
    run_bun(
        &bun,
        &home,
        BUN_SEED_REVIEWS,
        &[
            &data.join("reviews").display().to_string(),
            &seed.to_string(),
        ],
    );
    let later = vec![
        serde_json::from_value::<WorkChange>(json!({
            "item": item("done", "2026-11-23T09:00:00.000Z"), "id": ITEM,
            "change": {"state": "done"}, "actor": {"by": "agent", "caller": "Pi"}, "at": "2026-11-23T09:00:00.000Z",
        }))
        .unwrap(),
    ];
    let on_bun = rust_pass(&home, &bun_repo, &later);
    let on_rust = bun_pass(&bun, &home, &rust_repo, &later);
    assert_eq!(json!(on_bun.commits), on_rust["commits"]);
    assert_eq!(
        serde_json::to_value(&on_bun.blocked).unwrap(),
        on_rust["blocked"]
    );
    assert!(!on_bun.blocked.is_empty(), "the leak is kept out");
    assert_same_trees(&bun_repo, &rust_repo);
    assert_eq!(
        log(&bun_repo, Some(&bun_head)),
        log(&rust_repo, Some(&rust_head))
    );
}

/// A scratch copy of a real data root (`ROAMGATE_HISTORY_REAL_COPY`): its
/// history repo copied twice, Bun's pass on one and Rust's on the other.
#[test]
fn a_real_data_root_gives_the_same_pass_both_ways() {
    let Some(home) = std::env::var_os("ROAMGATE_HISTORY_REAL_COPY").map(PathBuf::from) else {
        eprintln!("skipped: ROAMGATE_HISTORY_REAL_COPY names no scratch copy of a data root");
        return;
    };
    let Some(bun) = bun() else { return };
    let data = home.join(".config").join("roamgate");
    let original = data.join("history");
    assert!(
        !original.starts_with(dirs_home()),
        "a scratch copy, never the user's own data"
    );
    let temp = tempfile::tempdir().unwrap();
    let copy = |name: &str| {
        let target = temp.path().join(name);
        let status = Command::new("cp")
            .arg("-a")
            .arg(&original)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success());
        target
    };
    let bun_repo = copy("bun");
    let rust_repo = copy("rust");
    let before = head(&bun_repo);
    let bun_result = bun_pass(&bun, &home, &bun_repo, &changes());
    let rust_result = rust_pass(&home, &rust_repo, &changes());
    eprintln!(
        "real copy: Bun {} commits, Rust {} commits, {} files",
        bun_result["commits"],
        rust_result.commits,
        tree(&rust_repo).len()
    );
    assert_eq!(bun_result["commits"], json!(rust_result.commits));
    assert_eq!(bun_result["errors"], json!([]));
    assert_eq!(rust_result.errors, []);
    assert_same_trees(&bun_repo, &rust_repo);
    assert_eq!(
        log(&bun_repo, Some(&before)),
        log(&rust_repo, Some(&before))
    );
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".config")
}

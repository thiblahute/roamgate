//! `<data>/mr-reviews/state.json` opened both ways (the plan's section 5.7
//! and Phase 8's exit): what the Bun server's store
//! (server/src/mr-reviews/store.ts) wrote, Rust reads and writes back with
//! the bytes Bun would write reopening it (forward); what Rust wrote, Bun
//! reads and writes back with the bytes Rust would (backward). A store
//! started empty writes no `inferred` and `homes` until it is reopened, on
//! both sides. Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use roamgate_base::paths::{DataContext, Platform};
use roamgate_mr_reviews::store::{MrStore, state_path};
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
        eprintln!("skipped: bun is not on PATH, the Bun side of state.json cannot run");
    }
    found
}

/// Opens the store at `path` in Bun, applies `change` (a JS function body
/// given `state` and `store`), and lets it write.
fn bun_store(bun: &Path, home: &Path, path: &Path, change: &str) {
    let source = format!(
        r#"
const {{ openMrStore }} = await import(process.argv[1]);
const store = openMrStore(process.argv[2]);
store.update((state) => {{ {change} }});
"#
    );
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_DATA_DIR")
        .arg("-e")
        .arg(source)
        .arg(repo().join("server/src/mr-reviews/store.ts"))
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn item() -> Value {
    json!({
        "key": "gitlab:gitlab.example.org/g/p#7",
        "provider": "gitlab",
        "host": "gitlab.example.org",
        "project": "g/p",
        "number": 7,
        "title": "Fix the caf\u{e9} \u{1f600} \"quoted\" <b>",
        "author": "bob",
        "updatedAt": "2026-11-23T10:00:00.000Z",
        "files": ["a.rs", "b/c.ts"],
        "score": 1.5,
        "big": 1e21,
        "small": 1e-7,
        "unknown": { "kept": [null, true, -0.0] },
    })
}

#[test]
fn what_bun_wrote_rust_writes_back_unchanged() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let context = DataContext::new(home.path(), Platform::current(), None);
    let path = state_path(&context.data_root());
    let item = item();
    bun_store(
        &bun,
        home.path(),
        &path,
        &format!(
            r#"state.items = [{item}];
state.seen["{key}"] = {{ at: "2026-11-23T10:00:00.000Z", marker: "m" }};
state.inferenceAt = "2026-11-23T09:00:00.000Z";
state.homes = {{ "{key}": {{ path: "/src/p", connectionId: "local" }} }};
store.setFeedback(state.items[0], "interested", "2026-11-23T10:01:00.000Z");"#,
            key = item["key"].as_str().unwrap()
        ),
    );
    let bun_again = path.with_extension("bun.json");
    std::fs::copy(&path, &bun_again).unwrap();
    bun_store(&bun, home.path(), &bun_again, "");
    let mut store = MrStore::open(context, &path);
    assert_eq!(store.get()["items"][0]["title"], item["title"]);
    store.update(|_| {}).unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        std::fs::read_to_string(&bun_again).unwrap()
    );
}

#[test]
fn what_rust_wrote_bun_writes_back_unchanged() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let context = DataContext::new(home.path(), Platform::current(), None);
    let path = state_path(&context.data_root());
    let item = item();
    let mut store = MrStore::open(context.clone(), &path);
    store
        .update(|state| {
            state.insert("items".into(), json!([item.clone()]));
            state.insert("inferenceAt".into(), json!("2026-11-23T09:00:00.000Z"));
            state["ranked"]
                .as_object_mut()
                .unwrap()
                .insert("k".into(), json!({ "pick": true, "reason": "ges" }));
        })
        .unwrap();
    store
        .set_feedback(
            item.as_object().unwrap(),
            Some("not_interested"),
            "2026-11-23T10:01:00.000Z",
        )
        .unwrap();
    let rust_again = path.with_extension("rust.json");
    std::fs::copy(&path, &rust_again).unwrap();
    MrStore::open(context, &rust_again).update(|_| {}).unwrap();
    bun_store(&bun, home.path(), &path, "");
    let written = std::fs::read_to_string(&path).unwrap();
    assert_eq!(written, std::fs::read_to_string(&rust_again).unwrap());
    assert!(written.contains(r#""inferred":{},"homes":{},"inferenceAt""#));
}

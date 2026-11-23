//! Opening a search hit (archive/open.test.ts) and reading a deleted
//! transcript back from the archive (archive/file-access.test.ts).

use std::path::PathBuf;
use std::sync::Arc;

use roamgate_archive::engine::{SyncOptions, run_sync};
use roamgate_archive::hosts::{ArchiveRuntime, SystemExec};
use roamgate_archive::open::{OpenRequest, open_archived};
use roamgate_archive::rpc::{archive_open_request, archive_search_query};
use roamgate_archive::search::{SearchOptions, search_archive};
use roamgate_archive::settings::{ArchiveSettings, normalize_archive_settings};
use roamgate_archive::text_repo::{TextPassOptions, update_text_repo};
use serde_json::json;

const SESSION: &str = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";

fn key() -> String {
    format!("testhost/claude/-Users-t-proj/{SESSION}.jsonl")
}

fn settings() -> ArchiveSettings {
    normalize_archive_settings(Some(&json!({"host": "testhost"})))
}

fn runtime(root: &std::path::Path) -> ArchiveRuntime {
    ArchiveRuntime {
        home_dir: root.to_path_buf(),
        platform: "linux".into(),
        env: Arc::new(|_| None),
        data_dir: root.join("data"),
        context: roamgate_base::paths::DataContext::new(
            root,
            roamgate_base::paths::Platform::current(),
            None,
        ),
        hostname: "testhost".into(),
    }
}

fn sync(runtime: &ArchiveRuntime, archive: &std::path::Path) {
    run_sync(SyncOptions {
        settings: &settings(),
        runtime,
        archive_dir: archive,
        hosts: None,
        agents: None,
        local_only: true,
        exec: &SystemExec,
        log: &mut |_| {},
    })
    .unwrap();
}

fn zoo() -> (tempfile::TempDir, ArchiveRuntime, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let runtime = runtime(root);
    let archive = root.join("archive");
    let project = root.join(".claude/projects/-Users-t-proj");
    std::fs::create_dir_all(&project).unwrap();
    let mut records = vec![json!({"type": "ai-title", "aiTitle": "Zoo planning"})];
    for i in 0..30 {
        let content = match i {
            20 => {
                json!([{"type": "text", "text": "now the lemur"}, {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}])
            }
            21 => json!([{"type": "tool_result", "content": "lemur.txt in the output"}]),
            _ => json!(format!("message {i}")),
        };
        records.push(json!({
            "type": if i % 2 == 1 { "assistant" } else { "user" },
            "timestamp": format!("2026-11-14T10:{i:02}:00Z"),
            "message": {"content": content},
        }));
    }
    std::fs::write(
        project.join(format!("{SESSION}.jsonl")),
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    sync(&runtime, &archive);
    update_text_repo(TextPassOptions {
        archive_dir: &archive,
        settings: &settings(),
        host: "testhost",
        log: &mut |_| {},
        busy: None,
        now_ms: None,
        repack: false,
    })
    .unwrap();
    (dir, runtime, archive)
}

#[test]
fn a_text_repo_line_opens_its_record_with_context_from_raw() {
    let (_dir, runtime, archive) = zoo();
    let query = archive_search_query(&json!({"query": "lemur"})).unwrap();
    let options = SearchOptions {
        runtime: Some(&runtime),
        ..SearchOptions::default()
    };
    let found = search_archive(&archive, &query, &settings(), options).unwrap();
    let hit = &found.hits[0];
    assert_eq!(hit.key.as_deref(), Some(key().as_str()));
    let request = archive_open_request(&json!({"key": hit.key, "line": hit.doc})).unwrap();
    let opened = open_archived(&archive, &settings(), &request, Some(&runtime))
        .unwrap()
        .unwrap();
    assert_eq!(opened.hit, Some(22));
    assert_eq!(opened.title.as_deref(), Some("Zoo planning"));
    let marked = opened.records.iter().find(|r| r.hit).unwrap();
    assert_eq!(
        marked
            .messages
            .iter()
            .map(|m| m.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["text", "tool_use"]
    );
    assert_eq!(opened.records.len(), 1 + 12 + 9);
    assert_eq!((opened.before, opened.after), (true, false));
    assert!(
        opened
            .records
            .iter()
            .any(|r| r.messages.iter().any(|m| m.text.contains("lemur.txt")))
    );
}

#[test]
fn a_raw_hit_opens_by_record_line_hidden_and_bad_keys_open_nothing() {
    let (_dir, _runtime, archive) = zoo();
    let raw = open_archived(
        &archive,
        &settings(),
        &OpenRequest {
            key: key(),
            line: 23,
            raw: true,
            context: None,
        },
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        raw.records.iter().find(|r| r.hit).unwrap().messages[0].kind,
        "tool_result"
    );
    let hidden = normalize_archive_settings(Some(
        &json!({"host": "testhost", "hide": [{"project": "proj"}]}),
    ));
    let request = OpenRequest {
        key: key(),
        line: 2,
        raw: false,
        context: None,
    };
    assert_eq!(
        open_archived(&archive, &hidden, &request, None).unwrap(),
        None
    );
    let bad = OpenRequest {
        key: "testhost/claude/../../etc/passwd".into(),
        line: 1,
        raw: false,
        context: None,
    };
    assert_eq!(
        open_archived(&archive, &settings(), &bad, None).unwrap(),
        None
    );
}

#[test]
fn a_transcript_the_agent_deleted_is_read_from_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let runtime = runtime(root);
    let archive = root.join("archive");
    let project = root.join(".claude/projects/-Users-t-proj");
    std::fs::create_dir_all(&project).unwrap();
    let path = project.join("bbbbbbbb-1111-2222-3333-444444444444.jsonl");
    let body = format!(
        "{}\n{}\n",
        json!({"type": "user", "message": {"content": "hello"}}),
        json!({"type": "assistant", "message": {"content": "world"}})
    );
    std::fs::write(&path, &body).unwrap();
    sync(&runtime, &archive);
    std::fs::remove_file(&path).unwrap();
    let text = path.to_string_lossy();
    let stat = roamgate_archive::file_access::stat(&text, &settings(), &archive, &runtime)
        .unwrap()
        .unwrap();
    assert_eq!(stat.size, body.len() as u64);
    let all =
        roamgate_archive::file_access::range(&text, 0, u64::MAX, &settings(), &archive, &runtime)
            .unwrap();
    assert_eq!(all.unwrap(), body.as_bytes());
    let part =
        roamgate_archive::file_access::range(&text, 2, 9, &settings(), &archive, &runtime).unwrap();
    assert_eq!(part.unwrap(), &body.as_bytes()[2..9]);
    let never = project.join("never-archived.jsonl");
    assert_eq!(
        roamgate_archive::file_access::stat(
            &never.to_string_lossy(),
            &settings(),
            &archive,
            &runtime
        )
        .unwrap(),
        None
    );
    assert!(
        std::fs::metadata(archive.join("archive.sqlite"))
            .unwrap()
            .len()
            > 0
    );
}

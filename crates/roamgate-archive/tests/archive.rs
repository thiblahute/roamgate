//! The archive's lifecycle (archive/archive.test.ts): sync, grow, shrink,
//! search through the text repo, rebuild, restore, ingest, health.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roamgate_agents::{map_claude_project, map_cwd};
use roamgate_archive::engine::{SyncOptions, rebuild_archive_db, run_ingest, run_sync};
use roamgate_archive::health::archive_health;
use roamgate_archive::hosts::{ArchiveRuntime, Exec, ExecResult, SystemExec, resolve_hosts};
use roamgate_archive::search::{SearchOptions, SearchQuery, SearchResult, search_archive};
use roamgate_archive::session::{
    LocalFileSource, LookupOptions, ResumeOptions, cat_file, cat_lines, lookup_session,
    resume_session,
};
use roamgate_archive::settings::{ArchiveSettings, normalize_archive_settings};
use roamgate_archive::store::open_archive_db;
use roamgate_archive::sync::SyncStats;
use roamgate_archive::text_repo::{TextPassOptions, update_text_repo};
use roamgate_archive::zstd_frames::archived_digest;
use serde_json::{Value, json};

const SESSION: &str = "11111111-2222-3333-4444-555555555555";

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    runtime: ArchiveRuntime,
    archive: PathBuf,
}

fn runtime_at(home: &Path) -> ArchiveRuntime {
    ArchiveRuntime {
        home_dir: home.to_path_buf(),
        platform: "linux".into(),
        env: Arc::new(|_| None),
        data_dir: home.join(".config/roamgate"),
        context: roamgate_base::paths::DataContext::new(
            home,
            roamgate_base::paths::Platform::current(),
            None,
        ),
        hostname: "testhost".into(),
    }
}

fn record(kind: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({
            "type": kind,
            "timestamp": "2026-11-14T10:00:00.000Z",
            "uuid": format!("u-{}-{}", text.len(), uuid_like()),
            "cwd": "/Users/tester/devel/proj",
            "message": {"role": kind, "content": text},
        })
    )
}

fn uuid_like() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let fixture = Self {
            runtime: runtime_at(&root),
            archive: root.join(".config/roamgate/archive"),
            root,
            _root: dir,
        };
        std::fs::create_dir_all(fixture.claude_dir().join(SESSION).join("subagents")).unwrap();
        fixture
    }

    fn claude_dir(&self) -> PathBuf {
        self.root.join(".claude/projects/-Users-tester-devel-proj")
    }

    fn main(&self) -> PathBuf {
        self.claude_dir().join(format!("{SESSION}.jsonl"))
    }

    fn sync_with(
        &self,
        settings: &ArchiveSettings,
        exec: &dyn Exec,
        local_only: bool,
    ) -> roamgate_archive::engine::SyncReport {
        run_sync(SyncOptions {
            settings,
            runtime: &self.runtime,
            archive_dir: &self.archive,
            hosts: None,
            agents: None,
            local_only,
            exec,
            log: &mut |_| {},
        })
        .unwrap()
    }

    fn sync(&self, settings: &ArchiveSettings) -> indexmap::IndexMap<String, SyncStats> {
        let report = self.sync_with(settings, &SystemExec, true);
        report
            .hosts
            .into_iter()
            .next()
            .map(|h| h.agents)
            .unwrap_or_default()
    }

    fn found(
        &self,
        terms: &str,
        extra: impl FnOnce(&mut SearchQuery),
        settings: &ArchiveSettings,
    ) -> SearchResult {
        update_text_repo(TextPassOptions {
            archive_dir: &self.archive,
            settings,
            host: "testhost",
            log: &mut |_| {},
            busy: None,
            now_ms: None,
            repack: false,
        })
        .unwrap();
        let mut query = SearchQuery {
            terms: terms.split(' ').map(str::to_owned).collect(),
            limit: 50,
            ..SearchQuery::default()
        };
        extra(&mut query);
        search_archive(&self.archive, &query, settings, SearchOptions::default()).unwrap()
    }

    fn lookup(&self, prefix: &str) -> roamgate_archive::session::SessionLookup {
        let db = open_archive_db(&self.runtime.context, &self.archive, false).unwrap();
        lookup_session(&db.conn, prefix, &LookupOptions::default()).unwrap()
    }
}

fn settings() -> ArchiveSettings {
    normalize_archive_settings(Some(&json!({"host": "testhost"})))
}

fn settings_with(extra: Value) -> ArchiveSettings {
    let mut base = json!({"host": "testhost"});
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    normalize_archive_settings(Some(&base))
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn read_all(mut reader: impl Read) -> Vec<u8> {
    let mut out = Vec::new();
    reader.read_to_end(&mut out).unwrap();
    out
}

#[test]
fn archives_indexes_grows_handles_partial_lines_and_shrinks() {
    let f = Fixture::new();
    let s = settings();
    let sub = f.claude_dir().join(SESSION).join("subagents/agent-1.jsonl");
    std::fs::write(
        f.main(),
        record("user", "first flamingo question") + &record("assistant", "an answer"),
    )
    .unwrap();
    std::fs::write(&sub, record("user", "subagent walrus task")).unwrap();
    let stats = &f.sync(&s)["claude"];
    assert_eq!((stats.new, stats.error), (2, 0));
    assert_eq!(f.found("flamingo", |_| {}, &s).total, 1);
    let walrus = f.found("walrus", |_| {}, &s).hits[0].clone();
    assert!(walrus.subagent);
    assert_eq!(walrus.session, SESSION);
    let stats = &f.sync(&s)["claude"];
    assert_eq!((stats.same, stats.new, stats.grown), (2, 0, 0));

    append(&f.main(), &record("user", "second narwhal question"));
    let stats = &f.sync(&s)["claude"];
    assert_eq!((stats.grown, stats.docs), (1, 1));
    assert_eq!(f.found("narwhal", |_| {}, &s).total, 1);
    assert_eq!(f.found("flamingo", |_| {}, &s).total, 1);

    append(
        &f.main(),
        "{\"type\":\"user\",\"message\":{\"content\":\"half pelican",
    );
    f.sync(&s);
    assert_eq!(f.found("pelican", |_| {}, &s).total, 0);
    append(&f.main(), " done\"}}\n");
    f.sync(&s);
    assert_eq!(f.found("pelican", |_| {}, &s).total, 1);

    assert!(
        f.lookup(&SESSION[..8])
            .files
            .iter()
            .all(|file| file.complete)
    );
    let lookup = f.lookup(SESSION);
    let bytes = read_all(cat_file(&f.archive, &lookup, None).unwrap());
    assert_eq!(bytes, std::fs::read(f.main()).unwrap());

    std::fs::write(f.main(), record("user", "rewritten axolotl")).unwrap();
    assert_eq!(f.sync(&s)["claude"].shrunk, 1);
    let dir = f
        .archive
        .join("raw/testhost/claude/-Users-tester-devel-proj");
    let kept = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains(".jsonl.zst."))
        .count();
    assert_eq!(kept, 1);
    assert_eq!(f.found("flamingo", |_| {}, &s).total, 0);
    assert_eq!(f.found("axolotl", |_| {}, &s).total, 1);
    assert!(f.main().exists() && sub.exists());
}

#[test]
fn appended_frames_are_one_valid_zstd_stream_with_a_checksum() {
    let f = Fixture::new();
    std::fs::write(f.main(), record("user", &"alpha".repeat(1000))).unwrap();
    f.sync(&settings());
    append(&f.main(), &record("user", &"beta".repeat(1000)));
    f.sync(&settings());
    let zst = f.archive.join(format!(
        "raw/testhost/claude/-Users-tester-devel-proj/{SESSION}.jsonl.zst"
    ));
    assert_eq!(
        archived_digest(&zst).unwrap().0,
        std::fs::metadata(f.main()).unwrap().len()
    );
}

#[test]
fn a_crash_after_compressing_is_repaired_on_the_next_run() {
    let f = Fixture::new();
    let s = settings();
    std::fs::write(f.main(), record("user", "one gazelle")).unwrap();
    f.sync(&s);
    let zst = f.archive.join(format!(
        "raw/testhost/claude/-Users-tester-devel-proj/{SESSION}.jsonl.zst"
    ));
    append(&zst, "garbage from an interrupted append");
    append(&f.main(), &record("user", "two ibex"));
    f.sync(&s);
    assert_eq!(f.found("ibex", |_| {}, &s).total, 1);
    assert_eq!(
        archived_digest(&zst).unwrap().0,
        std::fs::metadata(f.main()).unwrap().len()
    );
}

#[test]
fn index_rules_hide_and_exclude() {
    let f = Fixture::new();
    let other = f.root.join(".claude/projects/-Users-tester-secret");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(f.main(), record("user", "visible okapi")).unwrap();
    std::fs::write(
        other.join("aaaaaaaa-2222-3333-4444-555555555555.jsonl"),
        record("user", "hidden okapi"),
    )
    .unwrap();
    let hide = settings_with(json!({"hide": [{"project": "secret"}]}));
    f.sync(&hide);
    assert_eq!(f.found("okapi", |_| {}, &settings()).total, 2);
    assert_eq!(f.found("okapi", |_| {}, &hide).total, 1);
    std::fs::remove_dir_all(&f.archive).unwrap();
    let exclude = settings_with(json!({"exclude": [{"project": "secret"}]}));
    assert_eq!(f.sync(&exclude)["claude"].excluded, 1);
    assert_eq!(f.found("okapi", |_| {}, &settings()).total, 1);
}

#[test]
fn the_none_level_archives_a_session_but_keeps_it_out_of_search() {
    let f = Fixture::new();
    std::fs::write(f.main(), record("user", "marmot colony")).unwrap();
    let none = settings_with(json!({"index": {"default": "none", "rules": []}}));
    f.sync(&none);
    assert_eq!(f.found("marmot", |_| {}, &none).total, 0);
    assert!(f.lookup(SESSION).found);
}

#[test]
fn rebuild_db_restores_the_bookkeeping_the_text_repo_carries_on() {
    let f = Fixture::new();
    let s = settings();
    std::fs::write(
        f.main(),
        record("user", "first lemur") + &record("assistant", "reply ocelot"),
    )
    .unwrap();
    f.sync(&s);
    let before = f.found("ocelot", |_| {}, &s).total;
    drop(rebuild_archive_db(&f.runtime, &f.archive, Some(&s), &mut |_| {}).unwrap());
    assert!(f.lookup(SESSION).files[0].complete);
    let pass = update_text_repo(TextPassOptions {
        archive_dir: &f.archive,
        settings: &s,
        host: "testhost",
        log: &mut |_| {},
        busy: None,
        now_ms: None,
        repack: false,
    })
    .unwrap();
    assert_eq!(pass.status, "unchanged");
    assert_eq!(f.found("ocelot", |_| {}, &s).total, before);
    assert_eq!(f.sync(&s)["claude"].error, 0);
}

#[test]
fn history_prompts_are_searched() {
    let f = Fixture::new();
    std::fs::write(
        f.root.join(".claude/history.jsonl"),
        format!("{}\n", json!({"display": "remember the tapir", "timestamp": 1_760_000_000_000_i64, "project": "/x"})),
    )
    .unwrap();
    f.sync(&settings());
    let found = f.found("tapir", |q| q.history = true, &settings());
    assert_eq!(found.history.unwrap().len(), 1);
}

#[test]
fn codex_and_pi_sessions_are_archived_indexed_and_round_trip() {
    let f = Fixture::new();
    let s = settings();
    let codex_id = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    let codex_file = f.root.join(format!(
        ".codex/sessions/2026/05/20/rollout-2026-05-20T11-42-36-{codex_id}.jsonl"
    ));
    std::fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
    let lines = [
        json!({"timestamp": "2026-05-20T09:42:36Z", "type": "session_meta", "payload": {"id": codex_id, "cwd": "/tmp/work"}}),
        json!({"timestamp": "2026-05-20T09:42:37Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "find the capybara"}]}}),
        json!({"timestamp": "2026-05-20T09:42:38Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{\"cmd\":\"ls\"}", "call_id": "c"}}),
        json!({"timestamp": "2026-05-20T09:42:39Z", "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c", "output": "found capybara.txt"}}),
        json!({"timestamp": "2026-05-20T09:42:40Z", "type": "event_msg", "payload": {"type": "token_count"}}),
    ];
    std::fs::write(
        &codex_file,
        lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
    )
    .unwrap();
    let pi_id = "019f6105-eecf-7d83-b4bf-37244d32b16a";
    let pi_file = f.root.join(format!(
        ".pi/agent/sessions/--tmp-work--/2026-07-14T14-26-46-608Z_{pi_id}.jsonl"
    ));
    std::fs::create_dir_all(pi_file.parent().unwrap()).unwrap();
    let pi_lines = [
        json!({"type": "session", "id": pi_id, "cwd": "/tmp/work", "timestamp": "2026-07-14T14:26:46Z"}),
        json!({"type": "message", "id": "a", "timestamp": "2026-07-14T14:27:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "hello quokka"}]}}),
        json!({"type": "message", "id": "b", "timestamp": "2026-07-14T14:27:01Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}, {"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}]}}),
    ];
    std::fs::write(
        &pi_file,
        pi_lines
            .iter()
            .map(|l| format!("{l}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let stats = f.sync(&s);
    assert_eq!(stats["codex"].docs, 3);
    assert_eq!(stats["pi"].docs, 3);
    assert_eq!(
        f.found("capybara", |q| q.agent = Some("codex".into()), &s)
            .total,
        1
    );
    assert_eq!(
        f.found(
            "capybara",
            |q| {
                q.agent = Some("codex".into());
                q.tool_output = true;
            },
            &s
        )
        .total,
        2
    );
    assert_eq!(f.found("quokka", |_| {}, &s).hits[0].agent, "pi");
    let codex = f.lookup(&codex_id[..8]);
    assert_eq!(codex.session, codex_id);
    assert!(!codex.restorable);
    assert_eq!(codex.cwd.as_deref(), Some("/tmp/work"));
    assert_eq!(
        f.lookup(pi_id).resume,
        Some(format!("pi --session {pi_id}"))
    );
    let bytes = read_all(cat_file(&f.archive, &f.lookup(codex_id), None).unwrap());
    assert_eq!(bytes, std::fs::read(&codex_file).unwrap());
}

#[test]
fn restores_only_what_is_missing_maps_the_project_and_appends_a_note() {
    let f = Fixture::new();
    std::fs::write(
        f.main(),
        record("user", "question") + &record("assistant", "answer"),
    )
    .unwrap();
    f.sync(&settings());
    let lookup = f.lookup(SESSION);
    let other = tempfile::tempdir().unwrap();
    let other_runtime = runtime_at(other.path());
    let me = resolve_hosts(&settings(), &other_runtime).remove(0);
    let source = LocalFileSource(&f.archive);
    let options = ResumeOptions {
        runtime: &other_runtime,
        self_host: &me,
        source: &source,
        dry_run: false,
        now: "2026-11-23T00:00:00.000Z".into(),
    };
    let result = resume_session(&lookup, &options).unwrap();
    assert_eq!(
        result
            .restored
            .iter()
            .map(|r| r.status.as_str())
            .collect::<Vec<_>>(),
        vec!["restored"]
    );
    let home = other.path().to_string_lossy();
    let mapped = other
        .path()
        .join(".claude/projects")
        .join(map_claude_project("-Users-tester-devel-proj", &home))
        .join(format!("{SESSION}.jsonl"));
    let text = std::fs::read_to_string(&mapped).unwrap();
    assert!(text.starts_with(&std::fs::read_to_string(f.main()).unwrap()));
    let note: Value = serde_json::from_str(text.trim().lines().last().unwrap()).unwrap();
    assert_eq!(note["type"], "user");
    assert!(
        note["message"]["content"]
            .as_str()
            .unwrap()
            .contains("restored from another computer")
    );
    assert_eq!(note["cwd"], map_cwd("/Users/tester/devel/proj", &home));
    assert_eq!(result.command, Some(format!("claude --resume {SESSION}")));
    let again = resume_session(&lookup, &options).unwrap();
    assert_eq!(
        again
            .restored
            .iter()
            .map(|r| r.status.as_str())
            .collect::<Vec<_>>(),
        vec!["exists"]
    );
    assert_eq!(std::fs::read_to_string(&mapped).unwrap(), text);
}

#[test]
fn codex_sessions_are_not_restored() {
    let f = Fixture::new();
    let id = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    let file = f
        .root
        .join(format!(".codex/sessions/2026/05/20/rollout-x-{id}.jsonl"));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        format!(
            "{}\n",
            json!({"type": "session_meta", "payload": {"id": id, "cwd": "/a"}})
        ),
    )
    .unwrap();
    f.sync(&settings());
    let lookup = f.lookup(id);
    let me = resolve_hosts(&settings(), &f.runtime).remove(0);
    let source = LocalFileSource(&f.archive);
    let result = resume_session(
        &lookup,
        &ResumeOptions {
            runtime: &f.runtime,
            self_host: &me,
            source: &source,
            dry_run: false,
            now: String::new(),
        },
    )
    .unwrap();
    assert!(result.restored.is_empty());
    assert_eq!(result.command, None);
}

struct Unreachable;

impl Exec for Unreachable {
    fn run(&self, _argv: &[String], _timeout: Duration) -> ExecResult {
        ExecResult {
            code: 255,
            stdout: String::new(),
            stderr: "ssh: connect timed out".into(),
        }
    }
}

#[test]
fn a_pull_from_an_unreachable_host_is_recorded_not_fatal() {
    let f = Fixture::new();
    let s = settings_with(json!({"hosts": {"mac": {"ssh": "mac"}}}));
    let report = f.sync_with(&s, &Unreachable, false);
    assert_eq!(
        report
            .hosts
            .iter()
            .find(|h| h.host == "mac")
            .unwrap()
            .status,
        "unreachable"
    );
    let db = open_archive_db(&f.runtime.context, &f.archive, false).unwrap();
    let health = archive_health(
        &db.conn,
        &f.archive,
        &s,
        &f.runtime,
        0,
        roamgate_archive::now_ms(),
    )
    .unwrap();
    assert!(health.warnings.iter().any(|w| w.contains("mac")));
    assert!(
        health
            .hosts
            .iter()
            .find(|h| h.host == "mac")
            .unwrap()
            .last_attempt
            .is_some()
    );
}

#[test]
fn an_ingested_mirror_is_archived_under_its_host_duplicates_stay_separate() {
    let f = Fixture::new();
    let s = settings();
    let mirror = f
        .archive
        .join("mirror/mac/claude/tree/-Users-tester-devel-proj");
    std::fs::create_dir_all(&mirror).unwrap();
    std::fs::write(
        mirror.join(format!("{SESSION}.jsonl")),
        record("user", "mirrored kudu"),
    )
    .unwrap();
    std::fs::write(f.main(), record("user", "local kudu")).unwrap();
    f.sync(&s);
    let ingest = |host: &str| {
        run_ingest(
            SyncOptions {
                settings: &s,
                runtime: &f.runtime,
                archive_dir: &f.archive,
                hosts: None,
                agents: None,
                local_only: false,
                exec: &SystemExec,
                log: &mut |_| {},
            },
            host,
        )
    };
    ingest("mac").unwrap();
    let mut hosts: Vec<String> = f
        .lookup(SESSION)
        .copies
        .into_iter()
        .map(|c| c.host)
        .collect();
    hosts.sort();
    assert_eq!(hosts, vec!["mac", "testhost"]);
    assert_eq!(f.found("kudu", |_| {}, &s).total, 2);
    assert!(
        ingest("bad host!")
            .unwrap_err()
            .message
            .contains("invalid host")
    );
}

#[test]
fn health_is_stale_without_a_sync_and_fresh_after_one() {
    let f = Fixture::new();
    std::fs::write(f.main(), record("user", "x y z")).unwrap();
    f.sync(&settings());
    let db = open_archive_db(&f.runtime.context, &f.archive, false).unwrap();
    let now = roamgate_archive::now_ms();
    let fresh = archive_health(&db.conn, &f.archive, &settings(), &f.runtime, 0, now).unwrap();
    assert!(!fresh.hosts[0].stale);
    let later = archive_health(
        &db.conn,
        &f.archive,
        &settings(),
        &f.runtime,
        0,
        now + 100 * 3_600_000,
    )
    .unwrap();
    assert!(later.hosts[0].stale);
    assert!(!later.ok);
}

#[test]
fn project_mapping_across_homes() {
    assert_eq!(
        map_claude_project("-Users-thiblahute-devel-x", "/var/home/thiblahute"),
        "-var-home-thiblahute-devel-x"
    );
    assert_eq!(
        map_claude_project("-var-home-thiblahute-devel-x", "/Users/thiblahute"),
        "-Users-thiblahute-devel-x"
    );
    assert_eq!(map_cwd("/Users/a/b", "/var/home/a"), "/var/home/a/b");
}

#[test]
fn cat_lines_is_bounded() {
    let slice = cat_lines(&b"a\nb\nc\nd\n"[..], 2, 2, 100);
    assert_eq!(slice.lines, vec!["b", "c"]);
    assert_eq!(slice.next, Some(4));
}

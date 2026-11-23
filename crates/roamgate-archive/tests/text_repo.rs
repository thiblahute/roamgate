//! The conversation text repo and its search (archive/text-repo.test.ts).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_archive::engine::{SyncOptions, run_sync};
use roamgate_archive::hosts::{ArchiveRuntime, SystemExec};
use roamgate_archive::search::{SearchOptions, SearchQuery, SearchResult, search_archive};
use roamgate_archive::settings::{ArchiveSettings, normalize_archive_settings};
use roamgate_archive::text_repo::{
    STATE_PATH, TextPassOptions, TextPassReport, git, head_commit, read_head_file, read_text_state,
    rebuild_text_repo, text_repo_path, text_repo_status, update_text_repo,
};
use serde_json::{Value, json};

const SESSION: &str = "11111111-2222-3333-4444-555555555555";
const OTHER: &str = "99999999-2222-3333-4444-555555555555";
const PROJECT: &str = "-Users-tester-devel-proj";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    runtime: ArchiveRuntime,
    archive: PathBuf,
}

fn record(kind: &str, content: Value, ts: &str) -> String {
    format!(
        "{}\n",
        json!({"type": kind, "timestamp": ts, "cwd": "/Users/tester/devel/proj", "message": {"role": kind, "content": content}})
    )
}

fn rec(kind: &str, content: Value) -> String {
    record(kind, content, "2026-11-14T10:00:00.000Z")
}

fn settings() -> ArchiveSettings {
    normalize_archive_settings(Some(&json!({"host": "testhost"})))
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn ms(iso: &str) -> i64 {
    roamgate_archive::parse_iso_ms(iso).unwrap()
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        Self {
            runtime: ArchiveRuntime {
                home_dir: root.clone(),
                platform: "linux".into(),
                env: Arc::new(|_| None),
                data_dir: root.join(".config/roamgate"),
                context: roamgate_base::paths::DataContext::new(
                    &root,
                    roamgate_base::paths::Platform::current(),
                    None,
                ),
                hostname: "testhost".into(),
            },
            archive: root.join(".config/roamgate/archive"),
            root,
            _dir: dir,
        }
    }

    fn claude_file(&self, session: &str, project: &str) -> PathBuf {
        let dir = self.root.join(".claude/projects").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{session}.jsonl"))
    }

    fn main(&self) -> PathBuf {
        self.claude_file(SESSION, PROJECT)
    }

    fn sync(&self) {
        run_sync(SyncOptions {
            settings: &settings(),
            runtime: &self.runtime,
            archive_dir: &self.archive,
            hosts: None,
            agents: None,
            local_only: true,
            exec: &SystemExec,
            log: &mut |_| {},
        })
        .unwrap();
    }

    fn pass(&self) -> TextPassReport {
        update_text_repo(TextPassOptions {
            archive_dir: &self.archive,
            settings: &settings(),
            host: "testhost",
            log: &mut |_| {},
            busy: None,
            now_ms: None,
            repack: true,
        })
        .unwrap()
    }

    fn rebuild(&self) {
        rebuild_text_repo(TextPassOptions {
            archive_dir: &self.archive,
            settings: &settings(),
            host: "testhost",
            log: &mut |_| {},
            busy: None,
            now_ms: None,
            repack: true,
        })
        .unwrap();
    }

    fn repo(&self) -> PathBuf {
        text_repo_path(&self.archive)
    }

    /// HEAD's files and blob ids, the state file left out.
    fn tree(&self) -> Vec<String> {
        let out = git(&self.repo(), &["ls-tree", "-r", "HEAD"], None);
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .split('\n')
            .filter(|line| !line.is_empty() && !line.ends_with(STATE_PATH))
            .map(str::to_owned)
            .collect()
    }

    fn names(&self) -> Vec<String> {
        self.tree()
            .iter()
            .map(|line| line.split('\t').nth(1).unwrap().to_owned())
            .collect()
    }

    fn file(&self, path: &str) -> String {
        read_head_file(&self.repo(), path)
            .map(|raw| String::from_utf8_lossy(&raw).into_owned())
            .unwrap_or_default()
    }

    fn search(
        &self,
        terms: &str,
        extra: impl FnOnce(&mut SearchQuery),
        s: &ArchiveSettings,
        live: bool,
    ) -> SearchResult {
        let mut query = SearchQuery {
            terms: terms.split(' ').map(str::to_owned).collect(),
            limit: 20,
            ..SearchQuery::default()
        };
        extra(&mut query);
        let options = SearchOptions {
            runtime: live.then_some(&self.runtime),
            ..SearchOptions::default()
        };
        search_archive(&self.archive, &query, s, options).unwrap()
    }

    fn count(&self) -> String {
        String::from_utf8_lossy(&git(&self.repo(), &["rev-list", "--count", "HEAD"], None).stdout)
            .trim()
            .to_owned()
    }
}

#[test]
fn renders_raw_incrementally_one_commit_per_pass() {
    let f = Fixture::new();
    let main = f.main();
    std::fs::write(
        &main,
        rec("user", json!("first flamingo question"))
            + &rec(
                "assistant",
                json!([{"type": "text", "text": "looking"}, {"type": "tool_use", "name": "Bash", "input": {"command": "ls /tmp"}}]),
            )
            + &rec("user", json!([{"type": "tool_result", "content": "tool walrus out"}])),
    )
    .unwrap();
    let sub = f
        .root
        .join(format!(".claude/projects/{PROJECT}/{SESSION}/subagents"));
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(
        sub.join("agent-1.jsonl"),
        rec("user", json!("subagent task")),
    )
    .unwrap();
    std::fs::write(
        f.root.join(".claude/history.jsonl"),
        format!(
            "{}\n",
            json!({"display": "a typed prompt", "timestamp": ms("2026-11-14T09:00:00Z"), "project": "/Users/tester/devel/proj"})
        ),
    )
    .unwrap();
    f.sync();
    let first = f.pass();
    assert_eq!(first.status, "committed");
    assert_eq!(first.files, 3);
    let path = format!("testhost/claude/{PROJECT}/2026/11/14/{SESSION}.md");
    assert_eq!(
        f.names(),
        vec![
            "testhost/@history/claude/history.md".to_owned(),
            format!("testhost/claude/{PROJECT}/2026/11/14/{SESSION}.agent-1.md"),
            path.clone(),
        ]
    );
    assert_eq!(
        f.file(&path),
        [
            format!("# testhost/claude/{PROJECT}/{SESSION}.jsonl cwd=/Users/tester/devel/proj"),
            "2026-11-14T10:00:00 user text: first flamingo question".into(),
            "2026-11-14T10:00:00 assistant text: looking".into(),
            "2026-11-14T10:00:00 assistant tool_use Bash: ls /tmp".into(),
            String::new(),
        ]
        .join("\n")
    );
    assert_eq!(f.pass().status, "unchanged");

    append(
        &main,
        &(record("user", json!("second narwhal"), "2026-11-15T08:00:00Z")
            + "{\"type\":\"user\",\"timestamp\":\"2026-11-15T08:00:01Z\",\"message\":{\"content\":\"half pel"),
    );
    f.sync();
    let second = f.pass();
    assert_eq!(
        (second.status.as_str(), second.files, second.lines),
        ("committed", 1, 1)
    );
    assert_eq!(
        f.file(&path).trim().lines().last().unwrap(),
        "2026-11-15T08:00:00 user text: second narwhal"
    );
    append(&main, "ican\"}}\n");
    f.sync();
    f.pass();
    assert_eq!(
        f.file(&path).trim().lines().last().unwrap(),
        "2026-11-15T08:00:01 user text: half pelican"
    );
    assert_eq!(f.count(), "3");
    let log = git(&f.repo(), &["log", "-1", "--format=%cn <%ce>"], None);
    assert_eq!(
        String::from_utf8_lossy(&log.stdout).trim(),
        "Roamgate <roamgate@testhost>"
    );

    let incremental = f.tree();
    f.rebuild();
    assert_eq!(f.tree(), incremental);
    f.rebuild();
    assert_eq!(f.tree(), incremental);
    assert_eq!(f.count(), "1");
    let status = text_repo_status(&f.archive, &settings());
    assert!(status.exists);
    assert_eq!(status.files, 3);
    assert!(status.last_repack.is_some());
}

#[test]
fn a_shrunk_transcript_is_rendered_again_from_its_new_copy() {
    let f = Fixture::new();
    std::fs::write(
        f.main(),
        rec("user", json!("old flamingo")) + &rec("user", json!("x")),
    )
    .unwrap();
    f.sync();
    f.pass();
    std::fs::write(
        f.main(),
        record("user", json!("new axolotl"), "2026-11-16T00:00:00Z"),
    )
    .unwrap();
    f.sync();
    f.pass();
    let names = f.names();
    assert_eq!(
        names,
        vec![format!("testhost/claude/{PROJECT}/2026/11/16/{SESSION}.md")]
    );
    assert!(f.file(&names[0]).contains("new axolotl"));
    assert!(!f.file(&names[0]).contains("flamingo"));
}

#[test]
fn name_collisions_the_first_raw_path_keeps_the_name_in_any_order() {
    let f = Fixture::new();
    let id = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    let rollout = |day: &str, text: &str| {
        let dir = f.root.join(format!(".codex/sessions/2026/05/{day}"));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"timestamp": "2026-05-20T09:42:36Z", "type": "session_meta", "payload": {"id": id, "cwd": "/tmp/work"}}),
            json!({"timestamp": "2026-05-20T09:42:37Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}),
        ];
        std::fs::write(
            dir.join(format!("rollout-2026-05-{day}T11-42-36-{id}.jsonl")),
            lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
        )
        .unwrap();
    };
    rollout("21", "later capybara");
    f.sync();
    f.pass();
    rollout("20", "earlier capybara");
    f.sync();
    f.pass();
    let incremental = f.tree();
    let names = f.names();
    assert_eq!(names.len(), 2);
    let base = format!("testhost/codex/-tmp-work/2026/05/20/{id}.md");
    assert!(names.contains(&base));
    assert!(f.file(&base).contains("earlier capybara"));
    f.rebuild();
    assert_eq!(f.tree(), incremental);
}

#[test]
fn a_transcript_with_no_text_yet_is_kept_then_named_by_its_first_line() {
    let f = Fixture::new();
    std::fs::write(
        f.main(),
        rec(
            "user",
            json!([{"type": "tool_result", "content": "only output"}]),
        ),
    )
    .unwrap();
    f.sync();
    f.pass();
    assert!(f.tree().is_empty());
    let key = format!("testhost/claude/{PROJECT}/{SESSION}.jsonl");
    assert_eq!(read_text_state(&f.repo()).unwrap().files[&key].path, "");
    append(
        &f.main(),
        &record("user", json!("now a gecko"), "2026-11-15T00:00:00Z"),
    );
    f.sync();
    let report = f.pass();
    assert_eq!((report.files, report.lines), (1, 1));
    let path = format!("testhost/claude/{PROJECT}/2026/11/14/{SESSION}.md");
    assert_eq!(
        f.file(&path).split('\n').nth(1).unwrap(),
        "2026-11-15T00:00:00 user text: now a gecko"
    );
}

#[test]
fn a_pass_is_deferred_while_busy() {
    let f = Fixture::new();
    std::fs::write(f.main(), rec("user", json!("hello"))).unwrap();
    f.sync();
    let busy = || true;
    let report = update_text_repo(TextPassOptions {
        archive_dir: &f.archive,
        settings: &settings(),
        host: "testhost",
        log: &mut |_| {},
        busy: Some(&busy),
        now_ms: None,
        repack: true,
    })
    .unwrap();
    assert_eq!(report.status, "deferred");
    assert_eq!(head_commit(&f.repo()), None);
}

fn searched() -> Fixture {
    let f = Fixture::new();
    std::fs::write(
        f.main(),
        record(
            "user",
            json!("the flamingo and the walrus"),
            "2026-11-01T10:00:00Z",
        ) + &record(
            "assistant",
            json!("a flamingo answer"),
            "2026-11-02T10:00:00Z",
        ) + &record(
            "assistant",
            json!([{"type": "tool_use", "name": "Bash", "input": {"command": "grep flamingo"}}]),
            "2026-11-02T10:00:01Z",
        ) + &record(
            "user",
            json!([{"type": "tool_result", "content": "only in tool output: quokka"}]),
            "2026-11-02T10:00:02Z",
        ),
    )
    .unwrap();
    std::fs::write(
        f.claude_file(OTHER, "-Users-tester-devel-other"),
        record(
            "user",
            json!("one flamingo elsewhere"),
            "2026-11-10T10:00:00Z",
        ),
    )
    .unwrap();
    std::fs::write(
        f.root.join(".claude/history.jsonl"),
        format!("{}\n", json!({"display": "flamingo prompt", "timestamp": ms("2026-11-03T09:00:00Z"), "project": "/p"})),
    )
    .unwrap();
    f.sync();
    f.pass();
    f
}

#[test]
fn ranks_sessions_by_matching_messages_then_recency() {
    let f = searched();
    let result = f.search("flamingo", |_| {}, &settings(), false);
    assert_eq!(result.source.as_deref(), Some("text"));
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| (h.session.clone(), h.matches.unwrap()))
            .collect::<Vec<_>>(),
        vec![(SESSION.to_owned(), 3), (OTHER.to_owned(), 1)]
    );
    assert_eq!(result.total, 4);
    let top = &result.hits[0];
    assert_eq!(top.snippets.as_ref().unwrap().len(), 3);
    assert!(top.snippet.contains("[flamingo]"));
    assert_eq!(top.project, PROJECT);
    assert_eq!(top.kind, "tool_use");
    assert_eq!(
        f.search("flamingo", |q| q.recent = true, &settings(), false)
            .hits[0]
            .session,
        OTHER
    );
}

#[test]
fn filters_words_phrases_operators_role_kind_time_project_hide() {
    let f = searched();
    let sessions =
        |terms: &str, extra: &dyn Fn(&mut SearchQuery), s: &ArchiveSettings| -> Vec<String> {
            f.search(terms, |q| extra(q), s, false)
                .hits
                .into_iter()
                .map(|h| h.session)
                .collect()
        };
    let s = settings();
    let none = |_: &mut SearchQuery| {};
    assert_eq!(sessions("walrus flamingo", &none, &s), vec![SESSION]);
    assert_eq!(sessions("\"the walrus\"", &none, &s), vec![SESSION]);
    assert!(sessions("\"walrus the\"", &none, &s).is_empty());
    assert_eq!(sessions("flamingo NOT walrus", &none, &s).len(), 2);
    assert_eq!(sessions("walrus OR elsewhere", &none, &s).len(), 2);
    assert_eq!(
        sessions("flamingo", &|q| q.role = Some("user".into()), &s),
        vec![OTHER, SESSION]
    );
    assert_eq!(
        sessions("flamingo", &|q| q.kind = Some("tool_use".into()), &s),
        vec![SESSION]
    );
    assert_eq!(
        sessions("flamingo", &|q| q.since = Some("2026-11-05".into()), &s),
        vec![OTHER]
    );
    assert_eq!(
        sessions("flamingo", &|q| q.until = Some("2026-11-05".into()), &s),
        vec![SESSION]
    );
    assert_eq!(
        sessions("flamingo", &|q| q.project = Some("other".into()), &s),
        vec![OTHER]
    );
    assert!(sessions("flamingo", &|q| q.host = Some("nothere".into()), &s).is_empty());
    assert_eq!(
        sessions("flamingo", &|q| q.agent = Some("claude".into()), &s).len(),
        2
    );
    let hide = normalize_archive_settings(Some(
        &json!({"host": "testhost", "hide": [{"project": "other"}]}),
    ));
    assert_eq!(sessions("flamingo", &none, &hide), vec![SESSION]);
    assert!(sessions("quokka", &none, &s).is_empty());
    assert_eq!(
        sessions("fl[a-z]+go\\s+eLsE", &|q| q.regex = true, &s),
        vec![OTHER]
    );
}

#[test]
fn prompt_history_is_searched_on_request() {
    let f = searched();
    let result = f.search("flamingo", |q| q.history = true, &settings(), false);
    let history = serde_json::to_value(result.history.unwrap()).unwrap();
    assert_eq!(
        history,
        json!([{"host": "testhost", "ts": "2026-11-03T09:00:00", "project": "/p", "snippet": "[flamingo] prompt"}])
    );
    assert!(result.hits.iter().all(|hit| hit.session != "history"));
}

#[test]
fn sessions_grown_since_the_last_commit_are_found() {
    let f = searched();
    append(
        &f.main(),
        &record("user", json!("a fresh pangolin"), "2026-11-20T10:00:00Z"),
    );
    let fresh = "77777777-2222-3333-4444-555555555555";
    std::fs::write(
        f.claude_file(fresh, PROJECT),
        record(
            "user",
            json!("a new pangolin session"),
            "2026-11-21T10:00:00Z",
        ),
    )
    .unwrap();
    assert!(
        f.search("pangolin", |_| {}, &settings(), false)
            .hits
            .is_empty()
    );
    let live = f.search("pangolin", |_| {}, &settings(), true);
    let mut found: Vec<String> = live.hits.iter().map(|h| h.session.clone()).collect();
    found.sort();
    assert_eq!(found, vec![SESSION.to_owned(), fresh.to_owned()]);
    assert_eq!(
        live.hits.iter().find(|h| h.session == SESSION).unwrap().doc,
        5
    );
    assert_eq!(
        f.search("pangolin", |_| {}, &settings(), true).hits.len(),
        2
    );
    f.sync();
    f.pass();
    let after = f.search("pangolin", |_| {}, &settings(), true);
    assert_eq!(
        after
            .hits
            .iter()
            .map(|h| h.matches.unwrap())
            .collect::<Vec<_>>(),
        vec![1, 1]
    );
}

#[test]
fn tool_output_is_searched_in_raw_on_request() {
    let f = searched();
    let result = f.search("quokka", |q| q.tool_output = true, &settings(), false);
    assert_eq!(result.source.as_deref(), Some("raw"));
    assert!(result.warning.unwrap().contains("slow"));
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| (h.session.clone(), h.kind.clone(), h.doc))
            .collect::<Vec<_>>(),
        vec![(SESSION.to_owned(), "tool_result".to_owned(), 4)]
    );
}

#[test]
fn the_state_lists_every_rendered_file() {
    let f = searched();
    let state = read_text_state(&f.repo()).unwrap();
    let mut keys: Vec<&String> = state.files.keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "testhost/claude/-Users-tester-devel-other/99999999-2222-3333-4444-555555555555.jsonl",
            &format!("testhost/claude/{PROJECT}/{SESSION}.jsonl"),
            "testhost/claude/@history.jsonl",
        ]
    );
}

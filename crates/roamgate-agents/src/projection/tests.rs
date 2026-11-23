//! session-projection-cache.test.ts.

use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::files::BoxFut;
use crate::handlers::AgentSessionHandlers;
use crate::resolver::{HerdrCall, ResolverContext};

const PATH: &str = "/tmp/history-test.jsonl";

type Hook = Box<dyn FnMut(&Fixture) -> Result<(), String> + Send>;

#[derive(Default)]
struct State {
    text: String,
    file: Option<SessionFile>,
}

/// A transcript in memory: no ranges, as the TS fixture's.
#[derive(Default)]
struct Fixture {
    state: StdMutex<State>,
    reads: AtomicUsize,
    hook: StdMutex<Option<Arc<StdMutex<Hook>>>>,
}

impl Fixture {
    fn new() -> Arc<Self> {
        let fixture = Fixture::default();
        fixture.state.lock().unwrap().file = Some(SessionFile {
            path: PATH.into(),
            mtime_ms: 1000.0,
            size: Some(0.0),
            identity: Some("1".into()),
            change_token: Some("1".into()),
            ..Default::default()
        });
        Arc::new(fixture)
    }

    fn set(&self, records: &[Value], identity: Option<&str>, tail: &str) {
        let mut state = self.state.lock().unwrap();
        state.text = format!(
            "{}\n{tail}",
            records
                .iter()
                .map(js::stringify)
                .collect::<Vec<_>>()
                .join("\n")
        );
        let old = state.file.clone();
        state.file = Some(SessionFile {
            path: PATH.into(),
            mtime_ms: old.as_ref().map_or(1000.0, |f| f.mtime_ms) + 1.0,
            size: Some(state.text.len() as f64),
            identity: Some(
                identity
                    .map(str::to_owned)
                    .or_else(|| old.as_ref().and_then(|f| f.identity.clone()))
                    .unwrap_or_else(|| "1".into()),
            ),
            change_token: Some(js::number_text(
                old.as_ref()
                    .and_then(|f| f.change_token.as_deref())
                    .map_or(0.0, js::number_from_text)
                    + 1.0,
            )),
            ..Default::default()
        });
    }

    fn missing(&self) {
        self.state.lock().unwrap().file = None;
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn on_read(&self, hook: Option<Hook>) {
        *self.hook.lock().unwrap() = hook.map(|h| Arc::new(StdMutex::new(h)));
    }

    fn file(&self) -> Option<SessionFile> {
        self.state.lock().unwrap().file.clone()
    }
}

struct Files(Arc<Fixture>);

impl SessionFiles for Files {
    fn remote(&self) -> bool {
        true
    }
    fn has_range(&self) -> bool {
        false
    }
    fn stat_file<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.0.file();
        Box::pin(async move { Ok(file) })
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<String>> {
        self.0.reads.fetch_add(1, Ordering::SeqCst);
        let text = self.0.state.lock().unwrap().text.clone();
        let hook = self.0.hook.lock().unwrap().clone();
        let result = match hook {
            Some(hook) => (hook.lock().unwrap())(&self.0),
            None => Ok(()),
        };
        Box::pin(async move { result.map(|()| text).map_err(io::Error::other) })
    }
    fn read_prefix<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.0.state.lock().unwrap().text.as_bytes().to_vec();
        Box::pin(async move { Ok(bytes[..bytes.len().min(limit as usize)].to_vec()) })
    }
    fn read_tail<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.0.state.lock().unwrap().text.as_bytes().to_vec();
        Box::pin(async move { Ok(bytes[bytes.len().saturating_sub(limit as usize)..].to_vec()) })
    }
    fn read_range<'a>(&'a self, _: &'a str, _: u64, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Err(io::Error::other("no ranges")) })
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.0.state.lock().unwrap().text.as_bytes().to_vec();
        Box::pin(async move { Ok(bytes) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.0.file();
        Box::pin(async move { Ok(file) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.0.file();
        Box::pin(async move { Ok(file) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.0.file();
        Box::pin(async move { Ok(file) })
    }
}

struct Herdr(String);

impl HerdrCall for Herdr {
    fn call(&self, _: &str, _: Value, _: Option<u64>) -> BoxFut<'_, Result<Value, String>> {
        let value = json!({ "agent": { "agent": self.0, "agent_session": { "kind": "path", "value": PATH } } });
        Box::pin(async move { Ok(value) })
    }
}

struct Session {
    fixture: Arc<Fixture>,
    files: Arc<dyn SessionFiles>,
    agent: String,
    handlers: AgentSessionHandlers,
}

fn handlers(files: &Arc<dyn SessionFiles>, agent: &str) -> AgentSessionHandlers {
    AgentSessionHandlers::new(
        Arc::new(Herdr(agent.into())),
        files.clone(),
        Arc::new(ResolverContext::default()),
        None,
        Arc::new(js::now_ms),
    )
}

fn session(agent: &str) -> Session {
    let fixture = Fixture::new();
    let files: Arc<dyn SessionFiles> = Arc::new(Files(fixture.clone()));
    Session {
        handlers: handlers(&files, agent),
        fixture,
        files,
        agent: agent.into(),
    }
}

impl Session {
    async fn history(&self, cursor: Value) -> Result<Value, String> {
        self.handlers
            .read_history(&json!({ "pane_id": "p", "history_version": 2, "cursor": cursor }))
            .await
            .map_err(|e| e.message)
    }
    async fn ok(&self, cursor: Value) -> Value {
        self.history(cursor).await.unwrap()
    }
    fn resolved(&self) -> Resolved {
        Resolved::from_value(
            json!({
                "version": 1, "agent": self.agent, "pane_id": "p", "workspace_id": "w", "tab_id": "t",
                "status": "ok", "detail": "", "updated_at": "", "path": PATH,
                "session": { "kind": "path", "value": PATH, "source": "test", "agent": self.agent },
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .with_file(self.fixture.file())
    }
}

impl Resolved {
    fn with_file(mut self, file: Option<SessionFile>) -> Self {
        self.file = file;
        self
    }
}

fn message(text: &str) -> Value {
    json!({ "type": "message", "timestamp": "2026-01-01T00:00:00Z", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } })
}

fn mode(update: &Value) -> &str {
    update["mode"].as_str().unwrap()
}

fn texts(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect()
}

#[test]
fn counts_nested_strings_arguments_and_repeated_revision_values() {
    let value = json!({
        "arguments": { "command": "x".repeat(1024), "flags": [true, null, 1] },
        "extra": { "detail": "y".repeat(2048) },
    });
    let bytes = estimate_retained_bytes(&value, f64::INFINITY, 0);
    assert!(bytes > 2.0 * (1024.0 + 2048.0));
    assert_eq!(estimate_retained_bytes(&value, bytes, 0), bytes);
    assert_eq!(
        estimate_retained_bytes(&value, bytes - 1.0, 0),
        f64::INFINITY
    );
    assert!(estimate_retained_bytes(&json!([value, value]), f64::INFINITY, 0) > 2.0 * bytes);
}

#[test]
fn stops_before_visiting_the_remaining_payload_once_over_budget() {
    // Rust has no getters to trip: the budget answer is what is checked.
    assert_eq!(
        estimate_retained_bytes(&json!(["x".repeat(1000), null]), 100.0, 0),
        f64::INFINITY
    );
}

#[test]
fn deep_payloads_are_not_admitted_instead_of_overflowing_the_call_stack() {
    let mut value = json!("leaf");
    for _ in 0..100 {
        value = json!({ "nested": value });
    }
    assert_eq!(
        estimate_retained_bytes(&value, 32.0 * 1024.0 * 1024.0, 0),
        f64::INFINITY
    );
}

#[tokio::test]
async fn coalesces_history_and_summary_preview_and_atif_build_the_trajectory_unchanged_refresh_never_reads_again()
 {
    let s = session("pi");
    s.fixture.set(&[message("hello")], None, "");
    let (summary_params, atif_params) = (
        json!({ "pane_id": "p", "include_trajectory": true, "include_text": true }),
        json!({ "pane_id": "p" }),
    );
    let (first, summary, atif) = tokio::join!(
        s.history(Value::Null),
        s.handlers.read_summary(&summary_params),
        s.handlers.download_atif(&atif_params),
    );
    let (first, summary, atif) = (
        first.unwrap(),
        summary.map_err(|e| e.message).unwrap(),
        atif.map_err(|e| e.message).unwrap(),
    );
    assert_eq!(s.fixture.reads(), 3);
    assert_eq!(summary["stats"]["turns"], json!(1));
    assert!(summary["text"].as_str().unwrap().contains("hello"));
    let atif: Value = serde_json::from_slice(&atif.2).unwrap();
    assert_eq!(atif["steps"].as_array().unwrap().len(), 1);
    let refresh = s.ok(first["cursor"].clone()).await;
    assert_eq!(mode(&refresh), "delta");
    assert_eq!(refresh["upserts"], json!([]));
    assert_eq!(refresh["removed"], json!([]));
    assert!(refresh.get("order").is_none());
    assert_eq!(refresh["cursor"], first["cursor"]);
    for key in ["messages", "entries", "trajectory"] {
        assert!(refresh.get(key).is_none(), "{key}");
    }
    s.handlers
        .read_summary(&json!({ "pane_id": "p" }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    assert_eq!(s.fixture.reads(), 3);
}

#[tokio::test]
async fn reprojects_changed_data_once_and_completes_partial_jsonl_without_poisoning_cache() {
    let s = session("pi");
    s.fixture.set(&[message("one")], None, "{\"type\":");
    let first = s.ok(Value::Null).await;
    assert_eq!(mode(&first), "snapshot");
    s.fixture.set(&[message("one"), message("two")], None, "");
    let params = json!({ "pane_id": "p" });
    let (next, _) = tokio::join!(
        s.history(first["cursor"].clone()),
        s.handlers.read_summary(&params)
    );
    let next = next.unwrap();
    assert_eq!(mode(&next), "delta");
    assert_eq!(texts(&next["upserts"]), ["two"]);
    assert_eq!(s.fixture.reads(), 2);
}

#[tokio::test]
async fn appends_do_not_resend_timestamp_less_entries() {
    let s = session("pi");
    let first_record =
        json!({ "type": "message", "message": { "role": "user", "content": "first" } });
    s.fixture.set(std::slice::from_ref(&first_record), None, "");
    let first = s.ok(Value::Null).await;
    s.fixture.set(
        &[
            first_record,
            json!({ "type": "message", "message": { "role": "user", "content": "second" } }),
        ],
        None,
        "",
    );
    let next = s.ok(first["cursor"].clone()).await;
    assert_eq!(mode(&next), "delta");
    assert_eq!(texts(&next["upserts"]), ["second"]);
}

#[tokio::test]
async fn codex_source_switching_removes_early_projected_steps_instead_of_trusting_step_id() {
    let s = session("codex");
    let event = json!({ "type": "event_msg", "timestamp": "2026-01-01T00:00:00Z", "payload": { "type": "user_message", "message": "old source" } });
    s.fixture.set(std::slice::from_ref(&event), None, "");
    let first = s.ok(Value::Null).await;
    s.fixture.set(
        &[
            event,
            json!({ "type": "response_item", "timestamp": "2026-01-01T00:00:01Z", "payload": {
                "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "authoritative source" }] } }),
        ],
        None,
        "",
    );
    let next = s.ok(first["cursor"].clone()).await;
    assert_eq!(mode(&next), "delta");
    assert_eq!(next["removed"], json!([first["entries"][0]["id"]]));
    assert_eq!(next["upserts"][0]["text"], json!("authoritative source"));
    assert_eq!(next["order"], json!([next["upserts"][0]["id"]]));
}

#[tokio::test]
async fn tool_call_ids_support_argument_updates_and_revisions_preserve_ordering() {
    let s = session("pi");
    let call = |command: &str| {
        json!({ "type": "message", "timestamp": "2026-01-01T00:00:00Z", "message": { "role": "assistant", "content": [
            { "type": "toolCall", "id": "call-1", "name": "bash", "arguments": { "command": command } }] } })
    };
    s.fixture.set(&[call("a")], None, "");
    let first = s.ok(Value::Null).await;
    assert_eq!(first["entries"][0]["text"], json!(""));
    let pretty = |command: &str| js::len16(&js::stringify_pretty(&json!({ "command": command })));
    assert_eq!(first["entries"][0]["text_bytes"], json!(pretty("a")));
    s.fixture.set(&[call("longer")], None, "");
    let next = s.ok(first["cursor"].clone()).await;
    assert_eq!(mode(&next), "delta");
    assert_eq!(next["upserts"][0]["id"], first["entries"][0]["id"]);
    assert_eq!(next["upserts"][0]["text"], json!(""));
    assert_eq!(next["upserts"][0]["text_bytes"], json!(pretty("longer")));
    assert_eq!(next["removed"], json!([]));
    assert!(next.get("order").is_none());
    let fetched = s
        .handlers
        .read_entry(&json!({ "pane_id": "p", "entry_id": first["entries"][0]["id"] }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    assert!(fetched["text"].as_str().unwrap().contains("longer"));
    assert_eq!(next["upserts"][0]["text_hash"], fetched["text_hash"]);
    assert_ne!(
        next["upserts"][0]["text_hash"],
        first["entries"][0]["text_hash"]
    );
}

#[tokio::test]
async fn read_entry_rejects_unknown_or_evicted_history_entries() {
    let s = session("pi");
    s.fixture.set(&[message("one")], None, "");
    s.ok(Value::Null).await;
    let missing = s
        .handlers
        .read_entry(&json!({ "pane_id": "p", "entry_id": "missing:0" }))
        .await;
    assert!(
        missing
            .err()
            .unwrap()
            .message
            .contains("no longer available")
    );
    let id = s.ok(Value::Null).await["entries"][0]["id"].clone();
    let fetched = s
        .handlers
        .read_entry(&json!({ "pane_id": "p", "entry_id": id }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    assert_eq!(fetched["text"], json!("one"));
}

#[tokio::test]
async fn recent_window_removes_oldest_entries_full_export_is_not_windowed() {
    let s = session("pi");
    let records: Vec<Value> = (0..200).map(|i| message(&i.to_string())).collect();
    s.fixture.set(&records, None, "");
    let first = s.ok(Value::Null).await;
    let mut more = records.clone();
    more.push(message("200"));
    s.fixture.set(&more, None, "");
    let next = s.ok(first["cursor"].clone()).await;
    assert_eq!(mode(&next), "delta");
    assert_eq!(next["removed"], json!([first["entries"][0]["id"]]));
    assert_eq!(texts(&next["upserts"]), ["200"]);
    assert_eq!(next["order"].as_array().unwrap().len(), 200);
    let exported = s
        .handlers
        .download_atif(&json!({ "pane_id": "p" }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    let exported: Value = serde_json::from_slice(&exported.2).unwrap();
    assert_eq!(exported["steps"].as_array().unwrap().len(), 201);
}

#[tokio::test]
async fn truncation_replacement_missing_file_invalid_cursors_and_reconnect_reset_safely() {
    let s = session("pi");
    s.fixture
        .set(&[message("long message"), message("second")], None, "");
    let current = s.ok(Value::Null).await;
    s.fixture.set(&[message("short")], None, "");
    let next = s.ok(current["cursor"].clone()).await;
    assert_eq!(mode(&next), "snapshot");
    assert_ne!(next["cursor"]["epoch"], current["cursor"]["epoch"]);
    let current = next;
    s.fixture.set(&[message("short")], Some("replacement"), "");
    let next = s.ok(current["cursor"].clone()).await;
    assert_eq!(mode(&next), "snapshot");
    assert_ne!(next["cursor"]["epoch"], current["cursor"]["epoch"]);
    for cursor in [
        json!({ "epoch": next["cursor"]["epoch"], "revision": -1 }),
        json!({ "epoch": next["cursor"]["epoch"], "revision": 999 }),
        json!({ "epoch": "other", "revision": 1 }),
        json!("bad"),
    ] {
        assert_eq!(mode(&s.ok(cursor).await), "snapshot");
    }
    let other = handlers(&s.files, "pi");
    let reconnected = other
        .read_history(&json!({ "pane_id": "p", "history_version": 2, "cursor": next["cursor"] }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    assert_eq!(mode(&reconnected), "snapshot");
    s.fixture.missing();
    let missing = s.ok(next["cursor"].clone()).await;
    assert_eq!(mode(&missing), "snapshot");
    assert_eq!(missing["entries"], json!([]));
    s.fixture.set(&[message("short")], Some("replacement"), "");
    assert_eq!(mode(&s.ok(next["cursor"].clone()).await), "snapshot");
}

#[tokio::test]
async fn expired_revision_history_falls_back_to_snapshot() {
    let s = session("pi");
    s.fixture.set(&[message("0")], None, "");
    let first = s.ok(Value::Null).await;
    for i in 1..5 {
        let records: Vec<Value> = (0..=i).map(|j| message(&j.to_string())).collect();
        s.fixture.set(&records, None, "");
        s.ok(Value::Null).await;
    }
    assert_eq!(mode(&s.ok(first["cursor"].clone()).await), "snapshot");
}

#[tokio::test]
async fn changed_read_races_retry_transient_errors_do_not_cache_partial_projections() {
    let s = session("pi");
    s.fixture.set(&[message("old")], None, "");
    s.fixture.on_read(Some(Box::new(|f: &Fixture| {
        f.on_read(None);
        f.set(&[message("new")], None, "");
        Ok(())
    })));
    assert_eq!(s.ok(Value::Null).await["entries"][0]["text"], json!("new"));
    assert_eq!(s.fixture.reads(), 2);
    s.fixture.set(&[message("fail")], None, "");
    s.fixture
        .on_read(Some(Box::new(|_: &Fixture| Err("read failed".into()))));
    assert!(
        s.history(Value::Null)
            .await
            .unwrap_err()
            .contains("read failed")
    );
    s.fixture.on_read(None);
    assert_eq!(s.ok(Value::Null).await["entries"][0]["text"], json!("fail"));
    s.fixture.set(&[message("busy")], None, "");
    s.fixture.on_read(Some(Box::new(|f: &Fixture| {
        f.set(&[message("busy")], None, "");
        Ok(())
    })));
    assert!(
        s.history(Value::Null)
            .await
            .unwrap_err()
            .contains("changed while reading")
    );
    s.fixture.on_read(None);
    assert_eq!(s.ok(Value::Null).await["entries"][0]["text"], json!("busy"));
}

#[tokio::test]
async fn grok_descriptor_creation_time_changes_refresh_history_and_atif_timestamps() {
    let s = session("grok");
    s.fixture.set(
        &[json!({ "type": "user", "content": "timestamp-less query" })],
        None,
        "",
    );
    let original = s.fixture.file().unwrap();
    let cache = ProjectionCache::new(s.files.clone(), None);
    let base = s.resolved();
    let (_, first) = cache.history(&base, None).await.unwrap();
    let mut cursor = first["cursor"].clone();
    let mut expected = 1;
    for created in [Some(2000.0), Some(5000.0), None] {
        let resolved = base.clone().with_file(Some(SessionFile {
            created_at_ms: created,
            ..original.clone()
        }));
        let (projection, update) = cache.history(&resolved, Some(&cursor)).await.unwrap();
        let timestamp = js::iso(created.unwrap_or(original.mtime_ms));
        assert_eq!(mode(&update), "delta");
        assert_eq!(update["cursor"]["epoch"], cursor["epoch"]);
        assert_eq!(
            update["cursor"]["revision"].as_f64(),
            Some(cursor["revision"].as_f64().unwrap() + 1.0)
        );
        assert_eq!(update["upserts"][0]["sent_at"], json!(timestamp));
        assert_eq!(projection.messages[0]["sent_at"], json!(timestamp));
        expected += 1;
        assert_eq!(s.fixture.reads(), expected);
        let trajectory = cache.trajectory(&resolved, false).await.unwrap();
        assert_eq!(trajectory["steps"][0]["timestamp"], json!(timestamp));
        expected += 1;
        assert_eq!(s.fixture.reads(), expected);
        cursor = update["cursor"].clone();
        let (_, unchanged) = cache.history(&resolved, Some(&cursor)).await.unwrap();
        assert_eq!(unchanged["upserts"], json!([]));
        assert_eq!(s.fixture.reads(), expected);
    }
}

#[tokio::test]
async fn oversized_cache_admission_does_not_serialize_the_entire_projection() {
    // Admission is measured by estimate_retained_bytes, which stops at the
    // budget: what is checked is that the session is read again.
    let s = session("pi");
    s.fixture.set(&[message(&"x".repeat(100_000))], None, "");
    let cache = ProjectionCache::with_limits(s.files.clone(), None, 16, 16 * 1024);
    let resolved = s.resolved();
    let (projection, first) = cache.history(&resolved, None).await.unwrap();
    assert_eq!(
        js::len16(projection.entries[0]["text"].as_str().unwrap()),
        100_000
    );
    let (_, next) = cache
        .history(&resolved, Some(&first["cursor"]))
        .await
        .unwrap();
    assert_eq!(mode(&next), "snapshot");
    assert_ne!(next["cursor"]["epoch"], first["cursor"]["epoch"]);
    assert_eq!(s.fixture.reads(), 2);
}

#[tokio::test]
async fn entry_and_retained_payload_budgets_evict_with_a_fresh_epoch() {
    let s = session("pi");
    s.fixture.set(&[message("hello")], None, "");
    let cache = ProjectionCache::with_limits(s.files.clone(), None, 1, 1024 * 1024);
    let resolved = s.resolved();
    let (_, first) = cache.history(&resolved, None).await.unwrap();
    let mut claude = resolved.clone();
    claude.agent = "claude".into();
    claude.value.insert("agent".into(), json!("claude"));
    cache.get(&claude, false).await.unwrap();
    let (_, next) = cache
        .history(&resolved, Some(&first["cursor"]))
        .await
        .unwrap();
    assert_eq!(mode(&next), "snapshot");
    assert_eq!(s.fixture.reads(), 3);
    let tiny = ProjectionCache::with_limits(s.files.clone(), None, 10, 1);
    let (_, oversized) = tiny.history(&resolved, None).await.unwrap();
    let (_, again) = tiny
        .history(&resolved, Some(&oversized["cursor"]))
        .await
        .unwrap();
    assert_eq!(mode(&again), "snapshot");
    assert_eq!(s.fixture.reads(), 5);
}

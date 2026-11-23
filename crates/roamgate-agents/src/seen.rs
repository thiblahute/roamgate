//! `agent-seen.ts`: which turns of each agent the user has seen in
//! Roamgate (`agent-seen.json`), Herdr's boot ids, and `agent_seen.mark`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use roamgate_base::paths::DataContext;
use serde_json::{Map, Value};

use crate::js::{self, Obj};

const MAX_PER_CONNECTION: usize = 2000;
const MAX_CONNECTIONS: usize = 64;
/// Marks come in bursts as panes come and go: one write per burst.
pub const SAVE_DELAY_MS: f64 = 1_000.0;

/// `agent-seen.json` under the data root, or `ROAMGATE_AGENT_SEEN_PATH`.
pub fn agent_seen_path(env: &dyn roamgate_base::env::Env, root: &Path) -> PathBuf {
    roamgate_base::env::roamgate_env(env, "AGENT_SEEN_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("agent-seen.json"))
}

fn safe_int(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| js::is_safe_integer(*n))
}

fn load(path: &Path) -> Obj {
    let empty = || {
        let mut saved = Obj::new();
        saved.insert("version".into(), js::int(1));
        saved.insert("connections".into(), Value::Object(Obj::new()));
        saved
    };
    if !path.exists() {
        return empty();
    }
    let Some(Value::Object(value)) = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| js::parse(&t))
    else {
        return empty();
    };
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return empty();
    }
    let Some(Value::Object(raw)) = value.get("connections") else {
        return empty();
    };
    let mut connections = Obj::new();
    for (connection, entries) in raw {
        let Value::Object(entries) = entries else {
            continue;
        };
        let mut kept = Obj::new();
        for (key, entry) in entries {
            let Value::Object(entry) = entry else {
                continue;
            };
            let (Some(seq), Some(at)) = (safe_int(entry.get("seq")), js::num(entry.get("at")))
            else {
                continue;
            };
            let mut out = Obj::new();
            out.insert("seq".into(), js::number(seq));
            out.insert("at".into(), js::number(at));
            if let Some(Value::String(boot)) = entry.get("boot")
                && !boot.is_empty()
            {
                out.insert("boot".into(), Value::String(boot.clone()));
            }
            if let Some(quiet) = safe_int(entry.get("quiet")) {
                out.insert("quiet".into(), js::number(quiet));
            }
            kept.insert(key.clone(), Value::Object(out));
        }
        connections.insert(connection.clone(), Value::Object(kept));
    }
    let mut notes = Obj::new();
    if let Some(Value::Object(raw)) = value.get("notes") {
        for (connection, panes) in raw {
            let Value::Object(panes) = panes else {
                continue;
            };
            let mut kept = Obj::new();
            for (pane, note) in panes {
                let Value::Object(note) = note else { continue };
                let (Some(Value::String(text)), Some(at)) =
                    (note.get("text"), js::num(note.get("at")))
                else {
                    continue;
                };
                let mut out = Obj::new();
                out.insert("text".into(), Value::String(text.clone()));
                out.insert("at".into(), js::number(at));
                if let Some(Value::String(title)) = note.get("title") {
                    out.insert("title".into(), Value::String(title.clone()));
                }
                kept.insert(pane.clone(), Value::Object(out));
            }
            notes.insert(connection.clone(), Value::Object(kept));
        }
    }
    let mut saved = Obj::new();
    saved.insert("version".into(), js::int(1));
    saved.insert("connections".into(), Value::Object(connections));
    saved.insert("notes".into(), Value::Object(notes));
    saved
}

fn key_of(pane: &str, terminal: &str) -> String {
    format!("{pane}\u{0}{terminal}")
}

fn other_boot(entry: &Obj, boot: Option<&str>) -> bool {
    let theirs = js::sv(entry.get("boot"));
    boot.is_some_and(|b| !b.is_empty()) && !theirs.is_empty() && Some(theirs) != boot
}

fn latest(entries: &Obj) -> f64 {
    entries
        .values()
        .filter_map(|e| e.get("at").and_then(Value::as_f64))
        .fold(f64::NEG_INFINITY, f64::max)
}

/// The seen marks, written a moment after the last change.
pub struct AgentSeenStore {
    path: PathBuf,
    data: DataContext,
    saved: Obj,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    save_delay_ms: f64,
    /// When the pending write is due; None: nothing pending.
    due: Option<f64>,
}

impl AgentSeenStore {
    pub fn open(path: PathBuf, data: DataContext, now: Box<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self::with_delay(path, data, now, SAVE_DELAY_MS)
    }

    pub fn with_delay(
        path: PathBuf,
        data: DataContext,
        now: Box<dyn Fn() -> f64 + Send + Sync>,
        save_delay_ms: f64,
    ) -> Self {
        let saved = load(&path);
        Self {
            path,
            data,
            saved,
            now,
            save_delay_ms,
            due: None,
        }
    }

    fn connections(&self) -> &Obj {
        self.saved
            .get("connections")
            .and_then(Value::as_object)
            .unwrap()
    }

    fn connections_mut(&mut self) -> &mut Obj {
        self.saved
            .get_mut("connections")
            .and_then(Value::as_object_mut)
            .unwrap()
    }

    fn entries_mut(&mut self, connection: &str) -> &mut Obj {
        let connections = self.connections_mut();
        if !connections.contains_key(connection) {
            connections.insert(connection.to_owned(), Value::Object(Obj::new()));
        }
        connections
            .get_mut(connection)
            .and_then(Value::as_object_mut)
            .unwrap()
    }

    fn save(&mut self) {
        if self.due.is_none() {
            self.due = Some((self.now)() + self.save_delay_ms);
        }
    }

    /// When the pending write is due, if one is.
    pub fn due(&self) -> Option<f64> {
        self.due
    }

    /// Writes the pending marks if their time has come.
    pub fn poll(&mut self, now: f64) {
        if self.due.is_some_and(|due| now >= due) {
            self.flush();
        }
    }

    /// Writes pending marks now.
    pub fn flush(&mut self) {
        if self.due.take().is_none() {
            return;
        }
        let text = format!("{}\n", js::stringify(&Value::Object(self.saved.clone())));
        // Kept in memory on failure: lost only with a restart.
        let _ = self
            .data
            .replace_data_file(&self.path, text.as_bytes(), 0o600);
    }

    /// The state an agent was last seen finished in (-1: only working).
    pub fn seen(&self, connection: &str, pane: &str, terminal: &str) -> Option<f64> {
        self.connections()
            .get(connection)
            .and_then(|e| e.get(key_of(pane, terminal)))
            .and_then(|e| e.get("seq"))
            .and_then(Value::as_f64)
    }

    /// Records a look at the agent, now; true when it was not yet seen in
    /// state `seq`.
    pub fn mark(
        &mut self,
        connection: &str,
        pane: &str,
        terminal: &str,
        seq: Option<f64>,
        boot: Option<&str>,
    ) -> bool {
        if let Some(seq) = seq
            && (!js::is_safe_integer(seq) || seq < 0.0)
        {
            return false;
        }
        let added = !self.connections().contains_key(connection);
        self.entries_mut(connection);
        if added {
            let names: Vec<String> = self.connections().keys().cloned().collect();
            if names.len() > MAX_CONNECTIONS {
                let mut others: Vec<(String, f64)> = names
                    .iter()
                    .filter(|each| *each != connection)
                    .map(|each| {
                        let at = latest(
                            self.connections()
                                .get(each)
                                .and_then(Value::as_object)
                                .unwrap(),
                        );
                        (each.clone(), at)
                    })
                    .collect();
                others.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                for (old, _) in others.into_iter().take(names.len() - MAX_CONNECTIONS) {
                    self.connections_mut().shift_remove(&old);
                }
            }
        }
        let now = (self.now)();
        let key = key_of(pane, terminal);
        let entries = self.entries_mut(connection);
        let old = entries.get(&key).and_then(Value::as_object).cloned();
        let boot = boot.filter(|b| !b.is_empty());
        let old_boot = old
            .as_ref()
            .map(|o| js::sv(o.get("boot")).to_owned())
            .unwrap_or_default();
        let old_seq = old
            .as_ref()
            .and_then(|o| o.get("seq"))
            .and_then(Value::as_f64)
            .unwrap_or(-1.0);
        let same_boot = boot.is_some() && !old_boot.is_empty() && Some(old_boot.as_str()) == boot;
        let reset = old.is_some()
            && (other_boot(old.as_ref().unwrap(), boot)
                || (!same_boot && seq.is_some_and(|s| s < old_seq)));
        let before = if old.is_some() && !reset {
            old_seq
        } else {
            -1.0
        };
        let advanced = seq.is_some_and(|s| s > before);
        let kept = boot
            .map(str::to_owned)
            .or_else(|| (!reset && !old_boot.is_empty()).then_some(old_boot));
        let mut entry = Obj::new();
        entry.insert(
            "seq".into(),
            js::number(if advanced { seq.unwrap() } else { before }),
        );
        entry.insert("at".into(), js::number(now));
        if let Some(kept) = kept {
            entry.insert("boot".into(), Value::String(kept));
        }
        entries.insert(key, Value::Object(entry));
        if entries.len() > MAX_PER_CONNECTION {
            let mut keys: Vec<(String, f64)> = entries
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.get("at").and_then(Value::as_f64).unwrap_or(0.0),
                    )
                })
                .collect();
            keys.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let excess = keys.len() - MAX_PER_CONNECTION;
            for (old, _) in keys.into_iter().take(excess) {
                entries.shift_remove(&old);
            }
        }
        self.save();
        advanced
    }

    /// Roamgate itself prompted the agent in state `seq`.
    pub fn quiet_turn(
        &mut self,
        connection: &str,
        pane: &str,
        terminal: &str,
        seq: f64,
        status: &str,
    ) {
        if !js::is_safe_integer(seq) {
            return;
        }
        let key = key_of(pane, terminal);
        let entries = self.entries_mut(connection);
        let entry = entries.get(&key).and_then(Value::as_object).cloned();
        let finished = status == "idle" || status == "done";
        let entry_seq = entry
            .as_ref()
            .and_then(|e| e.get("seq"))
            .and_then(Value::as_f64);
        if finished
            && match entry_seq {
                Some(s) => seq > s,
                None => status == "done",
            }
        {
            return;
        }
        let mut out = Obj::new();
        out.insert("seq".into(), js::number(entry_seq.unwrap_or(seq)));
        out.insert(
            "at".into(),
            js::number(
                entry
                    .as_ref()
                    .and_then(|e| e.get("at"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            ),
        );
        out.insert("quiet".into(), js::number(seq));
        if let Some(Value::String(boot)) = entry.as_ref().and_then(|e| e.get("boot"))
            && !boot.is_empty()
        {
            out.insert("boot".into(), Value::String(boot.clone()));
        }
        entries.insert(key, Value::Object(out));
        self.save();
    }

    /// An agent saying the user needs to act.
    pub fn note(&mut self, connection: &str, pane: &str, text: &str, title: Option<&str>) {
        let now = (self.now)();
        if !self.saved.contains_key("notes") {
            self.saved.insert("notes".into(), Value::Object(Obj::new()));
        }
        let notes = self
            .saved
            .get_mut("notes")
            .and_then(Value::as_object_mut)
            .unwrap();
        if !notes.contains_key(connection) {
            notes.insert(connection.to_owned(), Value::Object(Obj::new()));
        }
        let panes = notes
            .get_mut(connection)
            .and_then(Value::as_object_mut)
            .unwrap();
        let mut note = Obj::new();
        if let Some(title) = title {
            note.insert("title".into(), Value::String(title.into()));
        }
        note.insert("text".into(), Value::String(text.into()));
        note.insert("at".into(), js::number(now));
        panes.insert(pane.to_owned(), Value::Object(note));
        self.save();
    }

    /// Herdr's agent list with each finished agent's own Done.
    pub fn annotate(&mut self, connection: &str, result: &Value, boot: Option<&str>) -> Value {
        let Some(record) = result.as_object() else {
            return result.clone();
        };
        let Some(Value::Array(agents)) = record.get("agents") else {
            return result.clone();
        };
        let mut changed = false;
        let mut annotated = Vec::with_capacity(agents.len());
        for agent in agents {
            let Some(map) = agent.as_object() else {
                annotated.push(agent.clone());
                continue;
            };
            let (Some(Value::String(pane)), Some(Value::String(terminal))) =
                (map.get("pane_id"), map.get("terminal_id"))
            else {
                annotated.push(agent.clone());
                continue;
            };
            let key = key_of(pane, terminal);
            let note = self
                .saved
                .get("notes")
                .and_then(|n| n.get(connection))
                .and_then(|n| n.get(pane.as_str()))
                .and_then(Value::as_object)
                .cloned();
            let connections = self
                .saved
                .get_mut("connections")
                .and_then(Value::as_object_mut)
                .unwrap();
            let entry = connections
                .get_mut(connection)
                .and_then(Value::as_object_mut)
                .and_then(|e| e.get_mut(&key))
                .and_then(Value::as_object_mut);
            let entry_at = entry
                .as_ref()
                .and_then(|e| e.get("at"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let mut out: Obj = map.clone();
            if let Some(note) = &note
                && note.get("at").and_then(Value::as_f64).unwrap_or(0.0) > entry_at
            {
                let text = js::sv(note.get("text"));
                let said = match note
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    Some(title) => format!("{title}: {text}"),
                    None => text.to_owned(),
                };
                out.insert("attention_note".into(), Value::String(said));
            }
            let Some(entry) = entry else {
                annotated.push(Value::Object(out));
                continue;
            };
            if other_boot(entry, boot) {
                annotated.push(Value::Object(out));
                continue;
            }
            let seq = safe_int(map.get("state_change_seq"));
            let entry_seq = entry.get("seq").and_then(Value::as_f64).unwrap_or(-1.0);
            if let Some(seq) = seq
                && seq < entry_seq
            {
                annotated.push(Value::Object(out));
                continue;
            }
            let status = js::sv(map.get("agent_status"));
            let finished = (status == "idle" || status == "done") && seq.is_some();
            let quiet = entry.get("quiet").and_then(Value::as_f64);
            if finished && quiet.is_some_and(|q| seq.unwrap() > q) {
                entry.insert("seq".into(), js::number(entry_seq.max(seq.unwrap())));
                entry.shift_remove("quiet");
                changed = true;
            }
            let at = entry.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            if at > 0.0 {
                out.insert("seen_at".into(), js::number(at));
            }
            if finished {
                let entry_seq = entry.get("seq").and_then(Value::as_f64).unwrap_or(-1.0);
                let quiet = entry.get("quiet").is_some();
                out.insert(
                    "seen_done".into(),
                    Value::Bool(!quiet && seq.unwrap() > entry_seq),
                );
            }
            annotated.push(Value::Object(out));
        }
        if changed {
            self.save();
        }
        let mut out = record.clone();
        out.insert("agents".into(), Value::Array(annotated));
        Value::Object(out)
    }
}

/// How long a connection's Herdr boot id is trusted before it is read again.
pub const BOOT_TTL_MS: f64 = 60_000.0;

/// Each connection's Herdr boot id, read at most once a minute.
#[derive(Default)]
pub struct HerdrBootCache {
    boots: HashMap<String, (f64, Option<String>)>,
}

impl HerdrBootCache {
    /// The cached boot id, or None when it must be read (`fresh` false).
    pub fn cached(&self, connection: &str, now: f64) -> Option<Option<String>> {
        let (at, boot) = self.boots.get(connection)?;
        (now - at < BOOT_TTL_MS).then(|| boot.clone())
    }

    /// Stores what a read gave (failures and empty ids are unknown boots).
    pub fn store(
        &mut self,
        connection: &str,
        now: f64,
        read: Result<Option<String>, String>,
    ) -> Option<String> {
        let boot = read.ok().flatten().filter(|b| !b.is_empty());
        self.boots
            .insert(connection.to_owned(), (now, boot.clone()));
        boot
    }

    pub fn invalidate(&mut self, connection: &str) {
        self.boots.remove(connection);
    }
}

/// The parameters of `agent_seen.mark`: pane, terminal and the optional
/// state number, or the error it answers.
pub fn mark_params(params: &Value) -> Result<(String, String, Option<f64>), String> {
    let invalid = || "invalid agent_seen.mark".to_owned();
    let map = params.as_object().ok_or_else(invalid)?;
    let pane = map
        .get("pane_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let terminal = map
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if pane.is_empty() || js::len16(pane) > 200 || terminal.is_empty() || js::len16(terminal) > 200
    {
        return Err(invalid());
    }
    let seq = match map.get("seq") {
        None => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => return Err(invalid()),
    };
    Ok((pane.to_owned(), terminal.to_owned(), seq))
}

/// Whether a mark must read the boot id again (a lower state number may
/// mean Herdr restarted).
pub fn mark_needs_fresh_boot(
    store: &AgentSeenStore,
    connection: &str,
    pane: &str,
    terminal: &str,
    seq: Option<f64>,
) -> bool {
    seq.is_some_and(|s| {
        js::is_safe_integer(s)
            && s >= 0.0
            && s < store.seen(connection, pane, terminal).unwrap_or(-1.0)
    })
}

/// Keeps `Map` in the public API of this module for adapters.
pub type Saved = Map<String, Value>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct Fixture {
        _dir: tempfile::TempDir,
        path: PathBuf,
        data: DataContext,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-seen.json");
        let data = DataContext::new(dir.path(), roamgate_base::paths::Platform::current(), None);
        Fixture {
            _dir: dir,
            path,
            data,
        }
    }

    fn clock() -> (Arc<AtomicI64>, Box<dyn Fn() -> f64 + Send + Sync>) {
        let at = Arc::new(AtomicI64::new(1000));
        let read = at.clone();
        (at, Box::new(move || read.load(Ordering::SeqCst) as f64))
    }

    fn open(f: &Fixture) -> AgentSeenStore {
        AgentSeenStore::open(f.path.clone(), f.data.clone(), Box::new(js::now_ms))
    }

    fn agent(status: &str, seq: i64, pane: &str) -> Value {
        json!({ "pane_id": pane, "terminal_id": format!("term-{pane}"), "agent": "claude", "agent_status": status, "state_change_seq": seq })
    }

    fn first(value: &Value) -> Value {
        value["agents"][0].clone()
    }

    #[test]
    fn an_agent_is_done_when_it_changed_state_since_it_was_seen() {
        let f = fixture();
        let mut store = open(&f);
        let list = json!({ "agents": [agent("idle", 5, "w1:p1"), agent("done", 3, "w1:p2"), agent("working", 9, "w1:p1")] });
        assert_eq!(store.annotate("local", &list, None), list);
        assert!(store.mark("local", "w1:p1", "term-w1:p1", Some(4.0), None));
        assert!(store.mark("local", "w1:p2", "term-w1:p2", Some(3.0), None));
        let annotated = store.annotate("local", &list, None);
        assert_eq!(annotated["agents"][0]["seen_done"], json!(true));
        assert_eq!(annotated["agents"][1]["seen_done"], json!(false));
        assert!(annotated["agents"][2].get("seen_done").is_none());
        assert!(annotated["agents"][0]["seen_at"].is_number());
        assert_eq!(store.annotate("desktop", &list, None), list);
        store.flush();
    }

    #[test]
    fn marks_only_move_forward_on_one_herdr_boot_and_survive_a_restart() {
        let f = fixture();
        let mut store = open(&f);
        let boot = Some("1072-1792889171298769000");
        assert!(store.mark("local", "w1:p1", "t1", Some(7.0), boot));
        assert!(!store.mark("local", "w1:p1", "t1", Some(6.0), boot));
        assert!(!store.mark("local", "w1:p1", "t1", Some(7.0), boot));
        assert!(!store.mark("local", "w1:p1", "t1", None, boot));
        assert!(!store.mark("local", "w1:p1", "t1", None, None));
        assert_eq!(store.seen("local", "w1:p1", "t1"), Some(7.0));
        assert!(!store.mark("local", "w1:p1", "t1", Some(-1.0), None));
        assert_eq!(store.seen("local", "w1:p1", "t2"), None);
        store.flush();
        assert_eq!(open(&f).seen("local", "w1:p1", "t1"), Some(7.0));
    }

    #[test]
    fn a_damaged_file_forgets_what_was_seen_rather_than_failing() {
        let f = fixture();
        std::fs::write(&f.path, "{ not json").unwrap();
        let mut store = open(&f);
        assert_eq!(store.seen("local", "w1:p1", "t1"), None);
        assert!(store.mark("local", "w1:p1", "t1", Some(1.0), None));
    }

    #[test]
    fn an_agent_looked_at_while_working_is_done_once_it_finishes() {
        let f = fixture();
        let (at, now) = clock();
        let mut store = AgentSeenStore::open(f.path.clone(), f.data.clone(), now);
        store.mark("local", "w1:p1", "term-w1:p1", None, None);
        assert_eq!(store.seen("local", "w1:p1", "term-w1:p1"), Some(-1.0));
        at.store(2000, Ordering::SeqCst);
        let annotated = store.annotate(
            "local",
            &json!({ "agents": [agent("idle", 0, "w1:p1"), agent("working", 4, "w1:p2")] }),
            None,
        );
        assert_eq!(annotated["agents"][0]["seen_done"], json!(true));
        assert_eq!(annotated["agents"][0]["seen_at"], json!(1000));
        assert!(annotated["agents"][1].get("seen_at").is_none());
    }

    #[test]
    fn a_herdr_restart_forgets_the_marks_of_the_server_before() {
        let f = fixture();
        let mut store = open(&f);
        let before = "1072-1792889171298769000";
        let after = "2210-1792990000000000000";
        assert!(store.mark("local", "w1:p1", "term-w1:p1", Some(1800.0), Some(before)));
        let list = json!({ "agents": [agent("done", 12, "w1:p1")] });
        assert_eq!(
            first(&store.annotate("local", &list, Some(after))),
            agent("done", 12, "w1:p1")
        );
        assert_eq!(
            first(&store.annotate("local", &list, None)),
            agent("done", 12, "w1:p1")
        );
        assert!(store.mark("local", "w1:p1", "term-w1:p1", Some(12.0), Some(after)));
        assert_eq!(store.seen("local", "w1:p1", "term-w1:p1"), Some(12.0));
        assert_eq!(
            first(&store.annotate("local", &list, Some(after)))["seen_done"],
            json!(false)
        );
        let later = json!({ "agents": [agent("idle", 15, "w1:p1")] });
        assert_eq!(
            first(&store.annotate("local", &later, Some(after)))["seen_done"],
            json!(true)
        );
        store.flush();
        let mut reloaded = open(&f);
        assert_eq!(reloaded.seen("local", "w1:p1", "term-w1:p1"), Some(12.0));
        assert_eq!(
            first(&reloaded.annotate("local", &list, Some(before))),
            agent("done", 12, "w1:p1")
        );
    }

    #[test]
    fn without_a_boot_id_a_lower_state_number_is_a_herdr_restart() {
        let f = fixture();
        let mut store = open(&f);
        assert!(store.mark("local", "w1:p1", "t1", Some(900.0), None));
        assert!(store.mark("local", "w1:p1", "t1", Some(3.0), None));
        assert_eq!(store.seen("local", "w1:p1", "t1"), Some(3.0));
        assert!(!store.mark("local", "w1:p1", "t1", None, Some("b2")));
        assert!(store.mark("local", "w1:p1", "t1", Some(5.0), Some("b3")));
        assert!(!store.mark("local", "w1:p1", "t1", None, Some("b4")));
        assert_eq!(store.seen("local", "w1:p1", "t1"), Some(-1.0));
    }

    #[test]
    fn the_boot_id_is_read_once_a_minute_or_again_when_invalidated() {
        let mut cache = HerdrBootCache::default();
        let mut reads = 0;
        let mut get =
            |cache: &mut HerdrBootCache,
             now: f64,
             read: &mut dyn FnMut() -> Result<Option<String>, String>| {
                match cache.cached("local", now) {
                    Some(boot) => boot,
                    None => {
                        let value = read();
                        cache.store("local", now, value)
                    }
                }
            };
        let mut read = || {
            reads += 1;
            Ok(Some(format!("boot-{reads}")))
        };
        assert_eq!(get(&mut cache, 0.0, &mut read).as_deref(), Some("boot-1"));
        assert_eq!(get(&mut cache, 0.0, &mut read).as_deref(), Some("boot-1"));
        assert_eq!(
            get(&mut cache, 60_000.0, &mut read).as_deref(),
            Some("boot-2")
        );
        cache.invalidate("local");
        assert_eq!(
            get(&mut cache, 60_000.0, &mut read).as_deref(),
            Some("boot-3")
        );
        cache.invalidate("local");
        assert_eq!(
            get(&mut cache, 60_000.0, &mut || Err("closed".into())),
            None
        );
        cache.invalidate("local");
        assert_eq!(
            get(&mut cache, 60_000.0, &mut || Ok(Some(String::new()))),
            None
        );
    }

    #[test]
    fn marks_are_written_once_per_burst_and_at_once_on_flush() {
        let f = fixture();
        let (at, now) = clock();
        let mut store = AgentSeenStore::open(f.path.clone(), f.data.clone(), now);
        store.mark("local", "w1:p1", "t1", Some(1.0), None);
        store.mark("local", "w1:p2", "t2", Some(2.0), None);
        assert!(!f.path.exists());
        store.poll(1999.0);
        assert!(!f.path.exists());
        store.poll(2000.0);
        assert_eq!(open(&f).seen("local", "w1:p2", "t2"), Some(2.0));
        at.store(3000, Ordering::SeqCst);
        store.mark("local", "w1:p3", "t3", Some(3.0), None);
        store.flush();
        assert_eq!(open(&f).seen("local", "w1:p3", "t3"), Some(3.0));
        std::fs::remove_file(&f.path).unwrap();
        store.flush();
        store.poll(10_000.0);
        assert!(!f.path.exists());
    }

    #[test]
    fn connections_looked_at_longest_ago_are_forgotten_beyond_64() {
        let f = fixture();
        let (at, now) = clock();
        let mut store = AgentSeenStore::open(f.path.clone(), f.data.clone(), now);
        for index in 0..64 {
            at.store(index, Ordering::SeqCst);
            store.mark(&format!("c{index}"), "w1:p1", "t1", Some(1.0), None);
        }
        at.store(100, Ordering::SeqCst);
        store.mark("c0", "w1:p1", "t1", Some(2.0), None);
        at.store(101, Ordering::SeqCst);
        store.mark("c64", "w1:p1", "t1", Some(1.0), None);
        assert_eq!(store.seen("c64", "w1:p1", "t1"), Some(1.0));
        assert_eq!(store.seen("c0", "w1:p1", "t1"), Some(2.0));
        assert_eq!(store.seen("c1", "w1:p1", "t1"), None);
        assert_eq!(store.seen("c2", "w1:p1", "t1"), Some(1.0));
    }

    #[test]
    fn agent_seen_mark_checks_its_parameters_and_marks_on_the_current_boot() {
        let f = fixture();
        let mut store = open(&f);
        let mut boots = HerdrBootCache::default();
        let mut boot = "boot-1".to_owned();
        let mut reads = 0;
        let long_pane = "x".repeat(201);
        let long_terminal = "t".repeat(201);
        for params in [
            Value::Null,
            json!("w1:p1"),
            json!({}),
            json!({ "pane_id": "w1:p1" }),
            json!({ "pane_id": "", "terminal_id": "t1" }),
            json!({ "pane_id": "w1:p1", "terminal_id": "" }),
            json!({ "pane_id": "w1:p1", "terminal_id": 7 }),
            json!({ "pane_id": long_pane, "terminal_id": "t1" }),
            json!({ "pane_id": "w1:p1", "terminal_id": long_terminal }),
            json!({ "pane_id": "w1:p1", "terminal_id": "t1", "seq": "4" }),
        ] {
            assert_eq!(mark_params(&params).unwrap_err(), "invalid agent_seen.mark");
        }
        let mut mark = |store: &mut AgentSeenStore,
                        boots: &mut HerdrBootCache,
                        boot: &str,
                        reads: &mut i32,
                        params: Value| {
            let (pane, terminal, seq) = mark_params(&params).unwrap();
            if mark_needs_fresh_boot(store, "local", &pane, &terminal, seq) {
                boots.invalidate("local");
            }
            let current = match boots.cached("local", 0.0) {
                Some(b) => b,
                None => {
                    *reads += 1;
                    boots.store("local", 0.0, Ok(Some(boot.to_owned())))
                }
            };
            store.mark("local", &pane, &terminal, seq, current.as_deref())
        };
        assert!(mark(
            &mut store,
            &mut boots,
            &boot,
            &mut reads,
            json!({ "pane_id": "w1:p1", "terminal_id": "t1", "seq": 40 })
        ));
        assert!(!mark(
            &mut store,
            &mut boots,
            &boot,
            &mut reads,
            json!({ "pane_id": "w1:p1", "terminal_id": "t1", "seq": 40 })
        ));
        assert!(!mark(
            &mut store,
            &mut boots,
            &boot,
            &mut reads,
            json!({ "pane_id": "w1:p2", "terminal_id": "t2" })
        ));
        assert_eq!(store.seen("local", "w1:p2", "t2"), Some(-1.0));
        assert!(!mark(
            &mut store,
            &mut boots,
            &boot,
            &mut reads,
            json!({ "pane_id": "w1:p1", "terminal_id": "t1", "seq": -2 })
        ));
        assert_eq!(reads, 1);
        boot = "boot-2".into();
        assert!(mark(
            &mut store,
            &mut boots,
            &boot,
            &mut reads,
            json!({ "pane_id": "w1:p1", "terminal_id": "t1", "seq": 3 })
        ));
        assert_eq!(reads, 2);
        assert_eq!(store.seen("local", "w1:p1", "t1"), Some(3.0));
    }

    #[test]
    fn what_an_agent_says_the_user_must_do_shows_until_they_look_at_it() {
        let f = fixture();
        let (at, now) = clock();
        let mut store = AgentSeenStore::open(f.path.clone(), f.data.clone(), now);
        let list = json!({ "agents": [agent("idle", 2, "w1:p1")] });
        store.note("local", "w1:p1", "A test is asked", Some("MR !12"));
        assert_eq!(
            first(&store.annotate("local", &list, None))["attention_note"],
            json!("MR !12: A test is asked")
        );
        store.flush();
        let mut reloaded =
            AgentSeenStore::open(f.path.clone(), f.data.clone(), Box::new(|| 1000.0));
        assert_eq!(
            first(&reloaded.annotate("local", &list, None))["attention_note"],
            json!("MR !12: A test is asked")
        );
        at.store(2000, Ordering::SeqCst);
        store.mark("local", "w1:p1", "term-w1:p1", None, None);
        assert!(
            first(&store.annotate("local", &list, None))
                .get("attention_note")
                .is_none()
        );
        at.store(3000, Ordering::SeqCst);
        store.note("local", "w1:p1", "Pipeline failed", None);
        assert_eq!(
            first(&store.annotate("local", &list, None))["attention_note"],
            json!("Pipeline failed")
        );
    }

    #[test]
    fn a_turn_roamgate_started_does_not_make_the_agent_done() {
        let f = fixture();
        let mut store = AgentSeenStore::open(f.path.clone(), f.data.clone(), Box::new(|| 1000.0));
        let mut done = |store: &mut AgentSeenStore, status: &str, seq: i64, pane: &str| {
            first(&store.annotate(
                "local",
                &json!({ "agents": [agent(status, seq, pane)] }),
                None,
            ))
        };
        store.mark("local", "w1:p1", "term-w1:p1", Some(4.0), None);
        store.quiet_turn("local", "w1:p1", "term-w1:p1", 4.0, "idle");
        assert!(
            done(&mut store, "working", 5, "w1:p1")
                .get("seen_done")
                .is_none()
        );
        assert_eq!(
            done(&mut store, "idle", 6, "w1:p1")["seen_done"],
            json!(false)
        );
        assert_eq!(
            done(&mut store, "idle", 8, "w1:p1")["seen_done"],
            json!(true)
        );
        store.mark("local", "w1:p2", "term-w1:p2", Some(2.0), None);
        store.quiet_turn("local", "w1:p2", "term-w1:p2", 3.0, "idle");
        assert_eq!(
            done(&mut store, "idle", 5, "w1:p2")["seen_done"],
            json!(true)
        );
        store.quiet_turn("local", "w1:p3", "term-w1:p3", 7.0, "idle");
        let fresh = done(&mut store, "idle", 9, "w1:p3");
        assert_eq!(fresh["seen_done"], json!(false));
        assert!(fresh.get("seen_at").is_none());
    }
}

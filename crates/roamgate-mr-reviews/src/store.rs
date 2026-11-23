//! The reviews module's own state (`mr-reviews/store.ts`),
//! `<data>/mr-reviews/state.json`: what the user saw of each request,
//! feedback, Claude's picks, reviews, review worktrees, the last inbox,
//! inferences and homes. Written through on every change, as Bun writes it
//! (`JSON.stringify` and a newline, atomic replace, 0600 in a 0700 directory).

use std::path::{Path, PathBuf};

use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::DataContext;
use roamgate_base::private::create_dir_all_mode;
use serde_json::{Value, json};

pub const FOUND_KEPT_DAYS: f64 = 14.0;
pub const FEEDBACK_KEPT: usize = 200;

/// `<data>/mr-reviews/state.json`.
pub fn state_path(data_root: &Path) -> PathBuf {
    data_root.join("mr-reviews").join("state.json")
}

fn record(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    }
}

/// An empty state, as `empty()` gives it (no `inferred` nor `homes`).
pub fn empty() -> Obj {
    let value = json!({
        "version": 1, "seen": {}, "feedback": [], "ranked": {}, "reviews": {}, "projects": {},
        "items": [], "baselined": {}, "prefetched": {}, "drafts": {}, "found": {}, "pins": {},
        "ownDetails": {},
    });
    value.as_object().cloned().unwrap_or_default()
}

/// `normalizeState`: any parsed JSON as a state.
pub fn normalize_state(raw: &Value) -> Obj {
    let value = raw.as_object().cloned().unwrap_or_default();
    let feedback: Vec<Value> = match value.get("feedback") {
        Some(Value::Array(items)) => {
            let kept: Vec<Value> = items
                .iter()
                .filter(|e| e.get("key").is_some_and(Value::is_string))
                .cloned()
                .collect();
            let skip = kept.len().saturating_sub(FEEDBACK_KEPT);
            kept.into_iter().skip(skip).collect()
        }
        _ => vec![],
    };
    let mut out = Obj::new();
    out.insert("version".into(), json!(1));
    out.insert("seen".into(), record(value.get("seen")));
    out.insert("feedback".into(), Value::Array(feedback));
    for name in ["ranked", "reviews", "projects"] {
        out.insert(name.into(), record(value.get(name)));
    }
    out.insert(
        "items".into(),
        match value.get("items") {
            Some(Value::Array(items)) => Value::Array(items.clone()),
            _ => json!([]),
        },
    );
    for name in [
        "baselined",
        "prefetched",
        "drafts",
        "found",
        "pins",
        "ownDetails",
        "inferred",
        "homes",
    ] {
        out.insert(name.into(), record(value.get(name)));
    }
    if let Some(at) = value.get("inferenceAt").filter(|v| v.is_string()) {
        out.insert("inferenceAt".into(), at.clone());
    }
    out
}

/// The state store: read once, written through on each change.
pub struct MrStore {
    context: DataContext,
    path: PathBuf,
    state: Obj,
}

impl MrStore {
    /// Opens the state at `path`; a missing or broken file starts over.
    pub fn open(context: DataContext, path: impl Into<PathBuf>) -> MrStore {
        let path = path.into();
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| normalize_state(&js::js_value(value)))
            .unwrap_or_else(empty);
        MrStore {
            context,
            path,
            state,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self) -> &Obj {
        &self.state
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            create_dir_all_mode(dir)?;
        }
        let text = format!("{}\n", js::stringify(&Value::Object(self.state.clone())));
        self.context
            .replace_data_file(&self.path, text.as_bytes(), 0o600)
    }

    /// Changes the state and writes it.
    pub fn update(&mut self, change: impl FnOnce(&mut Obj)) -> std::io::Result<()> {
        change(&mut self.state);
        self.save()
    }

    /// Sets (or with None clears) the user's verdict on a suggestion.
    pub fn set_feedback(
        &mut self,
        item: &Obj,
        verdict: Option<&str>,
        at: &str,
    ) -> std::io::Result<()> {
        let key = js::sv(item.get("key")).to_owned();
        let mut feedback: Vec<Value> = self
            .state
            .get("feedback")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| js::sv(e.get("key")) != key)
            .cloned()
            .collect();
        if let Some(verdict) = verdict {
            let files: Vec<Value> = item
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(20)
                .cloned()
                .collect();
            feedback.push(json!({
                "key": key, "verdict": verdict, "at": at,
                "title": item.get("title").cloned().unwrap_or(Value::Null),
                "project": item.get("project").cloned().unwrap_or(Value::Null),
                "author": item.get("author").cloned().unwrap_or(Value::Null),
                "files": files,
            }));
        }
        let skip = feedback.len().saturating_sub(FEEDBACK_KEPT);
        self.state.insert(
            "feedback".into(),
            Value::Array(feedback.into_iter().skip(skip).collect()),
        );
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::paths::Platform;

    struct Data {
        _home: tempfile::TempDir,
        context: DataContext,
        path: PathBuf,
    }

    fn data() -> Data {
        let home = tempfile::tempdir().unwrap();
        let context = DataContext::new(home.path(), Platform::current(), None);
        let path = state_path(&context.data_root());
        Data {
            _home: home,
            context,
            path,
        }
    }

    #[test]
    fn a_missing_or_broken_file_starts_empty() {
        let Data {
            context,
            path,
            _home,
        } = data();
        assert_eq!(MrStore::open(context.clone(), &path).get(), &empty());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{nope").unwrap();
        assert_eq!(MrStore::open(context, &path).get(), &empty());
    }

    #[test]
    fn bun_state_files_read_and_write_back_byte_for_byte() {
        // As Bun writes it after a refresh, an inference and a home (store.ts).
        let text = concat!(
            r#"{"version":1,"seen":{"gitlab:h/g/p#1":{"at":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-15T00:00:00Z","headSha":"abc1234","notes":2,"state":"open","pipeline":null}},"#,
            r#""feedback":[{"key":"k","verdict":"not_interested","at":"t","title":"T","project":"g/p","author":"a","files":[]}],"#,
            r#""ranked":{},"reviews":{},"projects":{},"items":[{"key":"gitlab:h/g/p#1","number":1,"score":0.5}],"#,
            r#""baselined":{"h":"t"},"prefetched":{},"drafts":{"k":{"count":2,"at":"t"}},"found":{},"pins":{},"ownDetails":{},"#,
            r#""inferred":{"k":{"whose":{"person":"bob"},"next":"n","dependsOn":[],"stale":false,"version":"v","facts":"f","at":"t","by":"model"}},"#,
            r#""homes":{},"inferenceAt":"2026-11-16T00:00:00.000Z"}"#,
            "\n"
        );
        let Data {
            context,
            path,
            _home,
        } = data();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        let mut store = MrStore::open(context, &path);
        store.update(|_| {}).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn an_old_bun_file_gains_the_later_records_and_bun_reads_it_back() {
        // Backward: a file from before inferred and homes were kept. Bun's
        // normalizeState accepts what Rust writes (every key it knows, the
        // same shapes), so a rollback reads it.
        let Data {
            context,
            path,
            _home,
        } = data();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"seen":[],"feedback":"x","items":{}}"#,
        )
        .unwrap();
        let mut store = MrStore::open(context, &path);
        store.update(|_| {}).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({"version": 1, "seen": {}, "feedback": [], "ranked": {}, "reviews": {}, "projects": {},
                "items": [], "baselined": {}, "prefetched": {}, "drafts": {}, "found": {}, "pins": {},
                "ownDetails": {}, "inferred": {}, "homes": {}})
        );
        assert_eq!(
            normalize_state(&written),
            written.as_object().cloned().unwrap()
        );
    }

    #[test]
    fn feedback_keeps_the_latest_word_per_request_capped() {
        let Data {
            context,
            path,
            _home,
        } = data();
        let mut store = MrStore::open(context.clone(), &path);
        let item = |n: usize| {
            json!({"key": format!("k{n}"), "title": "T", "project": "p", "author": "a",
                "files": (0..30).map(|i| format!("f{i}")).collect::<Vec<_>>()})
            .as_object()
            .cloned()
            .unwrap()
        };
        for n in 0..205 {
            store
                .set_feedback(&item(n), Some("more_like_this"), "t")
                .unwrap();
        }
        store
            .set_feedback(&item(204), Some("not_interested"), "t2")
            .unwrap();
        store.set_feedback(&item(203), None, "t3").unwrap();
        let feedback = store.get()["feedback"].as_array().unwrap().clone();
        assert_eq!(feedback.len(), 199);
        assert_eq!(feedback[0]["key"], json!("k5"));
        assert_eq!(feedback.last().unwrap()["verdict"], json!("not_interested"));
        assert_eq!(
            feedback.last().unwrap()["files"].as_array().unwrap().len(),
            20
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        let reopened = MrStore::open(context, &path);
        assert_eq!(reopened.get()["feedback"].as_array().unwrap().len(), 199);
    }
}

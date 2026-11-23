//! Suggestions (`mr-reviews/curation.ts`): Claude picks, from the followed
//! projects' open requests, the few the user would want to review, each
//! with a one-line reason, fed the user's own signals. A bare model: the
//! runner is injected ([`RunModel`]); the production one is the headless
//! Claude of `roamgate-claude`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_agents::obj;
use serde_json::{Value, json};

use crate::connection::{BoxFuture, MrConnection, sh_quote};
use crate::store::MrStore;

pub const CURATION_MODEL: &str = "opus";
pub const BATCH_SIZE: usize = 25;
pub const CURATION_EVERY_MS: f64 = 20.0 * 60_000.0;
pub const PICKS_PER_BATCH: usize = 8;
const FEEDBACK_SHOWN: usize = 30;
const HISTORY_TTL_MS: f64 = 10.0 * 60_000.0;

/// What a bare model run gave.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelAnswer {
    pub text: String,
    pub cost_usd: Option<f64>,
    pub ms: f64,
}

/// `claude -p` as a bare model: no tool, no session, no MCP, no hooks.
pub trait RunModel: Send + Sync {
    fn run<'a>(&'a self, model: &'a str, system: &'a str, prompt: &'a str) -> BoxFuture<'a, Result<ModelAnswer, String>>;
}

impl<F> RunModel for F
where
    F: Fn(&str, &str, &str) -> Result<ModelAnswer, String> + Send + Sync,
{
    fn run<'a>(&'a self, model: &'a str, system: &'a str, prompt: &'a str) -> BoxFuture<'a, Result<ModelAnswer, String>> {
        let answer = self(model, system, prompt);
        Box::pin(async move { answer })
    }
}

/// The user's history in a clone: `C path` per file of their commits over
/// 180 days, `B path` for files of their recent unmerged branches.
pub fn history_script(clone: &str) -> String {
    [
        format!("cd {} || exit 0", sh_quote(clone)),
        "e=$(git config user.email)".to_owned(),
        "[ -n \"$e\" ] || exit 0".to_owned(),
        "git log --since=180.days --no-merges --author=\"$e\" --name-only --format= -n 400 2>/dev/null | sed \"/^$/d; s/^/C /\"".to_owned(),
        "base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || git rev-parse --abbrev-ref upstream/HEAD 2>/dev/null || echo main)".to_owned(),
        "for b in $(git for-each-ref --sort=-committerdate --count=15 --format=\"%(refname:short)\" refs/heads); do".to_owned(),
        "  git log --no-merges --author=\"$e\" --name-only --format= \"$base..$b\" -n 30 2>/dev/null | sed \"/^$/d; s/^/B /\"".to_owned(),
        "done | sort -u | head -300".to_owned(),
    ]
    .join("\n")
}

/// Counts of files and their directories, most touched first.
pub fn top_paths(files: &[String], max: usize) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut bump = |key: String| match counts.iter_mut().find(|(k, _)| *k == key) {
        Some((_, n)) => *n += 1,
        None => counts.push((key, 1)),
    };
    for file in files {
        bump(file.clone());
        if let Some(at) = file.rfind('/')
            && at > 0
        {
            bump(format!("{}/", &file[..at]));
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts.truncate(max);
    counts
}

/// The history script's lines: committed paths, and branch paths (unique, capped).
pub fn parse_history(stdout: &str) -> (Vec<String>, Vec<String>) {
    let mut committed = Vec::new();
    let mut branches: Vec<String> = Vec::new();
    for line in stdout.split('\n') {
        if let Some(path) = line.strip_prefix("C ") {
            committed.push(js::trim(path).to_owned());
        } else if let Some(path) = line.strip_prefix("B ") {
            let path = js::trim(path).to_owned();
            if !branches.contains(&path) {
                branches.push(path);
            }
        }
    }
    branches.truncate(120);
    (committed, branches)
}

pub fn curation_system_prompt() -> String {
    format!(
        "You filter merge requests for one code reviewer. You never review code, never comment on the changes and never take any action: you only pick, among candidate open merge requests of projects the reviewer follows, the few they would most want to review, and say why in one short line.\n\nGround every pick in the reviewer's signals: files and directories they changed lately, their unmerged branches, requests they reviewed and the people involved, their own hints, and their past feedback (\"more_like_this\" and \"not_interested\" verdicts are precedent: pick what resembles the former, avoid what resembles the latter). A candidate with no concrete link to the signals is not picked. Prefer overlap with files the reviewer touched over loose topical similarity. Files every change touches (CI configuration such as .gitlab-ci.yml, top-level build files, release notes) are weak signals on their own. \"people\" are authors the reviewer was asked to review or reviewed: a person alone is a weak reason.\n\nAnswer with JSON only, no prose: an array with one object per candidate, in any order: {{\"key\": the candidate's key, \"pick\": true or false, \"score\": 0-100, \"reason\": at most 90 characters naming the concrete signal (a file, a directory, a person, a precedent), empty when not picked}}. Pick at most {PICKS_PER_BATCH}."
    )
}

/// The user's interest signals.
#[derive(Clone, Debug, Default)]
pub struct Signals {
    pub paths: Vec<(String, usize)>,
    pub branches: Vec<String>,
    pub collaborators: Vec<String>,
    pub reviewed: Vec<Value>,
    pub hints: String,
    pub feedback: Vec<Value>,
}

impl Signals {
    pub fn to_json(&self) -> Value {
        json!({"paths": self.paths.iter().map(|(p, n)| json!([p, n])).collect::<Vec<_>>(), "branches": self.branches,
            "collaborators": self.collaborators, "reviewed": self.reviewed, "hints": self.hints, "feedback": self.feedback})
    }
}

fn take<T: Clone>(items: &[T], n: usize) -> Vec<T> {
    items.iter().take(n).cloned().collect()
}

pub fn curation_prompt(signals: &Signals, candidates: &[Obj]) -> String {
    let compact: Vec<Value> = candidates
        .iter()
        .map(|item| {
            let files: Vec<Value> = item.get("files").and_then(Value::as_array).into_iter().flatten().take(25).cloned().collect();
            Value::Object(obj! {
                "key" => item.get("key").cloned(),
                "project" => item.get("project").cloned(),
                "title" => item.get("title").cloned(),
                "author" => item.get("author").cloned(),
                "draft" => js::is_true(item.get("draft")).then_some(true),
                "files" => files,
            })
        })
        .collect();
    let skip = signals.feedback.len().saturating_sub(FEEDBACK_SHOWN);
    let reviewer = obj! {
        "changed_lately" => signals.paths.iter().map(|(p, n)| json!([p, n])).collect::<Vec<_>>(),
        "unmerged_branches" => Value::Array(take(&signals.branches, 80).into_iter().map(Value::String).collect()),
        "reviewed" => take(&signals.reviewed, 20),
        "people" => Value::Array(take(&signals.collaborators, 30).into_iter().map(Value::String).collect()),
        "hints" => js::truthy(&signals.hints),
        "feedback" => signals.feedback[skip..].to_vec(),
    };
    js::stringify(&json!({"reviewer": reviewer, "candidates": compact}))
}

/// What a ranking stands on: the head and the title.
pub fn version_of(item: &Obj) -> String {
    format!("{}\n{}", js::sv(item.get("headSha")), js::sv(item.get("title")))
}

/// Whether a ranking still holds for `item`.
pub fn ranked_current(ranked: Option<&Value>, item: &Obj) -> bool {
    let Some(ranked) = ranked.filter(|r| r.is_object()) else { return false };
    if js::sv(ranked.get("by")) == "agent" {
        return true;
    }
    match ranked.get("version") {
        Some(version) if !version.is_null() => version.as_str() == Some(version_of(item).as_str()),
        _ => ranked.get("updatedAt") == item.get("updatedAt"),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ranking {
    pub key: String,
    pub pick: bool,
    pub score: f64,
    pub reason: String,
}

impl Ranking {
    pub fn to_json(&self) -> Value {
        json!({"key": self.key, "pick": self.pick, "score": js::number(self.score), "reason": self.reason})
    }
}

/// The JSON array in a model's answer.
pub fn answer_array(text: &str) -> Result<Vec<Value>, String> {
    let (Some(start), Some(end)) = (text.find('['), text.rfind(']')) else {
        return Err("no JSON array in the answer".into());
    };
    if end < start {
        return Err("no JSON array in the answer".into());
    }
    let raw: Value = serde_json::from_str(&text[start..=end]).map_err(|e| e.to_string())?;
    match js::js_value(raw) {
        Value::Array(items) => Ok(items),
        _ => Err("the answer is not an array".into()),
    }
}

static SPACES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\s+").expect("pattern"));

/// One-line text, as `.replace(/\s+/g, " ").trim().slice(0, max)`.
pub fn line(text: &str, max: usize) -> String {
    js::head16(js::trim(&SPACES.replace_all(text, " ")), max)
}

/// The model's answer, checked: only given keys, a reason for each pick, few picks.
pub fn parse_ranking(text: &str, keys: &[String]) -> Result<Vec<Ranking>, String> {
    let mut out: Vec<Ranking> = Vec::new();
    for entry in answer_array(text)? {
        let Some(key) = entry.get("key").and_then(Value::as_str).filter(|k| keys.iter().any(|x| x == k)) else { continue };
        let score = js::to_number(entry.get("score"));
        let score = if score.is_nan() { 0.0 } else { score.clamp(0.0, 100.0) };
        let reason = entry.get("reason").and_then(Value::as_str).map(|r| line(r, 120)).unwrap_or_default();
        out.push(Ranking { key: key.into(), pick: js::is_true(entry.get("pick")) && !reason.is_empty(), score, reason });
    }
    let mut picks: Vec<usize> = (0..out.len()).filter(|i| out[*i].pick).collect();
    picks.sort_by(|a, b| out[*b].score.partial_cmp(&out[*a].score).unwrap_or(std::cmp::Ordering::Equal));
    for extra in picks.into_iter().skip(PICKS_PER_BATCH) {
        out[extra].pick = false;
    }
    Ok(out)
}

/// The curation's settings (the fields it reads).
#[derive(Clone, Debug, Default)]
pub struct CurationSettings {
    pub curation: bool,
    pub hints: String,
    pub followed: usize,
    pub suggest_days: Option<f64>,
}

pub type Settings<T> = Arc<dyn Fn() -> BoxFuture<'static, T> + Send + Sync>;

/// `MrCurationState`.
pub fn status(state: &str, at: Option<String>, message: Option<String>) -> Value {
    Value::Object(obj! {"state" => state, "at" => at, "message" => message})
}

pub struct Curation {
    pub store: Arc<Mutex<MrStore>>,
    pub settings: Settings<CurationSettings>,
    pub connections: Arc<dyn Fn() -> Vec<Arc<dyn MrConnection>> + Send + Sync>,
    /// The user's name per forge host (lower case).
    pub users: Option<Arc<dyn Fn() -> HashMap<String, String> + Send + Sync>>,
    pub clones: Option<Arc<dyn Fn() -> BoxFuture<'static, Vec<(String, String)>> + Send + Sync>>,
    pub run: Arc<dyn RunModel>,
    pub model: String,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    status: Mutex<Value>,
    last_run: Mutex<f64>,
    history: Mutex<Option<(f64, Vec<String>, Vec<String>)>>,
    running: tokio::sync::Mutex<()>,
}

impl Curation {
    pub fn new(store: Arc<Mutex<MrStore>>, settings: Settings<CurationSettings>, run: Arc<dyn RunModel>) -> Curation {
        Curation {
            store,
            settings,
            connections: Arc::new(Vec::new),
            users: None,
            clones: None,
            run,
            model: CURATION_MODEL.into(),
            now: Arc::new(js::now_ms),
            on_change: None,
            status: Mutex::new(status("idle", None, None)),
            last_run: Mutex::new(0.0),
            history: Mutex::new(None),
            running: tokio::sync::Mutex::new(()),
        }
    }

    pub fn state(&self) -> Value {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_status(&self, value: Value) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }

    fn changed(&self) {
        if let Some(on_change) = &self.on_change {
            on_change();
        }
    }

    fn own(&self, item: &Obj) -> bool {
        let users = self.users.as_ref().map(|u| u()).unwrap_or_default();
        users.get(js::sv(item.get("host"))).is_some_and(|u| *u == js::sv(item.get("author")).to_lowercase())
    }

    async fn read_history(&self) -> (Vec<String>, Vec<String>) {
        let now = (self.now)();
        if let Some((at, committed, branches)) = self.history.lock().unwrap_or_else(|e| e.into_inner()).clone()
            && now - at < HISTORY_TTL_MS
        {
            return (committed, branches);
        }
        let mut clones: Vec<(String, String)> = Vec::new();
        {
            let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            for project in store.get().get("projects").and_then(Value::as_object).into_iter().flatten().map(|(_, p)| p) {
                let clone = (js::sv(project.get("connectionId")).to_owned(), js::sv(project.get("clone")).to_owned());
                if !clones.contains(&clone) {
                    clones.push(clone);
                }
            }
        }
        if let Some(found) = &self.clones {
            for clone in found().await {
                if !clones.contains(&clone) {
                    clones.push(clone);
                }
            }
        }
        let (mut committed, mut branches) = (Vec::new(), Vec::new());
        let connections = (self.connections)();
        for (connection_id, path) in clones {
            let Some(connection) = connections.iter().find(|c| c.id() == connection_id) else { continue };
            let (c, b) = parse_history(&connection.run(&history_script(&path), 60_000).await.stdout);
            committed.extend(c);
            branches.extend(b);
        }
        *self.history.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, committed.clone(), branches.clone()));
        (committed, branches)
    }

    /// The user's interest signals, as the curation reads them.
    pub async fn signals(&self, items: &[Obj], hints: &str) -> Signals {
        let (committed, branches) = self.read_history().await;
        let (reviews, feedback): (Vec<String>, Vec<Value>) = {
            let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            let state = store.get();
            (
                state.get("reviews").and_then(Value::as_object).map(|r| r.keys().cloned().collect()).unwrap_or_default(),
                state.get("feedback").and_then(Value::as_array).cloned().unwrap_or_default(),
            )
        };
        let by_key: HashMap<&str, &Obj> = items.iter().map(|i| (js::sv(i.get("key")), i)).collect();
        let reviewed: Vec<&Obj> = reviews.iter().filter_map(|k| by_key.get(k.as_str()).copied()).collect();
        let mine = items.iter().filter(|i| i.get("reasons").and_then(Value::as_array).is_some_and(|r| !r.is_empty()));
        let mut collaborators: Vec<String> = Vec::new();
        for item in reviewed.iter().copied().chain(mine) {
            let author = js::sv(item.get("author"));
            if !self.own(item) && !author.is_empty() && !collaborators.iter().any(|c| c == author) {
                collaborators.push(author.into());
            }
        }
        let mut unique_branches: Vec<String> = Vec::new();
        for branch in branches {
            if !unique_branches.contains(&branch) {
                unique_branches.push(branch);
            }
        }
        Signals {
            paths: top_paths(&committed, 60),
            branches: unique_branches,
            collaborators,
            reviewed: reviewed
                .iter()
                .map(|i| {
                    let files: Vec<Value> = i.get("files").and_then(Value::as_array).into_iter().flatten().take(15).cloned().collect();
                    json!({"title": i.get("title"), "author": i.get("author"), "files": files})
                })
                .collect(),
            hints: hints.into(),
            feedback: feedback
                .iter()
                .map(|f| {
                    let files: Vec<Value> = f.get("files").and_then(Value::as_array).into_iter().flatten().take(10).cloned().collect();
                    json!({"verdict": f.get("verdict"), "title": f.get("title"), "project": f.get("project"), "author": f.get("author"), "files": files})
                })
                .collect(),
        }
    }

    fn candidates(&self, items: &[Obj], days: f64) -> Vec<Obj> {
        let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let state = store.get();
        let since = (self.now)() - days * 24.0 * 60.0 * 60_000.0;
        let dismissed: Vec<&str> = state
            .get("feedback")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|f| js::sv(f.get("verdict")) == "not_interested")
            .map(|f| js::sv(f.get("key")))
            .collect();
        let ranked = state.get("ranked");
        let mut out: Vec<Obj> = items
            .iter()
            .filter(|item| {
                js::sv(item.get("state")) == "open"
                    && item.get("reasons").and_then(Value::as_array).is_none_or(Vec::is_empty)
                    && !self.own(item)
                    && !dismissed.contains(&js::sv(item.get("key")))
                    && js::date_parse(js::sv(item.get("updatedAt"))) >= since
                    && !ranked_current(ranked.and_then(|r| r.get(js::sv(item.get("key")))), item)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| js::locale_compare(js::sv(b.get("updatedAt")), js::sv(a.get("updatedAt"))));
        out.truncate(BATCH_SIZE);
        out
    }

    async fn batch(&self, items: &[Obj]) -> Result<(), String> {
        let settings = (self.settings)().await;
        if !settings.curation || settings.followed == 0 {
            self.set_status(status("off", None, None));
            return Ok(());
        }
        let batch = self.candidates(items, settings.suggest_days.unwrap_or(30.0));
        if batch.is_empty() {
            return Ok(());
        }
        self.set_status(status("running", Some(js::iso((self.now)())), None));
        self.changed();
        let signals = self.signals(items, &settings.hints).await;
        let answer = self.run.run(&self.model, &curation_system_prompt(), &curation_prompt(&signals, &batch)).await?;
        let keys: Vec<String> = batch.iter().map(|i| js::sv(i.get("key")).to_owned()).collect();
        let ranking = parse_ranking(&answer.text, &keys)?;
        let at = js::iso((self.now)());
        {
            let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store
                .update(|state| {
                    let mut ranked = state.get("ranked").and_then(Value::as_object).cloned().unwrap_or_default();
                    for item in &batch {
                        let key = js::sv(item.get("key"));
                        if ranked.get(key).is_some_and(|r| js::sv(r.get("by")) == "agent") {
                            continue;
                        }
                        let entry = ranking.iter().find(|r| r.key == key);
                        ranked.insert(
                            key.into(),
                            json!({"updatedAt": item.get("updatedAt"), "version": version_of(item),
                                "pick": entry.is_some_and(|e| e.pick), "score": js::number(entry.map_or(0.0, |e| e.score)),
                                "reason": entry.map_or("", |e| e.reason.as_str()), "at": at}),
                        );
                    }
                    state.insert("ranked".into(), Value::Object(ranked));
                })
                .map_err(|e| e.to_string())?;
        }
        tracing::info!(target: "bridge.mr-reviews", model = %self.model, candidates = batch.len(),
            picked = ranking.iter().filter(|r| r.pick).count(), ms = answer.ms, "suggestions ranked");
        self.set_status(status("idle", Some(at), None));
        Ok(())
    }

    /// After a refresh: one batch when due and none is running.
    pub async fn maybe_run(&self, items: &[Obj], force: bool) {
        let Ok(_running) = self.running.try_lock() else {
            let _ = self.running.lock().await;
            return;
        };
        {
            let mut last = self.last_run.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            if !force && now - *last < CURATION_EVERY_MS {
                return;
            }
            *last = now;
        }
        if let Err(error) = self.batch(items).await {
            let message = js::head16(&error, 300);
            tracing::warn!(target: "bridge.mr-reviews", error = %message, "suggestions not ranked");
            self.set_status(status("error", Some(js::iso((self.now)())), Some(message)));
        }
        self.changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::paths::{DataContext, Platform};

    fn item(n: u64, extra: Value) -> Obj {
        let mut value = json!({"provider": "gitlab", "host": "h", "project": "g/p", "number": n, "key": format!("k{n}"),
            "url": format!("https://h/g/p/-/merge_requests/{n}"), "title": format!("MR {n}"), "author": "alice",
            "draft": false, "state": "open", "updatedAt": js::iso(js::now_ms() - n as f64 * 3_600_000.0),
            "headSha": "a".repeat(40), "sourceBranch": "x", "targetBranch": "main", "pipeline": null, "notes": 0,
            "reasons": [], "files": [format!("src/f{n}.c")]});
        for (k, v) in extra.as_object().unwrap() {
            value[k] = v.clone();
        }
        value.as_object().cloned().unwrap()
    }

    fn store() -> (tempfile::TempDir, Arc<Mutex<MrStore>>) {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::current(), None);
        let path = crate::store::state_path(&context.data_root());
        (dir, Arc::new(Mutex::new(MrStore::open(context, path))))
    }

    fn settings(curation: bool, hints: &str) -> Settings<CurationSettings> {
        let hints = hints.to_owned();
        Arc::new(move || {
            let value = CurationSettings { curation, hints: hints.clone(), followed: 1, suggest_days: None };
            Box::pin(async move { value })
        })
    }

    type Asked = Arc<Mutex<Vec<(String, Value)>>>;

    fn recorder(answer: &'static str) -> (Asked, Arc<dyn RunModel>) {
        let asked: Asked = Arc::default();
        let log = asked.clone();
        let run = move |model: &str, _: &str, prompt: &str| {
            log.lock().unwrap().push((model.to_owned(), serde_json::from_str(prompt).unwrap()));
            Ok(ModelAnswer { text: answer.into(), cost_usd: None, ms: 1.0 })
        };
        (asked, Arc::new(run))
    }

    fn keys(prompt: &Value) -> Vec<String> {
        prompt["candidates"].as_array().unwrap().iter().map(|c| js::sv(c.get("key")).to_owned()).collect()
    }

    #[test]
    fn rankings_only_given_keys_a_reason_for_each_pick_few_picks() {
        let keys: Vec<String> = ["k1", "k2", "k3"].map(String::from).to_vec();
        let text = r#"Here: [{"key":"k1","pick":true,"score":90,"reason":"touches src/f1.c you changed"},{"key":"k2","pick":true,"score":50,"reason":""},{"key":"zz","pick":true,"score":99,"reason":"not a candidate"},{"key":"k3","pick":false,"score":10,"reason":""}]"#;
        assert_eq!(
            parse_ranking(text, &keys).unwrap().iter().map(Ranking::to_json).collect::<Vec<_>>(),
            vec![
                json!({"key": "k1", "pick": true, "score": 90, "reason": "touches src/f1.c you changed"}),
                json!({"key": "k2", "pick": false, "score": 50, "reason": ""}),
                json!({"key": "k3", "pick": false, "score": 10, "reason": ""}),
            ]
        );
        assert!(parse_ranking("no json", &keys).is_err());
    }

    #[test]
    fn top_paths_count_files_and_their_directories() {
        let files: Vec<String> = ["a/b.c", "a/b.c", "a/d.c"].map(String::from).to_vec();
        assert_eq!(top_paths(&files, 60), [("a/".into(), 3), ("a/b.c".into(), 2), ("a/d.c".into(), 1)]);
    }

    #[tokio::test]
    async fn a_batch_the_users_own_requests_and_dismissed_ones_are_no_candidates() {
        let (_dir, store) = store();
        store
            .lock()
            .unwrap()
            .update(|state| {
                state["feedback"].as_array_mut().unwrap().push(json!({"key": "k3", "verdict": "not_interested", "at": "t",
                    "title": "MR 3", "project": "g/p", "author": "alice", "files": []}));
            })
            .unwrap();
        let (asked, run) = recorder(r#"[{"key":"k1","pick":true,"score":80,"reason":"touches src/f1.c"}]"#);
        let mut curation = Curation::new(store.clone(), settings(true, "I maintain GES"), run);
        curation.users = Some(Arc::new(|| HashMap::from([("h".to_owned(), "me".to_owned())])));
        let items = vec![item(1, json!({})), item(2, json!({"author": "Me"})), item(3, json!({})), item(4, json!({"reasons": ["assigned"]}))];
        curation.maybe_run(&items, true).await;
        {
            let asked = asked.lock().unwrap();
            assert_eq!(asked.len(), 1);
            assert_eq!(asked[0].0, CURATION_MODEL);
            assert_eq!(keys(&asked[0].1), ["k1"]);
            assert_eq!(asked[0].1["reviewer"]["hints"], json!("I maintain GES"));
            assert_eq!(asked[0].1["reviewer"]["feedback"][0]["verdict"], json!("not_interested"));
        }
        let ranked = store.lock().unwrap().get()["ranked"]["k1"].clone();
        assert_eq!((ranked["pick"].clone(), ranked["reason"].clone()), (json!(true), json!("touches src/f1.c")));
        let commented: Vec<Obj> = items
            .iter()
            .map(|i| {
                let mut i = i.clone();
                if i["key"] == json!("k1") {
                    i.insert("updatedAt".into(), json!(js::iso(js::now_ms())));
                }
                i
            })
            .collect();
        curation.maybe_run(&commented, true).await;
        assert_eq!(asked.lock().unwrap().len(), 1);
        let pushed: Vec<Obj> = commented
            .iter()
            .map(|i| {
                let mut i = i.clone();
                if i["key"] == json!("k1") {
                    i.insert("headSha".into(), json!("b".repeat(40)));
                }
                i
            })
            .collect();
        curation.maybe_run(&pushed, true).await;
        assert_eq!(asked.lock().unwrap().len(), 2);
        assert_eq!(keys(&asked.lock().unwrap()[1].1), ["k1"]);
        let mut more = pushed.clone();
        more.push(item(5, json!({})));
        curation.maybe_run(&more, false).await;
        assert_eq!(asked.lock().unwrap().len(), 2);
        let old = item(6, json!({"updatedAt": js::iso(js::now_ms() - 90.0 * 86_400_000.0)}));
        curation.maybe_run(&[old, item(7, json!({}))], true).await;
        assert_eq!(keys(&asked.lock().unwrap().last().unwrap().1), ["k7"]);
    }

    #[test]
    fn a_ranking_saved_before_the_head_and_title_stamp_holds_at_its_updated_at() {
        let one = item(1, json!({}));
        let ranked = json!({"updatedAt": one["updatedAt"], "pick": false, "score": 10, "reason": "", "at": "t"});
        assert!(ranked_current(Some(&ranked), &one));
        let mut later = one.clone();
        later.insert("updatedAt".into(), json!("2099-01-01T00:00:00Z"));
        assert!(!ranked_current(Some(&ranked), &later));
        assert!(!ranked_current(None, &one));
        let mut agent = ranked.clone();
        agent["by"] = json!("agent");
        agent["version"] = json!("old");
        let mut pushed = one.clone();
        pushed.insert("headSha".into(), json!("c".repeat(40)));
        assert!(ranked_current(Some(&agent), &pushed));
    }

    #[tokio::test]
    async fn unstamped_rankings_and_the_agents_picks_are_not_ranked_again() {
        let (_dir, store) = store();
        let items = vec![item(1, json!({})), item(2, json!({})), item(3, json!({}))];
        let first_updated = items[0]["updatedAt"].clone();
        store
            .lock()
            .unwrap()
            .update(|state| {
                state["ranked"]["k1"] = json!({"updatedAt": first_updated, "pick": true, "score": 70, "reason": "old pick", "at": "t"});
                state["ranked"]["k2"] = json!({"updatedAt": "2000-01-01T00:00:00Z", "version": "old", "pick": true, "score": 90,
                    "reason": "asked in the chat", "at": "t", "by": "agent"});
            })
            .unwrap();
        let (asked, run) = recorder("[]");
        let curation = Curation::new(store.clone(), settings(true, ""), run);
        curation.maybe_run(&items, true).await;
        assert_eq!(asked.lock().unwrap().iter().map(|(_, p)| keys(p)).collect::<Vec<_>>(), [vec!["k3".to_owned()]]);
        assert_eq!(store.lock().unwrap().get()["ranked"]["k1"]["reason"], json!("old pick"));
        assert_eq!(store.lock().unwrap().get()["ranked"]["k2"]["by"], json!("agent"));
    }

    #[tokio::test]
    async fn off_nothing_is_asked() {
        let (_dir, store) = store();
        let (asked, run) = recorder("[]");
        let curation = Curation::new(store, settings(false, ""), run);
        curation.maybe_run(&[item(1, json!({}))], true).await;
        assert!(asked.lock().unwrap().is_empty());
        assert_eq!(curation.state()["state"], json!("off"));
    }
}

//! connections/tab-auto-rename.ts: a tab whose label is still its default
//! takes the title of its agent's session (the focused agent pane's, else
//! the first agent pane's), until someone renames it by hand. Evaluations
//! run one at a time; a lookup that outlives a change (a manual rename,
//! the setting, focus, the label, the tab) is dropped.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_herdr::control::{BeforeSend, HerdrClient};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::BoxFuture;
use crate::agent_status::herdr_event_name;
use roamgate_base::settings::js_trim;

/// A shell prompt, a shell or an agent's own binary: not a title worth a tab.
pub fn is_generic_terminal_title(raw: &str) -> bool {
    static PROMPT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:?\s*[^\n\r\x{2028}\x{2029}]*$").unwrap()
    });
    static BINARY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(bash|zsh|sh|fish|csh|tcsh|dash|tmux|screen|agy|antigravity|claude|hermes|codex|pi|omp|kimi|grok|gemini|opencode|cursor)(?:\s+--?\S[^\n\r\x{2028}\x{2029}]*)?$",
        )
        .unwrap()
    });
    js_trim(raw).is_empty() || PROMPT.is_match(raw) || BINARY.is_match(raw)
}

/// What the renamer asks of Herdr.
pub trait TabHerdr: Send + Sync {
    fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> BoxFuture<Result<Value, String>>;
}

impl TabHerdr for HerdrClient {
    fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> BoxFuture<Result<Value, String>> {
        let client = self.clone();
        let method = method.to_owned();
        Box::pin(async move {
            HerdrClient::call(&client, &method, params, timeout_ms, before_send, false).await
        })
    }
}

/// A pane's agent title, given the pane as Herdr listed it.
pub type TitleFor = Arc<dyn Fn(String, Value) -> BoxFuture<Option<String>> + Send + Sync>;
/// Where its failures are told.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;
/// Whether the setting lets it rename.
pub type Enabled = Arc<dyn Fn() -> BoxFuture<bool> + Send + Sync>;

pub struct TabAutoRenamerOptions {
    pub herdr: Arc<dyn TabHerdr>,
    pub title_for_pane: TitleFor,
    pub enabled: Option<Enabled>,
    pub debounce: Option<Duration>,
    pub poll_interval: Option<Duration>,
    pub log: Option<LogSink>,
}

type Work = Shared<BoxFuture<()>>;

#[derive(Default)]
struct State {
    manual: HashSet<String>,
    applied: HashMap<String, String>,
    pending: HashMap<String, String>,
    disposed: bool,
    started: bool,
    revision: u64,
    queued: bool,
    work: Option<Work>,
    debounce: Option<JoinHandle<()>>,
    poll: Option<JoinHandle<()>>,
}

struct Inner {
    options: TabAutoRenamerOptions,
    state: Mutex<State>,
}

/// The renamer of one connection (`createTabAutoRenamer`).
#[derive(Clone)]
pub struct TabAutoRenamer {
    inner: Arc<Inner>,
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

/// The tab's agent pane: the focused one, else the first.
fn agent_pane<'a>(panes: &'a [Value], tab_id: &str) -> Option<&'a Value> {
    let candidates: Vec<&Value> = panes
        .iter()
        .filter(|pane| text(pane.get("tab_id")) == tab_id && truthy(pane.get("agent")))
        .collect();
    candidates
        .iter()
        .find(|pane| truthy(pane.get("focused")))
        .or(candidates.first())
        .copied()
}

fn default_label(tab: &Value) -> bool {
    let label = text(tab.get("label"));
    if label.is_empty() {
        return true;
    }
    let Some(number) = tab.get("number").and_then(Value::as_f64) else {
        return false;
    };
    if number.fract() != 0.0 || number <= 0.0 {
        return false;
    }
    let number = number as i64;
    label == number.to_string() || label == format!("Tab {number}")
}

fn numbered_default(label: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:Tab )?[1-9][0-9]*$").unwrap());
    RE.is_match(label)
}

impl State {
    fn owns(&mut self, tab: &Value) -> bool {
        let tab_id = text(tab.get("tab_id"));
        if self.manual.contains(tab_id) {
            return false;
        }
        match self.applied.get(tab_id) {
            None => default_label(tab),
            Some(previous) if previous == text(tab.get("label")) => true,
            Some(_) => {
                self.manual.insert(tab_id.to_owned());
                false
            }
        }
    }
}

impl TabAutoRenamer {
    pub fn new(options: TabAutoRenamerOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State::default()),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self, expected: u64) -> bool {
        let state = self.lock();
        !state.disposed && state.revision == expected
    }

    async fn enabled(&self) -> bool {
        match &self.inner.options.enabled {
            Some(enabled) => enabled().await,
            None => true,
        }
    }

    async fn snapshot(&self) -> Result<(Vec<Value>, Vec<Value>), String> {
        let herdr = &self.inner.options.herdr;
        let (tabs, panes) = tokio::join!(
            herdr.call("tab.list", json!({}), 5000, None),
            herdr.call("pane.list", json!({}), 5000, None),
        );
        let list = |value: Value, key: &str| -> Vec<Value> {
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter(|each| each.is_object())
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok((list(tabs?, "tabs"), list(panes?, "panes")))
    }

    async fn evaluate(&self) -> Result<(), String> {
        let expected = self.lock().revision;
        if !self.enabled().await || !self.current(expected) {
            return Ok(());
        }
        let (tabs, panes) = self.snapshot().await?;
        for tab in &tabs {
            if !self.current(expected) {
                return Ok(());
            }
            let tab_id = text(tab.get("tab_id")).to_owned();
            if tab_id.is_empty() || !self.lock().owns(tab) {
                continue;
            }
            let Some(pane) = agent_pane(&panes, &tab_id) else {
                continue;
            };
            let pane_id = pane.get("pane_id").cloned();
            let agent = pane.get("agent").cloned();
            let title = (self.inner.options.title_for_pane)(
                text(pane.get("pane_id")).to_owned(),
                pane.clone(),
            )
            .await
            .map(|title| js_trim(&title).to_owned())
            .filter(|title| !title.is_empty());
            let Some(title) = title else {
                continue;
            };
            if !self.current(expected) {
                continue;
            }
            // Re-read labels and focus after slow disk or SSH reads: other
            // clients can edit them.
            let (latest_tabs, latest_panes) = self.snapshot().await?;
            let live = latest_tabs
                .iter()
                .find(|each| text(each.get("tab_id")) == tab_id);
            let active = agent_pane(&latest_panes, &tab_id);
            let Some(live) = live else {
                continue;
            };
            if !self.lock().owns(live)
                || active.and_then(|active| active.get("pane_id")).cloned() != pane_id
                || active.and_then(|active| active.get("agent")).cloned() != agent
                || text(live.get("label")) == title
            {
                continue;
            }
            if !self.enabled().await
                || !self.current(expected)
                || self.lock().manual.contains(&tab_id)
            {
                continue;
            }
            self.lock().pending.insert(tab_id.clone(), title.clone());
            let guard = {
                let renamer = self.clone();
                let tab_id = tab_id.clone();
                Box::new(move || {
                    if !renamer.current(expected) || renamer.lock().manual.contains(&tab_id) {
                        return Err("Tab auto-rename cancelled".to_owned());
                    }
                    Ok(())
                }) as BeforeSend
            };
            let renamed = self
                .inner
                .options
                .herdr
                .call(
                    "tab.rename",
                    json!({"tab_id": tab_id, "label": title}),
                    5000,
                    Some(guard),
                )
                .await;
            let mut state = self.lock();
            // A failed RPC must remain retryable, and a manual rename must
            // keep ownership.
            if renamed.is_ok()
                && !state.disposed
                && !state.manual.contains(&tab_id)
                && state.pending.get(&tab_id) == Some(&title)
            {
                state.applied.insert(tab_id.clone(), title.clone());
            }
            state.pending.remove(&tab_id);
            drop(state);
            renamed?;
        }
        Ok(())
    }

    /// Runs an evaluation, after the one running if any; every caller
    /// meanwhile shares it.
    pub fn trigger_evaluation(&self) -> Shared<BoxFuture<()>> {
        let mut state = self.lock();
        if state.disposed {
            return futures_util::future::ready(()).boxed().shared();
        }
        state.queued = true;
        if let Some(work) = &state.work {
            return work.clone();
        }
        let renamer = self.clone();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                {
                    let mut state = renamer.lock();
                    if !state.queued || state.disposed {
                        state.work = None;
                        break;
                    }
                    state.queued = false;
                }
                if let Err(error) = renamer.evaluate().await
                    && let Some(log) = &renamer.inner.options.log
                {
                    log(&format!("Tab auto-renamer: Error: {error}"));
                }
            }
            let _ = done_tx.send(());
        });
        let work: Work = async move {
            let _ = done_rx.await;
        }
        .boxed()
        .shared();
        state.work = Some(work.clone());
        work
    }

    fn schedule(&self) {
        let mut state = self.lock();
        if !state.started || state.disposed {
            return;
        }
        if let Some(timer) = state.debounce.take() {
            timer.abort();
        }
        let delay = self
            .inner
            .options
            .debounce
            .unwrap_or(Duration::from_millis(500));
        let renamer = self.clone();
        state.debounce = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            renamer.lock().debounce = None;
            renamer.trigger_evaluation().await;
        }));
    }

    pub fn start(&self) {
        {
            let mut state = self.lock();
            if state.started || state.disposed {
                return;
            }
            state.started = true;
            if let Some(interval) = self.inner.options.poll_interval {
                let renamer = self.clone();
                state.poll = Some(tokio::spawn(async move {
                    let mut ticks =
                        tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
                    loop {
                        ticks.tick().await;
                        renamer.schedule();
                    }
                }));
            }
        }
        self.schedule();
    }

    pub fn settings_changed(&self) {
        self.lock().revision += 1;
        self.schedule();
    }

    pub fn mark_manual_rename(&self, tab_id: &str, label: Option<&str>) {
        let mut state = self.lock();
        // The GUI assigns new tabs a default "Tab N" label through tab.rename.
        if let Some(label) = label
            && !label.is_empty()
            && numbered_default(label)
            && !state.applied.contains_key(tab_id)
            && !state.pending.contains_key(tab_id)
        {
            return;
        }
        if !tab_id.is_empty() {
            state.manual.insert(tab_id.to_owned());
        }
    }

    pub fn is_manually_renamed(&self, tab_id: &str) -> bool {
        self.lock().manual.contains(tab_id)
    }

    pub fn handle_herdr_event(&self, event: &Value) {
        if !event.is_object() {
            return;
        }
        let kind = herdr_event_name(event)
            .unwrap_or_default()
            .replace('.', "_");
        let data = event
            .get("data")
            .filter(|data| data.is_object())
            .unwrap_or(event);
        let tab = data
            .get("tab")
            .filter(|tab| tab.is_object())
            .unwrap_or(data);
        let tab_id = text(tab.get("tab_id")).to_owned();
        {
            let mut state = self.lock();
            if kind == "tab_renamed" {
                let label = text(tab.get("label"));
                if !label.is_empty()
                    && (state.pending.get(&tab_id).map(String::as_str) == Some(label)
                        || state.applied.get(&tab_id).map(String::as_str) == Some(label))
                {
                    return;
                }
                if !tab_id.is_empty()
                    && !label.is_empty()
                    && (state.applied.contains_key(&tab_id)
                        || state.pending.contains_key(&tab_id)
                        || !numbered_default(label))
                {
                    state.manual.insert(tab_id.clone());
                }
            }
            if kind == "tab_closed" {
                state.manual.remove(&tab_id);
                state.applied.remove(&tab_id);
                state.pending.remove(&tab_id);
            }
        }
        if kind.starts_with("pane_")
            || kind.starts_with("tab_")
            || kind.starts_with("workspace_")
            || kind == "session_resync_required"
        {
            self.settings_changed();
        }
    }

    pub fn dispose(&self) {
        let mut state = self.lock();
        state.disposed = true;
        state.revision += 1;
        if let Some(timer) = state.debounce.take() {
            timer.abort();
        }
        if let Some(timer) = state.poll.take() {
            timer.abort();
        }
        state.manual.clear();
        state.applied.clear();
    }
}

#[cfg(test)]
mod tests;

//! `history-watch.ts`: pushes `agent_history.changed` to the browsers
//! watching a pane when its session file changes, for every agent kind;
//! they fetch their delta with `agent_history.get` and their cursor. Local
//! files are watched; a remote connection runs one stat helper for all its
//! watched files.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::files::BoxFut;

/// Stops a watch when called.
pub type WatchHandle = Box<dyn FnOnce() + Send>;
pub type OnChange = Arc<dyn Fn() + Send + Sync>;
/// A watch on a file (and its folder, for its recreation).
pub type WatchLocal = Arc<dyn Fn(&str, OnChange) -> WatchHandle + Send + Sync>;
/// One helper over every watched path on a host: a line per path per poll
/// (`path<TAB>signature`), then its exit.
pub type SpawnRemote = Arc<
    dyn Fn(Vec<String>, Arc<dyn Fn(&str) + Send + Sync>, OnChange) -> WatchHandle + Send + Sync,
>;
/// The pane's session file now, None when it has none.
pub type ResolvePath =
    Arc<dyn Fn(Value) -> BoxFut<'static, Result<Option<String>, String>> + Send + Sync>;
pub type SendEvent<W> = Arc<dyn Fn(&W, Value) + Send + Sync>;

pub struct HistoryWatcherOptions<W> {
    pub resolve_path: ResolvePath,
    pub send: SendEvent<W>,
    /// Local: the watch of a file; `watch_local_file` when None.
    pub watch_local: Option<WatchLocal>,
    /// Remote: set for a connection over SSH.
    pub spawn_remote: Option<SpawnRemote>,
    pub debounce: Duration,
    /// How often panes are resolved again (a /clear, a resumed session).
    pub reresolve: Duration,
    /// A remote helper restarts this long after the paths changed.
    pub restart: Duration,
}

impl<W> HistoryWatcherOptions<W> {
    pub fn new(resolve_path: ResolvePath, send: SendEvent<W>) -> Self {
        Self {
            resolve_path,
            send,
            watch_local: None,
            spawn_remote: None,
            debounce: Duration::from_millis(150),
            reresolve: Duration::from_secs(30),
            restart: Duration::from_millis(500),
        }
    }
}

/// How long a helper that exited waits before it runs again.
const HELPER_RETRY: Duration = Duration::from_secs(5);

/// A watch on a local file and its folder (the file's name only), as
/// Node's `fs.watch` gives them; nothing when they cannot be watched.
pub fn watch_local_file(path: &str, on_change: OnChange) -> WatchHandle {
    use notify::{RecursiveMode, Watcher};
    let path = Path::new(path).to_path_buf();
    let name = path.file_name().map(|n| n.to_owned());
    let mut watchers = Vec::new();
    let file_change = on_change.clone();
    if let Ok(mut watcher) =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok() {
                file_change();
            }
        })
        && watcher.watch(&path, RecursiveMode::NonRecursive).is_ok()
    {
        watchers.push(watcher);
    }
    if let Some(dir) = path.parent()
        && let Ok(mut watcher) =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event
                    && event.paths.iter().any(|p| p.file_name() == name.as_deref())
                {
                    on_change();
                }
            })
        && watcher.watch(dir, RecursiveMode::NonRecursive).is_ok()
    {
        watchers.push(watcher);
    }
    Box::new(move || drop(watchers))
}

/// The session file an `agent_history.get` result read, if it says.
pub fn history_file_path(result: &Value) -> Option<String> {
    if let Some(file) = result.get("file").filter(|f| f.is_object())
        && let Some(Value::String(path)) = file.get("path")
    {
        return (!path.is_empty()).then(|| path.clone());
    }
    match result.get("path") {
        Some(Value::String(path)) if !path.is_empty() => Some(path.clone()),
        _ => None,
    }
}

struct Pane<W> {
    /// This pane's identity: a pane dropped and subscribed again is another.
    id: u64,
    params: Value,
    path: Option<String>,
    watchers: Vec<W>,
    handle: Option<WatchHandle>,
    timer: Option<JoinHandle<()>>,
}

struct State<W> {
    panes: Vec<(String, Pane<W>)>,
    next_id: u64,
    reresolve: Option<JoinHandle<()>>,
    remote: Option<(u64, WatchHandle)>,
    remote_ids: u64,
    remote_paths: String,
    restart: Option<JoinHandle<()>>,
    signatures: HashMap<String, String>,
    disposed: bool,
}

impl<W> State<W> {
    fn pane(&mut self, pane_id: &str) -> Option<&mut Pane<W>> {
        self.panes
            .iter_mut()
            .find(|(id, _)| id == pane_id)
            .map(|(_, p)| p)
    }
}

struct Inner<W> {
    options: HistoryWatcherOptions<W>,
    state: Mutex<State<W>>,
}

/// One per connection.
pub struct HistoryWatcher<W> {
    inner: Arc<Inner<W>>,
}

impl<W: Clone + PartialEq + Send + Sync + 'static> HistoryWatcher<W> {
    pub fn new(options: HistoryWatcherOptions<W>) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State {
                    panes: Vec::new(),
                    next_id: 0,
                    reresolve: None,
                    remote: None,
                    remote_ids: 0,
                    remote_paths: String::new(),
                    restart: None,
                    signatures: HashMap::new(),
                    disposed: false,
                }),
            }),
        }
    }

    /// `agent_history.subscribe`: `{pane_id, path}`.
    pub async fn subscribe(&self, ws: W, params: &Value) -> Result<Value, String> {
        let pane_id = match params.get("pane_id") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => crate::js::to_text(other),
        };
        if pane_id.is_empty() {
            return Err("pane_id is required".into());
        }
        let created = {
            let mut state = self.inner.state.lock().unwrap();
            if let Some(pane) = state.pane(&pane_id) {
                if !pane.watchers.contains(&ws) {
                    pane.watchers.push(ws);
                }
                None
            } else {
                state.next_id += 1;
                let id = state.next_id;
                state.panes.push((
                    pane_id.clone(),
                    Pane {
                        id,
                        params: params.clone(),
                        path: None,
                        watchers: vec![ws],
                        handle: None,
                        timer: None,
                    },
                ));
                Some(id)
            }
        };
        if let Some(id) = created {
            Inner::ensure_reresolve(&self.inner);
            Inner::resolve(&self.inner, &pane_id, id).await;
        }
        let path = self
            .inner
            .state
            .lock()
            .unwrap()
            .pane(&pane_id)
            .and_then(|p| p.path.clone());
        Ok(json!({ "pane_id": pane_id, "path": path }))
    }

    /// `agent_history.unsubscribe`.
    pub fn unsubscribe(&self, ws: &W, pane_id: &str) {
        let empty = {
            let mut state = self.inner.state.lock().unwrap();
            let Some(pane) = state.pane(pane_id) else {
                return;
            };
            pane.watchers.retain(|w| w != ws);
            pane.watchers.is_empty()
        };
        if empty {
            Inner::drop_pane(&self.inner, pane_id);
        }
    }

    /// A browser socket closed.
    pub fn cleanup_ws(&self, ws: &W) {
        let emptied: Vec<String> = {
            let mut state = self.inner.state.lock().unwrap();
            state
                .panes
                .iter_mut()
                .filter_map(|(id, pane)| {
                    pane.watchers.retain(|w| w != ws);
                    pane.watchers.is_empty().then(|| id.clone())
                })
                .collect()
        };
        for pane_id in emptied {
            Inner::drop_pane(&self.inner, &pane_id);
        }
    }

    /// The file a history read just resolved for the pane: when it is not
    /// the watched one (the pane moved to another session), watch it now.
    pub fn note_path(&self, pane_id: &str, path: Option<&str>) {
        let Some(path) = path else { return };
        {
            let mut state = self.inner.state.lock().unwrap();
            let Some(pane) = state.pane(pane_id) else {
                return;
            };
            if pane.path.as_deref() == Some(path) {
                return;
            }
            pane.path = Some(path.to_owned());
        }
        Inner::watch_pane(&self.inner, pane_id);
        Inner::changed(&self.inner, pane_id);
    }

    /// Resolve a pane again now (its session moved: a handover, /clear).
    pub fn refresh(&self, pane_id: &str) {
        let id = self.inner.state.lock().unwrap().pane(pane_id).map(|p| p.id);
        if let Some(id) = id {
            let inner = self.inner.clone();
            let pane_id = pane_id.to_owned();
            tokio::spawn(async move { Inner::resolve(&inner, &pane_id, id).await });
        }
    }

    pub fn dispose(&self) {
        let panes: Vec<String> = {
            let mut state = self.inner.state.lock().unwrap();
            state.disposed = true;
            state.panes.iter().map(|(id, _)| id.clone()).collect()
        };
        for pane_id in panes {
            Inner::drop_pane(&self.inner, &pane_id);
        }
        let mut state = self.inner.state.lock().unwrap();
        if let Some(timer) = state.restart.take() {
            timer.abort();
        }
        if let Some((_, close)) = state.remote.take() {
            close();
        }
    }
}

impl<W> Drop for HistoryWatcher<W> {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().unwrap();
        state.disposed = true;
        for timer in [state.reresolve.take(), state.restart.take()]
            .into_iter()
            .flatten()
        {
            timer.abort();
        }
    }
}

impl<W: Clone + PartialEq + Send + Sync + 'static> Inner<W> {
    fn changed(this: &Arc<Self>, pane_id: &str) {
        let mut state = this.state.lock().unwrap();
        let Some(pane) = state.pane(pane_id) else {
            return;
        };
        if pane.path.is_none() || pane.timer.is_some() {
            return;
        }
        let id = pane.id;
        let weak = Arc::downgrade(this);
        // The deadline is taken now, not when the task first runs.
        let due = tokio::time::Instant::now() + this.options.debounce;
        let pane_key = pane_id.to_owned();
        pane.timer = Some(tokio::spawn(async move {
            tokio::time::sleep_until(due).await;
            let Some(this) = weak.upgrade() else { return };
            let sends = {
                let mut state = this.state.lock().unwrap();
                let Some(pane) = state.pane(&pane_key).filter(|p| p.id == id) else {
                    return;
                };
                pane.timer = None;
                let Some(path) = pane.path.clone() else {
                    return;
                };
                let event = json!({ "event": "agent_history.changed", "data": { "pane_id": pane_key, "path": path } });
                pane.watchers
                    .iter()
                    .map(|w| (w.clone(), event.clone()))
                    .collect::<Vec<_>>()
            };
            for (ws, event) in sends {
                (this.options.send)(&ws, event);
            }
        }));
    }

    fn watched_paths(state: &State<W>) -> Vec<String> {
        let mut paths: Vec<String> = state
            .panes
            .iter()
            .filter_map(|(_, p)| p.path.clone())
            .collect();
        paths.sort();
        paths.dedup();
        paths
    }

    fn on_remote_line(this: &Arc<Self>, line: &str) {
        let Some(tab) = line.find('\t') else { return };
        let (path, signature) = (&line[..tab], &line[tab + 1..]);
        let panes: Vec<String> = {
            let mut state = this.state.lock().unwrap();
            let before = state
                .signatures
                .insert(path.to_owned(), signature.to_owned());
            if before.is_none() || before.as_deref() == Some(signature) {
                return;
            }
            state
                .panes
                .iter()
                .filter(|(_, p)| p.path.as_deref() == Some(path))
                .map(|(id, _)| id.clone())
                .collect()
        };
        for pane_id in panes {
            Self::changed(this, &pane_id);
        }
    }

    fn restart_remote(this: &Arc<Self>) {
        let Some(spawn) = this.options.spawn_remote.clone() else {
            return;
        };
        let mut state = this.state.lock().unwrap();
        if state.disposed {
            return;
        }
        if let Some(timer) = state.restart.take() {
            timer.abort();
        }
        let weak = Arc::downgrade(this);
        let due = tokio::time::Instant::now() + this.options.restart;
        state.restart = Some(tokio::spawn(async move {
            tokio::time::sleep_until(due).await;
            let Some(this) = weak.upgrade() else { return };
            Self::run_remote(&this, spawn);
        }));
    }

    fn run_remote(this: &Arc<Self>, spawn: SpawnRemote) {
        let mut state = this.state.lock().unwrap();
        state.restart = None;
        let paths = Self::watched_paths(&state);
        let key = paths.join("\n");
        if key == state.remote_paths && state.remote.is_some() {
            return;
        }
        if let Some((_, close)) = state.remote.take() {
            close();
        }
        state.remote_paths = key;
        state.signatures.retain(|path, _| paths.contains(path));
        if paths.is_empty() {
            return;
        }
        state.remote_ids += 1;
        let id = state.remote_ids;
        drop(state);
        let lines: Weak<Self> = Arc::downgrade(this);
        let exits: Weak<Self> = Arc::downgrade(this);
        let on_line: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
            if let Some(this) = lines.upgrade() {
                Self::on_remote_line(&this, line);
            }
        });
        let on_exit: OnChange = Arc::new(move || {
            let Some(this) = exits.upgrade() else { return };
            let mut state = this.state.lock().unwrap();
            if state.remote.as_ref().map(|(r, _)| *r) != Some(id) {
                return;
            }
            state.remote = None;
            tracing::info!(
                scope = "agent.history",
                "history watch helper exited; restarting"
            );
            let weak = Arc::downgrade(&this);
            let due = tokio::time::Instant::now() + HELPER_RETRY;
            state.restart = Some(tokio::spawn(async move {
                tokio::time::sleep_until(due).await;
                if let Some(this) = weak.upgrade() {
                    Self::restart_remote(&this);
                }
            }));
        });
        let handle = spawn(paths, on_line, on_exit);
        this.state.lock().unwrap().remote = Some((id, handle));
    }

    fn watch_pane(this: &Arc<Self>, pane_id: &str) {
        let remote = this.options.spawn_remote.is_some();
        let path = {
            let mut state = this.state.lock().unwrap();
            let Some(pane) = state.pane(pane_id) else {
                return;
            };
            if let Some(close) = pane.handle.take() {
                close();
            }
            pane.path.clone()
        };
        if let Some(path) = path.filter(|_| !remote) {
            let weak = Arc::downgrade(this);
            let key = pane_id.to_owned();
            let on_change: OnChange = Arc::new(move || {
                if let Some(this) = weak.upgrade() {
                    Self::changed(&this, &key);
                }
            });
            let handle = match &this.options.watch_local {
                Some(watch) => watch(&path, on_change),
                None => watch_local_file(&path, on_change),
            };
            let mut state = this.state.lock().unwrap();
            match state.pane(pane_id) {
                Some(pane) => pane.handle = Some(handle),
                None => handle(),
            }
        }
        if remote {
            Self::restart_remote(this);
        }
    }

    async fn resolve(this: &Arc<Self>, pane_id: &str, id: u64) {
        let params = {
            let mut state = this.state.lock().unwrap();
            match state.pane(pane_id).filter(|p| p.id == id) {
                Some(pane) => pane.params.clone(),
                None => return,
            }
        };
        let path = (this.options.resolve_path)(params).await.ok().flatten();
        {
            let mut state = this.state.lock().unwrap();
            let Some(pane) = state.pane(pane_id).filter(|p| p.id == id) else {
                return;
            };
            if pane.path == path {
                return;
            }
            pane.path = path;
        }
        Self::watch_pane(this, pane_id);
        // Another file now: what the browser shows may be stale.
        Self::changed(this, pane_id);
    }

    fn ensure_reresolve(this: &Arc<Self>) {
        let mut state = this.state.lock().unwrap();
        if state.reresolve.is_some() || state.disposed {
            return;
        }
        let weak = Arc::downgrade(this);
        let every = this.options.reresolve;
        let first = tokio::time::Instant::now() + every;
        state.reresolve = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(first, every);
            loop {
                interval.tick().await;
                let Some(this) = weak.upgrade() else { return };
                let panes: Vec<(String, u64)> = this
                    .state
                    .lock()
                    .unwrap()
                    .panes
                    .iter()
                    .map(|(id, p)| (id.clone(), p.id))
                    .collect();
                for (pane_id, id) in panes {
                    let this = this.clone();
                    tokio::spawn(async move { Self::resolve(&this, &pane_id, id).await });
                }
            }
        }));
    }

    fn drop_pane(this: &Arc<Self>, pane_id: &str) {
        let remote = this.options.spawn_remote.is_some();
        {
            let mut state = this.state.lock().unwrap();
            let Some(at) = state.panes.iter().position(|(id, _)| id == pane_id) else {
                return;
            };
            let (_, mut pane) = state.panes.remove(at);
            if let Some(close) = pane.handle.take() {
                close();
            }
            if let Some(timer) = pane.timer.take() {
                timer.abort();
            }
            if state.panes.is_empty()
                && let Some(timer) = state.reresolve.take()
            {
                timer.abort();
            }
        }
        if remote {
            Self::restart_remote(this);
        }
    }
}

#[cfg(test)]
mod tests;

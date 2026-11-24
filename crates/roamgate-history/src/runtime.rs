//! Local history in the server (history/runtime.ts): the stores say what
//! they wrote, the areas changed are kept as dirty sets (an area whole, or
//! some of its ids), and a pass commits them 30 s after the last change, at
//! most 5 min after the first ([`Debounce`]). Work changes are rendered as
//! they happen and committed one each. The areas kept in files are also
//! watched by their size and modification time, so hand edits are kept
//! too. A full pass runs a minute after the start (anything written while
//! history was off, or a hook missed). Never on the event loop: a pass, a
//! status and the polls run on blocking threads, git in child processes
//! at a low priority, one pass at a time; the start pass and `git gc` wait
//! while a game runs (GameMode), for up to 24 h.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use roamgate_base::clock::SharedClock;
use serde_json::{Value, json};

use crate::area::HistoryArea;
use crate::place::{HistoryPlace, Reviews};
use crate::repo::{HistoryRepo, PassInput, PassResult, RepoStatus, WorkCommit};
use crate::work::{WorkChange, work_commit, work_description_of};

pub const HISTORY_QUIET_MS: u64 = 30_000;
pub const HISTORY_MAX_WAIT_MS: u64 = 5 * 60_000;
pub const HISTORY_POLL_MS: u64 = 30_000;
pub const HISTORY_START_DELAY_MS: u64 = 60_000;
/// A heavy pass waits this long at most for a game to end.
pub const HISTORY_DEFER_MAX_MS: i64 = 24 * 60 * 60_000;
pub const HISTORY_DEFER_RETRY_MS: u64 = 10 * 60_000;
/// At shutdown, the last pass gets this long.
pub const HISTORY_STOP_MS: u64 = 5_000;

#[derive(Default)]
struct DebounceState {
    first: Option<i64>,
    generation: u64,
}

/// Runs `run` `quiet_ms` after the last touch, and at most `max_ms` after
/// the first touch since it last ran.
#[derive(Clone)]
pub struct Debounce {
    state: Arc<Mutex<DebounceState>>,
    run: Arc<dyn Fn() + Send + Sync>,
    quiet_ms: u64,
    max_ms: u64,
    clock: SharedClock,
}

impl Debounce {
    pub fn new(
        run: Arc<dyn Fn() + Send + Sync>,
        quiet_ms: u64,
        max_ms: u64,
        clock: SharedClock,
    ) -> Self {
        Self {
            state: Arc::default(),
            run,
            quiet_ms,
            max_ms,
            clock,
        }
    }

    pub fn touch(&self) {
        let now = self.clock.now();
        let (generation, due) = {
            let mut state = self.state.lock().unwrap();
            let first = *state.first.get_or_insert(now);
            let due = (now + self.quiet_ms as i64).min(first + self.max_ms as i64);
            state.generation += 1;
            (state.generation, due)
        };
        let this = self.clone();
        tokio::spawn(async move {
            this.clock.sleep_until(due).await;
            if this.state.lock().unwrap().generation == generation {
                this.fire();
            }
        });
    }

    /// Runs now when something waits.
    pub fn flush(&self) {
        if self.pending() {
            self.fire();
        }
    }

    pub fn pending(&self) -> bool {
        self.state.lock().unwrap().first.is_some()
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        state.generation += 1;
        state.first = None;
    }

    fn fire(&self) {
        self.cancel();
        (self.run)();
    }
}

/// What a pass writes into: the repo (tests give a fake).
pub trait PassRepo: Send + Sync {
    fn dir(&self) -> &Path;
    fn pass(&self, input: &PassInput) -> Result<PassResult, String>;
    fn status(&self) -> RepoStatus;
}

impl PassRepo for HistoryRepo {
    fn dir(&self) -> &Path {
        &self.dir
    }
    fn pass(&self, input: &PassInput) -> Result<PassResult, String> {
        HistoryRepo::pass(self, input)
    }
    fn status(&self) -> RepoStatus {
        HistoryRepo::status(self)
    }
}

pub type GameMode = Arc<dyn Fn() -> BoxFuture<'static, Option<bool>> + Send + Sync>;
pub type MakeRepo = Arc<dyn Fn(&Path, &str) -> Arc<dyn PassRepo> + Send + Sync>;
pub type Warn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// What the runtime runs on.
pub struct RuntimeOptions {
    pub areas: Vec<Arc<dyn HistoryArea>>,
    /// Where the repo is and whether history is on, read before each pass
    /// (blocking: it reads settings.json).
    pub place: Arc<dyn Fn() -> Result<HistoryPlace, String> + Send + Sync>,
    /// The review store, for a Work item's description as it is changed.
    pub reviews: Reviews,
    pub host: String,
    /// The login of this machine's user (the user's Work commits).
    pub user: String,
    /// Whether a game runs (GameMode); None when it cannot tell.
    pub game_mode: Option<GameMode>,
    pub clock: SharedClock,
    pub warn: Warn,
    pub repo: Option<MakeRepo>,
    pub quiet_ms: u64,
    pub max_wait_ms: u64,
    pub poll_ms: u64,
    pub start_delay_ms: u64,
}

impl RuntimeOptions {
    /// The server's defaults around these areas, place and reviews.
    pub fn new(
        areas: Vec<Arc<dyn HistoryArea>>,
        place: Arc<dyn Fn() -> Result<HistoryPlace, String> + Send + Sync>,
        reviews: Reviews,
        clock: SharedClock,
    ) -> Self {
        Self {
            areas,
            place,
            reviews,
            host: crate::place::history_host(),
            user: crate::work::local_user(),
            game_mode: None,
            clock,
            warn: Arc::new(|message, fields| {
                tracing::warn!(scope = "history", %fields, "{message}");
            }),
            repo: None,
            quiet_ms: HISTORY_QUIET_MS,
            max_wait_ms: HISTORY_MAX_WAIT_MS,
            poll_ms: HISTORY_POLL_MS,
            start_delay_ms: HISTORY_START_DELAY_MS,
        }
    }
}

#[derive(Clone)]
enum Dirty {
    All,
    Ids(Vec<String>),
}

type Running = Shared<BoxFuture<'static, Option<PassResult>>>;

struct State {
    dirty: HashMap<String, Dirty>,
    work: Vec<WorkCommit>,
    running: Option<Running>,
    repo: Option<Arc<dyn PassRepo>>,
    signatures: HashMap<String, String>,
    /// The full pass waits for a game since then.
    deferred_since: Option<i64>,
    full_pending: bool,
    stopped: bool,
    polling: bool,
    /// Bumped by `stop`: the start and poll timers end.
    timers: u64,
}

struct Inner {
    options: RuntimeOptions,
    host: String,
    state: Mutex<State>,
    debounce: Debounce,
}

/// The local history of a server.
#[derive(Clone)]
pub struct HistoryRuntime(Arc<Inner>);

fn sanitized(host: &str) -> String {
    static UNSAFE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"[^A-Za-z0-9.-]+").unwrap());
    UNSAFE.replace_all(host, "-").into_owned()
}

impl HistoryRuntime {
    pub fn new(options: RuntimeOptions) -> Self {
        Self(Arc::new_cyclic(|weak: &Weak<Inner>| {
            let weak = weak.clone();
            let debounce = Debounce::new(
                Arc::new(move || {
                    if let Some(inner) = weak.upgrade() {
                        drop(HistoryRuntime(inner).run_pass(false, false));
                    }
                }),
                options.quiet_ms,
                options.max_wait_ms,
                options.clock.clone(),
            );
            Inner {
                host: sanitized(&options.host),
                options,
                state: Mutex::new(State {
                    dirty: HashMap::new(),
                    work: Vec::new(),
                    running: None,
                    repo: None,
                    signatures: HashMap::new(),
                    deferred_since: None,
                    full_pending: true,
                    stopped: false,
                    polling: false,
                    timers: 0,
                }),
                debounce,
            }
        }))
    }

    /// The commits' host.
    pub fn host(&self) -> &str {
        &self.0.host
    }

    /// Watches the files and plans the start pass.
    pub fn start(&self) {
        let generation = self.0.state.lock().unwrap().timers;
        let clock = self.0.options.clock.clone();
        let this = self.clone();
        let delay = self.0.options.start_delay_ms;
        tokio::spawn(async move {
            clock.sleep(Duration::from_millis(delay)).await;
            if this.timers_alive(generation) {
                drop(this.run_pass(true, false));
            }
        });
        let poll = self.0.options.poll_ms;
        if poll > 0 {
            let this = self.clone();
            let clock = self.0.options.clock.clone();
            tokio::spawn(async move {
                this.poll(true).await;
                loop {
                    clock.sleep(Duration::from_millis(poll)).await;
                    if !this.timers_alive(generation) {
                        return;
                    }
                    this.poll(false).await;
                }
            });
        }
    }

    fn timers_alive(&self, generation: u64) -> bool {
        let state = self.0.state.lock().unwrap();
        state.timers == generation && !state.stopped
    }

    /// Stops; the last changes are committed (a few seconds at most).
    pub async fn stop(&self) {
        let (waiting, running) = {
            let mut state = self.0.state.lock().unwrap();
            if state.stopped {
                return;
            }
            state.stopped = true;
            state.timers += 1;
            // Only into a repo a pass already wrote: a server stopped
            // before its start pass (a test's) makes none on its way out.
            let waiting =
                state.repo.is_some() && (self.0.debounce.pending() || !state.work.is_empty());
            (waiting, state.running.clone())
        };
        self.0.debounce.cancel();
        let this = self.clone();
        let last = tokio::spawn(async move {
            if let Some(running) = running {
                running.await;
            }
            if waiting {
                this.pass(false, true).await;
            }
        });
        let _ = roamgate_base::clock::timeout(
            self.0.options.clock.as_ref(),
            Duration::from_millis(HISTORY_STOP_MS),
            last,
        )
        .await;
    }

    /// An area's store wrote (`id`: one of its ids, else all of it).
    pub fn changed(&self, area: &str, id: Option<&str>) {
        if !self.0.options.areas.iter().any(|each| each.name() == area) {
            return;
        }
        let stopped = {
            let mut state = self.0.state.lock().unwrap();
            let current = state.dirty.get(area).cloned();
            let next = match (id, current) {
                (None, _) | (_, Some(Dirty::All)) => Dirty::All,
                (Some(id), Some(Dirty::Ids(mut ids))) => {
                    if !ids.iter().any(|each| each == id) {
                        ids.push(id.to_owned());
                    }
                    Dirty::Ids(ids)
                }
                (Some(id), None) => Dirty::Ids(vec![id.to_owned()]),
            };
            state.dirty.insert(area.to_owned(), next);
            state.stopped
        };
        if !stopped {
            self.0.debounce.touch();
        }
    }

    /// The item's description now (blocking: it reads the review store).
    pub fn description_of(&self, change: &WorkChange) -> Option<String> {
        let item = change.item.as_ref()?;
        let source = (self.0.options.reviews)();
        work_description_of(source.as_deref(), item)
    }

    /// A Work change, with its item's description when it was made.
    pub fn work_changed(&self, change: &WorkChange, description: Option<&str>) {
        let commit = work_commit(change, description, &self.0.host, &self.0.options.user);
        self.0.state.lock().unwrap().work.push(commit);
        // Projects and the store's history.jsonl come with the next batch.
        self.changed("work", Some(&change.id));
    }

    /// A pass now: every area (`roamgate history commit`, Settings).
    pub async fn commit_now(&self) -> Option<PassResult> {
        self.0.debounce.cancel();
        let running = self.0.state.lock().unwrap().running.clone();
        if let Some(running) = running {
            running.await;
        }
        self.run_pass(true, true).await
    }

    fn run_pass(&self, full: bool, force: bool) -> Running {
        let mut state = self.0.state.lock().unwrap();
        if let Some(running) = state.running.clone() {
            // One at a time: what is left goes with the next.
            if full {
                state.full_pending = true;
            }
            drop(state);
            self.0.debounce.touch();
            return running;
        }
        let this = self.clone();
        let run: Running = async move {
            let result = this.pass(full, force).await;
            this.0.state.lock().unwrap().running = None;
            result
        }
        .boxed()
        .shared();
        state.running = Some(run.clone());
        drop(state);
        // It runs whether or not anyone waits for it.
        tokio::spawn(run.clone());
        run
    }

    async fn place(&self) -> Result<HistoryPlace, String> {
        let place = self.0.options.place.clone();
        tokio::task::spawn_blocking(move || place())
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
    }

    async fn pass(&self, full: bool, force: bool) -> Option<PassResult> {
        let place = match self.place().await {
            Ok(place) => place,
            Err(error) => {
                (self.0.options.warn)("history pass failed", json!({"error": error}));
                return None;
            }
        };
        if !place.enabled {
            let mut state = self.0.state.lock().unwrap();
            state.dirty.clear();
            state.work.clear();
            return None;
        }
        let mut full = full;
        {
            let mut state = self.0.state.lock().unwrap();
            if state
                .repo
                .as_ref()
                .is_none_or(|repo| repo.dir() != place.location)
            {
                let repo: Arc<dyn PassRepo> = match &self.0.options.repo {
                    Some(make) => make(&place.location, &self.0.host),
                    None => Arc::new(HistoryRepo::new(
                        &place.location,
                        &self.0.host,
                        true,
                        Some(self.repo_clock()),
                    )),
                };
                state.repo = Some(repo);
                // A new place gets everything.
                state.full_pending = true;
            }
            full |= state.full_pending;
        }
        let gaming = match &self.0.options.game_mode {
            Some(game_mode) => game_mode().await == Some(true),
            None => false,
        };
        let now = self.0.options.clock.now();
        let (areas, work, dirty, repo) = {
            let mut state = self.0.state.lock().unwrap();
            if full && gaming && !force {
                let since = *state.deferred_since.get_or_insert(now);
                if now - since < HISTORY_DEFER_MAX_MS {
                    // The whole pass waits for the game; the changes since go now.
                    state.full_pending = true;
                    full = false;
                    drop(state);
                    self.retry_later(HISTORY_DEFER_RETRY_MS);
                    state = self.0.state.lock().unwrap();
                }
            }
            if full {
                state.deferred_since = None;
            }
            if !full && state.dirty.is_empty() && state.work.is_empty() {
                return None;
            }
            let dirty = std::mem::take(&mut state.dirty);
            let work = std::mem::take(&mut state.work);
            let areas: Vec<crate::repo::AreaIds> = self
                .0
                .options
                .areas
                .iter()
                .filter_map(|area| {
                    if full {
                        return Some((area.clone(), None));
                    }
                    match dirty.get(area.name())? {
                        Dirty::All => Some((area.clone(), None)),
                        Dirty::Ids(ids) => Some((area.clone(), Some(ids.clone()))),
                    }
                })
                .collect();
            (areas, work, dirty, state.repo.clone()?)
        };
        let input = PassInput {
            areas,
            work: work.clone(),
            light: gaming,
        };
        let result = match tokio::task::spawn_blocking(move || repo.pass(&input)).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                (self.0.options.warn)("history pass failed", json!({"error": error}));
                return None;
            }
            Err(error) => {
                (self.0.options.warn)("history pass failed", json!({"error": error.to_string()}));
                return None;
            }
        };
        if result.locked {
            // `roamgate history commit` runs: this one goes after it.
            {
                let mut state = self.0.state.lock().unwrap();
                for (name, marked) in dirty {
                    let current = state.dirty.get(&name).cloned();
                    let next = match (marked, current) {
                        (Dirty::All, _) | (_, Some(Dirty::All)) => Dirty::All,
                        (Dirty::Ids(mut ids), Some(Dirty::Ids(more))) => {
                            for id in more {
                                if !ids.contains(&id) {
                                    ids.push(id);
                                }
                            }
                            Dirty::Ids(ids)
                        }
                        (Dirty::Ids(ids), None) => Dirty::Ids(ids),
                    };
                    state.dirty.insert(name, next);
                }
                let later = std::mem::take(&mut state.work);
                state.work = work;
                state.work.extend(later);
                if full {
                    state.full_pending = true;
                }
            }
            self.retry_later(self.0.options.quiet_ms);
            return Some(result);
        }
        if full {
            self.0.state.lock().unwrap().full_pending = false;
        }
        for error in &result.errors {
            (self.0.options.warn)(
                "history: an area was not written",
                json!({"area": error.area, "error": error.message}),
            );
        }
        if !result.blocked.is_empty() {
            let files: BTreeSet<&str> =
                result.blocked.iter().map(|hit| hit.file.as_str()).collect();
            (self.0.options.warn)(
                "history: secrets kept out of the commit",
                json!({"files": files}),
            );
        }
        Some(result)
    }

    /// The runtime's clock for the repo's times (a test clock's in tests).
    fn repo_clock(&self) -> crate::repo::Now {
        let clock = self.0.options.clock.clone();
        Arc::new(move || clock.now())
    }

    fn retry_later(&self, ms: u64) {
        if self.0.state.lock().unwrap().stopped {
            return;
        }
        let this = self.clone();
        let clock = self.0.options.clock.clone();
        tokio::spawn(async move {
            clock.sleep(Duration::from_millis(ms)).await;
            let full = this.0.state.lock().unwrap().full_pending;
            drop(this.run_pass(full, false));
        });
    }

    /// The watched files' size and time: an area whose files moved is
    /// changed. `baseline`: only noted.
    pub async fn poll(&self, baseline: bool) {
        {
            let mut state = self.0.state.lock().unwrap();
            if state.polling {
                return;
            }
            state.polling = true;
        }
        let areas = self.0.options.areas.clone();
        let signatures = tokio::task::spawn_blocking(move || {
            areas
                .iter()
                .filter_map(|area| {
                    let paths = area.watch()?;
                    let parts: Vec<String> = paths
                        .iter()
                        .map(|path| match std::fs::metadata(path) {
                            Ok(info) => {
                                let modified = info
                                    .modified()
                                    .ok()
                                    .and_then(|time| {
                                        time.duration_since(std::time::UNIX_EPOCH).ok()
                                    })
                                    .map_or(0, |since| since.as_nanos());
                                format!("{}:{}:{modified}", path.display(), info.len())
                            }
                            Err(_) => format!("{}:-", path.display()),
                        })
                        .collect();
                    Some((area.name().to_owned(), parts.join("\n")))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut moved = Vec::new();
        {
            let mut state = self.0.state.lock().unwrap();
            for (name, signature) in signatures {
                let before = state.signatures.insert(name.clone(), signature.clone());
                if !baseline && before.is_some_and(|before| before != signature) {
                    moved.push(name);
                }
            }
            state.polling = false;
        }
        for name in moved {
            self.changed(&name, None);
        }
    }

    /// The status as Settings and the CLI show it (`HistoryStatus`).
    pub async fn status(&self) -> Result<Value, String> {
        let place = self.place().await?;
        let repo: Arc<dyn PassRepo> = {
            let state = self.0.state.lock().unwrap();
            match &state.repo {
                Some(repo) if repo.dir() == place.location => repo.clone(),
                _ => Arc::new(HistoryRepo::new(
                    &place.location,
                    &self.0.host,
                    false,
                    Some(self.repo_clock()),
                )),
            }
        };
        let status = tokio::task::spawn_blocking(move || repo.status())
            .await
            .map_err(|error| error.to_string())?;
        let state = self.0.state.lock().unwrap();
        let mut pending: BTreeSet<String> = state.dirty.keys().cloned().collect();
        if !state.work.is_empty() {
            pending.insert("work".into());
        }
        let mut pending: Vec<String> = pending.into_iter().collect();
        pending.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(status_value(
            &place,
            &status,
            pending,
            state.running.is_some(),
            state
                .deferred_since
                .map(|_| "a game is running (GameMode): the full pass waits for it".to_owned()),
        ))
    }
}

/// `HistoryStatus`, in Bun's key order.
pub fn status_value(
    place: &HistoryPlace,
    status: &RepoStatus,
    pending: Vec<String>,
    running: bool,
    deferred: Option<String>,
) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("enabled".into(), json!(place.enabled));
    out.insert("location".into(), json!(path_text(&place.location)));
    out.insert(
        "defaultLocation".into(),
        json!(path_text(&place.default_location)),
    );
    out.extend(status.fields());
    out.insert("pending".into(), json!(pending));
    out.insert("running".into(), json!(running));
    out.insert("deferred".into(), json!(deferred));
    Value::Object(out)
}

fn path_text(path: &Path) -> String {
    path.display().to_string()
}

/// The place as the server reads it before each pass: settings.json's
/// `history`, the data root, the environment.
pub fn server_place(
    settings: PathBuf,
    data: PathBuf,
    env: Arc<dyn roamgate_base::env::Env>,
    home: PathBuf,
) -> Arc<dyn Fn() -> Result<HistoryPlace, String> + Send + Sync> {
    Arc::new(move || {
        let raw = crate::files::read_json(&settings).ok().flatten();
        crate::place::history_place(raw.as_ref(), &data, env.as_ref(), &home)
    })
}

#[cfg(test)]
mod tests;

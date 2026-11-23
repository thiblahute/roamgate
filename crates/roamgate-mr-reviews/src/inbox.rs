//! The reviews inbox (`mr-reviews/inbox.ts`): the user's merge and pull
//! requests on each forge host (review requested, assigned, mentioned),
//! their own requests, and the open ones of the followed projects, read in
//! as few GraphQL queries per host and refresh as each host's complexity
//! limit allows, remembered across restarts in the store. Only reads.
//!
//! Requests are JavaScript objects, as Bun holds them; what the inbox
//! answers ([`MrInbox::snapshot`]) is Bun's `MrInbox`, key for key.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use roamgate_agents::js::{self, Obj};
use roamgate_base::log::{LogFields, Logger};
use roamgate_forge::complexity::{AskError, ComplexityGuard, Provider};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::AbortHandle;

use crate::agent_search::{github_request_query, gitlab_request_query, parse_request};
use crate::connection::BoxFuture;
use crate::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use crate::forge_ref::ForgeRef;
use crate::inference::{inference_outdated, row_facts};
use crate::lanes::assign_lanes;
use crate::overrides::override_outdated;
use crate::queries::{
    HostAnswer, InboxPart, OWN_DETAILS_BATCH, OWN_MAX_PAGES, github_inbox_query,
    github_own_list_query, gitlab_inbox_query, gitlab_own_list_query, inbox_parts,
    lesser_own_fields, merge_answers, own_details_query, own_list_parts, parse_github_inbox,
    parse_gitlab_inbox, parse_own_details, parse_own_list, unknown_field_error, with_own_details,
};
use crate::shared::merge::{MergeInput, merge_after_label, merge_info, rules_for};
use crate::shared::types::{activity_marker, forge_ref_key, project_key, seen_of, unread};
use crate::store::MrStore;

#[cfg(test)]
mod merge_tests;
#[cfg(test)]
pub(crate) mod own_forge;
#[cfg(test)]
mod own_tests;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

const MINUTE: f64 = 60_000.0;
/// Refresh period while someone looks at the inbox.
pub const WATCHED_REFRESH_MS: f64 = 5.0 * MINUTE;
/// Refresh period otherwise (prefetch and lifecycle need it).
pub const IDLE_REFRESH_MS: f64 = 15.0 * MINUTE;
/// A viewer is someone who asked within this.
const VIEWER_MS: f64 = 2.0 * MINUTE;
/// A refresh asked for is not made again sooner than this.
pub const FRESH_MIN_MS: f64 = MINUTE;
/// A GitLab draft count is read again after this, or sooner when the
/// request changed; only for requests reviewed in Roamgate (their review
/// reads them anyway while open).
pub const DRAFTS_TTL_MS: f64 = 60.0 * MINUTE;
/// Draft counts read per refresh, at most.
const DRAFTS_PER_REFRESH: usize = 10;
/// Pinned requests no list has, read per refresh at most (a call each).
const PINS_PER_REFRESH: usize = 20;
/// A pinned request that closed is read again after this.
const PIN_TTL_MS: f64 = 60.0 * MINUTE;
/// An open own request's details are read again after this even when it
/// did not change: what moves without touching it (its target branch, so
/// its conflicts) shows within it.
pub const OWN_DETAILS_TTL_MS: f64 = 60.0 * MINUTE;
/// Unchanged own requests read again for their age per refresh, at most.
const OWN_AGED_PER_REFRESH: usize = 10;
/// GitLab label-events reads per refresh and host, at most (section 15).
const LABEL_EVENTS_PER_REFRESH: usize = 20;
/// Own requests whose details are read per refresh and host, at most.
const OWN_DETAILS_PER_REFRESH: usize = 200;
/// setTimeout holds about 24 days at most; a later wake is set again.
const LONGEST_WAIT_MS: f64 = 20.0 * 24.0 * 60.0 * MINUTE;

fn pin_call() -> FetchCall {
    FetchCall::new("inbox", "pinned")
}
fn own_call() -> FetchCall {
    FetchCall::new("inbox", "own")
}
fn own_details_call() -> FetchCall {
    FetchCall::new("inbox", "own-details")
}

/// The page a request has on its forge, for a pin not read.
fn request_url(reference: &Value) -> String {
    let field = |name: &str| reference.get(name).map(js::to_text).unwrap_or_default();
    if field("provider") == "gitlab" {
        format!(
            "https://{}/{}/-/merge_requests/{}",
            field("host"),
            field("project"),
            field("number")
        )
    } else {
        format!(
            "https://{}/{}/pull/{}",
            field("host"),
            field("project"),
            field("number")
        )
    }
}

pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub(crate) fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn reasons_has(item: &Obj, reason: &str) -> bool {
    list(item.get("reasons")).iter().any(|r| r == reason)
}

pub(crate) fn key_of(item: &Obj) -> &str {
    js::sv(item.get("key"))
}

fn log_fields(pairs: Vec<(&str, Value)>) -> LogFields {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// A settings provider: the settings in effect (`MrReviewsSettings`).
pub type SettingsFn = Arc<dyn Fn() -> BoxFuture<'static, Obj> + Send + Sync>;
type Hook = Arc<dyn Fn() + Send + Sync>;
/// Branches headed upstream, for the settings (`deps.upstream`).
pub type UpstreamFn = Arc<dyn Fn(&Obj) -> Upstream + Send + Sync>;
/// The efforts' cards, for the settings (`deps.efforts`).
pub type EffortsFn = Arc<dyn Fn(&Obj) -> Vec<Value> + Send + Sync>;

/// Branches headed upstream (rows of their own) and the requests that
/// branches are (by key, the fields `fromBranch`, `local` and `effort`).
#[derive(Clone, Debug, Default)]
pub struct Upstream {
    pub rows: Vec<Obj>,
    pub covered: HashMap<String, Obj>,
}

/// What the inbox needs (`MrInboxDeps`).
#[derive(Clone)]
pub struct MrInboxDeps {
    pub fetchers: Arc<dyn InboxFetchers>,
    pub settings: SettingsFn,
    pub store: Arc<Mutex<MrStore>>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub logger: Logger,
    /// The inbox changed: browsers may ask again.
    pub on_change: Option<Hook>,
    /// The inference's state, for the settings.
    pub inference: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
    /// After each refresh: prefetch, lifecycle, curation. What it gives is
    /// waited for before the refresh ends (what Bun's hook settles before
    /// any I/O: the inference's decision).
    pub after_refresh: Option<AfterRefreshFn>,
    /// Curation's state, shown in the inbox.
    pub curation: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
    /// Branches headed upstream and the requests branches are, as last read.
    pub upstream: Option<UpstreamFn>,
    /// The efforts' cards.
    pub efforts: Option<EffortsFn>,
    /// Someone looks at the inbox: the branches may be read again.
    pub on_viewer: Option<Hook>,
    /// A scheduled merge became mergeable (section 15): the inference may run.
    pub on_merge_time: Option<Hook>,
    /// Waits until this time (epoch ms) of the clock `now` reads; None:
    /// tokio's timer, the system's time.
    pub sleep_until: Option<SleepUntilFn>,
}

/// After a refresh, with its requests.
pub type AfterRefreshFn = Arc<dyn Fn(Vec<Obj>) -> Option<BoxFuture<'static, ()>> + Send + Sync>;

/// Waits until a time, epoch ms.
pub type SleepUntilFn = Arc<dyn Fn(f64) -> BoxFuture<'static, ()> + Send + Sync>;

impl MrInboxDeps {
    /// The deps with the system time, a silent logger and no hooks.
    pub fn new(
        fetchers: Arc<dyn InboxFetchers>,
        settings: SettingsFn,
        store: Arc<Mutex<MrStore>>,
    ) -> MrInboxDeps {
        MrInboxDeps {
            fetchers,
            settings,
            store,
            now: Arc::new(js::now_ms),
            logger: Logger::silent(),
            on_change: None,
            inference: None,
            after_refresh: None,
            curation: None,
            upstream: None,
            efforts: None,
            on_viewer: None,
            on_merge_time: None,
            sleep_until: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Host<'a> {
    host: &'a str,
    provider: Provider,
}

impl Host<'_> {
    fn gitlab(&self) -> bool {
        self.provider == Provider::Gitlab
    }
    fn provider_name(&self) -> &'static str {
        if self.gitlab() { "gitlab" } else { "github" }
    }
}

#[derive(Clone, Debug)]
struct HostResult {
    state: Obj,
    answer: Option<HostAnswer>,
    /// The user's own requests; None when they could not be read.
    own: Option<Vec<Obj>>,
}

/// Why a guarded ask failed: a forge error, or the host refusing the
/// own-requests fields asked (ask the lesser ones).
#[derive(Clone, Debug)]
enum Failure {
    Fetch(FetchError),
    FieldsRefused,
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Failure::Fetch(error) => error.message(),
            Failure::FieldsRefused => "",
        }
    }
    fn into_fetch(self) -> FetchError {
        match self {
            Failure::Fetch(error) => error,
            Failure::FieldsRefused => FetchError::Failed(String::new()),
        }
    }
}

impl From<FetchError> for Failure {
    fn from(error: FetchError) -> Failure {
        Failure::Fetch(error)
    }
}

struct Timers {
    refresh: Option<AbortHandle>,
    wake: Option<AbortHandle>,
    wake_time: f64,
}

struct Inner {
    deps: MrInboxDeps,
    hosts: Mutex<HashMap<String, HostResult>>,
    /// Whether a refresh runs; waiters wait for it to turn false.
    running: watch::Sender<bool>,
    last_refresh: Mutex<f64>,
    last_viewer: Mutex<f64>,
    stopped: AtomicBool,
    timers: Mutex<Timers>,
    /// The own-requests fields each GitLab host takes.
    own_fields: Mutex<HashMap<String, &'static str>>,
    /// Each host's complexity limit, learned from its refusals.
    complexity: ComplexityGuard,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The inbox service (`createMrInbox`). Clones share it.
#[derive(Clone)]
pub struct MrInbox(Arc<Inner>);

/// Turns the refresh flag off and schedules the next one, however the run ends.
struct Running(Arc<Inner>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.running.send_replace(false);
        schedule(&self.0);
    }
}

fn spawn_after(
    inner: &Arc<Inner>,
    wait_ms: f64,
    fire: impl FnOnce(Arc<Inner>) -> BoxFuture<'static, ()> + Send + 'static,
) -> Option<AbortHandle> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    let weak: Weak<Inner> = Arc::downgrade(inner);
    // The deadline is taken now, as setTimeout's, not when the task first runs.
    let wait = wait_ms.max(0.0).ceil();
    let sleep: BoxFuture<'static, ()> = match &inner.deps.sleep_until {
        Some(sleep_until) => sleep_until(inner.now() + wait),
        None => Box::pin(tokio::time::sleep_until(
            tokio::time::Instant::now() + Duration::from_millis(wait as u64),
        )),
    };
    let task = handle.spawn(async move {
        sleep.await;
        if let Some(inner) = weak.upgrade() {
            fire(inner).await;
        }
    });
    Some(task.abort_handle())
}

fn schedule(inner: &Arc<Inner>) {
    if inner.stopped.load(Ordering::SeqCst) {
        return;
    }
    let now = (inner.deps.now)();
    let watched = now - *lock(&inner.last_viewer) < VIEWER_MS;
    let period = if watched {
        WATCHED_REFRESH_MS
    } else {
        IDLE_REFRESH_MS
    };
    let wait = (*lock(&inner.last_refresh) + period - now).max(1_000.0);
    // The timer only starts the refresh: a timer set again meanwhile
    // must not cut a refresh short.
    let next = spawn_after(inner, wait, |inner| {
        Box::pin(async move { MrInbox(inner).refresh_soon() })
    });
    let mut timers = lock(&inner.timers);
    if let Some(old) = timers.refresh.take() {
        old.abort();
    }
    timers.refresh = next;
}

impl Inner {
    fn now(&self) -> f64 {
        (self.deps.now)()
    }

    fn iso(&self) -> String {
        js::iso(self.now())
    }

    fn changed(&self) {
        if let Some(hook) = &self.deps.on_change {
            hook();
        }
    }

    fn state(&self) -> Obj {
        lock(&self.deps.store).get().clone()
    }

    fn update(&self, change: impl FnOnce(&mut Obj)) {
        if let Err(error) = lock(&self.deps.store).update(change) {
            self.deps.logger.warn(
                "reviews state not written",
                Some(&log_fields(vec![("error", json!(error.to_string()))])),
            );
        }
    }

    async fn ask(&self, host: Host<'_>, query: &str, call: &FetchCall) -> FetchResult<Value> {
        if host.gitlab() {
            self.deps.fetchers.gitlab(host.host, query, call).await
        } else {
            self.deps.fetchers.github(host.host, query, call).await
        }
    }

    /// The complexity guard's run, keeping what the asks failed with.
    async fn guarded<'a, U, F>(
        &self,
        host: Host<'_>,
        units: &[U],
        build: &(dyn Fn(&[U]) -> String + Sync),
        ask: F,
        most: usize,
    ) -> Result<Vec<Value>, Failure>
    where
        U: Clone,
        F: Fn(String, Vec<U>) -> BoxFuture<'a, Result<Value, Failure>>,
    {
        let failed: Mutex<Option<Failure>> = Mutex::new(None);
        let result = self
            .complexity
            .run(
                host.host,
                host.provider,
                units,
                build,
                |query, part| {
                    let answer = ask(query, part);
                    let failed = &failed;
                    async move {
                        answer.await.map_err(|failure| {
                            let message = failure.message().to_owned();
                            *lock(failed) = Some(failure);
                            AskError(message)
                        })
                    }
                },
                most,
            )
            .await;
        result.map_err(|AskError(message)| match lock(&failed).take() {
            Some(failure) if failure.message() == message => failure,
            _ => Failure::Fetch(FetchError::Failed(message)),
        })
    }

    /// Every request known: the forges' lists, then those the reviews
    /// agent found and the pins read (once in a list, the list's copy wins).
    fn items(&self) -> Vec<Obj> {
        let state = self.state();
        let mut out: Vec<Obj> = list(state.get("items"))
            .iter()
            .filter_map(|v| v.as_object().cloned())
            .collect();
        let mut listed: HashSet<String> = out.iter().map(|i| key_of(i).to_owned()).collect();
        let found = state
            .get("found")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|f| f.values())
            .filter_map(|entry| entry.get("item").and_then(Value::as_object));
        let pins = state
            .get("pins")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|p| p.values())
            .filter(|pin| truthy(pin.get("item")))
            .filter_map(|pin| pin.get("item").and_then(Value::as_object));
        for item in found.chain(pins) {
            if listed.insert(key_of(item).to_owned()) {
                out.push(item.clone());
            }
        }
        out
    }

    /// One pinned request, read from the forge and kept.
    async fn read_pin(&self, reference: &ForgeRef) {
        let key = reference.key();
        let previous = self.state().get("pins").and_then(|p| p.get(&key)).cloned();
        let answer = if reference.provider == "gitlab" {
            self.deps
                .fetchers
                .gitlab(
                    &reference.host,
                    &gitlab_request_query(reference),
                    &pin_call(),
                )
                .await
        } else {
            self.deps
                .fetchers
                .github(
                    &reference.host,
                    &github_request_query(reference),
                    &pin_call(),
                )
                .await
        };
        match answer
            .and_then(|answer| parse_request(reference, &answer).map_err(FetchError::Failed))
        {
            Ok(found) => {
                let at = self.iso();
                self.update(|state| {
                    let pin = match found {
                        Some(found) => json!({"item": found.item, "at": at}),
                        None => {
                            json!({"error": "Not found, or you have no access to it", "at": at})
                        }
                    };
                    if let Some(pins) = state.get_mut("pins").and_then(Value::as_object_mut) {
                        pins.insert(key.clone(), pin);
                    }
                });
            }
            Err(error) => {
                let message = js::head16(error.message(), 300);
                self.deps.logger.debug(
                    "pinned request not read",
                    Some(&log_fields(vec![
                        ("mr", json!(key)),
                        ("error", json!(message)),
                    ])),
                );
                // A hiccup keeps what was known; it is read again next refresh.
                if previous.as_ref().is_some_and(|p| truthy(p.get("item"))) {
                    return;
                }
                let at = self.iso();
                self.update(|state| {
                    if let Some(pins) = state.get_mut("pins").and_then(Value::as_object_mut) {
                        pins.insert(key.clone(), json!({"error": message, "at": at}));
                    }
                });
            }
        }
    }

    /// The pinned requests no list has: read when new, failed, open or old.
    async fn read_pins(&self, settings: &Obj, listed: &HashSet<String>) {
        let pinned: Vec<&Value> = list(settings.get("pinned")).iter().collect();
        let wanted: HashSet<String> = pinned
            .iter()
            .filter_map(|r| r.as_object())
            .map(forge_ref_key)
            .collect();
        let stale: Vec<String> = self
            .state()
            .get("pins")
            .and_then(Value::as_object)
            .map(|pins| {
                pins.keys()
                    .filter(|key| !wanted.contains(*key) || listed.contains(*key))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !stale.is_empty() {
            self.update(|state| {
                if let Some(pins) = state.get_mut("pins").and_then(Value::as_object_mut) {
                    for key in &stale {
                        pins.shift_remove(key);
                    }
                }
            });
        }
        let pins = self.state().get("pins").cloned().unwrap_or(json!({}));
        let now = self.now();
        let due: Vec<ForgeRef> = pinned
            .into_iter()
            .filter(|reference| {
                let Some(reference) = reference.as_object() else {
                    return false;
                };
                let key = forge_ref_key(reference);
                if listed.contains(&key) {
                    return false;
                }
                let Some(known) = pins.get(&key).filter(|k| truthy(k.get("item"))) else {
                    return true;
                };
                js::sv(known["item"].get("state")) == "open"
                    || now - js::date_parse(js::sv(known.get("at"))) >= PIN_TTL_MS
            })
            .take(PINS_PER_REFRESH)
            .filter_map(ForgeRef::from_obj)
            .collect();
        for reference in &due {
            self.read_pin(reference).await;
        }
    }

    /// The light list of the user's own requests on a host: every open one,
    /// paged to the end (OWN_MAX_PAGES at most), and the latest settled.
    async fn list_own(&self, host: Host<'_>) -> FetchResult<Vec<Obj>> {
        let mut items: Vec<Obj> = Vec::new();
        let mut keys: HashSet<String> = HashSet::new();
        let mut after: Option<String> = None;
        for _ in 0..OWN_MAX_PAGES {
            let cursor = after.clone();
            // Its lists in several queries when the host's limit asks for it.
            let parts = own_list_parts(host.provider_name(), cursor.as_deref());
            let build = |parts: &[&'static str]| {
                if host.gitlab() {
                    gitlab_own_list_query(cursor.as_deref(), Some(parts))
                } else {
                    github_own_list_query(cursor.as_deref(), Some(parts))
                }
            };
            let call = own_call();
            let answers = self
                .guarded(
                    host,
                    &parts,
                    &build,
                    |query, _| {
                        let call = &call;
                        Box::pin(async move { Ok(self.ask(host, &query, call).await?) })
                    },
                    usize::MAX,
                )
                .await
                .map_err(Failure::into_fetch)?;
            let answer = merge_answers(&answers);
            let (read, next) = parse_own_list(host.provider_name(), host.host, &answer)?;
            for item in read {
                if keys.insert(key_of(&item).to_owned()) {
                    items.push(item);
                }
            }
            match next.filter(|n| !n.is_empty()) {
                None => return Ok(items),
                Some(next) => after = Some(next),
            }
        }
        self.deps.logger.warn(
            "own open requests cut at the page cap",
            Some(&log_fields(vec![
                ("host", json!(host.host)),
                ("pages", json!(OWN_MAX_PAGES)),
                ("read", json!(items.len())),
            ])),
        );
        Ok(items)
    }

    /// Details of some own requests, in batches sized to the host's
    /// complexity limit (OWN_DETAILS_BATCH at most); a batch refused for
    /// its complexity is split and asked again, a host refusing fields
    /// gets the lesser ones (and the batches asked so far are kept).
    async fn read_own_details(&self, host: Host<'_>, due: &[Obj]) -> FetchResult<Obj> {
        let found: Mutex<Obj> = Mutex::new(Obj::new());
        let mut left: Vec<Obj> = due.to_vec();
        left.sort_by(|a, b| js::locale_compare(js::sv(a.get("project")), js::sv(b.get("project"))));
        while !left.is_empty() {
            let fields = lock(&self.own_fields)
                .get(host.host)
                .copied()
                .unwrap_or("full");
            let lesser = lesser_own_fields(host.provider_name(), fields);
            let asked: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
            let build = |batch: &[Obj]| {
                let pairs: Vec<(String, u64)> = batch
                    .iter()
                    .map(|item| {
                        (
                            js::sv(item.get("project")).to_owned(),
                            item.get("number").and_then(Value::as_f64).unwrap_or(0.0) as u64,
                        )
                    })
                    .collect();
                own_details_query(host.provider_name(), &pairs, fields)
            };
            let call = own_details_call();
            let result = self
                .guarded(
                    host,
                    &left,
                    &build,
                    |query, batch| {
                        let (call, found, asked) = (&call, &found, &asked);
                        Box::pin(async move {
                            let answer = match self.ask(host, &query, call).await {
                                Ok(answer) => answer,
                                Err(error) => {
                                    let message = error.message().to_lowercase();
                                    if lesser.is_some()
                                        && message.contains("field")
                                        && !message.contains("complexity")
                                    {
                                        return Err(Failure::FieldsRefused);
                                    }
                                    return Err(error.into());
                                }
                            };
                            if lesser.is_some() && unknown_field_error(&answer) {
                                return Err(Failure::FieldsRefused);
                            }
                            let details =
                                parse_own_details(host.provider_name(), host.host, &answer)
                                    .map_err(FetchError::Failed)?;
                            let mut found = lock(found);
                            for (key, details) in details {
                                found.insert(key, Value::Object(details));
                            }
                            let mut asked = lock(asked);
                            for item in &batch {
                                asked.insert(key_of(item).to_owned());
                            }
                            Ok(answer)
                        })
                    },
                    OWN_DETAILS_BATCH,
                )
                .await;
            match result {
                Ok(_) => return Ok(found.into_inner().unwrap_or_else(|e| e.into_inner())),
                Err(Failure::FieldsRefused) => {
                    let lesser = lesser.unwrap_or("basic");
                    lock(&self.own_fields).insert(host.host.to_owned(), lesser);
                    self.deps.logger.info(
                        "own requests read with fewer fields",
                        Some(&log_fields(vec![
                            ("host", json!(host.host)),
                            ("fields", json!(lesser)),
                        ])),
                    );
                    let asked = lock(&asked);
                    left.retain(|item| !asked.contains(key_of(item)));
                }
                Err(Failure::Fetch(error)) => return Err(error),
            }
        }
        Ok(found.into_inner().unwrap_or_else(|e| e.into_inner()))
    }

    /// GitLab says when a label was added only through its label events:
    /// read for a request whose details were just read and that carries a
    /// merge-after label, once per change of those labels (section 15).
    async fn read_label_times(
        &self,
        host: Host<'_>,
        items: &[Obj],
        fresh: &mut Obj,
        settings: &Obj,
    ) {
        if !host.gitlab() {
            return;
        }
        let known = self.state().get("ownDetails").cloned().unwrap_or(json!({}));
        let mut calls = 0;
        for item in items {
            let key = key_of(item);
            let Some(details) = fresh.get_mut(key).and_then(Value::as_object_mut) else {
                continue;
            };
            if !truthy(details.get("merge")) || js::sv(item.get("state")) != "open" {
                continue;
            }
            let rules = rules_for(
                settings.get("merge"),
                js::sv(item.get("host")),
                js::sv(item.get("project")),
            );
            let labels: Vec<String> = list(item.get("labels"))
                .iter()
                .filter_map(Value::as_str)
                .filter(|label| {
                    merge_after_label(&[(*label).to_owned()], &rules.after_labels).is_some()
                })
                .map(str::to_owned)
                .collect();
            if labels.is_empty() {
                continue;
            }
            let mut sorted = labels.clone();
            sorted.sort();
            let joined = sorted.join("\n");
            let before = known.get(key);
            let before_for = before.and_then(|b| b.get("labelTimesFor"));
            if before_for.is_some_and(|f| f.as_str() == Some(joined.as_str())) {
                if let Some(added) = before
                    .and_then(|b| b.get("merge"))
                    .and_then(|m| m.get("labelsAddedAt"))
                    .filter(|a| truthy(Some(a)))
                    && let Some(merge) = details.get_mut("merge").and_then(Value::as_object_mut)
                {
                    merge.insert("labelsAddedAt".into(), added.clone());
                }
                details.insert(
                    "labelTimesFor".into(),
                    before_for.cloned().unwrap_or(Value::Null),
                );
                continue;
            }
            if calls >= LABEL_EVENTS_PER_REFRESH {
                continue;
            }
            let Some(read) = self.deps.fetchers.gitlab_label_events(item) else {
                return;
            };
            calls += 1;
            match read.await {
                Ok(added) => {
                    let mut kept = Obj::new();
                    for label in &labels {
                        if let Some(at) = added.get(label).filter(|a| truthy(Some(a))) {
                            kept.insert(label.clone(), at.clone());
                        }
                    }
                    if !kept.is_empty()
                        && let Some(merge) = details.get_mut("merge").and_then(Value::as_object_mut)
                    {
                        merge.insert("labelsAddedAt".into(), Value::Object(kept));
                    }
                    details.insert("labelTimesFor".into(), json!(joined));
                }
                Err(error) => self.deps.logger.debug(
                    "label events not read",
                    Some(&log_fields(vec![
                        ("mr", json!(key)),
                        ("error", json!(error.message())),
                    ])),
                ),
            }
        }
    }

    /// The user's own requests on a host: open, or settled since
    /// `settled_since`. Their details are read only when new, changed
    /// since last read, still settling, or (a few per refresh) old; the
    /// others keep the details known.
    async fn read_own(
        &self,
        host: Host<'_>,
        settled_since: &str,
        settings: &Obj,
    ) -> FetchResult<Vec<Obj>> {
        let listed: Vec<Obj> = self
            .list_own(host)
            .await?
            .into_iter()
            .filter(|item| {
                js::sv(item.get("state")) == "open"
                    || js::sv(item.get("updatedAt")) >= settled_since
            })
            .collect();
        let known = self.state().get("ownDetails").cloned().unwrap_or(json!({}));
        let now = self.now();
        let mut changed: Vec<Obj> = Vec::new();
        let mut aged: Vec<Obj> = Vec::new();
        for item in &listed {
            let open = js::sv(item.get("state")) == "open";
            match known.get(key_of(item)) {
                None => changed.push(item.clone()),
                Some(details)
                    if js::sv(item.get("updatedAt")) > js::sv(details.get("updatedAt"))
                        || item.get("headSha") != details.get("headSha")
                        || (open && truthy(details.get("settling"))) =>
                {
                    changed.push(item.clone())
                }
                Some(details)
                    if open
                        && now - js::date_parse(js::sv(details.get("at")))
                            >= OWN_DETAILS_TTL_MS =>
                {
                    aged.push(item.clone())
                }
                Some(_) => {}
            }
        }
        let at_of = |item: &Obj| {
            known
                .get(key_of(item))
                .map(|d| js::sv(d.get("at")).to_owned())
                .unwrap_or_default()
        };
        aged.sort_by(|a, b| js::locale_compare(&at_of(a), &at_of(b)));
        let due: Vec<Obj> = changed
            .into_iter()
            .chain(aged.into_iter().take(OWN_AGED_PER_REFRESH))
            .take(OWN_DETAILS_PER_REFRESH)
            .collect();
        let mut fresh = Obj::new();
        if !due.is_empty() {
            match self.read_own_details(host, &due).await {
                Ok(found) => fresh = found,
                // The list stands; the details known stay, read again next time.
                Err(error) => self.deps.logger.debug(
                    "own request details not read",
                    Some(&log_fields(vec![
                        ("host", json!(host.host)),
                        ("error", json!(error.message())),
                    ])),
                ),
            }
        }
        if !fresh.is_empty() {
            self.read_label_times(host, &due, &mut fresh, settings)
                .await;
        }
        // Kept for the requests listed; the others (gone, settled long ago) go.
        let keys: HashSet<&str> = listed.iter().map(key_of).collect();
        let prefix = format!("{}:{}/", host.provider_name(), host.host.to_lowercase());
        let gone: Vec<String> = known
            .as_object()
            .map(|known| {
                known
                    .keys()
                    .filter(|key| key.starts_with(&prefix) && !keys.contains(key.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !fresh.is_empty() || !gone.is_empty() {
            let at = self.iso();
            self.update(|state| {
                if let Some(own) = state.get_mut("ownDetails").and_then(Value::as_object_mut) {
                    for (key, details) in fresh {
                        if keys.contains(key.as_str()) {
                            let mut details = details.as_object().cloned().unwrap_or_default();
                            details.insert("at".into(), json!(at));
                            own.insert(key, Value::Object(details));
                        }
                    }
                    for key in &gone {
                        own.shift_remove(key);
                    }
                }
            });
        }
        let details = self.state().get("ownDetails").cloned().unwrap_or(json!({}));
        Ok(listed
            .iter()
            .map(|item| {
                with_own_details(item, details.get(key_of(item)).and_then(Value::as_object))
            })
            .collect())
    }

    async fn read_host(
        &self,
        host: Host<'_>,
        followed: &[String],
        settled_since: &str,
        settings: &Obj,
    ) -> HostResult {
        let mut state = Obj::new();
        state.insert("host".into(), json!(host.host));
        state.insert("provider".into(), json!(host.provider_name()));
        let read = async {
            // The lists and the followed projects, in as many queries as
            // the host's complexity limit asks.
            let parts = inbox_parts(followed);
            let build = |parts: &[InboxPart]| {
                if host.gitlab() {
                    gitlab_inbox_query(followed, Some(parts))
                } else {
                    github_inbox_query(followed, Some(parts))
                }
            };
            let call = FetchCall::inbox();
            let answers = self
                .guarded(
                    host,
                    &parts,
                    &build,
                    |query, _| {
                        let call = &call;
                        Box::pin(async move { Ok(self.ask(host, &query, call).await?) })
                    },
                    usize::MAX,
                )
                .await
                .map_err(Failure::into_fetch)?;
            let merged = merge_answers(&answers);
            let answer = if host.gitlab() {
                parse_gitlab_inbox(host.host, followed, &merged)
            } else {
                parse_github_inbox(host.host, followed, &merged)
            };
            answer.map_err(FetchError::Failed)
        };
        match read.await {
            Ok(answer) => {
                // Its own query: a failure there keeps what was known of them.
                let own = match self.read_own(host, settled_since, settings).await {
                    Ok(own) => Some(own),
                    Err(error) => {
                        self.deps.logger.debug(
                            "own requests not read",
                            Some(&log_fields(vec![
                                ("host", json!(host.host)),
                                ("error", json!(error.message())),
                            ])),
                        );
                        None
                    }
                };
                state.insert("state".into(), json!("ok"));
                state.insert("user".into(), json!(answer.user));
                state.insert("fetchedAt".into(), json!(self.iso()));
                if !answer.missing.is_empty() {
                    state.insert(
                        "message".into(),
                        json!(format!("Cannot see {}", answer.missing.join(", "))),
                    );
                }
                HostResult {
                    state,
                    answer: Some(answer),
                    own,
                }
            }
            Err(error) => {
                let kind = error.host_state();
                if kind == "error" {
                    self.deps.logger.warn(
                        "inbox host not read",
                        Some(&log_fields(vec![
                            ("host", json!(host.host)),
                            ("error", json!(error.message())),
                        ])),
                    );
                }
                state.insert("state".into(), json!(kind));
                state.insert("message".into(), json!(js::head16(error.message(), 300)));
                HostResult {
                    state,
                    answer: None,
                    own: None,
                }
            }
        }
    }

    async fn read_drafts(&self, items: &[Obj]) {
        let state = self.state();
        let now = self.now();
        let due: Vec<&Obj> = items
            .iter()
            .filter(|item| {
                let key = key_of(item);
                if js::sv(item.get("provider")) != "gitlab"
                    || !truthy(state.get("reviews").and_then(|r| r.get(key)))
                {
                    return false;
                }
                match state
                    .get("drafts")
                    .and_then(|d| d.get(key))
                    .filter(|k| truthy(Some(k)))
                {
                    None => true,
                    Some(known) => {
                        let at = js::sv(known.get("at"));
                        js::sv(item.get("updatedAt")) > at
                            || now - js::date_parse(at) >= DRAFTS_TTL_MS
                    }
                }
            })
            .take(DRAFTS_PER_REFRESH)
            .collect();
        let mut counts: Vec<(String, usize)> = Vec::new();
        for item in due {
            match self.deps.fetchers.gitlab_drafts(item).await {
                Ok(count) => counts.push((key_of(item).to_owned(), count)),
                Err(error) => self.deps.logger.debug(
                    "draft count not read",
                    Some(&log_fields(vec![
                        ("mr", json!(key_of(item))),
                        ("error", json!(error.message())),
                    ])),
                ),
            }
        }
        if !counts.is_empty() {
            let at = self.iso();
            self.update(|state| {
                if let Some(drafts) = state.get_mut("drafts").and_then(Value::as_object_mut) {
                    for (key, count) in counts {
                        drafts.insert(key, json!({"count": count, "at": at}));
                    }
                }
            });
        }
    }

    async fn run(&self) {
        let settings = (self.deps.settings)().await;
        let hosts: Vec<(String, Provider)> = list(settings.get("hosts"))
            .iter()
            .map(|h| {
                let provider = if js::sv(h.get("provider")) == "gitlab" {
                    Provider::Gitlab
                } else {
                    Provider::Github
                };
                (js::sv(h.get("host")).to_owned(), provider)
            })
            .collect();
        let followed_of = |host: &str| -> Vec<String> {
            list(settings.get("followed"))
                .iter()
                .filter(|entry| js::sv(entry.get("host")) == host)
                .map(|entry| js::sv(entry.get("project")).to_owned())
                .collect()
        };
        let retention = js::to_number(settings.get("retentionDays"));
        let settled_since = js::iso(self.now() - retention * 24.0 * 60.0 * MINUTE);
        let followed: Vec<Vec<String>> = hosts.iter().map(|(h, _)| followed_of(h)).collect();
        let reads = hosts
            .iter()
            .zip(&followed)
            .map(|((host, provider), followed)| {
                self.read_host(
                    Host {
                        host,
                        provider: *provider,
                    },
                    followed,
                    &settled_since,
                    &settings,
                )
            });
        let results: Vec<HostResult> = futures_util::future::join_all(reads).await;
        {
            let mut hosts = lock(&self.hosts);
            hosts.clear();
            for result in &results {
                hosts.insert(js::sv(result.state.get("host")).to_owned(), result.clone());
            }
        }
        // A host that failed keeps what it had: the list does not empty on
        // a hiccup.
        let previous: Vec<Obj> = list(self.state().get("items"))
            .iter()
            .filter_map(|v| v.as_object().cloned())
            .collect();
        let mut merged = Obj::new();
        let set = |merged: &mut Obj, item: Obj| {
            merged.insert(key_of(&item).to_owned(), Value::Object(item));
        };
        for result in &results {
            let host = js::sv(result.state.get("host"));
            let Some(answer) = &result.answer else {
                for item in previous.iter().filter(|i| js::sv(i.get("host")) == host) {
                    set(&mut merged, item.clone());
                }
                continue;
            };
            for item in &answer.followed {
                set(&mut merged, item.clone());
            }
            for item in &answer.mine {
                let mut item = item.clone();
                if let Some(files) = merged
                    .get(key_of(&item))
                    .and_then(|f| f.get("files"))
                    .filter(|f| truthy(Some(f)))
                {
                    item.insert("files".into(), files.clone());
                }
                set(&mut merged, item);
            }
            // The user's own: what they were read with, else what was known.
            let own: Vec<Obj> = result.own.clone().unwrap_or_else(|| {
                previous
                    .iter()
                    .filter(|i| js::sv(i.get("host")) == host && reasons_has(i, "authored"))
                    .cloned()
                    .collect()
            });
            for item in own {
                let known = merged.get(key_of(&item)).cloned();
                let mut reasons: Vec<Value> = Vec::new();
                for reason in known
                    .as_ref()
                    .map(|k| list(k.get("reasons")))
                    .unwrap_or(&[])
                    .iter()
                    .chain(list(item.get("reasons")))
                {
                    if !reasons.contains(reason) {
                        reasons.push(reason.clone());
                    }
                }
                let mut item = item;
                item.insert("reasons".into(), Value::Array(reasons));
                if let Some(files) = known
                    .as_ref()
                    .and_then(|k| k.get("files"))
                    .filter(|f| truthy(Some(f)))
                {
                    item.insert("files".into(), files.clone());
                }
                set(&mut merged, item);
            }
        }
        let items: Vec<Obj> = merged
            .into_iter()
            .filter_map(|(_, v)| match v {
                Value::Object(o) => Some(o),
                _ => None,
            })
            .collect();
        let at = self.iso();
        self.update(|state| {
            state.insert(
                "items".into(),
                Value::Array(items.iter().cloned().map(Value::Object).collect()),
            );
            let mut seen = state
                .get("seen")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut baselined = state
                .get("baselined")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            // A host's first answer is the baseline: everything in it
            // counts as seen as it is, so "new" and unread mean since then,
            // not "all".
            for result in &results {
                let host = js::sv(result.state.get("host"));
                if result.answer.is_none() || truthy(baselined.get(host)) {
                    continue;
                }
                baselined.insert(host.to_owned(), json!(at));
                for item in items.iter().filter(|i| js::sv(i.get("host")) == host) {
                    if !truthy(seen.get(key_of(item))) {
                        seen.insert(key_of(item).to_owned(), Value::Object(seen_of(item, &at)));
                    }
                }
            }
            // The user's own requests are never "new" to them: what changes
            // on them from the first sight on is what shows.
            for item in items.iter().filter(|i| reasons_has(i, "authored")) {
                if !truthy(seen.get(key_of(item))) {
                    seen.insert(key_of(item).to_owned(), Value::Object(seen_of(item, &at)));
                }
            }
            state.insert("baselined".into(), Value::Object(baselined));
            state.insert("seen".into(), Value::Object(seen));
            // The user saw a request close: its review state ages from now.
            if let Some(reviews) = state.get_mut("reviews").and_then(Value::as_object_mut) {
                for item in &items {
                    if let Some(review) =
                        reviews.get_mut(key_of(item)).and_then(Value::as_object_mut)
                        && js::sv(item.get("state")) != "open"
                        && !truthy(review.get("closedAt"))
                    {
                        review.insert("closedAt".into(), json!(at));
                    }
                }
            }
        });
        let listed: HashSet<String> = items.iter().map(|i| key_of(i).to_owned()).collect();
        self.read_pins(&settings, &listed).await;
        *lock(&self.last_refresh) = self.now();
        self.changed();
        self.read_drafts(&items).await;
        self.changed();
        if let Some(after) = &self.deps.after_refresh
            && let Some(settled) = after(items)
        {
            settled.await;
        }
    }
}

/// `MrInbox.get`'s options.
#[derive(Clone, Copy, Debug)]
pub struct GetOptions {
    pub fresh: bool,
    pub viewer: bool,
}

impl Default for GetOptions {
    fn default() -> Self {
        GetOptions {
            fresh: false,
            viewer: true,
        }
    }
}

impl MrInbox {
    pub fn new(deps: MrInboxDeps) -> MrInbox {
        let logger = deps.logger.clone();
        let complexity = ComplexityGuard::new(Some(Arc::new(move |host: &str, limit| {
            logger.info(
                "forge query complexity limit learned",
                Some(&log_fields(vec![
                    ("host", json!(host)),
                    ("max", js::number(limit.max)),
                    ("scale", js::number((limit.scale * 100.0).round() / 100.0)),
                ])),
            );
        })));
        MrInbox(Arc::new(Inner {
            deps,
            hosts: Mutex::new(HashMap::new()),
            running: watch::Sender::new(false),
            last_refresh: Mutex::new(0.0),
            last_viewer: Mutex::new(0.0),
            stopped: AtomicBool::new(true),
            timers: Mutex::new(Timers {
                refresh: None,
                wake: None,
                wake_time: 0.0,
            }),
            own_fields: Mutex::new(HashMap::new()),
            complexity,
        }))
    }

    pub fn deps(&self) -> &MrInboxDeps {
        &self.0.deps
    }

    /// Whether a refresh runs.
    pub fn refreshing(&self) -> bool {
        *self.0.running.borrow()
    }

    /// Reads every host again. A refresh already running is the one waited
    /// for. It starts (and says so) at once, before the future is polled,
    /// as Bun's promise does; a caller that does not wait spawns it.
    pub fn refresh(&self) -> BoxFuture<'static, ()> {
        let inner = self.0.clone();
        if *inner.running.borrow() {
            let mut running = inner.running.subscribe();
            return Box::pin(async move {
                let _ = running.wait_for(|running| !*running).await;
            });
        }
        inner.running.send_replace(true);
        let guard = Running(inner.clone());
        inner.changed();
        Box::pin(async move {
            guard.0.run().await;
            drop(guard);
        })
    }

    /// Starts a refresh without waiting for it.
    pub fn refresh_soon(&self) {
        let run = self.refresh();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(run);
            }
            Err(_) => drop(run),
        }
    }

    /// The inbox as known, without waiting; asks a refresh when stale.
    pub async fn get(&self, options: GetOptions) -> Obj {
        let inner = &self.0;
        if options.viewer {
            if let Some(hook) = &inner.deps.on_viewer {
                hook();
            }
            let now = inner.now();
            let was_watched = {
                let mut last = lock(&inner.last_viewer);
                let was = now - *last < VIEWER_MS;
                *last = now;
                was
            };
            if !was_watched {
                schedule(inner);
            }
        }
        let settings = (inner.deps.settings)().await;
        let min = if options.fresh {
            FRESH_MIN_MS
        } else {
            WATCHED_REFRESH_MS
        };
        let stale = inner.now() - *lock(&inner.last_refresh) >= min;
        if stale && !self.refreshing() {
            self.refresh_soon();
        }
        self.snapshot(&settings)
    }

    /// The rows shown and those removed by the user (`entries`).
    pub fn entries(&self, settings: &Obj) -> (Vec<Obj>, Vec<Obj>) {
        let inner = &self.0;
        let state = inner.state();
        let now = inner.now();
        let mut pinned: Vec<(String, Value)> = Vec::new();
        for reference in list(settings.get("pinned")) {
            let key = reference.as_object().map(forge_ref_key).unwrap_or_default();
            match pinned.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = reference.clone(),
                None => pinned.push((key, reference.clone())),
            }
        }
        let is_pinned = |key: &str| pinned.iter().any(|(k, _)| k == key);
        let mut hidden_at: HashMap<String, Value> = HashMap::new();
        for entry in list(settings.get("hidden")) {
            hidden_at.insert(
                js::sv(entry.get("key")).to_owned(),
                entry.get("marker").cloned().unwrap_or(Value::Null),
            );
        }
        let mut verdicts: HashMap<String, Value> = HashMap::new();
        for entry in list(state.get("feedback")) {
            verdicts.insert(
                js::sv(entry.get("key")).to_owned(),
                entry.get("verdict").cloned().unwrap_or(Value::Null),
            );
        }
        let ranked = state.get("ranked").cloned().unwrap_or(json!({}));
        let overrides = settings.get("overrides").cloned().unwrap_or(json!({}));
        let upstream = inner.deps.upstream.as_ref().map(|f| f(settings));
        let mut hidden: Vec<Obj> = Vec::new();
        let mut out: Vec<Obj> = Vec::new();
        let mut listed: HashSet<String> = HashSet::new();
        for item in inner.items() {
            let key = key_of(&item).to_owned();
            listed.insert(key.clone());
            let section = if is_pinned(&key) {
                "pinned"
            } else if reasons_has(&item, "authored") {
                "authored"
            } else if !list(item.get("reasons")).is_empty() {
                "mine"
            } else {
                "suggested"
            };
            let rank = ranked.get(&key).filter(|r| truthy(Some(r)));
            let verdict = verdicts.get(&key).filter(|v| truthy(Some(v)));
            if section == "suggested" {
                if js::sv(item.get("state")) != "open" {
                    continue;
                }
                // Shown once Claude picked it (or the user asked for more
                // like it); never after "not interested".
                let verdict = verdict.and_then(Value::as_str);
                if verdict == Some("not_interested") {
                    continue;
                }
                if !rank.is_some_and(|r| truthy(r.get("pick"))) && verdict != Some("more_like_this")
                {
                    continue;
                }
            }
            // Removed by the user, and quiet since: out of the view, listed apart.
            if section != "pinned"
                && hidden_at
                    .get(&key)
                    .is_some_and(|marker| *marker == json!(activity_marker(&item)))
            {
                let mut row = Obj::new();
                for name in [
                    "key", "provider", "host", "project", "number", "url", "title",
                ] {
                    row.insert(name.into(), item.get(name).cloned().unwrap_or(Value::Null));
                }
                hidden.push(row);
                continue;
            }
            let seen = state
                .get("seen")
                .and_then(|s| s.get(&key))
                .and_then(Value::as_object);
            let review = state
                .get("reviews")
                .and_then(|r| r.get(&key))
                .filter(|r| truthy(Some(r)));
            let drafts = match item.get("drafts").filter(|d| !d.is_null()) {
                Some(drafts) => Some(drafts.clone()),
                None if js::sv(item.get("provider")) == "gitlab" => state
                    .get("drafts")
                    .and_then(|d| d.get(&key))
                    .and_then(|d| d.get("count"))
                    .filter(|c| !c.is_null())
                    .cloned(),
                None => Some(json!(0)),
            };
            let mut entry = item.clone();
            if let Some(drafts) = drafts {
                entry.insert("drafts".into(), drafts);
            }
            entry.insert("section".into(), json!(section));
            entry.insert(
                "unread".into(),
                unread(&item, seen).map_or(Value::Null, Value::Object),
            );
            entry.insert("isNew".into(), json!(seen.is_none()));
            if section == "suggested"
                && let Some(reason) = rank
                    .and_then(|r| r.get("reason"))
                    .filter(|r| truthy(Some(r)))
            {
                entry.insert("reason".into(), reason.clone());
            }
            if let Some(verdict) = verdict {
                entry.insert("feedback".into(), verdict.clone());
            }
            if let Some(covered) = upstream.as_ref().and_then(|u| u.covered.get(&key)) {
                for (name, value) in covered {
                    entry.insert(name.clone(), value.clone());
                }
            }
            if let Some(found) = overrides.get(&key).and_then(Value::as_object) {
                entry.insert("override".into(), Value::Object(found.clone()));
                if override_outdated(found, &activity_marker(&item)) {
                    entry.insert("overrideOutdated".into(), json!(true));
                }
            }
            if let Some(review) = review {
                let mut shown = Obj::new();
                shown.insert(
                    "connectionId".into(),
                    review.get("connectionId").cloned().unwrap_or(Value::Null),
                );
                if let Some(workspace) = review.get("workspaceId").filter(|w| truthy(Some(w))) {
                    shown.insert("workspaceId".into(), workspace.clone());
                }
                shown.insert(
                    "sessionId".into(),
                    review.get("sessionId").cloned().unwrap_or(Value::Null),
                );
                entry.insert("review".into(), Value::Object(shown));
            }
            out.push(entry);
        }
        // A pinned request the forge did not give: a row saying so.
        for (key, reference) in &pinned {
            if listed.contains(key) {
                continue;
            }
            let mut row = reference.as_object().cloned().unwrap_or_default();
            let mark = if js::sv(reference.get("provider")) == "gitlab" {
                "!"
            } else {
                "#"
            };
            let title = format!(
                "{}{mark}{}",
                js::sv(reference.get("project")),
                reference.get("number").map(js::to_text).unwrap_or_default()
            );
            let unavailable = state
                .get("pins")
                .and_then(|p| p.get(key))
                .and_then(|p| p.get("error"))
                .filter(|e| !e.is_null())
                .cloned()
                .unwrap_or_else(|| json!("Not read yet"));
            let fields = [
                ("key", json!(key)),
                ("url", json!(request_url(reference))),
                ("title", json!(title)),
                ("author", json!("")),
                ("draft", json!(false)),
                ("state", json!("open")),
                ("updatedAt", json!("")),
                ("headSha", json!("")),
                ("sourceBranch", json!("")),
                ("targetBranch", json!("")),
                ("pipeline", Value::Null),
                ("notes", json!(0)),
                ("reasons", json!([])),
                ("section", json!("pinned")),
                ("unread", Value::Null),
                ("isNew", json!(false)),
                ("unavailable", unavailable),
            ];
            for (name, value) in fields {
                row.insert(name.into(), value);
            }
            out.push(row);
        }
        // Branches headed upstream with no request yet: one's own work too.
        for row in upstream.iter().flat_map(|u| u.rows.iter()) {
            if !listed.insert(key_of(row).to_owned()) {
                continue;
            }
            let mut row = row.clone();
            if let Some(found) = overrides.get(key_of(&row)).and_then(Value::as_object) {
                let outdated = override_outdated(found, &activity_marker(&row));
                row.insert("override".into(), Value::Object(found.clone()));
                if outdated {
                    row.insert("overrideOutdated".into(), json!(true));
                }
            }
            out.push(row);
        }
        let rank = |entry: &Obj| match js::sv(entry.get("section")) {
            "pinned" => 0,
            "mine" => 1,
            "authored" => 2,
            _ => 3,
        };
        let unread_first = |entry: &Obj| {
            let changed = entry
                .get("unread")
                .and_then(|u| u.get("changed"))
                .is_some_and(|c| truthy(Some(c)));
            if truthy(entry.get("isNew")) || changed {
                0
            } else {
                1
            }
        };
        let score = |entry: &Obj| {
            ranked
                .get(key_of(entry))
                .and_then(|r| r.get("score"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        out.sort_by(|a, b| {
            rank(a)
                .cmp(&rank(b))
                .then_with(|| {
                    if js::sv(a.get("section")) == "suggested" {
                        score(b)
                            .partial_cmp(&score(a))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    } else {
                        std::cmp::Ordering::Equal
                    }
                })
                .then_with(|| unread_first(a).cmp(&unread_first(b)))
                .then_with(|| {
                    js::locale_compare(js::sv(b.get("updatedAt")), js::sv(a.get("updatedAt")))
                })
        });
        // Merges scheduled by a label and bots merging (section 15): exact
        // facts, before the inference reads them.
        let users: HashMap<String, String> = lock(&inner.hosts)
            .iter()
            .filter_map(|(host, result)| {
                result
                    .state
                    .get("user")
                    .and_then(Value::as_str)
                    .filter(|u| !u.is_empty())
                    .map(|u| (host.clone(), u.to_owned()))
            })
            .collect();
        let own_details = state.get("ownDetails").cloned().unwrap_or(json!({}));
        let mut wake = f64::INFINITY;
        for entry in out.iter_mut() {
            if truthy(entry.get("branch")) || !reasons_has(entry, "authored") {
                continue;
            }
            let details = own_details.get(key_of(entry));
            let rules = rules_for(
                settings.get("merge"),
                js::sv(entry.get("host")),
                js::sv(entry.get("project")),
            );
            let notes: Vec<Obj> = details
                .map(|d| list(d.get("lastNotes")))
                .unwrap_or(&[])
                .iter()
                .filter_map(|n| n.as_object().cloned())
                .collect();
            let merge = merge_info(&MergeInput {
                state: js::sv(entry.get("state")),
                labels: list(entry.get("labels"))
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                updated_at: js::sv(entry.get("updatedAt")),
                facts: details
                    .and_then(|d| d.get("merge"))
                    .filter(|m| truthy(Some(m))),
                notes,
                rules: &rules,
                user: users.get(js::sv(entry.get("host"))).map(String::as_str),
                now,
            });
            let Some(merge) = merge else { continue };
            if let Some(after) = merge.get("after").filter(|a| !truthy(a.get("ready"))) {
                wake = wake.min(js::date_parse(js::sv(after.get("at"))));
            }
            entry.insert("merge".into(), Value::Object(merge));
        }
        self.wake_at(wake);
        // What was inferred of one's own work, unless it moved on since.
        let inferred = state.get("inferred").cloned().unwrap_or(json!({}));
        for entry in out.iter_mut() {
            let Some(found) = inferred.get(key_of(entry)).and_then(Value::as_object) else {
                continue;
            };
            if !truthy(entry.get("branch")) && !reasons_has(entry, "authored") {
                continue;
            }
            entry.insert("inferred".into(), Value::Object(found.clone()));
            let user = users
                .get(js::sv(entry.get("host")))
                .map(|u| u.to_lowercase())
                .unwrap_or_default();
            let notes = own_details
                .get(key_of(entry))
                .map(|d| list(d.get("lastNotes")).to_vec())
                .unwrap_or_default();
            if inference_outdated(found, entry, &row_facts(entry, &notes, &user)) {
                entry.insert("inferredOutdated".into(), json!(true));
            }
        }
        assign_lanes(&mut out, js::to_number(settings.get("staleDays")), now);
        (out, hidden)
    }

    /// At the soonest time a scheduled merge becomes mergeable, the rows
    /// move (Waiting to Your move) and the inference may run: no forge call.
    fn wake_at(&self, time: f64) {
        let inner = &self.0;
        let now = inner.now();
        if !time.is_finite() || time <= now {
            return;
        }
        {
            let timers = lock(&inner.timers);
            if timers.wake.is_some() && timers.wake_time == time {
                return;
            }
        }
        let wait = (time - now + 1_000.0).min(LONGEST_WAIT_MS);
        let next = spawn_after(inner, wait, |inner| {
            Box::pin(async move {
                {
                    let mut timers = lock(&inner.timers);
                    timers.wake = None;
                    timers.wake_time = 0.0;
                }
                inner.changed();
                if let Some(hook) = &inner.deps.on_merge_time {
                    hook();
                }
            })
        });
        let mut timers = lock(&inner.timers);
        if let Some(old) = timers.wake.take() {
            old.abort();
        }
        timers.wake_time = if next.is_some() { time } else { 0.0 };
        timers.wake = next;
    }

    /// The inbox every page reads (`MrInbox`).
    pub fn snapshot(&self, settings: &Obj) -> Obj {
        let inner = &self.0;
        let (entries, hidden) = self.entries(settings);
        let known = lock(&inner.hosts).clone();
        let hosts: Vec<Value> = list(settings.get("hosts"))
            .iter()
            .map(|host| {
                let name = js::sv(host.get("host"));
                match known.get(name) {
                    Some(result) => Value::Object(result.state.clone()),
                    None => json!({"host": name, "provider": host.get("provider").cloned().unwrap_or(Value::Null), "state": "pending"}),
                }
            })
            .collect();
        let mut out = Obj::new();
        out.insert(
            "entries".into(),
            Value::Array(entries.into_iter().map(Value::Object).collect()),
        );
        out.insert(
            "hidden".into(),
            Value::Array(hidden.into_iter().map(Value::Object).collect()),
        );
        out.insert("hosts".into(), Value::Array(hosts));
        out.insert(
            "curation".into(),
            inner
                .deps
                .curation
                .as_ref()
                .map_or_else(|| json!({"state": "off"}), |f| f()),
        );
        if let Some(inference) = &inner.deps.inference {
            out.insert("inference".into(), inference());
        }
        let last = *lock(&inner.last_refresh);
        if last != 0.0 {
            out.insert("refreshedAt".into(), json!(js::iso(last)));
        }
        out.insert("refreshing".into(), json!(self.refreshing()));
        let non_empty = |name: &str| {
            settings
                .get(name)
                .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                .cloned()
        };
        if let Some(order) = non_empty("order") {
            out.insert("order".into(), order);
        }
        out.insert(
            "orderVersion".into(),
            settings
                .get("orderVersion")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(0)),
        );
        if let Some(views) = non_empty("views") {
            out.insert("views".into(), views);
        }
        if let Some(panel) = settings.get("panel").filter(|p| truthy(p.get("at"))) {
            out.insert("panel".into(), panel.clone());
        }
        if let Some(groups) = non_empty("upstreamGroups") {
            out.insert("upstreamGroups".into(), groups);
        }
        if let Some(workspaces) = non_empty("upstreamWorkspaces") {
            out.insert("upstreamWorkspaces".into(), workspaces);
        }
        if non_empty("efforts").is_some()
            && let Some(efforts) = &inner.deps.efforts
        {
            out.insert("efforts".into(), Value::Array(efforts(settings)));
        }
        out
    }

    /// The forge hosts in effect (those set, or those signed in to).
    pub async fn hosts(&self) -> Vec<Value> {
        list((self.0.deps.settings)().await.get("hosts")).to_vec()
    }

    /// The settings changed what the inbox shows: browsers may ask again.
    pub fn changed(&self) {
        self.0.changed();
    }

    /// A request just pinned: read at once, so its row has its state.
    pub async fn read_pin(&self, reference: &ForgeRef) {
        self.0.read_pin(reference).await;
        self.0.changed();
    }

    /// The user looked at a request: its activity is read.
    pub fn mark_seen(&self, key: &str) -> bool {
        let Some(item) = self.item(key) else {
            return false;
        };
        let at = self.0.iso();
        self.0.update(|state| {
            if let Some(seen) = state.get_mut("seen").and_then(Value::as_object_mut) {
                seen.insert(key.to_owned(), Value::Object(seen_of(&item, &at)));
            }
        });
        self.0.changed();
        true
    }

    /// The user's word on a request (None takes it back).
    pub fn feedback(&self, key: &str, verdict: Option<&str>) -> bool {
        let Some(item) = self.item(key) else {
            return false;
        };
        let at = self.0.iso();
        if let Err(error) = lock(&self.0.deps.store).set_feedback(&item, verdict, &at) {
            self.0.deps.logger.warn(
                "reviews state not written",
                Some(&log_fields(vec![("error", json!(error.to_string()))])),
            );
        }
        self.0.changed();
        true
    }

    pub fn item(&self, key: &str) -> Option<Obj> {
        self.0.items().into_iter().find(|item| key_of(item) == key)
    }

    /// Every request known (`items`).
    pub fn items(&self) -> Vec<Obj> {
        self.0.items()
    }

    /// The user's name on each host read (their own requests are theirs).
    pub fn users(&self) -> HashMap<String, String> {
        lock(&self.0.hosts)
            .iter()
            .filter_map(|(host, result)| {
                result
                    .state
                    .get("user")
                    .and_then(Value::as_str)
                    .filter(|u| !u.is_empty())
                    .map(|user| (host.clone(), user.to_lowercase()))
            })
            .collect()
    }

    /// The projects of the inbox's requests, by `mrProjectKey`, in order.
    pub fn projects(&self) -> Vec<(String, Vec<Obj>)> {
        let mut out: Vec<(String, Vec<Obj>)> = Vec::new();
        for item in self.0.items() {
            let key = project_key(js::sv(item.get("host")), js::sv(item.get("project")));
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some((_, items)) => items.push(item),
                None => out.push((key, vec![item])),
            }
        }
        out
    }

    pub fn start(&self) {
        let inner = &self.0;
        inner.stopped.store(false, Ordering::SeqCst);
        // The first refresh waits a little: the bridge has more urgent work
        // when it starts.
        *lock(&inner.last_refresh) = inner.now() - IDLE_REFRESH_MS + 30_000.0;
        schedule(inner);
    }

    pub fn stop(&self) {
        let inner = &self.0;
        inner.stopped.store(true, Ordering::SeqCst);
        let mut timers = lock(&inner.timers);
        if let Some(timer) = timers.refresh.take() {
            timer.abort();
        }
        if let Some(timer) = timers.wake.take() {
            timer.abort();
        }
        timers.wake_time = 0.0;
    }
}

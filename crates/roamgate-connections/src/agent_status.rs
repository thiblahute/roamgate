//! The agent status subscription (server/src/connections/agent-status-subscription.ts).
//!
//! Herdr sends `pane.agent_status_changed` only to per-pane subscriptions,
//! so this loop keeps one subscription for the panes that host an agent:
//! membership comes from `pane.list`, is rebuilt when a membership event
//! arrives (debounced) and polled as a fallback. The status events reach
//! the client's own event listeners like every other subscription's.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::SharedClock;
use roamgate_herdr::control::{HerdrClient, SUBSCRIPTION_ACK_TIMEOUT_MS, Subscription};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, watch};

use crate::subscription_loop::LoopSubscription;

/// Herdr events that can change which panes host an agent.
const MEMBERSHIP_EVENT_TYPES: &[&str] = &[
    "pane_agent_detected",
    "pane_closed",
    "pane_moved",
    "tab_closed",
    "workspace_closed",
];

/// A Herdr event's name: `event`, else `data.type` (utils/herdr-events.ts).
pub fn herdr_event_name(event: &Value) -> Option<String> {
    let envelope = event.as_object()?;
    if let Some(name) = envelope.get("event").and_then(Value::as_str)
        && !name.is_empty()
    {
        return Some(name.to_owned());
    }
    envelope
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("type"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// The sorted ids of the panes that host an agent.
pub fn agent_pane_ids_from_pane_list(result: &Value) -> Vec<String> {
    let Some(panes) = result.get("panes").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = panes
        .iter()
        .filter_map(Value::as_object)
        .filter(|pane| {
            pane.get("agent")
                .and_then(Value::as_str)
                .is_some_and(|agent| !agent.is_empty())
        })
        .filter_map(|pane| pane.get("pane_id").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

pub fn same_pane_ids(a: &[String], b: &[String]) -> bool {
    a == b
}

/// What the loop needs of Herdr.
pub trait StatusHerdr: Send + Sync + 'static {
    fn pane_list(&self) -> BoxFuture<'static, Result<Value, String>>;
    fn subscribe(&self, subscriptions: Vec<Subscription>) -> Result<LoopSubscription, String>;
}

impl StatusHerdr for HerdrClient {
    fn pane_list(&self) -> BoxFuture<'static, Result<Value, String>> {
        let client = self.clone();
        // Bounded so a hung server cannot hold the runtime's stop hostage.
        async move { client.call("pane.list", json!({}), 5000, None, false).await }.boxed()
    }

    fn subscribe(&self, subscriptions: Vec<Subscription>) -> Result<LoopSubscription, String> {
        Ok(LoopSubscription::from_herdr(HerdrClient::subscribe(
            self,
            &subscriptions,
            SUBSCRIPTION_ACK_TIMEOUT_MS,
        )))
    }
}

type ErrorCallback = Arc<dyn Fn(String) + Send + Sync>;
type PaneListObserver = Arc<dyn Fn(&Value, Option<i64>) + Send + Sync>;
type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// What the loop is made of.
#[derive(Clone)]
pub struct AgentStatusArgs {
    pub herdr: Arc<dyn StatusHerdr>,
    pub connection_id: String,
    pub clock: SharedClock,
    pub on_subscribe_error: Option<ErrorCallback>,
    pub on_list_error: Option<ErrorCallback>,
    /// A revision taken when a listing starts, given back with its result.
    pub on_pane_list_start: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub on_pane_list: Option<PaneListObserver>,
    pub log: Option<LogSink>,
    pub retry_delay: Duration,
    pub rebuild_debounce: Duration,
    pub membership_poll: Duration,
}

impl AgentStatusArgs {
    pub fn new(herdr: Arc<dyn StatusHerdr>, connection_id: &str, clock: SharedClock) -> Self {
        Self {
            herdr,
            connection_id: connection_id.into(),
            clock,
            on_subscribe_error: None,
            on_list_error: None,
            on_pane_list_start: None,
            on_pane_list: None,
            log: None,
            retry_delay: Duration::from_millis(2000),
            rebuild_debounce: Duration::from_millis(300),
            membership_poll: Duration::from_millis(30_000),
        }
    }
}

#[derive(Default)]
struct State {
    running: bool,
    cancel: Option<watch::Sender<bool>>,
    active: Option<LoopSubscription>,
    task: Option<Shared<BoxFuture<'static, ()>>>,
    stop_task: Option<Shared<BoxFuture<'static, ()>>>,
    debounce: Option<tokio::task::JoinHandle<()>>,
}

/// The loop. Clones are the same loop.
#[derive(Clone)]
pub struct AgentStatusSubscriptionLoop {
    args: AgentStatusArgs,
    state: Arc<Mutex<State>>,
    rebuild_requested: Arc<AtomicBool>,
    rebuild_wake: Arc<Notify>,
}

enum Hold {
    Closed,
    Rebuild,
    Cancelled,
}

fn guarded<T>(work: impl FnOnce() -> T) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).ok()
}

impl AgentStatusSubscriptionLoop {
    pub fn new(args: AgentStatusArgs) -> Self {
        Self {
            args,
            state: Arc::default(),
            rebuild_requested: Arc::default(),
            rebuild_wake: Arc::new(Notify::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("agent status loop")
    }

    pub fn is_running(&self) -> bool {
        self.lock().running
    }

    fn report(&self, callback: &Option<ErrorCallback>, error: String) {
        if let Some(callback) = callback {
            guarded(|| callback(error));
        }
    }

    fn log(&self, message: &str) {
        if let Some(log) = &self.args.log {
            guarded(|| log(message));
        }
    }

    /// Waits `duration`, or less: cancelled, or (when asked) a rebuild wake.
    async fn wait(&self, duration: Duration, cancelled: &mut watch::Receiver<bool>, wake: bool) {
        let sleep = self.args.clock.sleep(duration);
        let notified = self.rebuild_wake.notified();
        tokio::pin!(notified);
        tokio::select! {
            _ = cancelled.wait_for(|cancel| *cancel) => {}
            () = sleep => {}
            () = &mut notified, if wake => {}
        }
    }

    async fn list_agent_pane_ids(&self) -> Option<Vec<String>> {
        let revision = self
            .args
            .on_pane_list_start
            .as_ref()
            .and_then(|start| guarded(|| start()));
        match self.args.herdr.pane_list().await {
            Ok(result) => {
                if let Some(observe) = &self.args.on_pane_list {
                    guarded(|| observe(&result, revision));
                }
                Some(agent_pane_ids_from_pane_list(&result))
            }
            Err(error) => {
                self.report(&self.args.on_list_error, error);
                None
            }
        }
    }

    fn request_rebuild(&self) {
        let mut state = self.lock();
        if !state.running {
            return;
        }
        self.rebuild_requested.store(true, Ordering::SeqCst);
        if state
            .debounce
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return;
        }
        let clock = self.args.clock.clone();
        let delay = self.args.rebuild_debounce;
        let wake = self.rebuild_wake.clone();
        state.debounce = Some(tokio::spawn(async move {
            clock.sleep(delay).await;
            wake.notify_waiters();
        }));
    }

    async fn hold_subscription(
        &self,
        subscription: &LoopSubscription,
        pane_ids: &[String],
        cancelled: &mut watch::Receiver<bool>,
    ) -> Hold {
        loop {
            // A wake that fired while no waiter listened (mid-listing) must
            // not be lost: the flag is checked before sleeping.
            if self.rebuild_requested.swap(false, Ordering::SeqCst) {
                let latest = self.list_agent_pane_ids().await;
                if *cancelled.borrow() {
                    return Hold::Cancelled;
                }
                match latest {
                    None => {
                        self.wait(self.args.retry_delay, cancelled, true).await;
                        if *cancelled.borrow() {
                            return Hold::Cancelled;
                        }
                        continue;
                    }
                    Some(latest) if !same_pane_ids(&latest, pane_ids) => return Hold::Rebuild,
                    Some(_) => continue,
                }
            }
            let closed = tokio::select! {
                _ = subscription.closed.clone() => true,
                () = self.wait(self.args.membership_poll, cancelled, true) => false,
            };
            if *cancelled.borrow() {
                return Hold::Cancelled;
            }
            if closed {
                return Hold::Closed;
            }
            // Woken by a membership wake or the fallback poll.
            self.rebuild_requested.store(false, Ordering::SeqCst);
            let latest = self.list_agent_pane_ids().await;
            if *cancelled.borrow() {
                return Hold::Cancelled;
            }
            match latest {
                None => {
                    self.wait(self.args.retry_delay, cancelled, true).await;
                    if *cancelled.borrow() {
                        return Hold::Cancelled;
                    }
                }
                Some(latest) if !same_pane_ids(&latest, pane_ids) => return Hold::Rebuild,
                Some(_) => {}
            }
        }
    }

    fn take_active(&self, subscription: &LoopSubscription) -> bool {
        let mut state = self.lock();
        let is_active = state
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.close, &subscription.close));
        if is_active {
            state.active = None;
        }
        is_active
    }

    async fn run(&self, mut cancelled: watch::Receiver<bool>) {
        while !*cancelled.borrow() {
            let pane_ids = self.list_agent_pane_ids().await;
            if *cancelled.borrow() {
                return;
            }
            let Some(pane_ids) = pane_ids else {
                self.wait(self.args.retry_delay, &mut cancelled, false)
                    .await;
                continue;
            };
            if pane_ids.is_empty() {
                // Nothing to subscribe to: sleep until a membership event or
                // the fallback poll, unless one came during the listing.
                if !self.rebuild_requested.load(Ordering::SeqCst) {
                    self.wait(self.args.membership_poll, &mut cancelled, true)
                        .await;
                }
                self.rebuild_requested.store(false, Ordering::SeqCst);
                continue;
            }
            let subscriptions = pane_ids
                .iter()
                .map(|pane_id| {
                    let mut map = Map::new();
                    map.insert("type".into(), json!("pane.agent_status_changed"));
                    map.insert("pane_id".into(), json!(pane_id));
                    Subscription::With(map)
                })
                .collect();
            let subscription = match self.args.herdr.subscribe(subscriptions) {
                Ok(subscription) => subscription,
                Err(error) => {
                    self.report(&self.args.on_subscribe_error, error);
                    self.wait(self.args.retry_delay, &mut cancelled, false)
                        .await;
                    continue;
                }
            };
            self.lock().active = Some(subscription.clone());
            let ready = tokio::select! {
                _ = cancelled.wait_for(|cancel| *cancel) => Err("cancelled".to_owned()),
                ready = subscription.ready.clone() => ready,
            };
            if *cancelled.borrow() {
                if self.take_active(&subscription) {
                    (subscription.close)();
                }
                return;
            }
            if let Err(error) = ready {
                if self.take_active(&subscription) {
                    (subscription.close)();
                }
                self.report(&self.args.on_subscribe_error, error);
                // The pane set may have raced the subscribe: list again.
                self.wait(self.args.retry_delay, &mut cancelled, false)
                    .await;
                continue;
            }
            // rebuild_requested stays: an event during the subscribe must
            // reach the hold's first check.
            self.log(&format!(
                "subscribed to agent status events connection={} panes={}",
                self.args.connection_id,
                pane_ids.len()
            ));
            let outcome = self
                .hold_subscription(&subscription, &pane_ids, &mut cancelled)
                .await;
            if self.take_active(&subscription) {
                (subscription.close)();
            }
            match outcome {
                Hold::Cancelled => return,
                Hold::Closed => {
                    self.wait(self.args.retry_delay, &mut cancelled, false)
                        .await
                }
                Hold::Rebuild => {}
            }
        }
    }

    pub fn start(&self) {
        let mut state = self.lock();
        if state.running || state.task.is_some() {
            return;
        }
        state.running = true;
        state.stop_task = None;
        let (cancel, cancelled) = watch::channel(false);
        state.cancel = Some(cancel.clone());
        let this = self.clone();
        let task = tokio::spawn(async move {
            this.run(cancelled).await;
            let mut state = this.lock();
            if state
                .cancel
                .as_ref()
                .is_some_and(|current| current.same_channel(&cancel))
            {
                state.running = false;
                state.cancel = None;
                state.task = None;
            }
        });
        state.task = Some(
            async move {
                let _ = task.await;
            }
            .boxed()
            .shared(),
        );
    }

    pub fn stop(&self) -> Shared<BoxFuture<'static, ()>> {
        let mut state = self.lock();
        if let Some(stop) = &state.stop_task {
            return stop.clone();
        }
        if !state.running && state.task.is_none() {
            return futures_util::future::ready(()).boxed().shared();
        }
        state.running = false;
        if let Some(cancel) = state.cancel.take() {
            let _ = cancel.send(true);
        }
        self.rebuild_requested.store(false, Ordering::SeqCst);
        if let Some(debounce) = state.debounce.take() {
            debounce.abort();
        }
        let active = state.active.take();
        let task = state.task.clone();
        let this = self.clone();
        let stop = async move {
            if let Some(task) = task {
                task.await;
            }
            this.lock().task = None;
        }
        .boxed()
        .shared();
        state.stop_task = Some(stop.clone());
        drop(state);
        if let Some(subscription) = active {
            (subscription.close)();
        }
        self.rebuild_wake.notify_waiters();
        stop
    }

    /// Feeds the client's events: membership changes rebuild.
    pub fn handle_herdr_event(&self, event: &Value) {
        let Some(name) = herdr_event_name(event) else {
            return;
        };
        if MEMBERSHIP_EVENT_TYPES.contains(&name.replace('.', "_").as_str()) {
            self.request_rebuild();
        }
    }
}

#[cfg(test)]
mod tests;

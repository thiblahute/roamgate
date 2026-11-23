//! The event subscription loop (server/src/connections/subscription-loop.ts):
//! subscribe, wait for the acknowledgement, hold until the subscription
//! closes, wait, subscribe again; `stop` cancels at any step and closes the
//! subscription it holds once. Observers can never stop the loop.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::SharedClock;
use tokio::sync::watch;

/// A subscription as the loop holds it.
#[derive(Clone)]
pub struct LoopSubscription {
    pub ready: Shared<BoxFuture<'static, Result<(), String>>>,
    pub closed: Shared<BoxFuture<'static, Result<(), String>>>,
    pub close: Arc<dyn Fn() + Send + Sync>,
}

impl LoopSubscription {
    /// The loop's view of a Herdr client subscription.
    pub fn from_herdr(subscription: roamgate_herdr::control::EventSubscription) -> Self {
        let closed = subscription.closed.clone();
        let close = subscription.clone();
        Self {
            ready: subscription.ready.clone(),
            closed: async move {
                closed.await;
                Ok(())
            }
            .boxed()
            .shared(),
            close: Arc::new(move || close.close()),
        }
    }
}

pub type Subscribe = Arc<dyn Fn() -> Result<LoopSubscription, String> + Send + Sync>;
type Callback = Arc<dyn Fn() + Send + Sync>;
type ErrorCallback = Arc<dyn Fn(String) + Send + Sync>;

/// What the loop is made of.
#[derive(Clone)]
pub struct SubscriptionLoopArgs {
    pub subscribe: Subscribe,
    pub retry_delay: Duration,
    pub on_ready: Option<Callback>,
    pub on_subscribe_error: Option<ErrorCallback>,
    pub on_subscription_closed: Option<Callback>,
    pub clock: SharedClock,
}

#[derive(Default)]
struct LoopState {
    running: bool,
    cancel: Option<watch::Sender<bool>>,
    active: Option<LoopSubscription>,
    task: Option<Shared<BoxFuture<'static, ()>>>,
    stop_task: Option<Shared<BoxFuture<'static, ()>>>,
}

/// The loop. Clones are the same loop.
#[derive(Clone)]
pub struct EventSubscriptionLoop {
    args: SubscriptionLoopArgs,
    state: Arc<Mutex<LoopState>>,
}

fn notify(callback: &Option<Callback>) {
    if let Some(callback) = callback {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback()));
    }
}

fn report(callback: &Option<ErrorCallback>, error: String) {
    if let Some(callback) = callback {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(error)));
    }
}

enum Settled {
    Done(Result<(), String>),
    Cancelled,
}

async fn settle(
    future: Shared<BoxFuture<'static, Result<(), String>>>,
    cancelled: &mut watch::Receiver<bool>,
) -> Settled {
    tokio::select! {
        biased;
        _ = cancelled.wait_for(|cancel| *cancel) => Settled::Cancelled,
        result = future => Settled::Done(result),
    }
}

impl EventSubscriptionLoop {
    pub fn new(args: SubscriptionLoopArgs) -> Self {
        Self {
            args,
            state: Arc::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LoopState> {
        self.state.lock().expect("subscription loop")
    }

    pub fn is_running(&self) -> bool {
        self.lock().running
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

    async fn wait_retry(&self, cancelled: &mut watch::Receiver<bool>) {
        if *cancelled.borrow() || self.args.retry_delay.is_zero() {
            return;
        }
        let sleep = self.args.clock.sleep(self.args.retry_delay);
        tokio::select! {
            _ = cancelled.wait_for(|cancel| *cancel) => {}
            () = sleep => {}
        }
    }

    fn current(&self, cancelled: &watch::Receiver<bool>) -> bool {
        !*cancelled.borrow()
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
        while self.current(&cancelled) {
            let subscription = match (self.args.subscribe)() {
                Ok(subscription) => subscription,
                Err(error) => {
                    if !self.current(&cancelled) {
                        return;
                    }
                    report(&self.args.on_subscribe_error, error);
                    self.wait_retry(&mut cancelled).await;
                    continue;
                }
            };
            self.lock().active = Some(subscription.clone());
            match settle(subscription.ready.clone(), &mut cancelled).await {
                Settled::Done(Ok(())) => {}
                outcome => {
                    if self.take_active(&subscription) {
                        (subscription.close)();
                    }
                    let Settled::Done(Err(error)) = outcome else {
                        return;
                    };
                    if !self.current(&cancelled) {
                        return;
                    }
                    report(&self.args.on_subscribe_error, error);
                    self.wait_retry(&mut cancelled).await;
                    continue;
                }
            }
            if !self.current(&cancelled) {
                if self.take_active(&subscription) {
                    (subscription.close)();
                }
                return;
            }
            notify(&self.args.on_ready);
            let closed = settle(subscription.closed.clone(), &mut cancelled).await;
            self.take_active(&subscription);
            match closed {
                Settled::Cancelled => return,
                _ if !self.current(&cancelled) => return,
                Settled::Done(Err(error)) => {
                    (subscription.close)();
                    report(&self.args.on_subscribe_error, error);
                }
                Settled::Done(Ok(())) => notify(&self.args.on_subscription_closed),
            }
            self.wait_retry(&mut cancelled).await;
        }
    }

    /// Stops the loop; repeated calls share one drain.
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
        stop
    }
}

#[cfg(test)]
mod tests;

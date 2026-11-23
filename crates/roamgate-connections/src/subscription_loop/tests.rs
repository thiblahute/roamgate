//! server/src/connections/subscription-loop.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};

use roamgate_base::clock::SystemClock;
use tokio::sync::oneshot;

use super::*;

type Gate = Mutex<Option<oneshot::Sender<Result<(), String>>>>;

/// A subscription the test acknowledges, fails or closes.
struct Controllable {
    subscription: LoopSubscription,
    ready: Arc<Gate>,
    closed: Arc<Gate>,
    closes: Arc<AtomicUsize>,
}

fn gate() -> (Arc<Gate>, Shared<BoxFuture<'static, Result<(), String>>>) {
    let (tx, rx) = oneshot::channel();
    (
        Arc::new(Mutex::new(Some(tx))),
        async move { rx.await.unwrap_or(Ok(())) }.boxed().shared(),
    )
}

fn open(gate: &Gate, result: Result<(), String>) {
    if let Some(tx) = gate.lock().unwrap().take() {
        let _ = tx.send(result);
    }
}

fn controllable() -> Arc<Controllable> {
    let (ready, ready_future) = gate();
    let (closed, closed_future) = gate();
    let closes = Arc::new(AtomicUsize::new(0));
    let close = {
        let (ready, closed, closes) = (ready.clone(), closed.clone(), closes.clone());
        Arc::new(move || {
            closes.fetch_add(1, Ordering::SeqCst);
            open(&ready, Err("closed before ready".into()));
            open(&closed, Ok(()));
        })
    };
    Arc::new(Controllable {
        subscription: LoopSubscription {
            ready: ready_future,
            closed: closed_future,
            close,
        },
        ready,
        closed,
        closes,
    })
}

fn args(subscribe: Subscribe, retry_ms: u64) -> SubscriptionLoopArgs {
    SubscriptionLoopArgs {
        subscribe,
        retry_delay: Duration::from_millis(retry_ms),
        on_ready: None,
        on_subscribe_error: None,
        on_subscription_closed: None,
        clock: Arc::new(SystemClock),
    }
}

async fn wait_until(predicate: impl Fn() -> bool) {
    for _ in 0..1000 {
        if predicate() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("condition not reached");
}

type Made = Arc<Mutex<Vec<Arc<Controllable>>>>;

fn making(made: &Made) -> Subscribe {
    let made = made.clone();
    Arc::new(move || {
        let next = controllable();
        made.lock().unwrap().push(next.clone());
        Ok(next.subscription.clone())
    })
}

fn nth(made: &Made, index: usize) -> Arc<Controllable> {
    made.lock().unwrap()[index].clone()
}

#[tokio::test]
async fn retries_after_subscribe_throws_synchronously() {
    let next = controllable();
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let attempts = Arc::new(AtomicUsize::new(0));
    let subscription = next.subscription.clone();
    let counter = attempts.clone();
    let mut args = args(
        Arc::new(move || {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err("sync unavailable".into());
            }
            Ok(subscription.clone())
        }),
        0,
    );
    let seen = errors.clone();
    args.on_subscribe_error = Some(Arc::new(move |error| seen.lock().unwrap().push(error)));
    let event_loop = EventSubscriptionLoop::new(args);
    event_loop.start();
    wait_until(|| attempts.load(Ordering::SeqCst) == 2).await;
    event_loop.stop().await;
    assert_eq!(*errors.lock().unwrap(), ["sync unavailable"]);
    assert_eq!(next.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stop_before_ready_closes_once_and_suppresses_callbacks_and_reconnect() {
    let made = Made::default();
    let (ready, closed, errors) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
    );
    let mut args = args(making(&made), 0);
    let counter = ready.clone();
    args.on_ready = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let counter = closed.clone();
    args.on_subscription_closed = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let counter = errors.clone();
    args.on_subscribe_error = Some(Arc::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let event_loop = EventSubscriptionLoop::new(args);
    event_loop.start();
    wait_until(|| made.lock().unwrap().len() == 1).await;
    let stopped = event_loop.stop();
    let first = nth(&made, 0);
    open(&first.ready, Ok(()));
    open(&first.closed, Ok(()));
    stopped.await;
    tokio::task::yield_now().await;
    assert_eq!(made.lock().unwrap().len(), 1);
    assert_eq!(first.closes.load(Ordering::SeqCst), 1);
    assert_eq!(ready.load(Ordering::SeqCst), 0);
    assert_eq!(closed.load(Ordering::SeqCst), 0);
    assert_eq!(errors.load(Ordering::SeqCst), 0);
    assert!(!event_loop.is_running());
}

#[tokio::test]
async fn stop_during_retry_wakes_immediately_and_prevents_another_attempt() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let (saw_tx, saw_rx) = oneshot::channel::<()>();
    let saw = Mutex::new(Some(saw_tx));
    let mut args = args(
        Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Err("unavailable".into())
        }),
        60_000,
    );
    args.on_subscribe_error = Some(Arc::new(move |_| {
        if let Some(tx) = saw.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }));
    let event_loop = EventSubscriptionLoop::new(args);
    event_loop.start();
    saw_rx.await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), event_loop.stop())
        .await
        .expect("stop wakes the retry wait");
    tokio::task::yield_now().await;
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert!(!event_loop.is_running());
}

#[tokio::test]
async fn repeated_stop_shares_the_same_drain_and_remains_idempotent() {
    let next = controllable();
    let subscription = next.subscription.clone();
    let event_loop =
        EventSubscriptionLoop::new(args(Arc::new(move || Ok(subscription.clone())), 2000));
    event_loop.start();
    tokio::task::yield_now().await;
    let first = event_loop.stop();
    let second = event_loop.stop();
    tokio::join!(first, second);
    event_loop.stop().await;
    assert_eq!(next.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retries_after_ready_and_closed_rejections_even_when_callbacks_throw() {
    let made = Made::default();
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let ready_calls = Arc::new(AtomicUsize::new(0));
    let mut args = args(making(&made), 0);
    let counter = ready_calls.clone();
    args.on_ready = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        panic!("observer ready failure");
    }));
    let seen = errors.clone();
    args.on_subscribe_error = Some(Arc::new(move |error| {
        let count = {
            let mut errors = seen.lock().unwrap();
            errors.push(error);
            errors.len()
        };
        if count == 1 {
            panic!("observer error failure");
        }
    }));
    args.on_subscription_closed = Some(Arc::new(|| panic!("observer close failure")));
    let event_loop = EventSubscriptionLoop::new(args);
    event_loop.start();
    wait_until(|| made.lock().unwrap().len() == 1).await;
    open(&nth(&made, 0).ready, Err("ready failed".into()));
    wait_until(|| made.lock().unwrap().len() == 2).await;
    open(&nth(&made, 1).ready, Ok(()));
    open(&nth(&made, 1).closed, Err("closed failed".into()));
    wait_until(|| made.lock().unwrap().len() == 3).await;
    open(&nth(&made, 2).ready, Ok(()));
    open(&nth(&made, 2).closed, Ok(()));
    wait_until(|| made.lock().unwrap().len() == 4).await;
    event_loop.stop().await;
    assert_eq!(*errors.lock().unwrap(), ["ready failed", "closed failed"]);
    assert_eq!(ready_calls.load(Ordering::SeqCst), 2);
    assert_eq!(nth(&made, 1).closes.load(Ordering::SeqCst), 1);
    assert_eq!(nth(&made, 3).closes.load(Ordering::SeqCst), 1);
}

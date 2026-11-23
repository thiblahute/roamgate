//! history-watch.test.ts, on tokio's paused clock.

use std::sync::Mutex;

use super::*;

type Ws = &'static str;
type Sent = Arc<Mutex<Vec<(Ws, Value)>>>;

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

struct Local {
    watcher: HistoryWatcher<Ws>,
    sent: Sent,
    watches: Arc<Mutex<HashMap<String, OnChange>>>,
    closed: Arc<Mutex<Vec<String>>>,
    paths: Arc<Mutex<HashMap<String, Option<String>>>>,
}

fn local(paths: &[(&str, &str)]) -> Local {
    let paths: Arc<Mutex<HashMap<String, Option<String>>>> = Arc::new(Mutex::new(
        paths
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
            .collect(),
    ));
    let sent: Sent = Arc::default();
    let watches: Arc<Mutex<HashMap<String, OnChange>>> = Arc::default();
    let closed: Arc<Mutex<Vec<String>>> = Arc::default();
    let known = paths.clone();
    let resolve: ResolvePath = Arc::new(move |params: Value| {
        let path = known
            .lock()
            .unwrap()
            .get(params["pane_id"].as_str().unwrap_or(""))
            .cloned()
            .flatten();
        Box::pin(async move { Ok(path) })
    });
    let to = sent.clone();
    let mut options = HistoryWatcherOptions::new(
        resolve,
        Arc::new(move |ws: &Ws, event: Value| to.lock().unwrap().push((*ws, event))),
    );
    let (w, c) = (watches.clone(), closed.clone());
    options.watch_local = Some(Arc::new(move |path: &str, on_change: OnChange| {
        w.lock().unwrap().insert(path.to_owned(), on_change);
        let (c, path) = (c.clone(), path.to_owned());
        Box::new(move || c.lock().unwrap().push(path))
    }));
    options.debounce = Duration::from_millis(100);
    options.reresolve = Duration::from_secs(30);
    Local {
        watcher: HistoryWatcher::new(options),
        sent,
        watches,
        closed,
        paths,
    }
}

fn event(pane: &str, path: &str) -> Value {
    json!({ "event": "agent_history.changed", "data": { "pane_id": pane, "path": path } })
}

fn paths_sent(sent: &Sent) -> Vec<String> {
    sent.lock()
        .unwrap()
        .iter()
        .map(|(_, e)| e["data"]["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_local_change_reaches_the_pane_s_subscribers_once_debounced() {
    let l = local(&[("p1", "/s/a.jsonl")]);
    assert_eq!(
        l.watcher
            .subscribe("a", &json!({ "pane_id": "p1" }))
            .await
            .unwrap(),
        json!({ "pane_id": "p1", "path": "/s/a.jsonl" })
    );
    l.watcher
        .subscribe("b", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    advance(100).await;
    l.sent.lock().unwrap().clear();
    let change = l.watches.lock().unwrap()["/s/a.jsonl"].clone();
    change();
    change();
    change();
    advance(99).await;
    assert!(l.sent.lock().unwrap().is_empty());
    advance(1).await;
    assert_eq!(
        *l.sent.lock().unwrap(),
        vec![
            ("a", event("p1", "/s/a.jsonl")),
            ("b", event("p1", "/s/a.jsonl"))
        ]
    );
    l.watcher.dispose();
}

#[tokio::test(start_paused = true)]
async fn the_last_subscriber_leaving_closes_the_watch() {
    let l = local(&[("p1", "/s/a.jsonl")]);
    l.watcher
        .subscribe("a", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    l.watcher
        .subscribe("b", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    l.watcher.unsubscribe(&"a", "p1");
    assert!(l.closed.lock().unwrap().is_empty());
    l.watcher.cleanup_ws(&"b");
    assert_eq!(*l.closed.lock().unwrap(), ["/s/a.jsonl"]);
    l.watcher.dispose();
}

#[tokio::test(start_paused = true)]
async fn a_session_moving_to_a_new_file_is_followed() {
    let l = local(&[("p1", "/s/a.jsonl")]);
    l.watcher
        .subscribe("a", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    advance(100).await;
    l.sent.lock().unwrap().clear();
    l.paths
        .lock()
        .unwrap()
        .insert("p1".into(), Some("/s/b.jsonl".into()));
    advance(30_000).await;
    advance(100).await;
    assert_eq!(*l.closed.lock().unwrap(), ["/s/a.jsonl"]);
    assert!(l.watches.lock().unwrap().contains_key("/s/b.jsonl"));
    assert_eq!(paths_sent(&l.sent), ["/s/b.jsonl"]);
    l.watcher.dispose();
}

#[tokio::test(start_paused = true)]
async fn a_history_read_that_resolved_another_file_moves_the_watch_at_once() {
    let l = local(&[("p1", "/s/a.jsonl")]);
    l.watcher
        .subscribe("a", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    advance(100).await;
    l.sent.lock().unwrap().clear();
    l.watcher.note_path("p1", Some("/s/b.jsonl"));
    l.watcher.note_path("p1", None);
    advance(100).await;
    assert_eq!(*l.closed.lock().unwrap(), ["/s/a.jsonl"]);
    assert!(l.watches.lock().unwrap().contains_key("/s/b.jsonl"));
    assert_eq!(paths_sent(&l.sent), ["/s/b.jsonl"]);
    assert_eq!(
        history_file_path(&json!({ "file": { "path": "/s/c.jsonl" } })).as_deref(),
        Some("/s/c.jsonl")
    );
    assert_eq!(
        history_file_path(&json!({ "path": "/s/d.jsonl" })).as_deref(),
        Some("/s/d.jsonl")
    );
    assert_eq!(
        history_file_path(&json!({ "file": null, "path": "" })),
        None
    );
    l.watcher.dispose();
}

struct Helper {
    paths: Vec<String>,
    on_line: Arc<dyn Fn(&str) + Send + Sync>,
    on_exit: OnChange,
    closed: Arc<Mutex<bool>>,
}

#[tokio::test(start_paused = true)]
async fn a_remote_connection_runs_one_helper_for_all_its_files() {
    let helpers: Arc<Mutex<Vec<Helper>>> = Arc::default();
    let spawned = helpers.clone();
    let spawn: SpawnRemote = Arc::new(move |paths, on_line, on_exit| {
        let closed = Arc::new(Mutex::new(false));
        spawned.lock().unwrap().push(Helper {
            paths,
            on_line,
            on_exit,
            closed: closed.clone(),
        });
        Box::new(move || *closed.lock().unwrap() = true)
    });
    let sent: Sent = Arc::default();
    let to = sent.clone();
    let resolve: ResolvePath = Arc::new(|params: Value| {
        let path = match params["pane_id"].as_str() {
            Some("p1") => Some("/r/a.jsonl".to_owned()),
            Some("p2") => Some("/r/b.jsonl".to_owned()),
            _ => None,
        };
        Box::pin(async move { Ok(path) })
    });
    let mut options = HistoryWatcherOptions::new(
        resolve,
        Arc::new(move |ws: &Ws, event: Value| to.lock().unwrap().push((*ws, event))),
    );
    options.spawn_remote = Some(spawn);
    options.debounce = Duration::from_millis(10);
    options.restart = Duration::from_millis(500);
    let watcher = HistoryWatcher::new(options);
    watcher
        .subscribe("a", &json!({ "pane_id": "p1" }))
        .await
        .unwrap();
    watcher
        .subscribe("a", &json!({ "pane_id": "p2" }))
        .await
        .unwrap();
    advance(500).await;
    let paths: Vec<Vec<String>> = helpers
        .lock()
        .unwrap()
        .iter()
        .map(|h| h.paths.clone())
        .collect();
    assert_eq!(
        paths,
        [vec!["/r/a.jsonl".to_owned(), "/r/b.jsonl".to_owned()]]
    );
    advance(10).await;
    sent.lock().unwrap().clear();
    let line = helpers.lock().unwrap()[0].on_line.clone();
    line("/r/a.jsonl\t10 100 7");
    line("/r/b.jsonl\t5 100 8");
    advance(10).await;
    assert!(sent.lock().unwrap().is_empty());
    line("/r/a.jsonl\t20 101 7");
    line("/r/b.jsonl\t5 100 8");
    advance(10).await;
    let panes: Vec<String> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, e)| e["data"]["pane_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(panes, ["p1"]);
    watcher.unsubscribe(&"a", "p2");
    advance(500).await;
    assert!(*helpers.lock().unwrap()[0].closed.lock().unwrap());
    assert_eq!(
        helpers.lock().unwrap().last().unwrap().paths,
        ["/r/a.jsonl"]
    );
    let exit = helpers.lock().unwrap().last().unwrap().on_exit.clone();
    exit();
    advance(5000).await;
    advance(500).await;
    assert_eq!(helpers.lock().unwrap().len(), 3);
    watcher.dispose();
    assert!(
        *helpers
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .closed
            .lock()
            .unwrap()
    );
}

#[tokio::test]
async fn the_default_local_watch_sees_appends_to_a_real_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    std::fs::write(&path, "{}\n").unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let close = watch_local_file(
        &path.to_string_lossy(),
        Arc::new(move || {
            let _ = tx.send(());
        }),
    );
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{}\n")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    close();
}

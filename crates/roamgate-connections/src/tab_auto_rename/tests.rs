//! server/src/connections/tab-auto-rename.test.ts.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;

#[test]
fn identifies_shell_prompts_and_shell_binaries_as_generic() {
    for title in [
        "shayani@home1:~/workspace/snsa",
        "shayani@home2: ~",
        "bash",
        "zsh",
        "agy --dangerously-skip-permissions",
        "",
        "   ",
    ] {
        assert!(is_generic_terminal_title(title), "{title}");
    }
}

#[test]
fn identifies_agent_generated_titles_as_non_generic() {
    for title in [
        "Previsão do tempo em João Pessoa",
        "Design system para o SNSA",
        "PR 2814 e feature flag",
    ] {
        assert!(!is_generic_terminal_title(title), "{title}");
    }
}

/// Herdr with tabs and panes; `tab.rename` relabels (and tells the
/// renamer, when `echo` is set).
#[derive(Default)]
struct FakeHerdr {
    tabs: Mutex<Vec<Value>>,
    panes: Mutex<Vec<Value>>,
    calls: Mutex<Vec<(String, Value)>>,
    renamed: Mutex<Vec<String>>,
    fail: AtomicBool,
    before: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    echo: OnceLock<TabAutoRenamer>,
}

impl TabHerdr for Arc<FakeHerdr> {
    fn call(
        &self,
        method: &str,
        params: Value,
        _timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> BoxFuture<Result<Value, String>> {
        let herdr = self.clone();
        let method = method.to_owned();
        Box::pin(async move {
            herdr
                .calls
                .lock()
                .unwrap()
                .push((method.clone(), params.clone()));
            match method.as_str() {
                "tab.list" => Ok(json!({"tabs": herdr.tabs.lock().unwrap().clone()})),
                "pane.list" => Ok(json!({"panes": herdr.panes.lock().unwrap().clone()})),
                "tab.rename" => {
                    if let Some(before) = herdr.before.lock().unwrap().as_ref() {
                        before();
                    }
                    if let Some(guard) = before_send {
                        guard()?;
                    }
                    if herdr.fail.load(Ordering::SeqCst) {
                        return Err("socket lost".into());
                    }
                    let label = params["label"].as_str().unwrap_or("").to_owned();
                    let tab = {
                        let mut tabs = herdr.tabs.lock().unwrap();
                        let Some(tab) = tabs
                            .iter_mut()
                            .find(|tab| tab["tab_id"] == params["tab_id"])
                        else {
                            return Ok(json!({"ok": true}));
                        };
                        tab["label"] = json!(label);
                        tab.clone()
                    };
                    herdr.renamed.lock().unwrap().push(label);
                    if let Some(renamer) = herdr.echo.get() {
                        renamer.handle_herdr_event(&json!({"event": "tab.renamed", "data": tab}));
                    }
                    Ok(json!({"ok": true}))
                }
                _ => Ok(json!({})),
            }
        })
    }
}

fn renames(herdr: &FakeHerdr) -> usize {
    herdr
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "tab.rename")
        .count()
}

struct Setup {
    renamer: TabAutoRenamer,
    herdr: Arc<FakeHerdr>,
}

fn setup(
    panes: Option<Vec<Value>>,
    tabs: Option<Vec<Value>>,
    titles: Option<Vec<(&str, &str)>>,
    enabled: bool,
    debounce_ms: u64,
) -> Setup {
    let herdr = Arc::new(FakeHerdr::default());
    *herdr.tabs.lock().unwrap() =
        tabs.unwrap_or_else(|| vec![json!({"tab_id": "tab-1", "label": "Tab 1", "number": 1})]);
    *herdr.panes.lock().unwrap() = panes.unwrap_or_else(|| {
        vec![json!({"pane_id": "pane-1", "tab_id": "tab-1", "focused": true, "agent": "claude"})]
    });
    let titles: HashMap<String, String> = titles
        .unwrap_or_else(|| vec![("pane-1", "Refactor Database")])
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect();
    let renamer = TabAutoRenamer::new(TabAutoRenamerOptions {
        herdr: Arc::new(herdr.clone()),
        title_for_pane: Arc::new(move |pane_id, _| {
            let title = titles.get(&pane_id).cloned();
            Box::pin(async move { title })
        }),
        enabled: Some(Arc::new(move || Box::pin(async move { enabled }))),
        debounce: Some(Duration::from_millis(debounce_ms)),
        poll_interval: None,
        log: None,
    });
    renamer.start();
    Setup { renamer, herdr }
}

fn default_setup() -> Setup {
    setup(None, None, None, true, 0)
}

#[tokio::test]
async fn automatically_renames_tab_when_agent_session_title_is_available() {
    let Setup { renamer, herdr } = default_setup();
    renamer.trigger_evaluation().await;
    let calls = herdr.calls.lock().unwrap().clone();
    let renames: Vec<_> = calls.iter().filter(|(m, _)| m == "tab.rename").collect();
    assert_eq!(renames.len(), 1);
    assert_eq!(
        renames[0].1,
        json!({"tab_id": "tab-1", "label": "Refactor Database"})
    );
    assert_eq!(
        herdr.tabs.lock().unwrap()[0]["label"],
        json!("Refactor Database")
    );
    renamer.dispose();
}

#[tokio::test]
async fn does_not_overwrite_manually_renamed_tabs() {
    let Setup { renamer, herdr } = default_setup();
    renamer.mark_manual_rename("tab-1", None);
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 0);
    assert_eq!(herdr.tabs.lock().unwrap()[0]["label"], json!("Tab 1"));
    renamer.dispose();
}

#[tokio::test]
async fn prioritizes_focused_pane_agent_title_over_other_panes_in_split_tab() {
    let Setup { renamer, herdr } = setup(
        Some(vec![
            json!({"pane_id": "pane-1", "tab_id": "tab-1", "focused": false, "agent": "claude"}),
            json!({"pane_id": "pane-2", "tab_id": "tab-1", "focused": true, "agent": "hermes"}),
        ]),
        None,
        Some(vec![
            ("pane-1", "Claude Session"),
            ("pane-2", "Hermes Session"),
        ]),
        true,
        0,
    );
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 1);
    assert_eq!(
        herdr.tabs.lock().unwrap()[0]["label"],
        json!("Hermes Session")
    );
    renamer.dispose();
}

#[tokio::test]
async fn falls_back_to_first_agent_pane_when_focused_pane_has_no_agent_in_split_tab() {
    let Setup { renamer, herdr } = setup(
        Some(vec![
            json!({"pane_id": "pane-1", "tab_id": "tab-1", "focused": true}),
            json!({"pane_id": "pane-2", "tab_id": "tab-1", "focused": false, "agent": "claude"}),
        ]),
        None,
        Some(vec![("pane-2", "Claude Background Task")]),
        true,
        0,
    );
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 1);
    assert_eq!(
        herdr.tabs.lock().unwrap()[0]["label"],
        json!("Claude Background Task")
    );
    renamer.dispose();
}

#[tokio::test]
async fn does_not_call_tab_rename_if_title_has_not_changed() {
    let Setup { renamer, herdr } = setup(
        None,
        Some(vec![
            json!({"tab_id": "tab-1", "label": "Already Named", "number": 1}),
        ]),
        Some(vec![("pane-1", "Already Named")]),
        true,
        0,
    );
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 0);
    renamer.dispose();
}

#[tokio::test]
async fn does_not_rename_when_disabled_via_is_enabled_setting() {
    let Setup { renamer, herdr } = setup(None, None, None, false, 0);
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 0);
    assert_eq!(herdr.tabs.lock().unwrap()[0]["label"], json!("Tab 1"));
    renamer.dispose();
}

#[tokio::test]
async fn cleans_up_state_when_tab_is_closed() {
    let Setup { renamer, .. } = default_setup();
    renamer.mark_manual_rename("tab-1", None);
    assert!(renamer.is_manually_renamed("tab-1"));
    renamer.handle_herdr_event(&json!({"event": "tab.closed", "data": {"tab_id": "tab-1"}}));
    assert!(!renamer.is_manually_renamed("tab-1"));
    renamer.dispose();
}

#[tokio::test(start_paused = true)]
async fn debounces_evaluation_on_pane_agent_detected_event() {
    let Setup { renamer, herdr } = setup(None, None, None, true, 10);
    renamer.handle_herdr_event(
        &json!({"event": "pane.agent_detected", "data": {"pane_id": "pane-1"}}),
    );
    // Before the debounce timer fires.
    tokio::task::yield_now().await;
    assert_eq!(renames(&herdr), 0);
    tokio::time::advance(Duration::from_millis(10)).await;
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 1);
    assert_eq!(
        herdr.tabs.lock().unwrap()[0]["label"],
        json!("Refactor Database")
    );
    renamer.dispose();
}

#[tokio::test(start_paused = true)]
async fn triggers_evaluation_on_pane_agent_status_changed_event() {
    let Setup { renamer, herdr } = setup(None, None, None, true, 10);
    renamer.handle_herdr_event(&json!({
        "event": "pane.agent_status_changed",
        "data": {"pane_id": "pane-1", "agent_status": "idle"},
    }));
    tokio::time::advance(Duration::from_millis(10)).await;
    renamer.trigger_evaluation().await;
    assert_eq!(renames(&herdr), 1);
    assert_eq!(
        herdr.tabs.lock().unwrap()[0]["label"],
        json!("Refactor Database")
    );
    renamer.dispose();
}

#[tokio::test]
async fn passes_candidate_pane_to_get_agent_title_for_pane() {
    let pane = json!({
        "pane_id": "p1",
        "tab_id": "t1",
        "agent": "claude",
        "terminal_title_stripped": "Stripped Title",
    });
    let herdr = Arc::new(FakeHerdr::default());
    *herdr.tabs.lock().unwrap() = vec![json!({"tab_id": "t1", "label": "Tab 1", "number": 1})];
    *herdr.panes.lock().unwrap() = vec![pane.clone()];
    let received = Arc::new(Mutex::new(Value::Null));
    let seen = received.clone();
    let renamer = TabAutoRenamer::new(TabAutoRenamerOptions {
        herdr: Arc::new(herdr.clone()),
        title_for_pane: Arc::new(move |_, pane| {
            *seen.lock().unwrap() = pane.clone();
            let title = pane
                .get("terminal_title_stripped")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Box::pin(async move { title })
        }),
        enabled: None,
        debounce: Some(Duration::ZERO),
        poll_interval: None,
        log: None,
    });
    renamer.trigger_evaluation().await;
    assert_eq!(*received.lock().unwrap(), pane);
    renamer.dispose();
}

/// The race fixture: a title lookup held until `title` is sent.
struct Race {
    renamer: TabAutoRenamer,
    herdr: Arc<FakeHerdr>,
    enabled: Arc<AtomicBool>,
    lookups: Arc<AtomicUsize>,
    entered: tokio::sync::watch::Receiver<bool>,
    title: tokio::sync::watch::Sender<Option<String>>,
}

fn race(label: &str) -> Race {
    let herdr = Arc::new(FakeHerdr::default());
    *herdr.tabs.lock().unwrap() = vec![json!({"tab_id": "t", "label": label, "number": 1})];
    *herdr.panes.lock().unwrap() =
        vec![json!({"pane_id": "p", "tab_id": "t", "agent": "claude", "focused": true})];
    let enabled = Arc::new(AtomicBool::new(true));
    let lookups = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered) = tokio::sync::watch::channel(false);
    let (title, title_rx) = tokio::sync::watch::channel::<Option<String>>(None);
    let entered_tx = Arc::new(entered_tx);
    let renamer = TabAutoRenamer::new(TabAutoRenamerOptions {
        herdr: Arc::new(herdr.clone()),
        title_for_pane: {
            let lookups = lookups.clone();
            Arc::new(move |_, _| {
                lookups.fetch_add(1, Ordering::SeqCst);
                let _ = entered_tx.send(true);
                let mut title = title_rx.clone();
                Box::pin(async move {
                    let _ = title.wait_for(Option::is_some).await;
                    title.borrow().clone()
                })
            })
        },
        enabled: {
            let enabled = enabled.clone();
            Some(Arc::new(move || {
                let on = enabled.load(Ordering::SeqCst);
                Box::pin(async move { on })
            }))
        },
        debounce: None,
        poll_interval: None,
        log: None,
    });
    let _ = herdr.echo.set(renamer.clone());
    Race {
        renamer,
        herdr,
        enabled,
        lookups,
        entered,
        title,
    }
}

impl Race {
    fn renamed(&self) -> Vec<String> {
        self.herdr.renamed.lock().unwrap().clone()
    }
    fn resolve(&self) {
        let _ = self.title.send(Some("Agent title".into()));
    }
    async fn entered(&mut self) {
        let _ = self.entered.wait_for(|entered| *entered).await;
    }
}

#[tokio::test]
async fn preserves_an_existing_custom_label_on_startup_restart() {
    let f = race("Custom Work");
    f.renamer.trigger_evaluation().await;
    assert_eq!(f.lookups.load(Ordering::SeqCst), 0);
    assert!(f.renamed().is_empty());
}

#[tokio::test]
async fn cancels_a_title_lookup_after_action() {
    for action in [
        "manual", "disable", "dispose", "settings", "focus", "external", "closed",
    ] {
        let mut f = race("Tab 1");
        let work = f.renamer.trigger_evaluation();
        f.entered().await;
        match action {
            "manual" => f.renamer.mark_manual_rename("t", None),
            "disable" => f.enabled.store(false, Ordering::SeqCst),
            "settings" => f.renamer.settings_changed(),
            "dispose" => f.renamer.dispose(),
            "focus" => f.herdr.panes.lock().unwrap()[0]["pane_id"] = json!("other"),
            "external" => f.herdr.tabs.lock().unwrap()[0]["label"] = json!("Custom Work"),
            "closed" => f.herdr.tabs.lock().unwrap().clear(),
            _ => unreachable!(),
        }
        f.resolve();
        work.await;
        assert!(f.renamed().is_empty(), "{action}");
    }
}

#[tokio::test]
async fn rechecks_manual_ownership_immediately_before_a_queued_rpc_is_sent() {
    let f = race("Tab 1");
    let renamer = f.renamer.clone();
    *f.herdr.before.lock().unwrap() = Some(Box::new(move || renamer.mark_manual_rename("t", None)));
    f.resolve();
    f.renamer.trigger_evaluation().await;
    assert!(f.renamed().is_empty());
}

#[tokio::test]
async fn retries_a_failed_rename_with_the_same_title() {
    let f = race("Tab 1");
    f.resolve();
    f.herdr.fail.store(true, Ordering::SeqCst);
    f.renamer.trigger_evaluation().await;
    f.herdr.fail.store(false, Ordering::SeqCst);
    f.renamer.trigger_evaluation().await;
    assert_eq!(f.renamed(), vec!["Agent title"]);
}

#[tokio::test]
async fn recognizes_its_own_rename_events_and_protects_later_edits_from_another_client() {
    let f = race("Tab 1");
    f.resolve();
    f.renamer.trigger_evaluation().await;
    assert!(!f.renamer.is_manually_renamed("t"));
    f.herdr.tabs.lock().unwrap()[0]["label"] = json!("Shared custom name");
    let tab = f.herdr.tabs.lock().unwrap()[0].clone();
    f.renamer
        .handle_herdr_event(&json!({"data": {"type": "tab.renamed", "tab": tab}}));
    f.renamer.trigger_evaluation().await;
    assert!(f.renamer.is_manually_renamed("t"));
    assert_eq!(f.renamed(), vec!["Agent title"]);
}

#[tokio::test]
async fn keeps_newly_numbered_default_tabs_eligible() {
    let f = race("Tab 1");
    f.renamer.mark_manual_rename("t", Some("Tab 1"));
    let tab = f.herdr.tabs.lock().unwrap()[0].clone();
    f.renamer
        .handle_herdr_event(&json!({"event": "tab.renamed", "data": tab}));
    f.resolve();
    f.renamer.trigger_evaluation().await;
    assert_eq!(f.renamed(), vec!["Agent title"]);
}

#[tokio::test]
async fn serializes_overlapping_evaluations() {
    let mut f = race("Tab 1");
    let first = f.renamer.trigger_evaluation();
    f.entered().await;
    let second = f.renamer.trigger_evaluation();
    assert_eq!(f.lookups.load(Ordering::SeqCst), 1);
    f.resolve();
    tokio::join!(first, second);
    assert_eq!(f.renamed(), vec!["Agent title"]);
}

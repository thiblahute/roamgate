use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use roamgate_base::clock::TokioClock;
use roamgate_base::paths::{DataContext, Platform};
use roamgate_work::store::{HistorySink, StoreWrites, WorkActor as StoreActor, WorkStore};
use roamgate_work::{By, WorkItem};
use serde_json::Map;

use super::*;
use crate::area::AreaRender;
use crate::work::{WorkActor, WorkArea};

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

/// Lets the runtime's blocking reads and passes (real threads) finish
/// until `done`, the paused clock still.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..2_000 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn the_debounce_runs_30_s_after_the_last_change_at_most_5_min_after_the_first() {
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = runs.clone();
    let debounce = Debounce::new(
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
        30_000,
        300_000,
        Arc::new(TokioClock::starting_at(0)),
    );
    let advance = |ms: u64| async move {
        tokio::time::advance(Duration::from_millis(ms)).await;
        settle().await;
    };
    debounce.touch();
    advance(29_999).await;
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    advance(1).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // A change every 20 s: never quiet, so the 5 minute cap runs it.
    debounce.touch();
    for _ in 0..14 {
        advance(20_000).await;
        debounce.touch();
    }
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    advance(20_000).await;
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    assert!(!debounce.pending());
    debounce.touch();
    debounce.flush();
    assert_eq!(runs.load(Ordering::SeqCst), 3);
    debounce.touch();
    debounce.cancel();
    advance(400_000).await;
    assert_eq!(runs.load(Ordering::SeqCst), 3);
}

type Passes = Arc<Mutex<Vec<(Vec<String>, bool)>>>;

/// A repo that records each pass instead of writing.
struct FakeRepo {
    dir: PathBuf,
    passes: Passes,
}

impl PassRepo for FakeRepo {
    fn dir(&self) -> &Path {
        &self.dir
    }
    fn pass(&self, input: &PassInput) -> Result<PassResult, String> {
        let names = input
            .areas
            .iter()
            .map(|(area, ids)| {
                format!(
                    "{}:{}",
                    area.name(),
                    ids.as_ref().map_or("all".into(), |ids| ids.join(","))
                )
            })
            .collect();
        self.passes.lock().unwrap().push((names, input.light));
        Ok(PassResult {
            commits: 1,
            ms: 1,
            ..PassResult::default()
        })
    }
    fn status(&self) -> RepoStatus {
        RepoStatus {
            exists: true,
            ..RepoStatus::default()
        }
    }
}

struct Named {
    name: &'static str,
    watch: Option<Vec<PathBuf>>,
}

impl HistoryArea for Named {
    fn name(&self) -> &str {
        self.name
    }
    fn watch(&self) -> Option<Vec<PathBuf>> {
        self.watch.clone()
    }
    fn render(&self, _ids: Option<&[String]>) -> Result<AreaRender, String> {
        Ok(AreaRender::default())
    }
}

fn area(name: &'static str) -> Arc<dyn HistoryArea> {
    Arc::new(Named { name, watch: None })
}

fn runtime(areas: Vec<Arc<dyn HistoryArea>>, enabled: bool, passes: &Passes) -> HistoryRuntime {
    let place = HistoryPlace {
        enabled,
        location: "/h".into(),
        default_location: "/h".into(),
    };
    let passes = passes.clone();
    let mut options = RuntimeOptions::new(
        areas,
        Arc::new(move || Ok(place.clone())),
        Arc::new(|| None),
        Arc::new(TokioClock::starting_at(0)),
    );
    options.repo = Some(Arc::new(move |dir: &Path, _host: &str| {
        Arc::new(FakeRepo {
            dir: dir.to_path_buf(),
            passes: passes.clone(),
        }) as Arc<dyn PassRepo>
    }));
    options.start_delay_ms = 1_000_000_000;
    options.poll_ms = 0;
    HistoryRuntime::new(options)
}

fn names(passes: &Passes) -> Vec<Vec<String>> {
    passes
        .lock()
        .unwrap()
        .iter()
        .map(|(names, _)| names.clone())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn changes_wait_for_the_debounce_then_one_pass_takes_the_dirty_areas() {
    let passes = Passes::default();
    let runtime = runtime(
        vec![area("work"), area("reviews"), area("settings")],
        true,
        &passes,
    );
    runtime.start();
    runtime.changed("reviews", Some("s1"));
    runtime.changed("reviews", Some("s2"));
    runtime.changed("settings", None);
    runtime.changed("unknown", None);
    tokio::time::sleep(Duration::from_millis(29_000)).await;
    settle().await;
    assert!(passes.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    until(|| !passes.lock().unwrap().is_empty()).await;
    // The first pass at a new place is a full one.
    assert_eq!(
        names(&passes),
        [["work:all", "reviews:all", "settings:all"]]
    );
    until(|| runtime.0.state.lock().unwrap().running.is_none()).await;
    runtime.changed("reviews", Some("s3"));
    tokio::time::sleep(Duration::from_millis(30_000)).await;
    until(|| passes.lock().unwrap().len() > 1).await;
    assert_eq!(names(&passes)[1], ["reviews:s3"]);
    assert_eq!(runtime.status().await.unwrap()["pending"], json!([]));
    runtime.stop().await;
}

#[tokio::test(start_paused = true)]
async fn while_a_game_runs_the_full_pass_waits_and_the_changes_go_alone() {
    let passes = Passes::default();
    let gaming = Arc::new(AtomicBool::new(true));
    let place = HistoryPlace {
        enabled: true,
        location: "/h".into(),
        default_location: "/h".into(),
    };
    let recorded = passes.clone();
    let mut options = RuntimeOptions::new(
        vec![area("work"), area("settings")],
        Arc::new(move || Ok(place.clone())),
        Arc::new(|| None),
        Arc::new(TokioClock::starting_at(0)),
    );
    options.repo = Some(Arc::new(move |dir: &Path, _host: &str| {
        Arc::new(FakeRepo {
            dir: dir.to_path_buf(),
            passes: recorded.clone(),
        }) as Arc<dyn PassRepo>
    }));
    let flag = gaming.clone();
    options.game_mode = Some(Arc::new(move || {
        let gaming = flag.load(Ordering::SeqCst);
        Box::pin(async move { Some(gaming) })
    }));
    options.start_delay_ms = 1_000_000_000;
    options.poll_ms = 0;
    let runtime = HistoryRuntime::new(options);
    runtime.changed("settings", None);
    runtime.run_pass(true, false).await;
    assert_eq!(names(&passes), [["settings:all"]]);
    assert!(passes.lock().unwrap()[0].1, "light while a game runs");
    let status = runtime.status().await.unwrap();
    assert!(status["deferred"].as_str().unwrap().contains("game"));
    gaming.store(false, Ordering::SeqCst);
    runtime.run_pass(false, false).await;
    assert_eq!(names(&passes)[1], ["work:all", "settings:all"]);
    assert_eq!(runtime.status().await.unwrap()["deferred"], Value::Null);
    // Asked for (Settings, the CLI): it does not wait.
    gaming.store(true, Ordering::SeqCst);
    runtime.commit_now().await;
    assert_eq!(names(&passes)[2], ["work:all", "settings:all"]);
    runtime.stop().await;
}

#[tokio::test(start_paused = true)]
async fn history_turned_off_drops_the_changes() {
    let passes = Passes::default();
    let runtime = runtime(vec![area("settings")], false, &passes);
    runtime.changed("settings", None);
    runtime.commit_now().await;
    assert!(passes.lock().unwrap().is_empty());
    assert_eq!(runtime.status().await.unwrap()["enabled"], false);
    runtime.stop().await;
}

#[tokio::test]
async fn a_watched_file_changed_by_hand_marks_its_area() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("voice.json");
    std::fs::write(&file, "{}").unwrap();
    let passes = Passes::default();
    let runtime = runtime(
        vec![
            Arc::new(Named {
                name: "voice",
                watch: Some(vec![file.clone()]),
            }),
            Arc::new(Named {
                name: "settings",
                watch: Some(vec![dir.path().join("none")]),
            }),
        ],
        true,
        &passes,
    );
    runtime.poll(true).await;
    std::fs::write(&file, "{\"speech_rate\":1.2}").unwrap();
    let later = std::time::SystemTime::now() + Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(later)
        .unwrap();
    runtime.poll(false).await;
    assert_eq!(runtime.status().await.unwrap()["pending"], json!(["voice"]));
    runtime.stop().await;
}

/// The Work store telling the runtime, as the core's family does.
struct ToRuntime(HistoryRuntime);

impl HistorySink for ToRuntime {
    fn changed(&self, area: &str, id: Option<&str>) {
        self.0.changed(area, id);
    }
    fn work_changed(
        &self,
        item: Option<&WorkItem>,
        id: &str,
        change: &Map<String, Value>,
        actor: &StoreActor,
        at: &str,
    ) {
        let change = WorkChange {
            item: item.map(WorkItem::to_json),
            id: id.to_owned(),
            change: change.clone(),
            actor: serde_json::from_value::<WorkActor>(serde_json::to_value(actor).unwrap())
                .unwrap(),
            at: at.to_owned(),
        };
        let description = self.0.description_of(&change);
        self.0.work_changed(&change, description.as_deref());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn each_work_change_is_its_own_commit_by_who_made_it_when() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let location = dir.join("history");
    let work_dir = dir.join("work");
    let place = HistoryPlace {
        enabled: true,
        location: location.clone(),
        default_location: location.clone(),
    };
    let mut options = RuntimeOptions::new(
        vec![Arc::new(WorkArea {
            work: work_dir.clone(),
            reviews: Arc::new(|| None),
        })],
        Arc::new(move || Ok(place.clone())),
        Arc::new(|| None),
        Arc::new(roamgate_base::clock::SystemClock),
    );
    options.host = "desk".into();
    options.start_delay_ms = 1_000_000_000;
    options.poll_ms = 0;
    let runtime = HistoryRuntime::new(options);
    runtime.start();
    let context = DataContext::new(dir, Platform::Unix, None);
    let mut store = WorkStore::open(
        &work_dir,
        StoreWrites::Disk {
            context,
            can_write: None,
        },
        Arc::new(ToRuntime(runtime.clone())),
        Arc::new(|| "2026-11-21T09:15:00.000Z".to_owned()),
    );
    let item = WorkItem {
        id: "1111222233334444".into(),
        project: "roamgate".into(),
        title: "Keep history".into(),
        state: "open".into(),
        tags: Vec::new(),
        owner: None,
        source: None,
        links: Vec::new(),
        created_at: "2026-11-20T08:00:00.000Z".into(),
        updated_at: "2026-11-20T08:00:00.000Z".into(),
        done_at: None,
        by: By::User,
        review: None,
        needs_triage: false,
        ask: None,
        answers: None,
        questions: None,
    };
    let state = |value: &str| json!({"state": value}).as_object().unwrap().clone();
    store
        .save_item(item.clone(), Some(&state("open")), None)
        .unwrap();
    let mut doing = item.clone();
    doing.state = "doing".into();
    doing.by = By::Agent;
    doing.updated_at = "2026-11-21T09:15:00.000Z".into();
    store
        .save_item(
            doing,
            Some(&state("doing")),
            Some(&StoreActor {
                by: By::Agent,
                address: Some("desktop/w2:p3".into()),
                caller: Some("Claude in roamgate".into()),
            }),
        )
        .unwrap();
    store
        .remove_item(&item.id, Some(&StoreActor::of(By::User)))
        .unwrap();
    let result = runtime.commit_now().await.unwrap();
    assert_eq!(result.errors, []);
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&location)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    let log = git(&[
        "log",
        "--format=%an|%ae|%aI|%s",
        "--",
        "work/items/1111222233334444.md",
    ]);
    let lines: Vec<&str> = log.trim().split('\n').collect();
    assert_eq!(lines.len(), 3, "{log}");
    assert!(
        lines[0].ends_with("|work 11112222: removed"),
        "{}",
        lines[0]
    );
    assert_eq!(
        lines[1],
        "Claude (desktop/w2:p3)|agent@desk|2026-11-21T09:15:00Z|work 11112222: state doing \"Keep history\""
    );
    assert!(
        lines[2].ends_with("|work 11112222: state open \"Keep history\""),
        "{}",
        lines[2]
    );
    // The batch after them: the store's history and nothing of the item.
    let batch = git(&["log", "-1", "--format=%an|%s"]);
    assert!(batch.starts_with("Roamgate|work: its history"), "{batch}");
    runtime.stop().await;
}

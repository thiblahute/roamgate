use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use roamgate_base::clock::TokioClock;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::companion::claude::fake;
use crate::config::VoiceConfig;

use super::*;

fn answering(text: &'static str) -> Compact {
    Arc::new(move |_, _| async move { Ok(text.to_owned()) }.boxed())
}

struct Setup {
    _root: tempfile::TempDir,
    path: PathBuf,
    memory: CompanionMemory,
    options: MemoryOptions,
}

impl Setup {
    fn make(&self) -> CompanionMemory {
        CompanionMemory::new(self.options.clone())
    }
}

fn setup_with(compact: Compact, extra: impl FnOnce(&mut MemoryOptions)) -> Setup {
    let root = tempfile::tempdir().unwrap();
    let path = companion_memory_path(root.path());
    let mut options = MemoryOptions::new(path.clone(), compact);
    extra(&mut options);
    let memory = CompanionMemory::new(options.clone());
    Setup {
        _root: root,
        path,
        memory,
        options,
    }
}

fn setup(compact: Compact) -> Setup {
    setup_with(compact, |_| {})
}

/// A summary the test finishes.
fn held() -> (Compact, Arc<Mutex<Option<oneshot::Sender<String>>>>) {
    let finish: Arc<Mutex<Option<oneshot::Sender<String>>>> = Arc::default();
    let kept = finish.clone();
    let compact: Compact = Arc::new(move |_, _| {
        let (tx, rx) = oneshot::channel();
        *kept.lock().unwrap() = Some(tx);
        async move { rx.await.map_err(|e| e.to_string()) }.boxed()
    });
    (compact, finish)
}

fn said(text: &str) -> Note {
    Note::new(MemoryKind::Heard, text)
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn keeps_nothing_at_first_no_memory_block() {
    let Setup { memory, .. } = setup(answering("A summary."));
    assert_eq!(memory.block(), "");
    assert_eq!(memory.epoch(), 0);
}

#[tokio::test]
async fn a_calls_words_come_back_after_a_restart() {
    let setup = setup(answering("A summary."));
    setup.memory.record(said("lance les tests"));
    setup
        .memory
        .record(Note::new(MemoryKind::Work, "lance les tests").by("roamgate"));
    setup
        .memory
        .record(Note::new(MemoryKind::Said, "Je lance les tests."));
    setup.memory.flush().unwrap();
    let back = setup.make();
    assert_eq!(back.entries().len(), 3);
    assert!(back.block().contains(r#"the user: "lance les tests""#));
    assert!(back.block().contains("you gave roamgate:"));
}

#[tokio::test]
async fn the_block_is_bounded_whatever_is_kept() {
    let Setup { memory, .. } = setup(Arc::new(|_, _| std::future::pending().boxed()));
    for at in 0..MAX_ENTRIES * 3 {
        memory.record(said(&format!("mot {at} {}", "x".repeat(2000))));
    }
    assert!(memory.entries().len() <= MAX_ENTRIES);
    let block = memory.block();
    assert_eq!(
        block.split('\n').filter(|l| l.starts_with("- ")).count(),
        BLOCK_ENTRIES
    );
    assert!(js::len16(&block) < 3700);
}

#[tokio::test]
async fn the_end_of_a_call_folds_the_log_into_the_summary() {
    let prompt: Arc<Mutex<String>> = Arc::default();
    let kept = prompt.clone();
    let setup = setup(Arc::new(move |text, _| {
        *kept.lock().unwrap() = text;
        async { Ok("  Ils ont lancé les tests de roamgate. ".to_owned()) }.boxed()
    }));
    setup.memory.record(said("lance les tests"));
    setup.memory.call_ended();
    settle().await;
    let prompt = prompt.lock().unwrap().clone();
    assert!(prompt.contains("Memory so far:\n(nothing yet)"));
    assert!(prompt.contains(r#"the user: "lance les tests""#));
    assert_eq!(
        setup.memory.summary(),
        "Ils ont lancé les tests de roamgate."
    );
    assert!(setup.memory.entries().is_empty());
    setup.memory.flush().unwrap();
    assert_eq!(
        setup.make().summary(),
        "Ils ont lancé les tests de roamgate."
    );
}

#[tokio::test]
async fn what_is_said_during_a_summary_stays_after_it() {
    let (compact, finish) = held();
    let Setup { memory, .. } = setup(compact);
    memory.record(said("premier"));
    memory.call_ended();
    memory.record(said("deuxième"));
    finish
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send("résumé".into())
        .unwrap();
    settle().await;
    assert_eq!(memory.summary(), "résumé");
    assert_eq!(
        memory
            .entries()
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>(),
        ["deuxième"]
    );
}

#[tokio::test]
async fn a_failed_summary_keeps_the_log() {
    let Setup { memory, .. } = setup(Arc::new(|_, _| {
        async { Err("no model".to_owned()) }.boxed()
    }));
    memory.record(said("garde ça"));
    memory.call_ended();
    settle().await;
    assert_eq!(memory.entries().len(), 1);
    assert_eq!(memory.summary(), "");
}

#[tokio::test]
async fn a_summary_is_capped() {
    let Setup { memory, .. } = setup(Arc::new(|_, _| {
        async { Ok("y".repeat(MAX_SUMMARY_CHARS * 2)) }.boxed()
    }));
    memory.record(said("parle"));
    memory.call_ended();
    settle().await;
    assert_eq!(js::len16(&memory.summary()), MAX_SUMMARY_CHARS);
}

#[tokio::test]
async fn a_corrupted_file_starts_fresh_kept_aside() {
    let root = tempfile::tempdir().unwrap();
    let path = companion_memory_path(root.path());
    std::fs::write(&path, "{ not json").unwrap();
    let memory = CompanionMemory::new(MemoryOptions::new(path.clone(), answering("")));
    assert_eq!(memory.block(), "");
    assert!(PathBuf::from(format!("{}.corrupt", path.display())).exists());
    memory.record(said("ça marche encore"));
    memory.flush().unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["log"].as_array().unwrap().len(), 1);
    // Bun's bytes: JSON.stringify, no newline.
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.starts_with(
            r#"{"version":1,"epoch":0,"summary":"","summarized_at":0,"log":[{"seq":1,"#
        )
    );
    assert!(text.ends_with("}]}"));
}

#[tokio::test]
async fn a_file_of_the_wrong_shape_starts_fresh() {
    let root = tempfile::tempdir().unwrap();
    let path = companion_memory_path(root.path());
    std::fs::write(&path, json!({"version": 9, "summary": 3}).to_string()).unwrap();
    let memory = CompanionMemory::new(MemoryOptions::new(path, answering("")));
    assert_eq!(memory.summary(), "");
}

#[tokio::test]
async fn entries_that_make_no_sense_are_dropped_the_summary_clipped() {
    let root = tempfile::tempdir().unwrap();
    let path = companion_memory_path(root.path());
    std::fs::write(
        &path,
        json!({
            "version": 1,
            "epoch": 2,
            "summary": "z".repeat(MAX_SUMMARY_CHARS + 500),
            "summarized_at": 1,
            "log": [
                {"seq": 1, "at": 1, "kind": "heard", "text": "bon"},
                {"at": "x", "kind": "heard", "text": "non"},
                {"at": 1, "kind": "nope", "text": "non"},
            ],
        })
        .to_string(),
    )
    .unwrap();
    let memory = CompanionMemory::new(MemoryOptions::new(path, answering("")));
    assert_eq!(memory.epoch(), 2);
    assert_eq!(js::len16(&memory.summary()), MAX_SUMMARY_CHARS);
    assert_eq!(memory.entries().len(), 1);
}

#[tokio::test]
async fn reset_forgets_all_keeps_counting_drops_a_summary_in_progress() {
    let (compact, finish) = held();
    let setup = setup(compact);
    setup.memory.record(said("secret"));
    setup.memory.call_ended();
    assert_eq!(setup.memory.reset(), 1);
    finish
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send("résumé d'avant".into())
        .unwrap();
    settle().await;
    assert_eq!(setup.memory.block(), "");
    setup.memory.flush().unwrap();
    let back = setup.make();
    assert_eq!(back.epoch(), 1);
    assert_eq!(back.block(), "");
    assert!(setup.path.exists());
}

#[tokio::test]
async fn the_same_answer_heard_twice_is_one_entry_and_gets_its_author() {
    let Setup { memory, .. } = setup(answering("A summary."));
    memory.record(Note::new(MemoryKind::Answer, "Les tests passent."));
    memory.record(Note::new(MemoryKind::Answer, "Les tests passent.").by("roamgate"));
    let entries = memory.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].who.as_deref(), Some("roamgate"));
}

#[tokio::test]
async fn on_compacted_tells_why_and_a_long_log_compacts_on_its_own() {
    let reasons: Arc<Mutex<Vec<CompactReason>>> = Arc::default();
    let kept = reasons.clone();
    let Setup { memory, .. } = setup_with(answering("résumé"), move |options| {
        options.on_compacted = Some(Arc::new(move |reason| kept.lock().unwrap().push(reason)));
    });
    for at in 0..60 {
        memory.record(said(&format!("phrase {at}")));
    }
    settle().await;
    assert_eq!(*reasons.lock().unwrap(), [CompactReason::Size]);
}

fn front(value: Value) -> ReadConfig {
    Arc::new(move || {
        Ok(VoiceConfig {
            raw: value.as_object().unwrap().clone(),
        })
    })
}

fn plain() -> ResolveCommand {
    Arc::new(|explicit: Option<&str>| ClaudeCommand::program(explicit.unwrap_or("claude")))
}

#[tokio::test]
async fn summarizes_on_a_session_of_its_own_stopped_afterwards() {
    let claude = fake::Claude::new(|_| "La mémoire.".into());
    let spawn = claude.spawn();
    let compact = front_compaction(
        front(json!({"front_model": "opus"})),
        plain(),
        Arc::new(move |_, _, _| spawn()),
        COMPACT_TIMEOUT_MS,
        Arc::new(SystemClock),
    );
    assert_eq!(
        compact("prompt".into(), false).await.unwrap(),
        "La mémoire."
    );
    assert!(claude.started.lock().unwrap()[0].1.is_cancelled());
}

#[tokio::test]
async fn without_a_front_it_refuses() {
    let compact = front_compaction(
        front(json!({})),
        plain(),
        Arc::new(|_, _, _| fake::silent()()),
        COMPACT_TIMEOUT_MS,
        Arc::new(SystemClock),
    );
    assert!(compact("prompt".into(), false).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn past_its_timeout_it_refuses() {
    let compact = front_compaction(
        front(json!({"front_model": "opus"})),
        plain(),
        Arc::new(|_, _, _| fake::silent()()),
        5,
        Arc::new(TokioClock::starting_at(0)),
    );
    assert!(
        compact("prompt".into(), false)
            .await
            .unwrap_err()
            .contains("too long")
    );
}

#[tokio::test]
async fn a_reset_leaves_the_memory_directory_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let files = CompanionMemoryFiles::new(dir.path().join("companion-memories"));
    std::fs::write(files.dir.join("MEMORY.md"), "- [Cat](cat.md) - the cat\n").unwrap();
    std::fs::write(
        files.dir.join("cat.md"),
        "---\nname: Cat\ndescription: the cat\ntype: user\n---\nA cat.\n",
    )
    .unwrap();
    let names = || {
        let mut names: Vec<String> = std::fs::read_dir(&files.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    };
    let before = names();
    let mut options = MemoryOptions::new(dir.path().join("memory.json"), answering("summary"));
    options.files = Some(files.clone());
    let memory = CompanionMemory::new(options);
    memory.record(Note::new(MemoryKind::Heard, "hello"));
    memory.reset();
    settle().await;
    assert_eq!(names(), before);
    assert!(
        std::fs::read_to_string(files.dir.join("cat.md"))
            .unwrap()
            .contains("A cat")
    );
    assert_eq!(
        files
            .list()
            .iter()
            .map(|m| m.file.as_str())
            .collect::<Vec<_>>(),
        ["cat.md"]
    );
}

type Calls = Arc<Mutex<Vec<(String, bool)>>>;

fn recording() -> (Compact, Calls) {
    let calls: Calls = Arc::default();
    let kept = calls.clone();
    let compact: Compact = Arc::new(move |prompt, writes| {
        kept.lock().unwrap().push((prompt, writes));
        async { Ok("summary".to_owned()) }.boxed()
    });
    (compact, calls)
}

#[tokio::test]
async fn forget_asks_a_writing_compaction_with_what_to_forget() {
    let (compact, calls) = recording();
    let Setup { memory, .. } = setup(compact);
    memory.forget("que je préfère le thé");
    settle().await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].1);
    assert!(calls[0].0.contains("To forget"));
    assert!(calls[0].0.contains("que je préfère le thé"));
}

#[tokio::test]
async fn the_block_stays_short_however_long_the_summary() {
    let Setup { memory, .. } = setup(answering("x"));
    memory.set_summary(&"ligne\n".repeat(2000));
    assert!(js::len16(&memory.block()) < 2000);
}

#[tokio::test]
async fn a_compaction_of_size_alone_does_not_write() {
    let (compact, calls) = recording();
    let Setup { memory, .. } = setup(compact);
    for i in 0..60 {
        memory.record(Note::new(MemoryKind::Heard, format!("line {i}")));
    }
    settle().await;
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.1)
            .collect::<Vec<_>>(),
        [false]
    );
}

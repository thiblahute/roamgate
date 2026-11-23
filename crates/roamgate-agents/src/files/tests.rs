//! session-file-access.test.ts: the host is a fake, or this machine (the
//! remote commands run here through bash).

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

#[test]
fn reads_remote_metadata_and_names() {
    let file = parse_remote_metadata("12\t1700000000\tL3RtcC94Lmpzb25s\t5:6\tc").unwrap();
    assert_eq!(file.path, "/tmp/x.jsonl");
    assert_eq!(file.size, Some(12.0));
    assert_eq!(file.mtime_ms, 1_700_000_000_000.0);
    assert!(validate_codex_session_id("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b").is_ok());
}

const REMOTE: &str = "/srv/herdr-gui-test/sessions/pi-session.jsonl";

fn metadata() -> String {
    // base64 of REMOTE
    format!(
        "42\t1784872800\t{}\t1:42\t1784872800.123:1784872800.456\n",
        "L3Nydi9oZXJkci1ndWktdGVzdC9zZXNzaW9ucy9waS1zZXNzaW9uLmpzb25s"
    )
}

type Answer = Box<dyn Fn(&[String]) -> RunOutput + Send + Sync>;

/// A host answering each command with `answer`, keeping the commands.
struct Fake {
    answer: Answer,
    commands: Mutex<Vec<Vec<String>>>,
}

impl Fake {
    fn new(answer: impl Fn(&[String]) -> RunOutput + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            answer: Box::new(answer),
            commands: Mutex::new(Vec::new()),
        })
    }
    fn lasts(&self) -> Vec<String> {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.last().cloned().unwrap_or_default())
            .collect()
    }
}

impl HostRunner for Fake {
    fn run(&self, argv: Vec<String>, _timeout_ms: u64) -> BoxFut<'_, Result<RunOutput, String>> {
        let output = (self.answer)(&argv);
        self.commands.lock().unwrap().push(argv);
        Box::pin(async move { Ok(output) })
    }
}

fn out(code: i32, stdout: &str) -> RunOutput {
    RunOutput {
        code,
        stdout: stdout.as_bytes().to_vec(),
        stderr: String::new(),
    }
}

#[tokio::test]
async fn reads_reported_session_files_through_ssh() {
    let host = Fake::new(|argv| {
        let command = argv.last().unwrap();
        if command.contains("head -c") && !command.contains("known=") {
            out(0, "{\"type\":\"session\"}\n")
        } else if command.contains("cat ") {
            out(0, "{\"type\":\"session\"}\n{\"type\":\"message\"}\n")
        } else {
            out(0, &format!("+{}", metadata()))
        }
    });
    let files = RemoteSessionFiles::new(host.clone());
    assert_eq!(
        files.stat_file(REMOTE).await.unwrap(),
        Some(SessionFile {
            path: REMOTE.into(),
            size: Some(42.0),
            mtime_ms: 1_784_872_800_000.0,
            identity: Some("1:42".into()),
            change_token: Some("1784872800.123:1784872800.456".into()),
            ..Default::default()
        })
    );
    assert_eq!(
        String::from_utf8(files.read_prefix(REMOTE, 20).await.unwrap()).unwrap(),
        "{\"type\":\"session\"}\n"
    );
    assert!(
        String::from_utf8(files.read_download(REMOTE).await.unwrap())
            .unwrap()
            .contains("\"type\":\"message\"")
    );
    // The host runs them: Bun's host.run puts them through the
    // connection's SSH (BatchMode, StrictHostKeyChecking) as its own.
    let commands = host.commands.lock().unwrap().clone();
    assert!(commands.iter().all(|c| c[0] == "bash"));
}

#[tokio::test]
async fn returns_null_when_a_remote_session_file_is_missing() {
    let host = Fake::new(|argv| {
        if argv[1] == "-c" {
            out(0, "-\n")
        } else {
            out(44, "")
        }
    });
    let files = RemoteSessionFiles::new(host);
    assert_eq!(files.stat_file(REMOTE).await.unwrap(), None);
    assert_eq!(files.find_pi_session_by_id("missing").await.unwrap(), None);
}

#[tokio::test]
async fn finds_a_remote_claude_session_by_id_following_linked_project_folders() {
    let host = Fake::new(|_| out(44, ""));
    let files = RemoteSessionFiles::new(host.clone());
    assert_eq!(
        files
            .find_claude_session_by_id("8b7109b8-e5d2-4744-ac9a-9a8c7d2dd3dc")
            .await
            .unwrap(),
        None
    );
    let commands = host.lasts();
    assert!(commands[0].contains("find -L "));
    assert!(commands[0].contains("CLAUDE_CONFIG_DIR"));
    assert_eq!(files.find_claude_session_by_id("../x").await.unwrap(), None);
    assert_eq!(host.lasts().len(), 1);
}

#[tokio::test]
async fn finds_a_claude_session_in_a_project_folder_that_is_a_link() {
    let host = Fake::new(|_| out(44, ""));
    let files = RemoteSessionFiles::new(host.clone());
    files
        .find_claude_session_by_id("8b7109b8-e5d2-4744-ac9a-9a8c7d2dd3dc")
        .await
        .unwrap();
    assert!(host.lasts()[0].contains("find -L "));
}

/// This machine as the host, its outputs' sizes kept.
struct Local {
    outputs: Mutex<Vec<usize>>,
}

impl HostRunner for Local {
    fn run(&self, argv: Vec<String>, _timeout_ms: u64) -> BoxFut<'_, Result<RunOutput, String>> {
        Box::pin(async move {
            // No login shell here: the user's profile is not the test's.
            let mut argv = argv;
            if argv.get(1).map(String::as_str) == Some("-lc") {
                argv[1] = "-c".into();
            }
            let output = tokio::process::Command::new(&argv[0])
                .args(&argv[1..])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            self.outputs.lock().unwrap().push(output.stdout.len());
            Ok(RunOutput {
                code: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        })
    }
}

fn local(budget: usize) -> (Arc<Local>, Arc<RemoteSessionFiles>) {
    let host = Arc::new(Local {
        outputs: Mutex::new(Vec::new()),
    });
    (host.clone(), RemoteSessionFiles::with_budget(host, budget))
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn reads_again_only_what_was_appended_to_a_remote_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let p = path.to_string_lossy().into_owned();
    let (host, files) = local(KEPT_TEXT_BYTES);
    let first = "{\"text\":\"é\"}\n".repeat(1000);
    std::fs::write(&path, &first).unwrap();
    assert_eq!(files.read_text(&p).await.unwrap(), first);
    append(&path, "{\"text\":\"more\"}\n");
    assert_eq!(
        files.read_text(&p).await.unwrap(),
        format!("{first}{{\"text\":\"more\"}}\n")
    );
    assert!(host.outputs.lock().unwrap()[1] < 5000);
    let rewritten = first.replace('é', "e");
    std::fs::write(&path, &rewritten).unwrap();
    assert_eq!(files.read_text(&p).await.unwrap(), rewritten);
    let corrected = format!("X{}{{\"text\":\"after edit\"}}\n", &rewritten[1..]);
    std::fs::write(&path, &corrected).unwrap();
    assert_eq!(files.read_text(&p).await.unwrap(), corrected);
    std::fs::write(&path, "{\"text\":\"short\"}\n").unwrap();
    assert_eq!(files.read_text(&p).await.unwrap(), "{\"text\":\"short\"}\n");
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_remote_transcripts_within_its_byte_budget() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.jsonl").to_string_lossy().into_owned();
    let b = dir.path().join("b.jsonl").to_string_lossy().into_owned();
    let (host, files) = local(10_000);
    std::fs::write(&a, "a".repeat(6000)).unwrap();
    std::fs::write(&b, "b".repeat(6000)).unwrap();
    files.read_text(&a).await.unwrap();
    files.read_text(&b).await.unwrap();
    files.read_text(&a).await.unwrap();
    assert!(host.outputs.lock().unwrap()[2] > 6000);
    files.read_text(&a).await.unwrap();
    assert!(host.outputs.lock().unwrap()[3] < 5000);
}

#[cfg(unix)]
#[tokio::test]
async fn stats_asked_together_share_one_ssh_command() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a b.jsonl").to_string_lossy().into_owned();
    let b = dir.path().join("b'q.jsonl").to_string_lossy().into_owned();
    let missing = dir
        .path()
        .join("missing.jsonl")
        .to_string_lossy()
        .into_owned();
    let folder = dir.path().to_string_lossy().into_owned();
    let (host, files) = local(KEPT_TEXT_BYTES);
    std::fs::write(&a, "a".repeat(12)).unwrap();
    std::fs::write(&b, "b".repeat(34)).unwrap();
    let (first, again, second, gone, dir_stat) = tokio::join!(
        files.stat_file(&a),
        files.stat_file(&a),
        files.stat_file(&b),
        files.stat_file(&missing),
        files.stat_file(&folder),
    );
    assert_eq!(host.outputs.lock().unwrap().len(), 1);
    let first = first.unwrap().unwrap();
    assert_eq!((first.path.as_str(), first.size), (a.as_str(), Some(12.0)));
    assert!(
        Regex::new(r"^\d+:\d+$")
            .unwrap()
            .is_match(first.identity.as_deref().unwrap())
    );
    assert!(first.change_token.as_deref().is_some_and(|t| !t.is_empty()));
    assert_eq!(again.unwrap().unwrap(), first);
    let second = second.unwrap().unwrap();
    assert_eq!(
        (second.path.as_str(), second.size),
        (b.as_str(), Some(34.0))
    );
    assert_eq!(gone.unwrap(), None);
    assert_eq!(dir_stat.unwrap(), None);
    append(Path::new(&a), "more");
    assert_eq!(files.stat_file(&a).await.unwrap().unwrap().size, Some(16.0));
    assert_eq!(host.outputs.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_failed_stat_batch_fails_each_of_its_stats() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let host = Fake::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        RunOutput {
            code: 255,
            stdout: Vec::new(),
            stderr: "refused".into(),
        }
    });
    let files = RemoteSessionFiles::new(host);
    let (a, b) = tokio::join!(files.stat_file("/a.jsonl"), files.stat_file("/b.jsonl"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(a.is_err() && b.is_err());
}

#[tokio::test]
async fn a_remote_pi_directory_search_names_only_a_safe_directory() {
    let host = Fake::new(|_| out(44, ""));
    let files = RemoteSessionFiles::new(host.clone());
    assert_eq!(
        files
            .find_pi_session_for_cwd("/a/$(rm -rf ~)")
            .await
            .unwrap(),
        None
    );
    assert!(host.lasts().is_empty());
    assert_eq!(
        files.find_pi_session_for_cwd("/srv/app").await.unwrap(),
        None
    );
    assert!(host.lasts()[0].contains("/sessions/--srv-app--"));
}

#[test]
fn pi_names_a_directory_s_sessions_after_its_path() {
    assert_eq!(
        pi_session_directory_name("/home/user/src/my-app.example.com/pi").as_deref(),
        Some("--home-user-src-my-app.example.com-pi--")
    );
    assert_eq!(pi_session_directory_name("relative/path"), None);
    assert_eq!(pi_session_directory_name("/a/\"b"), None);
    assert_eq!(pi_session_directory_name("/a/$(rm)"), None);
}

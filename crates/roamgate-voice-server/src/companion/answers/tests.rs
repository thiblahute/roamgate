use std::time::{Duration, SystemTime};

use super::*;

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
}

#[tokio::test]
async fn a_short_one_is_given_whole_as_it_is() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("voice-answers");
    let text = "x".repeat(LONG_ANSWER_CHARS);
    assert_eq!(
        answer_for_front(&text, &dir, now_ms()).await,
        FrontAnswer { text, file: None }
    );
    assert!(!dir.exists());
}

#[tokio::test]
async fn a_long_one_is_its_start_and_the_file_where_it_is_whole() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("voice-answers");
    // The answer of the 2026-11-20 call: 21k characters, cut at 12000.
    let paragraph = "Nicolas répond point par point à slomo. ".repeat(10);
    let text = (0..60)
        .map(|at| format!("{at}. {paragraph}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    assert!(len16(&text) > 20_000);
    let given = answer_for_front(&text, &dir, now_ms()).await;
    let file = given.file.clone().unwrap();
    assert_eq!(file.parent(), Some(dir.as_path()));
    assert!(
        file.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("answer-")
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert!(len16(&given.text) < LONG_ANSWER_CHARS);
    assert!(given.text.starts_with("0. Nicolas"));
    assert!(given.text.contains(&format!(
        "{} characters in all, given here only to that point. It is whole in {}",
        len16(&text),
        file.display()
    )));
    // The same answer told again keeps its file.
    assert_eq!(
        answer_for_front(&text, &dir, now_ms()).await.file,
        Some(file)
    );
}

#[test]
fn its_start_ends_with_a_paragraph_or_a_sentence() {
    assert_eq!(
        answer_start(
            &format!("{}\n\n{}", "a".repeat(2000), "b".repeat(2000)),
            START_CHARS
        ),
        "a".repeat(2000)
    );
    assert!(answer_start(&"Phrase un. ".repeat(400), START_CHARS).ends_with("un."));
}

#[tokio::test]
async fn files_older_than_a_day_go_when_another_is_written() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("voice-answers");
    let old = answer_for_front(&"o".repeat(5000), &dir, now_ms())
        .await
        .file
        .unwrap();
    let stale = SystemTime::now() - Duration::from_millis(ANSWER_FILE_MS as u64 + 60_000);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(stale)
        .unwrap();
    std::fs::write(dir.join("kept.md"), "recent").unwrap();
    answer_for_front(&"n".repeat(5000), &dir, now_ms()).await;
    assert!(!old.exists());
    assert!(dir.join("kept.md").exists());
}

use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use roamgate_base::clock::TokioClock;
use serde_json::json;

use crate::companion::claude::fake;

use super::*;

type Prompts = Arc<Mutex<Vec<String>>>;

/// A model that answers each prompt with `answer(prompt)`, and keeps them.
fn fake_ask(
    answer: impl Fn(&str) -> CleanerReply + Send + Sync + 'static,
) -> (CleanerAsk, Prompts) {
    let prompts: Prompts = Arc::default();
    let kept = prompts.clone();
    let ask: CleanerAsk = Arc::new(move |prompt: String, _| {
        kept.lock().unwrap().push(prompt.clone());
        let reply = answer(&prompt);
        async move { Ok(reply) }.boxed()
    });
    (ask, prompts)
}

/// The text after the last "Rest: " or "PIECE\n" of a prompt.
fn asked(prompt: &str) -> String {
    if let Some(rest) = prompt.rfind("Rest: ") {
        return prompt[rest + 6..].to_owned();
    }
    prompt[prompt.rfind("PIECE\n").map_or(0, |at| at + 6)..].to_owned()
}

fn text(text: impl Into<String>) -> CleanerReply {
    CleanerReply {
        text: Some(text.into()),
        ..CleanerReply::default()
    }
}

fn cleaned(text: &str, for_agent: bool) -> Cleaned {
    Cleaned {
        text: text.into(),
        for_agent,
    }
}

#[test]
fn splits_after_end_punctuation_keeping_it() {
    assert_eq!(
        sentences("Okay. So um what now? Let's go"),
        vec!["Okay.", "So um what now?", "Let's go"]
    );
    assert_eq!(sentences(""), Vec::<String>::new());
}

#[test]
fn reads_the_json_object_around_any_other_text() {
    assert_eq!(
        parse_cleaner_reply("```json\n{\"for_agent\": false, \"text\": \"Hi\"}\n```").unwrap(),
        CleanerReply {
            for_agent: Some(false),
            text: Some("Hi".into()),
            fixes: vec![],
        }
    );
    assert!(parse_cleaner_reply("no").is_err());
}

#[tokio::test]
async fn cleans_the_end_alone_when_nothing_settled_before() {
    let (ask, prompts) = fake_ask(|prompt| CleanerReply {
        for_agent: Some(true),
        ..text(asked(prompt).replacen("um ", "", 1))
    });
    let session = CleanSession::new(ask, "Agent: Want it?");
    assert_eq!(
        session.final_text("Yes um do it.").await,
        cleaned("Yes do it.", true)
    );
    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("Agent: Want it?"));
    assert!(prompts[0].contains("END\nCleaned so far: \nRest: Yes um do it."));
}

#[tokio::test]
async fn cleans_settled_sentences_while_the_rest_is_said() {
    let (ask, prompts) = fake_ask(|prompt| text(asked(prompt).replace("uh ", "")));
    let session = CleanSession::new(ask, "");
    session.partial("First uh one. Second", false);
    // Not settled until it reads the same twice.
    assert!(prompts.lock().unwrap().is_empty());
    session.partial("First uh one. Second uh one", false);
    assert_eq!(*prompts.lock().unwrap(), vec!["PIECE\nFirst uh one."]);
    let result = session.final_text("First uh one. Second uh one.").await;
    assert_eq!(
        prompts.lock().unwrap()[1],
        "END\nCleaned so far: First one.\nRest: Second uh one."
    );
    assert_eq!(result, cleaned("First one. Second one.", true));
}

#[tokio::test]
async fn a_piece_the_transcript_no_longer_starts_with_is_dropped() {
    let (ask, prompts) = fake_ask(|prompt| text(asked(prompt)));
    let session = CleanSession::new(ask, "");
    session.partial("Fist one. Two", false);
    session.partial("Fist one. Two more", false);
    let result = session.final_text("First one. Two more.").await;
    assert_eq!(
        prompts.lock().unwrap().last().unwrap(),
        "END\nCleaned so far: \nRest: First one. Two more."
    );
    assert_eq!(result.text, "First one. Two more.");
}

#[tokio::test]
async fn the_end_cleaned_at_a_pause_is_not_asked_again() {
    let (ask, prompts) = fake_ask(|prompt| text(asked(prompt)));
    let session = CleanSession::new(ask, "");
    session.partial("Do it now", true);
    assert_eq!(
        session.final_text("Do it now").await,
        cleaned("Do it now", true)
    );
    assert_eq!(prompts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_end_can_fix_what_was_cleaned_before_and_say_who_it_was_for() {
    let (ask, _) = fake_ask(|prompt| {
        if prompt.contains("END") {
            CleanerReply {
                for_agent: Some(false),
                text: Some(String::new()),
                fixes: vec![CleanerFix {
                    from: Some("red".into()),
                    to: Some(json!("blue")),
                }],
            }
        } else {
            text("Paint it red.")
        }
    });
    let session = CleanSession::new(ask, "");
    session.partial("Paint it red. Not red, blue I mean", false);
    session.partial("Paint it red. Not red, blue I mean", false);
    assert_eq!(
        session
            .final_text("Paint it red. Not red, blue I mean.")
            .await,
        cleaned("Paint it blue.", false)
    );
}

#[tokio::test]
async fn a_piece_that_comes_back_empty_keeps_its_words() {
    let (ask, _) = fake_ask(|prompt| {
        if prompt.contains("END") {
            text(asked(prompt))
        } else {
            text("")
        }
    });
    let session = CleanSession::new(ask, "");
    session.partial("Can I queue this, am I? But if I", false);
    session.partial("Can I queue this, am I? But if I start", false);
    assert_eq!(
        session
            .final_text("Can I queue this, am I? But if I start talking")
            .await
            .text,
        "Can I queue this, am I? But if I start talking"
    );
}

#[tokio::test]
async fn a_model_that_loses_most_of_the_words_gives_them_as_heard() {
    let (ask, _) = fake_ask(|_| text("Talking."));
    let session = CleanSession::new(ask, "");
    assert_eq!(
        session
            .final_text("I am not able to queue something else, am I")
            .await,
        cleaned("I am not able to queue something else, am I", true)
    );
    assert!(session.fell_back());
}

#[tokio::test(start_paused = true)]
async fn a_failing_or_slow_model_gives_the_words_as_heard() {
    let failing = CleanSession::new(
        Arc::new(|_, _| async { Err("down".to_owned()) }.boxed()),
        "",
    );
    assert_eq!(
        failing.final_text("Uh hello.").await,
        cleaned("Uh hello.", true)
    );
    let slow = CleanSession::with(
        Arc::new(|_, _| std::future::pending().boxed()),
        "",
        20,
        "Conversation so far",
        Arc::new(TokioClock::starting_at(0)),
    );
    assert_eq!(
        slow.final_text("Uh hello.").await,
        cleaned("Uh hello.", true)
    );
    assert!(slow.fell_back());
}

/// A Claude Code process answering each message with `answer`.
fn fake_claude(
    answer: impl Fn(&str) -> String + Send + Sync + 'static,
) -> (SpawnProcess, fake::Written, Arc<Mutex<usize>>) {
    let written = fake::Written::default();
    let spawned: Arc<Mutex<usize>> = Arc::default();
    let answer = Arc::new(answer);
    let (kept, count) = (written.clone(), spawned.clone());
    let spawn: SpawnProcess = Arc::new(move || {
        *count.lock().unwrap() += 1;
        let answer = answer.clone();
        fake::process(
            kept.clone(),
            Arc::new(move |content| vec![fake::result(&answer(content.as_str().unwrap()))]),
        )
        .0
    });
    (spawn, written, spawned)
}

#[tokio::test]
async fn asks_a_background_session_and_reads_its_json() {
    let (spawn, written, spawned) = fake_claude(|content| {
        format!(
            r#"{{"for_agent": true, "text": "{}"}}"#,
            content.to_uppercase()
        )
    });
    let cleaner = VoiceCleaner::new(spawn, 1);
    let reply = |t: &str| CleanerReply {
        for_agent: Some(true),
        text: Some(t.into()),
        fixes: vec![],
    };
    assert_eq!(cleaner.ask("hi".into(), None).await.unwrap(), reply("HI"));
    assert_eq!(
        cleaner.ask("there".into(), None).await.unwrap(),
        reply("THERE")
    );
    assert_eq!(*spawned.lock().unwrap(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&written.all()[0]).unwrap(),
        json!({"type": "user", "message": {"role": "user", "content": "hi"}})
    );
}

#[tokio::test]
async fn requests_no_longer_needed_are_dropped_unasked() {
    let (spawn, written, _) = fake_claude(|_| r#"{"text": "ok"}"#.into());
    let cleaner = VoiceCleaner::new(spawn, 1);
    let first = cleaner.ask("first".into(), None);
    let over = CancellationToken::new();
    let second = cleaner.ask("second".into(), Some(over.clone()));
    over.cancel();
    first.await.unwrap();
    assert_eq!(second.await, Err("No longer needed".into()));
    assert_eq!(written.all().len(), 1);
}

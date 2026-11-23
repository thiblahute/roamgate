use std::sync::Arc;

use roamgate_base::clock::TestClock;
use serde_json::json;

use super::*;

fn gst() -> NewAnswer {
    NewAnswer {
        job: "b01a370e".into(),
        pane: "local/w3:p1".into(),
        label: "gst".into(),
        question: "What speaker recognition tool do we use?".into(),
        answer: "We use pyannote, through the voice helper.".into(),
        at: None,
    }
}

fn kept(answer: NewAnswer, at: f64, mentioned: bool) -> WaitingAnswer {
    WaitingAnswer {
        job: answer.job,
        pane: answer.pane,
        label: answer.label,
        question: answer.question,
        answer: answer.answer,
        at,
        mentioned,
    }
}

#[tokio::test]
async fn an_answer_is_kept_with_the_sessions_name_and_the_question_until_heard() {
    let clock = Arc::new(TestClock::new(1_000_000));
    let waiting = WaitingAnswers::new(None, clock.clone());
    waiting.keep(gst());
    assert_eq!(waiting.list(), vec![kept(gst(), 1_000_000.0, false)]);
    assert_eq!(waiting.get("b01a370e").unwrap().answer, gst().answer);
    // Mentioned once: still waiting, never mentioned again.
    assert_eq!(waiting.mention(&["b01a370e", "other"]), 1);
    assert_eq!(waiting.mention(&["b01a370e"]), 0);
    assert_eq!(
        waiting
            .list()
            .iter()
            .map(|a| a.mentioned)
            .collect::<Vec<_>>(),
        vec![true]
    );
    // Heard (told, read or dismissed): gone.
    assert!(waiting.heard("b01a370e"));
    assert!(!waiting.heard("b01a370e"));
    assert_eq!(waiting.list(), vec![]);
    // A day later, an answer not heard goes by itself.
    waiting.keep(NewAnswer {
        job: "old".into(),
        ..gst()
    });
    clock.advance(WAITING_MS as u64 + 1).await;
    assert_eq!(waiting.list(), vec![]);
    assert_eq!(waiting.get("old"), None);
}

#[test]
fn dismissed_without_a_job_every_answer_waiting_goes() {
    let waiting = WaitingAnswers::new(None, Arc::new(TestClock::new(5)));
    waiting.keep(gst());
    waiting.keep(NewAnswer {
        job: "55fe1613".into(),
        label: "roamgate".into(),
        ..gst()
    });
    assert_eq!(waiting.dismiss(Some("nope")), Vec::<String>::new());
    assert_eq!(waiting.dismiss(None), vec!["b01a370e", "55fe1613"]);
    assert_eq!(waiting.list(), vec![]);
}

#[test]
fn the_same_job_answered_again_keeps_one_entry_the_oldest_go_past_the_cap() {
    let waiting = WaitingAnswers::new(None, Arc::new(TestClock::new(5)));
    waiting.keep(gst());
    waiting.keep(NewAnswer {
        answer: "Settled later.".into(),
        ..gst()
    });
    assert_eq!(
        waiting
            .list()
            .iter()
            .map(|a| a.answer.clone())
            .collect::<Vec<_>>(),
        vec!["Settled later."]
    );
    for i in 0..25 {
        waiting.keep(NewAnswer {
            job: format!("job-{i}"),
            ..gst()
        });
    }
    assert_eq!(waiting.list().len(), 20);
    assert_eq!(waiting.get("b01a370e"), None);
    assert!(waiting.get("job-24").is_some());
}

#[test]
fn kept_in_a_file_so_a_restart_each_deploy_loses_nothing() {
    let home = tempfile::tempdir().unwrap();
    let file = waiting_answers_file(&home.path().join("uploads"));
    let first = WaitingAnswers::new(Some(file.clone()), Arc::new(TestClock::new(7)));
    first.keep(gst());
    first.mention(&["b01a370e"]);
    assert!(file.exists());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved, json!([kept(gst(), 7.0, true).to_json()]));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        r#"[{"job":"b01a370e","pane":"local/w3:p1","label":"gst","question":"What speaker recognition tool do we use?","answer":"We use pyannote, through the voice helper.","at":7,"mentioned":true}]"#
    );
    let second = WaitingAnswers::new(Some(file.clone()), Arc::new(TestClock::new(8)));
    assert_eq!(second.list(), vec![kept(gst(), 7.0, true)]);
    second.heard("b01a370e");
    assert_eq!(WaitingAnswers::open(Some(file)).list(), vec![]);
    // A file that is not a list of answers is taken as none.
    let broken = waiting_answers_file(&home.path().join("broken"));
    assert_eq!(WaitingAnswers::open(Some(broken)).list(), vec![]);
}

#[test]
fn the_fronts_state_lists_them_with_how_to_read_or_drop_one() {
    let now = js::date_parse("2026-11-20T10:00:00Z");
    assert_eq!(waiting_context(&[], now), "");
    let context = waiting_context(
        &[
            kept(gst(), now - 2.0 * 60.0 * 60_000.0, true),
            WaitingAnswer {
                job: "55fe1613".into(),
                pane: "local/w5:p2".into(),
                label: "roamgate".into(),
                question: "Why did the call cut?".into(),
                answer: format!("The call cut because {}", "the page reloaded. ".repeat(40)),
                at: now - 3.0 * 60_000.0,
                mentioned: false,
            },
        ],
        now,
    );
    assert!(context.starts_with("Answers waiting ("));
    assert!(context.contains(r#"{"to": "read", "job": "<id>"}"#));
    assert!(context.contains(r#"- job b01a370e: gst, 2 h ago, asked "What speaker recognition tool do we use?", mentioned. Starts: "We use pyannote, through the voice helper." (42 characters)"#));
    assert!(context.contains(r#"- job 55fe1613: roamgate, 3 min ago, asked "Why did the call cut?", not mentioned yet. Starts: "The call cut because the page reloaded."#));
    assert!(context.contains(r#"..." (780 characters)"#));
}

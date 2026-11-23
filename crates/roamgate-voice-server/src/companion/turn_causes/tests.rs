use std::sync::Arc;

use roamgate_base::clock::TestClock;
use serde_json::json;

use super::*;

fn clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(1_000_000))
}

#[tokio::test]
async fn the_turns_cause_is_the_last_one_noted_before_it_started() {
    let time = clock();
    let causes = TurnCauses::new(time.clone());
    causes.note("local", "w1:p1", TurnCause::Agent("builder".into()));
    time.advance(60_000).await;
    causes.note("local", "w1:p1", TurnCause::User(UserVia::Review));
    time.advance(2_000).await;
    // The turn started with the review comment and ran 40 s.
    time.advance(40_000).await;
    let turn = causes.turn("local", "w1:p1", Some(40_000.0));
    assert_eq!(turn.cause.unwrap().cause, TurnCause::User(UserVia::Review));
    // A turn that started before it was the agent's message.
    let turn = causes.turn("local", "w1:p1", Some(90_000.0));
    assert_eq!(
        turn.cause.unwrap().cause,
        TurnCause::Agent("builder".into())
    );
    // Another session has none.
    assert_eq!(causes.turn("local", "w1:p2", None).cause, None);
}

#[tokio::test]
async fn an_old_cause_did_not_start_a_new_turn() {
    let time = clock();
    let causes = TurnCauses::new(time.clone());
    causes.note("local", "w1:p1", TurnCause::Companion);
    time.advance(2 * 60 * 60_000).await;
    assert_eq!(causes.turn("local", "w1:p1", Some(30_000.0)).cause, None);
}

#[tokio::test]
async fn only_the_users_own_causes_and_keys_are_their_input() {
    let time = clock();
    let causes = TurnCauses::new(time.clone());
    causes.note("local", "w1:p1", TurnCause::Companion);
    assert_eq!(causes.turn("local", "w1:p1", None).user_at, None);
    causes.note_user("local", "w1:p1");
    assert_eq!(
        causes.turn("local", "w1:p1", None).user_at,
        Some(time.now() as f64)
    );
    // Keys typed are not a turn's cause.
    assert_eq!(
        causes.turn("local", "w1:p1", None).cause.unwrap().cause,
        TurnCause::Companion
    );
    time.advance(5_000).await;
    causes.note("local", "w1:p1", TurnCause::User(UserVia::Chat));
    assert_eq!(
        causes.turn("local", "w1:p1", None).user_at,
        Some(time.now() as f64)
    );
}

#[test]
fn says_what_started_the_turn_how_long_it_ran_and_whether_the_user_looks() {
    let now = 1_000_000.0;
    let noted = |cause, at| Some(NotedCause { cause, at });
    assert_eq!(
        turn_context(
            &TurnFacts {
                cause: noted(TurnCause::User(UserVia::Review), now - 40_000.0),
                user_at: Some(now - 40_000.0),
                turn_ms: Some(40_000.0),
                looking: true,
            },
            now
        ),
        "(started by the user's review comment; ran 40 s; the user's last input there 40 s ago; the user is looking at it)"
    );
    assert_eq!(
        turn_context(
            &TurnFacts {
                cause: noted(TurnCause::Companion, now - 600_000.0),
                user_at: None,
                turn_ms: Some(9.0 * 60_000.0),
                looking: false,
            },
            now
        ),
        "(started by your own errand; ran 9 min; no input from the user there lately)"
    );
    assert_eq!(
        turn_context(
            &TurnFacts {
                cause: noted(TurnCause::Agent("roamgate-android".into()), now),
                user_at: Some(now - 3.0 * 60.0 * 60_000.0),
                ..TurnFacts::default()
            },
            now
        ),
        "(started by a message from agent session roamgate-android; the user's last input there 3 h ago)"
    );
    assert_eq!(
        turn_context(&TurnFacts::default(), now),
        "(started by nothing Roamgate saw: cause unknown; no input from the user there lately)"
    );
}

#[tokio::test]
async fn an_event_about_a_session_gets_its_turns_context_others_stay_as_they_are() {
    let time = clock();
    let causes = TurnCauses::new(time.clone());
    causes.note("local", "w1:p1", TurnCause::User(UserVia::Review));
    time.advance(40_000).await;
    let now = time.now() as f64;
    let body = json!({"pane": "local/w1:p1", "turn_ms": 40_000, "looking": true});
    assert_eq!(
        with_turn_context(
            "cps-iga185: Claude finished",
            body.as_object(),
            &causes,
            now
        ),
        "cps-iga185: Claude finished (started by the user's review comment; ran 40 s; the user's last input there 40 s ago; the user is looking at it)"
    );
    let empty = json!({});
    assert_eq!(
        with_turn_context(
            "Ranger task succeeded: backup",
            empty.as_object(),
            &causes,
            now
        ),
        "Ranger task succeeded: backup"
    );
    let bad = json!({"pane": "nopane"});
    assert_eq!(with_turn_context("x", bad.as_object(), &causes, now), "x");
}

//! voice-surprise.test.ts.

use std::sync::Arc;

use super::*;

fn voices() -> Vec<String> {
    ["elo", "oli", "tib2", "papa"].map(String::from).to_vec()
}

/// Picks in turn the first, second, ... of the choices offered.
fn first() -> f64 {
    0.0
}

fn last() -> f64 {
    0.999
}

#[test]
fn any_voice_may_read_a_reply() {
    assert_eq!(
        pick_surprise_voice(&voices(), None, &first).as_deref(),
        Some("elo")
    );
    assert_eq!(
        pick_surprise_voice(&voices(), None, &last).as_deref(),
        Some("papa")
    );
    assert_eq!(pick_surprise_voice(&[], None, &first), None);
}

#[test]
fn never_the_same_voice_twice_in_a_row_when_another_may_read() {
    assert_eq!(
        pick_surprise_voice(&voices(), Some("elo"), &first).as_deref(),
        Some("oli")
    );
    // The only one there is reads again.
    assert_eq!(
        pick_surprise_voice(&voices()[..1], Some("elo"), &first).as_deref(),
        Some("elo")
    );
    let random = math_random();
    let mut previous: Option<String> = None;
    for _ in 0..200 {
        let next = pick_surprise_voice(&voices(), previous.as_deref(), random.as_ref());
        assert_ne!(next, previous);
        previous = next;
    }
}

#[test]
fn a_reply_keeps_its_voice_from_one_sentence_to_the_next() {
    let mut picker = SurprisePicker::new(Arc::new(first));
    assert_eq!(picker.pick(&voices(), Some("r1")).as_deref(), Some("elo"));
    assert_eq!(picker.pick(&voices(), Some("r1")).as_deref(), Some("elo"));
    // The next reply is someone else.
    assert_eq!(picker.pick(&voices(), Some("r2")).as_deref(), Some("oli"));
    // A voice deleted meanwhile is picked again.
    let without: Vec<String> = voices()
        .into_iter()
        .filter(|voice| voice != "elo")
        .collect();
    assert_eq!(picker.pick(&without, Some("r1")).as_deref(), Some("tib2"));
}

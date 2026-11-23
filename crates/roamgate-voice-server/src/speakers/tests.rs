use serde_json::json;

use super::*;
use crate::testdata::{between, near, person};

fn said(id: Option<&str>, similarity: &[(&str, f64)]) -> VoiceTag {
    VoiceTag {
        voices: 7.0,
        id: id.map(str::to_owned),
        share: 1.0,
        mixed: false,
        mix: id.map(|id| vec![(id.to_owned(), 1.0)]).unwrap_or_default(),
        similarity: similarity
            .iter()
            .map(|(k, v)| ((*k).to_owned(), *v))
            .collect(),
        ..VoiceTag::default()
    }
}

fn mix(pairs: &[(&str, f64)]) -> Vec<(String, f64)> {
    pairs
        .iter()
        .map(|(id, share)| ((*id).to_owned(), *share))
        .collect()
}

#[test]
fn a_final_s_voice_is_checked_names_and_numbers_only() {
    let tag = parse_voice_tag(&json!({
        "voices": 1763550000000u64,
        "id": "B",
        "share": 0.8,
        "mixed": true,
        "mix": [{"id": "B", "share": 0.8}, {"id": "A", "share": 0.2}, {"id": "<x>", "share": 1}],
        "similarity": {"A": 0.12, "B": 0.71, "bad": 3, "C": "high"},
        "merged": {"D": "A", "E": 3},
        "seconds": 4.2,
    }))
    .unwrap();
    assert_eq!(
        js::stringify(&tag.to_json()),
        js::stringify(&json!({
            "voices": 1763550000000u64,
            "id": "B",
            "share": 0.8,
            "mixed": true,
            "mix": [{"id": "B", "share": 0.8}, {"id": "A", "share": 0.2}],
            "similarity": {"A": 0.12, "B": 0.71},
            "merged": {"D": "A"},
            "seconds": 4.2,
        }))
    );
    let empty = parse_voice_tag(&json!({"voices": 3, "id": null})).unwrap();
    assert_eq!((empty.id, empty.mixed, empty.mix.len()), (None, false, 0));
    for bad in [
        json!(null),
        json!("A"),
        json!(3),
        json!({"id": "A"}),
        json!({"voices": "3"}),
    ] {
        assert!(parse_voice_tag(&bad).is_none());
    }
}

#[test]
fn is_not_known_from_the_first_sound_labels_name_the_voices() {
    let mut speakers = SpeakerTracker::new(None);
    let mut radio = said(Some("A"), &[("A", 0.81)]);
    speakers.observe(Some(&mut radio));
    assert_eq!(speakers.label(Some(&radio)), "voice A");
    assert!(speakers.user().is_none());
    assert_eq!(
        speakers.label(Some(&said(None, &[("A", 0.05)]))),
        "voice unclear"
    );
    assert_eq!(speakers.label(None), "");
}

#[test]
fn is_the_voice_whose_words_the_companion_takes_up() {
    let mut speakers = SpeakerTracker::new(None);
    speakers.learn(Some(&mut said(Some("A"), &[("A", 0.8)])), "nobody", None);
    let mut user = said(Some("B"), &[("A", 0.06), ("B", 0.62)]);
    speakers.learn(Some(&mut user), "self", None);
    let known = speakers.user().unwrap();
    assert_eq!(
        (known.voices, known.id.as_deref(), known.prints),
        (Some(7.0), Some("B"), None)
    );
    assert_eq!(speakers.label(Some(&user)), "you 0.62");
    assert_eq!(
        speakers.label(Some(&said(Some("A"), &[("A", 0.77), ("B", 0.07)]))),
        "voice A, 0.07 like you"
    );
    assert_eq!(
        speakers.label(Some(&said(None, &[("A", 0.1), ("B", 0.31)]))),
        "voice unclear, 0.31 like you"
    );
}

#[test]
fn moves_to_another_voice_only_when_it_has_clearly_more() {
    let mut speakers = SpeakerTracker::new(None);
    speakers.learn(Some(&mut said(Some("A"), &[("A", 0.8)])), "web", None);
    assert_eq!(speakers.user().unwrap().id.as_deref(), Some("A"));
    speakers.learn(
        Some(&mut said(Some("B"), &[("A", 0.05), ("B", 0.6)])),
        "current",
        None,
    );
    assert_eq!(speakers.user().unwrap().id.as_deref(), Some("A"));
    speakers.learn(
        Some(&mut said(Some("B"), &[("A", 0.05), ("B", 0.6)])),
        "self",
        None,
    );
    assert_eq!(speakers.user().unwrap().id.as_deref(), Some("B"));
    let mut back = SpeakerTracker::new(None);
    back.learn(Some(&mut said(Some("A"), &[("A", 0.8)])), "self", None);
    back.learn(Some(&mut said(Some("A"), &[("A", 0.8)])), "self", None);
    back.learn(
        Some(&mut said(Some("A"), &[("A", 0.75)])),
        "nobody",
        Some(VoiceVerdict::Other),
    );
    assert!(back.user().is_none());
    back.learn(
        Some(&mut said(Some("B"), &[("A", 0.1), ("B", 0.2)])),
        "self",
        Some(VoiceVerdict::User),
    );
    assert_eq!(back.user().unwrap().id.as_deref(), Some("B"));
}

#[test]
fn mixed_or_unclear_words_teach_nothing_by_their_route() {
    let mut speakers = SpeakerTracker::new(None);
    let mut mixed = said(Some("A"), &[("A", 0.5), ("B", 0.4)]);
    mixed.mixed = true;
    mixed.mix = mix(&[("A", 0.55), ("B", 0.45)]);
    speakers.learn(Some(&mut mixed), "self", None);
    let mut half = said(Some("A"), &[("A", 0.5)]);
    half.share = 0.5;
    speakers.learn(Some(&mut half), "self", None);
    speakers.learn(Some(&mut said(None, &[])), "self", None);
    assert!(speakers.user().is_none());
}

#[test]
fn mixed_words_name_the_user_first() {
    let mut speakers = SpeakerTracker::new(None);
    speakers.learn(Some(&mut said(Some("B"), &[("B", 0.6)])), "self", None);
    let mut both = said(Some("A"), &[("A", 0.41), ("B", 0.35)]);
    both.mixed = true;
    both.share = 0.6;
    both.mix = mix(&[("A", 0.6), ("B", 0.4)]);
    assert_eq!(speakers.label(Some(&both)), "mixed: you + A");
    let mut others = said(Some("A"), &[("A", 0.5), ("B", 0.1), ("C", 0.4)]);
    others.mixed = true;
    others.mix = mix(&[("A", 0.6), ("C", 0.4)]);
    assert_eq!(speakers.label(Some(&others)), "mixed: A + C, 0.10 like you");
    assert!(speakers.is_other(Some(&others)));
    assert!(!speakers.is_other(Some(&both)));
}

#[test]
fn a_new_call_forgets_the_user_s_voice_merged_voices_keep_what_was_learnt() {
    let mut speakers = SpeakerTracker::new(None);
    speakers.learn(Some(&mut said(Some("C"), &[("C", 0.6)])), "self", None);
    let mut merged = said(Some("A"), &[("A", 0.6)]);
    merged.merged = Some([("C".to_owned(), "A".to_owned())].into_iter().collect());
    speakers.observe(Some(&mut merged));
    let user = speakers.user().unwrap();
    assert_eq!((user.voices, user.id.as_deref()), (Some(7.0), Some("A")));
    assert_eq!(speakers.label(Some(&merged)), "you 0.60");
    let mut next = said(Some("A"), &[("A", 0.7)]);
    next.voices = 8.0;
    speakers.observe(Some(&mut next));
    assert!(speakers.user().is_none());
    assert_eq!(speakers.label(Some(&next)), "voice A");
}

#[test]
fn another_voice_is_clearly_not_the_user_s_only_when_far_from_theirs() {
    let mut speakers = SpeakerTracker::new(None);
    assert!(!speakers.is_other(Some(&said(Some("A"), &[("A", 0.8)]))));
    speakers.learn(Some(&mut said(Some("A"), &[("A", 0.6)])), "self", None);
    assert!(!speakers.is_other(Some(&said(Some("A"), &[("A", 0.6)]))));
    assert!(speakers.is_other(Some(&said(Some("B"), &[("A", 0.05), ("B", 0.7)]))));
    assert!(!speakers.is_other(Some(&said(Some("B"), &[("A", 0.3), ("B", 0.5)]))));
}

fn spoken(voices: f64, id: &str, print: Vec<f64>) -> VoiceTag {
    VoiceTag {
        voices,
        id: Some(id.into()),
        share: 1.0,
        mixed: false,
        mix: mix(&[(id, 1.0)]),
        similarity: [(id.to_owned(), 0.7)].into_iter().collect(),
        seconds: Some(4.0),
        prints: Some([(id.to_owned(), print.clone())].into_iter().collect()),
        print: Some(print),
        ..VoiceTag::default()
    }
}

fn with_library() -> (tempfile::TempDir, SpeakerTracker) {
    let root = tempfile::Builder::new()
        .prefix("roamgate-speakers-")
        .tempdir()
        .unwrap();
    let library = VoiceProfiles::new(root.path().join("voice-profiles"));
    (root, SpeakerTracker::new(Some(library)))
}

fn lib(speakers: &mut SpeakerTracker) -> &mut VoiceProfiles {
    speakers.library().unwrap()
}

fn starts_with_score(label: &str, prefix: &str) -> bool {
    // `<prefix> 0.9d`
    label.len() == prefix.len() + 5 && label.starts_with(&format!("{prefix} 0.9"))
}

#[test]
fn the_user_s_profile_makes_their_voice_you_from_the_first_utterance() {
    let (_root, mut speakers) = with_library();
    let me = lib(&mut speakers).create(Some("Thibault"), VoiceRole::User);
    lib(&mut speakers).learn(&me, 1.0, person(0), 30.0);
    let mut first = spoken(2.0, "A", near(&person(0), 0.02, 1));
    speakers.observe(Some(&mut first));
    assert_eq!(speakers.label(Some(&first)), "Thibault (you) 0.70");
    let user = speakers.user().unwrap();
    assert_eq!((user.voices, user.id.as_deref()), (Some(2.0), Some("A")));
    assert_eq!(user.prints.unwrap().len(), 2);
    let kept = speakers.kept_user().unwrap();
    assert_eq!(
        (kept.voices, kept.id, kept.prints.unwrap().len()),
        (None, None, 2)
    );
}

#[test]
fn known_people_are_named_others_unknown_or_maybe_someone() {
    let (_root, mut speakers) = with_library();
    let simon = lib(&mut speakers).create(Some("Simon"), VoiceRole::Family);
    lib(&mut speakers).learn(&simon, 1.0, person(1), 30.0);
    let me = lib(&mut speakers).create(Some("Thibault"), VoiceRole::User);
    lib(&mut speakers).learn(&me, 1.0, person(0), 30.0);
    let mut simon_says = spoken(2.0, "B", near(&person(1), 0.02, 2));
    speakers.observe(Some(&mut simon_says));
    assert!(starts_with_score(
        &speakers.label(Some(&simon_says)),
        "Simon"
    ));
    assert!(speakers.is_other(Some(&simon_says)));
    let mut stranger = spoken(2.0, "C", person(3));
    speakers.observe(Some(&mut stranger));
    assert_eq!(speakers.label(Some(&stranger)), "voice C, unknown");
    let mut close = spoken(2.0, "D", between(&person(1), &person(4), 0.5));
    speakers.observe(Some(&mut close));
    assert_eq!(speakers.label(Some(&close)), "voice D, maybe Simon 0.50");
    let mut me2 = spoken(2.0, "A", near(&person(0), 0.02, 3));
    speakers.observe(Some(&mut me2));
    let mut both = spoken(2.0, "A", near(&person(0), 0.02, 4));
    both.mixed = true;
    both.mix = mix(&[("B", 0.5), ("A", 0.5)]);
    assert_eq!(speakers.label(Some(&both)), "mixed: Thibault (you) + Simon");
}

#[test]
fn profiles_learn_only_from_confident_unmixed_utterances() {
    let (_root, mut speakers) = with_library();
    let simon = lib(&mut speakers).create(Some("Simon"), VoiceRole::Family);
    lib(&mut speakers).learn(&simon, 1.0, person(1), 30.0);
    let print = near(&person(1), 0.02, 5);
    let mut mixed = spoken(2.0, "B", print.clone());
    mixed.mixed = true;
    speakers.observe(Some(&mut mixed));
    let mut half = spoken(2.0, "B", print.clone());
    half.share = 0.5;
    speakers.observe(Some(&mut half));
    let mut short = spoken(2.0, "B", print.clone());
    short.seconds = Some(0.5);
    speakers.observe(Some(&mut short));
    let mut far = spoken(2.0, "B", print.clone());
    far.similarity = [("B".to_owned(), 0.2)].into_iter().collect();
    speakers.observe(Some(&mut far));
    let kept = |speakers: &mut SpeakerTracker| lib(speakers).get(&simon).unwrap().prints.clone();
    assert_eq!(
        kept(&mut speakers)
            .iter()
            .map(|each| each.call)
            .collect::<Vec<_>>(),
        vec![1.0]
    );
    speakers.observe(Some(&mut spoken(2.0, "B", print.clone())));
    assert_eq!(
        kept(&mut speakers)
            .iter()
            .map(|each| each.call)
            .collect::<Vec<_>>(),
        vec![1.0, 2.0]
    );
    assert_eq!(kept(&mut speakers)[1].seconds, 4.0);
    speakers.observe(Some(&mut spoken(2.0, "B", print)));
    assert_eq!(kept(&mut speakers)[1].seconds, 8.0);
}

#[test]
fn the_user_s_voice_learnt_from_the_conversation_is_kept_as_theirs() {
    let (_root, mut speakers) = with_library();
    let mut tag = spoken(2.0, "A", person(0));
    speakers.observe(Some(&mut tag));
    speakers.learn(Some(&mut tag), "self", None);
    assert!(lib(&mut speakers).user().is_none());
    speakers.learn(Some(&mut tag), "self", Some(VoiceVerdict::User));
    assert_eq!(lib(&mut speakers).user().unwrap().prints.len(), 1);
    let mut next = spoken(3.0, "B", near(&person(0), 0.02, 6));
    speakers.observe(Some(&mut next));
    assert_eq!(speakers.label(Some(&next)), "you 0.70");
}

#[test]
fn a_voice_wrongly_taken_for_the_user_s_is_not_once_said() {
    let (_root, mut speakers) = with_library();
    let me = lib(&mut speakers).create(None, VoiceRole::User);
    lib(&mut speakers).learn(&me, 1.0, person(0), 30.0);
    let mut tag = spoken(2.0, "A", near(&person(0), 0.02, 7));
    speakers.observe(Some(&mut tag));
    assert_eq!(speakers.user().unwrap().id.as_deref(), Some("A"));
    assert_eq!(lib(&mut speakers).get(&me).unwrap().prints.len(), 2);
    speakers.learn(Some(&mut tag), "nobody", Some(VoiceVerdict::Other));
    assert!(speakers.user().is_none_or(|user| user.id.is_none()));
    assert_eq!(
        lib(&mut speakers)
            .get(&me)
            .unwrap()
            .prints
            .iter()
            .map(|each| each.call)
            .collect::<Vec<_>>(),
        vec![1.0]
    );
    speakers.observe(Some(&mut tag));
    assert!(!speakers.label(Some(&tag)).contains("you"));
}

#[test]
fn the_companion_names_a_voice_it_is_known_on_the_next_call() {
    let (_root, mut speakers) = with_library();
    let mut tag = spoken(2.0, "C", person(2));
    speakers.observe(Some(&mut tag));
    let naming = VoiceNaming {
        name: "Simon".into(),
        role: Some(VoiceRole::Family),
        voice: None,
    };
    assert_eq!(
        speakers.name(Some(&mut tag), &naming).as_deref(),
        Some("voice C is Simon (family)")
    );
    assert!(speakers.label(Some(&tag)).starts_with("Simon"));
    assert_eq!(lib(&mut speakers).by_name("simon").unwrap().prints.len(), 1);
    let dir = lib(&mut speakers).dir.clone();
    let mut again = SpeakerTracker::new(Some(VoiceProfiles::new(dir)));
    let mut next = spoken(3.0, "A", near(&person(2), 0.02, 8));
    again.observe(Some(&mut next));
    assert!(starts_with_score(&again.label(Some(&next)), "Simon"));
}

#[test]
fn a_wrong_name_is_corrected_the_first_person_unlearns_this_call() {
    let (_root, mut speakers) = with_library();
    let elo = lib(&mut speakers).create(Some("Elo"), VoiceRole::Family);
    lib(&mut speakers).learn(&elo, 1.0, person(1), 30.0);
    let mut tag = spoken(2.0, "B", near(&person(1), 0.05, 9));
    speakers.observe(Some(&mut tag));
    assert!(speakers.label(Some(&tag)).starts_with("Elo"));
    assert_eq!(lib(&mut speakers).get(&elo).unwrap().prints.len(), 2);
    let naming = VoiceNaming {
        voice: Some("B".into()),
        name: "Oli".into(),
        role: Some(VoiceRole::Family),
    };
    assert_eq!(
        speakers.name(Some(&mut tag), &naming).as_deref(),
        Some("voice B is Oli (family), was Elo")
    );
    assert_eq!(
        lib(&mut speakers)
            .get(&elo)
            .unwrap()
            .prints
            .iter()
            .map(|each| each.call)
            .collect::<Vec<_>>(),
        vec![1.0]
    );
    assert_eq!(lib(&mut speakers).by_name("Oli").unwrap().prints.len(), 1);
    speakers.observe(Some(&mut tag));
    assert!(speakers.label(Some(&tag)).starts_with("Oli"));
}

#[test]
fn naming_the_user_s_voice_names_their_profile() {
    let (_root, mut speakers) = with_library();
    let mut tag = spoken(2.0, "A", person(0));
    speakers.observe(Some(&mut tag));
    speakers.name(
        Some(&mut tag),
        &VoiceNaming {
            name: "Thibault".into(),
            role: Some(VoiceRole::User),
            voice: None,
        },
    );
    assert_eq!(
        lib(&mut speakers).user().unwrap().name.as_deref(),
        Some("Thibault")
    );
    assert_eq!(speakers.user().unwrap().id.as_deref(), Some("A"));
    assert_eq!(speakers.label(Some(&tag)), "Thibault (you) 0.70");
}

#[test]
fn a_voice_heard_long_and_often_is_kept_unnamed_offered_for_naming_once() {
    let (_root, mut speakers) = with_library();
    for call in 1..=3u64 {
        for i in 0..6u64 {
            speakers.observe(Some(&mut spoken(
                call as f64,
                "B",
                near(&person(5), 0.02, call * 10 + i),
            )));
        }
    }
    let kept = lib(&mut speakers).profiles()[0].clone();
    assert_eq!(
        (kept.name, kept.role, kept.calls),
        (None, VoiceRole::Unknown, 3.0)
    );
    let mut tag = spoken(3.0, "B", near(&person(5), 0.02, 99));
    speakers.observe(Some(&mut tag));
    assert_eq!(speakers.label(Some(&tag)), "voice B, heard on 3 calls");
    assert!(
        speakers
            .detail(Some(&tag), true)
            .contains("voice B was heard on 3 calls and has no name: you may ask once")
    );
    assert!(!speakers.detail(Some(&tag), true).contains("you may ask"));
    speakers.name(
        Some(&mut tag),
        &VoiceNaming {
            name: "Mamie".into(),
            role: Some(VoiceRole::Family),
            voice: None,
        },
    );
    let all: Vec<(Option<String>, f64)> = lib(&mut speakers)
        .profiles()
        .into_iter()
        .map(|each| (each.name, each.calls))
        .collect();
    assert_eq!(all, vec![(Some("Mamie".to_owned()), 3.0)]);
}

#[test]
fn the_companion_gets_every_score_behind_the_label() {
    let (_root, mut speakers) = with_library();
    let simon = lib(&mut speakers).create(Some("Simon"), VoiceRole::Family);
    lib(&mut speakers).learn(&simon, 1.0, person(1), 30.0);
    let me = lib(&mut speakers).create(Some("Thibault"), VoiceRole::User);
    lib(&mut speakers).learn(&me, 1.0, person(0), 30.0);
    speakers.observe(Some(&mut spoken(2.0, "A", person(0))));
    let mut tag = spoken(2.0, "B", near(&person(1), 0.02, 11));
    tag.similarity = [("A".to_owned(), 0.05), ("B".to_owned(), 0.71)]
        .into_iter()
        .collect();
    speakers.observe(Some(&mut tag));
    let detail = speakers.detail(Some(&without_prints(&tag)), false);
    let pattern = Regex::new(
        r"^voices in it: B 100% is Simon \(closest: Simon 0\.9\d, Thibault \(you\) 0\.1\d\) \| the words against people known: Simon 0\.9\d, Thibault \(you\) 0\.1\d \| against this call's voices: B 0\.71, A 0\.05$",
    )
    .unwrap();
    assert!(pattern.is_match(&detail), "{detail}");
}

#[test]
fn the_page_gets_tags_without_prints_and_sends_back_their_utterance() {
    let mut raw = spoken(2.0, "A", person(0)).to_json();
    raw["prints"] = json!({"A": person(0), "<x>": person(1), "B": [1, 2]});
    let mut tag = parse_voice_tag(&raw).unwrap();
    assert_eq!(
        tag.prints.as_ref().unwrap().keys().collect::<Vec<_>>(),
        vec!["A"]
    );
    let (_root, mut speakers) = with_library();
    speakers.observe(Some(&mut tag));
    assert_eq!(tag.utterance, Some(1.0));
    let page = without_prints(&tag).to_json();
    assert!(page.get("print").is_none() && page.get("prints").is_none());
    let back = parse_voice_tag(&serde_json::from_str(&js::stringify(&page)).unwrap()).unwrap();
    assert_eq!((back.utterance, back.seconds), (Some(1.0), Some(4.0)));
}

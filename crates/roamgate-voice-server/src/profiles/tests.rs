use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;

use super::*;
use crate::testdata::{between, near, person};

fn library() -> (tempfile::TempDir, VoiceProfiles) {
    let root = tempfile::Builder::new()
        .prefix("roamgate-voice-profiles-")
        .tempdir()
        .unwrap();
    let dir = root.path().join("voice-profiles");
    (root, VoiceProfiles::new(dir))
}

fn profile(prints: &[(Vec<f64>, f64)], id: &str) -> VoiceProfile {
    VoiceProfile {
        id: id.into(),
        name: Some(id.into()),
        role: VoiceRole::Family,
        prints: prints
            .iter()
            .map(|(print, call)| KeptPrint {
                print: print.clone(),
                call: *call,
                seconds: 10.0,
                at: 0.0,
            })
            .collect(),
        seconds: 10.0,
        calls: prints.len() as f64,
        first: 0.0,
        last: 0.0,
        offered: false,
    }
}

fn none() -> HashSet<String> {
    HashSet::new()
}

#[test]
fn sure_above_the_threshold_with_a_margin_over_the_next() {
    let simon = profile(&[(person(0), 1.0)], "simon");
    let elo = profile(&[(person(1), 1.0)], "elo");
    let found = match_print(
        &between(&person(0), &person(3), 0.7),
        &[&simon, &elo],
        None,
        &none(),
    );
    assert!(found.sure);
    let (id, score) = found.best.unwrap();
    assert_eq!(id, "simon");
    assert!((score - 0.7).abs() < 0.005);
}

#[test]
fn two_close_people_not_sure_without_the_margin_only_maybe() {
    let elo = profile(&[(person(1), 1.0)], "elo");
    let oli = profile(&[(between(&person(1), &person(2), 0.6), 1.0)], "oli");
    let heard = unit(
        &elo.prints[0]
            .print
            .iter()
            .zip(&oli.prints[0].print)
            .map(|(a, b)| a + b)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let found = match_print(&heard, &[&elo, &oli], None, &none());
    let best = found.best.as_ref().unwrap().1;
    assert!(best > 0.6);
    assert!(best - found.second < 0.15);
    assert!(!found.sure);
    assert!(found.maybe);
}

#[test]
fn below_the_threshold_maybe_then_nobody() {
    let simon = profile(&[(person(0), 1.0)], "simon");
    let close = match_print(
        &between(&person(0), &person(3), 0.5),
        &[&simon],
        None,
        &none(),
    );
    assert!(!close.sure && close.maybe);
    let far = match_print(
        &between(&person(0), &person(3), 0.3),
        &[&simon],
        None,
        &none(),
    );
    assert!(!far.sure && !far.maybe);
}

#[test]
fn the_call_s_own_print_and_rejected_people_do_not_count() {
    let simon = profile(&[(person(0), 5.0)], "simon");
    assert!(
        match_print(&person(0), &[&simon], Some(5.0), &none())
            .best
            .is_none()
    );
    assert!(match_print(&person(0), &[&simon], Some(6.0), &none()).sure);
    let rejected: HashSet<String> = ["simon".to_owned()].into();
    assert!(
        match_print(&person(0), &[&simon], Some(6.0), &rejected)
            .best
            .is_none()
    );
}

#[test]
fn a_person_s_closest_print_counts_one_per_microphone() {
    let phone = between(&person(0), &person(4), 0.4);
    let simon = profile(&[(person(0), 1.0), (phone.clone(), 2.0)], "simon");
    assert!(match_print(&near(&phone, 0.02, 3), &[&simon], None, &none()).sure);
}

#[test]
fn keeps_one_print_per_call_replaced_as_the_call_goes() {
    let (_root, mut voices) = library();
    let simon = voices.create(Some("Simon"), VoiceRole::Family);
    voices.learn(&simon, 1.0, person(0), 4.0);
    voices.learn(&simon, 1.0, near(&person(0), 0.02, 1), 9.0);
    voices.learn(&simon, 2.0, near(&person(0), 0.02, 2), 5.0);
    let kept = voices.get(&simon).unwrap().clone();
    assert_eq!(
        kept.prints
            .iter()
            .map(|each| (each.call, each.seconds))
            .collect::<Vec<_>>(),
        vec![(1.0, 9.0), (2.0, 5.0)]
    );
    assert_eq!(kept.calls, 2.0);
    assert_eq!(kept.seconds, 14.0);
}

#[test]
fn keeps_a_bounded_set_of_prints_merging_the_closest_the_call_s_own_kept() {
    let (_root, mut voices) = library();
    let simon = voices.create(Some("Simon"), VoiceRole::Family);
    for call in 1..=(MAX_PRINTS as u64 + 4) {
        let base = if call % 2 == 1 {
            person(0)
        } else {
            between(&person(0), &person(5), 0.5)
        };
        voices.learn(&simon, call as f64, near(&base, 0.02, call), 5.0);
    }
    let kept = voices.get(&simon).unwrap().clone();
    assert_eq!(kept.prints.len(), MAX_PRINTS);
    assert!(
        kept.prints
            .iter()
            .any(|each| each.call == (MAX_PRINTS + 4) as f64)
    );
    let scores: Vec<f64> = kept
        .prints
        .iter()
        .map(|each| cosine(&each.print, &person(0)))
        .collect();
    assert!(scores.iter().cloned().fold(f64::MIN, f64::max) > 0.95);
    assert!(scores.iter().cloned().fold(f64::MAX, f64::min) < 0.6);
}

#[test]
fn is_kept_in_private_files_read_back_prints_only_no_audio() {
    let (_root, mut voices) = library();
    let simon = voices.create(Some("Simon"), VoiceRole::Family);
    voices.learn(&simon, 1.0, person(0), 6.0);
    let files: Vec<String> = fs::read_dir(&voices.dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, vec![format!("{simon}.json")]);
    let file = voices.dir.join(&files[0]);
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&voices.dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let mut keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "calls", "first", "last", "name", "prints", "role", "seconds"
        ]
    );
    let mut again = VoiceProfiles::new(voices.dir.clone());
    let read = again.by_name("simon").unwrap().clone();
    assert_eq!(read.id, simon);
    assert_eq!(read.name.as_deref(), Some("Simon"));
    assert_eq!(read.role, VoiceRole::Family);
    assert!(cosine(&read.prints[0].print, &person(0)) > 0.9999);
}

#[test]
fn a_file_deleted_stays_deleted_a_file_it_cannot_read_is_skipped() {
    let (_root, mut voices) = library();
    let simon = voices.create(Some("Simon"), VoiceRole::Family);
    voices.learn(&simon, 1.0, person(0), 6.0);
    fs::write(voices.dir.join("0123456789abcdef.json"), "{not json").unwrap();
    fs::remove_file(voices.dir.join(format!("{simon}.json"))).unwrap();
    voices.learn(&simon, 1.0, person(0), 8.0);
    assert!(!voices.dir.join(format!("{simon}.json")).exists());
    assert!(voices.by_name("Simon").is_none());
    voices.reload();
    assert!(voices.profiles().is_empty());
}

#[test]
fn a_call_s_print_is_undone_an_unnamed_voice_left_empty_goes() {
    let (_root, mut voices) = library();
    let simon = voices.create(Some("Simon"), VoiceRole::Family);
    voices.learn(&simon, 1.0, person(0), 6.0);
    voices.learn(&simon, 2.0, person(1), 4.0);
    voices.forget_call(&simon, 2.0);
    let kept = voices.get(&simon).unwrap().clone();
    assert_eq!(
        kept.prints.iter().map(|each| each.call).collect::<Vec<_>>(),
        vec![1.0]
    );
    assert_eq!((kept.seconds, kept.calls), (6.0, 1.0));
    let stranger = voices.create(None, VoiceRole::Unknown);
    voices.learn(&stranger, 3.0, person(2), 30.0);
    voices.forget_call(&stranger, 3.0);
    assert!(voices.get(&stranger).is_none());
    assert!(!voices.dir.join(format!("{stranger}.json")).exists());
}

#[test]
fn an_unnamed_voice_given_a_name_moves_its_prints_over() {
    let (_root, mut voices) = library();
    let stranger = voices.create(None, VoiceRole::Unknown);
    voices.learn(&stranger, 1.0, person(2), 30.0);
    voices.learn(&stranger, 2.0, person(2), 25.0);
    let oli = voices.create(Some("Oli"), VoiceRole::Family);
    voices.absorb(&oli, &stranger);
    let kept = voices.get(&oli).unwrap().clone();
    assert_eq!(kept.prints.len(), 2);
    assert_eq!((kept.seconds, kept.calls), (55.0, 2.0));
    assert!(voices.get(&stranger).is_none());
}

#[test]
fn one_user_few_unnamed_voices() {
    let (_root, mut voices) = library();
    let a = voices.create(Some("A"), VoiceRole::User);
    let b = voices.create(Some("B"), VoiceRole::Family);
    voices.update(
        &b,
        ProfileChange {
            role: Some(VoiceRole::User),
            ..Default::default()
        },
    );
    assert_eq!(voices.user().unwrap().id, b);
    assert_eq!(voices.get(&a).unwrap().role, VoiceRole::Other);
    for _ in 0..MAX_UNNAMED + 3 {
        voices.create(None, VoiceRole::Unknown);
    }
    assert_eq!(
        voices
            .profiles()
            .iter()
            .filter(|each| each.role == VoiceRole::Unknown)
            .count(),
        MAX_UNNAMED
    );
}

#[test]
fn names_are_kept_short_and_printable() {
    let (_root, mut voices) = library();
    let elo = voices.create(Some("  Élodie <b>\n"), VoiceRole::Family);
    assert_eq!(voices.get(&elo).unwrap().name.as_deref(), Some("Élodie b"));
    assert_eq!(voices.by_name("élodie b").unwrap().id, elo);
}

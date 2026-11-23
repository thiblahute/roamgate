use std::collections::HashMap;

use roamgate_protocol::vectors::{self, Call};
use serde_json::{Map, Value, json};

use super::*;
use crate::js::number;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn run(call: &Call, handles: &mut HashMap<u64, ReadingEnd>) -> Value {
    let arg = |index: usize| call.args.get(index).cloned().unwrap_or(Value::Null);
    if let Some(handle) = call.on {
        let reading = handles.get_mut(&handle).expect("handle");
        return match call.method.as_deref() {
            Some("push") => json!(reading.push(
                arg(0).as_f64().unwrap_or(0.0),
                arg(1).as_f64().unwrap_or(0.0)
            )),
            Some("cut") => json!(reading.cut()),
            other => panic!("voice-library.json calls {other:?}, unknown here"),
        };
    }
    match call.target().as_str() {
        "voiceLibrary.READING_TEXTS" => Value::Object(
            READING_TEXTS
                .iter()
                .map(|(code, texts)| ((*code).to_owned(), json!(texts)))
                .collect::<Map<_, _>>(),
        ),
        "voiceLibrary.SAMPLE_SENTENCES" => Value::Object(
            SAMPLE_SENTENCES
                .iter()
                .map(|(code, sentence)| ((*code).to_owned(), json!(sentence)))
                .collect(),
        ),
        "voiceLibrary.VOICE_LANGUAGES" => Value::Array(
            VOICE_LANGUAGES
                .iter()
                .map(|(code, label)| json!({"code": code, "label": label}))
                .collect(),
        ),
        "voiceLibrary.END_PAUSE_SECONDS" => number(END_PAUSE_SECONDS),
        "voiceLibrary.MAX_RECORDING_SECONDS" => number(MAX_RECORDING_SECONDS),
        "voiceLibrary.cleanVoiceName" => {
            clean_voice_name(arg(0).as_str()).map_or(Value::Null, Value::from)
        }
        "voiceLibrary.voiceSlug" => json!(voice_slug(text(&arg(0)))),
        "voiceLibrary.uniqueVoiceId" => {
            let answers: Vec<(String, bool)> = arg(1)["$fn"]["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| {
                    (
                        call["args"][0].as_str().unwrap().to_owned(),
                        call["result"].as_bool().unwrap(),
                    )
                })
                .collect();
            json!(unique_voice_id(text(&arg(0)), |id| {
                answers
                    .iter()
                    .find(|(asked, _)| asked == id)
                    .is_some_and(|(_, taken)| *taken)
            }))
        }
        "voiceLibrary.transcriptWords" => json!(transcript_words(text(&arg(0)))),
        "voiceLibrary.wordErrorRate" => number(word_error_rate(text(&arg(0)), text(&arg(1)))),
        "voiceLibrary.chooseTranscript" => {
            let cut = arg(2).get("cut").and_then(Value::as_bool).unwrap_or(false);
            let (text, kind) = choose_transcript(text(&arg(0)), text(&arg(1)), cut);
            json!({"text": text, "kind": kind.as_str()})
        }
        "voiceLibrary.readingSeconds" => number(reading_seconds(text(&arg(0)))),
        "voiceLibrary.ReadingEnd" => {
            let handle = call.result.as_ref().unwrap()["$handle"].as_u64().unwrap();
            handles.insert(handle, ReadingEnd::new(text(&arg(0))));
            json!({"$handle": handle})
        }
        other => panic!("voice-library.json names {other}, unknown here"),
    }
}

/// Every case of `contract/vectors/voice-library.json`; the ledger's rows
/// of shared/voiceLibrary.test.ts name the vector file.
#[test]
fn voice_library_vectors() {
    let file = vectors::load("voice-library");
    let mut handles = HashMap::new();
    let mut failures = Vec::new();
    for case in &file.cases {
        for (index, call) in case.calls.iter().enumerate() {
            let got = run(call, &mut handles);
            let want = call.result.clone().unwrap_or(Value::Null);
            if got != want {
                failures.push(format!("{} #{index}: got {got}, want {want}", case.title()));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn languages_are_named_in_their_own_tongue() {
    assert!(is_voice_language("fr"));
    assert!(!is_voice_language("de"));
    assert_eq!(voice_language_label("ja"), "日本語");
    assert_eq!(voice_language_label("de"), "de");
}

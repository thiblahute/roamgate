//! contract/vectors/mr-complexity.json: the estimate, refusals and the
//! guard's batches, replayed on the Rust copy. The calls of queries.ts
//! (the inbox's own query templates, Phase 8) are skipped here.

use super::*;
use roamgate_protocol::vectors::{self, Call};
use serde_json::json;

/// A `$fn` argument: its recorded calls, looked up by arguments.
fn recorded(value: &Value) -> Vec<(Vec<Value>, Option<Value>, Option<String>)> {
    value["$fn"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| {
            (
                call["args"].as_array().unwrap().clone(),
                call.get("result").cloned(),
                call.get("throws")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )
        })
        .collect()
}

fn provider(value: &Value) -> Provider {
    match value.as_str() {
        Some("github") => Provider::Github,
        _ => Provider::Gitlab,
    }
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.is_finite() {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn error_message(value: &Value) -> Option<String> {
    value["$error"]["message"].as_str().map(str::to_owned)
}

async fn replay(guard: &ComplexityGuard, call: &Call) -> Result<Value, String> {
    let args = &call.args;
    match call.target().as_str() {
        "complexity.estimateComplexity" => Ok(number(estimate_complexity(
            &vectors::text(&args[0]).unwrap(),
        ))),
        "complexity.GITLAB_MAX_COMPLEXITY" => Ok(number(GITLAB_MAX_COMPLEXITY)),
        "complexity.complexityRefusal" => {
            let refusal = match error_message(&args[0]) {
                Some(message) => refusal_in(&message),
                None => complexity_refusal(&args[0]),
            };
            Ok(refusal.map_or(
                Value::Null,
                |r| json!({"complexity": number(r.complexity), "max": number(r.max)}),
            ))
        }
        "on.limit" => Ok(guard.limit(args[0].as_str().unwrap()).map_or(
            Value::Null,
            |l| json!({"max": number(l.max), "scale": l.scale}),
        )),
        "on.pack" | "on.run" => {
            let host = args[0].as_str().unwrap();
            let units = args[2].as_array().unwrap().clone();
            let builds = recorded(&args[3]);
            let build = move |part: &[Value]| -> String {
                let found = builds
                    .iter()
                    .find(|(a, _, _)| a[0] == Value::Array(part.to_vec()))
                    .unwrap_or_else(|| panic!("no recorded build for {part:?}"));
                found.1.clone().unwrap().as_str().unwrap().to_owned()
            };
            if call.target() == "on.pack" {
                let most = args
                    .get(4)
                    .and_then(Value::as_u64)
                    .map_or(usize::MAX, |m| m as usize);
                let batches = guard.pack(host, provider(&args[1]), &units, &build, most);
                return Ok(json!(batches));
            }
            let asks = recorded(&args[4]);
            let most = args
                .get(5)
                .and_then(Value::as_u64)
                .map_or(usize::MAX, |m| m as usize);
            guard
                .run(
                    host,
                    provider(&args[1]),
                    &units,
                    &build,
                    |query: String, part: Vec<Value>| {
                        let found = asks
                            .iter()
                            .find(|(a, _, _)| a[0] == json!(query) && a[1] == json!(part))
                            .cloned()
                            .unwrap_or_else(|| panic!("no recorded ask for {query}"));
                        async move {
                            match found.2 {
                                Some(message) => Err(AskError(message)),
                                None => Ok(found.1.unwrap_or(Value::Null)),
                            }
                        }
                    },
                    most,
                )
                .await
                .map(Value::Array)
                .map_err(|error| error.0)
        }
        other => panic!("unexpected call {other}"),
    }
}

#[tokio::test]
async fn the_complexity_vectors_hold() {
    let file = vectors::load("mr-complexity");
    let mut checked = 0;
    for case in &file.cases {
        let mut guard = ComplexityGuard::default();
        for call in &case.calls {
            let target = call.target();
            if target.starts_with("queries.") {
                continue;
            }
            if target == "complexity.createComplexityGuard" {
                guard = ComplexityGuard::default();
                continue;
            }
            let outcome = replay(&guard, call).await;
            match (&call.throws, outcome) {
                (Some(message), Err(got)) => assert_eq!(&got, message, "{}", case.title()),
                (None, Ok(got)) => assert_eq!(
                    got,
                    call.result.clone().unwrap_or(Value::Null),
                    "{}: {target}",
                    case.title()
                ),
                (expected, got) => panic!(
                    "{}: {target}: expected {expected:?}, got {got:?}",
                    case.title()
                ),
            }
            checked += 1;
        }
    }
    assert!(checked > 30, "only {checked} calls checked");
}

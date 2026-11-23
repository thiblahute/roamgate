//! The T0 vectors of the MR reviews (`contract/vectors/mr-*.json`),
//! replayed against the Rust ports: each call dispatched on its `fn`, a
//! name not known here failing the run.

use roamgate_agents::js::{self, Obj};
use roamgate_protocol::vectors::{self, Call};
use serde_json::{Value, json};

use crate::queries;
use crate::shared::{filter, merge, order};

/// `$text` long strings written out, recursively.
fn decode(value: &Value) -> Value {
    if let Some(("$text", _)) = vectors::tag(value) {
        return Value::String(vectors::text(value).unwrap_or_default());
    }
    match value {
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), decode(v))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(decode).collect()),
        other => other.clone(),
    }
}

/// A Map's entries as the vectors write them.
fn map_value(entries: Vec<(String, Obj)>) -> Value {
    json!({"$map": entries.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()})
}

/// A value as the test compares it: `undefined` properties left out.
fn clean(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if vectors::is_undefined(value) {
                return Value::Null;
            }
            Value::Object(
                map.iter()
                    .filter(|(_, v)| !vectors::is_undefined(v))
                    .map(|(k, v)| (k.clone(), clean(v)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(clean).collect()),
        Value::Number(n) => js::number(n.as_f64().unwrap_or(0.0)),
        other => other.clone(),
    }
}

fn arg(call: &Call, index: usize) -> Value {
    call.args
        .get(index)
        .map(decode)
        .map(js::js_value)
        .unwrap_or(Value::Null)
}

fn given(call: &Call, index: usize) -> Option<Value> {
    call.args
        .get(index)
        .filter(|v| !vectors::is_undefined(v))
        .map(decode)
        .map(js::js_value)
}

/// What a call that may throw gave: its result, or `Err(message)`.
type Outcome = Result<Value, String>;

fn obj(value: &Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn opt<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

fn sections(value: &Value) -> order::Sections {
    order::SECTIONS.map(|name| strings(value.get(name).unwrap_or(&Value::Null)))
}

fn sections_json(sections: &order::Sections) -> Value {
    let mut map = Obj::new();
    for (index, name) in order::SECTIONS.iter().enumerate() {
        map.insert((*name).into(), json!(sections[index]));
    }
    Value::Object(map)
}

fn order_op(value: &Value) -> order::OrderOp {
    let keys = strings(value.get("keys").unwrap_or(&Value::Null));
    let target = js::sv(value.get("target")).to_owned();
    match js::sv(value.get("op")) {
        "top" => order::OrderOp::Top(keys),
        "bottom" => order::OrderOp::Bottom(keys),
        "before" => order::OrderOp::Before(keys, target),
        "after" => order::OrderOp::After(keys, target),
        _ => order::OrderOp::Arrange(keys),
    }
}

fn merge_input(value: &Value) -> (Obj, merge::Rules) {
    (
        obj(value),
        merge::Rules::from_json(value.get("rules").unwrap_or(&Value::Null)),
    )
}

/// What the call gave, or None when the name is not known here.
pub(crate) fn run(call: &Call) -> Option<Outcome> {
    let target = call.target();
    if let Some(outcome) = run_queries(call, &target) {
        return Some(outcome);
    }
    Some(Ok(match target.as_str() {
        // shared/mrReviewsOrder.ts
        "mrReviewsOrder.orderMrEntries" => {
            let entries: Vec<Value> = arg(call, 0).as_array().cloned().unwrap_or_default();
            let order = strings(&arg(call, 1));
            Value::Array(order::order_entries(&entries, &order, |e| {
                e.get("key").and_then(Value::as_str).unwrap_or("")
            }))
        }
        "mrReviewsOrder.applyMrOrderOp" => {
            let outcome = order::apply_order_op(&sections(&arg(call, 0)), &order_op(&arg(call, 1)));
            json!({
                "sections": sections_json(&outcome.sections),
                "moved": outcome.moved,
                "unknown": outcome.unknown,
                "elsewhere": outcome.elsewhere,
            })
        }
        "mrReviewsOrder.flattenMrSections" => {
            json!(order::flatten_sections(&sections(&arg(call, 0))))
        }
        "mrReviewsOrder.storedMrOrder" => json!(order::stored_order(
            &strings(&arg(call, 0)),
            &strings(&arg(call, 1))
        )),
        "mrReviewsOrder.rebaseMrOrder" => {
            json!(order::rebase_order(
                &strings(&arg(call, 0)),
                &strings(&arg(call, 1)),
                &strings(&arg(call, 2))
            ))
        }
        // shared/mrReviewsFilter.ts
        "mrReviewsFilter.parseMrFilter" => filter::parse(js::sv(Some(&arg(call, 0)))).to_json(),
        "mrReviewsFilter.mrFilterMatches" => {
            json!(filter::matches(
                &obj(&arg(call, 0)),
                &filter::Filter::from_json(&arg(call, 1))
            ))
        }
        "mrReviewsFilter.mrFilterIsOwn" => {
            json!(filter::is_own(&filter::Filter::from_json(&arg(call, 0))))
        }
        "mrReviewsFilter.mrFilterCompletions" => {
            let entries: Vec<Obj> = arg(call, 1)
                .as_array()
                .into_iter()
                .flatten()
                .map(obj)
                .collect();
            Value::Array(
                filter::completions(js::sv(Some(&arg(call, 0))), &entries)
                    .into_iter()
                    .map(|(label, insert)| json!({"label": label, "insert": insert}))
                    .collect(),
            )
        }
        // shared/mrReviewsMerge.ts
        "mrReviewsMerge.parseMergeDelay" => {
            opt(merge::parse_merge_delay(js::sv(Some(&arg(call, 0)))).map(js::number))
        }
        "mrReviewsMerge.formatMergeDelay" => {
            json!(merge::format_merge_delay(
                arg(call, 0).as_f64().unwrap_or(0.0)
            ))
        }
        "mrReviewsMerge.mergeAfterLabel" => opt(merge::merge_after_label(
            &strings(&arg(call, 0)),
            &strings(&arg(call, 1)),
        )
        .map(|(label, delay)| json!({"label": label, "delayMs": js::number(delay)}))),
        "mrReviewsMerge.queueLabel" => opt(merge::queue_label(
            &strings(&arg(call, 0)),
            &strings(&arg(call, 1)),
        )),
        "mrReviewsMerge.botFailureReason" => opt(merge::bot_failure_reason(
            js::sv(Some(&arg(call, 0))),
            &strings(&arg(call, 1)),
        )),
        "mrReviewsMerge.mrMergeRulesFor" => {
            let settings = arg(call, 0);
            let reference = arg(call, 1);
            let given =
                (!settings.is_null() && !vectors::is_undefined(&settings)).then_some(&settings);
            merge::rules_for(
                given,
                js::sv(reference.get("host")),
                js::sv(reference.get("project")),
            )
            .to_json()
        }
        "mrReviewsMerge.mrMergeScope" => opt(merge::merge_scope(&arg(call, 0))),
        "mrReviewsMerge.mrMergePattern" => opt(merge::merge_pattern(&arg(call, 0))),
        "mrReviewsMerge.mrBotName" => json!(merge::bot_name(js::sv(Some(&arg(call, 0))))),
        "mrReviewsMerge.mrBotLabel" => json!(merge::bot_label(&obj(&arg(call, 0)))),
        "mrReviewsMerge.mrMergeFact" => {
            let info = arg(call, 0);
            json!(merge::merge_fact(info.as_object()))
        }
        "mrReviewsMerge.mrMergeInfo" => {
            let value = arg(call, 0);
            let (input, rules) = merge_input(&value);
            let input = merge::MergeInput {
                state: js::sv(input.get("state")),
                labels: strings(input.get("labels").unwrap_or(&Value::Null)),
                updated_at: js::sv(input.get("updatedAt")),
                facts: input.get("facts"),
                notes: input
                    .get("notes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(obj)
                    .collect(),
                rules: &rules,
                user: input.get("user").and_then(Value::as_str),
                now: input.get("now").and_then(Value::as_f64).unwrap_or(0.0),
            };
            opt(merge::merge_info(&input).map(Value::Object))
        }
        _ => return None,
    }))
}

fn followed(call: &Call, index: usize) -> Vec<String> {
    strings(&arg(call, index))
}

fn inbox_parts(call: &Call, index: usize) -> Option<Vec<queries::InboxPart>> {
    given(call, index).map(|parts| {
        parts
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| match p.as_u64() {
                Some(n) => queries::InboxPart::Followed(n as usize),
                None => queries::InboxPart::Mine,
            })
            .collect()
    })
}

fn run_queries(call: &Call, target: &str) -> Option<Outcome> {
    let host = || js::sv(Some(&arg(call, 0))).to_owned();
    let provider = || js::sv(Some(&arg(call, 0))).to_owned();
    Some(match target {
        "queries.gitlabInboxQuery" => Ok(json!(queries::gitlab_inbox_query(
            &followed(call, 0),
            inbox_parts(call, 1).as_deref()
        ))),
        "queries.githubInboxQuery" => Ok(json!(queries::github_inbox_query(
            &followed(call, 0),
            inbox_parts(call, 1).as_deref()
        ))),
        "queries.parseGitlabInbox" => {
            queries::parse_gitlab_inbox(&host(), &followed(call, 1), &arg(call, 2))
                .map(|a| a.to_json())
        }
        "queries.parseGithubInbox" => {
            queries::parse_github_inbox(&host(), &followed(call, 1), &arg(call, 2))
                .map(|a| a.to_json())
        }
        "queries.gitlabItem" => Ok(opt(
            queries::gitlab_item(&host(), &arg(call, 1)).map(Value::Object)
        )),
        "queries.githubItem" => Ok(opt(
            queries::github_item(&host(), &arg(call, 1)).map(Value::Object)
        )),
        "queries.gitlabOwnListQuery" | "queries.githubOwnListQuery" => {
            let after = given(call, 0).and_then(|a| a.as_str().map(str::to_owned));
            let parts: Option<Vec<String>> = given(call, 1).map(|p| strings(&p));
            let parts: Option<Vec<&str>> = parts
                .as_ref()
                .map(|p| p.iter().map(String::as_str).collect());
            Ok(json!(if target == "queries.gitlabOwnListQuery" {
                queries::gitlab_own_list_query(after.as_deref(), parts.as_deref())
            } else {
                queries::github_own_list_query(after.as_deref(), parts.as_deref())
            }))
        }
        "queries.ownDetailsQuery" => {
            let items: Vec<(String, u64)> = arg(call, 1)
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| {
                    (
                        js::sv(i.get("project")).to_owned(),
                        i.get("number").and_then(Value::as_u64).unwrap_or(0),
                    )
                })
                .collect();
            let fields = given(call, 2)
                .and_then(|f| f.as_str().map(str::to_owned))
                .unwrap_or_else(|| "full".into());
            Ok(json!(queries::own_details_query(
                &provider(),
                &items,
                &fields
            )))
        }
        "queries.parseOwnDetails" => {
            queries::parse_own_details(&provider(), js::sv(Some(&arg(call, 1))), &arg(call, 2))
                .map(map_value)
        }
        "queries.ownNotes" => Ok(json!(queries::own_notes(&provider(), &arg(call, 1)))),
        "queries.lesserOwnFields" => Ok(opt(queries::lesser_own_fields(
            &provider(),
            js::sv(Some(&arg(call, 1))),
        ))),
        "queries.gitlabSystemEvents" => Ok(json!(queries::gitlab_system_events(
            js::sv(Some(&arg(call, 0))),
            js::sv(Some(&arg(call, 1))),
            js::sv(Some(&arg(call, 2)))
        ))),
        "queries.parseLabelEvents" => Ok(Value::Object(queries::parse_label_events(&arg(call, 0)))),
        _ => return None,
    })
}

fn replay(name: &str) -> (usize, Vec<String>) {
    let file = vectors::load(name);
    let mut ran = 0;
    let mut failures = Vec::new();
    for case in &file.cases {
        for call in &case.calls {
            let target = call.target();
            let Some(outcome) = run(call) else {
                panic!("{name}: {}: no Rust port of {target}", case.title());
            };
            ran += 1;
            if let Some(message) = &call.throws {
                if outcome.as_ref().err() != Some(message) {
                    failures.push(format!(
                        "{name}: {} > {target}\n  got:  {outcome:?}\n  want: throws {message}",
                        case.title()
                    ));
                }
                continue;
            }
            let got = match outcome {
                Ok(got) => got,
                Err(message) => {
                    failures.push(format!(
                        "{name}: {} > {target}: threw {message}",
                        case.title()
                    ));
                    continue;
                }
            };
            let want = decode(&call.result.clone().unwrap_or(json!({"$undefined": true})));
            let (got, want) = (clean(&got), clean(&want));
            if got != want {
                failures.push(format!(
                    "{name}: {} > {target}\n  got:  {}\n  want: {}",
                    case.title(),
                    js::stringify(&got),
                    js::stringify(&want)
                ));
            }
        }
    }
    (ran, failures)
}

macro_rules! vector_test {
    ($test:ident, $file:literal) => {
        #[test]
        fn $test() {
            let (ran, failures) = replay($file);
            assert!(ran > 0, "{}: no call replayed", $file);
            assert!(
                failures.is_empty(),
                "{} failures:\n{}",
                failures.len(),
                failures.join("\n")
            );
        }
    };
}

vector_test!(mr_reviews_order_vectors, "mr-reviews-order");
vector_test!(mr_reviews_filter_vectors, "mr-reviews-filter");
vector_test!(mr_reviews_merge_vectors, "mr-reviews-merge");
vector_test!(mr_queries_vectors, "mr-queries");

//! Ranger's wire validators and limits (`shared/assistant.ts`), held to
//! `contract/vectors/assistant.json`. Values are JavaScript values
//! (`serde_json` maps in insertion order): the validators answer what the
//! TS type guards answer, lengths in UTF-16 code units.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js;
use serde_json::{Map, Value};

pub const ASSISTANT_MAX_WORKSPACES: usize = 512;
pub const ASSISTANT_MAX_MENTIONS: usize = 32;
pub const ASSISTANT_MAX_CUSTOM_MODELS: usize = 100;
pub const ASSISTANT_MAX_TOOL_ARGUMENTS: usize = 8_000;
pub const ASSISTANT_MAX_TOOL_OUTPUT: usize = 16_000;
pub const ASSISTANT_MAX_THINKING: usize = 16_000;
pub const ASSISTANT_MAX_THINKING_STEPS: usize = 64;
pub const ASSISTANT_MAX_TOOL_DETAILS: usize = 128_000;
pub const ASSISTANT_MAX_QUEUED: usize = 8;

/// The provider whose turns run on the bridge's Claude Code (`claude`).
pub const CLAUDE_CODE_PROVIDER: &str = "claude-code";

pub const ASSISTANT_THINKING_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub const ASSISTANT_MODEL_APIS: [&str; 3] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
];

pub const ACTION_KINDS: [&str; 9] = [
    "create_workspace",
    "create_worktree",
    "create_tab",
    "split_pane",
    "start_agent",
    "send_prompt",
    "close_workspace",
    "close_pane",
    "close_agent",
];

static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$").unwrap());
static HEX64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}$").unwrap());

/// A lowercase UUID, as `randomUUID` makes them.
pub fn is_uuid(text: &str) -> bool {
    UUID.is_match(text)
}

/// 64 lowercase hex digits (a SHA-256).
pub fn is_hex64(text: &str) -> bool {
    HEX64.is_match(text)
}

pub fn is_thinking_level(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|level| ASSISTANT_THINKING_LEVELS.contains(&level))
}

pub fn is_model_api(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|api| ASSISTANT_MODEL_APIS.contains(&api))
}

/// `isAssistantModelEndpoint`: an http(s) URL with a host and no
/// credentials, query, fragment, control characters or `$`.
pub fn is_model_endpoint(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    if js::len16(text) > 2000 || text.chars().any(|c| c <= '\u{20}' || c == '\u{7f}') {
        return false;
    }
    let Ok(url) = url::Url::parse(text) else {
        return false;
    };
    (url.scheme() == "https" || url.scheme() == "http")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty)
        && !text.contains('$')
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn has(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key).is_some()
}

/// `Number.isSafeInteger(value) && value >= 0`.
pub fn generation(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|n| js::is_safe_integer(n) && n >= 0.0)
}

fn safe_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(js::is_safe_integer)
}

fn nonempty(value: Option<&Value>) -> bool {
    text(value).is_some_and(|text| !text.is_empty())
}

/// `typeof value === "string" && Number.isFinite(Date.parse(value))`.
pub fn timestamp(value: Option<&Value>) -> bool {
    text(value).is_some_and(|text| js::date_parse(text).is_finite())
}

fn workspace_ref(value: Option<&Value>) -> bool {
    record(value)
        .is_some_and(|map| nonempty(map.get("connection_id")) && nonempty(map.get("workspace_id")))
}

fn mention_text(value: Option<&Value>, max: usize) -> bool {
    text(value).is_some_and(|text| {
        !js::trim(text).is_empty()
            && js::len16(text) <= max
            && !text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}

fn one_of(value: Option<&Value>, options: &[&str]) -> bool {
    // `[...].includes(String(value))`: a missing value is "undefined".
    let text = match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js::to_text(other),
        None => "undefined".to_owned(),
    };
    options.contains(&text.as_str())
}

/// Whether `timezone` names a time zone `Intl.DateTimeFormat` accepts.
pub fn valid_timezone(timezone: &str) -> bool {
    !timezone.is_empty() && jiff::tz::TimeZone::get(timezone).is_ok()
}

pub fn is_mention_target(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let agent = map.get("kind").and_then(Value::as_str) == Some("agent");
    let mut allowed = vec![
        "kind",
        "connection_id",
        "workspace_id",
        "runtime_generation",
        "connection_label",
        "workspace_label",
        "label",
    ];
    if agent {
        allowed.extend(["pane_id", "terminal_id", "agent", "agent_identity"]);
    }
    mention_text(map.get("connection_id"), 500)
        && mention_text(map.get("workspace_id"), 500)
        && generation(map.get("runtime_generation"))
        && mention_text(map.get("connection_label"), 200)
        && mention_text(map.get("workspace_label"), 200)
        && mention_text(map.get("label"), 200)
        && map.keys().all(|key| allowed.contains(&key.as_str()))
        && (map.get("kind").and_then(Value::as_str) == Some("workspace")
            || (agent
                && mention_text(map.get("pane_id"), 500)
                && mention_text(map.get("terminal_id"), 500)
                && mention_text(map.get("agent"), 200)
                && text(map.get("agent_identity")).is_some_and(is_hex64)))
}

pub fn is_mention_catalog(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    map.get("targets")
        .and_then(Value::as_array)
        .is_some_and(|targets| {
            targets.len() <= ASSISTANT_MAX_WORKSPACES + 200 && targets.iter().all(is_mention_target)
        })
        && map
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| errors.iter().all(Value::is_string))
        && map.get("truncated").is_none_or(Value::is_boolean)
}

/// `isAssistantMentions(value, messageText)`: ordered, non-overlapping
/// `@label` markers at their UTF-16 offsets.
pub fn is_mentions(value: &Value, message: &str) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    if items.len() > ASSISTANT_MAX_MENTIONS {
        return false;
    }
    let length = js::len16(message) as f64;
    let mut previous_end = 0.0;
    items.iter().all(|mention| {
        let Some(map) = mention.as_object() else {
            return false;
        };
        let mut target = map.clone();
        let start = target.shift_remove("start");
        let end = target.shift_remove("end");
        let target = Value::Object(target);
        let (Some(start), Some(end)) = (
            start.as_ref().and_then(Value::as_f64),
            end.as_ref().and_then(Value::as_f64),
        ) else {
            return false;
        };
        if !is_mention_target(&target)
            || !js::is_safe_integer(start)
            || !js::is_safe_integer(end)
            || start < previous_end
            || end <= start
            || end > length
        {
            return false;
        }
        let label = target.get("label").and_then(Value::as_str).unwrap_or("");
        if js::slice16(message, start as i64, Some(end as i64)) != format!("@{label}") {
            return false;
        }
        previous_end = end;
        true
    })
}

/// The workspaces of a task's scope, keyed as the TS keys them.
fn scope_key(map: &Map<String, Value>) -> String {
    js::stringify(&Value::Array(vec![
        map.get("connection_id").cloned().unwrap_or(Value::Null),
        map.get("workspace_id").cloned().unwrap_or(Value::Null),
    ]))
}

pub fn is_task_input(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let title_ok =
        text(map.get("title")).is_some_and(|t| !js::trim(t).is_empty() && js::len16(t) <= 100);
    let prompt_ok =
        text(map.get("prompt")).is_some_and(|t| !js::trim(t).is_empty() && js::len16(t) <= 32_000);
    let mentions_ok = match map.get("mentions") {
        None => true,
        Some(Value::Array(items)) => {
            items.len() <= ASSISTANT_MAX_MENTIONS && items.iter().all(is_mention_target)
        }
        Some(_) => false,
    };
    let mode_ok = match map.get("notification_mode") {
        None => true,
        Some(mode) => mode == "status" || mode == "agent",
    };
    let Some(scope) = map.get("scope").and_then(Value::as_array) else {
        return false;
    };
    if !title_ok
        || !prompt_ok
        || !mentions_ok
        || !mode_ok
        || scope.is_empty()
        || scope.len() > ASSISTANT_MAX_WORKSPACES
        || !scope.iter().all(|entry| workspace_ref(Some(entry)))
    {
        return false;
    }
    let keys: HashSet<String> = scope
        .iter()
        .filter_map(Value::as_object)
        .map(scope_key)
        .collect();
    if keys.len() != scope.len() {
        return false;
    }
    let Some(schedule) = record(map.get("schedule")) else {
        return false;
    };
    if let Some(Value::Array(mentions)) = map.get("mentions") {
        let outside = mentions.iter().any(|mention| {
            !scope.iter().any(|entry| {
                entry.get("connection_id") == mention.get("connection_id")
                    && entry.get("workspace_id") == mention.get("workspace_id")
            })
        });
        if outside {
            return false;
        }
    }
    match schedule.get("type").and_then(Value::as_str) {
        Some("once") => timestamp(schedule.get("at")),
        Some("interval") => schedule
            .get("minutes")
            .and_then(Value::as_f64)
            .is_some_and(|m| js::is_safe_integer(m) && (1.0..=525_600.0).contains(&m)),
        Some("daily") => {
            static TIME: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());
            text(schedule.get("time")).is_some_and(|t| TIME.is_match(t))
                && text(schedule.get("timezone"))
                    .is_some_and(|tz| js::len16(tz) <= 100 && intl_timezone(tz))
        }
        _ => false,
    }
}

/// `new Intl.DateTimeFormat("en", { timeZone })` does not throw: an IANA
/// name, or an offset as `+hh:mm`.
fn intl_timezone(timezone: &str) -> bool {
    static OFFSET: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?$").unwrap());
    OFFSET.is_match(timezone) || valid_timezone(timezone)
}

pub fn is_task_notification(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    text(map.get("task_id")).is_some_and(is_uuid)
        && text(map.get("run_id")).is_some_and(is_uuid)
        && matches!(
            map.get("status").and_then(Value::as_str),
            Some("succeeded" | "failed" | "waiting")
        )
        && text(map.get("title")).is_some_and(|t| !js::trim(t).is_empty() && js::len16(t) <= 200)
        && text(map.get("body")).is_some_and(|t| js::len16(t) <= 400)
}

const RUN_STATUSES: [&str; 6] = [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "stopped",
];

fn task_run(value: Option<&Value>) -> bool {
    let Some(map) = record(value) else {
        return false;
    };
    nonempty(map.get("id"))
        && nonempty(map.get("task_id"))
        && one_of(map.get("status"), &RUN_STATUSES)
        && timestamp(map.get("scheduled_at"))
        && (!has(map, "started_at") || timestamp(map.get("started_at")))
        && (!has(map, "finished_at") || timestamp(map.get("finished_at")))
        && (map.get("error") == Some(&Value::Null) || text(map.get("error")).is_some())
        && (!has(map, "notice") || text(map.get("notice")).is_some())
}

fn task(value: &Value) -> bool {
    if !is_task_input(value) {
        return false;
    }
    let map = value.as_object().unwrap();
    let id = text(map.get("id"));
    let scope_len = map
        .get("scope")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let run_of_task = |key: &str| {
        !has(map, key)
            || (task_run(map.get(key))
                && map.get(key).and_then(|run| run.get("task_id")) == map.get("id"))
    };
    id.is_some()
        && (!has(map, "approval_mode")
            || matches!(
                map.get("approval_mode").and_then(Value::as_str),
                Some("manual" | "auto")
            ))
        && id.is_some_and(|id| !id.is_empty())
        && one_of(map.get("status"), &["active", "paused", "cancelled"])
        && timestamp(map.get("created_at"))
        && timestamp(map.get("updated_at"))
        && (map.get("next_run_at") == Some(&Value::Null) || timestamp(map.get("next_run_at")))
        && record(map.get("model")).is_some_and(|model| {
            text(model.get("provider")).is_some() && text(model.get("id")).is_some()
        })
        && map
            .get("workspaces")
            .and_then(Value::as_array)
            .is_some_and(|workspaces| {
                workspaces.len() == scope_len
                    && workspaces.iter().all(|workspace| {
                        record(Some(workspace)).is_some_and(|w| {
                            text(w.get("label")).is_some()
                                && text(w.get("connection_label")).is_some()
                                && generation(w.get("runtime_generation"))
                        }) && workspace_ref(Some(workspace))
                    })
            })
        && run_of_task("current_run")
        && run_of_task("last_run")
}

const TASK_OPERATIONS: [&str; 6] = ["create", "update", "pause", "resume", "cancel", "delete"];

fn task_proposal(value: &Value) -> bool {
    if !is_task_input(value) {
        return false;
    }
    let map = value.as_object().unwrap();
    nonempty(map.get("id"))
        && text(map.get("status"))
            .is_some_and(|status| ["pending", "confirmed", "cancelled"].contains(&status))
        && timestamp(map.get("created_at"))
        && (!has(map, "task_id") || text(map.get("task_id")).is_some())
        && (!has(map, "detail") || text(map.get("detail")).is_some_and(|d| js::len16(d) <= 2000))
        && (!has(map, "operation")
            || (text(map.get("operation")).is_some_and(|op| TASK_OPERATIONS.contains(&op))
                && (map.get("operation") == Some(&Value::from("create"))
                    || nonempty(map.get("task_id")))))
}

pub fn is_task_detail(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(task_value) = map.get("task") else {
        return false;
    };
    if !task(task_value) {
        return false;
    }
    let Some(runs) = map.get("runs").and_then(Value::as_array) else {
        return false;
    };
    if runs.len() > 20 {
        return false;
    }
    let task_id = task_value.get("id");
    if !runs
        .iter()
        .all(|run| task_run(Some(run)) && run.get("task_id") == task_id)
    {
        return false;
    }
    match map.get("run") {
        None => true,
        Some(run) => {
            record(Some(run)).is_some_and(|r| {
                r.get("messages")
                    .and_then(Value::as_array)
                    .is_some_and(|messages| messages.len() <= 80 && messages.iter().all(is_message))
            }) && task_run(Some(run))
                && run.get("task_id") == task_id
                && runs.iter().any(|entry| entry.get("id") == run.get("id"))
        }
    }
}

const ACTION_STATUSES: [&str; 6] = [
    "pending",
    "executing",
    "succeeded",
    "failed",
    "uncertain",
    "cancelled",
];

fn action(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    nonempty(map.get("connection_id"))
        && nonempty(map.get("workspace_id"))
        && nonempty(map.get("id"))
        && text(map.get("kind")).is_some_and(|kind| ACTION_KINDS.contains(&kind))
        && text(map.get("status")).is_some_and(|status| ACTION_STATUSES.contains(&status))
        && generation(map.get("runtime_generation"))
        && text(map.get("connection_label")).is_some()
        && text(map.get("workspace_label")).is_some()
        && text(map.get("created_at")).is_some()
        && text(map.get("summary")).is_some()
        && text(map.get("detail")).is_some()
        && record(map.get("params")).is_some_and(|params| {
            params.len() <= 8
                && params
                    .values()
                    .all(|entry| entry.as_str().is_some_and(|t| js::len16(t) <= 20_000))
        })
}

pub fn is_show(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    text(map.get("connection_id")).is_some()
        && text(map.get("workspace_id")).is_some()
        && (!has(map, "pane_id") || text(map.get("pane_id")).is_some())
        && text(map.get("request_id")).is_some()
        && map.keys().all(|key| {
            ["connection_id", "workspace_id", "pane_id", "request_id"].contains(&key.as_str())
        })
}

fn tool_activity(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    text(map.get("id")).is_some()
        && text(map.get("name")).is_some()
        && (!has(map, "arguments")
            || text(map.get("arguments"))
                .is_some_and(|t| js::len16(t) <= ASSISTANT_MAX_TOOL_ARGUMENTS))
        && (!has(map, "output")
            || text(map.get("output")).is_some_and(|t| js::len16(t) <= ASSISTANT_MAX_TOOL_OUTPUT))
        && one_of(map.get("status"), &["running", "completed", "failed"])
}

fn source(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    nonempty(map.get("connection_id"))
        && nonempty(map.get("workspace_id"))
        && text(map.get("id")).is_some()
        && text(map.get("title")).is_some()
        && one_of(map.get("kind"), &["status", "history", "diff", "terminal"])
        && generation(map.get("runtime_generation"))
        && (!has(map, "pane_id") || text(map.get("pane_id")).is_some())
        && text(map.get("read_at")).is_some()
}

pub fn is_message(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(message_text) = text(map.get("text")) else {
        return false;
    };
    (!has(map, "show") || is_show(&map["show"]))
        && text(map.get("id")).is_some()
        && matches!(
            map.get("role").and_then(Value::as_str),
            Some("user" | "assistant")
        )
        && (!has(map, "thinking")
            || map
                .get("thinking")
                .and_then(Value::as_array)
                .is_some_and(|steps| {
                    steps.len() <= ASSISTANT_MAX_THINKING_STEPS
                        && steps.iter().all(Value::is_string)
                        && steps
                            .iter()
                            .map(|step| js::len16(step.as_str().unwrap_or("")))
                            .sum::<usize>()
                            <= ASSISTANT_MAX_THINKING
                }))
        && (!has(map, "thinking_skipped")
            || (safe_integer(map.get("thinking_skipped"))
                && map["thinking_skipped"].as_f64().unwrap_or(-1.0) >= 0.0))
        && (!has(map, "thinking_truncated")
            || map.get("thinking_truncated") == Some(&Value::Bool(true)))
        && (!has(map, "mentions") || is_mentions(&map["mentions"], message_text))
        && text(map.get("sent_at")).is_some()
        && (!has(map, "actions")
            || map
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|actions| actions.len() <= 8 && actions.iter().all(action)))
        && map
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| tools.iter().all(tool_activity))
        && map
            .get("sources")
            .and_then(Value::as_array)
            .is_some_and(|sources| sources.iter().all(source))
        && (!has(map, "task_proposals")
            || map
                .get("task_proposals")
                .and_then(Value::as_array)
                .is_some_and(|items| items.len() <= 8 && items.iter().all(task_proposal)))
}

pub fn is_queue(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    if items.len() > ASSISTANT_MAX_QUEUED {
        return false;
    }
    let valid = items.iter().all(|item| {
        let Some(map) = item.as_object() else {
            return false;
        };
        let Some(item_text) = text(map.get("text")) else {
            return false;
        };
        text(map.get("id")).is_some_and(|id| !id.is_empty() && js::len16(id) <= 500)
            && matches!(
                map.get("mode").and_then(Value::as_str),
                Some("steer" | "follow_up")
            )
            && !item_text.is_empty()
            && js::len16(item_text) <= 20_000
            && (!has(map, "mentions") || is_mentions(&map["mentions"], item_text))
            && timestamp(map.get("sent_at"))
    });
    let ids: HashSet<String> = items
        .iter()
        .map(|item| js::stringify(item.get("id").unwrap_or(&Value::Null)))
        .collect();
    valid && ids.len() == items.len()
}

fn session_summary(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    text(map.get("id")).is_some_and(is_uuid)
        && text(map.get("title")).is_some_and(|t| !t.is_empty() && js::len16(t) <= 80)
        && text(map.get("created_at")).is_some_and(|t| js::date_parse(t).is_finite())
        && text(map.get("updated_at")).is_some_and(|t| js::date_parse(t).is_finite())
        && generation(map.get("message_count"))
        && map["message_count"].as_f64().unwrap_or(f64::MAX) <= 80.0
}

fn provider(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    text(map.get("id")).is_some()
        && text(map.get("label")).is_some()
        && map.get("configured").is_some_and(Value::is_boolean)
        && (!has(map, "credential_method")
            || matches!(
                map.get("credential_method").and_then(Value::as_str),
                Some("api_key" | "oauth")
            ))
        && (!has(map, "custom")
            || record(map.get("custom")).is_some_and(|custom| {
                custom.get("base_url").is_some_and(is_model_endpoint)
                    && custom.get("api").is_some_and(is_model_api)
            }))
        && map
            .get("methods")
            .and_then(Value::as_array)
            .is_some_and(|methods| {
                methods
                    .iter()
                    .all(|method| method == "api_key" || method == "oauth")
            })
}

fn model(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let levels = map.get("thinking_levels").and_then(Value::as_array);
    text(map.get("provider")).is_some()
        && text(map.get("id")).is_some()
        && text(map.get("label")).is_some()
        && (!has(map, "thinking_levels")
            || levels.is_some_and(|levels| {
                levels.iter().all(is_thinking_level)
                    && levels
                        .iter()
                        .map(|level| level.as_str().unwrap_or(""))
                        .collect::<HashSet<_>>()
                        .len()
                        == levels.len()
            }))
        && (!has(map, "default_thinking_level")
            || (is_thinking_level(&map["default_thinking_level"])
                && levels.is_some_and(|levels| levels.contains(&map["default_thinking_level"]))))
        && (!has(map, "custom")
            || record(map.get("custom")).is_some_and(|custom| {
                custom.get("base_url").is_some_and(is_model_endpoint)
                    && custom.get("api").is_some_and(is_model_api)
                    && (!has(custom, "reasoning") || custom["reasoning"].is_boolean())
            }))
}

fn auth(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(map) = value.as_object() else {
        return false;
    };
    if !(text(map.get("id")).is_some()
        && text(map.get("provider")).is_some()
        && one_of(
            map.get("status"),
            &["waiting", "working", "completed", "failed"],
        )
        && text(map.get("message")).is_some()
        && (!has(map, "url") || text(map.get("url")).is_some())
        && (!has(map, "user_code") || text(map.get("user_code")).is_some()))
    {
        return false;
    }
    let Some(prompt) = map.get("prompt") else {
        return true;
    };
    record(Some(prompt)).is_some_and(|prompt| {
        text(prompt.get("id")).is_some()
            && text(prompt.get("message")).is_some()
            && one_of(
                prompt.get("type"),
                &["text", "secret", "select", "manual_code"],
            )
            && (!has(prompt, "options")
                || prompt
                    .get("options")
                    .and_then(Value::as_array)
                    .is_some_and(|options| {
                        options.iter().all(|option| {
                            record(Some(option)).is_some_and(|o| {
                                text(o.get("id")).is_some() && text(o.get("label")).is_some()
                            })
                        })
                    }))
    })
}

pub fn is_snapshot(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(config) = record(map.get("config")) else {
        return false;
    };
    let sessions_ok = match map.get("sessions") {
        None => true,
        Some(Value::Array(sessions)) => {
            sessions.iter().all(session_summary)
                && sessions
                    .iter()
                    .map(|session| js::stringify(session.get("id").unwrap_or(&Value::Null)))
                    .collect::<HashSet<_>>()
                    .len()
                    == sessions.len()
                && (!has(map, "session_id")
                    || sessions
                        .iter()
                        .any(|session| session.get("id") == map.get("session_id")))
        }
        Some(_) => false,
    };
    let tasks_ok = match map.get("tasks") {
        None => true,
        Some(Value::Array(tasks)) => {
            tasks.len() <= 50
                && tasks.iter().all(task)
                && tasks
                    .iter()
                    .map(|t| js::stringify(t.get("id").unwrap_or(&Value::Null)))
                    .collect::<HashSet<_>>()
                    .len()
                    == tasks.len()
        }
        Some(_) => false,
    };
    nonempty(map.get("instance_id"))
        && generation(map.get("revision"))
        && (!has(map, "chat_selection") || map.get("chat_selection") == Some(&Value::Bool(true)))
        && has(map, "session_id") == has(map, "sessions")
        && (!has(map, "session_id") || text(map.get("session_id")).is_some_and(is_uuid))
        && sessions_ok
        && map.get("running").is_some_and(Value::is_boolean)
        && (map.get("error") == Some(&Value::Null) || text(map.get("error")).is_some())
        && text(config.get("provider")).is_some()
        && text(config.get("model")).is_some()
        && (!has(config, "thinking_level") || is_thinking_level(&config["thinking_level"]))
        && one_of(config.get("credential_source"), &["assistant", "pi"])
        && (!has(config, "approval_mode")
            || matches!(
                config.get("approval_mode").and_then(Value::as_str),
                Some("manual" | "auto")
            ))
        && (!has(config, "workspace_scope")
            || config.get("workspace_scope") == Some(&Value::from("all")))
        && config
            .get("allowed_workspaces")
            .and_then(Value::as_array)
            .is_some_and(|refs| {
                refs.len() <= ASSISTANT_MAX_WORKSPACES
                    && refs.iter().all(|r| workspace_ref(Some(r)))
            })
        && map
            .get("providers")
            .and_then(Value::as_array)
            .is_some_and(|providers| providers.iter().all(provider))
        && map
            .get("models")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().all(model))
        && tasks_ok
        && map
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| messages.iter().all(is_message))
        && (!has(map, "queue") || is_queue(&map["queue"]))
        && (!has(map, "queue_held") || map.get("queue_held") == Some(&Value::Bool(true)))
        && map.get("auth").is_some_and(auth)
}

#[cfg(test)]
mod vectors_tests {
    use roamgate_protocol::vectors::{self, Call};
    use serde_json::{Value, json};

    use super::*;

    fn arg(call: &Call, index: usize) -> Value {
        call.args
            .get(index)
            .cloned()
            .map(js::js_value)
            .unwrap_or(Value::Null)
    }

    fn run(call: &Call) -> Value {
        let name = call.target();
        let name = name.strip_prefix("assistant.").unwrap_or(&name);
        let a = arg(call, 0);
        match name {
            "isAssistantMessage" => json!(is_message(&a)),
            "isAssistantSnapshot" => json!(is_snapshot(&a)),
            "isAssistantTaskInput" => json!(is_task_input(&a)),
            "isAssistantMentionTarget" => json!(is_mention_target(&a)),
            "isAssistantMentions" => {
                let message = arg(call, 1);
                json!(is_mentions(&a, message.as_str().unwrap_or("")))
            }
            "isAssistantTaskNotification" => json!(is_task_notification(&a)),
            "isAssistantTaskDetail" => json!(is_task_detail(&a)),
            "isAssistantMentionCatalog" => json!(is_mention_catalog(&a)),
            "ASSISTANT_MAX_TOOL_ARGUMENTS" => json!(ASSISTANT_MAX_TOOL_ARGUMENTS),
            "ASSISTANT_MAX_TOOL_OUTPUT" => json!(ASSISTANT_MAX_TOOL_OUTPUT),
            "ASSISTANT_MAX_THINKING" => json!(ASSISTANT_MAX_THINKING),
            "ASSISTANT_MAX_THINKING_STEPS" => json!(ASSISTANT_MAX_THINKING_STEPS),
            "ASSISTANT_THINKING_LEVELS" => json!(ASSISTANT_THINKING_LEVELS),
            "ASSISTANT_MAX_WORKSPACES" => json!(ASSISTANT_MAX_WORKSPACES),
            "ASSISTANT_MAX_MENTIONS" => json!(ASSISTANT_MAX_MENTIONS),
            other => panic!("assistant.json names {other}, unknown here"),
        }
    }

    /// Long strings (`$text`) and other tags written out.
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

    #[test]
    fn assistant_vectors() {
        let file = vectors::load("assistant");
        let mut failures = Vec::new();
        for case in &file.cases {
            for (index, call) in case.calls.iter().enumerate() {
                let mut call = call.clone();
                call.args = call.args.iter().map(decode).collect();
                let got = run(&call);
                let want = call
                    .result
                    .clone()
                    .map(|r| decode(&r))
                    .unwrap_or(Value::Null);
                if got != want {
                    failures.push(format!(
                        "{} #{index}: {} got {got}, want {want}",
                        case.title(),
                        call.target()
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}

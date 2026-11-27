//! The slash commands AGY answers in conversation mode without a turn:
//! /usage (the account's quota, from `agy -p /usage`), /context (the
//! context window the ACP session last reported) and /mode (ACP's
//! `session/set_mode`).

use roamgate_agents::js;
use roamgate_conversation::driver::{BoxFuture, CommandContext, CommandNotice, Object};
use serde_json::Value;

/// The modes `agy` takes (`--mode`), as ACP's `session/set_mode` names them.
const MODES: [&str; 4] = ["default", "accept-edits", "auto", "plan"];

/// How long `agy -p /usage` may take.
const USAGE_TIMEOUT_MS: u64 = 15_000;

/// The command a line is, if AGY answers it locally.
pub fn command<'a>(
    text: &'a str,
    context: &'a dyn CommandContext,
) -> Option<BoxFuture<'a, CommandNotice>> {
    let trimmed = js::trim(text);
    let (name, arg) = match trimmed.split_once(char::is_whitespace) {
        Some((name, arg)) => (name, arg.trim()),
        None => (trimmed, ""),
    };
    match name.to_ascii_lowercase().as_str() {
        "/usage" if arg.is_empty() => Some(Box::pin(usage(context))),
        "/context" if arg.is_empty() => Some(Box::pin(async move {
            CommandNotice {
                ok: true,
                text: format_agy_context_output(
                    context.context_usage(),
                    context.model().as_deref(),
                ),
            }
        })),
        "/mode" => Some(Box::pin(mode(arg.to_owned(), context))),
        _ => None,
    }
}

async fn usage(context: &dyn CommandContext) -> CommandNotice {
    match context
        .run("agy -p /usage --output-format json", USAGE_TIMEOUT_MS)
        .await
    {
        Ok(output) if output.code == Some(0) => CommandNotice {
            ok: true,
            text: format_agy_usage_output(
                &output.stdout,
                context.context_usage(),
                context.model().as_deref(),
            ),
        },
        Ok(output) => {
            let detail = [output.stderr.trim(), output.stdout.trim()]
                .into_iter()
                .find(|text| !text.is_empty())
                .unwrap_or("agy -p /usage exited with an error");
            CommandNotice {
                ok: false,
                text: format!("AGY /usage failed: {detail}"),
            }
        }
        Err(error) => CommandNotice {
            ok: false,
            text: format!("AGY /usage failed: {error}"),
        },
    }
}

async fn mode(arg: String, context: &dyn CommandContext) -> CommandNotice {
    if arg.is_empty() {
        return CommandNotice {
            ok: true,
            text: format!("AGY mode: use /mode <{}>.", MODES.join("|")),
        };
    }
    if !MODES.contains(&arg.as_str()) {
        return CommandNotice {
            ok: false,
            text: format!(
                "Unknown AGY mode '{arg}'. Expected one of: {}.",
                MODES.join(", ")
            ),
        };
    }
    let mut params = Object::new();
    params.insert("mode".into(), Value::String(arg.clone()));
    let error = match context.control("set_mode", params).await {
        None => Some("AGY did not answer in time".to_owned()),
        Some(answer) => answer.error.filter(|error| !error.is_empty()),
    };
    match error {
        None => CommandNotice {
            ok: true,
            text: format!("AGY mode set to {arg}."),
        },
        Some(error) => CommandNotice {
            ok: false,
            text: format!("Could not set AGY mode to {arg}: {error}"),
        },
    }
}

fn format_commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (idx, ch) in s.chars().enumerate() {
        if idx > 0 && (s.len() - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn format_reset_time(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("1970-01-01") || trimmed.starts_with("1969-12-31")
    {
        return None;
    }
    if let Some((date, rest)) = trimmed.split_once('T') {
        let hm = rest.get(..5).unwrap_or(rest).trim_end_matches('Z');
        return Some(format!("{date} {hm} UTC"));
    }
    Some(trimmed.to_owned())
}

/// Formats AGY's live context window usage (`/context`).
pub fn format_agy_context_output(context_usage: Option<(u64, u64)>, model: Option<&str>) -> String {
    let mut parts = Vec::new();
    match context_usage {
        Some((used, size)) if size > 0 => {
            let pct = (used as f64 / size as f64) * 100.0;
            parts.push(format!(
                "Context: {} / {} tokens ({pct:.1}%)",
                format_commas(used),
                format_commas(size)
            ));
        }
        _ => parts.push("Context: no usage reported yet in this session.".to_owned()),
    }
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        parts.push(format!("Model: {model}"));
    }
    parts.join(" | ")
}

/// Formats the JSON output of `agy -p /usage --output-format json` alongside
/// live session context usage when available.
pub fn format_agy_usage_output(
    stdout: &str,
    context_usage: Option<(u64, u64)>,
    model: Option<&str>,
) -> String {
    let parsed = stdout.lines().rev().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .starts_with('{')
            .then(|| serde_json::from_str::<Value>(trimmed).ok())
            .flatten()
    });
    let mut lines = Vec::new();
    if let Some(groups) = parsed
        .as_ref()
        .and_then(|v| v.pointer("/command/data/groups"))
        .and_then(Value::as_array)
        && !groups.is_empty()
    {
        lines.push("AGY Usage".to_owned());
        for group in groups {
            let Some(group_obj) = group.as_object() else {
                continue;
            };
            let group_name = js::sv(group_obj.get("name"));
            if !group_name.is_empty() {
                lines.push(format!("{group_name}:"));
            }
            if let Some(buckets) = group_obj.get("buckets").and_then(Value::as_array) {
                for bucket in buckets {
                    let Some(bucket_obj) = bucket.as_object() else {
                        continue;
                    };
                    let name = js::sv(bucket_obj.get("name"));
                    let pct = bucket_obj
                        .get("remaining_fraction")
                        .and_then(Value::as_f64)
                        .map(|f| (f * 100.0).round() as i64);
                    let reset = bucket_obj
                        .get("reset_time")
                        .and_then(Value::as_str)
                        .and_then(format_reset_time);
                    let mut row = String::from("  ");
                    if !name.is_empty() {
                        row.push_str(name);
                        row.push_str(": ");
                    }
                    if let Some(pct) = pct {
                        row.push_str(&format!("{pct}%"));
                    }
                    if let Some(reset) = reset {
                        row.push_str(&format!(" (resets {reset})"));
                    }
                    lines.push(row);
                }
            }
        }
    } else if let Some(resp) = parsed
        .as_ref()
        .and_then(|v| v.get("response"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        lines.push("AGY Usage".to_owned());
        lines.push(resp.trim().to_owned());
    } else if !stdout.trim().is_empty() {
        lines.push(stdout.trim().to_owned());
    } else {
        lines.push("Could not read AGY usage.".to_owned());
    }
    if context_usage.is_some() || model.is_some_and(|m| !m.is_empty()) {
        lines.push(format_agy_context_output(context_usage, model));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_agy_usage_json_and_context_usage() {
        let sample = r#"{"conversation_id":"","status":"SUCCESS","response":"fallback","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Weekly Limit Remaining","remaining_fraction":0.831,"reset_time":"2026-12-03T13:22:34Z"},{"name":"Five Hour Limit Remaining","remaining_fraction":0.325,"reset_time":"2026-11-26T18:22:34Z"}]},{"name":"Claude and GPT models","buckets":[{"name":"Weekly Limit Remaining","remaining_fraction":1.0,"reset_time":"1970-01-01T00:00:00Z"}]}]}}}"#;
        let out = format_agy_usage_output(sample, Some((12_542, 1_048_576)), Some("gemini-4-neon"));
        assert!(out.contains("AGY Usage"));
        assert!(out.contains("Gemini Models"));
        assert!(out.contains("Weekly Limit Remaining: 83% (resets 2026-12-03 13:22 UTC)"));
        assert!(out.contains("Five Hour Limit Remaining: 33% (resets 2026-11-26 18:22 UTC)"));
        assert!(out.contains("Claude and GPT models"));
        assert!(out.contains("Weekly Limit Remaining: 100%"));
        assert!(!out.contains("1970-01-01"));
        assert!(out.contains("Context: 12,542 / 1,048,576 tokens (1.2%)"));
        assert!(out.contains("Model: gemini-4-neon"));

        let ctx = format_agy_context_output(Some((12_542, 1_048_576)), Some("gemini-4-neon"));
        assert!(ctx.contains("12,542 / 1,048,576 tokens (1.2%)"));
        assert!(ctx.contains("Model: gemini-4-neon"));
    }
}

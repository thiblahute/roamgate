//! `session-artifacts.ts`: the artifacts a Claude session published.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj};

const ARTIFACT_URL: &str = r"(https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9_-]+)";
static CREATED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^Created a new Artifact at {ARTIFACT_URL}")).unwrap());
static PUBLISHED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^Published \S.*? at {ARTIFACT_URL}(?: \(Version ([0-9]+))?"
    ))
    .unwrap()
});

fn page_name(path: &str) -> String {
    let mut parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let last = parts.pop().unwrap_or("");
    let name = match last.rfind('.') {
        Some(at) if at + 1 < last.len() => &last[..at],
        _ => last,
    };
    if name == "index" {
        parts.pop().unwrap_or(name).to_owned()
    } else {
        name.to_owned()
    }
}

/// The artifact an Artifact tool call published, or None.
pub fn published_artifact(args: &Obj, output: &str) -> Option<Obj> {
    let action = match args.get("action") {
        None | Some(Value::Null) => "publish",
        Some(Value::String(s)) => s.as_str(),
        Some(_) => "",
    };
    if action != "publish" || js::is_true(args.get("asset")) {
        return None;
    }
    let created = CREATED.captures(output);
    let published = if created.is_some() {
        None
    } else {
        PUBLISHED.captures(output)
    };
    let url = created
        .as_ref()
        .map(|c| c[1].to_owned())
        .or_else(|| published.as_ref().map(|c| c[1].to_owned()))?;
    let title = js::str_of(args.get("title"))
        .map(js::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            js::str_of(args.get("file_path"))
                .map(page_name)
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "Artifact".into());
    let version = published
        .as_ref()
        .and_then(|c| c.get(2))
        .map(|m| js::number_from_text(m.as_str()))
        .filter(|v| *v != 0.0 && !v.is_nan());
    Some(obj! { "url" => url, "title" => title, "version" => version })
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| js::sv(part.get("text")).to_owned())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Every artifact a Claude session published, the most recent first.
pub fn parse_session_artifacts(records: &[Obj]) -> Vec<Value> {
    let mut calls: std::collections::HashMap<String, Obj> = Default::default();
    let mut artifacts: Vec<(String, Obj)> = Vec::new();
    for record in records {
        let Some(content) = record
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for part in content {
            let Some(part) = part.as_object() else {
                continue;
            };
            let kind = js::sv(part.get("type"));
            if kind == "tool_use" && js::sv(part.get("name")) == "Artifact" {
                if let (Some(Value::String(id)), Some(Value::Object(input))) =
                    (part.get("id"), part.get("input"))
                {
                    calls.insert(id.clone(), input.clone());
                }
            } else if kind == "tool_result"
                && !js::is_true(part.get("is_error"))
                && let Some(Value::String(use_id)) = part.get("tool_use_id")
            {
                let Some(args) = calls.get(use_id) else {
                    continue;
                };
                let Some(artifact) = published_artifact(args, &result_text(part.get("content")))
                else {
                    continue;
                };
                let url = js::sv(artifact.get("url")).to_owned();
                artifacts.retain(|(u, _)| *u != url);
                let mut entry = artifact;
                if let Some(Value::String(at)) = record.get("timestamp") {
                    entry.insert("published_at".into(), Value::String(at.clone()));
                }
                artifacts.push((url, entry));
            }
        }
    }
    artifacts
        .into_iter()
        .rev()
        .map(|(_, a)| Value::Object(a))
        .collect()
}

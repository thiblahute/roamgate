//! `session-commands.ts`: the skills and custom commands a Claude session
//! offers, from the listings Claude Code records.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js;

/// The commands, sorted by name as `localeCompare` sorts them.
pub fn parse_session_commands(records: &[Value]) -> Vec<Value> {
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_:.-]{1,100}$").unwrap());
    let mut commands: Vec<(String, String)> = Vec::new();
    for record in records {
        let Some(listing) = record.get("attachment").and_then(Value::as_object) else {
            continue;
        };
        if js::sv(listing.get("type")) != "skill_listing" {
            continue;
        }
        let Some(names) = listing.get("names").and_then(Value::as_array) else {
            continue;
        };
        let content = js::sv(listing.get("content"));
        let lines: Vec<&str> = content.split('\n').collect();
        for name in names {
            let Some(name) = name.as_str() else { continue };
            if !NAME.is_match(name) || js::len16(name) > 100 {
                continue;
            }
            let line = lines.iter().find(|each| {
                each.starts_with(&format!("- {name}:")) || each.starts_with(&format!("- {name} ("))
            });
            let description = line
                .map(|line| {
                    let from = (2 + name.len()).min(line.len());
                    let colon = line[from..].find(':').map(|at| at + from);
                    let after = match colon {
                        Some(at) => &line[at + 1..],
                        // indexOf gave -1: slice(0) is the whole line.
                        None => line,
                    };
                    js::trim(after).to_owned()
                })
                .unwrap_or_default();
            let description = js::head16(&description, 300);
            match commands.iter_mut().find(|(n, _)| n == name) {
                Some(entry) => entry.1 = description,
                None => commands.push((name.to_owned(), description)),
            }
        }
    }
    commands.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
    commands
        .into_iter()
        .map(|(name, description)| {
            Value::Object(obj! { "name" => name, "description" => description })
        })
        .collect()
}

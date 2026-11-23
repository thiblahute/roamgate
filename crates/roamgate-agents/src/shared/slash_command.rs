//! `shared/slashCommand.ts`: a slash command typed in Claude Code's
//! terminal, and what a command run in Claude Code printed.

use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::Value;

use crate::js;

#[derive(Debug, Clone, PartialEq)]
pub struct SlashCommand {
    /// With its slash: "/exit".
    pub name: String,
    pub args: String,
}

impl SlashCommand {
    pub fn to_value(&self) -> Value {
        Value::Object(obj! { "name" => self.name.clone(), "args" => self.args.clone() })
    }
}

fn tag(text: &str, name: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r"<{0}>([\s\S]*?)</{0}>", regex::escape(name))).unwrap();
    pattern
        .captures(text)
        .map(|caps| js::trim(&caps[1]).to_owned())
}

/// The command a user record is, or None.
pub fn parse_slash_command(text: &str) -> Option<SlashCommand> {
    static TAGS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<command-(?:name|message|args)>[\s\S]*?</command-[A-Za-z0-9_]+>").unwrap()
    });
    let raw = tag(text, "command-name").filter(|raw| !raw.is_empty())?;
    let rest = TAGS.replace_all(text, "");
    if !js::trim(&rest).is_empty() {
        return None;
    }
    let name = if raw.starts_with('/') {
        raw
    } else {
        format!("/{raw}")
    };
    Some(SlashCommand {
        name,
        args: tag(text, "command-args").unwrap_or_default(),
    })
}

/// What the command reads as: "/exit", "/model opus".
pub fn slash_command_text(command: &SlashCommand) -> String {
    if command.args.is_empty() {
        command.name.clone()
    } else {
        format!("{} {}", command.name, command.args)
    }
}

/// What a command run in Claude Code printed, or None.
pub fn local_command_output(text: &str) -> Option<String> {
    static STREAMS: LazyLock<FancyRegex> = LazyLock::new(|| {
        FancyRegex::new(r"<local-command-(stdout|stderr)>([\s\S]*?)</local-command-\1>").unwrap()
    });
    let streams: Vec<String> = STREAMS
        .captures_iter(text)
        .filter_map(Result::ok)
        .map(|caps| js::trim(&caps[2]).to_owned())
        .collect();
    if streams.is_empty() {
        return None;
    }
    let rest = STREAMS.replace_all(text, "");
    if !js::trim(&rest).is_empty() {
        return None;
    }
    let output = streams
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!output.is_empty()).then_some(output)
}

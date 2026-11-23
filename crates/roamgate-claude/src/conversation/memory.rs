//! How Claude Code reaches the companion's memory directory
//! (`drivers/claude-memory.ts`). Claude Code reads the directory by itself
//! once told where it is (`autoMemoryDirectory`): MEMORY.md is loaded at
//! the start of a session and its own rules for keeping files apply.
//! `--safe-mode` turns memory off, so these sessions leave it out and stay
//! bare another way: no user or project settings (so no CLAUDE.md, no
//! hooks, plugins or settings of the user's own) and hooks off for what
//! `--settings` itself could bring.
//!
//! The writer runs in `dontAsk` mode, with its file tools allowed for that
//! directory only: outside of it Read, Write and Edit are denied, whatever
//! the conversation it summarizes wrote.

use roamgate_agents::js::{self, Obj};
use roamgate_conversation::driver::{BackgroundMemoryLaunch, CompanionMemoryDriver};
use serde_json::{Value, json};

fn settings(dir: &str, extra: Obj) -> String {
    let mut settings = Obj::new();
    settings.insert("autoMemoryDirectory".into(), Value::String(dir.to_owned()));
    settings.insert("disableAllHooks".into(), Value::Bool(true));
    for (key, value) in extra {
        settings.insert(key, value);
    }
    js::stringify(&Value::Object(settings))
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

pub struct ClaudeMemoryDriver;

impl CompanionMemoryDriver for ClaudeMemoryDriver {
    fn reader(&self, dir: &str) -> Option<BackgroundMemoryLaunch> {
        Some(BackgroundMemoryLaunch {
            args: vec![
                "--setting-sources".into(),
                String::new(),
                "--settings".into(),
                settings(dir, Obj::new()),
            ],
            tools: String::new(),
            cwd: None,
        })
    }

    fn writer(&self, dir: &str) -> BackgroundMemoryLaunch {
        let mut extra = Obj::new();
        extra.insert(
            "permissions".into(),
            json!({"allow": [
                format!("Read({dir}/**)"),
                format!("Write({dir}/**)"),
                format!("Edit({dir}/**)"),
                "Glob",
            ]}),
        );
        let mut args = strings(&[
            "--setting-sources",
            "",
            "--permission-mode",
            "dontAsk",
            "--settings",
        ]);
        args.push(settings(dir, extra));
        BackgroundMemoryLaunch {
            args,
            tools: "Read,Write,Edit,Glob".into(),
            cwd: Some(dir.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_of(launch: &BackgroundMemoryLaunch) -> Value {
        let at = launch
            .args
            .iter()
            .position(|arg| arg == "--settings")
            .expect("--settings");
        serde_json::from_str(&launch.args[at + 1]).expect("JSON")
    }

    #[test]
    fn the_reader_leaves_safe_mode_and_has_no_tools() {
        let launch = ClaudeMemoryDriver.reader("/x/memories").expect("a reader");
        assert_eq!(launch.tools, "");
        assert!(!launch.args.iter().any(|arg| arg == "--safe-mode"));
        let settings = settings_of(&launch);
        assert_eq!(settings["autoMemoryDirectory"], "/x/memories");
        assert_eq!(settings["disableAllHooks"], true);
    }

    #[test]
    fn the_writers_file_tools_are_limited_to_the_directory() {
        let launch = ClaudeMemoryDriver.writer("/x/memories");
        assert_eq!(launch.cwd.as_deref(), Some("/x/memories"));
        assert_eq!(launch.tools, "Read,Write,Edit,Glob");
        assert!(launch.args.iter().any(|arg| arg == "dontAsk"));
        assert_eq!(
            settings_of(&launch)["permissions"]["allow"],
            json!([
                "Read(/x/memories/**)",
                "Write(/x/memories/**)",
                "Edit(/x/memories/**)",
                "Glob",
            ])
        );
    }
}

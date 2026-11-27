//! Antigravity CLI (`agy`) TUI terminal driver: process detection, kept
//! flags, screen readiness, `/exit`, and `agy --conversation <id>` resume.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js;

use roamgate_conversation::driver::{
    PaneProcess, TerminalDriver, TerminalReadiness, UNNAMED_SESSION_ID,
};

static AGY_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)agy(?:\.exe)?$").unwrap());
static AGY_CMDLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s/])agy(?:\.exe)?(?:\s|$)").unwrap());
static PS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(.*)$").unwrap());
static ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b(?:\[[0-9;:?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])").unwrap()
});

#[derive(Clone, Copy, PartialEq, Eq)]
enum Arity {
    None,
    One,
}

fn kept_flag(flag: &str) -> Option<Arity> {
    Some(match flag {
        "--model" | "--mode" | "--effort" | "--agent" | "--settings" | "--add-dir"
        | "--project" => Arity::One,
        "--dangerously-skip-permissions" | "--sandbox" | "--remote-agent" => Arity::None,
        _ => return None,
    })
}

fn is_headless_args(parts: &[&str], cmdline: &str) -> bool {
    parts.iter().any(|p| *p == "acp" || *p == "stream-json")
        || cmdline.contains(" acp")
        || cmdline.contains("stream-json")
}

/// Interactive `agy` terminal driver.
pub struct AgyTerminalDriver;

impl TerminalDriver for AgyTerminalDriver {
    fn agent(&self) -> &str {
        "agy"
    }

    fn herdr_agent(&self) -> &str {
        "agy"
    }

    fn display_name(&self) -> &str {
        "AGY"
    }

    fn is_agent_process(&self, process: &PaneProcess) -> bool {
        let mut parts: Vec<&str> = vec![process.argv0.as_deref().unwrap_or("")];
        parts.extend(process.argv.iter().flatten().map(String::as_str));
        let cmdline = process.cmdline.as_deref().unwrap_or("");
        if is_headless_args(&parts, cmdline) {
            return false;
        }
        if parts.iter().any(|part| AGY_PART.is_match(part)) {
            return true;
        }
        AGY_CMDLINE.is_match(cmdline)
    }

    fn kept_flags(&self, process: &PaneProcess) -> Vec<String> {
        let argv: &[String] = process.argv.as_deref().unwrap_or(&[]);
        let at = argv.iter().rposition(|arg| AGY_PART.is_match(arg));
        let rest = &argv[at.map_or(0, |at| at + 1)..];
        let mut kept = Vec::new();
        let mut index = 0;
        while index < rest.len() {
            let arg = &rest[index];
            let (flag, inline) = match arg.split_once('=') {
                Some((flag, value)) => (flag, Some(value)),
                None => (arg.as_str(), None),
            };
            let Some(arity) = kept_flag(flag) else {
                index += 1;
                continue;
            };
            if inline.is_some() {
                if arity != Arity::None {
                    kept.push(arg.clone());
                }
                index += 1;
                continue;
            }
            kept.push(arg.clone());
            if arity == Arity::One {
                match rest.get(index + 1) {
                    None => {
                        kept.pop();
                    }
                    Some(value) => {
                        kept.push(value.clone());
                        index += 1;
                    }
                }
            }
            index += 1;
        }
        kept
    }

    fn readiness(&self, screen: &str) -> TerminalReadiness {
        let plain = ESCAPE.replace_all(screen, "");
        if plain.contains("Confirm exit") || plain.contains("Press Ctrl+D again") {
            return TerminalReadiness {
                background: None,
                background_known: true,
                refusal: Some("AGY is waiting for confirmation in the terminal".into()),
            };
        }
        TerminalReadiness {
            background: None,
            background_known: true,
            refusal: None,
        }
    }

    fn exit_command(&self) -> &str {
        "/exit"
    }

    fn exit_dialog(&self, _screen: &str) -> Option<String> {
        None
    }

    fn background_work(&self, _screen: &str) -> Option<String> {
        None
    }

    fn resume_argv(&self, session_id: &str, flags: &[String]) -> Vec<String> {
        let mut argv = vec!["agy".to_owned()];
        argv.extend(flags.iter().cloned());
        if !session_id.is_empty() && session_id != UNNAMED_SESSION_ID {
            argv.push("--conversation".to_owned());
            argv.push(session_id.to_owned());
        }
        argv
    }

    fn headless_probe(&self, ps: &str, session_ids: &[String]) -> bool {
        let ids: Vec<&str> = session_ids
            .iter()
            .map(String::as_str)
            .filter(|id| !id.is_empty())
            .collect();
        if ids.is_empty() {
            return false;
        }
        ps.split('\n').any(|line| {
            AGY_CMDLINE.is_match(line)
                && (line.contains(" acp") || line.contains("stream-json"))
                && ids.iter().any(|id| line.contains(id))
        })
    }

    fn interactive_writer(
        &self,
        ps: &str,
        session_ids: &[String],
        except_pids: &[u32],
    ) -> Option<u32> {
        let ids: Vec<&str> = session_ids
            .iter()
            .map(String::as_str)
            .filter(|id| !id.is_empty())
            .collect();
        if ids.is_empty() {
            return None;
        }
        for line in ps.split('\n') {
            let Some(found) = PS_LINE.captures(line) else {
                continue;
            };
            let pid = js::number_from_text(&found[1]);
            let args = &found[2];
            if except_pids.iter().any(|except| f64::from(*except) == pid)
                || args.contains(" acp")
                || args.contains("stream-json")
                || !AGY_CMDLINE.is_match(args)
            {
                continue;
            }
            if ids.iter().any(|id| {
                args.contains(&format!("--conversation {id}"))
                    || args.contains(&format!("--conversation={id}"))
                    || args.contains(&format!("--resume {id}"))
                    || args.contains(&format!("--resume={id}"))
                    || args.contains(&format!("-r {id}"))
            }) {
                return (pid >= 0.0 && pid <= f64::from(u32::MAX)).then_some(pid as u32);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_interactive_and_headless_agy() {
        let tui = PaneProcess {
            pid: 10,
            argv: Some(vec![
                "/usr/local/bin/agy".into(),
                "--model".into(),
                "gemini-3-pro".into(),
                "--sandbox".into(),
                "--conversation".into(),
                "abc12345".into(),
            ]),
            ..Default::default()
        };
        assert!(AgyTerminalDriver.is_agent_process(&tui));
        assert_eq!(
            AgyTerminalDriver.kept_flags(&tui),
            vec!["--model", "gemini-3-pro", "--sandbox"]
        );

        let acp = PaneProcess {
            pid: 11,
            argv: Some(vec!["agy".into(), "acp".into(), "--stdio".into()]),
            ..Default::default()
        };
        assert!(!AgyTerminalDriver.is_agent_process(&acp));
    }

    #[test]
    fn resume_argv_uses_conversation_flag() {
        let argv = AgyTerminalDriver.resume_argv("conv-42", &["--sandbox".into()]);
        assert_eq!(argv, vec!["agy", "--sandbox", "--conversation", "conv-42"]);
    }

    #[test]
    fn detects_interactive_writer_excluding_acp() {
        let ps = " 101 agy acp --stdio --conversation conv-42\n 202 agy --conversation conv-42\n";
        assert_eq!(
            AgyTerminalDriver.interactive_writer(ps, &["conv-42".into()], &[]),
            Some(202)
        );
        assert_eq!(
            AgyTerminalDriver.interactive_writer(ps, &["conv-42".into()], &[202]),
            None
        );
    }
}

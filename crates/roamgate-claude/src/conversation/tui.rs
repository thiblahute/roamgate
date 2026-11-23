//! Claude Code's TUI (`drivers/claude-tui.ts`): its process and kept
//! flags, the screen parsers (prompt box, vim mode, footer, exit
//! question), /exit and `claude --resume`.

use std::sync::LazyLock;

use roamgate_agents::js;
use roamgate_conversation::driver::{PaneProcess, TerminalDriver, TerminalReadiness};

use super::js_re::{escape, fancy, regex};

/// Whether `ps -eo pid=,args=` lists a headless claude on one of these
/// sessions: its argv resumes the id and streams JSON. Matched by argv,
/// not by a recorded pid, which another process may have taken since.
pub fn ps_has_headless(ps_output: &str, session_ids: &[String]) -> bool {
    let ids: Vec<String> = session_ids
        .iter()
        .filter(|id| !id.is_empty())
        .map(|id| escape(id))
        .collect();
    if ids.is_empty() {
        return false;
    }
    let resume = fancy(
        &format!(r#"--resume['"\s]+(?:{})(?![\w-])"#, ids.join("|")),
        "",
    );
    ps_output
        .split('\n')
        .any(|line| line.contains("stream-json") && resume.is_match(line).unwrap_or(false))
}

static PS_LINE: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"^\s*(\d+)\s+(.*)$", ""));
static CLAUDE_ARGS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"(?:^|[\s/])claude(?:\.exe)?(?:\s|$)|claude-code", ""));

/// Whether `ps -eo pid=,args=` lists an interactive claude resuming one of
/// these sessions (not a headless one: those stream JSON), other than the
/// given pids. Its pid, if so.
pub fn ps_interactive_claude(
    ps_output: &str,
    session_ids: &[String],
    except_pids: &[u32],
) -> Option<u32> {
    let ids: Vec<String> = session_ids
        .iter()
        .filter(|id| !id.is_empty())
        .map(|id| escape(id))
        .collect();
    if ids.is_empty() {
        return None;
    }
    let resume = fancy(
        &format!(
            r#"(?:--resume|-r)(?:=|['"\s]+)(?:{})(?![\w-])"#,
            ids.join("|")
        ),
        "",
    );
    for line in ps_output.split('\n') {
        let Some(found) = PS_LINE.captures(line) else {
            continue;
        };
        let pid = js::number_from_text(&found[1]);
        let args = &found[2];
        if except_pids.iter().any(|except| f64::from(*except) == pid)
            || args.contains("stream-json")
        {
            continue;
        }
        if !CLAUDE_ARGS.is_match(args) {
            continue;
        }
        if resume.is_match(args).unwrap_or(false) {
            // A pid past u32 is no process of this system.
            return (pid >= 0.0 && pid <= f64::from(u32::MAX)).then_some(pid as u32);
        }
    }
    None
}

static CLAUDE_PART: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"(?:^|/)claude(?:\.exe)?$", ""));
static CLAUDE_CMDLINE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"(?:^|[\s/])claude(?:\s|$)|@anthropic-ai/claude-code", ""));

/// Whether a foreground process is an interactive Claude Code.
pub fn is_claude_process(process: &PaneProcess) -> bool {
    let mut parts: Vec<&str> = vec![process.argv0.as_deref().unwrap_or("")];
    parts.extend(process.argv.iter().flatten().map(String::as_str));
    let cmdline = process.cmdline.as_deref().unwrap_or("");
    // The pane holder's headless child (it streams JSON) is no TUI.
    if parts.contains(&"stream-json") || cmdline.contains("stream-json") {
        return false;
    }
    if parts.iter().any(|part| CLAUDE_PART.is_match(part)) {
        return true;
    }
    CLAUDE_CMDLINE.is_match(cmdline)
}

/// How each of claude's flags that a resumed TUI keeps takes values.
#[derive(Clone, Copy, PartialEq)]
enum Arity {
    None,
    One,
    Many,
}

fn kept_flag(flag: &str) -> Option<Arity> {
    Some(match flag {
        "--model"
        | "--permission-mode"
        | "--settings"
        | "--setting-sources"
        | "--agent"
        | "--effort"
        | "--fallback-model"
        | "--append-system-prompt"
        | "--system-prompt" => Arity::One,
        "--dangerously-skip-permissions"
        | "--allow-dangerously-skip-permissions"
        | "--strict-mcp-config"
        | "--ide"
        | "--verbose" => Arity::None,
        "--add-dir" | "--mcp-config" | "--allowedTools" | "--allowed-tools"
        | "--disallowedTools" | "--disallowed-tools" | "--plugin-dir" => Arity::Many,
        _ => return None,
    })
}

static CLAUDE_PROGRAM: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"(?:^|/)claude(?:\.exe)?$|claude-code/cli\.m?js$", ""));

/// The flags the pane's claude ran with that its resumed TUI keeps (model,
/// permission mode, directories, MCP configs...). Anything else (a session
/// to resume, a prompt, an unknown flag) is left out.
pub fn terminal_claude_args(process: &PaneProcess) -> Vec<String> {
    let argv: &[String] = process.argv.as_deref().unwrap_or(&[]);
    let at = argv.iter().rposition(|arg| CLAUDE_PROGRAM.is_match(arg));
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
        match arity {
            Arity::One => match rest.get(index + 1) {
                None => {
                    kept.pop();
                }
                Some(value) => {
                    kept.push(value.clone());
                    index += 1;
                }
            },
            Arity::Many => {
                while index + 1 < rest.len() && !rest[index + 1].starts_with('-') {
                    kept.push(rest[index + 1].clone());
                    index += 1;
                }
            }
            Arity::None => {}
        }
        index += 1;
    }
    kept
}

/// What Claude's prompt box holds, and its vim mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptBox {
    Empty,
    Draft,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimMode {
    Insert,
    Normal,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptBoxState {
    pub r#box: PromptBox,
    pub vim: VimMode,
}

static BORDER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"^[\s\u{2502}\u{2503}|]+|[\s\u{2502}\u{2503}|]+$", ""));
static RULE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex(
        r"^\s*[\u{2500}\u{2501}\u{2550}\u{256d}\u{256e}\u{256f}\u{2570}\u{2514}\u{2518}\u{250c}\u{2510}]{3,}",
        "",
    )
});
static ESCAPE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex(
        r"\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])",
        "",
    )
});
static PROMPT_MARK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"^\s*[\u{2502}\u{2503}|]?\s*\u{276f}", ""));
static INSERT: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"--\s*INSERT\s*--", ""));
static NORMAL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"--\s*(?:NORMAL|VISUAL)[^-\n]*--", ""));
static CODES: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"[;:]", ""));

/// The text of a line, its escapes left out.
fn plain_text(line: &str) -> String {
    ESCAPE.replace_all(line, "").into_owned()
}

/// `text.replace(BORDER, "")` (global).
fn without_border(text: &str) -> String {
    BORDER.replace_all(text, "").into_owned()
}

/// What the user typed on a line of Claude's prompt box: its text without
/// the dim parts (Claude's suggested next prompt, a placeholder) or the
/// cursor (inverse video).
fn typed_text(line: &str) -> String {
    let mut typed = String::new();
    let mut dim = false;
    let mut inverse = false;
    let mut at = 0;
    for found in ESCAPE.captures_iter(line) {
        let whole = found.get(0).expect("match");
        if !dim && !inverse {
            typed.push_str(&line[at..whole.start()]);
        }
        at = whole.end();
        if found.get(2).map(|m| m.as_str()) != Some("m") {
            continue;
        }
        let params = found.get(1).map_or("", |m| m.as_str());
        let params = if params.is_empty() { "0" } else { params };
        let codes: Vec<&str> = CODES.split(params).collect();
        let mut index = 0;
        while index < codes.len() {
            let code = if codes[index].is_empty() {
                0.0
            } else {
                js::number_from_text(codes[index])
            };
            // Colors' own parameters are not codes.
            if code == 38.0 || code == 48.0 || code == 58.0 {
                index += if codes.get(index + 1) == Some(&"5") {
                    2
                } else {
                    4
                };
                index += 1;
                continue;
            }
            if code == 0.0 {
                dim = false;
                inverse = false;
            } else if code == 2.0 {
                dim = true;
            } else if code == 22.0 {
                dim = false;
            } else if code == 7.0 {
                inverse = true;
            } else if code == 27.0 {
                inverse = false;
            }
            index += 1;
        }
    }
    if !dim && !inverse {
        typed.push_str(&line[at..]);
    }
    typed
}

/// Claude's prompt box and vim mode from the end of Claude's screen: the
/// last line with the prompt mark, and what follows it up to the box's
/// rule. With the screen's styles, dim text in the box (Claude's
/// suggestion of a next prompt) is not a draft; without them, any text is.
pub fn claude_prompt_state(text: &str) -> PromptBoxState {
    let lines: Vec<&str> = text.split('\n').collect();
    let plain: Vec<String> = lines.iter().map(|line| plain_text(line)).collect();
    let at = plain.iter().rposition(|line| PROMPT_MARK.is_match(line));
    let screen = plain.join("\n");
    let vim = if INSERT.is_match(&screen) {
        VimMode::Insert
    } else if NORMAL.is_match(&screen) {
        VimMode::Normal
    } else {
        VimMode::None
    };
    let Some(at) = at else {
        return PromptBoxState {
            r#box: PromptBox::Missing,
            vim,
        };
    };
    let first = without_border(&PROMPT_MARK.replace(&typed_text(lines[at]), ""));
    if !first.is_empty() {
        return PromptBoxState {
            r#box: PromptBox::Draft,
            vim,
        };
    }
    for index in at + 1..lines.len() {
        if RULE.is_match(&plain[index]) {
            break;
        }
        if !without_border(&typed_text(lines[index])).is_empty() {
            return PromptBoxState {
                r#box: PromptBox::Draft,
                vim,
            };
        }
    }
    PromptBoxState {
        r#box: PromptBox::Empty,
        vim,
    }
}

/// The lines from the last one with the prompt mark on: the box and footer.
fn lines_after_prompt(plain: &[String]) -> &[String] {
    match plain.iter().rposition(|line| PROMPT_MARK.is_match(line)) {
        Some(at) => &plain[at + 1..],
        None => &[],
    }
}

/// Footer words that name background work, as Claude Code writes them.
static WORK: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex(
        r"(?:^|\s)(\d+)\s+(shells?|bash(?:es)?|background tasks?|tasks?|monitors?|(?:local |background )?agents? running)(?:\s+(?:still\s+)?running)?\s*$",
        "i",
    )
});
static FOOTER_PARTS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"\s+\u{b7}\s+|\s+\u{b7}\s*$", ""));
static CUT_COUNT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"^[1-9]\d*(?:\s+\S*\u{2026})?$", ""));

/// Under this width (the prompt box's rule) Claude's footer is cut short:
/// "· 1 shell" may be gone from it, so it says nothing either way.
pub const FOOTER_MIN_WIDTH: usize = 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeFooter {
    /// The background work it shows ("1 shell"), or None.
    pub work: Option<String>,
    /// Whether its silence counts: false when the pane is too narrow for
    /// it (it is cut) or no prompt box is on screen.
    pub readable: bool,
}

/// JavaScript's `Number.parseInt(text, 10)` of a text starting with digits.
fn leading_int(text: &str) -> f64 {
    let digits: String = js::trim(text)
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    js::number_from_text(&digits)
}

/// The background work Claude's footer reports under its prompt box (a
/// background shell, a monitor, a task), as it words it: "1 shell". Claude
/// Code stops that work when it exits, so the terminal is not idle while
/// it runs, whatever Herdr says. Agents the footer lists ("← 18 agents")
/// are not counted: finished ones stay listed. A count whose word was cut
/// ("· 1" at the end of a narrow pane's footer) is work too.
pub fn claude_footer(text: &str) -> ClaudeFooter {
    let plain: Vec<String> = text.split('\n').map(plain_text).collect();
    let after = lines_after_prompt(&plain);
    // The box's rules: the narrower of the two around the prompt line.
    let width = after
        .iter()
        .find(|line| RULE.is_match(line))
        .map_or(0, |rule| js::len16(js::trim(rule)));
    let mut found: Vec<String> = Vec::new();
    let mut cut = 0.0;
    for line in after {
        for raw in FOOTER_PARTS.split(line) {
            let part = js::trim(raw);
            if let Some(work) = WORK.captures(part)
                && js::number_from_text(&work[1]) > 0.0
            {
                found.push(format!("{} {}", &work[1], work[2].to_lowercase()));
            } else if CUT_COUNT.is_match(part) {
                // A count cut from its word: "1", "2 sh…".
                cut += leading_int(part);
            }
        }
    }
    if !found.is_empty() {
        return ClaudeFooter {
            work: Some(found.join(", ")),
            readable: true,
        };
    }
    if cut != 0.0 {
        let word = if cut == 1.0 { "task" } else { "tasks" };
        return ClaudeFooter {
            work: Some(format!("{} background {word}", js::number_text(cut))),
            readable: true,
        };
    }
    ClaudeFooter {
        work: None,
        readable: width >= FOOTER_MIN_WIDTH,
    }
}

/// The background work Claude's footer shows ("1 shell"), or None.
pub fn claude_background_work(text: &str) -> Option<String> {
    claude_footer(text).work
}

static BACKGROUND_RUNNING: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"Background work is running", "i"));
static EXIT_AND_STOP: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"Exit and stop tasks", "i"));
static STAY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex(r"(?:^|[\s\u{276f}>])(\d)\.\s*Stay\s*$", "im"));

/// Claude Code's question when /exit finds background work running ("Exit
/// and stop tasks", "Move to background and exit", "Stay"): the key that
/// answers Stay (its number, or Escape, which cancels the same way), or
/// None when the question is not on screen.
pub fn claude_exit_dialog(text: &str) -> Option<String> {
    let screen = text
        .split('\n')
        .map(plain_text)
        .collect::<Vec<_>>()
        .join("\n");
    if !BACKGROUND_RUNNING.is_match(&screen) && !EXIT_AND_STOP.is_match(&screen) {
        return None;
    }
    Some(
        STAY.captures(&screen)
            .map_or_else(|| "\x1b".to_owned(), |stay| stay[1].to_owned()),
    )
}

/// Claude Code's TUI: the screen parsers above, its kept flags, /exit and
/// `claude --resume`.
pub struct ClaudeTerminalDriver;

impl TerminalDriver for ClaudeTerminalDriver {
    fn agent(&self) -> &str {
        "claude"
    }

    fn herdr_agent(&self) -> &str {
        "claude"
    }

    fn display_name(&self) -> &str {
        "Claude"
    }

    fn is_agent_process(&self, process: &PaneProcess) -> bool {
        is_claude_process(process)
    }

    fn kept_flags(&self, process: &PaneProcess) -> Vec<String> {
        terminal_claude_args(process)
    }

    fn readiness(&self, screen: &str) -> TerminalReadiness {
        let footer = claude_footer(screen);
        let refusal = if claude_exit_dialog(screen).is_some() {
            Some("Claude is asking whether to exit in the terminal")
        } else {
            let prompt = claude_prompt_state(screen);
            match (prompt.r#box, prompt.vim) {
                (PromptBox::Missing, _) => Some("Claude's prompt box is not on screen"),
                (PromptBox::Draft, _) => {
                    Some("Something is typed in Claude's prompt box; send or clear it first")
                }
                (_, VimMode::Normal) => {
                    Some("Claude's prompt is in vim normal mode; switch it to insert mode first")
                }
                _ => None,
            }
        };
        TerminalReadiness {
            background: footer.work,
            background_known: footer.readable,
            refusal: refusal.map(str::to_owned),
        }
    }

    fn exit_command(&self) -> &str {
        "/exit"
    }

    fn exit_dialog(&self, screen: &str) -> Option<String> {
        claude_exit_dialog(screen)
    }

    fn background_work(&self, screen: &str) -> Option<String> {
        claude_background_work(screen)
    }

    fn resume_argv(&self, session_id: &str, flags: &[String]) -> Vec<String> {
        let mut argv = vec!["claude".to_owned()];
        argv.extend(flags.iter().cloned());
        argv.push("--resume".into());
        argv.push(session_id.to_owned());
        argv
    }

    fn headless_probe(&self, ps: &str, session_ids: &[String]) -> bool {
        ps_has_headless(ps, session_ids)
    }

    fn interactive_writer(
        &self,
        ps: &str,
        session_ids: &[String],
        except_pids: &[u32],
    ) -> Option<u32> {
        ps_interactive_claude(ps, session_ids, except_pids)
    }
}

#[cfg(test)]
mod tests;

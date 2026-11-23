//! The TUI cases of `conversation/herdr.test.ts` (its probes, kept flags,
//! prompt box, footer and exit question are Claude's terminal driver's).

use roamgate_conversation::driver::PaneProcess;

use super::*;
use crate::conversation::testing::*;

const A: &str = "29616207-48e6-4ee2-b068-8fb98875a053";
const B: &str = "3892d0a6-1111-2222-3333-444444444444";

fn ids(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn finds_a_headless_claude_by_the_session_its_argv_resumes() {
    let ps = [
        format!("  812 /usr/sbin/some-daemon --resume {A}"),
        format!(
            " 4242 claude -p --resume {A} --input-format stream-json --output-format stream-json"
        ),
        format!(" 4300 claude --resume {B}"),
    ]
    .join("\n");
    assert!(ps_has_headless(&ps, &ids(&[A])));
    // The TUI on B is not a headless process.
    assert!(!ps_has_headless(&ps, &ids(&[B])));
    // After /clear the process still names the old id.
    assert!(ps_has_headless(&ps, &ids(&[B, A])));
    assert!(!ps_has_headless(&ps, &[]));
}

#[test]
fn sees_one_through_the_shell_that_starts_it_on_a_host() {
    let ps = format!(
        " 77 bash -lc cd '/w' && exec env -u X claude -p --resume '{A}' --input-format stream-json"
    );
    assert!(ps_has_headless(&ps, &ids(&[A])));
    // A longer id that only starts with it is another session.
    assert!(!ps_has_headless(&ps, &ids(&[&A[..20]])));
}

#[test]
fn an_interactive_claude_resuming_the_session_outside_the_given_pids() {
    let ps = [
        format!(
            " 4242 claude -p --resume {A} --input-format stream-json --output-format stream-json"
        ),
        format!(" 4300 claude --resume {A}"),
        format!(" 4400 node /opt/claude-code/cli.js --model haiku -r {A}"),
        format!(" 4500 vim notes-{A}.md"),
    ]
    .join("\n");
    assert_eq!(ps_interactive_claude(&ps, &ids(&[A]), &[]), Some(4300));
    assert_eq!(ps_interactive_claude(&ps, &ids(&[A]), &[4300]), Some(4400));
    assert_eq!(ps_interactive_claude(&ps, &ids(&[A]), &[4300, 4400]), None);
    assert_eq!(ps_interactive_claude(&ps, &ids(&[B]), &[]), None);
}

#[test]
fn model_permission_mode_and_directories_not_the_session_or_a_prompt() {
    let process = PaneProcess {
        pid: 1,
        argv: Some(ids(&[
            "/usr/local/bin/claude",
            "--model",
            "haiku",
            "--resume",
            A,
            "--permission-mode=plan",
            "--add-dir",
            "/a",
            "/b",
            "--dangerously-skip-permissions",
            "--continue",
            "--print",
            "a prompt",
        ])),
        ..PaneProcess::default()
    };
    assert_eq!(
        terminal_claude_args(&process),
        ids(&[
            "--model",
            "haiku",
            "--permission-mode=plan",
            "--add-dir",
            "/a",
            "/b",
            "--dangerously-skip-permissions",
        ])
    );
    let bare = PaneProcess {
        pid: 1,
        argv: Some(ids(&["claude"])),
        ..PaneProcess::default()
    };
    assert!(terminal_claude_args(&bare).is_empty());
    assert!(
        terminal_claude_args(&PaneProcess {
            pid: 1,
            ..PaneProcess::default()
        })
        .is_empty()
    );
}

fn rule24() -> String {
    "\u{2500}".repeat(24)
}

fn boxed(prompt: &str, after: &[&str]) -> String {
    let mut lines = vec![
        "  some answer".to_owned(),
        rule24(),
        format!("\u{276f}\u{a0}{prompt}"),
    ];
    lines.extend(after.iter().map(|line| (*line).to_owned()));
    lines.push(rule24());
    lines.push("  -- INSERT -- \u{23f5}\u{23f5} auto mode on".to_owned());
    lines.join("\n")
}

#[test]
fn claudes_dim_suggestion_of_a_next_prompt_is_not_a_draft() {
    // As Herdr reads it with its styles (`format: "ansi"`).
    let suggested = boxed("\x1b[0m\x1b[2mgo ahead with all three\x1b[0m\r", &[]);
    assert_eq!(
        claude_prompt_state(&suggested),
        PromptBoxState {
            r#box: PromptBox::Empty,
            vim: VimMode::Insert
        }
    );
    // The cursor on its first letter, in inverse video.
    assert_eq!(
        claude_prompt_state(&boxed("\x1b[7mg\x1b[0m\x1b[2mo ahead\x1b[0m", &[])).r#box,
        PromptBox::Empty
    );
    assert_eq!(
        claude_prompt_state(&boxed("\x1b[2;38;5;246mTry it\x1b[22m", &[])).r#box,
        PromptBox::Empty
    );
}

#[test]
fn typed_text_is_a_draft_styled_or_not_on_any_line_of_the_box() {
    let state = |prompt: &str, after: &[&str]| claude_prompt_state(&boxed(prompt, after)).r#box;
    assert_eq!(state("half typed\x1b[7m \x1b[27m", &[]), PromptBox::Draft);
    assert_eq!(state("\x1b[1mbold\x1b[0m", &[]), PromptBox::Draft);
    assert_eq!(state("\x1b[2mdim\x1b[22m and typed", &[]), PromptBox::Draft);
    assert_eq!(state("", &["  \x1b[0msecond line"]), PromptBox::Draft);
    // Without styles (an older Herdr), any text is a draft.
    assert_eq!(state("go ahead with all three", &[]), PromptBox::Draft);
    assert_eq!(state("", &[]), PromptBox::Empty);
}

#[test]
fn the_prompt_mark_and_vim_mode_are_read_through_the_styles() {
    let normal = boxed("", &[]).replacen("-- INSERT --", "\x1b[1m-- NORMAL --\x1b[0m", 1);
    assert_eq!(claude_prompt_state(&normal).vim, VimMode::Normal);
    assert_eq!(
        claude_prompt_state("\x1b[1mDo you want to proceed?\x1b[0m").r#box,
        PromptBox::Missing
    );
}

fn rule40() -> String {
    "\u{2500}".repeat(40)
}

#[test]
fn the_footers_running_shells_and_tasks_count_its_agents_do_not() {
    assert_eq!(
        claude_background_work(&background_screen()).as_deref(),
        Some("1 shell")
    );
    let two = [
        "\u{276f} ".to_owned(),
        rule40(),
        "  \x1b[2m-- INSERT --\x1b[0m \u{23f5}\u{23f5} auto mode on \u{b7} 2 shells \u{b7} 1 monitor"
            .to_owned(),
    ]
    .join("\n");
    assert_eq!(
        claude_background_work(&two).as_deref(),
        Some("2 shells, 1 monitor")
    );
    assert_eq!(claude_background_work(&idle_screen()), None);
    let agents = [
        "\u{276f} ".to_owned(),
        rule40(),
        "  auto mode on \u{b7} \u{2190} 18 agents".to_owned(),
    ]
    .join("\n");
    assert_eq!(claude_background_work(&agents), None);
}

#[test]
fn a_narrow_panes_footer_a_cut_count_is_work_its_silence_says_nothing() {
    let footer = |work: Option<&str>, readable: bool| ClaudeFooter {
        work: work.map(str::to_owned),
        readable,
    };
    // "· 1" with its word cut at 38 columns.
    assert_eq!(
        claude_footer(&narrow_screen()),
        footer(Some("1 background task"), true)
    );
    assert_eq!(
        claude_footer(&format!(
            "\u{276f} \n{}\n  auto mode on \u{b7} 2 sh\u{2026}",
            rule40()
        )),
        footer(Some("2 background tasks"), true)
    );
    // At 18 columns nothing is left: not readable, whatever runs.
    assert_eq!(claude_footer(&narrowest_screen()), footer(None, false));
    assert_eq!(claude_footer(&narrow_idle_screen()), footer(None, false));
    // A wide one says so when nothing runs.
    let wide = idle_screen().replace(&rule24(), &"\u{2500}".repeat(80));
    assert_eq!(claude_footer(&wide), footer(None, true));
    assert_eq!(
        claude_footer(&background_screen()),
        footer(Some("1 shell"), true)
    );
}

#[test]
fn the_conversation_above_the_prompt_is_not_the_footer() {
    let screen = [
        "\u{25cf} I started 2 shells".to_owned(),
        "\u{276f} ".to_owned(),
        rule40(),
        "  auto mode on".to_owned(),
    ]
    .join("\n");
    assert_eq!(claude_background_work(&screen), None);
}

#[test]
fn the_exit_question_and_the_key_that_answers_stay() {
    assert_eq!(
        claude_exit_dialog(&exit_dialog_screen()).as_deref(),
        Some("3")
    );
    assert_eq!(claude_exit_dialog(&background_screen()), None);
    assert_eq!(claude_exit_dialog(&idle_screen()), None);
    // No numbers: Escape cancels, as Stay does.
    let unnumbered = regex::Regex::new(r"[0-9]\. ")
        .expect("regex")
        .replace_all(&exit_dialog_screen(), "")
        .into_owned();
    assert_eq!(claude_exit_dialog(&unnumbered).as_deref(), Some("\x1b"));
}

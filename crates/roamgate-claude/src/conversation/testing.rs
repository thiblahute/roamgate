//! Claude's TUI screens as the conversation tests draw them
//! (`conversation/testing.ts`), for the drivers' tests and the
//! conversation service's.

fn rule(width: usize) -> String {
    "\u{2500}".repeat(width)
}

/// An idle TUI: its prompt box empty, in vim insert mode.
pub fn idle_screen() -> String {
    [
        "  some answer".to_owned(),
        rule(24),
        "\u{276f} ".to_owned(),
        rule(24),
        "  -- INSERT -- \u{23f5}\u{23f5} auto mode on".to_owned(),
    ]
    .join("\n")
}

/// Idle, with a shell running in the background.
pub fn background_screen() -> String {
    [
        "\u{273b} Worked for 2m 54s \u{b7} 1 shell still running".to_owned(),
        rule(24),
        "\u{276f} ".to_owned(),
        rule(24),
        "  -- INSERT -- \u{23f5}\u{23f5} auto mode on \u{b7} 1 shell \u{b7} \u{2190} 18 agents"
            .to_owned(),
    ]
    .join("\n")
}

/// A pane 38 columns wide: the footer's "1 shell" is cut to "1".
pub fn narrow_screen() -> String {
    [
        "\u{273b} Cooked for 4s \u{b7} done 12:48 PM \u{b7} 1".to_owned(),
        "  shell still running".to_owned(),
        String::new(),
        rule(38),
        "\u{276f}".to_owned(),
        rule(38),
        "  -- INSERT -- \u{23f5}\u{23f5} auto mode on \u{b7} 1".to_owned(),
    ]
    .join("\n")
}

/// 18 columns: nothing of the footer is left.
pub fn narrowest_screen() -> String {
    [
        "  done 12:41 PM \u{b7}".to_owned(),
        "  1 shell still".to_owned(),
        "  running".to_owned(),
        String::new(),
        rule(18),
        "\u{276f}".to_owned(),
        rule(18),
        "  -- INSERT -- \u{23f5}".to_owned(),
    ]
    .join("\n")
}

/// 30 columns, nothing running.
pub fn narrow_idle_screen() -> String {
    [
        "\u{23fa} ok".to_owned(),
        rule(30),
        "\u{276f}".to_owned(),
        rule(30),
        "  -- INSERT -- \u{23f5}\u{23f5} auto mode".to_owned(),
    ]
    .join("\n")
}

/// /exit asking what to do with the background work.
pub fn exit_dialog_screen() -> String {
    [
        "\u{276f} /exit",
        "\u{2594}\u{2594}\u{2594}\u{2594}\u{2594}\u{2594}\u{2594}\u{2594}",
        "   Background work is running",
        "   The following will stop when you exit:",
        "",
        "   shell \u{b7} cd /work/repo && ninja",
        "",
        "   \u{276f} 1. Exit and stop tasks",
        "     2. Move to background and exit",
        "     3. Stay",
        "",
        "   Enter to confirm \u{b7} Esc to cancel",
    ]
    .join("\n")
}

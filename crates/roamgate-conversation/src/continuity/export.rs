//! What the incoming agent of a switch is told: the work session's
//! checkpoint and the events its native session has not seen, as one
//! message in a `<roamgate-continuation>` block (the chat shows it as a
//! one-line notice, shared/injectedMessage.ts).

use roamgate_agents::shared::injected::CONTINUATION_TAG;

use crate::continuity::model::{CanonicalEvent, CanonicalEventKind, WorkSession};

/// How much of the history goes in, in characters: past it, the oldest
/// missing events are left out and the agent told where they are.
pub const DEFAULT_BOOTSTRAP_BUDGET_CHARS: usize = 32_000;

#[derive(Clone, Debug)]
pub struct BootstrapOptions {
    pub budget_chars: usize,
    /// A new native session even where the agent's last one could be
    /// resumed.
    pub force_fresh_native_session: bool,
}

impl Default for BootstrapOptions {
    fn default() -> Self {
        Self {
            budget_chars: DEFAULT_BOOTSTRAP_BUDGET_CHARS,
            force_fresh_native_session: false,
        }
    }
}

/// The incoming agent's first message, and where it starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootstrapPackage {
    pub prompt_text: String,
    /// The images of the events it carries, sent with it.
    pub images: Vec<String>,
    /// The events it carries: `from_seq..=through_seq` (`from_seq` past
    /// `through_seq` when there are none).
    pub from_seq: u64,
    pub through_seq: u64,
    /// The agent's earlier native session it resumes, if any.
    pub reused_execution_id: Option<String>,
    pub reused_native_session_id: Option<String>,
    /// Older events were left out for the budget.
    pub compacted: bool,
}

/// The name an actor goes by in the history.
pub fn agent_label(agent: &str) -> &str {
    match agent {
        "claude" => "Claude",
        "agy" => "AGY",
        "user" => "User",
        "roamgate" => "Roamgate",
        other => other,
    }
}

fn format_event(event: &CanonicalEvent) -> String {
    let seq = event.seq;
    let who = agent_label(&event.actor);
    match &event.kind {
        CanonicalEventKind::UserMessage { text, images } if images.is_empty() => {
            format!("[#{seq}] {who}: {text}")
        }
        CanonicalEventKind::UserMessage { text, images } => format!(
            "[#{seq}] {who}: {text} (attachments: {})",
            images.join(", ")
        ),
        CanonicalEventKind::AssistantMessage {
            text,
            model: Some(model),
        } if !model.is_empty() => format!("[#{seq}] {who} ({model}): {text}"),
        CanonicalEventKind::AssistantMessage { text, .. } => format!("[#{seq}] {who}: {text}"),
        CanonicalEventKind::ToolRecord {
            tool_call_id,
            name,
            input_summary,
            output_summary,
            is_error,
        } => format!(
            "[#{seq}] {who} ran {name} (id={tool_call_id}, {}; already done, not to run again)\n  input: {input_summary}\n  result: {output_summary}",
            if *is_error { "failed" } else { "ok" }
        ),
        CanonicalEventKind::BackendSwitch {
            from_agent,
            to_agent,
            reason,
            ..
        } => format!(
            "[#{seq}] Switched from {} to {} ({reason})",
            agent_label(from_agent),
            agent_label(to_agent)
        ),
        CanonicalEventKind::UncertainAction {
            tool_call_id,
            name,
            summary,
        } => format!(
            "[#{seq}] Cut off by the switch, outcome unknown: {name} (id={}): {summary}; check the actual state before acting",
            tool_call_id.as_deref().unwrap_or("unknown")
        ),
    }
}

/// The message that switches `session` to `target_agent`. The agent's
/// last native session that can be resumed (unless a new one is asked
/// for) gets the events since it last ran; a new one gets them all.
pub fn export_bootstrap(
    session: &WorkSession,
    target_agent: &str,
    options: &BootstrapOptions,
) -> BootstrapPackage {
    let latest_seq = session.latest_seq();
    let reused = (!options.force_fresh_native_session)
        .then(|| session.latest_resyncable_execution(target_agent))
        .flatten();
    let from_seq = reused.map_or(1, |exec| exec.delivered_through_seq + 1);
    let missing: Vec<&CanonicalEvent> = session
        .events
        .iter()
        .filter(|e| e.seq >= from_seq)
        .collect();

    let mut out = String::new();
    out.push_str(&format!(
        "This conversation continues here from {}; Roamgate kept its history. Continue the work without repeating what is done: the tool calls below already ran and are history, not commands. Check the current files before editing.\n\n",
        agent_label(&session.active_agent),
    ));
    out.push_str(&format!("Workspace: {}\n", session.cwd));
    if let Some(goal) = session.goal() {
        out.push_str(&format!("First request: {}\n", truncate(goal, 400)));
    }
    let jobs = &session.checkpoint.running_jobs;
    if !jobs.is_empty() {
        out.push_str("\nJobs Roamgate runs outside the agent (read their results, do not start them again):\n");
        for job in jobs {
            out.push_str(&format!("- {} ({}): {}", job.label, job.kind, job.status));
            if let Some(code) = job.exit_code {
                out.push_str(&format!(", exit {code}"));
            }
            if let Some(tail) = job.output_tail.as_deref().filter(|t| !t.is_empty()) {
                out.push_str(&format!(", output ends: {}", tail.replace('\n', " ")));
            }
            out.push('\n');
        }
    }
    let uncertain: Vec<&str> = session.uncertain_actions().collect();
    if !uncertain.is_empty() {
        out.push_str("\nCut off by a switch, outcome unknown (check before doing them again):\n");
        for action in uncertain {
            out.push_str(&format!("- {action}\n"));
        }
    }

    let formatted: Vec<(u64, String, &[String])> = missing
        .iter()
        .map(|event| {
            let images: &[String] = match &event.kind {
                CanonicalEventKind::UserMessage { images, .. } => images,
                _ => &[],
            };
            (event.seq, format_event(event), images)
        })
        .collect();
    let mut kept = 0usize;
    let mut used = 0usize;
    for (_, line, _) in formatted.iter().rev() {
        let cost = line.len() + 1;
        if kept > 0 && used + cost > options.budget_chars {
            break;
        }
        used += cost;
        kept += 1;
    }
    let compacted = kept < formatted.len();
    let mut images = Vec::new();
    if !formatted.is_empty() {
        out.push_str(if reused.is_some() {
            "\nWhat happened since you last had this conversation:\n"
        } else {
            "\nThe conversation so far:\n"
        });
        let first_kept = formatted[formatted.len() - kept].0;
        if compacted {
            let sessions: Vec<String> = session
                .executions
                .iter()
                .filter(|exec| !exec.native_session_id.is_empty())
                .map(|exec| format!("{} {}", agent_label(&exec.agent), exec.native_session_id))
                .collect();
            out.push_str(&format!(
                "(Events #{from_seq} to #{} are left out for length; the native sessions hold them: {}.)\n",
                first_kept - 1,
                sessions.join(", ")
            ));
        }
        for (_, line, event_images) in &formatted[formatted.len() - kept..] {
            out.push_str(line);
            out.push('\n');
            for image in *event_images {
                if !images.contains(image) {
                    images.push(image.clone());
                }
            }
        }
    }
    // The history's own text never closes the block.
    let out = out
        .replace(
            &format!("<{CONTINUATION_TAG}"),
            &format!("&lt;{CONTINUATION_TAG}"),
        )
        .replace(
            &format!("</{CONTINUATION_TAG}"),
            &format!("&lt;/{CONTINUATION_TAG}"),
        );
    let from = &session.active_agent;
    let prompt_text = format!(
        "<{CONTINUATION_TAG} from=\"{from}\" from-name=\"{}\">\n{}</{CONTINUATION_TAG}>",
        agent_label(from),
        out
    );

    BootstrapPackage {
        prompt_text,
        images,
        from_seq: if formatted.is_empty() {
            latest_seq + 1
        } else {
            from_seq
        },
        through_seq: latest_seq,
        reused_execution_id: reused.map(|e| e.id.clone()),
        reused_native_session_id: reused.map(|e| e.native_session_id.clone()),
        compacted,
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity::store::WorkSessionStore;
    use crate::time::VirtualClock;

    fn say(store: &WorkSessionStore, id: &str, actor: &str, text: &str) -> u64 {
        let kind = if actor == "user" {
            CanonicalEventKind::UserMessage {
                text: text.into(),
                images: vec![],
            }
        } else {
            CanonicalEventKind::AssistantMessage {
                text: text.into(),
                model: None,
            }
        };
        store.record_event(id, actor, kind, None).unwrap()
    }

    /// Switches to `to`, its native session `native` when new; the
    /// bootstrap it got.
    fn switch(store: &WorkSessionStore, id: &str, to: &str, native: &str) -> BootstrapPackage {
        let generation = store.begin_quiescing(id, to, "manual").unwrap();
        let snapshot = store
            .mark_checkpointed(id, generation, true, vec![])
            .unwrap();
        let package = export_bootstrap(&snapshot, to, &BootstrapOptions::default());
        store
            .begin_starting_replacement(
                id,
                generation,
                package
                    .reused_native_session_id
                    .as_deref()
                    .unwrap_or(native),
                package.reused_execution_id.as_deref(),
            )
            .unwrap();
        store.finish_switch(id, generation).unwrap();
        package
    }

    #[test]
    fn each_return_gets_exactly_the_events_it_missed() {
        let clock = VirtualClock::new();
        let store = WorkSessionStore::new("local", None, None, clock.shared());
        let id = store.create("w1:p1", "agy", "agy-1", "/repo");
        say(&store, &id, "user", "Use tabs");
        say(&store, &id, "agy", "OK, tabs");

        let to_claude = switch(&store, &id, "claude", "claude-1");
        assert_eq!((to_claude.from_seq, to_claude.through_seq), (1, 2));
        assert!(to_claude.reused_execution_id.is_none());
        assert!(to_claude.prompt_text.starts_with(
            "<roamgate-continuation from=\"agy\" from-name=\"AGY\">\nThis conversation continues here from AGY"
        ));
        assert!(to_claude.prompt_text.contains("[#1] User: Use tabs"));
        assert!(to_claude.prompt_text.ends_with("</roamgate-continuation>"));

        // #3 is the switch.
        say(&store, &id, "user", "Actually, spaces");
        say(&store, &id, "claude", "Switched to spaces");

        let to_agy = switch(&store, &id, "agy", "unused");
        assert_eq!(to_agy.reused_native_session_id.as_deref(), Some("agy-1"));
        assert_eq!((to_agy.from_seq, to_agy.through_seq), (3, 5));
        assert!(!to_agy.prompt_text.contains("[#1] User: Use tabs"));
        assert!(to_agy.prompt_text.contains("First request: Use tabs"));
        assert!(to_agy.prompt_text.contains("[#4] User: Actually, spaces"));

        say(&store, &id, "user", "Add a test");
        let to_claude_again = switch(&store, &id, "claude", "unused");
        assert_eq!(
            to_claude_again.reused_native_session_id.as_deref(),
            Some("claude-1")
        );
        assert_eq!(
            (to_claude_again.from_seq, to_claude_again.through_seq),
            (6, 7)
        );
        assert!(
            to_claude_again
                .prompt_text
                .contains("[#7] User: Add a test")
        );
        assert!(!to_claude_again.prompt_text.contains("Actually, spaces"));
    }

    #[test]
    fn over_budget_keeps_the_latest_events_and_names_the_native_sessions() {
        let clock = VirtualClock::new();
        let store = WorkSessionStore::new("local", None, None, clock.shared());
        let id = store.create("w1:p1", "claude", "claude-1", "/repo");
        for n in 0..50 {
            say(
                &store,
                &id,
                "user",
                &format!("message {n} {}", "x".repeat(80)),
            );
        }
        let generation = store.begin_quiescing(&id, "agy", "manual").unwrap();
        let snapshot = store
            .mark_checkpointed(&id, generation, true, vec![])
            .unwrap();
        let package = export_bootstrap(
            &snapshot,
            "agy",
            &BootstrapOptions {
                budget_chars: 1000,
                force_fresh_native_session: false,
            },
        );
        assert!(package.compacted);
        assert!(package.prompt_text.contains("message 49"));
        assert!(!package.prompt_text.contains("[#1] User"));
        assert!(package.prompt_text.contains("Claude claude-1"));
    }
}

//! Idle stop (`idle-stop.ts`): a conversation-mode session that sat idle
//! long enough gets its headless process stopped (its holder keeps the
//! pane), and the next message of any kind starts it again. These are the
//! rules of when; the service checks every session against them once a
//! minute.

/// No idle stop this long after another session's message reached it.
pub const PEER_QUIET_MS: i64 = 10 * 60_000;

#[derive(Clone, Debug, PartialEq)]
pub struct IdleStopFacts {
    /// The setting, in ms; 0: off.
    pub limit_ms: i64,
    pub now: i64,
    /// When the process last said something, or a turn was written.
    pub idle_since: i64,
    /// When another session's message last reached it; None: never.
    pub last_peer_at: Option<i64>,
    pub peer_quiet_ms: Option<i64>,
    /// The conversation owns the session (not a handover).
    pub conversation: bool,
    /// A process runs (or starts).
    pub alive: bool,
    /// The session's status (`AgentChatStatus`).
    pub status: String,
    /// A turn runs, a prompt waits, or a message is on its way.
    pub busy: bool,
    pub queued: usize,
    pub background_tasks: usize,
    /// A `!` line from the chat runs.
    pub shell_running: bool,
    /// The API key question waits for the user.
    pub api_key_question: bool,
    /// Why it must stay up meanwhile (a voice call, a companion job).
    pub kept_awake: Option<String>,
}

/// Why the session is not stopped now; None: stop it.
pub fn idle_stop_refusal(facts: &IdleStopFacts) -> Option<String> {
    let why = |text: &str| Some(text.to_owned());
    if facts.limit_ms <= 0 {
        return why("idle stop is off");
    }
    if !facts.conversation {
        return why("not in conversation mode");
    }
    if !facts.alive {
        return why("no process runs");
    }
    if facts.status == "blocked" {
        return why("it asks the user something");
    }
    if facts.api_key_question {
        return why("the API key question waits");
    }
    if facts.busy || facts.status != "idle" {
        return why("it works");
    }
    if facts.queued > 0 {
        return why("messages wait in its queue");
    }
    if facts.background_tasks > 0 {
        return why("background work runs");
    }
    if facts.shell_running {
        return why("a shell line runs");
    }
    if let Some(awake) = &facts.kept_awake {
        return Some(awake.clone());
    }
    if let Some(peer) = facts.last_peer_at
        && facts.now - peer < facts.peer_quiet_ms.unwrap_or(PEER_QUIET_MS)
    {
        return why("another session messaged it lately");
    }
    if facts.now - facts.idle_since < facts.limit_ms {
        return why("not idle long enough");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rules_what_keeps_a_session_s_process_up() {
        let idle = IdleStopFacts {
            limit_ms: 30 * 60_000,
            now: 31 * 60_000,
            idle_since: 0,
            last_peer_at: None,
            peer_quiet_ms: None,
            conversation: true,
            alive: true,
            status: "idle".into(),
            busy: false,
            queued: 0,
            background_tasks: 0,
            shell_running: false,
            api_key_question: false,
            kept_awake: None,
        };
        assert_eq!(idle_stop_refusal(&idle), None);
        let cases: Vec<(IdleStopFacts, &str)> = vec![
            (
                IdleStopFacts {
                    limit_ms: 0,
                    ..idle.clone()
                },
                "idle stop is off",
            ),
            (
                IdleStopFacts {
                    conversation: false,
                    ..idle.clone()
                },
                "not in conversation mode",
            ),
            (
                IdleStopFacts {
                    alive: false,
                    ..idle.clone()
                },
                "no process runs",
            ),
            (
                IdleStopFacts {
                    status: "blocked".into(),
                    ..idle.clone()
                },
                "it asks the user something",
            ),
            (
                IdleStopFacts {
                    api_key_question: true,
                    ..idle.clone()
                },
                "the API key question waits",
            ),
            (
                IdleStopFacts {
                    busy: true,
                    ..idle.clone()
                },
                "it works",
            ),
            (
                IdleStopFacts {
                    status: "working".into(),
                    ..idle.clone()
                },
                "it works",
            ),
            (
                IdleStopFacts {
                    queued: 1,
                    ..idle.clone()
                },
                "messages wait in its queue",
            ),
            (
                IdleStopFacts {
                    background_tasks: 2,
                    ..idle.clone()
                },
                "background work runs",
            ),
            (
                IdleStopFacts {
                    shell_running: true,
                    ..idle.clone()
                },
                "a shell line runs",
            ),
            (
                IdleStopFacts {
                    kept_awake: Some("a voice call is open".into()),
                    ..idle.clone()
                },
                "a voice call is open",
            ),
            (
                IdleStopFacts {
                    last_peer_at: Some(25 * 60_000),
                    ..idle.clone()
                },
                "another session messaged it lately",
            ),
            (
                IdleStopFacts {
                    idle_since: 2 * 60_000,
                    ..idle.clone()
                },
                "not idle long enough",
            ),
        ];
        for (facts, why) in cases {
            assert_eq!(idle_stop_refusal(&facts).as_deref(), Some(why));
        }
        // A peer's message 10 minutes old no longer counts.
        assert_eq!(
            idle_stop_refusal(&IdleStopFacts {
                last_peer_at: Some(21 * 60_000),
                ..idle
            }),
            None
        );
    }
}

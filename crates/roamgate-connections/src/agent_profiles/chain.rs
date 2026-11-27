//! The account chain over the profiles settings: its members as the walk
//! sees them (roamgate_accounts::chain), and the profile a session of
//! another agent starts with.

use std::collections::HashMap;
use std::path::Path;

use roamgate_accounts::chain::{
    Chain, Crossing, Lines, Member, Move, WalkOrder, crossing, default_move, limit_move, walk,
    weekday,
};
use roamgate_accounts::{AuthState, UsagePoller};
use serde_json::Value;

use super::shared::{profile_account_id, profile_agent, profile_name, profile_named};
use super::store::{
    AgentCommand, SessionProfiles, account_dir_of, command_for_session, profile_command,
    profile_for_session, profiles_list, profiles_of,
};

/// The chain of a `profiles` section: its account profiles in order, their
/// own lines, and whether it switches on its own.
pub struct ChainSettings {
    pub chain: Chain,
    pub accounts: Vec<Value>,
    pub lines: HashMap<String, Lines>,
    pub auto_switch: bool,
}

impl ChainSettings {
    /// The chain's account profile so named.
    pub fn account(&self, name: &str) -> Option<&Value> {
        self.accounts
            .iter()
            .find(|profile| profile_name(profile).eq_ignore_ascii_case(name))
    }
}

/// The chain of the settings, when it names accounts.
pub fn chain_settings(settings: Option<&Value>) -> Option<ChainSettings> {
    let profiles = profiles_of(settings);
    let raw = profiles.get("chain")?;
    let list = profiles_list(&profiles);
    let accounts: Vec<Value> = raw
        .get("accounts")?
        .as_array()?
        .iter()
        .filter_map(|name| profile_named(&list, name.as_str()))
        .filter(|profile| profile_account_id(profile).is_some())
        .collect();
    if accounts.is_empty() {
        return None;
    }
    let number = |key: &str, default: f64| raw.get(key).and_then(Value::as_f64).unwrap_or(default);
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
    let defaults = Lines {
        five_hour: number("five_hour_line", 95.0),
        weekly: number("weekly_line", 98.0),
    };
    let lines = raw
        .get("lines")
        .and_then(Value::as_object)
        .map(|lines| {
            lines
                .iter()
                .map(|(name, own)| {
                    let line = |key: &str, default: f64| {
                        own.get(key).and_then(Value::as_f64).unwrap_or(default)
                    };
                    (
                        name.clone(),
                        Lines {
                            five_hour: line("five_hour", defaults.five_hour),
                            weekly: line("weekly", defaults.weekly),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let chain = Chain {
        lines: defaults,
        walk: text("walk")
            .as_deref()
            .and_then(WalkOrder::from_id)
            .unwrap_or_default(),
        preferred: text("preferred"),
        preferred_days: raw
            .get("preferred_days")
            .and_then(Value::as_array)
            .map(|days| {
                days.iter()
                    .filter_map(Value::as_u64)
                    .map(|day| day as u8)
                    .collect()
            })
            .unwrap_or_default(),
        last_resort: text("last_resort"),
    };
    Some(ChainSettings {
        chain,
        accounts,
        lines,
        auto_switch: raw.get("auto_switch") == Some(&Value::Bool(true)),
    })
}

/// The chain's members, with their sign-in, last reading and history.
pub fn members(settings: &ChainSettings, home: &Path, usage: &UsagePoller) -> Vec<Member> {
    let board = usage.snapshot();
    settings
        .accounts
        .iter()
        .filter_map(|profile| {
            let (agent, dir) = account_dir_of(profile, home)?;
            let id = profile_account_id(profile)?;
            let key = format!("{}/{id}", agent.id());
            let windows = board
                .iter()
                .find(|reading| reading.key() == key)
                .and_then(|reading| reading.usage.as_ref())
                .map(|usage| usage.windows.clone())
                .unwrap_or_default();
            let signed_in = !matches!(
                roamgate_accounts::auth_state(agent, &dir),
                AuthState::SignedOut | AuthState::NeedsRelogin
            );
            let name = profile_name(profile).to_owned();
            Some(Member {
                lines: settings.lines.get(&name).copied(),
                name,
                agent: profile_agent(profile).to_owned(),
                signed_in,
                windows,
                history: usage.history(&key),
            })
        })
        .collect()
}

/// Today's weekday (0 Sunday) in this machine's time zone.
pub fn today(now_ms: i64) -> u8 {
    let offset = jiff::tz::TimeZone::system()
        .to_offset(jiff::Timestamp::from_millisecond(now_ms).unwrap_or_default())
        .seconds() as i64
        * 1000;
    weekday(now_ms, offset)
}

/// The command a session starts with for `agent`: its own profile when it
/// is that agent's, else the chain's first account of that agent with
/// headroom, else its own (which the caller then leaves aside).
pub fn command_for_agent(
    session_id: &str,
    agent: &str,
    settings: Option<&Value>,
    store: Option<&SessionProfiles>,
    home: &Path,
    usage: Option<&UsagePoller>,
    now_ms: i64,
) -> Result<AgentCommand, String> {
    let profile = profile_for_session(settings, Some(session_id), store);
    if profile_agent(&profile) != agent
        && let Some(usage) = usage
        && let Some(chain) = chain_settings(settings)
    {
        let members = members(&chain, home, usage);
        let first = walk(
            &chain.chain,
            &members,
            None,
            Some(agent),
            now_ms,
            today(now_ms),
        )
        .first()
        .map(|member| member.name.clone());
        if let Some(account) = first.as_deref().and_then(|name| chain.account(name)) {
            return profile_command(account, home);
        }
    }
    command_for_session(Some(session_id), settings, store, home)
}

/// A session running now, as the chain sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSession {
    pub connection_id: String,
    pub pane_id: String,
    pub session_id: String,
    /// Conversation mode runs it (else a terminal).
    pub conversation: bool,
    /// Its profile now.
    pub profile: String,
    pub pinned: bool,
}

/// A session the chain moves, and why.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionMove {
    pub session: LiveSession,
    pub to: String,
    pub to_agent: String,
    /// The account it leaves is another agent's.
    pub cross_agent: bool,
    pub crossing: Option<Crossing>,
}

fn agent_of<'m>(members: &'m [Member], name: &str) -> Option<&'m str> {
    members
        .iter()
        .find(|member| member.name == name)
        .map(|member| member.agent.as_str())
}

/// What the chain does now: where the global default goes, and which live
/// sessions move. An unpinned session leaves an account past its lines
/// (with the default when it moves); a pinned one only past the hard cap.
pub fn proactive(
    settings: &ChainSettings,
    members: &[Member],
    default: &str,
    sessions: &[LiveSession],
    now_ms: i64,
    today: u8,
) -> (Option<Move>, Vec<SessionMove>) {
    let chain = &settings.chain;
    let default_moved = members
        .iter()
        .any(|member| member.name == default)
        .then(|| default_move(chain, members, default, now_ms, today))
        .flatten();
    let mut moves = Vec::new();
    for session in sessions {
        let Some(member) = members.iter().find(|member| member.name == session.profile) else {
            continue;
        };
        let crossed = crossing(member, chain, now_ms, session.pinned);
        let to = match (&default_moved, &crossed) {
            // The default leaves for its preferred account: unpinned
            // sessions on it follow.
            (Some(moved), _) if !session.pinned && moved.from == session.profile => {
                Some(moved.to.clone())
            }
            (_, Some(_)) => walk(chain, members, Some(&member.name), None, now_ms, today)
                .first()
                .map(|next| next.name.clone()),
            _ => None,
        };
        let Some(to) = to.filter(|to| *to != session.profile) else {
            continue;
        };
        let to_agent = agent_of(members, &to).unwrap_or("claude").to_owned();
        moves.push(SessionMove {
            cross_agent: to_agent != member.agent,
            to_agent,
            to,
            crossing: crossed.or_else(|| {
                default_moved
                    .as_ref()
                    .and_then(|moved| moved.crossing.clone())
            }),
            session: session.clone(),
        });
    }
    (default_moved, moves)
}

/// Where a session stopped by a usage limit goes: the chain's next account
/// (the limited one left out, pinned or not: a limit is the hard cap).
pub fn reactive(
    settings: &ChainSettings,
    members: &[Member],
    session: &LiveSession,
    now_ms: i64,
    today: u8,
) -> Option<SessionMove> {
    let member = members
        .iter()
        .find(|member| member.name == session.profile)?;
    let next = limit_move(&settings.chain, members, &session.profile, now_ms, today)?;
    Some(SessionMove {
        session: session.clone(),
        to: next.name.clone(),
        to_agent: next.agent.clone(),
        cross_agent: next.agent != member.agent,
        crossing: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_accounts::{Endpoints, UsagePoller};
    use serde_json::json;

    use crate::agent_profiles::shared::normalize_profiles_settings;

    fn settings() -> Value {
        json!({"profiles": normalize_profiles_settings(Some(&json!({
            "list": [
                {"name": "Work", "agent": "claude", "account": {"id": "work"}},
                {"name": "Agy", "agent": "agy", "account": {"id": "a"}},
                {"name": "Agy 2", "agent": "agy", "account": {"id": "b"}},
            ],
            "default": "Work",
            "chain": {"accounts": ["Work", "Agy 2", "Agy"], "auto_switch": true,
                      "lines": {"Work": {"five_hour": 80}}},
        })))})
    }

    #[test]
    fn the_chain_reads_its_accounts_and_lines() {
        let chain = chain_settings(Some(&settings())).unwrap();
        assert!(chain.auto_switch);
        let names: Vec<_> = chain.accounts.iter().map(profile_name).collect();
        assert_eq!(names, ["Work", "Agy 2", "Agy"]);
        assert_eq!(chain.lines["Work"].five_hour, 80.0);
        assert_eq!(chain.lines["Work"].weekly, 98.0);
        assert!(chain_settings(Some(&json!({"profiles": {"list": []}}))).is_none());
    }

    #[test]
    fn a_session_of_another_agent_starts_on_the_chain_s_account_of_that_agent() {
        if std::env::var_os("ROAMGATE_DATA_ROOT").is_some() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let usage = UsagePoller::new(home, Endpoints::default(), "agy");
        let settings = settings();
        let command =
            command_for_agent("s", "agy", Some(&settings), None, home, Some(&usage), 0).unwrap();
        assert_eq!(command.profile, "Agy 2");
        assert_eq!(command.agent, "agy");
        let command =
            command_for_agent("s", "claude", Some(&settings), None, home, Some(&usage), 0).unwrap();
        assert_eq!(command.profile, "Work");
    }

    fn window(label: &str, utilization: f64) -> roamgate_accounts::UsageWindow {
        roamgate_accounts::UsageWindow {
            label: label.into(),
            utilization,
            resets_at: Some(roamgate_base::log::iso_millis(3_600_000)),
        }
    }

    fn member(name: &str, agent: &str, five: f64) -> Member {
        Member {
            name: name.into(),
            agent: agent.into(),
            signed_in: true,
            windows: vec![window("5h", five)],
            ..Member::default()
        }
    }

    fn session(pane: &str, profile: &str, pinned: bool) -> LiveSession {
        LiveSession {
            connection_id: "c".into(),
            pane_id: pane.into(),
            session_id: format!("s-{pane}"),
            conversation: true,
            profile: profile.into(),
            pinned,
        }
    }

    #[test]
    fn crossing_a_line_moves_the_default_and_unpinned_sessions_only() {
        let chain = chain_settings(Some(&settings())).unwrap();
        let mut members = vec![
            member("Work", "claude", 85.0),
            member("Agy 2", "agy", 10.0),
            member("Agy", "agy", 10.0),
        ];
        members[0].lines = chain.lines.get("Work").copied();
        let sessions = vec![
            session("p1", "Work", false),
            session("p2", "Work", true),
            session("p3", "Agy", false),
        ];
        // Work's own line is 80.
        let (moved, moves) = proactive(&chain, &members, "Work", &sessions, 0, 0);
        let moved = moved.unwrap();
        assert_eq!((moved.from.as_str(), moved.to.as_str()), ("Work", "Agy 2"));
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].session.pane_id, "p1");
        assert_eq!(moves[0].to, "Agy 2");
        assert!(moves[0].cross_agent);
        assert_eq!(moves[0].crossing.as_ref().unwrap().label, "5h");
        // Past the hard cap the pinned session moves too.
        let capped = vec![
            member("Work", "claude", 100.0),
            member("Agy 2", "agy", 10.0),
            member("Agy", "agy", 10.0),
        ];
        let (_, moves) = proactive(&chain, &capped, "Work", &sessions, 0, 0);
        let panes: Vec<_> = moves.iter().map(|m| m.session.pane_id.as_str()).collect();
        assert_eq!(panes, ["p1", "p2"]);
        // Nothing crossed: nothing moves.
        let calm = vec![member("Work", "claude", 10.0), member("Agy 2", "agy", 10.0)];
        let (moved, moves) = proactive(&chain, &calm, "Work", &sessions, 0, 0);
        assert!(moved.is_none() && moves.is_empty());
    }

    #[test]
    fn a_limited_session_goes_to_the_next_account_even_pinned() {
        let chain = chain_settings(Some(&settings())).unwrap();
        let members = vec![
            member("Work", "claude", 10.0),
            member("Agy 2", "agy", 99.0),
            member("Agy", "agy", 10.0),
        ];
        let moved = reactive(&chain, &members, &session("p", "Work", true), 0, 0).unwrap();
        assert_eq!(moved.to, "Agy");
        assert!(moved.cross_agent);
        assert!(reactive(&chain, &members, &session("p", "Other", false), 0, 0).is_none());
    }
}

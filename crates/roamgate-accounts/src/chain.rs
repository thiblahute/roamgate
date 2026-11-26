//! The account chain: when an account has crossed its lines, and which
//! account comes next. Pure functions over the accounts' usage readings.
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy), src/fallback.rs: the 5-hour line (95 %) and
//! the weekly line (98 %) judged on live windows only (a window whose reset
//! has passed has headroom again), the per-model weekly windows judged at
//! the weekly line, the 100 % hard cap, the per-account line overrides,
//! the preferred account and its days, the last resort, the walk orders
//! (the chain's own order, the soonest weekly reset, the most headroom)
//! and the burn-aware projection (an account whose recent burn would
//! cross a line before the next reading counts as crossed). clauth's spend
//! budget is left out (D10).

use crate::usage::{UsageSample, UsageWindow};

/// The default 5-hour line (percent used).
pub const DEFAULT_FIVE_HOUR_LINE: f64 = 95.0;
/// The default weekly line, for the aggregate and per-model weeks.
pub const DEFAULT_WEEKLY_LINE: f64 = 98.0;
/// No account serves past this.
pub const HARD_CAP: f64 = 100.0;
/// How far ahead the burn-aware projection looks (ms): about two readings.
pub const PROJECTION_MS: i64 = 3 * 60_000;

/// The lines an account is judged at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lines {
    pub five_hour: f64,
    pub weekly: f64,
}

impl Default for Lines {
    fn default() -> Self {
        Self {
            five_hour: DEFAULT_FIVE_HOUR_LINE,
            weekly: DEFAULT_WEEKLY_LINE,
        }
    }
}

/// In which order the walk tries the accounts with headroom.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WalkOrder {
    /// The chain's own order.
    #[default]
    Chain,
    /// The account whose weekly window resets first.
    SoonestWeeklyReset,
    /// The account with the most headroom left.
    MostHeadroom,
}

impl WalkOrder {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "chain" => Some(Self::Chain),
            "soonest_reset" => Some(Self::SoonestWeeklyReset),
            "most_headroom" => Some(Self::MostHeadroom),
            _ => None,
        }
    }
}

/// One account of the chain, as the walk sees it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Member {
    /// The profile's name.
    pub name: String,
    /// `claude`, `codex` or `agy`.
    pub agent: String,
    pub signed_in: bool,
    /// Its last reading's windows (none: unknown, judged as headroom).
    pub windows: Vec<UsageWindow>,
    /// Its recent readings, oldest first, for the projection.
    pub history: Vec<UsageSample>,
    /// Its own lines, when it overrides the chain's.
    pub lines: Option<Lines>,
}

/// The chain's settings.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Chain {
    pub lines: Lines,
    pub walk: WalkOrder,
    /// Taken first on its days when it has headroom.
    pub preferred: Option<String>,
    /// The preferred account's days (0 Sunday to 6 Saturday); none: every
    /// day.
    pub preferred_days: Vec<u8>,
    /// Taken only when no other account has headroom (still not past the
    /// hard cap).
    pub last_resort: Option<String>,
}

fn reset_ms(window: &UsageWindow) -> Option<i64> {
    window
        .resets_at
        .as_deref()
        .and_then(roamgate_base::log::parse_iso_millis)
}

/// A window counts while its reset is still ahead (clauth's `window_live`).
pub fn window_live(window: &UsageWindow, now_ms: i64) -> bool {
    reset_ms(window).is_some_and(|reset| now_ms < reset)
}

fn is_five_hour(window: &UsageWindow) -> bool {
    window.label == "5h" || window.label.starts_with("5h ")
}

/// The line a window is judged at.
fn line_for(window: &UsageWindow, lines: Lines) -> f64 {
    if is_five_hour(window) {
        lines.five_hour
    } else {
        lines.weekly
    }
}

/// The burn rate of a window (percent per ms) over the member's recent
/// readings, when they rise.
fn burn_rate(member: &Member, window: &UsageWindow, now_ms: i64) -> Option<f64> {
    let samples: Vec<&UsageSample> = member
        .history
        .iter()
        .filter(|sample| sample.label == window.label && sample.at <= now_ms)
        .collect();
    let (first, last) = (samples.first()?, samples.last()?);
    let span = last.at - first.at;
    if span <= 0 || last.utilization < first.utilization {
        return None;
    }
    Some((last.utilization - first.utilization) / span as f64)
}

/// Why a member is off the walk: the window and its reading.
#[derive(Clone, Debug, PartialEq)]
pub struct Crossing {
    pub label: String,
    pub utilization: f64,
    pub line: f64,
    /// Crossed by the projection, not yet by the reading.
    pub projected: bool,
}

/// The first live window past its line (or projected to cross it within
/// [`PROJECTION_MS`]); None: headroom. `cap` judges every window at the
/// hard cap instead.
pub fn crossing(member: &Member, chain: &Chain, now_ms: i64, cap: bool) -> Option<Crossing> {
    let lines = member.lines.unwrap_or(chain.lines);
    for window in &member.windows {
        if !window_live(window, now_ms) {
            continue;
        }
        let line = if cap {
            HARD_CAP
        } else {
            line_for(window, lines)
        };
        if window.utilization >= line {
            return Some(Crossing {
                label: window.label.clone(),
                utilization: window.utilization,
                line,
                projected: false,
            });
        }
        if !cap
            && let Some(rate) = burn_rate(member, window, now_ms)
            && window.utilization + rate * PROJECTION_MS as f64 >= line
        {
            return Some(Crossing {
                label: window.label.clone(),
                utilization: window.utilization,
                line,
                projected: true,
            });
        }
    }
    None
}

/// The least headroom of a member's live windows (100 when none).
fn headroom(member: &Member, now_ms: i64) -> f64 {
    member
        .windows
        .iter()
        .filter(|window| window_live(window, now_ms))
        .map(|window| 100.0 - window.utilization)
        .fold(100.0, f64::min)
}

/// When a member's weekly window resets (None: unknown, walked last).
fn weekly_reset(member: &Member, now_ms: i64) -> Option<i64> {
    member
        .windows
        .iter()
        .filter(|window| window.label == "7d" || window.label.starts_with("7d "))
        .filter(|window| window_live(window, now_ms))
        .filter_map(reset_ms)
        .min()
}

/// The weekday of `now_ms` (0 Sunday) at UTC offset `offset_ms`.
pub fn weekday(now_ms: i64, offset_ms: i64) -> u8 {
    // 1970-01-01 was a Thursday (4).
    ((((now_ms + offset_ms).div_euclid(86_400_000)) + 4).rem_euclid(7)) as u8
}

fn preferred_today(chain: &Chain, today: u8) -> bool {
    chain.preferred_days.is_empty() || chain.preferred_days.contains(&today)
}

/// The members in walk order, those without headroom left out. `agent`
/// keeps only that agent's members; `except` leaves one out (the account
/// being left).
pub fn walk<'m>(
    chain: &Chain,
    members: &'m [Member],
    except: Option<&str>,
    agent: Option<&str>,
    now_ms: i64,
    today: u8,
) -> Vec<&'m Member> {
    let mut open: Vec<(usize, &Member)> = members
        .iter()
        .enumerate()
        .filter(|(_, member)| {
            member.signed_in
                && Some(member.name.as_str()) != except
                && agent.is_none_or(|agent| member.agent == agent)
                && Some(&member.name) != chain.last_resort.as_ref()
                && crossing(member, chain, now_ms, false).is_none()
        })
        .collect();
    match chain.walk {
        WalkOrder::Chain => {}
        WalkOrder::SoonestWeeklyReset => open.sort_by_key(|(index, member)| {
            (weekly_reset(member, now_ms).unwrap_or(i64::MAX), *index)
        }),
        WalkOrder::MostHeadroom => open.sort_by(|(a_index, a), (b_index, b)| {
            headroom(b, now_ms)
                .total_cmp(&headroom(a, now_ms))
                .then(a_index.cmp(b_index))
        }),
    }
    if let Some(preferred) = &chain.preferred
        && preferred_today(chain, today)
        && let Some(at) = open
            .iter()
            .position(|(_, member)| &member.name == preferred)
    {
        let first = open.remove(at);
        open.insert(0, first);
    }
    let mut walked: Vec<&Member> = open.into_iter().map(|(_, member)| member).collect();
    // The last resort: when nothing else has headroom, still below the cap.
    if walked.is_empty()
        && let Some(last) = &chain.last_resort
        && let Some(member) = members.iter().find(|member| {
            &member.name == last
                && member.signed_in
                && Some(member.name.as_str()) != except
                && agent.is_none_or(|agent| member.agent == agent)
                && crossing(member, chain, now_ms, true).is_none()
        })
    {
        walked.push(member);
    }
    walked
}

/// A move the chain makes, and the reading behind it.
#[derive(Clone, Debug, PartialEq)]
pub struct Move {
    pub from: String,
    pub to: String,
    /// The window that made it move (None: the preferred account's day).
    pub crossing: Option<Crossing>,
}

/// Where the global default goes: away from an account past its lines to
/// the first of the walk, or back to the preferred account on its days.
/// None: it stays.
pub fn default_move(
    chain: &Chain,
    members: &[Member],
    current: &str,
    now_ms: i64,
    today: u8,
) -> Option<Move> {
    let current_member = members.iter().find(|member| member.name == current);
    let crossed = current_member.and_then(|member| crossing(member, chain, now_ms, false));
    if let Some(crossed) = crossed {
        let next = walk(chain, members, Some(current), None, now_ms, today)
            .into_iter()
            .next()?;
        return Some(Move {
            from: current.to_owned(),
            to: next.name.clone(),
            crossing: Some(crossed),
        });
    }
    // Back on the preferred account on its days, once it has headroom.
    let preferred = chain.preferred.as_ref()?;
    if preferred == current || !preferred_today(chain, today) || current_member.is_none() {
        return None;
    }
    let first = walk(chain, members, None, None, now_ms, today)
        .into_iter()
        .next()?;
    (&first.name == preferred).then(|| Move {
        from: current.to_owned(),
        to: preferred.clone(),
        crossing: None,
    })
}

/// Where a session limited on `current` goes: the first of the walk, the
/// limited account left out (its limit is known now, whatever its last
/// reading said).
pub fn limit_move<'m>(
    chain: &Chain,
    members: &'m [Member],
    current: &str,
    now_ms: i64,
    today: u8,
) -> Option<&'m Member> {
    walk(chain, members, Some(current), None, now_ms, today)
        .into_iter()
        .next()
}

/// The log line of a move: from, to, and the reading that caused it.
pub fn move_log(movement: &Move, why: &str) -> String {
    match &movement.crossing {
        Some(crossing) => format!(
            "{why}: {} -> {} ({} at {:.1}% {} line {:.0}%)",
            movement.from,
            movement.to,
            crossing.label,
            crossing.utilization,
            if crossing.projected {
                "projected past its"
            } else {
                "past its"
            },
            crossing.line
        ),
        None => format!(
            "{why}: {} -> {} (the preferred account's day)",
            movement.from, movement.to
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn window(label: &str, utilization: f64, resets_in: i64) -> UsageWindow {
        UsageWindow {
            label: label.into(),
            utilization,
            resets_at: Some(roamgate_base::log::iso_millis(NOW + resets_in)),
        }
    }

    fn member(name: &str, windows: Vec<UsageWindow>) -> Member {
        Member {
            name: name.into(),
            agent: "claude".into(),
            signed_in: true,
            windows,
            ..Member::default()
        }
    }

    fn names(walked: &[&Member]) -> Vec<String> {
        walked.iter().map(|member| member.name.clone()).collect()
    }

    #[test]
    fn the_lines_are_judged_on_live_windows_only() {
        let chain = Chain::default();
        let at = |w| crossing(&member("a", vec![w]), &chain, NOW, false);
        assert!(at(window("5h", 94.9, HOUR)).is_none());
        assert_eq!(at(window("5h", 95.0, HOUR)).unwrap().line, 95.0);
        assert!(at(window("7d", 97.0, HOUR)).is_none());
        assert!(at(window("7d", 98.0, HOUR)).is_some());
        // A per-model week is judged at the weekly line.
        assert!(at(window("7d opus", 98.5, HOUR)).is_some());
        // agy's groups too.
        assert!(at(window("5h gemini models", 96.0, HOUR)).is_some());
        // A window whose reset passed has headroom again.
        assert!(at(window("5h", 100.0, -1)).is_none());
        // No reading: headroom.
        assert!(crossing(&member("a", vec![]), &chain, NOW, false).is_none());
    }

    #[test]
    fn an_account_s_own_lines_win_and_the_cap_is_absolute() {
        let chain = Chain::default();
        let mut low = member("a", vec![window("5h", 80.0, HOUR)]);
        low.lines = Some(Lines {
            five_hour: 75.0,
            weekly: 90.0,
        });
        assert!(crossing(&low, &chain, NOW, false).is_some());
        assert!(crossing(&low, &chain, NOW, true).is_none());
        let full = member("b", vec![window("7d", 100.0, HOUR)]);
        assert_eq!(crossing(&full, &chain, NOW, true).unwrap().line, 100.0);
    }

    #[test]
    fn a_fast_burn_counts_as_crossed_before_the_reading_does() {
        let chain = Chain::default();
        let mut hot = member("a", vec![window("5h", 90.0, HOUR)]);
        hot.history = vec![
            UsageSample {
                at: NOW - 3 * 60_000,
                label: "5h".into(),
                utilization: 84.0,
            },
            UsageSample {
                at: NOW,
                label: "5h".into(),
                utilization: 90.0,
            },
        ];
        let crossed = crossing(&hot, &chain, NOW, false).unwrap();
        assert!(crossed.projected);
        // A slow burn does not.
        hot.history[0].utilization = 89.9;
        assert!(crossing(&hot, &chain, NOW, false).is_none());
    }

    #[test]
    fn the_walk_orders_and_skips() {
        let mut chain = Chain::default();
        let members = vec![
            member("work", vec![window("5h", 96.0, HOUR)]),
            member("perso", vec![window("7d", 50.0, 5 * 24 * HOUR)]),
            member("spare", vec![window("7d", 10.0, 2 * 24 * HOUR)]),
            Member {
                signed_in: false,
                ..member("out", vec![])
            },
        ];
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 0)),
            ["perso", "spare"]
        );
        chain.walk = WalkOrder::SoonestWeeklyReset;
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 0)),
            ["spare", "perso"]
        );
        chain.walk = WalkOrder::MostHeadroom;
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 0)),
            ["spare", "perso"]
        );
        chain.walk = WalkOrder::Chain;
        // The preferred account first on its days only.
        chain.preferred = Some("spare".into());
        chain.preferred_days = vec![0];
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 0)),
            ["spare", "perso"]
        );
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 3)),
            ["perso", "spare"]
        );
        // Only one agent's accounts.
        assert!(walk(&chain, &members, None, Some("codex"), NOW, 0).is_empty());
    }

    #[test]
    fn the_last_resort_comes_only_when_nothing_else_can() {
        let chain = Chain {
            last_resort: Some("spare".into()),
            ..Chain::default()
        };
        let mut members = vec![
            member("work", vec![window("5h", 50.0, HOUR)]),
            member("spare", vec![window("5h", 97.0, HOUR)]),
        ];
        assert_eq!(names(&walk(&chain, &members, None, None, NOW, 0)), ["work"]);
        members[0].windows[0].utilization = 99.0;
        // Past its soft line, below the cap: still taken last.
        assert_eq!(
            names(&walk(&chain, &members, None, None, NOW, 0)),
            ["spare"]
        );
        members[1].windows[0].utilization = 100.0;
        assert!(walk(&chain, &members, None, None, NOW, 0).is_empty());
    }

    #[test]
    fn the_default_moves_on_a_crossing_and_back_on_the_preferred_day() {
        let mut chain = Chain::default();
        let members = vec![
            member("work", vec![window("5h", 95.5, HOUR)]),
            member("perso", vec![window("5h", 10.0, HOUR)]),
        ];
        let moved = default_move(&chain, &members, "work", NOW, 0).unwrap();
        assert_eq!((moved.from.as_str(), moved.to.as_str()), ("work", "perso"));
        assert_eq!(
            move_log(&moved, "default account"),
            "default account: work -> perso (5h at 95.5% past its line 95%)"
        );
        assert!(default_move(&chain, &members, "perso", NOW, 0).is_none());
        chain.preferred = Some("perso".into());
        let back = default_move(&chain, &members, "work", NOW, 0).unwrap();
        assert_eq!(back.to, "perso");
        // Nowhere to go: it stays.
        let spent = vec![member("work", vec![window("5h", 99.0, HOUR)])];
        assert!(default_move(&Chain::default(), &spent, "work", NOW, 0).is_none());
    }

    #[test]
    fn a_limited_session_leaves_its_account_whatever_its_reading() {
        let chain = Chain::default();
        let members = vec![
            member("work", vec![window("5h", 20.0, HOUR)]),
            member("perso", vec![]),
        ];
        assert_eq!(
            limit_move(&chain, &members, "work", NOW, 0).unwrap().name,
            "perso"
        );
        assert!(limit_move(&chain, &members[..1], "work", NOW, 0).is_none());
    }

    #[test]
    fn weekdays_count_from_sunday() {
        // 2026-11-26 is a Thursday.
        let thursday = roamgate_base::log::parse_iso_millis("2026-11-26T12:00:00.000Z").unwrap();
        assert_eq!(weekday(thursday, 0), 4);
        assert_eq!(weekday(thursday, 13 * HOUR), 5);
    }
}

//! Which account each session ran on, and when: `<data>/accounts/
//! sessions.json`. A session's run on an account starts when Roamgate
//! starts (or finds) it there, and stops when it moves to another profile.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files::{read_object, write_private};

/// Runs kept, the oldest dropped first.
const MAX_RUNS: usize = 2000;

/// One run of a session on an account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRun {
    pub session_id: String,
    pub agent: String,
    /// The account's id.
    pub account: String,
    /// The profile it ran under.
    pub profile: String,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Where it ran last seen: connection and pane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<RunPane>,
}

/// A pane a session ran in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunPane {
    pub connection_id: String,
    pub pane_id: String,
}

/// The account a session runs on now: agent, account id, profile.
pub type OnAccount<'a> = Option<(&'a str, &'a str, &'a str)>;

/// The runs file, written by one process at a time (the lock here).
pub struct SessionRuns {
    file: PathBuf,
    lock: Mutex<()>,
}

impl SessionRuns {
    pub fn new(data_root: &Path) -> Self {
        Self {
            file: crate::accounts_root(data_root).join("sessions.json"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Vec<SessionRun> {
        read_object(&self.file)
            .and_then(|doc| doc.get("runs").cloned())
            .and_then(|runs| serde_json::from_value::<Vec<SessionRun>>(runs).ok())
            .unwrap_or_default()
    }

    fn write(&self, runs: &[SessionRun]) -> io::Result<()> {
        if let Some(parent) = self.file.parent() {
            roamgate_base::private::create_private_dir(parent)?;
        }
        let mut doc = serde_json::Map::new();
        doc.insert("version".into(), Value::from(1));
        doc.insert(
            "runs".into(),
            serde_json::to_value(runs).map_err(io::Error::other)?,
        );
        write_private(&self.file, &doc)
    }

    /// The session runs on `on` (None: on no account) from `now_ms`. Its
    /// open run on another account stops; the same account changes
    /// nothing. True when it wrote.
    pub fn record(&self, session_id: &str, on: OnAccount<'_>, now_ms: i64) -> io::Result<bool> {
        self.record_in(session_id, on, None, now_ms)
    }

    /// [`Self::record`], with the pane it runs in when known (kept on its
    /// open run).
    pub fn record_in(
        &self,
        session_id: &str,
        on: OnAccount<'_>,
        pane: Option<RunPane>,
        now_ms: i64,
    ) -> io::Result<bool> {
        if session_id.is_empty() {
            return Ok(false);
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut runs = self.read();
        let open = runs
            .iter()
            .rposition(|run| run.session_id == session_id && run.ended_at.is_none());
        if let (Some(index), Some((agent, account, _))) = (open, on)
            && runs[index].agent == agent
            && runs[index].account == account
        {
            if pane.is_none() || runs[index].pane == pane {
                return Ok(false);
            }
            runs[index].pane = pane;
            self.write(&runs)?;
            return Ok(true);
        }
        if open.is_none() && on.is_none() {
            return Ok(false);
        }
        if let Some(index) = open {
            runs[index].ended_at = Some(now_ms);
        }
        if let Some((agent, account, profile)) = on {
            runs.push(SessionRun {
                session_id: session_id.to_owned(),
                agent: agent.to_owned(),
                account: account.to_owned(),
                profile: profile.to_owned(),
                started_at: now_ms,
                ended_at: None,
                pane,
            });
        }
        let excess = runs.len().saturating_sub(MAX_RUNS);
        runs.drain(..excess);
        self.write(&runs)?;
        Ok(true)
    }

    /// The runs on an account that overlap `[from, to]`.
    pub fn on_account(&self, agent: &str, account: &str, from: i64, to: i64) -> Vec<SessionRun> {
        self.read()
            .into_iter()
            .filter(|run| {
                run.agent == agent
                    && run.account == account
                    && run.started_at <= to
                    && run.ended_at.is_none_or(|ended| ended >= from)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_s_runs_follow_its_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let runs = SessionRuns::new(temp.path());
        assert!(
            runs.record("s1", Some(("claude", "work", "Work")), 10)
                .unwrap()
        );
        assert!(
            !runs
                .record("s1", Some(("claude", "work", "Work")), 20)
                .unwrap()
        );
        assert!(
            runs.record("s1", Some(("claude", "perso", "Perso")), 30)
                .unwrap()
        );
        assert!(runs.record("s1", None, 40).unwrap());
        assert!(!runs.record("s1", None, 50).unwrap());
        assert!(
            runs.record("s2", Some(("claude", "work", "Work")), 60)
                .unwrap()
        );
        let work = runs.on_account("claude", "work", 0, 100);
        assert_eq!(work.len(), 2);
        assert_eq!(work[0].ended_at, Some(30));
        assert_eq!(work[1].session_id, "s2");
        assert_eq!(work[1].ended_at, None);
        assert_eq!(runs.on_account("claude", "work", 31, 59).len(), 0);
        let perso = runs.on_account("claude", "perso", 0, 100);
        assert_eq!((perso[0].started_at, perso[0].ended_at), (30, Some(40)));
    }
}

/// One move of the account chain (`<data>/accounts/switches.jsonl`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SwitchEntry {
    pub at: i64,
    /// `default` (the global default moved) or `session`.
    pub kind: String,
    pub from: String,
    pub to: String,
    /// `account_line`, `usage_limit`, `preferred_day`...
    pub why: String,
    /// The reading behind it (`5h at 96.0% (line 95%)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Entries kept, the oldest dropped first.
const MAX_SWITCHES: usize = 500;

/// The chain's switch log.
pub struct SwitchLog {
    file: PathBuf,
    lock: Mutex<()>,
}

impl SwitchLog {
    pub fn new(data_root: &Path) -> Self {
        Self {
            file: crate::accounts_root(data_root).join("switches.jsonl"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Vec<SwitchEntry> {
        std::fs::read_to_string(&self.file)
            .map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn append(&self, entry: &SwitchEntry) -> io::Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.read();
        entries.push(entry.clone());
        let excess = entries.len().saturating_sub(MAX_SWITCHES);
        entries.drain(..excess);
        if let Some(parent) = self.file.parent() {
            roamgate_base::private::create_private_dir(parent)?;
        }
        let mut text = String::new();
        for entry in &entries {
            text.push_str(&serde_json::to_string(entry).map_err(io::Error::other)?);
            text.push('\n');
        }
        crate::files::write_private_bytes(&self.file, text.as_bytes())
    }

    /// The last `limit` entries, newest first.
    pub fn recent(&self, limit: usize) -> Vec<SwitchEntry> {
        let mut entries = self.read();
        entries.reverse();
        entries.truncate(limit);
        entries
    }
}

#[cfg(test)]
mod switch_tests {
    use super::*;

    #[test]
    fn the_log_keeps_the_newest_first() {
        let temp = tempfile::tempdir().unwrap();
        let log = SwitchLog::new(temp.path());
        assert!(log.recent(5).is_empty());
        for at in 0..3 {
            log.append(&SwitchEntry {
                at,
                kind: "session".into(),
                from: "Work".into(),
                to: "Perso".into(),
                why: "usage_limit".into(),
                reading: None,
                session_id: Some("s".into()),
                ok: at != 1,
                error: (at == 1).then(|| "busy".into()),
            })
            .unwrap();
        }
        let recent = log.recent(2);
        assert_eq!(recent.iter().map(|e| e.at).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(recent[1].error.as_deref(), Some("busy"));
    }
}

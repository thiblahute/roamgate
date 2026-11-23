//! connections/agent-tab-title.ts: the title of a pane's agent session for
//! its tab: Claude's from the session summary bound to the pane, Hermes'
//! from its state database and Antigravity's from its annotation (by the
//! session id Herdr reports, never a guess), else the pane's own terminal
//! title when it is not a shell's or a binary's. A result is dropped when
//! the pane's agent or session changed while it was read.

use std::path::Path;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_agents::antigravity::antigravity_home;
use roamgate_agents::files::AgentEnv;
use roamgate_agents::utils::normalize_agent_name;
use roamgate_exec::quote::shell_quote;
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::tab_auto_rename::is_generic_terminal_title;
use roamgate_base::settings::js_trim;

/// A Herdr call (`HerdrCall`).
pub type HerdrCall = Arc<dyn Fn(String, Value) -> BoxFuture<Result<Value, String>> + Send + Sync>;
/// The session summary of a pane (`agent_history.summary`'s reader).
pub type ReadSummary = Arc<dyn Fn(Value) -> BoxFuture<Result<Value, String>> + Send + Sync>;

/// A command's outcome.
#[derive(Clone, Debug, Default)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Runs an argv with a timeout (ms).
pub type Run = Arc<dyn Fn(Vec<String>, u64) -> BoxFuture<Result<RunOutput, String>> + Send + Sync>;
/// The argv running a command on a host (`sshCommandArgv`).
pub type SshArgv = Arc<dyn Fn(&str, &str) -> Vec<String> + Send + Sync>;

/// `Bun.stripANSI`: the escape sequences of ansi-regex.
fn strip_ansi(text: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"[\x{1b}\x{9b}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?\x{07})|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]))",
        )
        .unwrap()
    });
    RE.replace_all(text, "").into_owned()
}

fn clean_title(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let replaced: String = strip_ansi(raw)
        .chars()
        .map(|c| {
            if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let title = js_trim(&replaced);
    (!title.is_empty()).then(|| title.chars().take(160).collect())
}

fn annotation_title(text: &str) -> Option<String> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?:^|\n)\s*title:\s*("(?:\\.|[^"\\])*")"#).unwrap());
    let quoted = RE.captures(text)?.get(1)?.as_str().to_owned();
    let parsed: Value = serde_json::from_str(&quoted).ok()?;
    clean_title(Some(&parsed))
}

/// A Hermes session's title from its state database (read-only).
pub fn read_hermes_session_title(path: &Path, id: &str) -> Result<Option<String>, String> {
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let title: Option<Value> = db
        .query_row("SELECT title FROM sessions WHERE id = ?", [id], |row| {
            let value: rusqlite::types::Value = row.get(0)?;
            Ok(match value {
                rusqlite::types::Value::Text(text) => Value::String(text),
                _ => Value::Null,
            })
        })
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    Ok(clean_title(title.as_ref()))
}

const HERMES_SCRIPT: &str = "import os, sqlite3, sys, pathlib\np = pathlib.Path(os.path.expanduser(\"~/.hermes/state.db\"))\nwith sqlite3.connect(p.as_uri() + \"?mode=ro\", uri=True) as db:\n row = db.execute(\"SELECT title FROM sessions WHERE id = ?\", (sys.argv[1],)).fetchone()\n print(row[0] if row and row[0] else \"\")";
const ANNOTATION_SCRIPT: &str = "import os, sys\np = os.path.expanduser(\"~/.gemini/antigravity-cli/annotations/\") + sys.argv[1] + \".pbtxt\"\nwith open(p, encoding=\"utf-8\") as f:\n print(f.read())";

pub struct AgentTabTitleOptions {
    pub herdr_call: HerdrCall,
    pub read_summary: ReadSummary,
    pub ssh_host: Option<String>,
    pub remote_platform: Option<String>,
    pub run: Run,
    pub ssh_argv: SshArgv,
    /// Where local agents keep their state.
    pub env: AgentEnv,
}

/// The reader of one connection (`createAgentTabTitleReader`).
#[derive(Clone)]
pub struct AgentTabTitleReader {
    options: Arc<AgentTabTitleOptions>,
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

impl AgentTabTitleReader {
    pub fn new(options: AgentTabTitleOptions) -> Self {
        Self {
            options: Arc::new(options),
        }
    }

    async fn read_bound_title(&self, agent: &str, id: &str) -> Result<Option<String>, String> {
        // Ids become annotation filenames and remote command arguments.
        // Never guess a session.
        static ID: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_-]{1,200}$").unwrap());
        if !ID.is_match(id) {
            return Ok(None);
        }
        let options = &self.options;
        if let Some(host) = &options.ssh_host {
            if options.remote_platform.as_deref() == Some("windows") {
                return Ok(None);
            }
            let script = if agent == "hermes" {
                HERMES_SCRIPT
            } else {
                ANNOTATION_SCRIPT
            };
            let command = format!("python3 -c {} {}", shell_quote(script), shell_quote(id));
            let result = (options.run)((options.ssh_argv)(host, &command), 3000).await?;
            if result.code != 0 {
                return Ok(None);
            }
            let text = String::from_utf8_lossy(&result.stdout).into_owned();
            return Ok(if agent == "hermes" {
                clean_title(Some(&json!(text)))
            } else {
                annotation_title(&text)
            });
        }
        if agent == "hermes" {
            let path = options.env.home.join(".hermes").join("state.db");
            return read_hermes_session_title(&path, id);
        }
        let path = antigravity_home(&options.env)
            .join("annotations")
            .join(format!("{id}.pbtxt"));
        let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        Ok(annotation_title(&text))
    }

    /// The title of the pane's agent session, or None.
    pub async fn read(&self, pane_id: &str) -> Result<Option<String>, String> {
        let options = &self.options;
        let result = (options.herdr_call)("agent.get".into(), json!({"target": pane_id})).await?;
        let Some(info) = result.get("agent").filter(|info| info.is_object()) else {
            return Ok(None);
        };
        let agent = normalize_agent_name(text(info.get("agent")));
        if agent.is_empty() {
            return Ok(None);
        }
        let session = info
            .get("agent_session")
            .filter(|session| session.is_object());
        let mut title: Option<String> = None;
        if let Some(session) = session {
            let session_agent = session.get("agent");
            let same_agent = match session_agent {
                None | Some(Value::Null) => true,
                Some(value) if !super_truthy(value) => true,
                Some(value) => normalize_agent_name(text(Some(value))) == agent,
            };
            if same_agent {
                if agent == "claude" {
                    let summary = (options.read_summary)(json!({"pane_id": pane_id}))
                        .await
                        .unwrap_or(Value::Null);
                    let bound = summary.get("session").filter(|bound| bound.is_object());
                    if let Some(bound) = bound
                        && bound.get("kind") == session.get("kind")
                        && bound.get("value") == session.get("value")
                    {
                        title = clean_title(summary.get("title"));
                    }
                } else if (agent == "hermes" || agent == "agy")
                    && session.get("kind").and_then(Value::as_str) == Some("id")
                {
                    title = self
                        .read_bound_title(&agent, text(session.get("value")))
                        .await
                        .unwrap_or(None);
                }
            }
        }
        if title.is_none() {
            let terminal = clean_title(info.get("terminal_title_stripped"))
                .or_else(|| clean_title(info.get("terminal_title")));
            static LEAD: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^[\s\x{2733}*\x{2022}]+").unwrap());
            if let Some(terminal) = terminal {
                let stripped = js_trim(&LEAD.replace(&terminal, "")).to_owned();
                if !stripped.is_empty() && !is_generic_terminal_title(&stripped) {
                    title = Some(stripped);
                }
            }
        }
        let Some(title) = title else {
            return Ok(None);
        };
        // A new agent or session may have replaced this one while its title
        // was being read.
        let latest = (options.herdr_call)("agent.get".into(), json!({"target": pane_id})).await?;
        let Some(live) = latest.get("agent").filter(|live| live.is_object()) else {
            return Ok(None);
        };
        if live.get("agent") != info.get("agent")
            || serde_json::to_string(&live.get("agent_session")).ok()
                != serde_json::to_string(&info.get("agent_session")).ok()
        {
            return Ok(None);
        }
        Ok(Some(title))
    }
}

/// JavaScript truthiness of a session's `agent`.
fn super_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

#[cfg(test)]
mod tests;

//! What conversation mode needs of Herdr and the pane's host (`herdr.ts`):
//! every call that changes something in a pane goes through
//! [`ConversationHerdr`], so tests drive a fake and nothing reaches a real
//! Herdr server. [`HerdrConversation`] is the real one, over Herdr's calls
//! (the core fills [`HerdrCalls`] with `herdr.call`, or its own client).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_agents::js::{self, rec, str_of};
use roamgate_agents::obj;
use serde_json::{Value, json};

use crate::driver::{BoxFuture, Drivers, PaneProcess};
use crate::shared::Obj;

/// A failed call: its message, as Bun's errors give it.
pub type HerdrError = String;
pub type HerdrResult<T> = Result<T, HerdrError>;

/// `pane.process_info`, parsed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneProcessInfo {
    pub shell_pid: Option<f64>,
    pub foreground_process_group_id: Option<f64>,
    pub foreground_processes: Vec<PaneProcess>,
}

/// Another writer on a session, as `writer_elsewhere` finds it.
#[derive(Clone, Debug, PartialEq)]
pub struct WriterElsewhere {
    /// Which, in plain words: for the log, and refusals that say no more.
    pub text: String,
    /// In a pane of this Herdr: where it is, and what it does
    /// (`AgentChatOtherWriter`).
    pub pane: Option<Obj>,
}

/// A headless agent's report to Herdr.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentReport {
    pub pane_id: String,
    /// "idle", "working", "blocked" or "unknown".
    pub state: String,
    pub session_id: String,
    pub message: Option<String>,
    /// Herdr's name of the agent; claude when not given.
    pub agent: Option<String>,
}

/// What a handover needs from Herdr and the host (`ConversationHerdr`).
pub trait ConversationHerdr: Send + Sync {
    /// `agent.get` for the pane: its agent record, None when it has none.
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<Option<Obj>>>;
    /// The screen as Herdr's agent detection reads it.
    fn read_detection<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<String>>;
    fn process_info<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<PaneProcessInfo>>;
    /// Types the text and Enter into the agent (`agent.prompt`).
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>>;
    /// Types the text into the pane's shell (`pane.send_text`).
    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>>;
    /// Presses keys in the pane (`pane.send_keys`): a menu's answer.
    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> BoxFuture<'a, HerdrResult<()>>;
    fn report_agent(&self, report: AgentReport) -> BoxFuture<'_, HerdrResult<()>>;
    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, HerdrResult<()>>;
    /// Whether a pid still runs on the pane's host.
    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool>;
    /// Whether a headless agent resumed with one of these session ids runs
    /// on the pane's host, whoever started it. Fails when the host cannot
    /// say.
    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> BoxFuture<'a, HerdrResult<bool>>;
    /// Whether the pane still exists (false once Herdr says not found).
    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<bool>>;
    /// Another writer on these sessions, outside this pane, if any: a pane
    /// Herdr maps to one of them, or an interactive TUI on the host
    /// (`except_pids` aside). Fails when the host cannot say.
    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        session_ids: &'a [String],
        except_pids: &'a [u32],
    ) -> BoxFuture<'a, HerdrResult<Option<WriterElsewhere>>>;
}

/// The source conversation mode reports to Herdr as.
pub const HEADLESS_SOURCE: &str = "roamgate:headless";

/// What a Herdr event means for conversation leases
/// (`conversationCloseEvent`): a closed pane takes its lease (and headless
/// process) with it, and a closed tab or workspace sends the service to
/// look for leases whose pane is gone. Both of Herdr's spellings are taken
/// (`pane_closed`, `pane.closed`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseEvent {
    Pane(String),
    Sweep,
}

pub fn conversation_close_event(event: &Value) -> Option<CloseEvent> {
    let event = event.as_object()?;
    let name = event.get("event")?.as_str()?;
    // JavaScript's replace: the first underscore only.
    let normalized = name.replacen('_', ".", 1);
    match normalized.as_str() {
        "pane.closed" => Some(
            match rec(event.get("data")).and_then(|data| str_of(data.get("pane_id"))) {
                Some(pane) => CloseEvent::Pane(pane.to_owned()),
                None => CloseEvent::Sweep,
            },
        ),
        "tab.closed" | "workspace.closed" => Some(CloseEvent::Sweep),
        _ => None,
    }
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// A process of Herdr's listing (`argv`, `argv0`, `cmdline`, `cwd`).
pub fn parse_pane_process(item: &Value) -> Option<PaneProcess> {
    let item = item.as_object()?;
    let pid = item.get("pid")?.as_f64()?;
    Some(PaneProcess {
        pid: pid as u32,
        argv: item.get("argv").and_then(Value::as_array).map(|argv| {
            argv.iter()
                .filter_map(|part| part.as_str().map(str::to_owned))
                .collect()
        }),
        argv0: str_of(item.get("argv0")).map(str::to_owned),
        cmdline: str_of(item.get("cmdline")).map(str::to_owned),
        cwd: str_of(item.get("cwd")).map(str::to_owned),
    })
}

/// `pane.process_info`'s answer (`parseProcessInfo`).
pub fn parse_process_info(result: &Value) -> PaneProcessInfo {
    let empty = Obj::new();
    let info = rec(Some(result))
        .and_then(|result| rec(result.get("process_info")))
        .or_else(|| rec(Some(result)))
        .unwrap_or(&empty);
    PaneProcessInfo {
        shell_pid: finite(info.get("shell_pid")),
        foreground_process_group_id: finite(info.get("foreground_process_group_id")),
        foreground_processes: info
            .get("foreground_processes")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_pane_process).collect())
            .unwrap_or_default(),
    }
}

/// The pane's agent's session id (`agent_session.value`), if any.
fn agent_session_id(agent: &Obj) -> Option<&str> {
    rec(agent.get("agent_session"))
        .and_then(|session| str_of(session.get("value")))
        .filter(|value| !value.is_empty())
}

/// Herdr's agent status as a writer's: done is idle at its prompt too.
fn writer_status(agent: &Obj) -> &'static str {
    if !agent.get("agent").is_some_and(js_truthy) {
        return "unknown";
    }
    match str_of(agent.get("agent_status")) {
        Some("idle" | "done") => "idle",
        Some("working") => "working",
        Some("blocked") => "blocked",
        _ => "unknown",
    }
}

/// JavaScript's truthiness of a value.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// The name a record of `workspace.get` or `tab.get` carries, if any.
fn label_of(result: &Value, key: &str) -> Option<(String, Option<f64>)> {
    let record = rec(Some(result)).and_then(|result| rec(result.get(key)))?;
    Some((
        str_of(record.get("label"))
            .map(js::trim)
            .unwrap_or("")
            .to_owned(),
        finite(record.get("number")),
    ))
}

/// Herdr's calls and the pane's host, as the real [`HerdrConversation`]
/// uses them.
pub trait HerdrCalls: Send + Sync {
    /// A Herdr call; the error is its message.
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        timeout_ms: u64,
    ) -> BoxFuture<'a, HerdrResult<Value>>;
    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool>;
    /// `ps -eo pid=,args=` on the pane's host; fails when it cannot run.
    fn list_processes(&self) -> BoxFuture<'_, HerdrResult<String>>;
}

static NOT_FOUND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)agent_not_found|not found").unwrap());
static NOT_STYLED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)invalid|unknown|format").unwrap());
static PANE_GONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)not[_ ]found|no such pane|unknown pane").unwrap());

/// The Herdr side of a runtime, over its calls (`createConversationHerdr`).
pub struct HerdrConversation {
    calls: Arc<dyn HerdrCalls>,
    drivers: Drivers,
    seq: AtomicI64,
}

impl HerdrConversation {
    /// `now`: the time its report sequence starts at (Date.now()).
    pub fn new(calls: Arc<dyn HerdrCalls>, drivers: Drivers, now: i64) -> Self {
        Self {
            calls,
            drivers,
            seq: AtomicI64::new(now),
        }
    }

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The pane's shell is at its prompt, no agent in front (unsure: no).
    async fn bare_shell(&self, pane_id: &str) -> bool {
        let Ok(result) = self
            .calls
            .call("pane.process_info", json!({"pane_id": pane_id}), 5000)
            .await
        else {
            return false;
        };
        let info = parse_process_info(&result);
        info.shell_pid.is_some()
            && info.foreground_process_group_id == info.shell_pid
            && !info.foreground_processes.iter().any(|process| {
                self.drivers
                    .all()
                    .iter()
                    .any(|driver| driver.terminal.is_agent_process(process))
            })
    }

    /// Another pane's writer, named as the sidebar does (the workspace's
    /// label, the tab's unless it is its number).
    async fn describe_writer(&self, pane_id: &str, name: &str, agent: &Obj) -> Obj {
        let workspace_id = str_of(agent.get("workspace_id")).map(str::to_owned);
        let tab_id = str_of(agent.get("tab_id")).map(str::to_owned);
        let workspace = async {
            match &workspace_id {
                Some(id) => self
                    .calls
                    .call("workspace.get", json!({"workspace_id": id}), 5000)
                    .await
                    .ok()
                    .and_then(|result| label_of(&result, "workspace")),
                None => None,
            }
        };
        let tab = async {
            match &tab_id {
                Some(id) => self
                    .calls
                    .call("tab.get", json!({"tab_id": id}), 5000)
                    .await
                    .ok()
                    .and_then(|result| label_of(&result, "tab")),
                None => None,
            }
        };
        let (workspace, tab) = tokio::join!(workspace, tab);
        let tab_label = match &tab {
            Some((label, number))
                if !label.is_empty()
                    && number.is_none_or(|number| *label != js::number_text(number)) =>
            {
                Some(label.clone())
            }
            Some((_, Some(number))) => Some(format!("Tab {}", js::number_text(*number))),
            _ => None,
        };
        obj! {
            "pane_id" => pane_id,
            "workspace_id" => workspace_id.filter(|id| !id.is_empty()),
            "tab_id" => tab_id.filter(|id| !id.is_empty()),
            "workspace_label" => workspace.map(|(label, _)| label).filter(|label| !label.is_empty()),
            "tab_label" => tab_label,
            "agent_name" => name,
            "status" => writer_status(agent),
        }
    }
}

fn text_of_read(result: &Value) -> String {
    let read = rec(Some(result))
        .and_then(|result| result.get("read"))
        .filter(|read| read.is_object())
        .unwrap_or(result);
    rec(Some(read))
        .and_then(|read| str_of(read.get("text")))
        .unwrap_or("")
        .to_owned()
}

impl ConversationHerdr for HerdrConversation {
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<Option<Obj>>> {
        Box::pin(async move {
            match self
                .calls
                .call("agent.get", json!({"target": pane_id}), 5000)
                .await
            {
                Ok(result) => Ok(rec(Some(&result))
                    .and_then(|result| rec(result.get("agent")))
                    .cloned()),
                Err(error) if NOT_FOUND.is_match(&error) => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    fn read_detection<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<String>> {
        Box::pin(async move {
            // With its styles: Claude's suggested next prompt is dim text in
            // the prompt box, which reads as a draft once the styles are gone.
            match self
                .calls
                .call(
                    "agent.read",
                    json!({"target": pane_id, "source": "recent", "lines": 40, "format": "ansi", "strip_ansi": false}),
                    5000,
                )
                .await
            {
                Ok(result) => return Ok(text_of_read(&result)),
                Err(error) if !NOT_STYLED.is_match(&error) => return Err(error),
                Err(_) => {}
            }
            // A Herdr without styled reads.
            let result = self
                .calls
                .call(
                    "agent.read",
                    json!({"target": pane_id, "source": "detection", "strip_ansi": true}),
                    5000,
                )
                .await?;
            Ok(text_of_read(&result))
        })
    }

    fn process_info<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<PaneProcessInfo>> {
        Box::pin(async move {
            let result = self
                .calls
                .call("pane.process_info", json!({"pane_id": pane_id}), 5000)
                .await?;
            Ok(parse_process_info(&result))
        })
    }

    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move {
            self.calls
                .call(
                    "agent.prompt",
                    json!({"target": pane_id, "text": text}),
                    5000,
                )
                .await
                .map(drop)
        })
    }

    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move {
            self.calls
                .call(
                    "pane.send_text",
                    json!({"pane_id": pane_id, "text": text}),
                    5000,
                )
                .await
                .map(drop)
        })
    }

    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move {
            self.calls
                .call(
                    "pane.send_keys",
                    json!({"pane_id": pane_id, "keys": [keys]}),
                    5000,
                )
                .await
                .map(drop)
        })
    }

    fn report_agent(&self, report: AgentReport) -> BoxFuture<'_, HerdrResult<()>> {
        Box::pin(async move {
            let seq = self.next_seq();
            let params = obj! {
                "pane_id" => report.pane_id,
                "source" => HEADLESS_SOURCE,
                "agent" => report.agent.unwrap_or_else(|| "claude".into()),
                "state" => report.state,
                "agent_session_id" => report.session_id,
                "seq" => seq,
                "message" => report.message.filter(|message| !message.is_empty()),
            };
            self.calls
                .call("pane.report_agent", Value::Object(params), 5000)
                .await
                .map(drop)
        })
    }

    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move {
            let seq = self.next_seq();
            self.calls
                .call(
                    "pane.release_agent",
                    json!({"pane_id": pane_id, "source": HEADLESS_SOURCE, "agent": agent.unwrap_or("claude"), "seq": seq}),
                    5000,
                )
                .await
                .map(drop)
        })
    }

    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool> {
        self.calls.pid_alive(pid)
    }

    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> BoxFuture<'a, HerdrResult<bool>> {
        Box::pin(async move {
            let ps = self.calls.list_processes().await?;
            Ok(self
                .drivers
                .all()
                .iter()
                .any(|driver| driver.terminal.headless_probe(&ps, session_ids)))
        })
    }

    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<bool>> {
        Box::pin(async move {
            match self
                .calls
                .call("pane.get", json!({"pane_id": pane_id}), 5000)
                .await
            {
                Ok(_) => Ok(true),
                Err(error) if PANE_GONE.is_match(&error) => Ok(false),
                Err(error) => Err(error),
            }
        })
    }

    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        session_ids: &'a [String],
        except_pids: &'a [u32],
    ) -> BoxFuture<'a, HerdrResult<Option<WriterElsewhere>>> {
        Box::pin(async move {
            let listed = self.calls.call("agent.list", json!({}), 5000).await?;
            let agents = rec(Some(&listed))
                .and_then(|listed| listed.get("agents"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for agent in &agents {
                let Some(agent) = agent.as_object() else {
                    continue;
                };
                if agent.get("pane_id").and_then(Value::as_str) == Some(pane_id) {
                    continue;
                }
                let Some(session) = agent_session_id(agent) else {
                    continue;
                };
                if !session_ids.iter().any(|id| id == session) {
                    continue;
                }
                let other = agent.get("pane_id").map(js::to_text).unwrap_or_default();
                // Herdr keeps a pane's session once its agent has gone: a
                // shell back at its prompt writes nothing.
                if !agent.get("agent").is_some_and(js_truthy) && self.bare_shell(&other).await {
                    continue;
                }
                let name = str_of(agent.get("agent"))
                    .and_then(|name| self.drivers.for_herdr_agent(name))
                    .map(|driver| driver.terminal.display_name().to_owned())
                    .unwrap_or_else(|| "Claude".into());
                return Ok(Some(WriterElsewhere {
                    text: format!("{name} runs this session in pane {other}"),
                    pane: Some(self.describe_writer(&other, &name, agent).await),
                }));
            }
            let ps = self.calls.list_processes().await?;
            for driver in self.drivers.all() {
                if let Some(pid) = driver
                    .terminal
                    .interactive_writer(&ps, session_ids, except_pids)
                {
                    return Ok(Some(WriterElsewhere {
                        text: format!(
                            "{} runs this session in another terminal (pid {pid})",
                            driver.terminal.display_name()
                        ),
                        pane: None,
                    }));
                }
            }
            Ok(None)
        })
    }
}

/// A local pid check: signal 0 tells whether it exists (`localPidAlive`).
pub fn local_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = rustix::process::Pid::from_raw(pid as i32) else {
            return false;
        };
        match rustix::process::test_kill_process(pid) {
            Ok(()) => true,
            Err(error) => error == rustix::io::Errno::PERM,
        }
    }
    #[cfg(not(unix))]
    {
        // No signal 0 here: the task list says whether it runs.
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests;

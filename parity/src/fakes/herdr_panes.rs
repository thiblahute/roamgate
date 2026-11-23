//! Terminal panes of the fake Herdr: a pane listed in the seed's
//! `terminals` behaves as a pane with a shell, for conversation mode's
//! handovers.
//!
//! ```yaml
//! herdr:
//!   terminals:
//!     p1: {args: [--model, opus], cwd: "${ROOT}/work"}
//! ```
//!
//! - A Claude TUI runs in it from the start (`tui: false` for a bare
//!   shell): a real process, the `claude` fake with `PARITY_CLAUDE_TUI=1`,
//!   which stays until killed, so pids, `pane.process_info` and a pid check
//!   on the host all see it.
//! - `agent.read` gives the TUI's screen (`screen`, default an idle Claude
//!   with an empty prompt box), or a shell prompt once it is gone.
//! - `agent.prompt` with `/exit` (or `/quit`) ends the TUI.
//! - `pane.send_text` runs what is typed, once it ends with Enter (`\r` or
//!   `\n`), with `sh -c` in the pane's directory and environment (the
//!   run's, with HERDR_PANE_ID, HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH): the
//!   pane holder Roamgate types there runs for real. Its output goes to
//!   `<herdr dir>/pane-<id>.log`.
//! - `pane.report_agent` and `pane.release_agent` update the pane's agent
//!   record as Herdr does; `pane.send_keys` is acknowledged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use herdr_api::api::{
    AgentInfo, Method, PaneProcessInfo, PaneProcessInfoProcess, PaneReadResult, ResponseResult,
};
use serde::Deserialize;

use super::herdr::Model;

/// An idle Claude Code at an empty prompt box, as Herdr reads it.
pub const IDLE_CLAUDE_SCREEN: &str = "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\u{276f} \n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n  ? for shortcuts\n";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSeed {
    #[serde(default = "yes")]
    pub tui: bool,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub screen: Option<String>,
    /// Commands typed in the pane read a keyboard (a pipe the scenario
    /// writes to with `pane_type`) instead of an ended input.
    #[serde(default)]
    pub keyboard: bool,
}

fn yes() -> bool {
    true
}

struct Pane {
    seed: TerminalSeed,
    tui: Option<Child>,
    jobs: Vec<Child>,
}

/// The run's side the panes need: its environment and fakes.
#[derive(Debug, Clone)]
pub struct Shell {
    pub env: BTreeMap<String, String>,
    pub bin: PathBuf,
    pub dir: PathBuf,
}

#[derive(Default)]
pub struct Panes {
    shell: Option<Shell>,
    panes: BTreeMap<String, Pane>,
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    // Reaped at once: a zombie would still pass a pid check.
    let _ = child.wait();
}

impl Panes {
    /// Starts the TUIs of the model's terminal panes (again after a reseed).
    pub fn attach(&mut self, shell: Shell, model: &Model) {
        self.shell = Some(shell);
        self.reset(model);
    }

    pub fn reset(&mut self, model: &Model) {
        for pane in self.panes.values_mut() {
            if let Some(tui) = pane.tui.as_mut() {
                kill(tui);
            }
        }
        self.panes.clear();
        let Some(shell) = self.shell.clone() else {
            return;
        };
        for (id, seed) in &model.terminals {
            let seed: TerminalSeed = match serde_json::from_value(seed.clone()) {
                Ok(seed) => seed,
                Err(error) => {
                    eprintln!("fake herdr: terminals.{id}: {error}");
                    continue;
                }
            };
            let cwd = self.cwd(model, id, &seed);
            let tui = seed.tui.then(|| {
                Command::new(shell.bin.join(super::exe("claude")))
                    .args(&seed.args)
                    .env_clear()
                    .envs(&shell.env)
                    .env("PARITY_CLAUDE_TUI", "1")
                    .current_dir(&cwd)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .ok()
            });
            self.panes.insert(
                id.clone(),
                Pane {
                    seed,
                    tui: tui.flatten(),
                    jobs: Vec::new(),
                },
            );
        }
    }

    fn cwd(&self, model: &Model, id: &str, seed: &TerminalSeed) -> PathBuf {
        let from_pane = model
            .panes
            .iter()
            .find(|pane| pane.pane_id == id)
            .and_then(|pane| pane.cwd.clone());
        let path = PathBuf::from(seed.cwd.clone().or(from_pane).unwrap_or_else(|| "/".into()));
        if path.is_dir() {
            path
        } else {
            PathBuf::from("/")
        }
    }

    fn tui_alive(pane: &mut Pane) -> bool {
        match pane.tui.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    pane.tui = None;
                    false
                }
            },
            None => false,
        }
    }

    /// The answer of a terminal pane's method, or None when it is not one.
    pub fn answer(&mut self, model: &mut Model, method: &Method) -> Option<ResponseResult> {
        match method {
            Method::PaneReportAgent(params) => {
                let state = serde_json::to_value(params.state).ok()?;
                let agent = find_agent(model, &params.pane_id);
                if let Some(agent) = agent {
                    agent.agent_status =
                        serde_json::from_value(state).unwrap_or(agent.agent_status);
                    agent.agent = Some(params.agent.clone());
                    if let Some(session) = &params.agent_session_id {
                        agent.agent_session = serde_json::from_value(serde_json::json!({
                            "source": params.source, "agent": params.agent, "kind": "id", "value": session
                        }))
                        .ok();
                    }
                }
                Some(ResponseResult::Ok {})
            }
            Method::PaneReleaseAgent(_) | Method::PaneSendKeys(_) => Some(ResponseResult::Ok {}),
            Method::PaneProcessInfo(params) => {
                let pane_id = params.pane_id.clone()?;
                let pane = self.panes.get_mut(&pane_id)?;
                let shell_pid = std::process::id();
                let tui_pid = if Self::tui_alive(pane) {
                    pane.tui.as_ref().map(Child::id)
                } else {
                    None
                };
                let mut processes = Vec::new();
                if let Some(pid) = tui_pid {
                    let mut argv = vec!["claude".to_owned()];
                    argv.extend(pane.seed.args.iter().cloned());
                    processes.push(PaneProcessInfoProcess {
                        pid,
                        name: "claude".into(),
                        argv0: Some("claude".into()),
                        cmdline: Some(argv.join(" ")),
                        argv: Some(argv),
                        cwd: pane.seed.cwd.clone().or_else(|| {
                            model
                                .panes
                                .iter()
                                .find(|info| info.pane_id == pane_id)
                                .and_then(|info| info.cwd.clone())
                        }),
                    });
                }
                pane.jobs
                    .retain_mut(|job| matches!(job.try_wait(), Ok(None)));
                let job_pid = pane.jobs.last().map(Child::id);
                let foreground = tui_pid.or(job_pid).unwrap_or(shell_pid);
                Some(ResponseResult::PaneProcessInfo {
                    process_info: PaneProcessInfo {
                        pane_id: pane_id.clone(),
                        shell_pid: Some(shell_pid),
                        foreground_process_group_id: Some(foreground),
                        tty: None,
                        foreground_processes: processes,
                    },
                })
            }
            Method::AgentRead(params) => {
                let pane = self.panes.get_mut(&params.target)?;
                let text = if Self::tui_alive(pane) {
                    pane.seed
                        .screen
                        .clone()
                        .unwrap_or_else(|| IDLE_CLAUDE_SCREEN.into())
                } else {
                    "$ \n".into()
                };
                let info = model
                    .panes
                    .iter()
                    .find(|info| info.pane_id == params.target)?;
                Some(ResponseResult::PaneRead {
                    read: PaneReadResult {
                        pane_id: info.pane_id.clone(),
                        workspace_id: info.workspace_id.clone(),
                        tab_id: info.tab_id.clone(),
                        source: params.source,
                        format: params.format,
                        text,
                        revision: 0,
                        truncated: false,
                    },
                })
            }
            Method::AgentPrompt(params) => {
                let pane = self.panes.get_mut(&params.target)?;
                let text = params.text.trim();
                if (text == "/exit" || text == "/quit")
                    && let Some(mut tui) = pane.tui.take()
                {
                    kill(&mut tui);
                }
                let agent = find_agent(model, &params.target)?.clone();
                Some(ResponseResult::AgentPrompted { agent })
            }
            Method::PaneSendText(params) => {
                let shell = self.shell.clone()?;
                let cwd = {
                    let pane = self.panes.get(&params.pane_id)?;
                    self.cwd(model, &params.pane_id, &pane.seed.clone())
                };
                let pane = self.panes.get_mut(&params.pane_id)?;
                let text = params.text.as_str();
                if text.ends_with('\r') || text.ends_with('\n') {
                    let command = text.trim().to_owned();
                    let workspace = model
                        .panes
                        .iter()
                        .find(|info| info.pane_id == params.pane_id)
                        .map(|info| info.workspace_id.clone())
                        .unwrap_or_default();
                    let log = log_file(&shell.dir, &params.pane_id);
                    let keyboard = pane.seed.keyboard;
                    let job = Command::new("sh")
                        .arg("-c")
                        .arg(&command)
                        .env_clear()
                        .envs(&shell.env)
                        .env("HERDR_PANE_ID", &params.pane_id)
                        .env("HERDR_WORKSPACE_ID", workspace)
                        .current_dir(cwd)
                        .stdin(if keyboard {
                            Stdio::piped()
                        } else {
                            Stdio::null()
                        })
                        .stdout(log.try_clone().map(Stdio::from).unwrap_or(Stdio::null()))
                        .stderr(log.try_clone().map(Stdio::from).unwrap_or(Stdio::null()))
                        .spawn();
                    match job {
                        Ok(job) => pane.jobs.push(job),
                        Err(error) => eprintln!("fake herdr: pane {}: {error}", params.pane_id),
                    }
                }
                Some(ResponseResult::Ok {})
            }
            _ => None,
        }
    }
}

impl Panes {
    /// The pane's newest job still running.
    fn job(&mut self, pane: &str) -> Option<&mut Child> {
        let pane = self.panes.get_mut(pane)?;
        let index = pane
            .jobs
            .iter_mut()
            .rposition(|job| matches!(job.try_wait(), Ok(None)))?;
        pane.jobs.get_mut(index)
    }

    /// Types text on the keyboard of the pane's running job.
    pub fn type_into(&mut self, pane: &str, text: &str) -> anyhow::Result<()> {
        use std::io::Write;
        let job = self
            .job(pane)
            .ok_or_else(|| anyhow::anyhow!("no job runs in pane {pane}"))?;
        let stdin = job.stdin.as_mut().ok_or_else(|| {
            anyhow::anyhow!("pane {pane} has no keyboard (terminals: keyboard: true)")
        })?;
        stdin.write_all(text.as_bytes())?;
        stdin.flush()?;
        Ok(())
    }

    /// Sends a signal (`HUP`, `TERM`, `KILL`, ...) to the pane's running
    /// job, as a pane that closes or a kill does; gives its pid.
    pub fn signal(&mut self, pane: &str, signal: &str) -> anyhow::Result<u32> {
        let job = self
            .job(pane)
            .ok_or_else(|| anyhow::anyhow!("no job runs in pane {pane}"))?;
        let pid = job.id();
        let status = Command::new("kill")
            .arg(format!("-{signal}"))
            .arg(pid.to_string())
            .status()?;
        anyhow::ensure!(status.success(), "kill -{signal} {pid} failed");
        Ok(pid)
    }

    /// The pid of the pane's running job, if any.
    pub fn job_pid(&mut self, pane: &str) -> Option<u32> {
        self.job(pane).map(|job| job.id())
    }
}

fn find_agent<'a>(model: &'a mut Model, pane: &str) -> Option<&'a mut AgentInfo> {
    model
        .agents
        .iter_mut()
        .find(|agent| agent.pane_id == pane || agent.terminal_id == pane)
}

fn log_file(dir: &Path, pane: &str) -> std::fs::File {
    let safe: String = pane
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("pane-{safe}.log")))
        .unwrap_or_else(|_| std::fs::File::create("/dev/null").expect("/dev/null"))
}

impl Drop for Panes {
    fn drop(&mut self) {
        for pane in self.panes.values_mut() {
            if let Some(tui) = pane.tui.as_mut() {
                kill(tui);
            }
            for job in &mut pane.jobs {
                kill(job);
            }
        }
    }
}

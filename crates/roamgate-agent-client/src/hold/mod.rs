//! `roamgate-hold`: hold a pane while Roamgate's conversation mode owns
//! its session.
//!
//! While it holds the pane it also runs the session's headless claude for
//! Roamgate, as its own child: everything claude says goes to a log on
//! this host, which Roamgate reads from where it stopped (an SSH link that
//! drops or a Roamgate restart loses nothing), and what Roamgate writes
//! reaches claude's stdin once, in order. Handing the session back ends
//! that child first, then becomes claude --resume: one process sequences
//! both writers.
//!
//! The same command line, environment, requests and output as
//! contract/assets/python/roamgate-hold.py, which SSH hosts still run.

mod api_key;
mod child;
mod sys;

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::py;
use child::Child;
use sys::Disposition;

/// Set on the claude this holder becomes: it stays in the terminal,
/// whatever Roamgate's claude start setting says (its SessionStart hook
/// steps aside).
pub const START_ENV: &str = "ROAMGATE_CLAUDE_START";
const NOTICE: &str = "This session is in conversation mode; Enter takes it back here.";
const HINT: &str = "Press Enter alone (nothing typed) to take the session back here.";
/// Enter again within this long ends the child when Roamgate cannot answer.
const CONFIRM: Duration = Duration::from_secs(10);
/// The environment variable that makes a holder process its child's guard.
pub const GUARD_ENV: &str = "ROAMGATE_HOLD_GUARD";

/// How this holder was started, to start its guards and itself again.
pub struct Holder {
    pub socket: PathBuf,
    /// The executable (the roamgate binary).
    program: PathBuf,
    /// The name it was run under (`roamgate-hold`, or `roamgate`); off
    /// Unix the executable's own name says it.
    #[cfg_attr(not(unix), allow(dead_code))]
    arg0: String,
    /// The arguments that select the holder (`hold` for `roamgate hold`).
    prefix: Vec<String>,
}

impl Holder {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        #[cfg(unix)]
        std::os::unix::process::CommandExt::arg0(&mut command, &self.arg0);
        command.args(&self.prefix);
        command
    }

    /// Starts the guard of child `pid`: should this holder die without
    /// ending it (killed, crashed), the guard does. It reads a pipe only
    /// this holder writes: a byte means the child ended (nothing to do),
    /// the end of the pipe that the holder is gone. Gives the pipe's end
    /// that calls it off.
    fn guard(&self, pid: u32) -> Option<std::io::PipeWriter> {
        let (reader, writer) = std::io::pipe().ok()?;
        let mut command = self.command();
        command
            .env(GUARD_ENV, pid.to_string())
            .stdin(reader)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        command.spawn().ok()?;
        Some(writer)
    }
}

/// The guard itself (run with [`GUARD_ENV`] set to the child's pid).
pub fn guard_main(pid: &str) -> i32 {
    for signal in [sys::SIGHUP, sys::SIGINT, sys::SIGTERM] {
        sys::set_signal(signal, Disposition::Ignore);
    }
    let mut byte = [0u8; 1];
    let done = matches!(std::io::stdin().read(&mut byte), Ok(1));
    if !done && let Ok(pid) = pid.trim().parse::<u32>() {
        sys::kill(pid);
    }
    0
}

/// Posts to the agent socket: its status and JSON reply ({} when it is not
/// JSON), or why Roamgate cannot be reached at all.
pub fn post(
    socket: &Path,
    command: &str,
    body: &Map<String, Value>,
    timeout: u64,
) -> Result<(u16, Map<String, Value>), String> {
    let text = py::dumps(&Value::Object(body.clone()));
    let response = crate::http::post(socket, command, &text, Duration::from_secs(timeout))
        .map_err(|error| error.0)?;
    let reply = serde_json::from_str::<Value>(&response.text())
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    Ok((response.status, reply))
}

/// A piece of a long line, cut between characters (it is sent as text).
pub fn utf8_prefix(data: &[u8]) -> &[u8] {
    for back in 1..=data.len().min(4) {
        let lead = data[data.len() - back];
        if lead & 0xC0 == 0x80 {
            continue;
        }
        let size = if lead >= 0xF0 {
            4
        } else if lead >= 0xE0 {
            3
        } else if lead >= 0xC0 {
            2
        } else {
            1
        };
        return if back >= size {
            data
        } else {
            &data[..data.len() - back]
        };
    }
    data
}

/// Roamgate is gone: is a headless claude still on one of these sessions
/// here? After /clear its argv still names the session it resumed.
fn conversation_running(sessions: &[String]) -> bool {
    let Some(out) = crate::process::output_within(
        Command::new("ps").args(["-eo", "pid=,args="]),
        Duration::from_secs(10),
    ) else {
        return true;
    };
    let out = String::from_utf8_lossy(&out);
    out.lines()
        .filter(|line| line.contains("stream-json"))
        .any(|line| {
            sessions.iter().any(|session| {
                line.contains(&format!("--resume {session}"))
                    || line.contains(&format!("--resume '{session}"))
            })
        })
}

/// Claude keeps a session under its project's folder once it has a
/// message; one started and left at once has none yet.
fn transcript_exists(session: &str, env: &BTreeMap<String, String>, cwd: &str) -> bool {
    let base = env
        .get("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| py::home().join(".claude"));
    let projects = base.join("projects");
    let name = format!("{session}.jsonl");
    let cwd = if cwd.is_empty() {
        py::real_cwd()
    } else {
        py::realpath(cwd)
    };
    let here: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if projects.join(&here).join(&name).exists() {
        return true;
    }
    std::fs::read_dir(&projects)
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().join(&name).exists())
        })
        .unwrap_or(false)
}

/// `--resume` of a session with no transcript fails: it starts with that
/// id instead (claude started, then taken at once, before a message).
pub fn new_or_resumed(argv: &[String], env: &BTreeMap<String, String>, cwd: &str) -> Vec<String> {
    let Some(at) = argv.iter().position(|arg| arg == "--resume") else {
        return argv.to_vec();
    };
    if at + 1 >= argv.len() || transcript_exists(&argv[at + 1], env, cwd) {
        return argv.to_vec();
    }
    let mut out = argv[..at].to_vec();
    out.push("--session-id".into());
    out.extend(argv[at + 1..].iter().cloned());
    out
}

fn say(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "\r\n{text}\r\n");
    let _ = out.flush();
}

fn eprint_exit(message: &str, code: i32) -> i32 {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{message}");
    code
}

fn process_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn env_var(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    items
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// A profile's environment on this process: its removals, then its values.
fn apply_profile_env(spec: &Map<String, Value>, env: &mut BTreeMap<String, String>) {
    if let Some(unset) = spec.get("unset").and_then(Value::as_array) {
        for name in unset.iter().filter_map(Value::as_str) {
            env.remove(name);
        }
    }
    if let Some(values) = spec.get("env").and_then(Value::as_object) {
        for (name, value) in values {
            if let Some(value) = value.as_str() {
                env.insert(name.clone(), value.to_owned());
            }
        }
    }
}

/// Becomes `program args` with `env` (`os.execvp`); gives the error when
/// it could not. Off Unix it runs it and exits with its code.
fn exec(program: &str, args: &[String], env: &BTreeMap<String, String>) -> std::io::Error {
    let mut command = Command::new(program);
    command.args(args).env_clear().envs(env);
    #[cfg(unix)]
    {
        std::os::unix::process::CommandExt::exec(&mut command)
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => error,
        }
    }
}

/// `str(error)` of a failed `os.execvp`.
fn exec_error_text(error: &std::io::Error, program: &str) -> String {
    match error.raw_os_error() {
        Some(_) => format!("{}: {}", py::os_error_text(error), py::repr_str(program)),
        None => error.to_string(),
    }
}

/// An agent start Roamgate prepared for this pane (a profile's program and
/// environment, fetched with a one-use token so nothing secret is typed):
/// become it.
fn launch(holder: &Holder, token: &str, pane: &str) -> i32 {
    let mut body = Map::new();
    body.insert("pane".into(), json!(pane));
    body.insert("token".into(), json!(token));
    let (status, reply) = match post(&holder.socket, "launch", &body, 30) {
        Ok(answer) => answer,
        Err(error) => {
            return eprint_exit(
                &format!("roamgate-hold: Roamgate is unreachable: {error}"),
                1,
            );
        }
    };
    let argv = if status == 200 {
        string_list(reply.get("argv"))
            .filter(|argv| !argv.is_empty() && argv.iter().all(|a| !a.is_empty()))
    } else {
        None
    };
    let Some(argv) = argv else {
        let error = reply
            .get("error")
            .filter(|error| truthy(error))
            .map(py_text)
            .unwrap_or_else(|| "Roamgate has no such start (it expired?)".into());
        return eprint_exit(&format!("roamgate-hold: {error}"), 1);
    };
    let mut env = process_env();
    apply_profile_env(&reply, &mut env);
    let program = argv[0].clone();
    let mut args = argv[1..].to_vec();
    if reply.get("agent").and_then(Value::as_str) == Some("claude") {
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        args = new_or_resumed(&args, &env, &cwd);
    }
    if reply.get("terminal").is_some_and(|value| {
        !matches!(value, Value::Null | Value::Bool(false))
            && value != &json!(0)
            && value != &json!("")
    }) {
        env.insert(START_ENV.into(), "terminal".into());
    }
    let error = exec(&program, &args, &env);
    eprint_exit(
        &format!(
            "roamgate-hold: {program} did not start: {}",
            exec_error_text(&error, &program)
        ),
        127,
    )
}

/// Takes `name VALUE` out of the arguments: the value, if it had one.
fn take_option(args: &mut Vec<String>, name: &str) -> Option<Option<String>> {
    let at = args.iter().position(|arg| arg == name)?;
    let value = args.get(at + 1).cloned();
    let end = (at + 2).min(args.len());
    args.drain(at..end);
    Some(value)
}

/// Stops this holder as a job of the pane's shell: the shell's prompt is
/// back, no claude runs, and the session is saved (its transcript).
/// Brought back with fg, this holder starts again and asks Roamgate for
/// the session (which it keeps here meanwhile) in conversation mode.
fn stopped_job(
    holder: &Holder,
    relaunch: &[String],
    spec: &Map<String, Value>,
    why: Option<&str>,
) -> i32 {
    let text = |name: &str| {
        spec.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let session = text("session_id");
    let title = Some(text("title"))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| session.clone());
    if let Some(why) = why {
        say(why);
        say(&format!(
            "To leave it instead: kill this job, then claude --resume {session}"
        ));
    }
    say(&format!(
        "Suspended: claude (conversation: {title}). fg brings it back."
    ));
    sys::set_signal(sys::SIGTSTP, Disposition::Default);
    loop {
        sys::stop_self();
        // Continued: by fg, in the foreground, or by bg (it stops again:
        // it only holds the pane from the foreground).
        if sys::in_foreground() {
            break;
        }
    }
    let mut keep = Map::new();
    for name in ["session_id", "cwd", "title", "terminal_args"] {
        if let Some(value) = spec.get(name).filter(|value| truthy(value)) {
            keep.insert(name.into(), value.clone());
        }
    }
    let mut command = holder.command();
    command
        .args(relaunch)
        .arg("--fg")
        .arg(py::dumps(&Value::Object(keep)));
    #[cfg(unix)]
    let error = std::os::unix::process::CommandExt::exec(&mut command);
    #[cfg(not(unix))]
    let error = match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => error,
    };
    eprint_exit(&format!("roamgate-hold: {error}"), 1)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn reset_signals(signals: &[i32]) {
    for signal in signals {
        sys::set_signal(*signal, Disposition::Default);
    }
}

/// Lines typed into the pane, read on their own thread; None at the end of
/// the input.
fn stdin_lines() -> mpsc::Receiver<Option<String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        loop {
            let mut line = Vec::new();
            match stdin.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => {
                    let _ = sender.send(None);
                    return;
                }
                Ok(_) => {
                    if sender
                        .send(Some(String::from_utf8_lossy(&line).into_owned()))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

/// What the holder waits for: Roamgate's answer that ends its hold.
#[derive(Default)]
struct Done {
    target: Option<Map<String, Value>>,
}

/// Ends the holder when the pane closes (SIGHUP, SIGTERM; a closed console
/// on Windows): its claude goes with it, and its log does not stay behind
/// (the conversation in full).
fn on_hangup(child: Arc<Child>) {
    #[cfg(unix)]
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
        else {
            return;
        };
        runtime.block_on(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let (Ok(mut hangup), Ok(mut terminate)) = (
                signal(SignalKind::hangup()),
                signal(SignalKind::terminate()),
            ) else {
                return;
            };
            let number = tokio::select! {
                _ = hangup.recv() => sys::SIGHUP,
                _ = terminate.recv() => sys::SIGTERM,
            };
            // No lock here: the interrupted thread may hold it.
            child.kill_unlocked();
            let _ = std::fs::remove_dir_all(&child.directory);
            std::process::exit(128 + number);
        });
    });
    // Windows: the console closes (the pane goes).
    #[cfg(windows)]
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
        else {
            return;
        };
        runtime.block_on(async move {
            let Ok(mut close) = tokio::signal::windows::ctrl_close() else {
                return;
            };
            close.recv().await;
            child.kill_unlocked();
            let _ = std::fs::remove_dir_all(&child.directory);
            std::process::exit(128 + sys::SIGHUP);
        });
    });
}

/// `roamgate-hold ARGS`: the process's exit code (when it does not
/// become claude).
pub fn main(argv0: &str, prefix: &[String], args: &[String]) -> i32 {
    if let Ok(pid) = std::env::var(GUARD_ENV) {
        return guard_main(&pid);
    }
    let mut args = args.to_vec();
    let mut socket = std::env::var("ROAMGATE_REVIEW_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            py::home()
                .join(".cache")
                .join("roamgate")
                .join("review.sock")
        });
    if let Some(value) = take_option(&mut args, "--socket")
        && let Some(value) = value
    {
        socket = PathBuf::from(value);
    }
    // Brought back with fg after stopping as a shell job: what it kept.
    let mut fg_spec: Option<Map<String, Value>> = None;
    if let Some(value) = take_option(&mut args, "--fg") {
        fg_spec = value
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned());
    }
    let holder = Arc::new(Holder {
        socket,
        program: std::env::current_exe().unwrap_or_else(|_| PathBuf::from(argv0)),
        arg0: argv0.to_owned(),
        prefix: prefix.to_vec(),
    });
    // This holder's arguments without --fg: what it runs again with after fg.
    let relaunch = relaunch_args(prefix);
    if args.first().map(String::as_str) == Some("--launch") {
        let pane = env_var("HERDR_PANE_ID");
        if pane.is_empty() || args.len() < 2 {
            return eprint_exit(
                "roamgate-hold --launch runs in a Herdr pane, given a token",
                2,
            );
        }
        return launch(&holder, &args[1], &pane);
    }
    let session = args.first().cloned().unwrap_or_default();
    let pane = env_var("HERDR_PANE_ID");
    if pane.is_empty() || session.is_empty() || session.contains('/') || session.starts_with('.') {
        return eprint_exit("roamgate-hold runs in a Herdr pane, given a session id", 2);
    }
    hold(holder, &relaunch, session, pane, fg_spec)
}

/// `sys.argv[1:]` without its first `--fg VALUE` (nor the arguments that
/// chose the holder: `hold` of `roamgate hold ...`).
fn relaunch_args(prefix: &[String]) -> Vec<String> {
    let mut all: Vec<String> = std::env::args().skip(1).collect();
    if all.starts_with(prefix) {
        all.drain(..prefix.len());
    }
    if let Some(at) = all.iter().position(|arg| arg == "--fg") {
        let end = (at + 2).min(all.len());
        all.drain(at..end);
    }
    all
}

fn hold(
    holder: Arc<Holder>,
    relaunch: &[String],
    session: String,
    pane: String,
    fg_spec: Option<Map<String, Value>>,
) -> i32 {
    // Nothing typed here may reach the shell, or signal claude, while the
    // session is held.
    for signal in [sys::SIGINT, sys::SIGTSTP, sys::SIGQUIT] {
        sys::set_signal(signal, Disposition::Ignore);
    }
    let saved_tty = sys::quiet_tty();
    let root = py::home().join(".cache").join("roamgate").join("headless");
    let child = match Child::new(&root, holder.clone()) {
        Ok(child) => child,
        Err(error) => {
            return eprint_exit(&format!("roamgate-hold: {}", py::os_error_text(&error)), 1);
        }
    };
    on_hangup(child.clone());
    let cwd = py::real_cwd();
    let mut body = Map::new();
    body.insert("pane".into(), json!(pane));
    body.insert("workspace".into(), json!(env_var("HERDR_WORKSPACE_ID")));
    body.insert("herdr_socket".into(), json!(env_var("HERDR_SOCKET_PATH")));
    body.insert("cwd".into(), json!(cwd));
    body.insert("agent".into(), json!("claude"));
    body.insert("session".into(), json!(session));
    // Whether it can stop as a shell job, and how its job is named.
    body.insert(
        "job_control".into(),
        json!(if sys::job_control() { 1 } else { 0 }),
    );
    body.insert("holder_pid".into(), json!(std::process::id()));
    body.insert("job".into(), json!(session));
    let body = Arc::new(Mutex::new(body));
    // Every session this pane held: a headless claude may name any of them.
    let seen = Arc::new(Mutex::new(vec![session.clone()]));
    let done = Arc::new((Mutex::new(Done::default()), Condvar::new()));
    let resume = {
        let done = done.clone();
        move |reply: Map<String, Value>| {
            let mut state = done.0.lock().unwrap();
            if state.target.is_some() {
                return;
            }
            state.target = Some(reply);
            done.1.notify_all();
        }
    };
    let is_done = {
        let done = done.clone();
        move || done.0.lock().unwrap().target.is_some()
    };

    if let Some(fg) = &fg_spec {
        // Back from a stopped job: the session it kept, in conversation
        // mode again, or stopped again with the reason.
        {
            let mut body = body.lock().unwrap();
            if let Some(id) = fg.get("session_id").filter(|v| truthy(v)) {
                body.insert("session".into(), id.clone());
                let id = py_text(id);
                let mut seen = seen.lock().unwrap();
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            if let Some(dir) = fg.get("cwd").filter(|v| truthy(v)) {
                body.insert("cwd".into(), dir.clone());
            }
        }
        say("Bringing the conversation back...");
        let mut request = body.lock().unwrap().clone();
        request.extend(child.status(&child.state.lock().unwrap()));
        request.insert(
            "terminal_args".into(),
            json!(py::dumps(
                fg.get("terminal_args")
                    .filter(|v| truthy(v))
                    .unwrap_or(&json!([]))
            )),
        );
        let (status, reply) = match post(&holder.socket, "fg", &request, 60) {
            Ok(answer) => answer,
            Err(error) => {
                let mut reply = Map::new();
                reply.insert(
                    "error".into(),
                    json!(format!("Roamgate is unreachable: {error}")),
                );
                (0, reply)
            }
        };
        if status != 200 || reply.get("action").and_then(Value::as_str) != Some("hold") {
            child.stop();
            let _ = std::fs::remove_dir_all(&child.directory);
            reset_signals(&[sys::SIGINT, sys::SIGQUIT, sys::SIGHUP, sys::SIGTERM]);
            if let Some(saved) = &saved_tty {
                sys::restore_tty(saved);
            }
            let reason = ["reason", "error"]
                .iter()
                .find_map(|name| reply.get(*name).filter(|v| truthy(v)).map(py_text))
                .unwrap_or_else(|| "Roamgate said no".into());
            return stopped_job(
                &holder,
                relaunch,
                fg,
                Some(&format!("Not brought back: {reason}")),
            );
        }
    }

    {
        let (child, body, seen, holder) =
            (child.clone(), body.clone(), seen.clone(), holder.clone());
        let resume = resume.clone();
        let is_done = is_done.clone();
        std::thread::spawn(move || {
            while !is_done() {
                let mut request = body.lock().unwrap().clone();
                request.extend(child.status(&child.state.lock().unwrap()));
                // Read outside the lock (the config may be large); only
                // this thread uses it.
                let api_key = {
                    let mut state = child.state.lock().unwrap();
                    state.api_key.get()
                };
                request.insert("api_key".into(), json!(api_key));
                let (status, reply) = match post(&holder.socket, "hold", &request, 60) {
                    Ok(answer) => answer,
                    Err(_) => {
                        std::thread::sleep(Duration::from_secs(2));
                        continue;
                    }
                };
                if status != 200 {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                // Handed back, or stopped as a shell job (the chat's Ctrl+Z).
                if matches!(
                    reply.get("action").and_then(Value::as_str),
                    Some("resume" | "suspend")
                ) {
                    resume(reply);
                    return;
                }
                child.apply(reply.get("commands"));
                if let Some(offset) = reply.get("output_from").and_then(Value::as_i64)
                    && offset >= 0
                {
                    let mut state = child.state.lock().unwrap();
                    state.want = Some(offset);
                    child.cond.notify_all();
                }
                if let Some(id) = reply.get("session_id").filter(|v| truthy(v)) {
                    body.lock().unwrap().insert("session".into(), id.clone());
                    let id = py_text(id);
                    let mut seen = seen.lock().unwrap();
                    if !seen.contains(&id) {
                        seen.push(id);
                    }
                }
            }
        });
    }
    {
        let child = child.clone();
        let pane = pane.clone();
        std::thread::spawn(move || child.send_loop(pane));
    }
    say(NOTICE);
    let lines = stdin_lines();
    let mut input_ended = false;
    // Until when another Enter ends this holder's child (Roamgate away).
    let mut confirm_until: Option<Instant> = None;
    while !is_done() {
        let line = if input_ended {
            // No terminal any more: wait for Roamgate alone.
            std::thread::sleep(Duration::from_millis(500));
            continue;
        } else {
            match lines.recv_timeout(Duration::from_millis(500)) {
                Ok(Some(line)) => line,
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    input_ended = true;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            }
        };
        if is_done() {
            continue;
        }
        if !line.trim().is_empty() {
            // Text that reached the pane (pasted, or sent to it) is not a
            // request to take the session back.
            say(HINT);
            continue;
        }
        say("Asking Roamgate to hand the session back...");
        let request = body.lock().unwrap().clone();
        let (status, reply) =
            post(&holder.socket, "handback", &request, 120).unwrap_or((0, Map::new()));
        let action = reply.get("action").and_then(Value::as_str);
        if status == 200 && action == Some("resume") {
            resume(reply);
        } else if status == 200 {
            say(&reply
                .get("reason")
                .filter(|v| truthy(v))
                .map(py_text)
                .unwrap_or_else(|| "Roamgate said no.".into()));
            say(NOTICE);
        } else {
            // Roamgate cannot answer for this pane (unreachable, or its
            // connection is not ready): this holder's own child, then the
            // host's processes, decide. Asked twice, so a process starting
            // just now shows up.
            let error = reply
                .get("error")
                .filter(|v| truthy(v))
                .map(py_text)
                .unwrap_or_else(|| "Roamgate is unreachable".into());
            let now = Instant::now();
            if child.alive() && confirm_until.is_none_or(|until| now >= until) {
                // It runs until handed back or stopped: Enter again ends it.
                confirm_until = Some(now + CONFIRM);
                say(&format!(
                    "{error}; the conversation process still runs here, so not resuming. \
                     Press Enter again within {} s to end it (what it is doing stops) and resume here.",
                    CONFIRM.as_secs()
                ));
                continue;
            }
            if child.alive() {
                say("Ending the conversation process here...");
                child.end(Duration::from_secs(5));
            }
            confirm_until = None;
            let sessions = seen.lock().unwrap().clone();
            let running = conversation_running(&sessions) || {
                std::thread::sleep(Duration::from_secs(2));
                conversation_running(&sessions)
            };
            if running {
                say(&format!(
                    "{error}; a conversation process still runs, so not resuming."
                ));
                say(NOTICE);
                continue;
            }
            let body = body.lock().unwrap();
            let mut target = Map::new();
            target.insert(
                "session_id".into(),
                body.get("session").cloned().unwrap_or(Value::Null),
            );
            target.insert(
                "cwd".into(),
                body.get("cwd").cloned().unwrap_or(Value::Null),
            );
            drop(body);
            resume(target);
            break;
        }
    }
    // The headless child ends before claude starts here.
    child.stop();
    let _ = std::fs::remove_dir_all(&child.directory);
    let target = done.0.lock().unwrap().target.clone().unwrap_or_default();
    let body = body.lock().unwrap().clone();
    let pick = |name: &str, fallback: &str| {
        target
            .get(name)
            .filter(|v| truthy(v))
            .or_else(|| body.get(fallback))
            .map(py_text)
            .unwrap_or_default()
    };
    let session = pick("session_id", "session");
    let cwd = pick("cwd", "cwd");
    reset_signals(&[
        sys::SIGINT,
        sys::SIGTSTP,
        sys::SIGQUIT,
        sys::SIGHUP,
        sys::SIGTERM,
    ]);
    if let Some(saved) = &saved_tty {
        sys::restore_tty(saved);
    }
    if target.get("action").and_then(Value::as_str) == Some("suspend") {
        // The chat's Ctrl+Z: a stopped job, not claude in the terminal.
        let mut spec = target.clone();
        spec.insert("session_id".into(), json!(session));
        spec.insert("cwd".into(), json!(cwd));
        return stopped_job(&holder, relaunch, &spec, None);
    }
    let _ = std::env::set_current_dir(&cwd);
    // The TUI's whole command line; a Roamgate from before drivers sends
    // claude's arguments alone.
    let (program, mut args) = match string_list(target.get("argv"))
        .filter(|argv| !argv.is_empty() && argv.iter().all(|a| !a.is_empty()))
    {
        Some(argv) => (argv[0].clone(), argv[1..].to_vec()),
        None => (
            "claude".to_owned(),
            string_list(target.get("args"))
                .unwrap_or_else(|| vec!["--resume".into(), session.clone()]),
        ),
    };
    // The session's profile: its environment, never typed or shown.
    let mut env = process_env();
    apply_profile_env(&target, &mut env);
    let base = program.rsplit('/').next().unwrap_or(&program);
    if base == "claude" || target.get("agent").and_then(Value::as_str) == Some("claude") {
        let here = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        args = new_or_resumed(&args, &env, &here);
    }
    // Handed back: this agent stays in the terminal.
    env.insert(START_ENV.into(), "terminal".into());
    say(&format!("Resuming {session} in the terminal."));
    let error = exec(&program, &args, &env);
    eprint_exit(
        &format!("roamgate-hold: {}", exec_error_text(&error, &program)),
        1,
    )
}

/// `str(value)` for what Roamgate sent as text.
fn py_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_a_long_line_between_characters() {
        assert_eq!(utf8_prefix(b"abc"), b"abc");
        let text = "a\u{e9}".as_bytes();
        assert_eq!(utf8_prefix(&text[..2]), b"a");
        assert_eq!(utf8_prefix(text), text);
        let emoji = "\u{1f600}".as_bytes();
        assert_eq!(utf8_prefix(&emoji[..3]), b"");
    }
}

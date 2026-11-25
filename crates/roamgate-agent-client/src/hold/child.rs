//! The headless claude run for Roamgate, and the log of all it says.
//!
//! The log only grows while the holder runs: each child is framed by a
//! start and an exit line, and each line written to its stdin is noted
//! (with Roamgate's sequence number) just before it is written. It lives
//! in a directory of this holder's own (another holder, on the same
//! session or not, never touches it).

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::api_key::{API_KEY, ApiKeyAnswers, Environ, record_api_key_answer};
use super::{Holder, new_or_resumed, post, sys, utf8_prefix};
use crate::py::{self, Dumps};

/// The most sent to Roamgate at once: whole lines, or a piece of a longer
/// line (Roamgate puts the pieces together), so no line is too long to send.
const CHUNK: u64 = 256 * 1024;
pub const STOP_WAIT: Duration = Duration::from_secs(30);

/// What to write to a child's stdin, outside the lock.
type StdinWrite = (Arc<Mutex<Option<ChildStdin>>>, Vec<u8>);

/// A running child: the process (shared with its reader, which waits on
/// it) and its stdin.
struct Proc {
    process: Arc<Mutex<std::process::Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    number: i64,
}

impl Proc {
    fn kill(&self) {
        let _ = self.process.lock().unwrap().kill();
    }
}

pub struct State {
    log: File,
    writing: bool,
    pub size: u64,
    epoch_offset: u64,
    pub number: i64,
    proc: Option<Proc>,
    pid: u32,
    stdin_open: bool,
    applied: i64,
    /// Where Roamgate wants the log from (None: it has not said).
    pub want: Option<i64>,
    closed: bool,
    pub api_key: ApiKeyAnswers,
}

pub struct Child {
    pub id: String,
    pub directory: PathBuf,
    path: PathBuf,
    pub state: Mutex<State>,
    pub cond: Condvar,
    holder: Arc<Holder>,
}

/// `json.dumps(value, separators=(",", ":")).encode()`.
fn compact(value: &Value) -> Vec<u8> {
    py::dumps_with(value, Dumps::COMPACT).into_bytes()
}

/// `str(value)` of a JSON value as Python has it.
fn py_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(number) => match number.as_i64() {
            Some(int) => int.to_string(),
            None => py::float_repr(number.as_f64().unwrap_or(0.0)),
        },
        other => other.to_string(),
    }
}

/// Python's `value == number` for an int `number`.
fn equals_int(value: Option<&Value>, number: i64) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_i64() == Some(number) || n.as_f64() == Some(number as f64),
        Some(Value::Bool(flag)) => i64::from(*flag) == number,
        _ => false,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// Whether the holder that wrote `directory` still runs.
fn holder_alive(directory: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(directory.join("holder.pid")) else {
        // Not one of ours (an older holder's): left alone.
        return true;
    };
    let text = text.trim();
    let Ok(pid) = (if text.is_empty() { "0" } else { text }).parse::<i64>() else {
        return true;
    };
    if pid <= 0 {
        return false;
    }
    sys::alive(pid as u32)
}

/// The logs of holders that died without cleaning up.
fn prune(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !holder_alive(&path) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

impl Child {
    pub fn new(root: &Path, holder: Arc<Holder>) -> std::io::Result<Arc<Self>> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        prune(root);
        let directory = root.join(&id);
        create_private_dir(&directory)?;
        std::fs::write(directory.join("holder.pid"), std::process::id().to_string())?;
        let path = directory.join("out.jsonl");
        let log = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)?;
        let env: Environ = std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        Ok(Arc::new(Self {
            id,
            directory,
            path,
            state: Mutex::new(State {
                log,
                writing: false,
                size: 0,
                epoch_offset: 0,
                number: 0,
                proc: None,
                pid: 0,
                stdin_open: false,
                applied: 0,
                want: None,
                closed: false,
                api_key: ApiKeyAnswers::new(env),
            }),
            cond: Condvar::new(),
            holder,
        }))
    }

    /// The pid of the running child, for a signal handler that may not
    /// take the lock.
    pub fn pid_unlocked(&self) -> Option<u32> {
        self.state
            .try_lock()
            .ok()
            .and_then(|state| (state.pid > 0).then_some(state.pid))
    }

    // All below with the lock held, unless said otherwise.

    fn append<'a>(
        &'a self,
        mut state: MutexGuard<'a, State>,
        data: &[u8],
    ) -> MutexGuard<'a, State> {
        let mut data = data.to_vec();
        if !data.ends_with(b"\n") {
            data.push(b'\n');
        }
        // One line at a time, whole: another waits for the one being written.
        while state.writing {
            state = self
                .cond
                .wait_timeout(state, Duration::from_secs(1))
                .unwrap()
                .0;
        }
        state.writing = true;
        let mut view: &[u8] = &data;
        while !view.is_empty() {
            match state.log.write(view) {
                Ok(written) => view = &view[written..],
                Err(_) => {
                    // The disk is full, say: the rest waits here (and
                    // claude's output in its pipe) until it can be written.
                    // Nothing is lost, and the reader carries on after.
                    state = self
                        .cond
                        .wait_timeout(state, Duration::from_secs(1))
                        .unwrap()
                        .0;
                }
            }
        }
        state.writing = false;
        state.size += data.len() as u64;
        self.cond.notify_all();
        state
    }

    fn mark<'a>(&'a self, state: MutexGuard<'a, State>, value: Value) -> MutexGuard<'a, State> {
        self.append(state, &compact(&value))
    }

    pub fn status(&self, state: &State) -> Map<String, Value> {
        let mut status = Map::new();
        status.insert("holder_id".into(), json!(self.id));
        status.insert("applied".into(), json!(state.applied));
        status.insert("child".into(), json!(state.number));
        status.insert(
            "child_alive".into(),
            json!(if state.proc.is_some() { 1 } else { 0 }),
        );
        status.insert("child_pid".into(), json!(state.pid));
        status.insert("log_size".into(), json!(state.size));
        status.insert("epoch_offset".into(), json!(state.epoch_offset));
        status
    }

    fn refuse<'a>(&'a self, state: MutexGuard<'a, State>, reason: &str) -> MutexGuard<'a, State> {
        self.mark(
            state,
            json!({"type": "roamgate_child", "event": "refused", "reason": reason}),
        )
    }

    fn start<'a>(
        self: &'a Arc<Self>,
        mut state: MutexGuard<'a, State>,
        command: &Map<String, Value>,
    ) -> MutexGuard<'a, State> {
        if state.closed {
            return state;
        }
        if state.proc.is_some() {
            return self.refuse(state, "a conversation process already runs");
        }
        let argv: Option<Vec<String>> =
            command
                .get("argv")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().map(str::to_owned))
                        .collect()
                });
        let Some(argv) = argv.filter(|argv| !argv.is_empty()) else {
            return self.refuse(state, "no command");
        };
        let mut env: Environ = std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        // The pane's names the headless claude keeps under other ones.
        if let Some(copy) = command.get("copy").and_then(Value::as_object) {
            for (name, alias) in copy {
                if let Some(alias) = alias.as_str()
                    && let Some(value) = env.get(name).cloned()
                {
                    env.insert(alias.to_owned(), value);
                }
            }
        }
        let mut drop: Vec<String> = command
            .get("drop")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(py_str).collect())
            .unwrap_or_default();
        if let Some(policy) = command.get("api_key").and_then(Value::as_object)
            && policy.get("policy").and_then(Value::as_str) == Some("claude_config")
        {
            let answer = policy.get("answer").and_then(Value::as_str);
            let answer_state = match answer {
                Some(answer @ ("approve" | "reject")) => {
                    // The user's answer, from the chat: filed as the TUI
                    // files it, and taken for this start even if it
                    // could not be.
                    if !record_api_key_answer(&env, answer == "approve") {
                        state = self.mark(
                            state,
                            json!({"type": "roamgate_child", "event": "api_key_unsaved"}),
                        );
                    }
                    state.api_key.seen = None;
                    if answer == "approve" {
                        "approved"
                    } else {
                        "rejected"
                    }
                    .to_owned()
                }
                _ => state.api_key.get(),
            };
            if answer_state == "new" {
                return self.refuse(state, "the API key question is not answered yet");
            }
            if answer_state == "approved" {
                drop.retain(|name| name != API_KEY);
            } else if !drop.iter().any(|name| name == API_KEY) {
                drop.push(API_KEY.to_owned());
            }
        }
        let prefixes: Vec<String> = command
            .get("drop_prefixes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        env.retain(|name, _| {
            !(drop.contains(name) || prefixes.iter().any(|prefix| name.starts_with(prefix)))
        });
        // A profile's removals: after the API key policy, so a profile with
        // its own token never sends the pane's key.
        if let Some(unset) = command.get("unset").and_then(Value::as_array) {
            for name in unset {
                env.remove(&py_str(name));
            }
        }
        if let Some(set) = command.get("set").and_then(Value::as_object) {
            for (name, value) in set {
                env.insert(name.clone(), py_str(value));
            }
        }
        let cwd = command
            .get("cwd")
            .filter(|value| truthy(Some(value)))
            .map(py_str)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|dir| dir.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
        let argv = new_or_resumed(&argv, &env, &cwd);
        let err = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(self.directory.join("err.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let spawned = Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(&cwd)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(err)
            .spawn();
        let mut process = match spawned {
            Ok(process) => process,
            Err(error) => {
                let filename = if Path::new(&cwd).is_dir() {
                    &argv[0]
                } else {
                    &cwd
                };
                let text = match error.raw_os_error() {
                    Some(_) => format!("{}: {}", py::os_error_text(&error), py::repr_str(filename)),
                    None => error.to_string(),
                };
                return self.refuse(state, &format!("claude did not start: {text}"));
            }
        };
        state.number += 1;
        state.epoch_offset = state.size;
        let number = state.number;
        let pid = process.id();
        state = self.mark(
            state,
            json!({"type": "roamgate_child", "event": "start", "child": number, "pid": pid}),
        );
        let stdout = process.stdout.take();
        let stdin = Arc::new(Mutex::new(process.stdin.take()));
        let process = Arc::new(Mutex::new(process));
        state.proc = Some(Proc {
            process: process.clone(),
            stdin,
            number,
        });
        state.pid = pid;
        let guarded = self.holder.guard(pid);
        state.stdin_open = true;
        let child = self.clone();
        std::thread::spawn(move || child.read(process, stdout, number, guarded));
        state
    }

    /// Without the lock: it is taken per line.
    fn read(
        self: Arc<Self>,
        process: Arc<Mutex<std::process::Child>>,
        stdout: Option<std::process::ChildStdout>,
        number: i64,
        guarded: Option<std::io::PipeWriter>,
    ) {
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if line.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let state = self.state.lock().unwrap();
                        drop(self.append(state, &line));
                    }
                    Err(_) => {
                        // Its output cannot be read any more: it is ended,
                        // so that Roamgate sees it exit instead of waiting
                        // on it for good.
                        let _ = process.lock().unwrap().kill();
                        break;
                    }
                }
            }
        }
        let code = wait(&process, None).unwrap_or(-1);
        release(guarded);
        let state = self.state.lock().unwrap();
        let mut state = self.mark(
            state,
            json!({"type": "roamgate_child", "event": "exit", "child": number, "code": code}),
        );
        if state
            .proc
            .as_ref()
            .is_some_and(|proc| proc.number == number)
        {
            state.proc = None;
            state.pid = 0;
            state.stdin_open = false;
        }
    }

    /// Notes the line; gives what to write to stdin (outside the lock).
    fn input<'a>(
        &'a self,
        state: MutexGuard<'a, State>,
        seq: i64,
        command: &Map<String, Value>,
    ) -> (MutexGuard<'a, State>, Option<StdinWrite>) {
        let line = command.get("line").and_then(Value::as_str);
        let kind = command
            .get("kind")
            .filter(|value| truthy(Some(value)))
            .cloned()
            .unwrap_or_else(|| json!("other"));
        let current = state.number;
        if state.proc.is_none()
            || !state.stdin_open
            || !equals_int(command.get("child"), current)
            || line.is_none()
        {
            let state = self.mark(
                state,
                json!({
                    "type": "roamgate_input",
                    "seq": seq,
                    "child": command.get("child").cloned().unwrap_or(Value::Null),
                    "kind": kind,
                    "dropped": true,
                }),
            );
            return (state, None);
        }
        let mut noted = Map::new();
        noted.insert("type".into(), json!("roamgate_input"));
        noted.insert("seq".into(), json!(seq));
        noted.insert("child".into(), json!(current));
        noted.insert("kind".into(), kind);
        if let Some(request) = command
            .get("request_id")
            .filter(|value| truthy(Some(value)))
        {
            noted.insert("request_id".into(), request.clone());
        }
        let state = self.mark(state, Value::Object(noted));
        let mut data = line.unwrap_or_default().as_bytes().to_vec();
        if !data.ends_with(b"\n") {
            data.push(b'\n');
        }
        let stdin = state.proc.as_ref().map(|proc| proc.stdin.clone());
        (state, stdin.map(|stdin| (stdin, data)))
    }

    /// Closes claude's stdin: it ends once it has answered.
    fn close_stdin(state: &mut State) {
        let Some(proc) = &state.proc else {
            return;
        };
        if !state.stdin_open {
            return;
        }
        state.stdin_open = false;
        proc.stdin.lock().unwrap().take();
    }

    /// Called by the polling thread only, so writes keep their order.
    pub fn apply(self: &Arc<Self>, commands: Option<&Value>) {
        let Some(Value::Array(commands)) = commands else {
            return;
        };
        let mut commands: Vec<&Map<String, Value>> =
            commands.iter().filter_map(Value::as_object).collect();
        commands.sort_by_key(|command| command.get("seq").and_then(Value::as_i64).unwrap_or(0));
        for command in commands {
            let Some(seq) = command.get("seq").and_then(Value::as_i64) else {
                continue;
            };
            let mut write = None;
            {
                let mut state = self.state.lock().unwrap();
                if seq <= state.applied {
                    continue;
                }
                let op = command.get("op").and_then(Value::as_str);
                let child = command.get("child");
                match op {
                    Some("start") => state = self.start(state, command),
                    Some("input") => {
                        let (next, to_write) = self.input(state, seq, command);
                        state = next;
                        write = to_write;
                    }
                    Some("end") if equals_int(child, state.number) => {
                        Self::close_stdin(&mut state);
                    }
                    Some("kill") if equals_int(child, state.number) => {
                        if let Some(proc) = &state.proc {
                            proc.kill();
                        }
                    }
                    _ => {}
                }
                state.applied = seq;
            }
            if let Some((stdin, data)) = write {
                let mut stdin = stdin.lock().unwrap();
                if let Some(pipe) = stdin.as_mut() {
                    // It is exiting: its exit line says so.
                    let _ = pipe.write_all(&data).and_then(|()| pipe.flush());
                }
            }
        }
    }

    /// Sends the log to Roamgate from where it asks, whole lines only.
    pub fn send_loop(self: Arc<Self>, pane: String) {
        loop {
            let (start, size) = {
                let mut state = self.state.lock().unwrap();
                while !state.closed && state.want.is_none_or(|want| want >= state.size as i64) {
                    state = self
                        .cond
                        .wait_timeout(state, Duration::from_secs(1))
                        .unwrap()
                        .0;
                }
                if state.closed {
                    return;
                }
                (state.want.unwrap_or(0) as u64, state.size)
            };
            let data = (|| -> std::io::Result<Vec<u8>> {
                let mut log = File::open(&self.path)?;
                log.seek(SeekFrom::Start(start))?;
                let mut data = vec![];
                log.take((size - start).min(CHUNK)).read_to_end(&mut data)?;
                if !data.ends_with(b"\n") {
                    match data.iter().rposition(|byte| *byte == b'\n') {
                        Some(cut) => data.truncate(cut + 1),
                        None => data = utf8_prefix(&data).to_vec(),
                    }
                }
                Ok(data)
            })();
            let Ok(data) = data else {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            };
            let mut body = Map::new();
            body.insert("pane".into(), json!(pane));
            body.insert("holder_id".into(), json!(self.id));
            body.insert("offset".into(), json!(start));
            body.insert("end".into(), json!(start + data.len() as u64));
            body.insert(
                "data".into(),
                json!(String::from_utf8_lossy(&data).into_owned()),
            );
            let reply = match post(&self.holder.socket, "hold_output", &body, 30) {
                Ok((200, reply)) => reply,
                Ok(_) | Err(_) => {
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            let offset = reply.get("offset").and_then(Value::as_i64);
            let mut state = self.state.lock().unwrap();
            state.want = offset.filter(|offset| *offset >= 0);
        }
    }

    /// Closes the child's stdin and waits for it, killing it if need be;
    /// false when there was none.
    pub fn end(&self, wait_for: Duration) -> bool {
        let process = {
            let mut state = self.state.lock().unwrap();
            let process = state.proc.as_ref().map(|proc| proc.process.clone());
            Self::close_stdin(&mut state);
            process
        };
        let Some(process) = process else {
            return false;
        };
        if wait(&process, Some(wait_for)).is_none() {
            let _ = process.lock().unwrap().kill();
            wait(&process, None);
        }
        true
    }

    /// Ends the child before claude resumes here: never both.
    pub fn stop(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.cond.notify_all();
        }
        if !self.end(STOP_WAIT) {
            return;
        }
        // Its reader notes the exit; then nothing reads the log any more.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.state.lock().unwrap().proc.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn alive(&self) -> bool {
        self.state.lock().unwrap().proc.is_some()
    }

    /// Kills the child (the pane closes), without the lock.
    pub fn kill_unlocked(&self) {
        if let Some(pid) = self.pid_unlocked() {
            sys::kill(pid);
        }
    }
}

/// Waits for the process to end, at most `limit`: its code as Python's
/// `returncode` (minus the signal that ended it), None on time out.
fn wait(process: &Arc<Mutex<std::process::Child>>, limit: Option<Duration>) -> Option<i64> {
    let deadline = limit.map(|limit| Instant::now() + limit);
    loop {
        match process.lock().unwrap().try_wait() {
            Ok(Some(status)) => return Some(returncode(status)),
            Ok(None) => {}
            Err(_) => return Some(-1),
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn returncode(status: std::process::ExitStatus) -> i64 {
    if let Some(code) = status.code() {
        return i64::from(code);
    }
    #[cfg(unix)]
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return -i64::from(signal);
    }
    -1
}

/// The child ended normally: its guard leaves.
fn release(guarded: Option<std::io::PipeWriter>) {
    if let Some(mut pipe) = guarded {
        let _ = pipe.write_all(b"x");
    }
}

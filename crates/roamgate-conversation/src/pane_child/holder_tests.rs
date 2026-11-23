//! holder-child.test.ts: the real roamgate-hold (contract/assets) in a
//! scratch HOME, its headless child a stand-in for claude, read through a
//! holder channel behind Roamgate's side of the agent socket.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::Notify;

use super::*;
use crate::driver::StartOptions;
use crate::holder_script::HOLD_CLIENT_SCRIPT;
use crate::testing::{claude_input_kind, test_drivers};
use crate::time::SystemClock;

/// A stand-in for claude: headless (-p), stream-json in and out, each user
/// message answered in a few lines, slowly, then a result.
const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
args = sys.argv[1:]
if "-p" not in args:
    print("claude " + " ".join(args))
    sys.exit(0)
def say(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()
say({"type": "system", "subtype": "init", "session_id": args[args.index("--resume") + 1]})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") != "user":
        say({"type": "echo", "of": message.get("type")})
        continue
    text = message["message"]["content"]
    say({"type": "user", "uuid": message.get("uuid"), "message": message["message"]})
    for index in range(int(os.environ.get("FAKE_STEPS", "3"))):
        time.sleep(float(os.environ.get("FAKE_STEP_S", "0.05")))
        say({"type": "step", "n": index, "of": text})
    say({"type": "result", "subtype": "success", "result": text})
time.sleep(0.3)
"#;

const PANE: &str = "w1:p1";
const SESSION: &str = "11111111-aaaa-bbbb-cccc-000000000000";

struct Server {
    channel: Mutex<HolderChannel>,
    down: Mutex<bool>,
    wake: Arc<Notify>,
}

fn channel(saved: Option<HolderSaved>, wake: Arc<Notify>) -> HolderChannel {
    HolderChannel::new(HolderChannelOptions {
        pane_id: PANE.into(),
        saved,
        on_work: Arc::new(move || wake.notify_waiters()),
        on_offset: None,
        on_pending: None,
        input_kind: Arc::new(claude_input_kind),
        log: None,
        clock: Arc::new(SystemClock),
    })
}

impl Server {
    fn channel(&self) -> HolderChannel {
        self.channel.lock().unwrap().clone()
    }

    /// A new runtime: it reads on from what the one before saved.
    fn swap(&self, resume: Option<HolderResume>) -> Option<HolderSaved> {
        let mut current = self.channel.lock().unwrap();
        let saved = current.save().map(|saved| HolderSaved {
            resume: resume.clone(),
            ..saved
        });
        current.detach();
        *current = channel(saved.clone(), self.wake.clone());
        saved
    }

    async fn answer(&self, command: &str, body: &str) -> (u16, Value) {
        if *self.down.lock().unwrap() {
            return (503, json!({"error": "not ready"}));
        }
        let Some(form) = Form::from_json(body) else {
            return (400, json!({"error": "invalid request"}));
        };
        let channel = self.channel();
        if command == "hold_output" {
            let answer = channel.receive(HolderOutput {
                holder_id: form.get("holder_id").unwrap_or(""),
                offset: js::number_from_text(form.get("offset").unwrap_or("")) as i64,
                end: js::number_from_text(form.get("end").unwrap_or("")) as i64,
                data: form.get("data").unwrap_or(""),
            });
            return (
                200,
                answer
                    .map(|offset| json!({"offset": offset}))
                    .unwrap_or(json!({})),
            );
        }
        if command == "handback" {
            return (200, json!({"action": "refused", "reason": "not now"}));
        }
        if let Some(status) = parse_holder_status(&form) {
            channel.update(status);
        }
        if !channel.has_work() {
            let woken = self.wake.notified();
            let _ = tokio::time::timeout(Duration::from_millis(150), woken).await;
        }
        let work = channel.work();
        let mut reply = json!({"action": "hold", "session_id": SESSION});
        if let Some(commands) = work.commands {
            reply["commands"] = Value::Array(commands.into_iter().map(Value::Object).collect());
        }
        if let Some(from) = work.output_from {
            reply["output_from"] = json!(from);
        }
        (200, reply)
    }
}

async fn serve_one(server: Arc<Server>, mut stream: tokio::net::UnixStream) {
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let (head_end, length) = loop {
        let Ok(read) = stream.read(&mut chunk).await else {
            return;
        };
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..at]).to_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            break (at + 4, length);
        }
    };
    while buffer.len() < head_end + length {
        let Ok(read) = stream.read(&mut chunk).await else {
            return;
        };
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("");
    let command = path.trim_start_matches("/v1/").to_owned();
    let body = String::from_utf8_lossy(&buffer[head_end..head_end + length]).into_owned();
    let (status, answer) = server.answer(&command, &body).await;
    let text = answer.to_string();
    let response = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

struct Scratch {
    _dir: tempfile::TempDir,
    dir: PathBuf,
    bin: PathBuf,
    work: PathBuf,
}

fn scratch() -> Scratch {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    let bin = dir.join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::fs::write(bin.join("claude"), FAKE_CLAUDE).unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("hold.py"), HOLD_CLIENT_SCRIPT).unwrap();
    let work = dir.join("work");
    std::fs::create_dir(&work).unwrap();
    // The session has a transcript: it is resumed (none: started anew).
    let projects = dir.join(".claude").join("projects").join("elsewhere");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::write(projects.join(format!("{SESSION}.jsonl")), "{}\n").unwrap();
    Scratch {
        _dir: temp,
        dir,
        bin,
        work,
    }
}

fn roamgate(dir: &Path) -> (Arc<Server>, PathBuf) {
    let socket = dir.join("r.sock");
    let wake = Arc::new(Notify::new());
    let server = Arc::new(Server {
        channel: Mutex::new(channel(None, wake.clone())),
        down: Mutex::new(false),
        wake,
    });
    let listener = UnixListener::bind(&socket).unwrap();
    let serving = server.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(serving.clone(), stream));
        }
    });
    (server, socket)
}

fn start_holder(scratch: &Scratch, socket: &Path, env: &[(&str, &str)]) -> tokio::process::Child {
    let mut command = tokio::process::Command::new("python3");
    command
        .arg(scratch.dir.join("hold.py"))
        .arg(SESSION)
        .current_dir(&scratch.dir)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", scratch.bin.display()))
        .env("HOME", &scratch.dir)
        .env("HERDR_PANE_ID", PANE)
        .env("ROAMGATE_REVIEW_SOCKET", socket)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    command.spawn().unwrap()
}

fn start_command(work: &Path) -> Obj {
    test_drivers()
        .of(None)
        .protocol
        .start_command(&StartOptions {
            session_id: SESSION.into(),
            cwd: work.to_string_lossy().into_owned(),
            ..StartOptions::default()
        })
}

fn start(work: &Path) -> HolderSpawn {
    HolderSpawn {
        command: start_command(work),
        attach_only: false,
        signal: None,
        timeout_ms: None,
    }
}

fn attach() -> HolderSpawn {
    HolderSpawn {
        command: Obj::new(),
        attach_only: true,
        signal: None,
        timeout_ms: None,
    }
}

fn user_line(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
}

/// Reads lines until one matches (or the output ends).
async fn read_until(
    child: &Arc<dyn HeadlessProcess>,
    into: &mut Vec<String>,
    done: impl Fn(&str) -> bool,
) {
    loop {
        let next = tokio::time::timeout(Duration::from_secs(20), child.next_line())
            .await
            .expect("a line in time");
        let Some(line) = next else {
            return;
        };
        let stop = done(&line);
        into.push(line);
        if stop {
            return;
        }
    }
}

fn steps(lines: &[String]) -> Vec<u64> {
    lines
        .iter()
        .filter(|line| line.contains("\"step\""))
        .map(|line| js::parse(line).unwrap()["n"].as_u64().unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reader_that_goes_mid_turn_loses_nothing_the_next_reads_each_line_once() {
    let scratch = scratch();
    let (rg, socket) = roamgate(&scratch.dir);
    let _holder = start_holder(
        &scratch,
        &socket,
        &[("FAKE_STEPS", "12"), ("FAKE_STEP_S", "0.1")],
    );
    let first = rg
        .channel()
        .spawn(start(&scratch.work))
        .await
        .unwrap()
        .unwrap();
    first.write(&user_line("long turn")).unwrap();
    let mut read = Vec::new();
    read_until(&first, &mut read, |line| line.contains("\"n\": 2")).await;
    // The link drops, and the runtime goes: the turn runs on.
    *rg.down.lock().unwrap() = true;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let saved = rg.swap(None);
    assert!(saved.unwrap().offset > 0);
    *rg.down.lock().unwrap() = false;
    let second = rg.channel().spawn(attach()).await.unwrap().unwrap();
    // Replayed: all the runtime before took from the holder.
    assert!(second.replayed() >= read.len());
    let mut again = Vec::new();
    read_until(&second, &mut again, |line| line.contains("\"result\"")).await;
    // The replayed head is what was read; the rest follows once each.
    assert_eq!(again[..read.len()], read[..]);
    assert_eq!(steps(&again), (0..12).collect::<Vec<_>>());
    assert!(again.last().unwrap().contains("\"result\""));
    assert_eq!(
        again
            .iter()
            .filter(|line| line.contains("\"result\""))
            .count(),
        1
    );
    second.end();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(20), second.exited())
            .await
            .unwrap(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reader_with_a_saved_state_takes_the_lines_after_it_only_each_once() {
    let scratch = scratch();
    let (rg, socket) = roamgate(&scratch.dir);
    let _holder = start_holder(
        &scratch,
        &socket,
        &[("FAKE_STEPS", "12"), ("FAKE_STEP_S", "0.1")],
    );
    let first = rg
        .channel()
        .spawn(start(&scratch.work))
        .await
        .unwrap()
        .unwrap();
    first.write(&user_line("long turn")).unwrap();
    let mut read = Vec::new();
    read_until(&first, &mut read, |line| line.contains("\"n\": 2")).await;
    // Asking for the next line marks the last one handled.
    let reader = first.clone();
    let pending = tokio::spawn(async move { reader.next_line().await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    let position = first.position().unwrap().unwrap();
    assert!(position.offset > position.epoch_offset);
    *rg.down.lock().unwrap() = true;
    tokio::time::sleep(Duration::from_millis(400)).await;
    rg.swap(Some(HolderResume {
        child: position.child,
        epoch_offset: position.epoch_offset,
        offset: position.offset,
        state: json!({"handled": read.len()}),
    }));
    pending.abort();
    *rg.down.lock().unwrap() = false;
    let second = rg.channel().spawn(attach()).await.unwrap().unwrap();
    assert_eq!(second.replayed(), 0);
    assert_eq!(second.resume(), Some(json!({"handled": read.len()})));
    let mut again = Vec::new();
    read_until(&second, &mut again, |line| line.contains("\"result\"")).await;
    // Nothing handled before comes again; every later step comes once.
    let all: Vec<String> = read.iter().chain(again.iter()).cloned().collect();
    assert_eq!(steps(&all), (0..12).collect::<Vec<_>>());
    assert_eq!(
        again
            .iter()
            .filter(|line| line.contains("\"result\""))
            .count(),
        1
    );
    second.end();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(20), second.exited())
            .await
            .unwrap(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_input_sent_twice_its_answer_lost_reaches_claude_once() {
    let scratch = scratch();
    let (rg, socket) = roamgate(&scratch.dir);
    let _holder = start_holder(&scratch, &socket, &[]);
    let child = rg
        .channel()
        .spawn(start(&scratch.work))
        .await
        .unwrap()
        .unwrap();
    // Unconfirmed when the runtime goes: the next sends it again.
    child.write(&user_line("once")).unwrap();
    let saved = rg.swap(None).unwrap();
    // The input at most once, and the start when the holder's ack of it is
    // still on its way.
    let ops: Vec<&str> = saved.pending.iter().map(command_op).collect();
    assert!(ops.iter().filter(|op| **op == "input").count() <= 1);
    assert!(ops.iter().all(|op| ["input", "start"].contains(op)));
    let again = rg.channel().spawn(attach()).await.unwrap().unwrap();
    let mut seen = Vec::new();
    read_until(&again, &mut seen, |line| line.contains("\"result\"")).await;
    again.end();
    tokio::time::timeout(Duration::from_secs(20), again.exited())
        .await
        .unwrap();
    let root = scratch.dir.join(".cache").join("roamgate").join("headless");
    let dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(dirs.len(), 1);
    let log = std::fs::read_to_string(dirs[0].join("out.jsonl")).unwrap();
    assert_eq!(log.matches("\"type\": \"user\"").count(), 1);
}

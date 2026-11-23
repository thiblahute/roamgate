//! The fakes themselves: what each one answers, without a server.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use roamgate_parity::fakes::herdr::{FakeHerdr, HerdrSeed};
use roamgate_parity::fakes::http::{self, FakeHttp};
use roamgate_parity::fakes::script::read_calls;
use roamgate_parity::fakes::{self, voice};
use roamgate_parity::http::{Request, Target, send};
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_parity-fake");

fn fake(dir: &Path, program: &str, args: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new(FAKE)
        .arg(program)
        .args(args)
        .env("PARITY_FAKES_DIR", dir)
        .env("PARITY_REMOTE_HOME", dir.join("remote"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn scripted_rules_answer_in_turn_and_every_call_is_logged() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("glab.json"),
        json!({"rules": [
            {"args_prefix": ["api", "graphql"], "times": 1, "stdout_json": {"data": {"first": true}}},
            {"args_prefix": ["api", "graphql"], "stderr": "HTTP 429 Retry-After: 30\n", "exit": 1},
        ]})
        .to_string(),
    )
    .unwrap();
    let first = fake(
        dir.path(),
        "glab",
        &["api", "graphql", "-f", "query=x"],
        b"",
    );
    assert_eq!(
        String::from_utf8_lossy(&first.stdout),
        "{\"data\":{\"first\":true}}\n"
    );
    let second = fake(
        dir.path(),
        "glab",
        &["api", "graphql", "-f", "query=x"],
        b"",
    );
    assert_eq!(second.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&second.stderr).contains("429"));
    let unscripted = fake(dir.path(), "glab", &["mr", "list"], b"");
    assert_eq!(unscripted.status.code(), Some(1));
    let calls = read_calls(dir.path());
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls.iter().map(|call| call.rule).collect::<Vec<_>>(),
        vec![Some(0), Some(1), None]
    );
}

#[test]
fn svc_tools_have_quiet_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let gamemode = fake(dir.path(), "gamemoded", &["-s"], b"");
    assert_eq!(
        String::from_utf8_lossy(&gamemode.stdout),
        "gamemode is inactive\n"
    );
    assert_eq!(
        fake(dir.path(), "systemctl", &["--user", "status", "x"], b"")
            .status
            .code(),
        Some(0)
    );
    let herdr = fake(dir.path(), "herdr", &["--version"], b"");
    assert!(String::from_utf8_lossy(&herdr.stdout).starts_with("herdr 0.9."));
}

#[test]
fn ssh_runs_remote_commands_locally_and_tracks_masters() {
    let dir = tempfile::tempdir().unwrap();
    let ran = fake(
        dir.path(),
        "ssh",
        &[
            "-T",
            "-o",
            "BatchMode=yes",
            "host",
            "printf",
            "%s",
            "\"$HOME\"",
        ],
        b"",
    );
    assert_eq!(ran.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&ran.stdout),
        dir.path().join("remote").to_string_lossy()
    );
    let control = dir.path().join("control");
    let control_text = control.to_string_lossy().into_owned();
    let check = fake(
        dir.path(),
        "ssh",
        &["-S", &control_text, "-O", "check", "host"],
        b"",
    );
    assert_eq!(check.status.code(), Some(255));
    let mut master = Command::new(FAKE)
        .args(["ssh", "-M", "-N", "-S", &control_text, "host"])
        .env("PARITY_FAKES_DIR", dir.path())
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if control.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let check = fake(
        dir.path(),
        "ssh",
        &["-S", &control_text, "-O", "check", "host"],
        b"",
    );
    assert_eq!(check.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&check.stderr).starts_with("Master running"));
    let exit = fake(
        dir.path(),
        "ssh",
        &["-S", &control_text, "-O", "exit", "host"],
        b"",
    );
    assert_eq!(exit.status.code(), Some(0));
    master.kill().unwrap();
    master.wait().unwrap();
    std::fs::write(
        dir.path().join("ssh.json"),
        json!({"rules": [{"args_match": "refused", "stderr": "ssh: connect to host h port 22: Connection refused\n", "exit": 255}]}).to_string(),
    )
    .unwrap();
    let refused = fake(dir.path(), "ssh", &["h", "refused"], b"");
    assert_eq!(refused.status.code(), Some(255));
}

#[test]
fn claude_streams_and_answers_the_control_protocol() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("claude.json"),
        json!({
            "turns": [[
                {"type": "system", "subtype": "init", "session_id": "{{session_id}}"},
                {"type": "result", "subtype": "success", "result": "hi", "session_id": "{{session_id}}"}
            ]],
            "control": {"initialize": {"models": ["opus"]}}
        })
        .to_string(),
    )
    .unwrap();
    let input = b"{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"initialize\"}}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";
    let output = fake(
        dir.path(),
        "claude",
        &[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--resume",
            "abc",
        ],
        input,
    );
    let lines: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["response"]["request_id"], "r1");
    assert_eq!(lines[0]["response"]["response"]["models"][0], "opus");
    assert_eq!(lines[1]["session_id"], "abc");
    assert_eq!(lines[2]["result"], "hi");
}

#[test]
fn the_voice_helper_answers_frames_and_starts_signalling() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("roamgate-voice.json"),
        json!({"replies": {"speak": [{"event": "speak_progress", "id": 9}, {"done": true}]}})
            .to_string(),
    )
    .unwrap();
    let mut input = voice::encode(voice::JSON, br#"{"op":"ping","id":1}"#);
    input.extend(voice::encode(
        voice::JSON,
        br#"{"op":"call_start","id":2,"call":4}"#,
    ));
    input.extend(voice::encode(voice::JSON, br#"{"op":"speak","id":3}"#));
    let output = fake(dir.path(), "roamgate-voice", &[], &input);
    let mut reader = output.stdout.as_slice();
    let mut replies = Vec::new();
    while let Some((kind, payload)) = voice::read(&mut reader).unwrap() {
        assert_eq!(kind, voice::JSON);
        replies.push(serde_json::from_slice::<Value>(&payload).unwrap());
    }
    assert_eq!(replies[0], json!({"id": 1, "ok": true}));
    assert!(replies[1]["signalling_port"].as_u64().unwrap() > 0);
    assert_eq!(replies[2]["event"], "speak_progress");
    assert_eq!(replies[3], json!({"id": 3, "ok": true, "done": true}));
}

#[test]
fn the_voice_helper_times_its_frames_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("roamgate-voice.json"),
        json!({"timestamps": true}).to_string(),
    )
    .unwrap();
    let input = voice::encode(voice::JSON, br#"{"op":"ping","id":1}"#);
    let output = fake(dir.path(), "roamgate-voice", &[], &input);
    assert!(output.status.success());
    let log = std::fs::read_to_string(dir.path().join("roamgate-voice.frames.jsonl")).unwrap();
    let lines: Vec<Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["op"], "ping");
    assert_eq!(lines[1]["sent"], json!({"id": 1, "ok": true}));
    assert_eq!(lines[2]["eof"], true);
    let times: Vec<u64> = lines
        .iter()
        .map(|line| line["at_us"].as_u64().unwrap())
        .collect();
    assert!(times[0] > 0 && times.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(lines.iter().all(|line| line["pid"] == lines[0]["pid"]));
}

#[tokio::test]
async fn herdr_answers_on_its_own_types_and_refuses_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let seed: HerdrSeed = serde_json::from_value(json!({
        "workspaces": [{"workspace_id": "w1", "label": "one"}],
        "panes": [{"pane_id": "p1", "cwd": "/x"}],
    }))
    .unwrap();
    let herdr = FakeHerdr::start(dir.path(), &seed).await.unwrap();
    let ask = |line: &'static str| {
        let path = herdr.control.clone();
        async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let stream = tokio::net::UnixStream::connect(path).await.unwrap();
            let (read, mut write) = stream.into_split();
            write.write_all(line.as_bytes()).await.unwrap();
            let mut reply = String::new();
            BufReader::new(read).read_line(&mut reply).await.unwrap();
            serde_json::from_str::<Value>(&reply).unwrap()
        }
    };
    let pong = ask("{\"id\":\"1\",\"method\":\"ping\",\"params\":{}}\n").await;
    assert_eq!(pong["result"]["type"], "pong");
    assert_eq!(pong["result"]["protocol"], 22);
    let panes =
        ask("{\"id\":\"2\",\"method\":\"pane.list\",\"params\":{\"workspace_id\":\"w1\"}}\n").await;
    assert_eq!(panes["result"]["panes"][0]["pane_id"], "p1");
    assert_eq!(panes["result"]["panes"][0]["tab_id"], "w1:t1");
    let bad = ask("{\"id\":\"3\",\"method\":\"workspace.get\",\"params\":{}}\n").await;
    assert_eq!(bad["error"]["code"], "invalid_request");
    let calls = herdr.calls();
    assert_eq!(calls.iter().filter(|call| !call.valid).count(), 1);
    assert!(herdr.emit(&json!({"event": "nope", "data": {}})).is_err());
}

#[tokio::test]
async fn models_serve_ranges_and_push_decrypts_with_vapid() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("model.bin"), b"0123456789").unwrap();
    let server = FakeHttp::start(dir.path().to_path_buf(), Value::Null)
        .await
        .unwrap();
    let address = server.base.trim_start_matches("http://").to_owned();
    let ranged = send(
        &Target::Tcp(address.clone()),
        &Request {
            method: "GET".into(),
            path: "/files/model.bin".into(),
            headers: vec![("range".into(), "bytes=2-5".into())],
            body: Vec::new(),
        },
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert_eq!(ranged.status, 206);
    assert_eq!(ranged.body, b"2345");
    assert_eq!(ranged.header("content-range"), Some("bytes 2-5/10"));
    assert_eq!(http::parse_range("bytes=-3", 10), Some((7, 9)));

    // A push as a sender would make it: encrypted to the subscription,
    // signed with a VAPID key.
    let subscription = server.subscribe("s1");
    let sender = p256::SecretKey::from_slice(&[7u8; 32]).unwrap();
    let body = http::encrypt(
        &subscription.public_key(),
        &subscription.auth,
        &sender,
        [3u8; 16],
        br#"{"title":"Done"}"#,
    )
    .unwrap();
    let vapid = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        json!({"aud": server.base, "exp": 4102444800u64, "sub": "mailto:parity@example.invalid"})
            .to_string(),
    );
    let signed = format!("{header}.{claims}");
    let signature: Signature = vapid.sign(signed.as_bytes());
    let key = URL_SAFE_NO_PAD.encode(vapid.verifying_key().to_encoded_point(false).as_bytes());
    let authorization = format!(
        "vapid t={signed}.{}, k={key}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    let response = send(
        &Target::Tcp(address),
        &Request {
            method: "POST".into(),
            path: "/push/s1".into(),
            headers: vec![
                ("content-encoding".into(), "aes128gcm".into()),
                ("ttl".into(), "60".into()),
                ("authorization".into(), authorization),
            ],
            body,
        },
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert_eq!(response.status, 201);
    let pushes = server.pushes();
    assert_eq!(pushes[0].payload, json!({"title": "Done"}));
    assert_eq!(
        pushes[0].vapid_subject.as_deref(),
        Some("mailto:parity@example.invalid")
    );
}

#[test]
fn every_program_is_linked() {
    let dir = tempfile::tempdir().unwrap();
    fakes::install(Path::new(FAKE), dir.path()).unwrap();
    for (_, programs) in fakes::COMMAND_FAKES {
        for program in *programs {
            assert!(dir.path().join(fakes::exe(program)).exists(), "{program}");
        }
    }
}

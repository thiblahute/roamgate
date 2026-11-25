//! contract/vectors/agent-client.json: the Rust `roamgate-review` reads
//! each command line as the Python client does, sends the same requests
//! and prints the same output.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Duration;

use roamgate_agent_client::http::{Response, Unreachable};
use roamgate_agent_client::review::{Env, Transport, run};
use serde_json::Value;

struct Fake {
    socket: String,
    exists: bool,
    reply: Value,
    requests: RefCell<Vec<Value>>,
}

impl Transport for Fake {
    fn exists(&self, socket: &str) -> bool {
        socket == self.socket && self.exists
    }

    fn post(
        &self,
        _socket: &str,
        command: &str,
        body: &str,
        timeout: Duration,
    ) -> Result<Response, Unreachable> {
        self.requests.borrow_mut().push(serde_json::json!({
            "command": command,
            "body": body,
            "timeout": timeout.as_secs(),
        }));
        if self.reply.get("unreachable").is_some() {
            return Err(Unreachable("[Errno 111] Connection refused".into()));
        }
        Ok(Response {
            status: self.reply["status"].as_u64().unwrap() as u16,
            body: self.reply["body"].as_str().unwrap().as_bytes().to_vec(),
        })
    }
}

/// The cases whose arguments are POSIX absolute paths.
const POSIX_PATH_CASES: &[&str] = &["open a range with repos", "place path"];

#[test]
fn the_rust_client_does_what_the_python_one_does() {
    let doc = roamgate_protocol::vectors::load_raw("agent-client");
    let socket = doc["socket"].as_str().unwrap().to_owned();
    let mut failures = vec![];
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // The Python client was recorded on a POSIX host: there /nonexistent/a
        // is absolute, on Windows realpath puts it on the drive, as Python's
        // own os.path.realpath does.
        if cfg!(windows) && POSIX_PATH_CASES.contains(&name) {
            continue;
        }
        let mut vars: BTreeMap<String, String> = BTreeMap::from([
            ("ROAMGATE_REVIEW_SOCKET".into(), socket.clone()),
            ("COLUMNS".into(), "80".into()),
            ("HOME".into(), "/home/agent".into()),
        ]);
        if let Some(env) = case.get("env").and_then(Value::as_object) {
            for (key, value) in env {
                vars.insert(key.clone(), value.as_str().unwrap().to_owned());
            }
        }
        let env = Env {
            vars: Box::new(move |name| vars.get(name).cloned()),
            cwd: "/".into(),
        };
        let fake = Fake {
            socket: socket.clone(),
            exists: case
                .get("socket_exists")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            reply: case
                .get("reply")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"status": 200, "body": "{\"ok\": true}"})),
            requests: RefCell::new(vec![]),
        };
        let args: Vec<String> = case["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap().to_owned())
            .collect();
        let input = case
            .get("stdin")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mut stdin = move || input.clone();
        let outcome = run(&args, &env, &fake, &mut stdin);
        let got = serde_json::json!({
            "requests": fake.requests.into_inner(),
            "exit": outcome.code,
            "stdout": outcome.stdout,
            "stderr": outcome.stderr,
        });
        if got != case["expect"] {
            failures.push(format!(
                "{name}:\n  want {}\n  got  {}",
                case["expect"], got
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// contract/vectors/claude-start-hook.json: the server's installer of the
/// claude start hook leaves Claude's settings as the Python one does.
#[test]
fn the_hook_installer_does_what_the_python_one_does() {
    let doc = roamgate_protocol::vectors::load_raw("claude-start-hook");
    let mut failures = vec![];
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude = roamgate_agent_client::hook_install::claude_dir(home.path(), None);
        if case["claude_dir"].as_bool().unwrap() {
            std::fs::create_dir(&claude).unwrap();
            if let Some(text) = case["settings"].as_str() {
                std::fs::write(claude.join("settings.json"), text).unwrap();
            }
        }
        let outcome = roamgate_agent_client::hook_install::install(&claude);
        let after = std::fs::read_to_string(claude.join("settings.json")).ok();
        let got = serde_json::json!({"outcome": outcome, "after": after});
        let want = serde_json::json!({"outcome": case["outcome"], "after": case["after"]});
        if got != want {
            failures.push(format!("{name}:\n  want {want}\n  got  {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

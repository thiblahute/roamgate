//! T1 and T2 scenarios: YAML files under `parity/scenarios/<family>/`.
//!
//! ```yaml
//! name: settings change reaches every browser
//! family: settings            # the contract family it covers
//! tier: T1                    # T1 (fakes) or T2 (real tools)
//! ledger: [server/src/x.test.ts > old test name]   # old tests it replaces
//! covers: [rpc:settings.set]  # contract entries beyond what steps name
//! server:
//!   env: {ROAMGATE_X: "1"}
//!   herdr: {workspaces: [{workspace_id: w1}]}   # or false: no Herdr
//!   epoch: 1767225600000       # the test clock's start
//!   files: {".config/roamgate/settings.json": {json: {...}}}
//!   fakes: {glab: {rules: [...]}}
//!   start: true                # false: start with a `start` step
//! contract_exceptions: [{surface: rpc.request, name: x, reason: ...}]
//! steps:
//!   - login: {}
//!   - connect: {}
//!   - call: settings.get
//!     reply: {...}
//! ```
//!
//! Strings in steps may name `${ROOT}`, `${HOME}`, `${DATA}`, `${BASE}`,
//! `${ADDRESS}`, `${FAKE_HTTP}`, `${REPO}`, `${PASSWORD}` and every value a
//! step saved (`save: {name: /json/pointer}`); a string that is only
//! `${name}` becomes the saved value itself. See `matcher.rs` for what an
//! expected value may say, and each step's function below for its keys.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::fakes::herdr::HerdrSeed;
use crate::http::{self, Request, Target};
use crate::matcher;
use crate::normalize::Normalizers;
use crate::paths::{contract_dir, repo_root};
use crate::record::{self, Exception};
use crate::run::{Run, RunOptions, SeedFile};
use crate::ws::{Connect, Incoming, Socket, push_name};

/// How long a step waits for what it expects (real time: a fake or the
/// server doing real I/O; the server's own timers wait for `advance`).
pub const WAIT: Duration = Duration::from_secs(10);
/// How long `expect_log` waits for its lines when the step gives no
/// `within_ms`.
pub const LOG_GRACE: Duration = Duration::from_secs(5);

/// Why the server log does not pass an `expect_log`: a line not there yet
/// (it may still come) or one that is, or a wrong step.
enum LogMismatch {
    Missing(anyhow::Error),
    Wrong(anyhow::Error),
}

impl LogMismatch {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Missing(error) | Self::Wrong(error) => error,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    /// The file's name without `.yaml` (set by `load`).
    #[serde(skip)]
    pub file_stem: String,
    pub name: String,
    pub family: String,
    #[serde(default = "default_tier")]
    pub tier: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub ledger: Vec<String>,
    #[serde(default)]
    pub covers: Vec<String>,
    #[serde(default)]
    pub server: ServerSpec,
    #[serde(default)]
    pub contract_exceptions: Vec<Exception>,
    /// Platforms it runs on (linux, macos, windows); all when empty.
    #[serde(default)]
    pub platforms: Vec<String>,
    pub steps: Vec<Value>,
}

fn default_tier() -> String {
    "T1".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSpec {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// A Herdr session, `false` for none; default: an empty session.
    #[serde(default)]
    pub herdr: Option<Value>,
    /// More fake Herdrs by id (run.rs RunOptions::herdrs).
    #[serde(default)]
    pub herdrs: BTreeMap<String, Value>,
    #[serde(default)]
    /// Epoch milliseconds, or `now` (the real time at the start: for
    /// cases comparing the clock with real file times).
    pub epoch: Option<Value>,
    #[serde(default)]
    pub files: BTreeMap<String, Value>,
    #[serde(default)]
    pub fakes: BTreeMap<String, Value>,
    #[serde(default)]
    pub openai: Option<Value>,
    #[serde(default)]
    pub served: BTreeMap<String, String>,
    /// The login password; `null` for none (the server makes a token).
    #[serde(default = "default_password")]
    pub password: Option<String>,
    #[serde(default)]
    pub start: Option<bool>,
    /// The server to run: `standalone` (the release binary of this
    /// checkout, built once, build.rs), or a command line (`${REPO}` named
    /// in it); default `ROAMGATE_SERVER_CMD`.
    #[serde(default)]
    pub command: Option<String>,
    /// Whether the test clock is on (default true; a release build refuses
    /// it).
    #[serde(default)]
    pub clock: Option<bool>,
    /// Arguments after the server command (`--public-dir ...`).
    #[serde(default)]
    pub args: Vec<String>,
    /// The server's working directory (`${ROOT}`, `${HOME}`); default the
    /// repository.
    #[serde(default)]
    pub cwd: Option<String>,
}

impl Default for ServerSpec {
    fn default() -> Self {
        ServerSpec {
            env: BTreeMap::new(),
            herdr: None,
            herdrs: BTreeMap::new(),
            epoch: None,
            files: BTreeMap::new(),
            fakes: BTreeMap::new(),
            openai: None,
            served: BTreeMap::new(),
            password: default_password(),
            start: None,
            command: None,
            clock: None,
            args: Vec::new(),
            cwd: None,
        }
    }
}

fn default_password() -> Option<String> {
    Some(crate::run::PASSWORD.to_owned())
}

pub fn load(path: &Path) -> Result<Scenario> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| path.display().to_string())?;
    let json = serde_json::to_value(value)?;
    let mut scenario: Scenario = serde_json::from_value(json)
        .with_context(|| format!("{}: not a scenario", path.display()))?;
    scenario.file_stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(scenario)
}

/// Every scenario file, sorted.
pub fn all(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "yaml" || extension == "yml")
        })
        .map(|entry| entry.into_path())
        .collect();
    files.sort();
    files
}

fn seed_file(path: &str, spec: &Value) -> Result<SeedFile> {
    let (content, mode) = match spec {
        Value::String(text) => (text.clone().into_bytes(), None),
        Value::Object(map) => {
            let content = if let Some(json) = map.get("json") {
                format!("{}\n", serde_json::to_string_pretty(json)?).into_bytes()
            } else if let Some(text) = map.get("text").and_then(Value::as_str) {
                text.as_bytes().to_vec()
            } else if let Some(lines) = map.get("jsonl").and_then(Value::as_array) {
                lines
                    .iter()
                    .map(|line| format!("{line}\n"))
                    .collect::<String>()
                    .into_bytes()
            } else {
                bail!("file {path}: give json, jsonl or text");
            };
            let mode = map
                .get("mode")
                .and_then(Value::as_str)
                .map(|mode| u32::from_str_radix(mode.trim_start_matches("0o"), 8))
                .transpose()?;
            (content, mode)
        }
        _ => bail!("file {path}: give a string or {{json|text, mode}}"),
    };
    Ok(SeedFile {
        path: path.to_owned(),
        content,
        mode,
    })
}

/// The run options a scenario asks for.
pub fn options(scenario: &Scenario) -> Result<RunOptions> {
    let mut options = RunOptions {
        env: scenario.server.env.clone(),
        password: scenario.server.password.clone(),
        ..RunOptions::default()
    };
    match &scenario.server.epoch {
        None => {}
        Some(Value::String(word)) if word == "now" => {
            options.epoch_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or(crate::run::DEFAULT_EPOCH_MS);
        }
        Some(value) => {
            options.epoch_ms = value
                .as_i64()
                .context("server.epoch: milliseconds or now")?;
        }
    }
    options.herdr = match &scenario.server.herdr {
        None => Some(HerdrSeed::default()),
        Some(Value::Bool(false)) => None,
        Some(seed) => Some(serde_json::from_value(seed.clone()).context("server.herdr")?),
    };
    for (id, seed) in &scenario.server.herdrs {
        options.herdrs.insert(
            id.clone(),
            serde_json::from_value(seed.clone()).with_context(|| format!("server.herdrs.{id}"))?,
        );
    }
    for (path, spec) in &scenario.server.files {
        options.files.push(seed_file(path, spec)?);
    }
    options.fakes = scenario.server.fakes.clone();
    options.openai = scenario.server.openai.clone().unwrap_or(Value::Null);
    options.served = scenario
        .server
        .served
        .iter()
        .map(|(path, text)| (path.clone(), text.clone().into_bytes()))
        .collect();
    options.clock = scenario.server.clock.unwrap_or(true);
    let repo = repo_root().to_string_lossy().into_owned();
    let command: Option<Vec<String>> = match scenario.server.command.as_deref() {
        None if scenario.server.args.is_empty() && scenario.server.cwd.is_none() => None,
        None => Some(crate::run::server_command().0),
        Some("standalone") => Some(vec![
            crate::build::standalone()?.to_string_lossy().into_owned(),
        ]),
        Some(line) => Some(
            line.split_whitespace()
                .map(|word| word.replace("${REPO}", &repo))
                .collect(),
        ),
    };
    options.command = command.map(|mut command| {
        command.extend(scenario.server.args.iter().cloned());
        (
            command,
            scenario.server.cwd.clone().unwrap_or_else(|| repo.clone()),
        )
    });
    Ok(options)
}

/// The state of a scenario being run.
pub struct Runner {
    pub run: Run,
    pub vars: BTreeMap<String, Value>,
    sockets: BTreeMap<String, Socket>,
    /// The arrival number of the last push each socket's ordered
    /// expectations consumed.
    order: BTreeMap<String, u64>,
    next_id: u64,
    normalizers: Normalizers,
    /// Where this scenario's goldens are: contract/golden/<family>/<file>/.
    golden_dir: PathBuf,
    /// Processes started with `spawn` (a pane's holder): their stdin, and
    /// their exit with their output once `wait_process` asks.
    processes: BTreeMap<String, Spawned>,
    /// Scripted agent sockets (`serve_agent_socket`), by name.
    agent_sockets: BTreeMap<String, crate::fakes::agent_socket::FakeAgentSocket>,
    /// HTTP requests sent with `no_wait: <name>`, answered later.
    pending_http: BTreeMap<String, (String, tokio::task::JoinHandle<Result<http::Response>>)>,
}

fn str_of(value: &Value) -> Option<&str> {
    value.as_str()
}

fn get<'a>(step: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    step.get(key)
}

fn names(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(name)) => vec![name.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn duration(step: &Map<String, Value>) -> Duration {
    step.get("within_ms")
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
        .unwrap_or(WAIT)
}

impl Runner {
    pub async fn new(fake_bin: &Path, scenario: &Scenario) -> Result<Runner> {
        let mut run = Run::new(fake_bin, options(scenario)?).await?;
        let family = owner_family(&scenario.family);
        run.wait_for_core = crate::run::rust_owners().iter().any(|name| name == family);
        let mut runner = Runner {
            run,
            vars: BTreeMap::new(),
            sockets: BTreeMap::new(),
            order: BTreeMap::new(),
            next_id: 0,
            normalizers: Normalizers::load(&contract_dir())?,
            pending_http: BTreeMap::new(),
            processes: BTreeMap::new(),
            agent_sockets: BTreeMap::new(),
            golden_dir: contract_dir()
                .join("golden")
                .join(&scenario.family)
                .join(&scenario.file_stem),
        };
        runner.refresh_vars();
        Ok(runner)
    }

    fn refresh_vars(&mut self) {
        let text = |path: &Path| Value::String(path.to_string_lossy().into_owned());
        self.vars.insert("ROOT".into(), text(&self.run.root));
        self.vars.insert("HOME".into(), text(&self.run.home));
        self.vars.insert("DATA".into(), text(&self.run.data_root()));
        self.vars.insert("REPO".into(), text(&repo_root()));
        for (id, herdr) in &self.run.herdrs {
            self.vars
                .insert(format!("HERDR_{id}_CONTROL"), text(&herdr.control));
            self.vars
                .insert(format!("HERDR_{id}_CLIENT"), text(&herdr.client));
        }
        self.vars.insert(
            "FAKE_HTTP".into(),
            Value::String(self.run.http.base.clone()),
        );
        if let Some(password) = &self.run.password {
            self.vars
                .insert("PASSWORD".into(), Value::String(password.clone()));
        }
        if let Ok(base) = self.run.base() {
            self.vars.insert("BASE".into(), Value::String(base));
        }
        if let Ok(address) = self.run.address() {
            self.vars.insert("ADDRESS".into(), Value::String(address));
        }
    }

    /// `${name}` replaced in every string of a value.
    pub fn interpolate(&self, value: &Value) -> Result<Value> {
        let pattern = Regex::new(r"\$\{([A-Za-z0-9_.-]+)\}").expect("regex");
        Ok(match value {
            Value::String(text) => {
                if let Some(found) = pattern.captures(text)
                    && found.get(0).map(|whole| whole.as_str()) == Some(text.as_str())
                {
                    return self
                        .vars
                        .get(&found[1])
                        .cloned()
                        .ok_or_else(|| anyhow!("no value named ${{{}}}", &found[1]));
                }
                let mut missing = None;
                let replaced = pattern.replace_all(text, |found: &regex::Captures| {
                    match self.vars.get(&found[1]) {
                        Some(Value::String(text)) => text.clone(),
                        Some(other) => other.to_string(),
                        None => {
                            missing = Some(found[1].to_owned());
                            String::new()
                        }
                    }
                });
                if let Some(name) = missing {
                    bail!("no value named ${{{name}}}");
                }
                Value::String(replaced.into_owned())
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.interpolate(item))
                    .collect::<Result<_>>()?,
            ),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| Ok((key.clone(), self.interpolate(item)?)))
                    .collect::<Result<_>>()?,
            ),
            other => other.clone(),
        })
    }

    fn path(&self, value: &Value) -> Result<PathBuf> {
        let text = str_of(value).context("a path")?;
        let path = PathBuf::from(text);
        Ok(if path.is_absolute() {
            path
        } else {
            self.run.home.join(path)
        })
    }

    /// Checks `actual` against `expected` after the step's normalizers.
    fn expect(
        &self,
        what: &str,
        step: &Map<String, Value>,
        expected: &Value,
        actual: Option<&Value>,
    ) -> Result<()> {
        let normalizers = names(get(step, "normalize"));
        let actual = match actual {
            Some(value) => Some(
                self.normalizers
                    .apply(&normalizers, value, &self.run.paths())?,
            ),
            None => None,
        };
        matcher::check(expected, actual.as_ref())
            .map_err(|difference| anyhow!("{what}: {difference}"))
    }

    /// `golden: <name>`: the step's outcome, normalized by the step's
    /// `normalize` list, must equal contract/golden/<family>/<scenario>/
    /// <name>.json (recorded from Bun with PARITY_UPDATE_GOLDEN=1, then
    /// reviewed). The outcome is the reply without its id (`call`,
    /// `await`), the status and body (`http`, `agent`), the exit code and
    /// output (`cli`, `client`, `sh`), the value (`assert_file`,
    /// `assert_rows`, `assert_refs`, pushes).
    fn golden(&self, step: &Map<String, Value>, value: &Value) -> Result<()> {
        let Some(name) = get(step, "golden").and_then(Value::as_str) else {
            return Ok(());
        };
        let mut outcome = value.clone();
        if let Value::Object(map) = &mut outcome {
            map.remove("id");
            map.remove("headers");
            map.remove("cookie");
            if map.get("json").is_some_and(|json| !json.is_null()) {
                map.remove("text");
                map.remove("stdout");
            } else {
                map.remove("json");
            }
        }
        let normalizers = names(get(step, "normalize"));
        let outcome = self
            .normalizers
            .apply(&normalizers, &outcome, &self.run.paths())?;
        let path = self.golden_dir.join(format!("{name}.json"));
        let text = format!("{}\n", serde_json::to_string_pretty(&outcome)?);
        if std::env::var("PARITY_UPDATE_GOLDEN").is_ok_and(|value| value == "1") {
            std::fs::create_dir_all(&self.golden_dir)?;
            std::fs::write(&path, text)?;
            return Ok(());
        }
        let wanted = std::fs::read_to_string(&path).with_context(|| {
            format!(
                "no golden {} (record it with PARITY_UPDATE_GOLDEN=1 and review it)",
                path.display()
            )
        })?;
        let wanted: Value = serde_json::from_str(&wanted)?;
        if wanted != outcome {
            bail!(
                "golden {name} differs ({}):\n--- golden\n{}\n--- actual\n{}",
                path.display(),
                serde_json::to_string_pretty(&wanted)?,
                serde_json::to_string_pretty(&outcome)?
            );
        }
        Ok(())
    }

    fn save(&mut self, step: &Map<String, Value>, value: &Value) -> Result<()> {
        self.golden(step, value)?;
        if let Some(Value::Object(saves)) = get(step, "save") {
            for (name, pointer) in saves {
                let pointer = str_of(pointer).context("save: a JSON pointer")?;
                let found = select(value, pointer)
                    .ok_or_else(|| anyhow!("save {name}: nothing at {pointer} in {value}"))?;
                self.vars.insert(name.clone(), found);
            }
        }
        Ok(())
    }

    fn socket<'a>(&'a self, step: &'a Map<String, Value>) -> Result<(&'a str, &'a Socket)> {
        let name = get(step, "socket")
            .and_then(Value::as_str)
            .unwrap_or("main");
        let socket = self
            .sockets
            .get(name)
            .ok_or_else(|| anyhow!("no socket named {name} (connect first)"))?;
        Ok((name, socket))
    }

    pub async fn start(&mut self) -> Result<()> {
        self.run.start().await?;
        self.refresh_vars();
        Ok(())
    }

    /// Runs one step (already interpolated).
    pub async fn step(&mut self, step: &Value) -> Result<()> {
        let step = step.as_object().context("a step is a map")?.clone();
        let kind = [
            "login",
            "connect",
            "call",
            "send",
            "expect_push",
            "expect_pushes",
            "expect_no_push",
            "drain",
            "expect_close",
            "close",
            "http",
            "agent",
            "client",
            "cli",
            "advance",
            "expect_now",
            "herdr_emit",
            "herdr_seed",
            "herdr_notify",
            "herdr_endpoint",
            "herdr_calls",
            "fake_calls",
            "http_fake_calls",
            "push_subscription",
            "pushes",
            "write",
            "assert_file",
            "assert_rows",
            "assert_refs",
            "assert_absent",
            "restart",
            "stop",
            "start",
            "expect_log",
            "wait_file",
            "sh",
            "set",
            "print",
            "print_pushes",
            "await",
            "await_http",
            "spawn",
            "serve_agent_socket",
            "pane_type",
            "pane_signal",
            "process_gone",
            "agent_socket_requests",
            "stop_agent_socket",
            "write_stdin",
            "wait_process",
        ]
        .into_iter()
        .find(|kind| step.contains_key(*kind))
        .ok_or_else(|| anyhow!("unknown step {}", Value::Object(step.clone())))?;
        match kind {
            "login" => self.login(&step).await,
            "connect" => self.connect(&step).await,
            "call" => self.call(&step).await,
            "send" => self.send(&step),
            "expect_push" => self.expect_push(&step).await,
            "expect_pushes" => self.expect_pushes(&step).await,
            "expect_no_push" => self.expect_no_push(&step).await,
            "drain" => {
                let (_, socket) = self.socket(&step)?;
                socket.drain().await;
                Ok(())
            }
            "expect_close" => self.expect_close(&step).await,
            "close" => {
                let (_, socket) = self.socket(&step)?;
                socket.close();
                Ok(())
            }
            "http" => self.http(&step).await,
            "agent" => self.agent(&step).await,
            "client" => self.client(&step).await,
            "cli" => self.cli(&step).await,
            "advance" => {
                let ms = get(&step, "advance")
                    .and_then(Value::as_u64)
                    .context("advance: milliseconds")?;
                let now = self.run.clock().advance(ms).await?;
                self.vars.insert("NOW".into(), json!(now));
                Ok(())
            }
            "expect_now" => {
                let now = self.run.clock().now().await?;
                self.expect("test clock", &step, &step["expect_now"], Some(&json!(now)))
            }
            "herdr_emit" => self
                .run
                .fake_herdr(get(&step, "herdr").and_then(Value::as_str))?
                .emit(&step["herdr_emit"]),
            "herdr_endpoint" => self
                .run
                .fake_herdr(get(&step, "herdr").and_then(Value::as_str))?
                .endpoint_action(&step["herdr_endpoint"]),
            "herdr_notify" => self
                .run
                .fake_herdr(get(&step, "herdr").and_then(Value::as_str))?
                .notify(&step["herdr_notify"]),
            "herdr_seed" => {
                let seed: HerdrSeed = serde_json::from_value(step["herdr_seed"].clone())?;
                self.run
                    .fake_herdr(get(&step, "herdr").and_then(Value::as_str))?
                    .reseed(&seed)
            }
            "herdr_calls" => {
                // `within_ms` in the spec: what real I/O after a timer
                // still does may land a little later; checked again until
                // it holds or the time is up.
                let wait = step["herdr_calls"].get("within_ms").and_then(Value::as_u64);
                let deadline =
                    tokio::time::Instant::now() + Duration::from_millis(wait.unwrap_or(0));
                loop {
                    match self.herdr_calls(&step) {
                        Err(error) if tokio::time::Instant::now() < deadline => {
                            let _ = error;
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        other => break other,
                    }
                }
            }
            "fake_calls" => self.fake_calls(&step),
            "http_fake_calls" => self.http_fake_calls(&step),
            "push_subscription" => {
                let id = str_of(&step["push_subscription"]).context("push_subscription: an id")?;
                let subscription = self.run.http.subscribe(id);
                let json = subscription.json(&self.run.http.base);
                self.vars.insert(format!("push_{id}"), json);
                if let Some(status) = get(&step, "status").and_then(Value::as_u64) {
                    self.run.http.set_push_status(id, status as u16);
                }
                Ok(())
            }
            "pushes" => {
                let pushes = serde_json::to_value(self.run.http.pushes())?;
                self.expect("fake-push messages", &step, &step["pushes"], Some(&pushes))
            }
            "write" => self.write(&step),
            "assert_file" => self.assert_file(&step),
            // With `within_ms`, waits for the path to go: a removal the
            // server makes after the step that triggers it (a sweep on the
            // test clock) is done when the server says nothing.
            "assert_absent" => {
                let path = self.path(&step["assert_absent"])?;
                let deadline = step
                    .contains_key("within_ms")
                    .then(|| tokio::time::Instant::now() + duration(&step));
                while path.exists() {
                    match deadline {
                        Some(deadline) if tokio::time::Instant::now() <= deadline => {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                        _ => bail!("{} exists", path.display()),
                    }
                }
                Ok(())
            }
            "assert_rows" => self.assert_rows(&step),
            "assert_refs" => self.assert_refs(&step),
            "restart" => {
                self.close_sockets();
                self.run.stop().await?;
                if let Some(Value::Object(env)) = step["restart"].get("env") {
                    for (key, value) in env {
                        match value {
                            Value::Null => {
                                self.run.env.remove(key);
                            }
                            other => {
                                self.run.env.insert(
                                    key.clone(),
                                    other
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| other.to_string()),
                                );
                            }
                        }
                    }
                }
                if let Some(password) = step["restart"].get("password") {
                    self.run.password = password.as_str().map(str::to_owned);
                    self.run.env.insert(
                        "ROAMGATE_PASSWORD".into(),
                        self.run.password.clone().unwrap_or_default(),
                    );
                }
                self.start().await
            }
            "stop" => {
                self.close_sockets();
                let signal = step["stop"]
                    .get("signal")
                    .and_then(Value::as_str)
                    .unwrap_or("TERM")
                    .to_owned();
                let code = self.run.stop_with(&signal).await?;
                if let Some(expected) = get(&step, "expect_exit") {
                    self.expect("exit code", &step, expected, Some(&json!(code)))?;
                }
                Ok(())
            }
            "start" => self.start().await,
            "expect_log" => {
                // Waits for the lines to come, `within_ms` in the spec or
                // LOG_GRACE: the server goes on logging after the line the
                // run waits for (the authentication mode follows `listening`)
                // and the harness reads its output as it comes.
                let wait = step["expect_log"]
                    .get("within_ms")
                    .and_then(Value::as_u64)
                    .map_or(LOG_GRACE, Duration::from_millis);
                let deadline = tokio::time::Instant::now() + wait;
                loop {
                    match self.expect_log(&step) {
                        Err(LogMismatch::Missing(_)) if tokio::time::Instant::now() < deadline => {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        other => break other.map_err(LogMismatch::into_error),
                    }
                }
            }
            "wait_file" => self.wait_file(&step).await,
            "sh" => self.sh(&step).await,
            // Shows a value while writing a scenario (stderr).
            "await" => self.await_reply(&step).await,
            "spawn" => self.spawn(&step),
            // A scripted agent socket for the installed assets
            // (fakes/agent_socket.rs): `serve_agent_socket: <name>` with
            // `replies` and an optional `path` (default <root>/<name>.sock,
            // saved as ${<name>_socket}).
            "serve_agent_socket" => {
                let name = str_of(&step["serve_agent_socket"])
                    .context("serve_agent_socket: a name")?
                    .to_owned();
                let path = match get(&step, "path").and_then(Value::as_str) {
                    Some(path) => self.path(&Value::String(path.to_owned()))?,
                    None => self.run.root.join(format!("{name}.sock")),
                };
                let replies = crate::fakes::agent_socket::replies_of(
                    get(&step, "replies").unwrap_or(&Value::Null),
                );
                let socket =
                    crate::fakes::agent_socket::FakeAgentSocket::start(&path, replies).await?;
                self.vars.insert(
                    format!("{name}_socket"),
                    Value::String(path.to_string_lossy().into_owned()),
                );
                self.agent_sockets.insert(name, socket);
                Ok(())
            }
            // `agent_socket_requests: {name, command?, count?, min?, calls?,
            // within_ms?}`: the requests it got, `{command, body}` each.
            "agent_socket_requests" => {
                let spec = step["agent_socket_requests"]
                    .as_object()
                    .context("agent_socket_requests: a map")?
                    .clone();
                let name = spec
                    .get("name")
                    .and_then(Value::as_str)
                    .context("agent_socket_requests: name")?
                    .to_owned();
                let wanted = spec
                    .get("count")
                    .or_else(|| spec.get("min"))
                    .and_then(Value::as_u64);
                let deadline = tokio::time::Instant::now() + duration(&spec);
                loop {
                    let socket = self
                        .agent_sockets
                        .get(&name)
                        .ok_or_else(|| anyhow!("no agent socket {name}"))?;
                    let selected: Vec<Value> = socket
                        .requests()
                        .into_iter()
                        .filter(|request| {
                            spec.get("command")
                                .and_then(Value::as_str)
                                .is_none_or(|command| request["command"] == command)
                        })
                        .collect();
                    let enough = wanted.is_none_or(|count| selected.len() as u64 >= count);
                    if enough || tokio::time::Instant::now() > deadline {
                        self.counts("agent socket requests", &step, &spec, &selected)?;
                        return self.save(&spec, &Value::Array(selected));
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            // `pane_type: {pane, text, herdr?}`: keys typed into the running
            // job of a fake Herdr terminal pane (`keyboard: true`).
            "pane_type" => {
                let spec = step["pane_type"]
                    .as_object()
                    .context("pane_type: {pane, text}")?;
                let pane = spec
                    .get("pane")
                    .and_then(Value::as_str)
                    .context("pane_type: pane")?;
                let text = spec.get("text").and_then(Value::as_str).unwrap_or("");
                self.run
                    .fake_herdr(spec.get("herdr").and_then(Value::as_str))?
                    .type_into(pane, text)
            }
            // `pane_signal: {pane, signal, herdr?, save?}`: a signal to the
            // pane's running job (HUP: the pane closes); its pid is saved as
            // ${<save>} when asked.
            "pane_signal" => {
                let spec = step["pane_signal"]
                    .as_object()
                    .context("pane_signal: {pane, signal}")?
                    .clone();
                let pane = spec
                    .get("pane")
                    .and_then(Value::as_str)
                    .context("pane_signal: pane")?;
                let signal = spec.get("signal").and_then(Value::as_str).unwrap_or("TERM");
                let pid = self
                    .run
                    .fake_herdr(spec.get("herdr").and_then(Value::as_str))?
                    .signal_pane(pane, signal)?;
                if let Some(name) = spec.get("save").and_then(Value::as_str) {
                    self.vars.insert(name.to_owned(), json!(pid));
                }
                Ok(())
            }
            // `process_gone: <pid>` (within_ms): the process ended (no zombie
            // counts: a reaped or re-parented one is gone from /proc).
            "process_gone" => {
                let pid = step["process_gone"]
                    .as_u64()
                    .or_else(|| {
                        step["process_gone"]
                            .as_str()
                            .and_then(|text| text.parse().ok())
                    })
                    .context("process_gone: a pid")?;
                let deadline = tokio::time::Instant::now() + duration(&step);
                loop {
                    let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
                    let alive = state.is_some_and(|stat| {
                        stat.rsplit(')')
                            .next()
                            .and_then(|rest| rest.split_whitespace().next())
                            .is_some_and(|state| state != "Z")
                    });
                    if !alive {
                        return Ok(());
                    }
                    if tokio::time::Instant::now() > deadline {
                        bail!("process {pid} still runs");
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            "stop_agent_socket" => {
                let name =
                    str_of(&step["stop_agent_socket"]).context("stop_agent_socket: a name")?;
                self.agent_sockets
                    .remove(name)
                    .ok_or_else(|| anyhow!("no agent socket {name}"))?
                    .stop();
                Ok(())
            }
            "write_stdin" => {
                let spec = step["write_stdin"]
                    .as_object()
                    .context("write_stdin: {name, text}")?;
                let name = spec
                    .get("name")
                    .and_then(Value::as_str)
                    .context("write_stdin: name")?;
                let text = spec.get("text").and_then(Value::as_str).unwrap_or("");
                let process = self
                    .processes
                    .get_mut(name)
                    .ok_or_else(|| anyhow!("no process {name}"))?;
                let stdin = process
                    .stdin
                    .as_mut()
                    .ok_or_else(|| anyhow!("{name}'s stdin is closed"))?;
                use tokio::io::AsyncWriteExt;
                stdin.write_all(text.as_bytes()).await?;
                stdin.flush().await?;
                if spec.get("close").and_then(Value::as_bool).unwrap_or(false) {
                    process.stdin = None;
                }
                Ok(())
            }
            "wait_process" => {
                let name = str_of(&step["wait_process"])
                    .context("wait_process: a name")?
                    .to_owned();
                let process = self
                    .processes
                    .remove(&name)
                    .ok_or_else(|| anyhow!("no process {name}"))?;
                let Spawned {
                    mut child, stdin, ..
                } = process;
                drop(stdin);
                // `kill_after_ms`: a process that holds on (a negative
                // check): its output after that long, then it is killed.
                if let Some(ms) = get(&step, "kill_after_ms").and_then(Value::as_u64) {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    let _ = child.start_kill();
                }
                let output = tokio::time::timeout(duration(&step), child.wait_with_output())
                    .await
                    .with_context(|| format!("process {name} did not end"))??;
                let output = crate::cli::Output {
                    code: output.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                };
                self.check_output(&format!("process {name}"), &step, &output)
            }
            "await_http" => {
                let name = str_of(&step["await_http"])
                    .context("await_http: a name")?
                    .to_owned();
                let (line, task) = self
                    .pending_http
                    .remove(&name)
                    .ok_or_else(|| anyhow!("no request sent with no_wait: {name}"))?;
                let response = tokio::time::timeout(duration(&step), task)
                    .await
                    .with_context(|| format!("{line} ({name}) did not answer"))???;
                self.check_response(&line, &step, &response)
            }
            // The messages queued on a socket, left queued: for writing
            // a scenario (stderr).
            "print_pushes" => {
                let (name, socket) = self.socket(&step)?;
                for (number, message) in socket.peek().await {
                    let text = match message {
                        Incoming::Text(value) => value.to_string(),
                        other => format!("{other:?}"),
                    };
                    eprintln!(
                        "parity push {name} #{number}: {}",
                        text.chars().take(600).collect::<String>()
                    );
                }
                Ok(())
            }
            "print" => {
                eprintln!(
                    "parity print: {}",
                    serde_json::to_string_pretty(&step["print"])?
                );
                Ok(())
            }
            "set" => {
                for (name, value) in step["set"].as_object().context("set: a map")? {
                    self.vars.insert(name.clone(), value.clone());
                }
                Ok(())
            }
            _ => unreachable!(),
        }
    }

    fn close_sockets(&mut self) {
        for socket in self.sockets.values() {
            socket.close();
        }
        self.sockets.clear();
        self.order.clear();
    }

    async fn login(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["login"].as_object().cloned().unwrap_or_default();
        let password = spec
            .get("password")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.run.password.clone())
            .context("login: no password")?;
        let jar = spec
            .get("as")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        if let Some(Value::Object(extra)) = spec.get("headers") {
            for (key, value) in extra {
                headers.push((key.clone(), value.as_str().unwrap_or_default().to_owned()));
            }
        }
        if spec.get("reuse").and_then(Value::as_bool).unwrap_or(false)
            && let Some(cookie) = self.run.cookie_header(&jar)
        {
            headers.push(("cookie".into(), cookie));
        }
        let response = http::send(
            &Target::Tcp(self.run.address()?),
            &Request {
                method: "POST".into(),
                path: "/api/login".into(),
                headers,
                body: json!({"password": password}).to_string().into_bytes(),
            },
            WAIT,
        )
        .await?;
        let expected = spec.get("status").and_then(Value::as_u64).unwrap_or(200);
        if u64::from(response.status) != expected {
            bail!(
                "login: status {} (expected {expected}): {}",
                response.status,
                response.text()
            );
        }
        let jar_cookies = self.run.cookies.entry(jar).or_default();
        for (name, value) in http::cookies_from(&response) {
            jar_cookies.insert(name, value);
        }
        let saved = json!({"status": response.status, "headers": response.header_map(), "cookie": self.run.cookie_header(spec.get("as").and_then(Value::as_str).unwrap_or("main"))});
        self.save(&spec, &saved)
    }

    async fn connect(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["connect"].as_object().cloned().unwrap_or_default();
        let name = spec
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        let path = spec
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("/ws")
            .to_owned();
        let rpc = spec
            .get("rpc")
            .and_then(Value::as_bool)
            .unwrap_or(path == "/ws");
        let mut headers: Vec<(String, String)> = Vec::new();
        let jar = spec.get("as").and_then(Value::as_str).unwrap_or("main");
        if spec.get("cookie").and_then(Value::as_bool).unwrap_or(true)
            && let Some(cookie) = self.run.cookie_header(jar)
        {
            headers.push(("cookie".into(), cookie));
        }
        if let Some(Value::Object(extra)) = spec.get("headers") {
            for (key, value) in extra {
                headers.push((key.clone(), value.as_str().unwrap_or_default().to_owned()));
            }
        }
        let url = format!("ws://{}{}", self.run.address()?, path);
        let connected = Socket::connect(Connect {
            url: &url,
            headers: &headers,
            rpc,
        })
        .await;
        if let Some(status) = spec.get("expect_refused") {
            let error = match connected {
                Ok(_) => bail!("connect {path}: expected a refusal"),
                Err(error) => format!("{error:#}"),
            };
            let code = status
                .as_u64()
                .map(|code| code.to_string())
                .unwrap_or_default();
            if !error.contains(&code) {
                bail!("connect {path}: refused, but not with {code}: {error}");
            }
            return Ok(());
        }
        let socket = connected?;
        if path == "/ws" && spec.get("hello").and_then(Value::as_bool).unwrap_or(true) {
            let hello = socket
                .take(WAIT, |message| matches!(message, Incoming::Text(value) if value.get("hello") == Some(&Value::Bool(true))))
                .await
                .ok_or_else(|| anyhow!("no hello on {path}"))?;
            let Incoming::Text(hello) = hello.1 else {
                unreachable!()
            };
            if let Some(expected) = spec.get("expect_hello") {
                self.expect("hello", &spec, expected, Some(&hello))?;
            }
            self.vars.insert(format!("{name}_hello"), hello);
        }
        self.sockets.insert(name.clone(), socket);
        self.order.insert(name, 0);
        Ok(())
    }

    /// The reply to a call made with `no_wait`, checked as `call` does.
    async fn await_reply(&mut self, step: &Map<String, Value>) -> Result<()> {
        let id = str_of(&step["await"])
            .context("await: a request id")?
            .to_owned();
        // `advance_every`: while no reply came (100 ms of real time), the
        // clock moves by this much, for a call whose timer the server sets
        // only after real I/O (no race with a single `advance`).
        if let Some(ms) = get(step, "advance_every").and_then(Value::as_u64) {
            let deadline = tokio::time::Instant::now() + duration(step);
            loop {
                let (_, socket) = self.socket(step)?;
                if socket.has_reply(&id).await || tokio::time::Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                let (_, socket) = self.socket(step)?;
                if socket.has_reply(&id).await {
                    break;
                }
                self.run.clock().advance(ms).await?;
            }
        }
        let (_, socket) = self.socket(step)?;
        let reply = socket.reply(&id, duration(step)).await?;
        if let Some(expected) = get(step, "error") {
            self.expect(&format!("{id} error"), step, expected, reply.get("error"))?;
        } else if reply.get("error").is_some()
            && !get(step, "any_outcome")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            bail!("{id}: {}", reply["error"]);
        }
        if let Some(expected) = get(step, "reply") {
            self.expect(&format!("{id} reply"), step, expected, reply.get("result"))?;
        }
        self.save(step, &reply)
    }

    async fn call(&mut self, step: &Map<String, Value>) -> Result<()> {
        let method = str_of(&step["call"]).context("call: a method")?.to_owned();
        self.next_id += 1;
        let id = get(step, "id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("p{}", self.next_id));
        let mut request = json!({"id": id, "method": method, "params": get(step, "params").cloned().unwrap_or(json!({}))});
        for key in ["connection_id", "connection_generation", "lane"] {
            if let Some(value) = get(step, key) {
                request[key] = value.clone();
            }
        }
        let (_, socket) = self.socket(step)?;
        socket.send_json(&request)?;
        // `no_wait`: the reply is taken later by an `await: <id>` step (a
        // call the server answers only once the clock moves).
        if get(step, "no_wait")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(());
        }
        let mut reply = socket.reply(&id, duration(step)).await?;
        // `until`: the call is made again (every 50 ms of real time, at
        // most `within_ms`) until its result matches, for state the server
        // reaches through real I/O with a fake (a forge refresh).
        if let Some(until) = get(step, "until").cloned() {
            let deadline = tokio::time::Instant::now() + duration(step);
            let mut round = 0;
            while self
                .expect("until", step, &until, reply.get("result"))
                .is_err()
            {
                if tokio::time::Instant::now() > deadline {
                    self.expect(
                        &format!("{method} until"),
                        step,
                        &until,
                        reply.get("result"),
                    )?;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                round += 1;
                let again = format!("{id}-{round}");
                request["id"] = json!(again);
                let (_, socket) = self.socket(step)?;
                socket.send_json(&request)?;
                reply = socket.reply(&again, duration(step)).await?;
            }
        }
        if let Some(expected) = get(step, "error") {
            let error = reply.get("error");
            if error.is_none() {
                bail!("{method}: expected an error, got {reply}");
            }
            self.expect(&format!("{method} error"), step, expected, error)?;
        } else if reply.get("error").is_some()
            && !get(step, "any_outcome")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            bail!("{method}: {}", reply["error"]);
        }
        if let Some(expected) = get(step, "reply") {
            self.expect(
                &format!("{method} reply"),
                step,
                expected,
                reply.get("result"),
            )?;
        }
        for needle in names(get(step, "reply_lacks")) {
            if reply.to_string().contains(&needle) {
                bail!("{method}: the reply contains {needle:?}");
            }
        }
        if let Some(expected) = get(step, "envelope") {
            self.expect(
                &format!("{method} reply envelope"),
                step,
                expected,
                Some(&reply),
            )?;
        }
        self.save(step, &reply)?;
        Ok(())
    }

    fn send(&mut self, step: &Map<String, Value>) -> Result<()> {
        let (_, socket) = self.socket(step)?;
        // `send: {"$binary_hex": "..."}`: a binary message (audio).
        if let Some(hex) = step["send"].get("$binary_hex").and_then(Value::as_str) {
            let bytes = (0..hex.len() / 2)
                .map(|at| u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .context("send: $binary_hex is hex")?;
            return socket.send_binary(bytes);
        }
        match &step["send"] {
            Value::String(text) => socket.send_text(text),
            value => socket.send_json(value),
        }
    }

    /// Takes the first queued push named `push` whose message matches.
    async fn take_push(&mut self, spec: &Map<String, Value>, ordered: bool) -> Result<Value> {
        let name = spec
            .get("push")
            .and_then(Value::as_str)
            .context("a push name")?
            .to_owned();
        let expected = spec.get("message").cloned();
        let normalizers = names(spec.get("normalize"));
        let paths = self.run.paths();
        let socket_name = spec
            .get("socket")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        let after = if ordered {
            self.order.get(&socket_name).copied().unwrap_or(0)
        } else {
            0
        };
        let socket = self
            .sockets
            .get(&socket_name)
            .ok_or_else(|| anyhow!("no socket named {socket_name}"))?;
        let normalizer = &self.normalizers;
        let found = socket
            .take(duration(spec), |message| {
                let Incoming::Text(value) = message else {
                    return false;
                };
                let message_name = if socket.is_rpc() {
                    push_name(value)
                } else {
                    socket_message_name(value)
                };
                if message_name != name {
                    return false;
                }
                match &expected {
                    None => true,
                    Some(expected) => normalizer
                        .apply(&normalizers, value, &paths)
                        .is_ok_and(|value| matcher::check(expected, Some(&value)).is_ok()),
                }
            })
            .await;
        let Some((number, Incoming::Text(value))) = found else {
            // A probe (advance_every) keeps the queue for its next try.
            if spec.contains_key("$probe") {
                bail!("no {name} push yet");
            }
            let queued: Vec<String> = socket
                .drain()
                .await
                .into_iter()
                .map(|(_, message)| match message {
                    Incoming::Text(value) => value.to_string().chars().take(300).collect(),
                    other => format!("{other:?}"),
                })
                .collect();
            bail!(
                "no {name} push matching {} on {socket_name}; queued: {queued:#?}",
                expected.map(|value| value.to_string()).unwrap_or_default()
            );
        };
        if ordered {
            if number <= after {
                bail!("push {name} arrived before the previous expected push");
            }
            self.order.insert(socket_name, number);
        }
        Ok(value)
    }

    async fn expect_push(&mut self, step: &Map<String, Value>) -> Result<()> {
        let mut spec = step.clone();
        spec.insert("push".into(), step["expect_push"].clone());
        // `advance_every: <ms>`: while the push has not come (100 ms of real
        // time), the clock moves by that much, for work that sleeps on the
        // server's clock between real I/O.
        if let Some(ms) = get(step, "advance_every").and_then(Value::as_u64) {
            let deadline = tokio::time::Instant::now() + duration(step);
            let mut probe = spec.clone();
            probe.insert("within_ms".into(), json!(100));
            probe.insert("$probe".into(), Value::Bool(true));
            loop {
                match self.take_push(&probe, false).await {
                    Ok(value) => return self.save(step, &value),
                    Err(error) if tokio::time::Instant::now() > deadline => return Err(error),
                    Err(_) => {
                        self.run.clock().advance(ms).await?;
                    }
                }
            }
        }
        let value = self.take_push(&spec, false).await?;
        self.save(step, &value)
    }

    async fn expect_pushes(&mut self, step: &Map<String, Value>) -> Result<()> {
        let items = step["expect_pushes"]
            .as_array()
            .context("expect_pushes: a list")?
            .clone();
        if let Some(socket) = get(step, "socket").and_then(Value::as_str) {
            self.order.insert(socket.to_owned(), 0);
        } else {
            self.order.insert("main".into(), 0);
        }
        for item in items {
            let mut spec = item.as_object().context("a push")?.clone();
            for key in ["socket", "normalize", "within_ms"] {
                if let (false, Some(value)) = (spec.contains_key(key), step.get(key)) {
                    spec.insert(key.into(), value.clone());
                }
            }
            let value = self.take_push(&spec, true).await?;
            self.save(&spec, &value)?;
        }
        Ok(())
    }

    /// No such push queued once a `bridge.ping` round trip is done (the
    /// server answers in order, so what it sent before is in by then).
    async fn expect_no_push(&mut self, step: &Map<String, Value>) -> Result<()> {
        let name = str_of(&step["expect_no_push"])
            .context("expect_no_push: a push name")?
            .to_owned();
        self.next_id += 1;
        let id = format!("barrier{}", self.next_id);
        let (_, socket) = self.socket(step)?;
        socket.send_json(&json!({"id": id, "method": "bridge.ping", "params": {}}))?;
        socket.reply(&id, WAIT).await?;
        if let Some((_, message)) = socket
            .take(
                Duration::ZERO,
                |message| matches!(message, Incoming::Text(value) if push_name(value) == name),
            )
            .await
        {
            bail!("unexpected {name} push: {message:?}");
        }
        Ok(())
    }

    async fn expect_close(&mut self, step: &Map<String, Value>) -> Result<()> {
        let (name, socket) = self.socket(step)?;
        let name = name.to_owned();
        let found = socket
            .take(duration(step), |message| {
                matches!(message, Incoming::Closed { .. })
            })
            .await;
        let Some((_, Incoming::Closed { code, reason })) = found else {
            bail!("socket {name} did not close");
        };
        if let Some(expected) = step["expect_close"]
            .as_object()
            .and_then(|spec| spec.get("code"))
        {
            self.expect("close code", step, expected, Some(&json!(code)))?;
        }
        if let Some(expected) = step["expect_close"]
            .as_object()
            .and_then(|spec| spec.get("reason"))
        {
            self.expect("close reason", step, expected, Some(&json!(reason)))?;
        }
        Ok(())
    }

    fn check_response(
        &mut self,
        what: &str,
        step: &Map<String, Value>,
        response: &http::Response,
    ) -> Result<()> {
        let expect = get(step, "expect").cloned().unwrap_or(json!({}));
        let expect = expect.as_object().context("expect: a map")?;
        if let Some(status) = expect.get("status") {
            self.expect(
                &format!(
                    "{what} status ({})",
                    response.text().chars().take(300).collect::<String>()
                ),
                step,
                status,
                Some(&json!(response.status)),
            )?;
        }
        if let Some(Value::Object(headers)) = expect.get("headers") {
            for (name, value) in headers {
                let actual = response
                    .header(name)
                    .map(|text| Value::String(text.to_owned()));
                self.expect(
                    &format!("{what} header {name}"),
                    step,
                    value,
                    actual.as_ref(),
                )?;
            }
        }
        if let Some(expected) = expect.get("json") {
            let body = response.json()?;
            self.expect(&format!("{what} body"), step, expected, Some(&body))?;
        }
        if let Some(expected) = expect.get("text") {
            self.expect(
                &format!("{what} body"),
                step,
                expected,
                Some(&Value::String(response.text())),
            )?;
        }
        for needle in names(expect.get("text_contains")) {
            if !response.text().contains(&needle) {
                bail!(
                    "{what} body does not contain {needle:?}: {}",
                    response.text().chars().take(500).collect::<String>()
                );
            }
        }
        for needle in names(expect.get("text_lacks")) {
            if response.text().contains(&needle) {
                bail!("{what} body contains {needle:?}");
            }
        }
        if let Some(length) = expect.get("body_length").and_then(Value::as_u64)
            && response.body.len() as u64 != length
        {
            bail!(
                "{what} body is {} bytes, expected {length}",
                response.body.len()
            );
        }
        let body = response.json().unwrap_or(Value::Null);
        let saved = json!({"status": response.status, "headers": response.header_map(), "json": body, "text": response.text()});
        self.save(step, &saved)
    }

    async fn http(&mut self, step: &Map<String, Value>) -> Result<()> {
        let line = str_of(&step["http"]).context("http: \"METHOD /path\"")?;
        let (method, path) = line.split_once(' ').context("http: \"METHOD /path\"")?;
        let mut headers: Vec<(String, String)> = Vec::new();
        let jar = get(step, "as")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        if get(step, "cookie").and_then(Value::as_bool).unwrap_or(true)
            && let Some(cookie) = self.run.cookie_header(&jar)
        {
            headers.push(("cookie".into(), cookie));
        }
        if let Some(Value::Object(extra)) = get(step, "headers") {
            for (key, value) in extra {
                headers.retain(|(name, _)| !name.eq_ignore_ascii_case(key));
                headers.push((
                    key.clone(),
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                ));
            }
        }
        let body = match (get(step, "body"), get(step, "text")) {
            (Some(body), _) => {
                if !headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                {
                    headers.push(("content-type".into(), "application/json".into()));
                }
                body.to_string().into_bytes()
            }
            (None, Some(text)) => text.as_str().unwrap_or_default().as_bytes().to_vec(),
            _ => Vec::new(),
        };
        let request = Request {
            method: method.into(),
            path: path.into(),
            headers,
            body,
        };
        let target = Target::Tcp(self.run.address()?);
        // `no_wait: <name>`: sent now, its response taken by a later
        // `await_http: <name>` (an answer that needs the clock to move).
        if let Some(name) = get(step, "no_wait").and_then(Value::as_str) {
            let timeout = duration(step).max(Duration::from_secs(60));
            let task = tokio::spawn(async move { http::send(&target, &request, timeout).await });
            self.pending_http
                .insert(name.to_owned(), (line.to_owned(), task));
            return Ok(());
        }
        let response = http::send(&target, &request, duration(step)).await?;
        if get(step, "save_cookies")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let cookies = self.run.cookies.entry(jar.clone()).or_default();
            for (name, value) in http::cookies_from(&response) {
                if value.is_empty() {
                    cookies.remove(&name);
                } else {
                    cookies.insert(name, value);
                }
            }
        }
        self.check_response(line, step, &response)
    }

    async fn agent(&mut self, step: &Map<String, Value>) -> Result<()> {
        let command = str_of(&step["agent"])
            .context("agent: a command")?
            .to_owned();
        let socket = crate::agent::socket_path(&self.run.home);
        self.wait_for(&socket, WAIT).await?;
        let headers: Vec<(String, String)> = get(step, "headers")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(key, value)| {
                        (key.clone(), value.as_str().unwrap_or_default().to_owned())
                    })
                    .collect()
            })
            .unwrap_or_default();
        // `no_wait: <name>`: a long poll (watch, mod_poll, hold, a prompt),
        // its response taken by a later `await_http: <name>`.
        if let Some(name) = get(step, "no_wait").and_then(Value::as_str) {
            let body = get(step, "body").cloned().unwrap_or(json!({}));
            let timeout = duration(step).max(Duration::from_secs(60));
            let line = format!("agent {command}");
            let task = tokio::spawn(async move {
                crate::agent::post(&socket, &command, &body, &headers, timeout).await
            });
            self.pending_http.insert(name.to_owned(), (line, task));
            return Ok(());
        }
        let response = crate::agent::post(
            &socket,
            &command,
            get(step, "body").unwrap_or(&json!({})),
            &headers,
            duration(step),
        )
        .await?;
        self.check_response(&format!("agent {command}"), step, &response)
    }

    async fn wait_for(&self, path: &Path, timeout: Duration) -> Result<()> {
        let deadline = tokio::time::Instant::now() + timeout;
        while !path.exists() {
            if tokio::time::Instant::now() > deadline {
                bail!("{} did not appear", path.display());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }

    async fn wait_file(&mut self, step: &Map<String, Value>) -> Result<()> {
        let path = self.path(&step["wait_file"])?;
        self.wait_for(&path, duration(step)).await
    }

    fn check_output(
        &mut self,
        what: &str,
        step: &Map<String, Value>,
        output: &crate::cli::Output,
    ) -> Result<()> {
        let expect = get(step, "expect").cloned().unwrap_or(json!({"exit": 0}));
        let expect = expect.as_object().context("expect: a map")?;
        let context = || format!("stdout: {}\nstderr: {}", output.stdout, output.stderr);
        if let Some(code) = expect.get("exit") {
            self.expect(
                &format!("{what} exit code ({})", context()),
                step,
                code,
                Some(&json!(output.code)),
            )?;
        }
        if let Some(expected) = expect.get("stderr") {
            self.expect(
                &format!("{what} stderr"),
                step,
                expected,
                Some(&Value::String(output.stderr.clone())),
            )?;
        }
        // `exit_not: <code>`: any exit code but that one (a failure).
        if let Some(code) = expect.get("exit_not").and_then(Value::as_i64)
            && i64::from(output.code) == code
        {
            bail!(
                "{what} exited {code}, expected another code ({})",
                context()
            );
        }
        if let Some(expected) = expect.get("stdout") {
            self.expect(
                &format!("{what} stdout"),
                step,
                expected,
                Some(&Value::String(output.stdout.clone())),
            )?;
        }
        if let Some(golden) = expect.get("stdout_file").and_then(Value::as_str) {
            let path = repo_root().join(golden);
            let wanted =
                std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
            if wanted != output.stdout {
                bail!(
                    "{what} stdout differs from {golden}:\n--- expected\n{wanted}\n--- actual\n{}",
                    output.stdout
                );
            }
        }
        if let Some(golden) = expect.get("stderr_file").and_then(Value::as_str) {
            let path = repo_root().join(golden);
            let wanted =
                std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
            if wanted != output.stderr {
                bail!(
                    "{what} stderr differs from {golden}:\n--- expected\n{wanted}\n--- actual\n{}",
                    output.stderr
                );
            }
        }
        if let Some(expected) = expect.get("stdout_json") {
            let value: Value = serde_json::from_str(output.stdout.trim())
                .with_context(|| format!("{what} stdout is not JSON: {}", output.stdout))?;
            self.expect(&format!("{what} stdout"), step, expected, Some(&value))?;
        }
        for needle in names(expect.get("stdout_contains")) {
            if !output.stdout.contains(&needle) {
                bail!("{what} stdout lacks {needle:?}\n{}", context());
            }
        }
        for needle in names(expect.get("stderr_contains")) {
            if !output.stderr.contains(&needle) {
                bail!("{what} stderr lacks {needle:?}\n{}", context());
            }
        }
        let parsed = serde_json::from_str::<Value>(output.stdout.trim()).unwrap_or(Value::Null);
        self.save(step, &json!({"exit": output.code, "stdout": output.stdout, "stderr": output.stderr, "json": parsed}))
    }

    /// The environment of a process a step runs: the server's, without
    /// the test clock (that socket is the server's; a CLI process keeps
    /// the real clock), with the step's `env` over it.
    fn step_env(&self, step: &Map<String, Value>) -> BTreeMap<String, String> {
        let mut env = self.run.env.clone();
        env.remove("ROAMGATE_TEST_CLOCK");
        env.remove("ROAMGATE_TEST_CLOCK_EPOCH");
        if let Some(Value::Object(extra)) = get(step, "env") {
            for (key, value) in extra {
                match value {
                    Value::Null => {
                        env.remove(key);
                    }
                    other => {
                        env.insert(
                            key.clone(),
                            other
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| other.to_string()),
                        );
                    }
                }
            }
        }
        env
    }

    async fn client(&mut self, step: &Map<String, Value>) -> Result<()> {
        // `cwd`: where the client runs, relative to the run's root.
        let cwd = match get(step, "cwd").and_then(Value::as_str) {
            Some(dir) => self.run.root.join(dir),
            None => self.run.root.clone(),
        };
        let args: Vec<String> = names(Some(&step["client"]));
        let client = crate::agent::client_path(&self.run.home);
        self.wait_for(&client, WAIT).await?;
        self.wait_for(&crate::agent::socket_path(&self.run.home), WAIT)
            .await?;
        let python = std::env::var("PARITY_PYTHON").unwrap_or_else(|_| "python3".into());
        let command = vec![python, client.to_string_lossy().into_owned()];
        let env = self.step_env(step);
        let output = crate::cli::run(
            &command,
            &args,
            &env,
            &cwd,
            get(step, "stdin").and_then(Value::as_str),
            duration(step),
        )
        .await?;
        self.check_output(
            &format!("roamgate-review {}", args.join(" ")),
            step,
            &output,
        )
    }

    async fn cli(&mut self, step: &Map<String, Value>) -> Result<()> {
        let args: Vec<String> = names(Some(&step["cli"]));
        let mut env = self.step_env(step);
        // A CLI process would take over the server's test clock socket
        // (a stale file there is replaced): it runs on the real clock.
        env.remove("ROAMGATE_TEST_CLOCK");
        env.remove("ROAMGATE_TEST_CLOCK_EPOCH");
        let command = self.run.command.clone();
        let cwd = self.run.cwd.clone();
        let output = crate::cli::run(
            &command,
            &args,
            &env,
            &cwd,
            get(step, "stdin").and_then(Value::as_str),
            duration(step),
        )
        .await?;
        self.check_output(&format!("roamgate {}", args.join(" ")), step, &output)
    }

    fn herdr_calls(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["herdr_calls"]
            .as_object()
            .context("herdr_calls: a map")?;
        let calls = self
            .run
            .fake_herdr(spec.get("herdr").and_then(Value::as_str))?
            .calls();
        if spec
            .get("all_valid")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && let Some(invalid) = calls.iter().find(|call| !call.valid)
        {
            bail!(
                "the server sent Herdr a request Herdr's types refuse: {} {} ({})",
                invalid.method,
                invalid.params,
                invalid.error.clone().unwrap_or_default()
            );
        }
        if let Some(pattern) = spec.get("none_match").and_then(Value::as_str) {
            let regex = Regex::new(pattern)?;
            if let Some(call) = calls.iter().find(|call| regex.is_match(&call.method)) {
                bail!(
                    "the server called Herdr's {} ({})",
                    call.method,
                    call.params
                );
            }
        }
        let selected: Vec<Value> = calls
            .iter()
            .filter(|call| {
                spec.get("method")
                    .and_then(Value::as_str)
                    .is_none_or(|method| method == call.method)
            })
            .map(|call| serde_json::to_value(call).expect("serialises"))
            .collect();
        self.counts("Herdr calls", step, spec, &selected)
    }

    fn counts(
        &mut self,
        what: &str,
        step: &Map<String, Value>,
        spec: &Map<String, Value>,
        selected: &[Value],
    ) -> Result<()> {
        // `where`: only the calls matching this (matcher.rs) count.
        let filtered: Vec<Value>;
        let selected = match spec.get("where") {
            Some(pattern) => {
                filtered = selected
                    .iter()
                    .filter(|call| matcher::check(pattern, Some(call)).is_ok())
                    .cloned()
                    .collect();
                filtered.as_slice()
            }
            None => selected,
        };
        if let Some(max) = spec.get("max").and_then(Value::as_u64)
            && selected.len() as u64 > max
        {
            bail!("{what}: {} calls, expected at most {max}", selected.len());
        }
        // `index` with `text_contains` / `text_lacks`: one call's JSON text.
        if let Some(index) = spec.get("index").and_then(Value::as_u64) {
            let call = selected
                .get(index as usize)
                .ok_or_else(|| anyhow!("{what}: no call {index} (of {})", selected.len()))?;
            let text = call.to_string();
            for needle in names(spec.get("text_contains")) {
                if !text.contains(&needle) {
                    bail!("{what}: call {index} lacks {needle:?}");
                }
            }
            for needle in names(spec.get("text_lacks")) {
                if text.contains(&needle) {
                    bail!("{what}: call {index} contains {needle:?}");
                }
            }
            if let Some(expected) = spec.get("call") {
                self.expect(what, step, expected, Some(call))?;
            }
        }
        if let Some(count) = spec.get("count").and_then(Value::as_u64)
            && selected.len() as u64 != count
        {
            bail!(
                "{what}: {} calls, expected {count}: {selected:#?}",
                selected.len()
            );
        }
        if let Some(min) = spec.get("min").and_then(Value::as_u64)
            && (selected.len() as u64) < min
        {
            bail!("{what}: {} calls, expected at least {min}", selected.len());
        }
        if let Some(expected) = spec.get("calls") {
            self.expect(what, step, expected, Some(&Value::Array(selected.to_vec())))?;
        }
        Ok(())
    }

    fn fake_calls(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["fake_calls"]
            .as_object()
            .context("fake_calls: a map")?
            .clone();
        let program = spec
            .get("program")
            .and_then(Value::as_str)
            .context("fake_calls: program")?;
        let pattern = spec
            .get("argv_match")
            .and_then(Value::as_str)
            .map(Regex::new)
            .transpose()?;
        let selected: Vec<Value> = self
            .run
            .fake_calls()
            .into_iter()
            .filter(|call| call.program == program)
            .filter(|call| {
                pattern
                    .as_ref()
                    .is_none_or(|regex| regex.is_match(&call.argv.join(" ")))
            })
            .map(|call| serde_json::to_value(call).expect("serialises"))
            .collect();
        self.counts(&format!("{program} calls"), step, &spec, &selected)
    }

    fn http_fake_calls(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["http_fake_calls"]
            .as_object()
            .context("http_fake_calls: a map")?
            .clone();
        let selected: Vec<Value> = self
            .run
            .http
            .calls()
            .into_iter()
            .filter(|call| {
                spec.get("fake")
                    .and_then(Value::as_str)
                    .is_none_or(|fake| fake == call.fake)
            })
            .filter(|call| {
                spec.get("path")
                    .and_then(Value::as_str)
                    .is_none_or(|path| path == call.path)
            })
            .map(|call| serde_json::to_value(call).expect("serialises"))
            .collect();
        self.counts("HTTP fake calls", step, &spec, &selected)
    }

    fn write(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["write"].as_object().context("write: a map")?;
        let path = self.path(spec.get("path").context("write: path")?)?;
        let file = seed_file(&path.to_string_lossy(), &Value::Object(spec.clone()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &file.content)?;
        #[cfg(unix)]
        if let Some(mode) = file.mode {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))?;
        }
        Ok(())
    }

    fn assert_file(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["assert_file"]
            .as_object()
            .context("assert_file: a map")?
            .clone();
        let path = self.path(spec.get("path").context("assert_file: path")?)?;
        let what = path.display().to_string();
        if spec.get("exists") == Some(&Value::Bool(false)) {
            if path.exists() {
                bail!("{what} exists");
            }
            return Ok(());
        }
        if !path.exists() {
            bail!("{what} does not exist");
        }
        if let Some(expected) = spec.get("json") {
            let value = crate::inspect::json_file(&path)?;
            self.expect(&what, &spec, expected, Some(&value))?;
            self.save(&spec, &value)?;
        }
        if let Some(expected) = spec.get("jsonl") {
            let value = crate::inspect::jsonl_file(&path)?;
            self.expect(&what, &spec, expected, Some(&value))?;
        }
        if let Some(expected) = spec.get("text") {
            let value = Value::String(std::fs::read_to_string(&path)?);
            self.expect(&what, &spec, expected, Some(&value))?;
        }
        if let Some(name) = spec.get("save_text").and_then(Value::as_str) {
            let text = std::fs::read_to_string(&path)?;
            self.vars
                .insert(name.to_owned(), Value::String(text.trim().to_owned()));
        }
        for needle in names(spec.get("text_contains")) {
            if !std::fs::read_to_string(&path)?.contains(&needle) {
                bail!("{what} lacks {needle:?}");
            }
        }
        for needle in names(spec.get("zstd_contains")) {
            if !crate::inspect::zstd_text(&path)?.contains(&needle) {
                bail!("{what} (zstd) lacks {needle:?}");
            }
        }
        if let Some(expected) = spec.get("mode") {
            let mode = crate::inspect::mode(&path)?;
            if cfg!(unix) {
                self.expect(
                    &format!("{what} mode"),
                    &spec,
                    expected,
                    Some(&Value::String(mode)),
                )?;
            }
        }
        Ok(())
    }

    fn assert_rows(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["assert_rows"]
            .as_object()
            .context("assert_rows: a map")?
            .clone();
        let path = self.path(spec.get("db").context("assert_rows: db")?)?;
        let sql = spec
            .get("sql")
            .and_then(Value::as_str)
            .context("assert_rows: sql")?;
        let rows = crate::inspect::sqlite_rows(&path, sql)?;
        if let Some(expected) = spec.get("rows") {
            self.expect(
                &format!("{} {sql}", path.display()),
                &spec,
                expected,
                Some(&rows),
            )?;
        }
        self.save(&spec, &rows)
    }

    fn assert_refs(&mut self, step: &Map<String, Value>) -> Result<()> {
        let spec = step["assert_refs"]
            .as_object()
            .context("assert_refs: a map")?
            .clone();
        let repo = self.path(spec.get("repo").context("assert_refs: repo")?)?;
        let prefix = spec
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or("refs/");
        let refs = crate::inspect::git_refs(&repo, prefix)?;
        if let Some(expected) = spec.get("refs") {
            self.expect(
                &format!("refs of {}", repo.display()),
                &spec,
                expected,
                Some(&refs),
            )?;
        }
        self.save(&spec, &refs)
    }

    fn expect_log(&mut self, step: &Map<String, Value>) -> Result<(), LogMismatch> {
        let log = self.run.log_text();
        let spec = step["expect_log"]
            .as_object()
            .context("expect_log: a map")
            .map_err(LogMismatch::Wrong)?;
        for needle in names(spec.get("contains")) {
            if !log.contains(&needle) {
                return Err(LogMismatch::Missing(anyhow!(
                    "the server log lacks {needle:?}:\n{log}"
                )));
            }
        }
        if let Some(pattern) = spec.get("matches").and_then(Value::as_str)
            && !Regex::new(pattern)
                .map_err(|error| LogMismatch::Wrong(error.into()))?
                .is_match(&log)
        {
            return Err(LogMismatch::Missing(anyhow!(
                "the server log does not match /{pattern}/:\n{log}"
            )));
        }
        for needle in names(spec.get("lacks")) {
            if log.contains(&needle) {
                return Err(LogMismatch::Wrong(anyhow!("the server log has {needle:?}")));
            }
        }
        Ok(())
    }

    /// A shell command in the run's root, with the server's environment:
    /// fixtures for T2 (git repositories and the like).
    async fn sh(&mut self, step: &Map<String, Value>) -> Result<()> {
        let command = str_of(&step["sh"]).context("sh: a command")?.to_owned();
        let env = self.step_env(step);
        let output = crate::cli::run(
            &["sh".to_owned(), "-c".to_owned()],
            std::slice::from_ref(&command),
            &env,
            &self.run.root,
            get(step, "stdin").and_then(Value::as_str),
            duration(step),
        )
        .await?;
        let expect_default = json!({"exit": 0});
        let mut step = step.clone();
        step.entry("expect").or_insert(expect_default);
        self.check_output(&format!("sh {command}"), &step, &output)
    }
}

/// A JSON pointer whose segments may also be `[key=value]`: the first
/// element of an array whose `key` is that string (`/tasks/[title=A]/id`),
/// or `[key]`: the first element that has `key`.
pub fn select(value: &Value, pointer: &str) -> Option<Value> {
    if !pointer.contains('[') {
        return value.pointer(pointer).cloned();
    }
    let mut at = value;
    for segment in pointer.split('/').skip(1) {
        at = match segment
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            // `[key]`: the first element that has `key` (not null).
            Some(filter) if !filter.contains('=') => at
                .as_array()?
                .iter()
                .find(|item| item.get(filter).is_some_and(|found| !found.is_null()))?,
            Some(filter) => {
                let (key, wanted) = filter.split_once('=')?;
                at.as_array()?.iter().find(|item| {
                    item.get(key).is_some_and(|found| match found {
                        Value::String(text) => text == wanted,
                        other => serde_json::from_str::<Value>(wanted)
                            .is_ok_and(|parsed| parsed == *other),
                    })
                })?
            }
            None => {
                let segment = segment.replace("~1", "/").replace("~0", "~");
                match at {
                    Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
                    Value::Object(map) => map.get(&segment)?,
                    _ => return None,
                }
            }
        };
    }
    Some(at.clone())
}

/// A process a scenario started (`spawn`).
pub struct Spawned {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
}

impl Runner {
    /// `spawn: <name>` with `command` (run by `sh -c` in the run's root,
    /// or `cwd` under it) and `env`: a process that runs on while the steps
    /// go on (a pane's holder), its stdin fed by `write_stdin` and its end
    /// checked by `wait_process`. Killed with the run if never waited for.
    fn spawn(&mut self, step: &Map<String, Value>) -> Result<()> {
        let name = str_of(&step["spawn"]).context("spawn: a name")?.to_owned();
        let command = get(step, "command")
            .and_then(Value::as_str)
            .context("spawn: command")?;
        let env = self.step_env(step);
        let cwd = match get(step, "cwd").and_then(Value::as_str) {
            Some(dir) => self.run.root.join(dir),
            None => self.run.root.clone(),
        };
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .env_clear()
            .envs(&env)
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn {command}"))?;
        let stdin = child.stdin.take();
        self.processes.insert(name, Spawned { child, stdin });
        Ok(())
    }
}

/// A message's name on the voice, notification and call sockets
/// (corpus.ts socketMessageName).
pub fn socket_message_name(value: &Value) -> String {
    if let Some(map) = value.as_object() {
        for key in ["op", "type", "event", "kind", "method"] {
            if let Some(text) = map.get(key).and_then(Value::as_str) {
                return format!("{key}:{text}");
            }
        }
    }
    push_name(value)
}

/// What a scenario covers in the contract: what its steps name, plus its
/// `covers` list. `rpc:<method>`, `push:<name>`, `http:<METHOD> <path>`,
/// `agent:<command>`, `cli:<command>`, `env:<NAME>`.
pub fn coverage(scenario: &Scenario) -> Vec<String> {
    let mut out: Vec<String> = scenario.covers.clone();
    // The channel of each named socket (contract/ws/asyncapi.yaml names).
    let mut channels: BTreeMap<String, &'static str> = BTreeMap::new();
    for step in &scenario.steps {
        let Some(step) = step.as_object() else {
            continue;
        };
        let socket = step.get("socket").and_then(Value::as_str).unwrap_or("main");
        if let Some(method) = step.get("call").and_then(Value::as_str) {
            out.push(format!("rpc:{method}"));
        }
        let mut pushed = |name: &str| match channels.get(socket) {
            Some(channel) => {
                let message = name.split_once(':').map_or(name, |(_, rest)| rest);
                out.push(format!("ws:{channel} out {message}"));
            }
            None => out.push(format!("push:{name}")),
        };
        if let Some(name) = step.get("expect_push").and_then(Value::as_str) {
            pushed(name);
        }
        if let Some(items) = step.get("expect_pushes").and_then(Value::as_array) {
            for name in items.iter().filter_map(|item| item.get("push")?.as_str()) {
                pushed(name);
            }
        }
        if let Some(sent) = step.get("send")
            && let Some(channel) = channels.get(socket)
        {
            let name = socket_message_name(sent);
            let message = name.split_once(':').map_or(name.as_str(), |(_, rest)| rest);
            out.push(format!("ws:{channel} in {message}"));
        }
        if let Some(line) = step.get("http").and_then(Value::as_str) {
            out.push(format!("http:{}", line.split('?').next().unwrap_or(line)));
        }
        if let Some(command) = step.get("agent").and_then(Value::as_str) {
            out.push(format!("agent:{command}"));
        }
        if let Some(args) = step.get("cli").and_then(Value::as_array)
            && let Some(first) = args.first().and_then(Value::as_str)
        {
            out.push(format!("cli:{first}"));
        }
        if let Some(Value::Object(connect)) = step.get("connect") {
            let path = connect.get("path").and_then(Value::as_str).unwrap_or("/ws");
            out.push(format!("http:GET {path}"));
            if path == "/ws" && connect.get("expect_refused").is_none() {
                out.push("push:hello".to_owned());
            }
            let name = connect
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("main")
                .to_owned();
            let channel = match path.split('?').next().unwrap_or(path) {
                "/api/notifications/ws" => Some("notifications"),
                "/api/voice/ws" => Some("voice"),
                "/api/voice/call/signalling" => Some("signalling"),
                _ => None,
            };
            match channel {
                Some(channel) => {
                    channels.insert(name, channel);
                }
                None => {
                    channels.remove(&name);
                }
            }
        }
    }
    for key in scenario.server.env.keys() {
        out.push(format!("env:{key}"));
    }
    for step in &scenario.steps {
        let restart_env = step.get("restart").and_then(|restart| restart.get("env"));
        for env in [step.get("env"), restart_env].into_iter().flatten() {
            if let Some(env) = env.as_object() {
                out.extend(env.keys().map(|key| format!("env:{key}")));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The family of contract/owners/families.json a scenario's family is in.
pub fn owner_family(scenario_family: &str) -> &str {
    match scenario_family {
        "herdr" => "herdr_setup",
        other => other,
    }
}

/// Runs a scenario against the server `ROAMGATE_SERVER_CMD` names, then
/// checks the recorded traffic against the contract.
pub async fn run(fake_bin: &Path, path: &Path) -> Result<()> {
    let scenario = load(path)?;
    let mut runner = Runner::new(fake_bin, &scenario).await?;
    if scenario.server.start.unwrap_or(true) {
        runner.start().await?;
    }
    let mut outcome = Ok(());
    for (index, step) in scenario.steps.iter().enumerate() {
        let step = match runner.interpolate(step) {
            Ok(step) => step,
            Err(error) => {
                outcome = Err(error.context(format!("step {} ({step})", index + 1)));
                break;
            }
        };
        let times = step.get("repeat").and_then(Value::as_u64).unwrap_or(1);
        let mut failed = None;
        for round in 0..times {
            runner.vars.insert("ROUND".into(), json!(round));
            let step = match runner.interpolate(&scenario.steps[index]) {
                Ok(step) => step,
                Err(error) => {
                    failed = Some(error);
                    break;
                }
            };
            // `retry: <ms>`: an assertion repeated (every 50 ms of real
            // time) until it holds, for state the server writes after real
            // I/O (a model's answer, a SQLite commit).
            let retry = step
                .get("retry")
                .and_then(Value::as_u64)
                .map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms));
            let result = loop {
                let result = runner.step(&step).await;
                match (&result, retry) {
                    (Err(_), Some(deadline)) if tokio::time::Instant::now() < deadline => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    _ => break result,
                }
            };
            if let Err(error) = result {
                failed = Some(error.context(format!("round {round}")));
                break;
            }
        }
        if let Some(error) = failed {
            outcome = Err(error.context(format!("step {} {}", index + 1, step)));
            break;
        }
    }
    runner.close_sockets();
    // The hybrid build: the core was up (run.rs check_core).
    if outcome.is_ok() {
        outcome = runner.run.check_core().await;
    }
    // A family a hybrid run gives to Rust: the core served the scenario.
    if outcome.is_ok() {
        let family = owner_family(&scenario.family);
        if crate::run::rust_owners().iter().any(|name| name == family)
            && !runner
                .run
                .core_served()
                .lines()
                .any(|line| line.split(' ').next() == Some(family))
        {
            outcome = Err(anyhow::anyhow!(
                "hybrid: {family} is Rust's (PARITY_RUST_OWNERS) but the core served nothing of it"
            ));
        }
    }
    let _ = runner.run.stop().await;
    if let Err(error) = outcome {
        let log = runner.run.log_text();
        let tail: String = log
            .lines()
            .rev()
            .take(60)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(error.context(format!(
            "{}\n--- server output (last lines) ---\n{tail}",
            scenario.name
        )));
    }
    // PARITY_RECORDINGS_DIR keeps every run's recording (to census shapes
    // and type contract entries from them).
    if let Some(keep) = std::env::var_os("PARITY_RECORDINGS_DIR") {
        let into = PathBuf::from(keep).join(format!("{}-{}", scenario.family, scenario.file_stem));
        std::fs::create_dir_all(&into)?;
        for entry in std::fs::read_dir(&runner.run.record_dir)
            .into_iter()
            .flatten()
            .flatten()
        {
            let _ = std::fs::copy(entry.path(), into.join(entry.file_name()));
        }
    }
    let report = record::check(&runner.run.record_dir)?;
    record::enforce(&report, &scenario.contract_exceptions)
        .with_context(|| scenario.name.clone())?;
    Ok(())
}

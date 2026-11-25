//! The machines the archive covers and how to reach them (archive/hosts.ts).
//! This machine is read in place; an ssh host is pulled into a mirror with
//! rsync (incremental, over its own connection) or pushes into that mirror
//! itself, and the mirror is then synced like a local directory.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::Agent;
use roamgate_agents::js::{js_lower, js_trim};
use serde_json::Value;

use crate::settings::{ArchiveSettings, HostSpec, PathStyle, PushSettings};

/// An environment: a variable's value, if set.
pub type EnvFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What the archive works on: this machine's home, environment and data.
#[derive(Clone)]
pub struct ArchiveRuntime {
    pub home_dir: PathBuf,
    /// Node's `process.platform`.
    pub platform: String,
    pub env: EnvFn,
    /// Roamgate's data directory (settings.json, connections.json).
    pub data_dir: PathBuf,
    /// The data context, for the safe path checks of its databases.
    pub context: roamgate_base::paths::DataContext,
    /// `os.hostname()`.
    pub hostname: String,
}

impl ArchiveRuntime {
    pub fn var(&self, name: &str) -> Option<String> {
        (self.env)(name)
    }
}

/// A host resolved from settings and connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHost {
    pub id: String,
    /// This machine.
    pub self_host: bool,
    pub ssh: Option<String>,
    pub home: Option<String>,
    pub path_style: PathStyle,
    pub roots: IndexMap<String, String>,
    pub enabled: bool,
}

pub static SAFE_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").unwrap());

struct Profile {
    id: Value,
    label: Value,
    kind: Value,
    ssh_destination: Value,
}

fn read_profiles(runtime: &ArchiveRuntime) -> Vec<Profile> {
    let path = runtime
        .var("ROAMGATE_CONNECTIONS_PATH")
        .map(|path| js_trim(&path).to_owned())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime.data_dir.join("connections.json"));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    match parsed.get("profiles") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| Profile {
                id: item.get("id").cloned().unwrap_or(Value::Null),
                label: item.get("label").cloned().unwrap_or(Value::Null),
                kind: item.get("type").cloned().unwrap_or(Value::Null),
                ssh_destination: item.get("ssh_destination").cloned().unwrap_or(Value::Null),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn host_id_of(profile: &Profile) -> Option<String> {
    let raw = match (&profile.label, &profile.id) {
        (Value::String(label), _) if !js_trim(label).is_empty() => label.clone(),
        (_, Value::String(id)) => id.clone(),
        _ => String::new(),
    };
    let lowered = js_lower(js_trim(&raw));
    let mut id = String::with_capacity(lowered.len());
    let mut in_run = false;
    for c in lowered.chars() {
        let keep = c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-');
        if keep {
            id.push(c);
            in_run = false;
        } else {
            if !in_run {
                id.push('-');
            }
            in_run = true;
        }
    }
    SAFE_HOST.is_match(&id).then_some(id)
}

/// This machine's name in the archive.
pub fn self_host_id(settings: &ArchiveSettings, runtime: &ArchiveRuntime) -> String {
    let configured = runtime
        .var("ROAMGATE_ARCHIVE_HOST")
        .map(|host| js_trim(&host).to_owned())
        .filter(|host| !host.is_empty())
        .or_else(|| settings.host.clone());
    if let Some(configured) = configured.filter(|host| SAFE_HOST.is_match(host)) {
        return configured;
    }
    let local = read_profiles(runtime)
        .into_iter()
        .find(|profile| profile.kind == Value::String("local".into()));
    if let Some(id) = local.as_ref().and_then(host_id_of) {
        return id;
    }
    let short = js_lower(runtime.hostname.split('.').next().unwrap_or("host"));
    if SAFE_HOST.is_match(&short) {
        short
    } else {
        "host".into()
    }
}

/// The hosts in play: this machine, the ssh profiles of Roamgate's own
/// connections, and the configured ones on top.
pub fn resolve_hosts(settings: &ArchiveSettings, runtime: &ArchiveRuntime) -> Vec<ResolvedHost> {
    let self_id = self_host_id(settings, runtime);
    let mut specs: IndexMap<String, HostSpec> = IndexMap::new();
    for profile in read_profiles(runtime) {
        let Some(id) = host_id_of(&profile) else {
            continue;
        };
        if id == self_id {
            continue;
        }
        if profile.kind == Value::String("ssh".into())
            && let Value::String(destination) = &profile.ssh_destination
        {
            specs.insert(
                id,
                HostSpec {
                    ssh: Some(destination.clone()),
                    ..HostSpec::default()
                },
            );
        }
    }
    for (id, spec) in &settings.hosts {
        let merged = match specs.get(id) {
            // `{ ...specs.get(id), ...spec }`: the configured keys win.
            Some(base) => HostSpec {
                ssh: spec.ssh.clone().or_else(|| base.ssh.clone()),
                home: spec.home.clone().or_else(|| base.home.clone()),
                path_style: spec.path_style.or(base.path_style),
                roots: spec.roots.clone().or_else(|| base.roots.clone()),
                enabled: spec.enabled.or(base.enabled),
            },
            None => spec.clone(),
        };
        specs.insert(id.clone(), merged);
    }
    let mut hosts = vec![ResolvedHost {
        id: self_id.clone(),
        self_host: true,
        ssh: None,
        home: Some(runtime.home_dir.to_string_lossy().into_owned()),
        path_style: if runtime.platform == "win32" {
            PathStyle::Windows
        } else {
            PathStyle::Posix
        },
        roots: settings
            .hosts
            .get(&self_id)
            .and_then(|spec| spec.roots.clone())
            .unwrap_or_default(),
        enabled: true,
    }];
    for (id, spec) in specs {
        if id == self_id || !SAFE_HOST.is_match(&id) {
            continue;
        }
        hosts.push(ResolvedHost {
            enabled: spec.enabled != Some(false) && spec.ssh.is_some(),
            id,
            self_host: false,
            ssh: spec.ssh,
            home: spec.home,
            path_style: spec.path_style.unwrap_or_default(),
            roots: spec.roots.unwrap_or_default(),
        });
    }
    hosts
}

/// The agents the settings archive, in their order.
pub fn enabled_adapters(settings: &ArchiveSettings) -> Vec<Agent> {
    settings
        .agents
        .iter()
        .filter_map(|id| Agent::from_id(id))
        .collect()
}

/// The session root of an agent on this machine.
pub fn local_root(agent: Agent, host: &ResolvedHost, runtime: &ArchiveRuntime) -> PathBuf {
    match host.roots.get(agent.id()) {
        Some(root) => PathBuf::from(root),
        None => agent.root_for(&runtime.home_dir, &|name: &str| runtime.var(name)),
    }
}

/// Where a remote host's agent files are mirrored: tree/ and extra/.
pub fn mirror_dir(archive_dir: &Path, host: &str, agent: &str) -> PathBuf {
    archive_dir.join("mirror").join(host).join(agent)
}

/// What a process gave.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a process to its end (tests swap it).
pub trait Exec: Send + Sync {
    fn run(&self, argv: &[String], timeout: Duration) -> ExecResult;
}

/// The default timeout of an archive transfer.
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Runs processes for real, killed at their timeout.
pub struct SystemExec;

impl Exec for SystemExec {
    fn run(&self, argv: &[String], timeout: Duration) -> ExecResult {
        run_process(argv, timeout, None)
    }
}

/// Runs `argv` to its end (killed after `timeout`), stdin ignored.
pub fn run_process(
    argv: &[String],
    timeout: Duration,
    env: Option<&[(String, String)]>,
) -> ExecResult {
    use std::io::Read;
    let Some((program, args)) = argv.split_first() else {
        return ExecResult {
            code: 127,
            ..ExecResult::default()
        };
    };
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(env) = env {
        command.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ExecResult {
                code: if error.kind() == std::io::ErrorKind::NotFound {
                    127
                } else {
                    1
                },
                stdout: String::new(),
                stderr: error.to_string(),
            };
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = stdout.read_to_end(&mut text);
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = stderr.read_to_end(&mut text);
        text
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    ExecResult {
        code: status.map_or(1, exit_code),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

/// Bun's exit code: the code, or 128 plus the signal.
pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// ssh options: BatchMode, a connect timeout, never a shared master.
pub const SSH_OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
];

fn rsync_shell() -> String {
    format!("ssh {}", SSH_OPTIONS.join(" "))
}

/// The rsync options of every archive transfer: incremental in place, and
/// compressed (`-z`).
pub fn rsync_base() -> Vec<String> {
    [
        "rsync",
        "-rt",
        "-z",
        "--inplace",
        "--partial",
        "--mkpath",
        "--timeout=120",
        "-e",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .chain([rsync_shell()])
    .collect()
}

/// Single-quote a word for a POSIX shell.
pub fn sh_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

fn ssh_argv(destination: &str, command: &str) -> Vec<String> {
    std::iter::once("ssh".to_owned())
        .chain(SSH_OPTIONS.iter().map(|s| (*s).to_owned()))
        .chain([destination.to_owned(), command.to_owned()])
        .collect()
}

/// The user's home on an ssh host, asked with POSIX sh only.
pub fn remote_home(exec: &dyn Exec, ssh: &str) -> Option<String> {
    let result = exec.run(
        &ssh_argv(ssh, "printf %s \"$HOME\""),
        Duration::from_secs(60),
    );
    let home = js_trim(&result.stdout).to_owned();
    (result.code == 0 && home.starts_with('/')).then_some(home)
}

/// A host that could not be reached.
#[derive(Debug, Clone)]
pub struct UnreachableHost(pub String);

fn trimmed_head(text: &str, chars: usize) -> String {
    roamgate_agents::js::utf16_prefix(js_trim(text), chars).to_owned()
}

fn remote_root(agent: Agent, host: &ResolvedHost, home: Option<&str>) -> Option<String> {
    if let Some(root) = host.roots.get(agent.id()) {
        return Some(root.clone());
    }
    let home = home?;
    Some(
        agent
            .root_for(Path::new(home), &roamgate_agents::NoEnv)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Pull one agent of an ssh host into its mirror. False when the agent has
/// no sessions there.
pub fn pull_agent(
    exec: &dyn Exec,
    archive_dir: &Path,
    host: &ResolvedHost,
    agent: Agent,
    home: Option<&str>,
) -> Result<bool, crate::PullError> {
    let Some(ssh) = &host.ssh else {
        return Ok(false);
    };
    if host.path_style == PathStyle::Windows {
        return Err(crate::PullError::Other(
            "windows hosts are not supported yet".into(),
        ));
    }
    if agent.snapshot_sqlite() {
        return Ok(false); // live sqlite files are not copied remotely
    }
    let Some(root) = remote_root(agent, host, home) else {
        return Ok(false);
    };
    let mirror = mirror_dir(archive_dir, &host.id, agent.id());
    let mut argv = rsync_base();
    argv.extend(agent.rsync_filters().iter().map(|s| (*s).to_owned()));
    argv.push(format!("{ssh}:{root}/"));
    argv.push(format!("{}/", mirror.join("tree").display()));
    let tree = exec.run(&argv, TRANSFER_TIMEOUT);
    if tree.code == 23 || tree.code == 24 {
        // Missing source dir (23) or files vanished (24): the rest was copied.
        if !tree.stderr.contains("No such file or directory") || tree.code == 24 {
            return Ok(true);
        }
        return Ok(false);
    }
    if tree.code != 0 {
        return Err(crate::PullError::Unreachable(UnreachableHost(format!(
            "rsync {ssh}: exit {} {}",
            tree.code,
            trimmed_head(&tree.stderr, 300)
        ))));
    }
    for extra in agent.extra_files() {
        let mut argv = rsync_base();
        argv.push(format!("{ssh}:{}/{}", home.unwrap_or("~"), extra.home_path));
        argv.push(
            mirror
                .join("extra")
                .join(extra.relpath)
                .display()
                .to_string(),
        );
        let result = exec.run(&argv, TRANSFER_TIMEOUT);
        if result.code != 0 && result.code != 23 {
            return Err(crate::PullError::Unreachable(UnreachableHost(format!(
                "rsync {ssh}: exit {}",
                result.code
            ))));
        }
    }
    Ok(true)
}

/// Push this machine's files for one agent into the archive home's mirror.
pub fn push_agent(
    exec: &dyn Exec,
    push: &PushSettings,
    host_id: &str,
    agent: Agent,
    root: &Path,
    extras: &[(PathBuf, String)],
) -> Result<(), UnreachableHost> {
    let remote = push
        .archive_dir
        .as_deref()
        .unwrap_or("~/.config/roamgate/archive");
    let mirror = format!("{remote}/mirror/{host_id}/{}", agent.id());
    if root.exists() {
        let mut argv = rsync_base();
        argv.extend(agent.rsync_filters().iter().map(|s| (*s).to_owned()));
        argv.push(format!("{}/", root.display()));
        argv.push(format!("{}:{mirror}/tree/", push.target));
        let tree = exec.run(&argv, TRANSFER_TIMEOUT);
        if tree.code != 0 && tree.code != 24 {
            return Err(UnreachableHost(format!(
                "rsync {}: exit {} {}",
                push.target,
                tree.code,
                trimmed_head(&tree.stderr, 300)
            )));
        }
    }
    for (path, relpath) in extras {
        if !path.exists() {
            continue;
        }
        let mut argv = rsync_base();
        argv.push(path.display().to_string());
        argv.push(format!("{}:{mirror}/extra/{relpath}", push.target));
        let result = exec.run(&argv, TRANSFER_TIMEOUT);
        if result.code != 0 && result.code != 24 {
            return Err(UnreachableHost(format!(
                "rsync {}: exit {}",
                push.target, result.code
            )));
        }
    }
    Ok(())
}

/// Ask the archive home, over ssh with POSIX sh only, to ingest what was
/// pushed.
pub fn remote_ingest(exec: &dyn Exec, push: &PushSettings, host_id: &str) -> ExecResult {
    let binary = push
        .binary
        .clone()
        .unwrap_or_else(|| "\"$HOME/.local/bin/roamgate\"".into());
    let dir = match &push.archive_dir {
        Some(dir) if dir.starts_with('/') => format!(" --dir {}", sh_quote(dir)),
        _ => String::new(),
    };
    let command = format!(
        "exec {binary} archive ingest {}{dir} --json",
        sh_quote(host_id)
    );
    exec.run(&ssh_argv(&push.target, &command), TRANSFER_TIMEOUT)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    pub type Answer = Box<dyn Fn(&[String]) -> ExecResult + Send + Sync>;

    /// Records each command and answers with a fixed result.
    pub struct Recorder {
        pub calls: Mutex<Vec<Vec<String>>>,
        pub answer: Answer,
    }

    impl Exec for Recorder {
        fn run(&self, argv: &[String], _timeout: Duration) -> ExecResult {
            self.calls.lock().unwrap().push(argv.to_vec());
            (self.answer)(argv)
        }
    }

    pub fn runtime(home: &Path, data: &Path) -> ArchiveRuntime {
        ArchiveRuntime {
            home_dir: home.to_path_buf(),
            platform: "linux".into(),
            env: Arc::new(|_| None),
            data_dir: data.to_path_buf(),
            context: roamgate_base::paths::DataContext::new(
                home,
                roamgate_base::paths::Platform::current(),
                None,
            ),
            hostname: "Desk.local".into(),
        }
    }

    #[test]
    // Unix only: the pull's local destination is a Unix path; rsync reads
    // a Windows drive path (C:...) as a remote host.
    #[cfg(unix)]
    fn a_pull_compresses_every_rsync_transfer() {
        let recorder = Recorder {
            calls: Mutex::new(Vec::new()),
            answer: Box::new(|_| ExecResult::default()),
        };
        let host = ResolvedHost {
            id: "mac".into(),
            self_host: false,
            ssh: Some("me@mac".into()),
            home: None,
            path_style: PathStyle::Posix,
            roots: IndexMap::new(),
            enabled: true,
        };
        let pulled = pull_agent(
            &recorder,
            Path::new("/a"),
            &host,
            Agent::Claude,
            Some("/Users/me"),
        )
        .unwrap();
        assert!(pulled);
        let calls = recorder.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        for call in calls.iter() {
            assert_eq!(&call[..3], &["rsync", "-rt", "-z"]);
        }
        assert_eq!(calls[0].last().unwrap(), "/a/mirror/mac/claude/tree/");
        assert_eq!(
            calls[0][calls[0].len() - 2],
            "me@mac:/Users/me/.claude/projects/"
        );
        assert_eq!(
            calls[1][calls[1].len() - 2],
            "me@mac:/Users/me/.claude/history.jsonl"
        );
    }

    #[test]
    fn a_push_compresses_every_rsync_transfer() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("projects");
        std::fs::create_dir_all(&root).unwrap();
        let history = home.path().join("history.jsonl");
        std::fs::write(&history, "{}\n").unwrap();
        let recorder = Recorder {
            calls: Mutex::new(Vec::new()),
            answer: Box::new(|_| ExecResult::default()),
        };
        let push = PushSettings {
            target: "home".into(),
            archive_dir: None,
            binary: None,
        };
        push_agent(
            &recorder,
            &push,
            "laptop",
            Agent::Claude,
            &root,
            &[(history, "@history.jsonl".into())],
        )
        .unwrap();
        {
            let calls = recorder.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            for call in calls.iter() {
                assert!(call.contains(&"-z".to_owned()));
            }
            assert_eq!(
                calls[0].last().unwrap(),
                "home:~/.config/roamgate/archive/mirror/laptop/claude/tree/"
            );
        }
        let ingest = remote_ingest(&recorder, &push, "laptop");
        assert_eq!(ingest.code, 0);
        assert_eq!(
            recorder
                .calls
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .last()
                .unwrap(),
            "exec \"$HOME/.local/bin/roamgate\" archive ingest 'laptop' --json"
        );
    }

    #[test]
    fn hosts_come_from_connections_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("connections.json"),
            r#"{"profiles":[{"id":"local","type":"local","label":"My Desk"},{"id":"x","type":"ssh","label":"Mac Book","ssh_destination":"me@mac"}]}"#,
        )
        .unwrap();
        let runtime = runtime(dir.path(), dir.path());
        let settings = crate::settings::normalize_archive_settings(Some(&serde_json::json!({
            "hosts": {"mac-book": {"home": "/Users/me"}, "far": {"ssh": "far", "enabled": false}}
        })));
        let hosts = resolve_hosts(&settings, &runtime);
        assert_eq!(hosts[0].id, "my-desk");
        assert!(hosts[0].self_host);
        assert_eq!(hosts[1].id, "mac-book");
        assert_eq!(hosts[1].ssh.as_deref(), Some("me@mac"));
        assert_eq!(hosts[1].home.as_deref(), Some("/Users/me"));
        assert!(hosts[1].enabled);
        assert!(!hosts[2].enabled);
    }
}

//! A conversation stopped as a shell job (`suspended.ts`, the chat's
//! Ctrl+Z): its holder waits stopped in the pane's shell, and `fg` there
//! brings it back. The holder keeps what the session needs; this is what
//! the browsers are shown of it (the terminal's banner, its fg button).

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::js;
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use serde_json::Value;

use crate::driver::PaneProcess;
use crate::handover::SuspendedSpec;
use crate::holder::HolderShell;
use crate::pane_child::Form;
use crate::shared::{Obj, lease_str};

/// A stopped conversation (`SuspendedConversation`): `{pane_id,
/// session_id, title?, agent?, suspended_at, holder_pid?, job?}`.
pub type SuspendedConversation = Obj;

fn valid(value: &Value) -> bool {
    let Some(entry) = value.as_object() else {
        return false;
    };
    ["connection_id", "pane_id", "session_id", "suspended_at"]
        .iter()
        .all(|key| entry.get(*key).is_some_and(Value::is_string))
}

fn read_all(file: &PathBuf) -> Vec<Obj> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    match js::parse(&text) {
        Some(Value::Object(parsed)) => match parsed.get("suspended") {
            Some(Value::Array(entries)) => entries
                .iter()
                .filter(|entry| valid(entry))
                .filter_map(|entry| entry.as_object().cloned())
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// The conversations stopped as shell jobs, per pane of one connection,
/// kept on disk (when given a file) so a Roamgate restart still shows
/// them. Other connections' entries in the file are kept as they are.
#[derive(Clone)]
pub struct SuspendedStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    connection_id: String,
    file: Option<PathBuf>,
    data: DataContext,
    entries: Mutex<IndexMap<String, SuspendedConversation>>,
}

impl SuspendedStore {
    /// `file`: None keeps them in memory only.
    pub fn new(connection_id: &str, file: Option<PathBuf>, data: Option<DataContext>) -> Self {
        let mut entries = IndexMap::new();
        if let Some(file) = &file {
            for mut entry in read_all(file) {
                if lease_str(&entry, "connection_id") != Some(connection_id) {
                    continue;
                }
                entry.shift_remove("connection_id");
                let pane = lease_str(&entry, "pane_id").unwrap_or("").to_owned();
                entries.insert(pane, entry);
            }
        }
        Self {
            inner: Arc::new(StoreInner {
                connection_id: connection_id.to_owned(),
                file,
                data: data.unwrap_or_else(|| DataContext::from_env(&ProcessEnv)),
                entries: Mutex::new(entries),
            }),
        }
    }

    fn save(&self, entries: &IndexMap<String, SuspendedConversation>) {
        let Some(file) = &self.inner.file else {
            return;
        };
        let mut all: Vec<Value> = read_all(file)
            .into_iter()
            .filter(|entry| {
                lease_str(entry, "connection_id") != Some(self.inner.connection_id.as_str())
            })
            .map(Value::Object)
            .collect();
        for entry in entries.values() {
            let mut mine = Obj::new();
            mine.insert(
                "connection_id".into(),
                Value::from(self.inner.connection_id.clone()),
            );
            for (key, value) in entry {
                mine.insert(key.clone(), value.clone());
            }
            all.push(Value::Object(mine));
        }
        let mut contents = Obj::new();
        contents.insert("version".into(), Value::from(1));
        contents.insert("suspended".into(), Value::Array(all));
        // Kept in memory if it fails; the next change writes it again.
        let _ = self.inner.data.replace_data_file(
            file,
            format!("{}\n", js::stringify(&Value::Object(contents))).as_bytes(),
            0o600,
        );
    }

    pub fn get(&self, pane_id: &str) -> Option<SuspendedConversation> {
        self.inner.entries.lock().unwrap().get(pane_id).cloned()
    }

    pub fn all(&self) -> Vec<SuspendedConversation> {
        self.inner
            .entries
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect()
    }

    pub fn set(&self, entry: SuspendedConversation) {
        let mut entries = self.inner.entries.lock().unwrap();
        let pane = lease_str(&entry, "pane_id").unwrap_or("").to_owned();
        entries.insert(pane, entry);
        self.save(&entries);
    }

    /// True when there was one.
    pub fn delete(&self, pane_id: &str) -> bool {
        let mut entries = self.inner.entries.lock().unwrap();
        if entries.shift_remove(pane_id).is_none() {
            return false;
        }
        self.save(&entries);
        true
    }
}

/// The shell's program name ("bash", "zsh", "fish"), from Herdr's listing.
pub fn shell_name(process: Option<&PaneProcess>) -> String {
    let word = process.and_then(|process| {
        process
            .argv0
            .clone()
            .or_else(|| process.argv.as_ref().and_then(|argv| argv.first().cloned()))
            .or_else(|| {
                process
                    .cmdline
                    .as_ref()
                    .map(|cmdline| cmdline.split(' ').next().unwrap_or("").to_owned())
            })
    });
    let word = word.unwrap_or_default();
    let word = word.strip_prefix('-').unwrap_or(&word);
    word.rsplit('/').next().unwrap_or("").to_owned()
}

static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^(?i)[0-9a-f-]{8,64}$").unwrap());

/// What is typed into the pane's shell to bring a stopped conversation's
/// job back: that job by name, never the shell's current one. fish names
/// jobs by pid; the others by a word of their command line, the session id
/// the holder was started with. Quoted: zsh would read `?` as a pattern.
pub fn foreground_command(
    session_id: &str,
    holder_pid: Option<u32>,
    job: Option<&str>,
    shell: &str,
) -> Result<String, String> {
    if shell == "fish"
        && let Some(pid) = holder_pid.filter(|pid| *pid != 0)
    {
        return Ok(format!(" fg {pid}\r"));
    }
    let word = job.unwrap_or(session_id);
    if !SESSION_ID.is_match(word) {
        return Err("invalid session id".into());
    }
    Ok(format!(" fg '%?{word}'\r"))
}

/// What a holder's request says of itself and its shell; None: nothing.
pub fn parse_holder_shell(form: &Form) -> Option<HolderShell> {
    let job_control = form.get("job_control")?;
    let pid = js::number_from_text(form.get("holder_pid").unwrap_or(""));
    let job = form.get("job").unwrap_or("");
    Some(HolderShell {
        job_control: job_control == "1",
        pid: (js::is_safe_integer(pid) && pid > 0.0).then_some(pid as u32),
        job: SESSION_ID.is_match(job).then(|| job.to_owned()),
    })
}

/// What a stopped holder brought back with `fg` kept of its session; None
/// when it is not one (an invalid session id or directory, say).
pub fn parse_suspended_spec(form: &Form) -> Option<SuspendedSpec> {
    let session_id = form.get("session").unwrap_or("");
    let cwd = form.get("cwd").unwrap_or("");
    if !SESSION_ID.is_match(session_id) || !cwd.starts_with('/') {
        return None;
    }
    let args = js::parse(form.get("terminal_args").unwrap_or("[]"))?;
    let args = args.as_array()?;
    if args.len() > 64 {
        return None;
    }
    let terminal_args = args
        .iter()
        .map(|each| {
            each.as_str()
                .filter(|each| js::len16(each) < 4096)
                .map(str::to_owned)
        })
        .collect::<Option<Vec<String>>>()?;
    Some(SuspendedSpec {
        session_id: session_id.to_owned(),
        cwd: cwd.to_owned(),
        agent: None,
        terminal_args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_agents::obj;

    #[test]
    fn fg_names_the_job_by_its_session_id_or_by_pid_in_fish() {
        assert_eq!(
            foreground_command("abcdef12-0000", Some(77), None, "bash").unwrap(),
            " fg '%?abcdef12-0000'\r"
        );
        assert_eq!(
            foreground_command("abcdef12-0000", Some(77), Some("12345678-aaaa"), "zsh").unwrap(),
            " fg '%?12345678-aaaa'\r"
        );
        assert_eq!(
            foreground_command("abcdef12-0000", Some(77), None, "fish").unwrap(),
            " fg 77\r"
        );
        assert!(foreground_command("x'; rm -rf /", None, None, "bash").is_err());
        let process = |argv0: Option<&str>, argv: Option<Vec<String>>| PaneProcess {
            pid: 1,
            argv0: argv0.map(str::to_owned),
            argv,
            ..PaneProcess::default()
        };
        assert_eq!(shell_name(Some(&process(Some("-zsh"), None))), "zsh");
        assert_eq!(
            shell_name(Some(&process(None, Some(vec!["/usr/bin/fish".into()])))),
            "fish"
        );
    }

    #[test]
    fn a_holder_says_its_shell_and_what_fg_brings_back() {
        let form = Form::from_pairs(&[
            ("job_control", "1"),
            ("holder_pid", "4321"),
            ("job", "11111111-2222"),
        ]);
        assert_eq!(
            parse_holder_shell(&form),
            Some(HolderShell {
                job_control: true,
                pid: Some(4321),
                job: Some("11111111-2222".into())
            })
        );
        assert_eq!(parse_holder_shell(&Form::from_pairs(&[])), None);
        let spec = Form::from_pairs(&[
            ("session", "11111111-2222"),
            ("cwd", "/w"),
            ("terminal_args", "[\"--model\",\"opus\"]"),
        ]);
        assert_eq!(
            parse_suspended_spec(&spec),
            Some(SuspendedSpec {
                session_id: "11111111-2222".into(),
                cwd: "/w".into(),
                agent: None,
                terminal_args: vec!["--model".into(), "opus".into()],
            })
        );
        assert_eq!(
            parse_suspended_spec(&Form::from_pairs(&[("session", "x"), ("cwd", "/w")])),
            None
        );
        assert_eq!(
            parse_suspended_spec(&Form::from_pairs(&[
                ("session", "11111111-2222"),
                ("cwd", "w")
            ])),
            None
        );
    }

    #[test]
    fn stopped_conversations_keep_the_other_connections_entries() {
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), roamgate_base::paths::Platform::current(), None);
        let file = home.path().join("conversation-suspended.json");
        let one = SuspendedStore::new("local", Some(file.clone()), Some(data.clone()));
        let two = SuspendedStore::new("ssh:b", Some(file.clone()), Some(data.clone()));
        one.set(obj! {"pane_id" => "p1", "session_id" => "s1", "suspended_at" => "2026-11-19T00:00:00.000Z"});
        two.set(obj! {"pane_id" => "p1", "session_id" => "s2", "suspended_at" => "2026-11-19T00:00:00.000Z"});
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\"version\":1,\"suspended\":[{\"connection_id\":\"local\",\"pane_id\":\"p1\",\"session_id\":\"s1\",\"suspended_at\":\"2026-11-19T00:00:00.000Z\"},{\"connection_id\":\"ssh:b\",\"pane_id\":\"p1\",\"session_id\":\"s2\",\"suspended_at\":\"2026-11-19T00:00:00.000Z\"}]}\n"
        );
        let again = SuspendedStore::new("local", Some(file.clone()), Some(data));
        assert_eq!(again.get("p1").unwrap()["session_id"], "s1");
        assert!(again.get("p1").unwrap().get("connection_id").is_none());
        assert!(again.delete("p1"));
        assert!(!again.delete("p1"));
        assert!(!std::fs::read_to_string(&file).unwrap().contains("\"s1\""));
    }
}

//! `roamgate owners`: shows and flips the owners table,
//! `<data>/runtime/owners.json` (contract/wire/core-channel.md, Owners
//! table). Hidden and temporary like the channel: the flip command of the
//! plan's section 8.1 gate, run on dogfood instead of editing the file by
//! hand. The server only reads the table (it follows each change); this
//! command is its one writer.

use std::path::{Path, PathBuf};

use roamgate_base::env::Env;
use roamgate_base::paths::DataContext;
use roamgate_sidecar::owners::families;
use serde_json::{Map, Value, json};

pub const OWNERS_USAGE: &str = "Usage:
  roamgate owners                          show who owns each family
  roamgate owners set <family>... rust|bun give families to a side
  roamgate owners shadow on|off|<rate>     turn shadow reads on or off, or set their rate (0 to 1)

The running server follows <data>/runtime/owners.json as it changes; a
family goes to Rust only while the server's core is connected and
implements it.
";

/// The table's file under the data root of `env`.
pub fn owners_path(env: &dyn Env) -> PathBuf {
    DataContext::from_env(env)
        .data_root()
        .join("runtime")
        .join("owners.json")
}

fn read_table(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(
                json!({"version": 1, "owners": {}, "shadow": {"enabled": true, "rate": 0.1}})
                    .as_object()
                    .cloned()
                    .unwrap(),
            );
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not JSON ({error}): fix it first", path.display()))?;
    let Value::Object(table) = value else {
        return Err(format!(
            "{} is not a JSON object: fix it first",
            path.display()
        ));
    };
    if table.get("version") != Some(&json!(1)) {
        return Err(format!("{} is not version 1: fix it first", path.display()));
    }
    Ok(table)
}

fn write_table(env: &dyn Env, path: &Path, table: &Map<String, Value>) -> Result<(), String> {
    let context = DataContext::from_env(env);
    if let Some(dir) = path.parent() {
        roamgate_base::private::create_private_dir(dir)
            .map_err(|error| format!("cannot make {}: {error}", dir.display()))?;
    }
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(table.clone())).unwrap()
    );
    context
        .replace_data_file(path, text.as_bytes(), 0o600)
        .map_err(|error| format!("cannot write {}: {error}", path.display()))
}

fn side_of(table: &Map<String, Value>, family: &str) -> &'static str {
    match table
        .get("owners")
        .and_then(|owners| owners.get(family))
        .and_then(Value::as_str)
    {
        Some("rust") => "rust",
        _ => "bun",
    }
}

/// The family the table does not choose: which front holds the port is
/// the service's start command (`roamgate front`, or the Bun server).
const FRONT: &str = "front";

/// Which front runs, from the channel sockets of `runtime`: each front
/// listens on `core-<its pid>.sock` for its core, so a live owner whose
/// command line is `roamgate front` is the Rust front, a live Bun owner the
/// Bun front (a Rust front's Bun core has a socket of its own too: the Rust
/// front wins). "none" without a live owner, "unknown" where command lines
/// cannot be read.
fn running_front(runtime: &Path, cmdline: &dyn Fn(u32) -> Option<Vec<String>>) -> &'static str {
    let Ok(entries) = std::fs::read_dir(runtime) else {
        return "none";
    };
    let mut seen = "none";
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .strip_prefix("core-")
            .and_then(|rest| rest.strip_suffix(".sock"))
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(args) = cmdline(pid) else {
            continue;
        };
        let program = args
            .first()
            .and_then(|arg| Path::new(arg).file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if program.starts_with("roamgate") && args.iter().skip(1).any(|arg| arg == "front") {
            return "rust";
        }
        if program == "bun" || program.starts_with("roamgate") {
            seen = "bun";
        } else if seen == "none" {
            seen = "unknown";
        }
    }
    seen
}

/// A live process's command line (Linux's /proc); None when it is gone or
/// cannot be read.
fn proc_cmdline(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<String> = raw
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect();
    (!args.is_empty()).then_some(args)
}

fn show(table: &Map<String, Value>, front: &str, out: &mut String) {
    for (name, family) in families() {
        if family.test {
            continue;
        }
        let phase = family
            .phase
            .map(|phase| format!("phase {phase}"))
            .unwrap_or_default();
        if name == FRONT {
            out.push_str(&format!(
                "{name:<16} {front:<5} {phase} (the running server's, chosen by its start command)\n"
            ));
            continue;
        }
        out.push_str(&format!("{name:<16} {:<5} {phase}\n", side_of(table, name)));
    }
    let shadow = table.get("shadow").cloned().unwrap_or(Value::Null);
    let enabled = shadow
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let rate = shadow.get("rate").and_then(Value::as_f64).unwrap_or(0.1);
    out.push_str(&format!(
        "shadow reads     {}, rate {rate}\n",
        if enabled { "on" } else { "off" }
    ));
}

/// Runs `roamgate owners <args>`: the exit code, what to print on stdout,
/// and on stderr.
pub fn run(env: &dyn Env, args: &[String]) -> (u8, String, String) {
    let path = owners_path(env);
    let mut table = match read_table(&path) {
        Ok(table) => table,
        Err(message) => return (1, String::new(), format!("roamgate owners: {message}\n")),
    };
    let mut out = String::new();
    match args.first().map(String::as_str) {
        None | Some("show") => {
            let runtime = path.parent().map(Path::to_path_buf).unwrap_or_default();
            show(&table, running_front(&runtime, &proc_cmdline), &mut out);
            return (0, out, String::new());
        }
        Some("--help" | "-h" | "help") => return (0, OWNERS_USAGE.into(), String::new()),
        Some("set") => {
            let (Some(side), Some(names)) = (args.last(), args.get(1..args.len() - 1)) else {
                return (2, String::new(), OWNERS_USAGE.into());
            };
            if names.is_empty() || !matches!(side.as_str(), "rust" | "bun") {
                return (2, String::new(), OWNERS_USAGE.into());
            }
            for name in names {
                if name == FRONT {
                    return (
                        2,
                        String::new(),
                        "roamgate owners: the front is not in the table: the service's start command chooses it (`roamgate front` or the Bun server)\n".into(),
                    );
                }
                if !families()
                    .get(name.as_str())
                    .is_some_and(|family| !family.test)
                {
                    return (
                        2,
                        String::new(),
                        format!("roamgate owners: no family {name}\n"),
                    );
                }
            }
            let owners = table
                .entry("owners")
                .or_insert_with(|| Value::Object(Map::new()));
            if !owners.is_object() {
                *owners = Value::Object(Map::new());
            }
            let owners = owners.as_object_mut().unwrap();
            for name in names {
                if side == "rust" {
                    owners.insert(name.clone(), json!("rust"));
                } else {
                    owners.remove(name.as_str());
                }
            }
        }
        Some("shadow") => {
            let setting = match args.get(1).map(String::as_str) {
                Some("on") => ("enabled", json!(true)),
                Some("off") => ("enabled", json!(false)),
                Some(rate) => match rate.parse::<f64>() {
                    Ok(rate) if (0.0..=1.0).contains(&rate) => ("rate", json!(rate)),
                    _ => return (2, String::new(), OWNERS_USAGE.into()),
                },
                None => return (2, String::new(), OWNERS_USAGE.into()),
            };
            let shadow = table
                .entry("shadow")
                .or_insert_with(|| json!({"enabled": true, "rate": 0.1}));
            if !shadow.is_object() {
                *shadow = json!({"enabled": true, "rate": 0.1});
            }
            shadow
                .as_object_mut()
                .unwrap()
                .insert(setting.0.into(), setting.1);
        }
        Some(other) => {
            return (
                2,
                String::new(),
                format!("roamgate owners: unknown command {other}\n\n{OWNERS_USAGE}"),
            );
        }
    }
    // The CLI pass-through runs the binary that last wrote the table.
    if let Ok(exe) = std::env::current_exe() {
        table.insert("core".into(), json!(exe.display().to_string()));
    }
    if let Err(message) = write_table(env, &path, &table) {
        return (1, String::new(), format!("roamgate owners: {message}\n"));
    }
    let runtime = path.parent().map(Path::to_path_buf).unwrap_or_default();
    show(&table, running_front(&runtime, &proc_cmdline), &mut out);
    (0, out, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &Path) -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([("HOME".into(), home.display().to_string())])
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[cfg(unix)]
    #[test]
    fn flips_families_and_shadow_reads_and_keeps_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        let (code, out, _) = run(&env, &[]);
        assert_eq!(code, 0);
        assert!(out.contains("limit_resume     bun"), "{out}");
        assert!(!out.contains("test.echo"));

        let (code, out, _) = run(&env, &args(&["set", "limit_resume", "update", "rust"]));
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("limit_resume     rust"));
        let path = owners_path(&env);
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({"version": 1, "owners": {"limit_resume": "rust", "update": "rust"}, "shadow": {"enabled": true, "rate": 0.1}, "core": std::env::current_exe().unwrap().display().to_string()})
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        assert_eq!(run(&env, &args(&["set", "update", "bun"])).0, 0);
        assert_eq!(run(&env, &args(&["shadow", "off"])).0, 0);
        assert_eq!(run(&env, &args(&["shadow", "0.5"])).0, 0);
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({"version": 1, "owners": {"limit_resume": "rust"}, "shadow": {"enabled": false, "rate": 0.5}, "core": std::env::current_exe().unwrap().display().to_string()})
        );
    }

    #[test]
    fn the_front_line_names_the_front_that_holds_the_port() {
        let dir = tempfile::tempdir().unwrap();
        let sock =
            |pid: u32| std::fs::write(dir.path().join(format!("core-{pid}.sock")), "").unwrap();
        let lines = |table: &[(u32, &[&str])]| {
            let table: Vec<(u32, Vec<String>)> = table
                .iter()
                .map(|(pid, args)| (*pid, args.iter().map(|arg| (*arg).to_owned()).collect()))
                .collect();
            move |pid: u32| {
                table
                    .iter()
                    .find(|(p, _)| *p == pid)
                    .map(|(_, a)| a.clone())
            }
        };
        assert_eq!(running_front(dir.path(), &lines(&[])), "none");
        sock(10);
        sock(20);
        // A Bun front alone, its socket from a gone server left behind.
        let bun = lines(&[(20, &["/home/u/.bun/bin/bun", "/srv/server/src/index.ts"])]);
        assert_eq!(running_front(dir.path(), &bun), "bun");
        // The Rust front and its Bun core, each with its socket.
        let rust = lines(&[
            (
                10,
                &["/home/u/.local/share/roamgate/core/roamgate", "front"],
            ),
            (20, &["bun", "run", "/srv/server/src/index.ts"]),
        ]);
        assert_eq!(running_front(dir.path(), &rust), "rust");
        let other = lines(&[(10, &["/usr/bin/python3"])]);
        assert_eq!(running_front(dir.path(), &other), "unknown");

        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        let (code, _, err) = run(&env, &args(&["set", "front", "rust"]));
        assert_eq!(code, 2);
        assert!(err.contains("start command"), "{err}");
        let (_, out, _) = run(&env, &[]);
        assert!(
            out.contains("front            none  phase 7 (the running server's"),
            "{out}"
        );
    }

    #[test]
    fn refuses_unknown_families_sides_and_broken_tables() {
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        assert_eq!(run(&env, &args(&["set", "nope", "rust"])).0, 2);
        assert_eq!(run(&env, &args(&["set", "test.echo", "rust"])).0, 2);
        assert_eq!(run(&env, &args(&["set", "work", "go"])).0, 2);
        assert_eq!(run(&env, &args(&["shadow", "2"])).0, 2);
        assert!(!owners_path(&env).exists());
        let path = owners_path(&env);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ broken").unwrap();
        let (code, _, err) = run(&env, &args(&["set", "work", "rust"]));
        assert_eq!(code, 1);
        assert!(err.contains("fix it first"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
    }
}

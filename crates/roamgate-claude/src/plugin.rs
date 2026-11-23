//! Roamgate's Claude Code mod as Roamgate ships it
//! (server/src/agent/claude-mod-plugin.ts and claude-mod-files.ts): a
//! directory marketplace under `~/.cache/roamgate/claude-plugins` (written
//! at start on this machine and on each SSH host, like the review client)
//! that lists the plugin by a relative path, so Claude Code reads it in
//! place and an update needs no reinstall. Installing is the user's choice
//! (Configuration > Integrations): Roamgate runs Claude Code's own `claude
//! plugin install` for it, and never edits Claude's settings itself.

use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;
use roamgate_agents::js::{stringify, stringify_pretty};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::mod_hub::write_mode;

/// Under the home directory, beside the review client.
pub const CLAUDE_MOD_MARKETPLACE_DIR: &str = ".cache/roamgate/claude-plugins";
pub const CLAUDE_MOD_NAME: &str = "roamgate";
pub const CLAUDE_MOD_MARKETPLACE: &str = "roamgate";
pub const CLAUDE_MOD_PLUGIN_ID: &str = "roamgate@roamgate";
/// Mods came in 2.1.287; 2.1.304 settled what a plugin's prompts do after
/// the user stops a turn, which the mod relies on.
pub const CLAUDE_MOD_MIN_CLAUDE: &str = "2.1.304";

const CHECKSUM_FILE: &str = ".roamgate-checksum";

/// The mod's files (server/claude-mod), carried by the binary: tests and
/// the engine's own type files are not shipped.
pub const CLAUDE_MOD_SOURCE_FILES: &[(&str, &str)] = &[
    (
        ".claude-plugin/plugin.json",
        include_str!("../../../server/claude-mod/.claude-plugin/plugin.json"),
    ),
    (
        "hooks/hooks.json",
        include_str!("../../../server/claude-mod/hooks/hooks.json"),
    ),
    (
        "hooks/register.ts",
        include_str!("../../../server/claude-mod/hooks/register.ts"),
    ),
    (
        "hooks/client.ts",
        include_str!("../../../server/claude-mod/hooks/client.ts"),
    ),
    (
        "hooks/tools.ts",
        include_str!("../../../server/claude-mod/hooks/tools.ts"),
    ),
    (
        "hooks/catalog.gen.ts",
        include_str!("../../../server/claude-mod/hooks/catalog.gen.ts"),
    ),
];

fn marketplace() -> Value {
    json!({
        "name": CLAUDE_MOD_MARKETPLACE,
        "owner": {"name": "Roamgate"},
        "plugins": [{
            "name": CLAUDE_MOD_NAME,
            "source": format!("./{CLAUDE_MOD_NAME}"),
            "description": "Roamgate's link to Claude Code sessions: tools to answer review and chat comments and message other sessions, and in Herdr panes, messages as prompts once Claude is idle and exact turns, waits, model and usage.",
        }],
    })
}

/// Every file of the marketplace, by its path under it, in the TS order.
pub static CLAUDE_MOD_FILES: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    let mut files = vec![(
        ".claude-plugin/marketplace.json".to_owned(),
        format!("{}\n", stringify_pretty(&marketplace())),
    )];
    for (path, text) in CLAUDE_MOD_SOURCE_FILES {
        files.push((format!("{CLAUDE_MOD_NAME}/{path}"), (*text).to_owned()));
    }
    files
});

/// sha256 of `JSON.stringify(Object.entries(files).sort())`, 16 hex digits.
pub static CLAUDE_MOD_CHECKSUM: LazyLock<String> = LazyLock::new(|| {
    let mut entries: Vec<&(String, String)> = CLAUDE_MOD_FILES.iter().collect();
    // Array.prototype.sort compares the entries as strings, "path,text".
    entries.sort_by(|a, b| {
        let left = format!("{},{}", a.0, a.1);
        let right = format!("{},{}", b.0, b.1);
        left.encode_utf16().cmp(right.encode_utf16())
    });
    let value = Value::Array(
        entries
            .into_iter()
            .map(|(path, text)| json!([path, text]))
            .collect(),
    );
    hex::encode(Sha256::digest(stringify(&value).as_bytes()))[..16].to_owned()
});

/// The text of one marketplace file.
pub fn claude_mod_file(path: &str) -> Option<&'static str> {
    CLAUDE_MOD_FILES
        .iter()
        .find(|(each, _)| each == path)
        .map(|(_, text)| text.as_str())
}

/// Writes the marketplace under `home` unless this version is there. Files
/// of an older version that this one no longer has are left: Claude reads
/// only what the manifests name.
pub fn write_claude_mod_plugin(home: &Path) -> std::io::Result<bool> {
    let base = home.join(CLAUDE_MOD_MARKETPLACE_DIR);
    if std::fs::read_to_string(base.join(CHECKSUM_FILE))
        .is_ok_and(|text| text.trim() == CLAUDE_MOD_CHECKSUM.as_str())
    {
        return Ok(false);
    }
    for (path, text) in CLAUDE_MOD_FILES.iter() {
        let target = base.join(path);
        if let Some(parent) = target.parent() {
            create_dir_mode(parent, 0o755)?;
        }
        let temp =
            std::path::PathBuf::from(format!("{}.{}.tmp", target.display(), std::process::id()));
        write_mode(&temp, text.as_bytes(), 0o644)?;
        std::fs::rename(&temp, &target)?;
    }
    std::fs::write(
        base.join(CHECKSUM_FILE),
        format!("{}\n", CLAUDE_MOD_CHECKSUM.as_str()),
    )?;
    Ok(true)
}

/// Removes the marketplace (tests).
pub fn remove_claude_mod_plugin(home: &Path) {
    let _ = std::fs::remove_dir_all(home.join(CLAUDE_MOD_MARKETPLACE_DIR));
}

fn create_dir_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(mode)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::create_dir_all(path)
    }
}

/// A shell command that writes `text` to standard output on a host with
/// python3, packed (deflate, then base64): the setup script travels as one
/// command argument, which Linux caps at 128 KiB.
pub fn packed_output(text: &str) -> String {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(text.as_bytes()).expect("in memory");
    let packed =
        base64::engine::general_purpose::STANDARD.encode(encoder.finish().expect("in memory"));
    format!(
        "python3 -c 'import base64,sys,zlib; sys.stdout.buffer.write(zlib.decompress(base64.b64decode(sys.argv[1])))' '{packed}'"
    )
}

/// `path.dirname` of a relative POSIX path.
fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(at) => &path[..at],
        None => ".",
    }
}

/// The marketplace for an SSH host, as lines of the review client's setup
/// script (python3 decodes; `$HOME` is the host's).
pub fn remote_claude_mod_script() -> Vec<String> {
    let checksum = CLAUDE_MOD_CHECKSUM.as_str();
    let mut lines = vec![
        format!("m=\"$HOME/{CLAUDE_MOD_MARKETPLACE_DIR}\""),
        format!("if [ \"$(cat \"$m/{CHECKSUM_FILE}\" 2>/dev/null)\" != \"{checksum}\" ]; then"),
    ];
    for (path, text) in CLAUDE_MOD_FILES.iter() {
        lines.push(format!("  mkdir -p \"$m/{}\"", dirname(path)));
        lines.push(format!(
            "  {} > \"$m/{path}.tmp\" && mv \"$m/{path}.tmp\" \"$m/{path}\"",
            packed_output(text)
        ));
    }
    lines.push(format!(
        "  printf '%s\\n' '{checksum}' > \"$m/{CHECKSUM_FILE}\""
    ));
    lines.push("fi".into());
    lines
}

/// Compares dotted versions: negative when `a` is older.
pub fn compare_versions(a: &str, b: &str) -> i64 {
    static NUMBERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:\.\d+)*").unwrap());
    let parts = |value: &str| -> Vec<i64> {
        NUMBERS
            .find(value)
            .map_or("0", |m| m.as_str())
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (left, right) = (parts(a), parts(b));
    for index in 0..left.len().max(right.len()) {
        let difference =
            left.get(index).copied().unwrap_or(0) - right.get(index).copied().unwrap_or(0);
        if difference != 0 {
            return difference;
        }
    }
    0
}

/// What the host script is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeModAction {
    Status,
    Install,
    Uninstall,
}

/// A POSIX shell script that runs Claude Code's plugin command on a host:
/// finds `claude` (PATH, else its usual places), prints its version, then
/// the command's output.
pub fn claude_mod_host_script(action: ClaudeModAction) -> String {
    let marketplace = format!("\"$HOME/{CLAUDE_MOD_MARKETPLACE_DIR}\"");
    let command = match action {
        ClaudeModAction::Install => format!(
            "\"$c\" plugin install {CLAUDE_MOD_NAME} --marketplace {marketplace} --scope user --json; echo \"ROAMGATE_EXIT=$?\"; \"$c\" plugin enable {CLAUDE_MOD_PLUGIN_ID} --scope user >/dev/null 2>&1; true"
        ),
        ClaudeModAction::Uninstall => format!(
            "\"$c\" plugin uninstall {CLAUDE_MOD_PLUGIN_ID} --scope user --json; echo \"ROAMGATE_EXIT=$?\"; \"$c\" plugin marketplace remove {CLAUDE_MOD_MARKETPLACE} >/dev/null 2>&1; true"
        ),
        ClaudeModAction::Status => "true".to_owned(),
    };
    [
        "c=\"$(command -v claude 2>/dev/null || true)\"".to_owned(),
        "if [ -z \"$c\" ]; then for p in \"$HOME/.local/bin/claude\" \"$HOME/.claude/local/claude\" /opt/homebrew/bin/claude /usr/local/bin/claude; do if [ -x \"$p\" ]; then c=\"$p\"; break; fi; done; fi".to_owned(),
        "if [ -z \"$c\" ]; then echo \"ROAMGATE_CLAUDE=\"; exit 0; fi".to_owned(),
        "echo \"ROAMGATE_CLAUDE=$c\"".to_owned(),
        "echo \"ROAMGATE_VERSION=$(\"$c\" --version 2>/dev/null | head -n 1)\"".to_owned(),
        command,
        "echo \"ROAMGATE_LIST_BEGIN\"".to_owned(),
        "\"$c\" plugin list --json 2>/dev/null || true".to_owned(),
    ]
    .join("\n")
}

/// What the host script printed, read.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeModHostOutput {
    pub claude: Option<String>,
    pub version: String,
    pub exit: Option<i64>,
    pub action_output: String,
    pub plugin: Option<Map<String, Value>>,
}

/// Reads what the host script printed.
pub fn parse_claude_mod_host_output(output: &str) -> ClaudeModHostOutput {
    static CLAUDE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^ROAMGATE_CLAUDE=(.*)$").unwrap());
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^ROAMGATE_VERSION=(.*)$").unwrap());
    static EXIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^ROAMGATE_EXIT=(\d+)$").unwrap());
    let field = |re: &Regex| {
        re.captures(output)
            .and_then(|c| c.get(1))
            .map_or(String::new(), |m| m.as_str().trim().to_owned())
    };
    let claude = field(&CLAUDE);
    let version = field(&VERSION);
    let exit = EXIT.captures(output).and_then(|c| c[1].parse::<i64>().ok());
    let begin = output.find("ROAMGATE_LIST_BEGIN");
    let version_at = output.find("ROAMGATE_VERSION=");
    let version_end = version_at.and_then(|at| output[at..].find('\n').map(|n| at + n));
    let action_output = match (version_end, begin) {
        (Some(end), Some(begin)) if begin > end => {
            EXIT.replace(&output[end + 1..begin], "").trim().to_owned()
        }
        _ => String::new(),
    };
    let mut plugin = None;
    if let Some(begin) = begin {
        let rest = output[begin + "ROAMGATE_LIST_BEGIN".len()..].trim();
        let listed = serde_json::from_str::<Value>(if rest.is_empty() { "[]" } else { rest });
        if let Ok(Value::Array(listed)) = listed {
            plugin = listed.into_iter().find_map(|each| match each {
                Value::Object(each)
                    if each.get("id").and_then(Value::as_str) == Some(CLAUDE_MOD_PLUGIN_ID)
                        && each.get("scope").map_or(Some("user"), Value::as_str)
                            == Some("user") =>
                {
                    Some(each)
                }
                _ => None,
            });
        }
    }
    ClaudeModHostOutput {
        claude: (!claude.is_empty()).then_some(claude),
        version,
        exit,
        action_output,
        plugin,
    }
}

/// The state a host's script output describes (ClaudeModInstallState).
pub fn claude_mod_state_of(output: &str, sessions: i64) -> Value {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+\.\d+\.\d+").unwrap());
    let parsed = parse_claude_mod_host_output(output);
    let plugin = parsed.plugin.as_ref();
    let from_roamgate = plugin
        .and_then(|p| p.get("readFromFolder"))
        .and_then(Value::as_str)
        .is_some_and(|folder| {
            folder.contains(&format!("{CLAUDE_MOD_MARKETPLACE_DIR}/{CLAUDE_MOD_NAME}"))
        });
    let state = |available: bool, reason: Option<String>, version: Option<&str>| {
        let mut out = Map::new();
        out.insert("min_claude".into(), json!(CLAUDE_MOD_MIN_CLAUDE));
        out.insert("sessions".into(), json!(sessions));
        out.insert("installed".into(), json!(plugin.is_some()));
        out.insert(
            "enabled".into(),
            json!(plugin.and_then(|p| p.get("enabled")) == Some(&Value::Bool(true))),
        );
        out.insert("from_roamgate".into(), json!(from_roamgate));
        out.insert("available".into(), json!(available));
        if let Some(reason) = reason {
            out.insert("reason".into(), json!(reason));
        }
        if let Some(version) = version {
            out.insert("claude_version".into(), json!(version));
        }
        Value::Object(out)
    };
    if parsed.claude.is_none() {
        return state(
            false,
            Some("Claude Code was not found on this host".into()),
            None,
        );
    }
    let Some(version) = VERSION.find(&parsed.version).map(|m| m.as_str()) else {
        return state(
            false,
            Some("Claude Code's version could not be read".into()),
            None,
        );
    };
    if compare_versions(version, CLAUDE_MOD_MIN_CLAUDE) < 0 {
        return state(
            false,
            Some(format!(
                "Claude Code {version} is older than {CLAUDE_MOD_MIN_CLAUDE}; update it (claude update) for the mod"
            )),
            Some(version),
        );
    }
    state(true, None, Some(version))
}

impl ClaudeModAction {
    /// The action a `claude_mod.<action>` call names.
    pub fn parse(action: &str) -> Option<Self> {
        match action {
            "status" => Some(Self::Status),
            "install" => Some(Self::Install),
            "uninstall" => Some(Self::Uninstall),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Install => "install",
            Self::Uninstall => "uninstall",
        }
    }
}

/// Configuration > Integrations: the mod on a connection's host
/// (`claudeModIntegration`). `unix`: whether the host is one (the mod
/// needs a Unix host); `sessions`: the panes whose Claude runs a live mod;
/// `run` runs the host script of an action and answers its output, with
/// `ROAMGATE_SCRIPT_FAILED <stderr>` after it when it failed.
pub async fn claude_mod_integration<F, Fut>(
    action: ClaudeModAction,
    unix: bool,
    sessions: i64,
    run: F,
) -> Value
where
    F: Fn(ClaudeModAction) -> Fut,
    Fut: std::future::Future<Output = String>,
{
    if !unix {
        return json!({
            "available": false,
            "reason": "The Claude mod needs a Unix host",
            "min_claude": "",
            "installed": false,
            "enabled": false,
            "from_roamgate": false,
            "sessions": sessions,
        });
    }
    if action == ClaudeModAction::Status {
        return claude_mod_state_of(&run(ClaudeModAction::Status).await, sessions);
    }
    let before = claude_mod_state_of(&run(ClaudeModAction::Status).await, sessions);
    if action == ClaudeModAction::Install && before["available"] != Value::Bool(true) {
        return before;
    }
    let output = run(action).await;
    let mut state = claude_mod_state_of(&output, sessions);
    let parsed = parse_claude_mod_host_output(&output);
    tracing::info!(
        action = action.as_str(),
        exit = ?parsed.exit,
        installed = %state["installed"],
        enabled = %state["enabled"],
        "claude mod {}",
        action.as_str()
    );
    if parsed.exit != Some(0) {
        let mut reason = parsed.action_output.clone();
        let last = reason
            .trim()
            .split('\n')
            .next_back()
            .unwrap_or("")
            .to_owned();
        if let Ok(Value::Object(said)) = serde_json::from_str::<Value>(&last) {
            let text = |value: &Value| match value {
                Value::String(text) => text.clone(),
                other => roamgate_agents::js::stringify(other),
            };
            if let Some(why) = said
                .get("error")
                .filter(|v| !v.is_null())
                .or_else(|| said.get("message").filter(|v| !v.is_null()))
            {
                reason = text(why);
            }
        }
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(": {}", roamgate_agents::js::head16(&reason, 300))
        };
        state["reason"] = json!(format!("claude plugin {} failed{reason}", action.as_str()));
    }
    state
}

#[cfg(test)]
mod tests;

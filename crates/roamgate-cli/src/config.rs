//! `roamgate config` (cli/config.ts): read and change the managed service's
//! environment file, validated as a whole before it is replaced, comments
//! and order kept.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use roamgate_base::env::roamgate_env;
use serde_json::{Map, Value, json};

use crate::args::{EXIT_FAILURE, EXIT_OK, Failure, Opt, parse_command_args, wants_help};
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use roamgate_exec::service::ServicePlatform;

use crate::service::{parse_service_environment, prepare_service_access};
use crate::service_context::{
    ServiceConfigFile, locate_service_config, read_service_setup, restart_running_service,
    service_status,
};

type Validate = fn(&str) -> Result<(), String>;

/// A setting `config` knows.
pub struct Setting {
    pub key: &'static str,
    pub description: &'static str,
    /// The value the server uses when the file does not set one.
    pub fallback: Option<&'static str>,
    pub secret: bool,
    pub validate: Option<Validate>,
    /// The server refuses to start with an invalid value, so it is checked
    /// on every write; the others strictly only when they change, so an
    /// existing value the server tolerates never blocks unrelated edits.
    pub startup: bool,
}

const fn setting(key: &'static str, description: &'static str) -> Setting {
    Setting {
        key,
        description,
        fallback: None,
        secret: false,
        validate: None,
        startup: false,
    }
}

fn assert_flag(value: &str) -> Result<(), String> {
    if value != "0" && value != "1" {
        return Err("must be 0 or 1".into());
    }
    Ok(())
}

fn assert_positive_integer(value: &str) -> Result<(), String> {
    let digits = value.bytes().all(|byte| byte.is_ascii_digit());
    let safe = value
        .parse::<u64>()
        .is_ok_and(|number| number < (1u64 << 53));
    if value.is_empty() || !digits || value.starts_with('0') || !safe {
        return Err("must be a positive integer".into());
    }
    Ok(())
}

fn assert_absolute_path(value: &str) -> Result<(), String> {
    if !std::path::Path::new(value).is_absolute() {
        return Err("must be an absolute path".into());
    }
    Ok(())
}

fn validate_host(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".:_-".contains(c));
    if !valid {
        return Err("must be a host name or IP address".into());
    }
    Ok(())
}

fn validate_port(value: &str) -> Result<(), String> {
    let digits = !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    let number: f64 = value.parse().unwrap_or(f64::NAN);
    if !digits || !(1.0..=65_535.0).contains(&number) {
        return Err("must be a port number from 1 to 65535".into());
    }
    Ok(())
}

fn validate_password(value: &str) -> Result<(), String> {
    roamgate_base::credentials::assert_valid_auth_password(value)
}

fn validate_pin(value: &str) -> Result<(), String> {
    roamgate_base::credentials::assert_valid_auth_pin(value)
}

fn validate_log_level(value: &str) -> Result<(), String> {
    roamgate_base::log::parse_log_level(value)
        .map(drop)
        .map_err(|error| error.to_string())
}

fn validate_notification_source(value: &str) -> Result<(), String> {
    crate::server_config::parse_task_notification_source(Some(value)).map(drop)
}

fn validate_ssh_host(value: &str) -> Result<(), String> {
    roamgate_exec::ssh::command::validate_ssh_destination(value)
        .map(drop)
        .map_err(|error| error.to_string())
}

fn validate_update_base_url(value: &str) -> Result<(), String> {
    crate::update::normalize_update_base_url(Some(value)).map(drop)
}

/// assertValidPushSubject: a URL, then https or a mailto address.
fn validate_push_subject(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    if url::Url::parse(value).is_err() {
        return Err("Invalid URL".into());
    }
    if !roamgate_notify::web_push::valid_push_subject(value) {
        return Err("Invalid VAPID subject".into());
    }
    Ok(())
}

pub const SETTINGS: &[Setting] = &[
    Setting {
        fallback: Some("127.0.0.1"),
        validate: Some(validate_host),
        ..setting("HOST", "listen address")
    },
    Setting {
        fallback: Some("8787"),
        validate: Some(validate_port),
        ..setting("PORT", "listen port")
    },
    Setting {
        secret: true,
        validate: Some(validate_password),
        ..setting(
            "ROAMGATE_PASSWORD",
            "fixed login password instead of a generated token",
        )
    },
    Setting {
        secret: true,
        validate: Some(validate_pin),
        ..setting(
            "ROAMGATE_PIN",
            "6..12 digit convenience login (private networks only)",
        )
    },
    Setting {
        validate: Some(assert_absolute_path),
        ..setting(
            "ROAMGATE_TLS_CERT",
            "PEM certificate chain for native HTTPS",
        )
    },
    Setting {
        validate: Some(assert_absolute_path),
        ..setting("ROAMGATE_TLS_KEY", "PEM private key for native HTTPS")
    },
    Setting {
        fallback: Some("info"),
        validate: Some(validate_log_level),
        startup: true,
        ..setting("ROAMGATE_LOG_LEVEL", "error|warn|info|debug")
    },
    Setting {
        fallback: Some("herdr"),
        validate: Some(validate_notification_source),
        startup: true,
        ..setting(
            "ROAMGATE_NOTIFICATION_SOURCE",
            "herdr|status task alert source",
        )
    },
    setting("HERDR_SOCKET_PATH", "Herdr control socket"),
    setting("HERDR_CLIENT_SOCKET_PATH", "Herdr render socket"),
    Setting {
        validate: Some(validate_ssh_host),
        startup: true,
        ..setting("HERDR_SSH_HOST", "remote Herdr over SSH (user@host)")
    },
    setting("HERDR_SESSION", "named Herdr session"),
    Setting {
        validate: Some(validate_update_base_url),
        ..setting(
            "ROAMGATE_UPDATE_BASE_URL",
            "latest-release mirror directory",
        )
    },
    Setting {
        validate: Some(assert_flag),
        ..setting("ROAMGATE_DISABLE_UPDATE_CHECK", "1 disables update checks")
    },
    Setting {
        validate: Some(assert_flag),
        ..setting(
            "ROAMGATE_ALLOW_FILE_REVEAL",
            "1 allows revealing files on the host",
        )
    },
    Setting {
        validate: Some(assert_positive_integer),
        ..setting("ROAMGATE_UPLOAD_MAX_BYTES", "maximum terminal upload size")
    },
    Setting {
        validate: Some(assert_positive_integer),
        ..setting("ROAMGATE_UPLOAD_RETENTION_HOURS", "staged upload retention")
    },
    Setting {
        validate: Some(validate_push_subject),
        ..setting(
            "ROAMGATE_WEB_PUSH_SUBJECT",
            "VAPID contact; empty disables Web Push",
        )
    },
    Setting {
        validate: Some(assert_absolute_path),
        ..setting("ROAMGATE_WEB_PUSH_PATH", "Web Push registry file")
    },
    Setting {
        validate: Some(assert_absolute_path),
        ..setting(
            "ROAMGATE_CONNECTIONS_PATH",
            "connection profile registry file",
        )
    },
    Setting {
        validate: Some(assert_absolute_path),
        ..setting("ROAMGATE_SETTINGS_PATH", "GUI settings file")
    },
];

/// Legacy HERDR_GUI_* spellings are accepted; the Roamgate name is written.
fn resolve_setting(key: &str) -> Result<&'static Setting, Failure> {
    let canonical = match key.strip_prefix("HERDR_GUI_") {
        Some(rest) => format!("ROAMGATE_{rest}"),
        None => key.to_owned(),
    };
    SETTINGS
        .iter()
        .find(|setting| setting.key == canonical)
        .ok_or_else(|| {
            Failure::usage(format!(
                "unknown setting: {key} (run `roamgate config show` for the list; edit the file directly for other variables)"
            ))
        })
}

fn legacy_alias(key: &str) -> Option<String> {
    key.strip_prefix("ROAMGATE_")
        .map(|rest| format!("HERDR_GUI_{rest}"))
}

fn effective_value(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    match key.strip_prefix("ROAMGATE_") {
        Some(suffix) => roamgate_env(env, suffix),
        None => env.get(key).cloned(),
    }
}

fn bare(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_./:@%+,=-".contains(c))
}

/// Quotes so systemd's EnvironmentFile, launchd's sh source and the Windows
/// parser all read the same value: single quotes are literal everywhere,
/// double quotes when the value has no $, `, \ or ".
pub fn encode_environment_value(value: &str) -> Result<String, String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err("values must be a single line without NUL characters".into());
    }
    if !value.is_empty() && bare(value) {
        return Ok(value.to_owned());
    }
    if !value.contains('\'') {
        return Ok(format!("'{value}'"));
    }
    if !value.contains(['$', '`', '\\', '"']) {
        return Ok(format!("\"{value}\""));
    }
    Err("values containing ' together with $, `, \\ or \" cannot be quoted for every service manager; edit the file directly".into())
}

/// Updates in order, a later one of the same key in the first one's place
/// (a JavaScript Map's `set`); None removes.
pub type Updates = Vec<(String, Option<String>)>;

fn set_update(updates: &mut Updates, key: &str, value: Option<String>) {
    match updates.iter_mut().find(|(name, _)| name == key) {
        Some(entry) => entry.1 = value,
        None => updates.push((key.to_owned(), value)),
    }
}

fn line_pattern(key: &str, comment: bool) -> regex::Regex {
    let comment = if comment { r"#\s*" } else { "" };
    regex::Regex::new(&format!(
        r"^\s*{comment}(?:export\s+)?{}\s*=",
        regex::escape(key)
    ))
    .expect("valid pattern")
}

/// Applies updates keeping comments and order: a value replaces the last
/// assignment, lands below its commented placeholder, or is appended;
/// earlier duplicate assignments go.
pub fn update_environment_file(contents: &str, updates: &Updates) -> Result<String, String> {
    let newline = if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = contents
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    for (key, value) in updates {
        let pattern = line_pattern(key, false);
        let mut assigned: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| pattern.is_match(line))
            .map(|(index, _)| index)
            .collect();
        let replacement = match value {
            None => None,
            Some(value) => Some(format!("{key}={}", encode_environment_value(value)?)),
        };
        if let Some(replacement) = &replacement
            && let Some(last) = assigned.pop()
        {
            lines[last] = replacement.clone();
        }
        let mut index = 0;
        lines.retain(|_| {
            index += 1;
            !assigned.contains(&(index - 1))
        });
        let Some(replacement) = replacement else {
            continue;
        };
        if lines.contains(&replacement) {
            continue;
        }
        let placeholder = line_pattern(key, true);
        match lines.iter().rposition(|line| placeholder.is_match(line)) {
            Some(at) => lines.insert(at + 1, replacement),
            None => lines.push(replacement),
        }
    }
    Ok(if lines.is_empty() {
        String::new()
    } else {
        format!("{}{newline}", lines.join(newline))
    })
}

fn parse(file: &ServiceConfigFile, contents: &str) -> Result<BTreeMap<String, String>, String> {
    parse_service_environment(
        contents,
        &file.config_path.display().to_string(),
        file.platform,
        &file.home.display().to_string(),
    )
}

/// Refuses a file the service would not start with; settings in
/// `strict` also get their stricter checks.
fn validate_candidate(
    file: &ServiceConfigFile,
    contents: &str,
    strict: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    let env = parse(file, contents)?;
    for setting in SETTINGS {
        let Some(validate) = setting.validate else {
            continue;
        };
        if !setting.startup && !strict.contains(setting.key) {
            continue;
        }
        let Some(value) = effective_value(&env, setting.key).filter(|value| !value.is_empty())
        else {
            continue;
        };
        validate(&value).map_err(|message| format!("{}: {message}", setting.key))?;
    }
    prepare_service_access(
        &file.config_path.display().to_string(),
        contents,
        file.platform,
        &file.home.display().to_string(),
    )?;
    Ok(env)
}

/// Settings whose effective value differs between two parsed files.
fn changed_settings(
    before: Option<&BTreeMap<String, String>>,
    after: &BTreeMap<String, String>,
) -> BTreeSet<String> {
    SETTINGS
        .iter()
        .filter(|setting| {
            before.is_none_or(|before| {
                effective_value(before, setting.key) != effective_value(after, setting.key)
            })
        })
        .map(|setting| setting.key.to_owned())
        .collect()
}

/// The names `contents` assigns, in the order a JavaScript object of the
/// parsed file lists them (first assignment first; launchd's HOME first).
fn assignment_order(contents: &str, platform: ServicePlatform) -> Vec<String> {
    let name = regex::Regex::new(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=").unwrap();
    let mut names: Vec<String> = Vec::new();
    if platform == ServicePlatform::Launchd {
        names.push("HOME".into());
    }
    for line in contents.split('\n') {
        if let Some(captures) = name.captures(line)
            && !names.iter().any(|known| known == &captures[1])
        {
            names.push(captures[1].to_owned());
        }
    }
    names
}

/// Restarts, or reminds that the running service keeps the old values.
fn apply_change(context: &CliContext, restart: bool) -> Result<i32, Failure> {
    if restart {
        return Ok(
            match restart_running_service(context).map_err(Failure::Failed)? {
                None => {
                    context.log("The service is not running; changes apply when it starts.");
                    EXIT_OK
                }
                Some(code) => {
                    if code == 0 {
                        context.log("Restarted the service.");
                    }
                    code
                }
            },
        );
    }
    // Unsupported platforms have no managed service to remind about.
    if service_status(context).is_ok_and(|status| status.active) {
        context
            .log("The running service still uses the old values; run `roamgate service restart`.");
    }
    Ok(EXIT_OK)
}

fn replace_file(
    context: &CliContext,
    file: &ServiceConfigFile,
    contents: &str,
) -> Result<(), Failure> {
    context
        .service()
        .data()
        .replace_data_file(&file.config_path, contents.as_bytes(), 0o600)
        .map_err(Failure::failed)
}

fn edit_config(args: &[String], context: &CliContext) -> Result<i32, Failure> {
    let parsed = parse_command_args(args, &[Opt::flag("restart")], 0)?;
    let file = locate_service_config(&context.runtime).map_err(Failure::Failed)?;
    if !file.config_exists {
        replace_file(context, &file, &file.contents)?;
    }
    // Repairing a broken file is a reason to edit it; all is checked after.
    let before = parse(&file, &file.contents).ok();
    let env = context.runtime.env.as_ref();
    let editor = env
        .var("VISUAL")
        .filter(|value| !value.is_empty())
        .or_else(|| env.var("EDITOR").filter(|value| !value.is_empty()))
        .unwrap_or_else(|| {
            if context.runtime.platform == "win32" {
                "notepad".into()
            } else {
                "vi".into()
            }
        });
    let mut argv: Vec<String> = editor
        .split(crate::url::js_space)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    argv.push(file.config_path.display().to_string());
    let code = context.run_command(&argv);
    if code != 0 {
        context.error(&format!("roamgate config: editor exited {code}"));
        return Ok(EXIT_FAILURE);
    }
    let edited = locate_service_config(&context.runtime).map_err(Failure::Failed)?;
    let checked = parse(&edited, &edited.contents).and_then(|after| {
        validate_candidate(
            &edited,
            &edited.contents,
            &changed_settings(before.as_ref(), &after),
        )
    });
    if let Err(message) = checked {
        context.error(&format!(
            "roamgate config: the edited file is invalid: {message}"
        ));
        context.error(
            "The service would refuse to start; run `roamgate config edit` again to fix it.",
        );
        return Ok(EXIT_FAILURE);
    }
    if edited.contents == file.contents {
        context.log("No changes.");
        return Ok(EXIT_OK);
    }
    apply_change(context, parsed.flag("restart"))
}

/// The value of `KEY=-`: standard input without its last line break.
fn read_stdin_value() -> Result<String, Failure> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(Failure::failed)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(match text.strip_suffix('\n') {
        Some(rest) => rest.strip_suffix('\r').unwrap_or(rest).to_owned(),
        None => text,
    })
}

struct Row {
    key: &'static str,
    value: Option<String>,
    source: &'static str,
    description: &'static str,
}

fn show(
    context: &CliContext,
    setup: &crate::service_context::ServiceSetup,
    rest: &[String],
) -> Result<i32, Failure> {
    let parsed = parse_command_args(rest, &[Opt::flag("reveal"), Opt::flag("json")], 0)?;
    let reveal = parsed.flag("reveal");
    let mut known: Vec<String> = Vec::new();
    let rows: Vec<Row> = SETTINGS
        .iter()
        .map(|setting| {
            known.push(setting.key.to_owned());
            if let Some(alias) = legacy_alias(setting.key) {
                known.push(alias);
            }
            let value = effective_value(&setup.env, setting.key);
            let source = match (&value, setting.fallback) {
                (Some(_), _) if setup.env.contains_key(setting.key) => "file",
                (Some(_), _) => "file (legacy name)",
                (None, Some(_)) => "default",
                (None, None) => "unset",
            };
            let shown = match value {
                None => setting.fallback.map(str::to_owned),
                Some(value) if setting.secret && !reveal && !value.is_empty() => {
                    Some("(hidden)".into())
                }
                Some(value) => Some(value),
            };
            Row {
                key: setting.key,
                value: shown,
                source,
                description: setting.description,
            }
        })
        .collect();
    let other: Vec<String> = assignment_order(&setup.contents, setup.platform)
        .into_iter()
        .filter(|key| setup.env.contains_key(key) && !known.contains(key))
        .collect();
    if parsed.flag("json") {
        let settings: Map<String, Value> = rows
            .iter()
            .map(|row| {
                (
                    row.key.to_owned(),
                    json!({ "value": row.value, "source": row.source }),
                )
            })
            .collect();
        let other = if reveal {
            Value::Object(
                other
                    .iter()
                    .map(|key| (key.clone(), json!(setup.env[key])))
                    .collect(),
            )
        } else {
            json!(other)
        };
        context.print_json(&json!({
            "path": setup.config_path.display().to_string(),
            "exists": setup.config_exists,
            "settings": settings,
            "other": other,
        }));
        return Ok(EXIT_OK);
    }
    context.log(&format!(
        "{}{}",
        context.display_path(&setup.config_path),
        if setup.config_exists {
            ""
        } else {
            " (not created yet; showing defaults)"
        }
    ));
    context.log("");
    let width = rows.iter().map(|row| row.key.len()).max().unwrap_or(0);
    for row in rows.iter().filter(|row| row.source != "unset") {
        let label = if row.source == "file" {
            String::new()
        } else {
            format!("  ({})", row.source)
        };
        let value = match row.value.as_deref() {
            Some("") => "''".to_owned(),
            Some(value) => value.to_owned(),
            None => "undefined".to_owned(),
        };
        context.log(&format!("  {:width$}  {value}{label}", row.key));
    }
    let unset: Vec<&Row> = rows.iter().filter(|row| row.source == "unset").collect();
    if !unset.is_empty() {
        context.log("");
        context.log("Not set:");
        for row in unset {
            context.log(&format!("  {:width$}  {}", row.key, row.description));
        }
    }
    if !other.is_empty() {
        context.log("");
        context.log(&format!("Other variables: {}", other.join(", ")));
    }
    Ok(EXIT_OK)
}

fn set_or_unset(
    context: &CliContext,
    setup: &crate::service_context::ServiceSetup,
    action: &str,
    rest: &[String],
) -> Result<i32, Failure> {
    let parsed = parse_command_args(rest, &[Opt::flag("restart")], usize::MAX)?;
    if parsed.positionals.is_empty() {
        return Err(Failure::usage(if action == "set" {
            "config set needs KEY=VALUE"
        } else {
            "config unset needs a KEY"
        }));
    }
    let mut updates: Updates = Vec::new();
    let mut from_stdin = false;
    for argument in &parsed.positionals {
        let (key, mut value) = if action == "set" {
            match argument.find('=') {
                Some(separator) if separator > 0 => (
                    &argument[..separator],
                    Some(argument[separator + 1..].to_owned()),
                ),
                _ => {
                    return Err(Failure::usage(format!(
                        "expected KEY=VALUE, got: {argument}"
                    )));
                }
            }
        } else {
            (argument.as_str(), None)
        };
        let setting = resolve_setting(key)?;
        if value.as_deref() == Some("-") {
            if from_stdin {
                return Err(Failure::usage(
                    "only one value can be read from standard input",
                ));
            }
            from_stdin = true;
            value = Some(read_stdin_value()?);
        } else if setting.secret && value.as_deref().is_some_and(|value| !value.is_empty()) {
            context.error(&format!(
                "Warning: {key} on the command line can be saved in shell history; prefer {key}=-",
                key = setting.key
            ));
        }
        if let (Some(value), Some(validate)) = (&value, setting.validate)
            && !value.is_empty()
        {
            validate(value)
                .map_err(|message| Failure::usage(format!("{}: {message}", setting.key)))?;
        }
        let remove = value.is_none();
        set_update(&mut updates, setting.key, value);
        // The legacy alias would take effect again after an unset: both go.
        if let Some(alias) = legacy_alias(setting.key)
            && (remove || setup.env.contains_key(&alias))
        {
            set_update(&mut updates, &alias, None);
        }
    }
    let next = update_environment_file(&setup.contents, &updates).map_err(Failure::Failed)?;
    if next == setup.contents && setup.config_exists {
        context.log("No changes.");
        return Ok(EXIT_OK);
    }
    let changed: BTreeSet<String> = updates.iter().map(|(key, _)| key.clone()).collect();
    validate_candidate(setup, &next, &changed).map_err(Failure::Failed)?;
    replace_file(context, setup, &next)?;
    context.log(&format!(
        "Updated {}",
        context.display_path(&setup.config_path)
    ));
    apply_change(context, parsed.flag("restart"))
}

/// `roamgate config <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    let Some(action) = args.first().filter(|_| !wants_help(args)) else {
        context.log(command_help("config"));
        return Ok(Outcome::Code(EXIT_OK));
    };
    let rest = &args[1..];

    // path and edit only locate the file, so they work when it is broken.
    if action == "path" {
        parse_command_args(rest, &[], 0)?;
        let file = locate_service_config(&context.runtime).map_err(Failure::Failed)?;
        context.log(&file.config_path.display().to_string());
        return Ok(Outcome::Code(EXIT_OK));
    }
    if action == "edit" {
        return edit_config(rest, context).map(Outcome::Code);
    }

    let setup = read_service_setup(&context.runtime).map_err(Failure::Failed)?;
    let code = match action.as_str() {
        "show" => show(context, &setup, rest)?,
        "get" => {
            let parsed = parse_command_args(rest, &[], 1)?;
            let [key] = parsed.positionals.as_slice() else {
                return Err(Failure::usage("config get needs one KEY"));
            };
            let setting = resolve_setting(key)?;
            match effective_value(&setup.env, setting.key) {
                Some(value) => {
                    context.log(&value);
                    EXIT_OK
                }
                None => match setting.fallback {
                    Some(fallback) => {
                        context.log(fallback);
                        EXIT_OK
                    }
                    None => EXIT_FAILURE,
                },
            }
        }
        "set" | "unset" => set_or_unset(context, &setup, action, rest)?,
        other => {
            return Err(Failure::usage(format!("unknown config action: {other}")));
        }
    };
    Ok(Outcome::Code(code))
}

#[cfg(test)]
mod tests;

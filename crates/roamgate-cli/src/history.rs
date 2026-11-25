//! `roamgate history status|commit` (server/src/cli/history.ts): the local
//! history's status, or a pass now over every area, without the server.
//! It waits for nothing: run while the server runs, the two take turns
//! (the repo's pass lock).

use std::sync::Arc;

use roamgate_agents::js;
use roamgate_base::env::Env;
use roamgate_base::paths::{DataContext, Platform};
use roamgate_history::area::{ReviewSource, history_paths};
use roamgate_history::files::read_json;
use roamgate_history::place::{HistoryPlace, history_areas, history_host, history_place};
use roamgate_history::repo::{HistoryRepo, PassInput};
use roamgate_history::reviews::SqliteReviews;
use roamgate_history::runtime::status_value;
use roamgate_voice_server::models::format_bytes;
use serde_json::{Value, json};

use crate::args::{display_path, wants_help};
use crate::commands::CliRuntime;
use crate::output::Printed;
use crate::service::read_service_environment;

const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_USAGE: i32 = 2;

pub fn history_help() -> &'static str {
    include_str!("../../../contract/cli/help/history.txt")
}

/// The service's environment over the CLI's: the paths the server uses.
struct Merged {
    service: std::collections::BTreeMap<String, String>,
    own: Arc<dyn Env>,
}

impl Env for Merged {
    fn var(&self, name: &str) -> Option<String> {
        self.service
            .get(name)
            .cloned()
            .or_else(|| self.own.var(name))
    }
}

/// `describeStatus`: the status as lines.
pub fn describe_status(status: &Value, show: &dyn Fn(&str) -> String) -> Vec<String> {
    let text = |value: &Value| js::sv(Some(value)).to_owned();
    let location = text(&status["location"]);
    let mut lines = vec![
        format!(
            "Local history: {}",
            if status["enabled"] == true {
                "on"
            } else {
                "off"
            }
        ),
        format!(
            "Location: {}{}",
            show(&location),
            if status["location"] == status["defaultLocation"] {
                " (default)"
            } else {
                ""
            }
        ),
    ];
    if status["exists"] != true {
        lines.push("No repository there yet.".into());
        return lines;
    }
    let last = &status["lastCommit"];
    lines.push(if last.is_object() {
        format!(
            "Last commit: {} {} {}",
            text(&last["at"]),
            js::head16(&text(&last["sha"]), 10),
            text(&last["subject"])
        )
    } else {
        "No commit yet.".into()
    });
    lines.push(format!(
        "Commits: {}, size {}",
        status["commits"],
        format_bytes(status["sizeBytes"].as_f64().unwrap_or(0.0))
    ));
    let mut areas: Vec<(&String, &Value)> = status["files"]
        .as_object()
        .map(|files| files.iter().collect())
        .unwrap_or_default();
    areas.sort_by(|(a, _), (b, _)| js::locale_compare(a, b));
    if !areas.is_empty() {
        lines.push(format!(
            "Files: {}",
            areas
                .iter()
                .map(|(area, n)| format!("{area} {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let pass = &status["lastPass"];
    if pass.is_object() {
        let commits = pass["commits"].as_u64().unwrap_or(0);
        lines.push(format!(
            "Last pass: {}, {} commit{}, {} ms",
            text(&pass["at"]),
            commits,
            if commits == 1 { "" } else { "s" },
            pass["ms"]
        ));
    }
    let pending: Vec<String> = status["pending"]
        .as_array()
        .into_iter()
        .flatten()
        .map(&text)
        .collect();
    if !pending.is_empty() {
        lines.push(format!("Waiting: {}", pending.join(", ")));
    }
    if let Some(deferred) = status["deferred"].as_str() {
        lines.push(format!("Deferred: {deferred}"));
    }
    for hit in status["blocked"].as_array().into_iter().flatten() {
        lines.push(format!(
            "Kept out: {}:{} holds a secret ({}); remove it from where it was written",
            text(&hit["file"]),
            hit["line"],
            text(&hit["kind"])
        ));
    }
    for error in status["errors"].as_array().into_iter().flatten() {
        lines.push(error_line(error));
    }
    lines
}

fn error_line(error: &Value) -> String {
    format!(
        "Error{}: {}",
        error["area"]
            .as_str()
            .map(|area| format!(" ({area})"))
            .unwrap_or_default(),
        js::sv(error.get("message"))
    )
}

/// `roamgate history ...`.
pub struct HistoryCli<'a> {
    pub runtime: &'a CliRuntime,
    /// The commits' host (this machine's when None).
    pub host: Option<String>,
}

impl HistoryCli<'_> {
    fn context(&self) -> DataContext {
        DataContext::new(
            &self.runtime.home,
            if self.runtime.platform == "win32" {
                Platform::Windows
            } else {
                Platform::Unix
            },
            self.runtime.app_data.clone(),
        )
    }

    fn show(&self, path: &str) -> String {
        display_path(
            path,
            &self.runtime.platform,
            &self.runtime.home.display().to_string(),
        )
    }

    pub fn run(&self, args: &[String]) -> Printed {
        let mut out = Printed::default();
        let code = self.run_into(args, &mut out);
        out.exit(code)
    }

    fn run_into(&self, args: &[String], out: &mut Printed) -> i32 {
        let Some(action) = args.first().filter(|_| !wants_help(args)) else {
            // The file is what console.log printed: its newline included.
            out.stdout.push_str(history_help());
            return EXIT_OK;
        };
        let json = args.iter().any(|arg| arg == "--json");
        if let Some(unknown) = args[1..].iter().find(|arg| *arg != "--json") {
            out.error(&format!("Unknown argument: {unknown}"));
            return EXIT_USAGE;
        }
        let env = Merged {
            service: read_service_environment(&self.runtime.service()).unwrap_or_default(),
            own: self.runtime.env.clone(),
        };
        let context = self.context();
        let paths = history_paths(&env, &context);
        let settings = read_json(&paths.settings).ok().flatten();
        let place = match history_place(settings.as_ref(), &paths.data, &env, &self.runtime.home) {
            Ok(place) => place,
            Err(error) => {
                out.error(&format!("roamgate history: {error}"));
                return EXIT_FAILURE;
            }
        };
        let host = self.host.clone().unwrap_or_else(history_host);
        let repo = HistoryRepo::new(&place.location, &host, false, None);
        let status_of =
            |place: &HistoryPlace| status_value(place, &repo.status(), Vec::new(), false, None);
        match action.as_str() {
            "status" => {
                let status = status_of(&place);
                if json {
                    out.log(&js::stringify_pretty(&status));
                } else {
                    for line in describe_status(&status, &|path| self.show(path)) {
                        out.log(&line);
                    }
                }
                EXIT_OK
            }
            "commit" => {
                if !place.enabled {
                    out.error(
                        "Local history is off (Settings, History and backup, or ROAMGATE_HISTORY).",
                    );
                    return EXIT_FAILURE;
                }
                let reviews: Arc<dyn ReviewSource> = Arc::new(SqliteReviews::new(&paths.reviews));
                let areas = history_areas(&paths, Arc::new(move || Some(reviews.clone())));
                let result = match repo.pass(&PassInput {
                    areas: areas.into_iter().map(|area| (area, None)).collect(),
                    ..PassInput::default()
                }) {
                    Ok(result) => result,
                    Err(error) => {
                        out.error(&format!("roamgate history: {error}"));
                        return EXIT_FAILURE;
                    }
                };
                if json {
                    let mut value = serde_json::to_value(&result).unwrap_or(Value::Null);
                    if let Some(object) = value.as_object_mut() {
                        object.insert("status".into(), status_of(&place));
                    }
                    out.log(&js::stringify_pretty(&value));
                    return if !result.errors.is_empty() || result.locked {
                        EXIT_FAILURE
                    } else {
                        EXIT_OK
                    };
                }
                if result.locked {
                    out.error("Another pass is running (the server's): try again in a moment.");
                    return EXIT_FAILURE;
                }
                let location = self.show(&place.location.display().to_string());
                out.log(&if result.commits > 0 {
                    format!(
                        "Committed in {location} ({} commit{}).",
                        result.commits,
                        if result.commits == 1 { "" } else { "s" }
                    )
                } else {
                    format!("Nothing changed in {location}.")
                });
                for hit in &result.blocked {
                    out.log(&format!(
                        "Kept out: {}:{} holds a secret ({})",
                        hit.file, hit.line, hit.kind
                    ));
                }
                for error in &result.errors {
                    out.error(&error_line(&json!(error)));
                }
                if result.errors.is_empty() {
                    EXIT_OK
                } else {
                    EXIT_FAILURE
                }
            }
            other => {
                out.error(&format!("Unknown history action: {other}"));
                EXIT_USAGE
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::context::testing::{shown, test_runtime};

    fn seeded() -> (tempfile::TempDir, std::path::PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let data = home.path().join(".config").join("roamgate");
        std::fs::create_dir_all(data.join("work")).unwrap();
        std::fs::write(
            data.join("settings.json"),
            json!({"version": 1, "title_suffix": "desk", "api_token": "x"}).to_string(),
        )
        .unwrap();
        std::fs::write(
            data.join("work").join("work.json"),
            json!({
                "version": 1,
                "projects": [],
                "items": [{
                    "id": "1111222233334444",
                    "project": "p",
                    "title": "T",
                    "state": "open",
                    "tags": [],
                    "links": [],
                    "createdAt": "2026-11-20T08:00:00.000Z",
                    "updatedAt": "2026-11-20T08:00:00.000Z",
                    "by": "user",
                }],
            })
            .to_string(),
        )
        .unwrap();
        (home, data)
    }

    fn run(runtime: &CliRuntime, host: Option<&str>, args: &[&str]) -> Printed {
        HistoryCli {
            runtime,
            host: host.map(str::to_owned),
        }
        .run(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn history_commit_writes_the_areas_status_shows_the_repo() {
        let (home, data) = seeded();
        let runtime = test_runtime(home.path());
        let history = shown(home.path(), ".config/roamgate/history");
        let printed = run(&runtime, Some("desk"), &["commit"]);
        assert_eq!((printed.code, printed.stderr.as_str()), (0, ""));
        assert!(
            printed
                .stdout
                .contains(&format!("Committed in {history} (1 commit)")),
            "{}",
            printed.stdout
        );
        assert!(data.join("history/work/items/1111222233334444.md").exists());
        assert!(data.join("history/settings/title_suffix.json").exists());
        let again = run(&runtime, Some("desk"), &["commit"]);
        assert_eq!(again.code, 0);
        assert_eq!(again.stdout, format!("Nothing changed in {history}.\n"));
        let status = run(&runtime, Some("desk"), &["status"]);
        assert_eq!(status.code, 0);
        assert!(status.stdout.contains("Local history: on"));
        assert!(
            status
                .stdout
                .contains(&format!("Location: {history} (default)"))
        );
        assert!(
            regex::Regex::new(r"Last commit: .* settings: title_suffix, version; work: 1 item")
                .unwrap()
                .is_match(&status.stdout),
            "{}",
            status.stdout
        );
        assert!(
            regex::Regex::new(r"Files: .*settings 2.*work 1")
                .unwrap()
                .is_match(&status.stdout),
            "{}",
            status.stdout
        );
        let json_status = run(&runtime, Some("desk"), &["status", "--json"]);
        assert_eq!(json_status.code, 0);
        let value: Value = serde_json::from_str(&json_status.stdout).unwrap();
        assert_eq!(value["enabled"], true);
        assert_eq!(value["exists"], true);
        assert_eq!(value["commits"], 2);
        assert_eq!(value["files"]["settings"], 2);
        assert_eq!(value["files"]["work"], 1);
    }

    #[test]
    fn history_off_status_says_so_commit_refuses() {
        let (home, _data) = seeded();
        let mut runtime = test_runtime(home.path());
        runtime.env = Arc::new(BTreeMap::from([(
            "ROAMGATE_HISTORY".to_owned(),
            "off".to_owned(),
        )]));
        let commit = run(&runtime, Some("desk"), &["commit"]);
        assert_eq!(commit.code, 1);
        assert!(commit.stderr.starts_with("Local history is off"));
        let status = run(&runtime, Some("desk"), &["status"]);
        assert_eq!(status.code, 0);
        assert_eq!(
            status.stdout,
            format!(
                "Local history: off\nLocation: {} (default)\nNo repository there yet.\n",
                shown(home.path(), ".config/roamgate/history")
            )
        );
    }

    #[test]
    fn unknown_actions_and_arguments_are_usage_errors() {
        let (home, _data) = seeded();
        let runtime = test_runtime(home.path());
        assert_eq!(run(&runtime, None, &["restore"]).code, 2);
        assert_eq!(run(&runtime, None, &["status", "--all"]).code, 2);
        let help = run(&runtime, None, &[]);
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("roamgate history status"));
    }
}

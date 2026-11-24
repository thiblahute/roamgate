//! Where the history repo is and whether it is written (history/place.ts):
//! on by default at `<data>/history`; Settings' `history.location` moves
//! it and `history.enabled: false` turns it off. `ROAMGATE_HISTORY=off`
//! makes off the default (test servers), which the settings can still
//! turn on.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_agents::js;
use roamgate_base::env::{Env, roamgate_env};
use serde::Serialize;
use serde_json::Value;

use crate::area::{HistoryArea, HistoryPaths, ReviewSource};
use crate::files::{
    SettingsArea, companion_area, connections_area, move_hosts_area, session_profiles_area,
    voice_area,
};
use crate::mr_reviews::MrReviewsArea;
use crate::reviews::ReviewsArea;
use crate::work::WorkArea;

/// Where the repo is and whether it is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlace {
    pub enabled: bool,
    pub location: PathBuf,
    pub default_location: PathBuf,
}

/// `history` of settings.json as the server holds it
/// (`normalizeHistorySettings`): a boolean `enabled`, a non-blank
/// `location` (trimmed).
pub fn history_settings(settings: Option<&Value>) -> (Option<bool>, Option<String>) {
    let Some(history) = settings
        .and_then(|settings| settings.get("history"))
        .and_then(Value::as_object)
    else {
        return (None, None);
    };
    let enabled = history.get("enabled").and_then(Value::as_bool);
    let location = history
        .get("location")
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|location| !location.is_empty())
        .map(str::to_owned);
    (enabled, location)
}

/// The place: settings.json's `history` (`settings`, the file's whole
/// value), the data root and the environment.
pub fn history_place(
    settings: Option<&Value>,
    data: &Path,
    env: &dyn Env,
    home: &Path,
) -> Result<HistoryPlace, String> {
    let default_location = roamgate_env(env, "HISTORY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("history"));
    let off = roamgate_env(env, "HISTORY").is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "off" | "0" | "false" | "no"
        )
    });
    let (enabled, location) = history_settings(settings);
    Ok(HistoryPlace {
        enabled: enabled.unwrap_or(!off),
        location: match location {
            Some(set) => expand_location(&set, home)?,
            None => default_location.clone(),
        },
        default_location,
    })
}

/// The machine's name for the commits' `Roamgate-Host:` trailer: in a
/// toolbox (whose own name is always `toolbx`), the host's.
pub fn history_host_of(in_toolbox: bool, host_file: &Path) -> String {
    if in_toolbox && let Ok(name) = std::fs::read_to_string(host_file) {
        let name = js::trim(&name);
        if !name.is_empty() {
            return name.to_owned();
        }
    }
    os_hostname()
}

/// This machine's history host.
pub fn history_host() -> String {
    history_host_of(
        Path::new("/run/.toolboxenv").exists(),
        Path::new("/run/host/etc/hostname"),
    )
}

/// `os.hostname()`.
pub fn os_hostname() -> String {
    #[cfg(unix)]
    {
        rustix::system::uname()
            .nodename()
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

/// `path.resolve` of an absolute path: `.` and `..` folded.
fn resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A location as typed: `~` is the home directory; a relative one is
/// refused.
pub fn expand_location(value: &str, home: &Path) -> Result<PathBuf, String> {
    let trimmed = js::trim(value);
    let expanded = if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err("the history location must be an absolute path".into());
    }
    Ok(resolve(&expanded))
}

/// The review store of the areas (a source opened lazily).
pub type Reviews = Arc<dyn Fn() -> Option<Arc<dyn ReviewSource>> + Send + Sync>;

/// Every area of the history, in the order a commit message lists them.
pub fn history_areas(paths: &HistoryPaths, reviews: Reviews) -> Vec<Arc<dyn HistoryArea>> {
    vec![
        Arc::new(WorkArea {
            work: paths.work.clone(),
            reviews: reviews.clone(),
        }),
        Arc::new(ReviewsArea {
            reviews: paths.reviews.clone(),
            source: reviews,
        }),
        Arc::new(SettingsArea {
            settings: paths.settings.clone(),
        }),
        Arc::new(connections_area(paths)),
        Arc::new(move_hosts_area(paths)),
        Arc::new(session_profiles_area(paths)),
        Arc::new(MrReviewsArea {
            settings: paths.settings.clone(),
            data: paths.data.clone(),
        }),
        Arc::new(companion_area(paths)),
        Arc::new(voice_area(paths)),
    ]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn history_is_on_at_data_history_unless_the_settings_or_the_environment_say() {
        let none: [(&str, &str); 0] = [];
        let home = Path::new("/home/u");
        assert_eq!(
            history_place(None, Path::new("/d"), &none, home).unwrap(),
            HistoryPlace {
                enabled: true,
                location: "/d/history".into(),
                default_location: "/d/history".into(),
            }
        );
        let off = [("ROAMGATE_HISTORY", "off")];
        assert!(
            !history_place(None, Path::new("/d"), &off, home)
                .unwrap()
                .enabled
        );
        let on = json!({"history": {"enabled": true}});
        assert!(
            history_place(Some(&on), Path::new("/d"), &off, home)
                .unwrap()
                .enabled
        );
        let moved = json!({"history": {"location": "~/keep"}});
        assert_eq!(
            history_place(
                Some(&moved),
                Path::new("/d"),
                &[("ROAMGATE_HISTORY_DIR", "/x")],
                home
            )
            .unwrap(),
            HistoryPlace {
                enabled: true,
                location: "/home/u/keep".into(),
                default_location: "/x".into(),
            }
        );
        let error = expand_location("relative/dir", home).unwrap_err();
        assert!(error.contains("absolute"));
    }

    #[test]
    fn in_a_toolbox_the_host_s_name_is_the_machine_s() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hostname"), "amd-desktop\n").unwrap();
        assert_eq!(
            history_host_of(true, &dir.path().join("hostname")),
            "amd-desktop"
        );
        assert_eq!(
            history_host_of(true, &dir.path().join("missing")),
            os_hostname()
        );
        assert_eq!(history_host_of(false, Path::new("/nowhere")), os_hostname());
        assert!(!os_hostname().is_empty());
    }
}

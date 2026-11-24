//! The areas kept as the stores' own small files (history/files.ts):
//! settings (one file per top-level key, from an allowlist), connections,
//! move hosts, session profiles, the companion's memories and the voice
//! settings. JSON goes through `without_secrets` and is written key-sorted;
//! Markdown is copied as it is (the scan before the commit keeps a secret
//! out).

use std::path::{Path, PathBuf};

use regex::Regex;
use roamgate_agents::js;
use roamgate_base::secrets::without_secrets;
use serde_json::{Map, Value};

use crate::area::{AreaRender, HistoryArea, HistoryPaths, count};
use crate::format::{file_name_of, stable_json};

/// The keys of settings.json the history keeps, each as
/// `settings/<key>.json`. `mr_reviews` is the mr-reviews area's (its
/// authored part); a key not listed here is never written.
pub const HISTORY_SETTINGS_KEYS: &[&str] = &[
    "version",
    "archive",
    "title_suffix",
    "auto_rename_agent_tabs",
    "worktree_command",
    "worktree_remove_command",
    "repositories",
    "workspace_auto_sync",
    "terminal_transport",
    "activity",
    "time_report",
    "claude_start_mode",
    "conversation",
    "limit_resume",
    "mr_cache",
    "profiles",
    "custom",
    "ui",
    "workspace_tree",
    "rendered_sites",
    "rendered_site_roots",
    "history",
];

/// A JSON file as JavaScript reads it: None when missing, an error naming
/// the file when it cannot be read or parsed.
pub fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str::<Value>(&text)
        .map(|value| Some(js::js_value(value)))
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// The settings area.
pub struct SettingsArea {
    pub settings: PathBuf,
}

impl HistoryArea for SettingsArea {
    fn name(&self) -> &str {
        "settings"
    }

    fn watch(&self) -> Option<Vec<PathBuf>> {
        Some(vec![self.settings.clone()])
    }

    fn render(&self, _ids: Option<&[String]>) -> Result<AreaRender, String> {
        let mut render = AreaRender {
            owns: vec!["settings/".into()],
            ..AreaRender::default()
        };
        if let Some(Value::Object(settings)) = read_json(&self.settings)? {
            for key in HISTORY_SETTINGS_KEYS {
                if let Some(value) = settings.get(*key) {
                    render.set(
                        format!("settings/{key}.json"),
                        stable_json(&without_secrets(value)),
                    );
                }
            }
        }
        Ok(render)
    }

    fn describe(&self, paths: &[String]) -> Option<String> {
        Some(
            paths
                .iter()
                .map(|path| {
                    let name = path.strip_prefix("settings/").unwrap_or(path);
                    name.strip_suffix(".json").unwrap_or(name).to_owned()
                })
                .collect::<Vec<_>>()
                .join(", "),
        )
    }
}

/// One source of a files area: a JSON file, or a directory of files.
pub enum Source {
    Json {
        from: PathBuf,
        to: String,
        /// Only these keys (the authored part of a mixed file).
        keys: Option<&'static [&'static str]>,
    },
    Dir {
        from: PathBuf,
        /// The directory in the repo, ending in `/`.
        to: String,
        /// The entries taken.
        matches: Regex,
        json: bool,
    },
}

/// A directory's entries that match, without dot files, in JavaScript's
/// sort order.
fn entries(dir: &Path, matches: &Regex) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| matches.is_match(name) && !name.starts_with('.'))
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

/// An area of small files.
pub struct FilesArea {
    pub name: &'static str,
    pub sources: Vec<Source>,
}

impl HistoryArea for FilesArea {
    fn name(&self) -> &str {
        self.name
    }

    fn watch(&self) -> Option<Vec<PathBuf>> {
        Some(
            self.sources
                .iter()
                .flat_map(|source| match source {
                    Source::Json { from, .. } => vec![from.clone()],
                    Source::Dir { from, matches, .. } => std::iter::once(from.clone())
                        .chain(
                            entries(from, matches)
                                .into_iter()
                                .map(|file| from.join(file)),
                        )
                        .collect(),
                })
                .collect(),
        )
    }

    fn render(&self, _ids: Option<&[String]>) -> Result<AreaRender, String> {
        let mut render = AreaRender::default();
        for source in &self.sources {
            match source {
                Source::Json { from, to, keys } => {
                    let Some(mut value) = read_json(from)? else {
                        continue;
                    };
                    if let Some(keys) = keys {
                        let picked = |get: &dyn Fn(&str) -> Option<Value>| {
                            let mut out = Map::new();
                            for key in keys.iter() {
                                if let Some(each) = get(key) {
                                    out.insert((*key).to_owned(), each);
                                }
                            }
                            Value::Object(out)
                        };
                        match &value {
                            Value::Object(object) => {
                                value = picked(&|key| object.get(key).cloned());
                            }
                            Value::Array(_) => value = picked(&|_| None),
                            _ => {}
                        }
                    }
                    render.set(to.clone(), stable_json(&without_secrets(&value)));
                }
                Source::Dir {
                    from,
                    to,
                    matches,
                    json,
                } => {
                    for file in entries(from, matches) {
                        let target = format!("{to}{}", file_name_of(&file));
                        if *json {
                            if let Some(value) = read_json(&from.join(&file))? {
                                render.set(target, stable_json(&without_secrets(&value)));
                            }
                        } else if let Ok(bytes) = std::fs::read(from.join(&file)) {
                            render.set(target, String::from_utf8_lossy(&bytes).into_owned());
                        }
                    }
                }
            }
        }
        render.owns = self
            .sources
            .iter()
            .map(|source| match source {
                Source::Json { to, .. } | Source::Dir { to, .. } => to.clone(),
            })
            .collect();
        Ok(render)
    }

    fn describe(&self, paths: &[String]) -> Option<String> {
        Some(count(paths.len(), "file"))
    }
}

fn json(from: PathBuf, to: &str) -> Source {
    Source::Json {
        from,
        to: to.into(),
        keys: None,
    }
}

pub fn connections_area(paths: &HistoryPaths) -> FilesArea {
    FilesArea {
        name: "connections",
        sources: vec![json(paths.connections.clone(), "connections.json")],
    }
}

pub fn move_hosts_area(paths: &HistoryPaths) -> FilesArea {
    FilesArea {
        name: "move-hosts",
        sources: vec![json(paths.data.join("move-hosts.json"), "move-hosts.json")],
    }
}

pub fn session_profiles_area(paths: &HistoryPaths) -> FilesArea {
    FilesArea {
        name: "session-profiles",
        sources: vec![json(
            paths.data.join("session-profiles.json"),
            "session-profiles.json",
        )],
    }
}

/// The companion: its memory, the rules the user taught it, the taste the
/// user set.
pub fn companion_area(paths: &HistoryPaths) -> FilesArea {
    FilesArea {
        name: "companion",
        sources: vec![
            json(
                paths.data.join("companion-memory.json"),
                "companion/memory.json",
            ),
            Source::Dir {
                from: paths.data.join("companion-memories"),
                to: "companion/memories/".into(),
                matches: Regex::new(r"\.md$").unwrap(),
                json: false,
            },
            Source::Json {
                from: paths.data.join("taste.json"),
                to: "companion/taste.json".into(),
                // The profile is read again from the music service; these
                // are the user's.
                keys: Some(&["version", "avoid", "picks"]),
            },
        ],
    }
}

pub fn voice_area(paths: &HistoryPaths) -> FilesArea {
    FilesArea {
        name: "voice",
        sources: vec![
            json(paths.data.join("voice.json"), "voice/voice.json"),
            Source::Dir {
                from: paths.data.join("voice-profiles"),
                to: "voice/profiles/".into(),
                matches: Regex::new(r"\.json$").unwrap(),
                json: true,
            },
            json(paths.voice_data.join("low-gpu.json"), "voice/low-gpu.json"),
        ],
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn paths(dir: &Path) -> HistoryPaths {
        HistoryPaths {
            data: dir.to_path_buf(),
            settings: dir.join("settings.json"),
            connections: dir.join("connections.json"),
            reviews: dir.join("reviews"),
            work: dir.join("work"),
            voice_data: dir.join("share"),
        }
    }

    fn keys(render: &AreaRender) -> Vec<&str> {
        render.files.keys().map(String::as_str).collect()
    }

    #[test]
    fn settings_one_file_per_allowed_key_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &settings,
            json!({
                "version": 1,
                "title_suffix": "desk",
                "profiles": {"list": [{"id": "p", "env": {"ANTHROPIC_AUTH_TOKEN": "t", "HOME": "/h"}}]},
                "mr_reviews": {"order": []},
                "something_new": {"x": 1},
                "ui": {"note": "glpat-abcdefghijklmnopqr"},
            })
            .to_string(),
        )
        .unwrap();
        let area = SettingsArea {
            settings: settings.clone(),
        };
        let render = area.render(None).unwrap();
        assert_eq!(
            keys(&render),
            [
                "settings/profiles.json",
                "settings/title_suffix.json",
                "settings/ui.json",
                "settings/version.json"
            ]
        );
        assert_eq!(
            render.text("settings/profiles.json").unwrap(),
            "{\n  \"list\": [\n    {\n      \"env\": {\n        \"HOME\": \"/h\"\n      },\n      \"id\": \"p\"\n    }\n  ]\n}\n"
        );
        assert!(
            render
                .text("settings/ui.json")
                .unwrap()
                .contains("[removed]")
        );
        assert_eq!(render.owns, ["settings/"]);
        assert_eq!(area.watch(), Some(vec![settings]));
        assert_eq!(
            area.describe(&["settings/ui.json".into(), "settings/profiles.json".into()])
                .unwrap(),
            "ui, profiles"
        );
    }

    #[test]
    fn the_small_files_areas_copy_their_stores_json_key_sorted_markdown_as_it_is() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let paths = paths(dir);
        std::fs::create_dir_all(dir.join("companion-memories")).unwrap();
        std::fs::create_dir_all(dir.join("voice-profiles")).unwrap();
        std::fs::create_dir_all(&paths.voice_data).unwrap();
        let write = |path: PathBuf, text: &str| std::fs::write(path, text).unwrap();
        write(
            dir.join("connections.json"),
            r#"{"version":1,"profiles":[{"id":"mac","password":"x"}]}"#,
        );
        write(
            dir.join("move-hosts.json"),
            r#"{"serving":"desk","hosts":[]}"#,
        );
        write(
            dir.join("session-profiles.json"),
            r#"{"version":1,"sessions":{}}"#,
        );
        write(dir.join("companion-memory.json"), r#"{"summary":"s"}"#);
        write(
            dir.join("companion-memories").join("home.md"),
            "---\nname: home\n---\nLives here.\n",
        );
        write(
            dir.join("companion-memories").join("notes.txt"),
            "not a memory",
        );
        write(
            dir.join("taste.json"),
            r#"{"version":1,"profile":{"top":["a"]},"avoid":["x"],"picks":["y"],"updated":5}"#,
        );
        write(
            dir.join("voice.json"),
            r#"{"speech_rate":1.1,"helper":"/h"}"#,
        );
        write(
            dir.join("voice-profiles").join("anna.json"),
            r#"{"name":"Anna"}"#,
        );
        write(paths.voice_data.join("low-gpu.json"), r#"{"holders":{}}"#);
        let mut all = AreaRender::default();
        for area in [
            connections_area(&paths),
            move_hosts_area(&paths),
            session_profiles_area(&paths),
            companion_area(&paths),
            voice_area(&paths),
        ] {
            all.files.extend(area.render(None).unwrap().files);
        }
        assert_eq!(
            keys(&all),
            [
                "companion/memories/home.md",
                "companion/memory.json",
                "companion/taste.json",
                "connections.json",
                "move-hosts.json",
                "session-profiles.json",
                "voice/low-gpu.json",
                "voice/profiles/anna.json",
                "voice/voice.json",
            ]
        );
        assert_eq!(
            all.text("connections.json").unwrap(),
            "{\n  \"profiles\": [\n    {\n      \"id\": \"mac\"\n    }\n  ],\n  \"version\": 1\n}\n"
        );
        assert_eq!(
            all.text("companion/memories/home.md").unwrap(),
            "---\nname: home\n---\nLives here.\n"
        );
        assert_eq!(
            serde_json::from_str::<Value>(all.text("companion/taste.json").unwrap()).unwrap(),
            json!({"avoid": ["x"], "picks": ["y"], "version": 1})
        );
        let companion = companion_area(&paths);
        assert!(
            companion
                .watch()
                .unwrap()
                .contains(&dir.join("companion-memories").join("home.md"))
        );
        assert_eq!(
            companion.render(None).unwrap().owns,
            [
                "companion/memory.json",
                "companion/memories/",
                "companion/taste.json"
            ]
        );
    }

    #[test]
    fn a_missing_store_writes_nothing_a_broken_one_is_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let area = connections_area(&paths(temp.path()));
        assert!(area.render(None).unwrap().files.is_empty());
        std::fs::write(temp.path().join("connections.json"), "{broken").unwrap();
        let error = area.render(None).unwrap_err();
        assert!(error.contains("connections.json"), "{error}");
    }
}

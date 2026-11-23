//! The archive settings (`archive` in settings.json; archive/settings.ts):
//! where the archive lives, which agents and hosts it covers, what is
//! indexed and what is left out.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use roamgate_agents::js::js_trim;

/// How much of a file is rendered for search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexLevel {
    Full,
    Words,
    None,
}

impl IndexLevel {
    pub fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "full" => Some(Self::Full),
            "words" => Some(Self::Words),
            "none" => Some(Self::None),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Words => "words",
            Self::None => "none",
        }
    }
}

/// A match on any of host, agent and project (substring); empty fields
/// match all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchiveRule {
    pub host: Option<String>,
    pub agent: Option<String>,
    pub project: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexRule {
    pub rule: ArchiveRule,
    pub level: IndexLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PathStyle {
    #[default]
    Posix,
    Windows,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostSpec {
    /// An ssh destination; absent: this machine.
    pub ssh: Option<String>,
    /// The user's home there, for project path mapping; found when absent.
    pub home: Option<String>,
    pub path_style: Option<PathStyle>,
    /// Per-agent root overrides.
    pub roots: Option<IndexMap<String, String>>,
    /// Left out of pulls while false.
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSettings {
    pub target: String,
    pub archive_dir: Option<String>,
    pub binary: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveSettings {
    /// Archive directory; default `<data root>/archive`.
    pub dir: Option<String>,
    /// This machine's name in the archive.
    pub host: Option<String>,
    /// Agents archived; others are never guessed.
    pub agents: Vec<String>,
    pub hosts: IndexMap<String, HostSpec>,
    /// Hours without a successful sync after which health warns.
    pub stale_hours: f64,
    /// Index thinking blocks too.
    pub thinking: bool,
    pub index_default: IndexLevel,
    pub index_rules: Vec<IndexRule>,
    /// Never archived.
    pub exclude: Vec<ArchiveRule>,
    /// Archived but left out of search and the Ranger tools.
    pub hide: Vec<ArchiveRule>,
    /// Health warns below this much free disk, in GB.
    pub min_free_gb: f64,
    pub push: Option<PushSettings>,
    /// An archive on another machine, reached over ssh.
    pub remote: Option<String>,
    pub remote_dir: Option<String>,
    /// Characters of a tool call kept in the text repo.
    pub text_tool_chars: Option<u64>,
}

impl Default for ArchiveSettings {
    fn default() -> Self {
        normalize_archive_settings(None)
    }
}

/// A trimmed non-empty string (`str`).
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn rule(object: &Map<String, Value>) -> ArchiveRule {
    ArchiveRule {
        host: text(object.get("host")),
        agent: text(object.get("agent")),
        project: text(object.get("project")),
    }
}

fn rules(value: Option<&Value>) -> Vec<ArchiveRule> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .map(rule)
            .collect(),
        _ => Vec::new(),
    }
}

fn host_spec(value: &Value) -> HostSpec {
    let Some(object) = value.as_object() else {
        return HostSpec::default();
    };
    let roots = object.get("roots").and_then(Value::as_object).map(|roots| {
        roots
            .iter()
            .filter_map(|(agent, root)| text(Some(root)).map(|root| (agent.clone(), root)))
            .collect::<IndexMap<_, _>>()
    });
    HostSpec {
        ssh: text(object.get("ssh")),
        home: text(object.get("home")),
        path_style: match object.get("path_style").and_then(Value::as_str) {
            Some("windows") => Some(PathStyle::Windows),
            Some("posix") => Some(PathStyle::Posix),
            _ => None,
        },
        roots: roots.filter(|roots| !roots.is_empty()),
        enabled: (object.get("enabled") == Some(&Value::Bool(false))).then_some(false),
    }
}

/// Fills defaults in and drops invalid values, field by field.
pub fn normalize_archive_settings(raw: Option<&Value>) -> ArchiveSettings {
    let empty = Map::new();
    let object = raw.and_then(Value::as_object).unwrap_or(&empty);
    let agents = match object.get("agents") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|agent| !js_trim(agent).is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec!["claude".into(), "codex".into(), "pi".into()],
    };
    let index = object
        .get("index")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let push = object
        .get("push")
        .and_then(Value::as_object)
        .and_then(|push| {
            Some(PushSettings {
                target: text(push.get("target"))?,
                archive_dir: text(push.get("archive_dir")),
                binary: text(push.get("binary")),
            })
        });
    let stale_hours = object
        .get("stale_hours")
        .and_then(Value::as_f64)
        .filter(|hours| *hours > 0.0)
        .unwrap_or(48.0);
    let min_free_gb = object
        .get("min_free_gb")
        .and_then(Value::as_f64)
        .filter(|gb| *gb >= 0.0)
        .unwrap_or(20.0);
    let text_tool_chars = object.get("text_tool_chars").and_then(|value| {
        let number = value.as_f64()?;
        (number.fract() == 0.0 && (80.0..=100_000.0).contains(&number)).then_some(number as u64)
    });
    ArchiveSettings {
        dir: text(object.get("dir")),
        host: text(object.get("host")),
        agents,
        hosts: object
            .get("hosts")
            .and_then(Value::as_object)
            .map(|hosts| {
                hosts
                    .iter()
                    .map(|(id, spec)| (id.clone(), host_spec(spec)))
                    .collect()
            })
            .unwrap_or_default(),
        stale_hours,
        thinking: object.get("thinking") == Some(&Value::Bool(true)),
        index_default: index
            .get("default")
            .and_then(IndexLevel::parse)
            .unwrap_or(IndexLevel::Full),
        index_rules: match index.get("rules") {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(Value::as_object)
                .filter_map(|item| {
                    Some(IndexRule {
                        level: item.get("level").and_then(IndexLevel::parse)?,
                        rule: rule(item),
                    })
                })
                .collect(),
            _ => Vec::new(),
        },
        exclude: rules(object.get("exclude")),
        hide: rules(object.get("hide")),
        min_free_gb,
        push,
        remote: text(object.get("remote")),
        remote_dir: text(object.get("remote_dir")),
        text_tool_chars,
    }
}

/// What a rule is checked against.
#[derive(Debug, Clone, Copy)]
pub struct RuleSubject<'a> {
    pub host: &'a str,
    pub agent: &'a str,
    pub project: &'a str,
}

pub fn rule_matches(rule: &ArchiveRule, subject: RuleSubject<'_>) -> bool {
    rule.host.as_deref().is_none_or(|host| host == subject.host)
        && rule
            .agent
            .as_deref()
            .is_none_or(|agent| agent == subject.agent)
        && rule
            .project
            .as_deref()
            .is_none_or(|project| subject.project.contains(project))
}

pub fn any_rule_matches(list: &[ArchiveRule], subject: RuleSubject<'_>) -> bool {
    list.iter().any(|rule| rule_matches(rule, subject))
}

pub fn index_level_for(settings: &ArchiveSettings, subject: RuleSubject<'_>) -> IndexLevel {
    settings
        .index_rules
        .iter()
        .find(|entry| rule_matches(&entry.rule, subject))
        .map_or(settings.index_default, |entry| entry.level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_fill_in_and_invalid_values_drop() {
        let settings = normalize_archive_settings(Some(&json!({
            "agents": ["claude", " ", 3],
            "stale_hours": -1,
            "index": {"default": "words", "rules": [{"project": "x", "level": "none"}, {"level": "bad"}]},
            "hosts": {"mac": {"ssh": " mac ", "roots": {"claude": " "}, "enabled": false}},
            "push": {"target": ""},
            "text_tool_chars": 50,
        })));
        assert_eq!(settings.agents, vec!["claude"]);
        assert_eq!(settings.stale_hours, 48.0);
        assert_eq!(settings.index_default, IndexLevel::Words);
        assert_eq!(settings.index_rules.len(), 1);
        let mac = &settings.hosts["mac"];
        assert_eq!(mac.ssh.as_deref(), Some("mac"));
        assert_eq!(mac.roots, None);
        assert_eq!(mac.enabled, Some(false));
        assert_eq!(settings.push, None);
        assert_eq!(settings.text_tool_chars, None);
        let subject = RuleSubject {
            host: "h",
            agent: "claude",
            project: "-x-y",
        };
        assert_eq!(index_level_for(&settings, subject), IndexLevel::None);
        assert_eq!(
            ArchiveSettings::default().agents,
            vec!["claude", "codex", "pi"]
        );
    }
}

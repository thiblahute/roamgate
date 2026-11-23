//! The coverage gate (the plan's section 5.12): every contract entry is
//! named by at least one case.
//!
//! Entries are read from `contract/`: RPC methods, pushes, HTTP operations,
//! the other sockets' messages, agent socket commands, CLI commands and
//! environment variables. What a scenario covers comes from its steps and
//! its `covers` list (`scenario::coverage`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result};
use regex::Regex;
use serde_json::Value;

use crate::paths::{contract_dir, repo_root, scenarios_dir};
use crate::scenario;

/// Contract entries by surface, as coverage refs (`rpc:<method>`, ...).
pub fn entries(contract: &Path) -> Result<BTreeMap<&'static str, BTreeSet<String>>> {
    let mut out: BTreeMap<&'static str, BTreeSet<String>> = BTreeMap::new();
    for entry in walkdir::WalkDir::new(contract.join("rpc"))
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let value: Value = serde_json::from_str(&std::fs::read_to_string(entry.path())?)?;
        if let Some(method) = value.get("method").and_then(Value::as_str)
            && method != "*"
        {
            out.entry("rpc")
                .or_default()
                .insert(format!("rpc:{method}"));
        }
    }
    for entry in std::fs::read_dir(contract.join("push"))? {
        let path = entry?.path();
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        if let Some(name) = value.get("x-inventory").and_then(Value::as_str) {
            out.entry("push")
                .or_default()
                .insert(format!("push:{name}"));
        }
    }
    let openapi = |file: &str| -> Result<serde_json::Value> {
        let text = std::fs::read_to_string(contract.join(file)).with_context(|| file.to_owned())?;
        let yaml: serde_yaml::Value = serde_yaml::from_str(&text)?;
        Ok(serde_json::to_value(yaml)?)
    };
    let http = openapi("http/openapi.yaml")?;
    for (path, item) in http["paths"].as_object().into_iter().flatten() {
        for method in item
            .as_object()
            .into_iter()
            .flatten()
            .map(|(method, _)| method)
        {
            if ["get", "put", "post", "delete", "patch", "head", "options"]
                .contains(&method.as_str())
            {
                out.entry("http")
                    .or_default()
                    .insert(format!("http:{} {path}", method.to_uppercase()));
            }
        }
    }
    let agent = openapi("agent-socket/openapi.yaml")?;
    for path in agent["paths"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(path, _)| path)
    {
        if let Some(command) = path.strip_prefix("/v1/") {
            out.entry("agent")
                .or_default()
                .insert(format!("agent:{command}"));
        }
    }
    let ws_text = std::fs::read_to_string(contract.join("ws/asyncapi.yaml"))?;
    let inventory = Regex::new(r"x-inventory:\s*(.+)")?;
    for found in inventory.captures_iter(&ws_text) {
        out.entry("ws")
            .or_default()
            .insert(format!("ws:{}", found[1].trim().trim_matches('"')));
    }
    let cli: Value = serde_json::from_str(&std::fs::read_to_string(
        contract.join("cli/commands.json"),
    )?)?;
    for command in cli["commands"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, _)| name)
    {
        out.entry("cli")
            .or_default()
            .insert(format!("cli:{command}"));
    }
    let env = std::fs::read_to_string(contract.join("env.md"))?;
    let row = Regex::new(r"(?m)^\| `([A-Z0-9_]+)`")?;
    for found in row.captures_iter(&env) {
        out.entry("env")
            .or_default()
            .insert(format!("env:{}", &found[1]));
    }
    Ok(out)
}

/// Whether a scenario's ref covers an entry (HTTP refs match the path
/// templates, `{name}` standing for a segment and a last `{static}` or
/// `{path}` for the rest).
pub fn covers(entry: &str, refs: &BTreeSet<String>) -> bool {
    if refs.contains(entry) {
        return true;
    }
    let Some(operation) = entry.strip_prefix("http:") else {
        return false;
    };
    let Some((method, template)) = operation.split_once(' ') else {
        return false;
    };
    let rest = Regex::new(r"/\{(static|path)\}$").expect("regex");
    let tail = rest.is_match(template);
    let body = rest.replace(template, "");
    let parts: Vec<String> = Regex::new(r"\{[^}]+\}")
        .expect("regex")
        .split(&body)
        .map(regex::escape)
        .collect();
    let pattern = format!(
        "^{}{}$",
        parts.join("[^/]+"),
        if tail { "(?:/.*)?" } else { "" }
    );
    let Ok(pattern) = Regex::new(&pattern) else {
        return false;
    };
    refs.iter().any(|reference| {
        reference
            .strip_prefix("http:")
            .and_then(|operation| operation.split_once(' '))
            .is_some_and(|(ref_method, path)| {
                (ref_method == method || (method == "GET" && ref_method == "HEAD"))
                    && pattern.is_match(path.split('?').next().unwrap_or(path))
            })
    })
}

#[derive(Debug, Default)]
pub struct Report {
    pub entries: BTreeMap<&'static str, usize>,
    pub uncovered: BTreeMap<&'static str, Vec<String>>,
    pub scenarios: usize,
}

impl Report {
    pub fn summary(&self) -> String {
        let mut lines = vec![format!("{} scenarios", self.scenarios)];
        for (surface, total) in &self.entries {
            let missing = self.uncovered.get(surface).map_or(0, Vec::len);
            lines.push(format!("{surface}: {}/{total} covered", total - missing));
        }
        lines.join("\n")
    }

    pub fn uncovered_total(&self) -> usize {
        self.uncovered.values().map(Vec::len).sum()
    }
}

/// Every scenario's refs against every contract entry.
pub fn report() -> Result<Report> {
    let entries = entries(&contract_dir())?;
    // The variables every run sets (run.rs) are read on every start.
    let mut refs: BTreeSet<String> = crate::run::HARNESS_ENV
        .iter()
        .map(|name| format!("env:{name}"))
        .collect();
    let paths = scenario::all(&scenarios_dir());
    for path in &paths {
        let loaded = scenario::load(path).with_context(|| {
            path.strip_prefix(repo_root())
                .unwrap_or(path)
                .display()
                .to_string()
        })?;
        refs.extend(scenario::coverage(&loaded));
    }
    let mut report = Report {
        scenarios: paths.len(),
        ..Report::default()
    };
    for (surface, names) in entries {
        report.entries.insert(surface, names.len());
        let missing: Vec<String> = names
            .into_iter()
            .filter(|name| !covers(name, &refs))
            .collect();
        if !missing.is_empty() {
            report.uncovered.insert(surface, missing);
        }
    }
    Ok(report)
}

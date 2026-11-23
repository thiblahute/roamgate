//! Every run records the server's traffic (`ROAMGATE_CONTRACT_RECORD`) and
//! the recording is checked against `contract/` with the record checker
//! (`bun scripts/contract-record.ts check`, or `PARITY_RECORD_CHECK`).

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::paths::{contract_dir, repo_root};

#[derive(Debug, Clone, Deserialize)]
pub struct Finding {
    pub kind: String,
    pub surface: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub count: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Report {
    pub messages: u64,
    pub checked: u64,
    pub findings: Vec<Finding>,
}

/// A finding a scenario expects (a refused request on purpose).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exception {
    pub surface: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub reason: String,
}

/// The recording checked by the checker `PARITY_RECORD_CHECK` names:
/// `rust` (the default, crate::check), `bun` (the TS checker,
/// `bun scripts/contract-record.ts check`), `both` (the two, which must
/// agree on every finding's kind, surface and name, and on the paths of
/// unknown fields and unlisted messages), or a command.
pub fn check(recording: &Path) -> Result<Report> {
    if !recording.exists() {
        return Ok(Report {
            messages: 0,
            checked: 0,
            findings: Vec::new(),
        });
    }
    let mode = std::env::var("PARITY_RECORD_CHECK").unwrap_or_else(|_| "rust".to_owned());
    match mode.as_str() {
        "rust" => crate::check::check_recordings(recording, &contract_dir()),
        "bun" => check_with(recording, "bun scripts/contract-record.ts check"),
        "both" => {
            let rust = crate::check::check_recordings(recording, &contract_dir())?;
            let bun = check_with(recording, "bun scripts/contract-record.ts check")?;
            let keys = |report: &Report| {
                let mut keys: Vec<String> = report
                    .findings
                    .iter()
                    // A mismatch's paths depend on the validator (TypeBox
                    // also names the branches of an anyOf it tried):
                    // mismatches compare by message, the rest by path.
                    .map(|finding| {
                        if finding.kind == "mismatch" {
                            format!("{} {} {}", finding.kind, finding.surface, finding.name)
                        } else {
                            format!(
                                "{} {} {} {}",
                                finding.kind, finding.surface, finding.name, finding.path
                            )
                        }
                    })
                    .collect();
                keys.sort();
                keys.dedup();
                keys
            };
            if keys(&rust) != keys(&bun) {
                bail!(
                    "the Rust and the TS record checkers disagree:\n  rust: {:#?}\n  bun: {:#?}",
                    keys(&rust),
                    keys(&bun)
                );
            }
            Ok(rust)
        }
        command => check_with(recording, command),
    }
}

fn check_with(recording: &Path, command: &str) -> Result<Report> {
    let command = command.to_owned();
    let mut words = command.split_whitespace();
    let program = words.next().context("empty PARITY_RECORD_CHECK")?;
    let output = Command::new(program)
        .args(words)
        .arg(recording)
        .arg("--contract")
        .arg(contract_dir())
        .arg("--json")
        .current_dir(repo_root())
        .output()
        .with_context(|| format!("run {command}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find('{').context("no JSON from the record checker")?;
    let value: Value = serde_json::from_str(&text[start..]).with_context(|| {
        format!(
            "record checker output: {text}\n{}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    Ok(serde_json::from_value(value)?)
}

/// Fails with the findings no exception covers.
pub fn enforce(report: &Report, exceptions: &[Exception]) -> Result<()> {
    let left: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|finding| {
            !exceptions.iter().any(|exception| {
                exception.surface == finding.surface
                    && exception.name == finding.name
                    && exception
                        .kind
                        .as_ref()
                        .is_none_or(|kind| *kind == finding.kind)
            })
        })
        .collect();
    if left.is_empty() {
        return Ok(());
    }
    let lines: Vec<String> = left
        .iter()
        .map(|finding| {
            format!(
                "  {} {} {} {}: {} (x{})",
                finding.kind,
                finding.surface,
                finding.name,
                finding.path,
                finding.detail,
                finding.count
            )
        })
        .collect();
    bail!(
        "the recorded traffic does not match contract/ ({} messages):\n{}",
        report.messages,
        lines.join("\n")
    )
}

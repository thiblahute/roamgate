//! The gates of the plan's sections 5.1 and 5.12, as tests:
//!
//! - every scenario file loads, and every old test it claims exists;
//! - parity/ledger.tsv has a row for every `it()`/`test()` of the TS suite
//!   and none for a test that is gone, and its scenario mappings name
//!   existing scenarios;
//! - every contract entry is covered by a scenario;
//! - contract/env.md lists what the crates read, and only that.
//!
//! Tests mapped `todo` or `pending:<what>` and uncovered entries are
//! reported; with `PARITY_GATE_STRICT=1` the `todo` ones and the uncovered
//! entries fail the gate (`pending:` rows wait on another subtask or a
//! runner).

use std::collections::BTreeSet;

use roamgate_parity::paths::{repo_root, scenarios_dir};
use roamgate_parity::{coverage, ledger, scenario};

fn strict() -> bool {
    std::env::var("PARITY_GATE_STRICT").is_ok_and(|value| value == "1")
}

#[test]
fn every_scenario_loads_and_claims_real_tests() {
    let tests = ledger::discover(&repo_root()).unwrap();
    let mut problems = Vec::new();
    for path in scenario::all(&scenarios_dir()) {
        match scenario::load(&path) {
            Ok(loaded) => {
                for claim in &loaded.ledger {
                    if ledger::resolve(claim, &tests).is_none() {
                        problems.push(format!("{}: no such test: {claim}", path.display()));
                    }
                }
            }
            Err(error) => problems.push(format!("{error:#}")),
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_ledger_accounts_for_every_old_test() {
    let root = repo_root();
    let tests = ledger::discover(&root).unwrap();
    let rows = ledger::read(&ledger::ledger_path()).unwrap();
    let have: BTreeSet<_> = rows.iter().map(|row| row.id.clone()).collect();
    let found: BTreeSet<_> = tests.iter().cloned().collect();
    let missing: Vec<_> = found.difference(&have).collect();
    let stale: Vec<_> = have.difference(&found).collect();
    let how = "run `cargo run -p roamgate-parity --bin parity-ledger` and map the new rows";
    assert!(
        missing.is_empty(),
        "tests missing from parity/ledger.tsv ({how}): {missing:#?}"
    );
    assert!(
        stale.is_empty(),
        "rows of tests that are gone ({how}): {stale:#?}"
    );
    let claims = ledger::scenario_claims().unwrap();
    // By test, not by position: a restack may list a file's tests in
    // another order (its vector cases after the tests it kept).
    let expected: std::collections::BTreeMap<_, _> = ledger::rebuild(&tests, &rows, &claims)
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    let outdated: Vec<String> = rows
        .iter()
        .filter_map(|row| expected.get(&row.id).map(|want| (row, want)))
        .filter(|(row, want)| row.mapping != want.mapping)
        .map(|(row, want)| {
            format!(
                "{} > {}: {} should be {}",
                row.id.file, row.id.title, row.mapping, want.mapping
            )
        })
        .collect();
    assert!(
        outdated.is_empty(),
        "ledger mappings out of date ({how}):\n{}",
        outdated.join("\n")
    );
    for row in &rows {
        assert!(
            row.mapping == "todo"
                || [
                    "scenario:",
                    "vector:",
                    "rust-unit:",
                    "internal:",
                    "pending:"
                ]
                .iter()
                .any(|kind| row.mapping.starts_with(kind)),
            "{} > {}: unknown mapping {}",
            row.id.file,
            row.id.title,
            row.mapping
        );
        for path in row
            .mapping
            .split(',')
            .filter_map(|part| part.strip_prefix("scenario:"))
        {
            assert!(
                root.join(path).exists(),
                "{} > {}: no scenario {path}",
                row.id.file,
                row.id.title
            );
        }
    }
    // A rust-unit mapping to a crate the workspace has names the test that
    // covers it, and that test exists.
    // Rows under a prefix of parity/unported.tsv wait for a later subtask.
    let unported = ledger::unported(&root).unwrap();
    let mut used = vec![false; unported.len()];
    let mut unnamed = 0usize;
    let mut broken = Vec::new();
    for row in &rows {
        for (name, test) in ledger::rust_units(&row.mapping) {
            let Some(dir) = ledger::crate_dir(&root, &name) else {
                continue;
            };
            let later = unported
                .iter()
                .position(|entry| entry.krate == name && row.id.file.starts_with(&entry.prefix));
            match test {
                None if later.is_some() => used[later.unwrap()] = true,
                None => unnamed += 1,
                Some(test) if !ledger::rust_test_exists(&dir, &test) => broken.push(format!(
                    "{} > {}: no test {test} in crates/{name}",
                    row.id.file, row.id.title
                )),
                Some(_) => {}
            }
        }
    }
    assert!(broken.is_empty(), "{}", broken.join("\n"));
    let stale: Vec<String> = unported
        .iter()
        .zip(&used)
        .filter(|(entry, used)| !**used && ledger::crate_dir(&root, &entry.krate).is_some())
        .map(|(entry, _)| format!("{}\t{}\t{}", entry.krate, entry.prefix, entry.subtask))
        .collect();
    assert!(
        stale.is_empty(),
        "parity/unported.tsv entries with no unnamed row left (remove them):\n{}",
        stale.join("\n")
    );
    let todo = rows.iter().filter(|row| row.mapping == "todo").count();
    let mut pending: std::collections::BTreeMap<&str, usize> = Default::default();
    for row in &rows {
        if let Some(what) = row.mapping.strip_prefix("pending:") {
            *pending.entry(what).or_default() += 1;
        }
    }
    eprintln!(
        "ledger: {} tests, {} mapped, {todo} todo, pending {pending:?}",
        rows.len(),
        rows.len() - todo - pending.values().sum::<usize>()
    );
    if unnamed > 0 {
        eprintln!("ledger: {unnamed} rust-unit rows of existing crates name no test");
    }
    if strict() {
        assert_eq!(todo, 0, "unmapped tests in parity/ledger.tsv");
        assert_eq!(
            unnamed, 0,
            "rust-unit rows of existing crates must name the Rust test that covers them"
        );
    }
}

#[test]
fn every_contract_entry_is_covered() {
    let report = coverage::report().unwrap();
    eprintln!("coverage:\n{}", report.summary());
    if strict() {
        assert_eq!(
            report.uncovered_total(),
            0,
            "uncovered contract entries: {:#?}",
            report.uncovered
        );
    }
}

/// A crate's source file, its tests left out (`tests` directories and
/// modules, a `#[cfg(test)] mod tests` block).
fn crate_sources() -> Vec<(String, String)> {
    let crates = repo_root().join("crates");
    walkdir::WalkDir::new(&crates)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "rs"))
        .filter_map(|entry| {
            let relative = entry
                .path()
                .strip_prefix(&crates)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            let in_src = relative.split('/').nth(1) == Some("src");
            if !in_src || relative.contains("/tests") || relative.ends_with("tests.rs") {
                return None;
            }
            let mut text = std::fs::read_to_string(entry.path()).ok()?;
            if let Some(at) = text.find("#[cfg(test)]\nmod tests") {
                text.truncate(at);
            }
            Some((relative, text))
        })
        .collect()
}

#[test]
fn the_environment_table_is_what_the_crates_read() {
    let env = std::fs::read_to_string(repo_root().join("contract/env.md")).unwrap();
    let table: BTreeSet<String> = regex::Regex::new(r"(?m)^\| `([A-Z0-9_]+)`")
        .unwrap()
        .captures_iter(&env)
        .map(|found| found[1].to_owned())
        .collect();
    let sources = crate_sources();
    // Every name of the table is named by the crates (a legacy or
    // ROAMGATE_ name also by its suffix, roamgate_env's argument).
    let stale: Vec<&String> = table
        .iter()
        .filter(|name| {
            let mut names = vec![format!("\"{name}\"")];
            for prefix in ["ROAMGATE_", "HERDR_GUI_"] {
                if let Some(rest) = name.strip_prefix(prefix) {
                    names.push(format!("\"{rest}\""));
                }
            }
            !sources
                .iter()
                .any(|(_, text)| names.iter().any(|quoted| text.contains(quoted.as_str())))
        })
        .collect();
    assert!(
        stale.is_empty(),
        "contract/env.md names variables no crate reads: {stale:?}"
    );
    // Every ROAMGATE_ or HERDR_GUI_ variable the crates read is listed.
    let read = regex::Regex::new(
        r#"(?:var|var_os)\(\s*"((?:ROAMGATE|HERDR_GUI)_[A-Z0-9_]+)"\s*\)|roamgate_env\([^,]+,\s*"([A-Z0-9_]+)"\s*\)|(?:var|var_os)\(\s*&?(?:[a-z_]+::)*([A-Z][A-Z0-9_]+)\s*\)"#,
    )
    .unwrap();
    let constant =
        regex::Regex::new(r#"const ([A-Z0-9_]+): &str = "((?:ROAMGATE|HERDR_GUI)_[A-Z0-9_]+)";"#)
            .unwrap();
    let constants: std::collections::BTreeMap<String, String> = sources
        .iter()
        .flat_map(|(_, text)| {
            constant
                .captures_iter(text)
                .map(|found| (found[1].to_owned(), found[2].to_owned()))
                .collect::<Vec<_>>()
        })
        .collect();
    let mut missing = BTreeSet::new();
    for (path, text) in &sources {
        for found in read.captures_iter(text) {
            let name = if let Some(name) = found.get(1) {
                name.as_str().to_owned()
            } else if let Some(suffix) = found.get(2) {
                format!("ROAMGATE_{}", suffix.as_str())
            } else {
                match constants.get(&found[3]) {
                    Some(name) => name.clone(),
                    None => continue,
                }
            };
            if !table.contains(&name) {
                missing.insert(format!("{name} ({path})"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "variables the crates read that contract/env.md does not list: {missing:#?}"
    );
}

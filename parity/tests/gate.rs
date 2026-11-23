//! The gates of the plan's sections 5.1 and 5.12, as tests:
//!
//! - every scenario file loads, and every old test it claims exists;
//! - parity/ledger.tsv has a row for every `it()`/`test()` of the TS suite
//!   and none for a test that is gone, and its scenario mappings name
//!   existing scenarios;
//! - every contract entry is covered by a scenario.
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
    if strict() {
        assert_eq!(todo, 0, "unmapped tests in parity/ledger.tsv");
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

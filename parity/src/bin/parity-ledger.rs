//! Rewrites parity/ledger.tsv from the TS sources and the scenarios'
//! `ledger:` lists, keeping the mappings it has (roamgate_parity::ledger),
//! and prints the coverage of contract/ by the scenarios.
//!
//! `cargo run -p roamgate-parity --bin parity-ledger [-- --uncovered]`

use std::collections::BTreeMap;

use roamgate_parity::paths::repo_root;
use roamgate_parity::{coverage, ledger};

fn main() -> anyhow::Result<()> {
    let root = repo_root();
    let tests = ledger::discover(&root)?;
    let path = ledger::ledger_path();
    let old = if path.exists() {
        ledger::read(&path)?
    } else {
        Vec::new()
    };
    let claims = ledger::scenario_claims()?;
    let dangling: Vec<&String> = claims
        .keys()
        .filter(|claim| ledger::resolve(claim, &tests).is_none())
        .collect();
    for claim in &dangling {
        eprintln!("no such test: {claim}");
    }
    let rows = ledger::rebuild(&tests, &old, &claims);
    ledger::write(&path, &rows)?;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &rows {
        let kind = row.mapping.split(':').next().unwrap_or("").to_owned();
        *counts.entry(kind).or_default() += 1;
    }
    println!("{} tests in the ledger: {counts:?}", rows.len());
    let report = coverage::report()?;
    println!("{}", report.summary());
    if std::env::args().any(|arg| arg == "--uncovered") {
        for (surface, names) in &report.uncovered {
            for name in names {
                println!("uncovered {surface} {name}");
            }
        }
    }
    if !dangling.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

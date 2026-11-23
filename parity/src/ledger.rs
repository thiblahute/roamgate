//! The ledger of the TS suite's tests (the plan's section 5.1): every
//! `it()` and `test()` of server/src, shared and scripts, and what it maps
//! to in the Rust era.
//!
//! `parity/ledger.tsv` has a row per test: `file`, `test` (its title, with
//! `#n` for the n-th repeat of a title in a file), `mapping`, `note`. A
//! mapping is `scenario:<path>` (a parity scenario replaces it: scenarios
//! name the tests they replace in their `ledger:` list), `vector:<file>`
//! (contract/vectors), `rust-unit:<crate>` (internal behaviour, a Rust unit
//! test, in a crate not written yet), `rust-unit:<crate>:<test>` (the Rust
//! test that covers it, once `crates/<crate>` exists: see [`rust_units`]),
//! `internal:<reason>` (nothing observable to keep),
//! `pending:<what>` (mapped once that lands: `pending:S5` for the vectors
//! of the plan's subtask S5, `pending:windows-runner`), or `todo`.
//! `parity-ledger` rewrites the file from the sources, keeping the
//! mappings it has.
//!
//! A test file whose cases moved to contract/vectors calls
//! `runVectors("<name>", ...)`: its tests are then the cases of
//! `contract/vectors/<name>.json` (each case's `ledger` title, else its
//! `name`) besides the `it()` and `test()` it still has, so the ledger keeps
//! the old tests' rows once their bodies are gone.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::paths::{repo_root, scenarios_dir};
use crate::scenario;

/// Where the TS tests are.
pub const TEST_ROOTS: &[&str] = &["server/src", "shared", "scripts"];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TestId {
    pub file: String,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub id: TestId,
    pub mapping: String,
    pub note: String,
}

fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

/// The index after the balanced group opening at `at` (`(`, `[`, `{`).
fn skip_group(bytes: &[u8], at: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = at;
    let mut quote: Option<u8> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(open) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == open {
                quote = None;
            }
        } else {
            match byte {
                b'"' | b'\'' | b'`' => quote = Some(byte),
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(index + 1);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    None
}

/// A string literal at `at`, its text (escapes kept as written but `\"`).
fn string_at(bytes: &[u8], at: usize) -> Option<String> {
    let open = *bytes.get(at)?;
    if !matches!(open, b'"' | b'\'' | b'`') {
        return None;
    }
    let mut out = Vec::new();
    let mut index = at + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' && index + 1 < bytes.len() {
            let next = bytes[index + 1];
            if next == open || next == b'\\' {
                out.push(next);
            } else {
                out.push(byte);
                out.push(next);
            }
            index += 2;
            continue;
        }
        if byte == open {
            return Some(String::from_utf8_lossy(&out).into_owned());
        }
        out.push(byte);
        index += 1;
    }
    None
}

/// The titles of a file's `it(...)` and `test(...)` calls, in order.
pub fn titles(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &bytes[index..];
        let word = if rest.starts_with(b"test") {
            4
        } else if rest.starts_with(b"it") {
            2
        } else {
            index += 1;
            continue;
        };
        let before = index.checked_sub(1).map(|at| bytes[at]);
        let after = bytes.get(index + word).copied();
        let boundary_before = before.is_none_or(|byte| {
            !(byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' || byte == b'$')
        });
        let boundary_after = after.is_some_and(|byte| byte == b'(' || byte == b'.');
        if !boundary_before || !boundary_after {
            index += 1;
            continue;
        }
        // Modifiers: `.skip`, `.only`, `.todo`, `.skipIf(...)`, `.each(...)`.
        let mut at = index + word;
        let mut ok = true;
        while at < bytes.len() && bytes[at] == b'.' {
            at += 1;
            let start = at;
            while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
                at += 1;
            }
            if at == start {
                ok = false;
                break;
            }
            let name = &bytes[start..at];
            if matches!(
                name,
                b"skipIf" | b"if" | b"each" | b"todoIf" | b"failing" | b"serial"
            ) && bytes.get(at) == Some(&b'(')
            {
                match skip_group(bytes, at) {
                    Some(next) => at = next,
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
        }
        if ok && bytes.get(at) == Some(&b'(') {
            let start = skip_space(bytes, at + 1);
            if let Some(title) = string_at(bytes, start) {
                out.push(title);
            }
        }
        index += word;
    }
    out
}

/// The names `runVectors("<name>"` calls in a test file give.
pub fn vector_names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("runVectors(") {
        rest = &rest[at + "runVectors(".len()..];
        let bytes = rest.as_bytes();
        let start = skip_space(bytes, 0);
        if let Some(name) = string_at(bytes, start) {
            out.push(name);
        }
    }
    out
}

/// The old tests a vector file holds: each case's `ledger` title, else its
/// `name`, once each, in order.
pub fn vector_titles(root: &Path, name: &str) -> Result<Vec<String>> {
    let path = root
        .join("contract")
        .join("vectors")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("runVectors names {}", path.display()))?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).with_context(|| path.display().to_string())?;
    let mut out: Vec<String> = Vec::new();
    for case in doc["cases"].as_array().into_iter().flatten() {
        let title = case["ledger"]
            .as_str()
            .or_else(|| case["name"].as_str())
            .with_context(|| format!("{}: a case with no name", path.display()))?
            .replace(['\t', '\n'], " ");
        if !out.contains(&title) {
            out.push(title);
        }
    }
    Ok(out)
}

/// Every test of the TS suite.
pub fn discover(root: &Path) -> Result<Vec<TestId>> {
    let mut out = Vec::new();
    for base in TEST_ROOTS {
        let mut files: Vec<PathBuf> = walkdir::WalkDir::new(root.join(base))
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                !entry
                    .path()
                    .components()
                    .any(|part| part.as_os_str() == "node_modules")
            })
            .map(|entry| entry.into_path())
            .filter(|path| {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                name.ends_with(".test.ts") || name.ends_with(".test.js")
            })
            .collect();
        files.sort();
        for path in files {
            let text = std::fs::read_to_string(&path)?;
            let file = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let mut seen: BTreeMap<String, usize> = BTreeMap::new();
            let mut found: Vec<String> = Vec::new();
            for title in titles(&text) {
                let title = title.replace(['\t', '\n'], " ");
                let count = seen.entry(title.clone()).or_default();
                *count += 1;
                found.push(if *count == 1 {
                    title
                } else {
                    format!("{title}#{count}")
                });
            }
            // Vector cases carry their old title, numbered already.
            for name in vector_names(&text) {
                for title in vector_titles(root, &name)? {
                    if !found.contains(&title) {
                        found.push(title);
                    }
                }
            }
            for title in found {
                out.push(TestId {
                    file: file.clone(),
                    title,
                });
            }
        }
    }
    Ok(out)
}

pub fn ledger_path() -> PathBuf {
    repo_root().join("parity").join("ledger.tsv")
}

/// A mapping by file, from `parity/ledger-rules.tsv`: `prefix<TAB>
/// mapping<TAB>note[<TAB>title regex]`. The longest prefix of a test's file
/// (with the title regex, when given, matching its title) maps the tests no
/// scenario claims and the ledger has as `todo`. A rule's mapping may be
/// `todo` itself, with a note saying what it waits for. Rules are written
/// file by file, after reading the file's tests.
#[derive(Debug, Clone)]
pub struct Rule {
    pub prefix: String,
    pub mapping: String,
    pub note: String,
    pub title: Option<regex::Regex>,
}

pub fn rules_path() -> PathBuf {
    repo_root().join("parity").join("ledger-rules.tsv")
}

pub fn read_rules(path: &Path) -> Result<Vec<Rule>> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    let mut rules = Vec::new();
    for (number, line) in text.lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            bail!(
                "{}:{}: not prefix<TAB>mapping<TAB>note",
                path.display(),
                number + 1
            );
        }
        rules.push(Rule {
            prefix: parts[0].to_owned(),
            mapping: parts[1].to_owned(),
            note: parts[2].to_owned(),
            title: parts
                .get(3)
                .filter(|pattern| !pattern.is_empty())
                .map(|pattern| regex::Regex::new(pattern))
                .transpose()?,
        });
    }
    Ok(rules)
}

pub fn rule_for<'a>(rules: &'a [Rule], test: &TestId) -> Option<&'a Rule> {
    rules
        .iter()
        .filter(|rule| test.file.starts_with(&rule.prefix))
        .filter(|rule| {
            rule.title
                .as_ref()
                .is_none_or(|title| title.is_match(&test.title))
        })
        .max_by_key(|rule| (rule.prefix.len(), rule.title.is_some()))
}

pub const HEADER: &str = "file\ttest\tmapping\tnote";

pub fn read(path: &Path) -> Result<Vec<Row>> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    let mut rows = Vec::new();
    for (number, line) in text.lines().enumerate().skip(1) {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 3 {
            bail!(
                "{}:{}: not file<TAB>test<TAB>mapping<TAB>note",
                path.display(),
                number + 1
            );
        }
        rows.push(Row {
            id: TestId {
                file: parts[0].into(),
                title: parts[1].into(),
            },
            mapping: parts[2].into(),
            note: parts.get(3).copied().unwrap_or("").into(),
        });
    }
    Ok(rows)
}

pub fn write(path: &Path, rows: &[Row]) -> Result<()> {
    let mut text = String::from(HEADER);
    text.push('\n');
    for row in rows {
        text.push_str(&format!(
            "{}\t{}\t{}\t{}\n",
            row.id.file, row.id.title, row.mapping, row.note
        ));
    }
    std::fs::write(path, text)?;
    Ok(())
}

/// What the scenarios say they replace: `<file> > <title>` to scenario
/// paths (relative to the repository).
pub fn scenario_claims() -> Result<BTreeMap<String, BTreeSet<String>>> {
    let root = repo_root();
    let mut claims: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in scenario::all(&scenarios_dir()) {
        let loaded = scenario::load(&path)?;
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        for claim in loaded.ledger {
            claims.entry(claim).or_default().insert(relative.clone());
        }
    }
    Ok(claims)
}

/// The test a claim `<file> > <title>` names, if any (the title may carry
/// describe names before it, `a > b > title`; the last part is the title).
pub fn resolve<'a>(claim: &str, tests: &'a [TestId]) -> Option<&'a TestId> {
    let (file, title) = claim.split_once(" > ")?;
    tests
        .iter()
        .find(|test| test.file == file && test.title == title)
        .or_else(|| {
            let last = title.rsplit(" > ").next()?;
            tests
                .iter()
                .find(|test| test.file == file && test.title == last)
        })
}

/// The ledger rebuilt from the sources: every test, its scenario when one
/// claims it, else the mapping the old ledger had, else `todo`.
pub fn rebuild(
    tests: &[TestId],
    old: &[Row],
    claims: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Row> {
    let previous: BTreeMap<&TestId, &Row> = old.iter().map(|row| (&row.id, row)).collect();
    let rules = read_rules(&rules_path()).unwrap_or_default();
    let mut by_test: BTreeMap<&TestId, BTreeSet<String>> = BTreeMap::new();
    for (claim, paths) in claims {
        if let Some(test) = resolve(claim, tests) {
            by_test
                .entry(test)
                .or_default()
                .extend(paths.iter().cloned());
        }
    }
    tests
        .iter()
        .map(|test| {
            if let Some(paths) = by_test.get(test) {
                let mapping = paths
                    .iter()
                    .map(|path| format!("scenario:{path}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let note = previous
                    .get(test)
                    .map(|row| row.note.clone())
                    .unwrap_or_default();
                return Row {
                    id: test.clone(),
                    mapping,
                    note,
                };
            }
            match previous.get(test) {
                Some(row)
                    if !row.mapping.starts_with("scenario:")
                        && !row.mapping.starts_with("pending:")
                        && row.mapping != "todo" =>
                {
                    (*row).clone()
                }
                _ => match rule_for(&rules, test) {
                    Some(rule) => Row {
                        id: test.clone(),
                        mapping: rule.mapping.clone(),
                        note: rule.note.clone(),
                    },
                    None => Row {
                        id: test.clone(),
                        mapping: "todo".into(),
                        note: String::new(),
                    },
                },
            }
        })
        .collect()
}

/// The crates and Rust tests a mapping names: each `rust-unit:<crate>` part
/// (none named) or `rust-unit:<crate>:<test>` part, in order. Several parts
/// are separated by commas, as scenarios are.
///
/// `<test>` is the test's path as `cargo test -p <crate>` lists it for the
/// crate's library (`settings::tests::keeps_unknown_keys`), or for an
/// integration test `tests/<target>.rs`, the target's name then the path in
/// it (`lock_coexistence::bun_and_rust_take_turns`).
pub fn rust_units(mapping: &str) -> Vec<(String, Option<String>)> {
    mapping
        .split(',')
        .filter_map(|part| part.strip_prefix("rust-unit:"))
        .map(|unit| match unit.split_once(':') {
            Some((name, test)) => (name.to_owned(), Some(test.to_owned())),
            None => (unit.to_owned(), None),
        })
        .collect()
}

/// Where a crate that exists holds code of a later subtask:
/// `parity/unported.tsv` (`crate`, file prefix, subtask). A crate of the
/// plan's section 6.2 is made by the first subtask that ports into it,
/// while the rest of its rows wait for theirs: rows of an existing crate
/// under an unported prefix may name no test yet; every other row of an
/// existing crate names its test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unported {
    pub krate: String,
    pub prefix: String,
    pub subtask: String,
}

/// The entries of `parity/unported.tsv` (none when it is missing).
pub fn unported(root: &Path) -> Result<Vec<Unported>> {
    let path = root.join("parity/unported.tsv");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| path.display().to_string()),
    };
    let mut entries = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        let [krate, prefix, subtask] = parts[..] else {
            bail!(
                "{}:{}: want crate, prefix, subtask",
                path.display(),
                index + 1
            );
        };
        entries.push(Unported {
            krate: krate.into(),
            prefix: prefix.into(),
            subtask: subtask.into(),
        });
    }
    Ok(entries)
}

/// The directory of a crate the workspace has under `crates/`, if any.
pub fn crate_dir(root: &Path, name: &str) -> Option<PathBuf> {
    let dir = root.join("crates").join(name);
    dir.join("Cargo.toml").is_file().then_some(dir)
}

/// Whether `<test>` (see [`rust_units`]) is a test of the crate at `dir`:
/// a function under `#[test]` (or an attribute ending in `::test`, as
/// `#[tokio::test]`) in the file its path leads to, inside the inline
/// modules the rest of the path names.
pub fn rust_test_exists(dir: &Path, test: &str) -> bool {
    let parts: Vec<&str> = test.split("::").collect();
    let Some((name, modules)) = parts.split_last() else {
        return false;
    };
    // The longest prefix of the modules that is a file, the rest inline.
    let mut candidates: Vec<(PathBuf, usize)> = Vec::new();
    for taken in 0..=modules.len() {
        let path = &modules[..taken];
        if taken == 0 {
            candidates.push((dir.join("src").join("lib.rs"), 0));
            continue;
        }
        let joined: PathBuf = path.iter().collect();
        candidates.push((dir.join("src").join(&joined).with_extension("rs"), taken));
        candidates.push((dir.join("src").join(&joined).join("mod.rs"), taken));
        if taken == 1 {
            candidates.push((dir.join("tests").join(path[0]).with_extension("rs"), taken));
        }
    }
    candidates.into_iter().rev().any(|(file, taken)| {
        let Ok(text) = std::fs::read_to_string(&file) else {
            return false;
        };
        let inline = &modules[taken..];
        inline
            .iter()
            .all(|module| text.contains(&format!("mod {module} {{")))
            && has_test_fn(&text, name)
    })
}

/// Whether `text` has `fn <name>` right after a test attribute (other
/// attributes, comments and blank lines may come between).
fn has_test_fn(text: &str, name: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    let wanted = [format!("fn {name}("), format!("fn {name}<")];
    lines.iter().enumerate().any(|(index, line)| {
        let trimmed = line.trim_start();
        let is_fn = wanted.iter().any(|want| {
            trimmed.starts_with(want.as_str())
                || trimmed.starts_with(&format!("async {want}"))
                || trimmed.starts_with(&format!("pub {want}"))
        });
        if !is_fn {
            return false;
        }
        lines[..index]
            .iter()
            .rev()
            .map(|line| line.trim())
            .take_while(|line| {
                line.is_empty()
                    || line.starts_with("#[")
                    || line.starts_with("//")
                    || line.ends_with(")]")
            })
            .any(|line| line == "#[test]" || (line.starts_with("#[") && line.contains("::test")))
    })
}

#[cfg(test)]
mod tests {
    use super::{has_test_fn, rust_units, titles, vector_names};

    #[test]
    fn reads_the_crates_and_tests_a_mapping_names() {
        assert_eq!(
            rust_units("rust-unit:roamgate-base:settings::tests::a,rust-unit:roamgate-exec"),
            vec![
                (
                    "roamgate-base".to_owned(),
                    Some("settings::tests::a".to_owned())
                ),
                ("roamgate-exec".to_owned(), None)
            ]
        );
        assert!(rust_units("scenario:x.yaml").is_empty());
    }

    #[test]
    fn finds_test_functions_under_their_attribute() {
        let text = "mod tests {\n    #[test]\n    fn plain() {}\n\n    #[tokio::test(start_paused = true)]\n    // why\n    async fn timed() {}\n\n    fn helper() {}\n}\n";
        assert!(has_test_fn(text, "plain"));
        assert!(has_test_fn(text, "timed"));
        assert!(!has_test_fn(text, "helper"));
        assert!(!has_test_fn(text, "missing"));
    }

    #[test]
    fn finds_the_vector_files_a_test_file_runs() {
        let text = r#"
            import { runVectors } from "../contract/vectors/vectors";
            // The cases are contract/vectors/x.json.
            runVectors("speech-rate", { speechRate });
            runVectors( 'other', {});
        "#;
        assert_eq!(vector_names(text), vec!["speech-rate", "other"]);
    }

    #[test]
    fn finds_titles_and_skips_lookalikes() {
        let text = r#"
            test("plain", () => {});
            it('single', async () => {});
            test.skipIf(process.platform === "win32")(
              "after a modifier",
              () => {},
            );
            test.each([[1, 2]])("each %d", () => {});
            describe("group", () => { it(`template ${x}`, () => {}); });
            if (/x/.test("not a test")) {}
            const result = await test2("no");
            it("escaped \"quote\"", () => {});
        "#;
        assert_eq!(
            titles(text),
            vec![
                "plain",
                "single",
                "after a modifier",
                "each %d",
                "template ${x}",
                "escaped \"quote\""
            ]
        );
    }
}

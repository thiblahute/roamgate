//! The declared families (contract/wire/core-channel.md, Families in the
//! core, and One writer per file): contract/wire/families.json, embedded.

use std::sync::LazyLock;

use serde::Deserialize;

use crate::protocol::Families;

const FAMILIES_JSON: &str = include_str!("../../../contract/wire/families.json");

#[derive(Deserialize)]
struct FamiliesFile {
    families: Families,
}

static FAMILIES: LazyLock<Families> = LazyLock::new(|| {
    serde_json::from_str::<FamiliesFile>(FAMILIES_JSON)
        .expect("contract/wire/families.json parses")
        .families
});

/// The declared families.
pub fn families() -> &'static Families {
    &FAMILIES
}

/// The names of the families the core serves: the test family only when
/// tests are on.
pub fn implemented(test: bool, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .filter(|name| {
            families()
                .get(**name)
                .is_some_and(|family| test || !family.test)
        })
        .map(|name| (*name).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::Value;

    use super::*;

    #[test]
    fn no_file_has_two_writers_and_every_file_is_in_the_storage_index() {
        let index: Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../contract/storage/index.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let entries = index["entries"].as_object().unwrap();
        let mut writers: HashMap<&str, &str> = HashMap::new();
        for (family, declared) in families() {
            for file in &declared.files {
                if let Some(other) = writers.insert(file, family) {
                    panic!("{file} is in {other} and {family}");
                }
                assert!(
                    entries.contains_key(file),
                    "{family}: {file} is not in contract/storage/index.json"
                );
            }
        }
        assert!(!writers.is_empty());
    }

    #[test]
    fn the_test_family_needs_tests_on() {
        assert_eq!(implemented(false, &["test.echo", "work"]), vec!["work"]);
        assert_eq!(implemented(true, &["test.echo"]), vec!["test.echo"]);
    }
}

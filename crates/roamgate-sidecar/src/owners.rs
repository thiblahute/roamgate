//! The owners table (contract/wire/core-channel.md, Owners table and One
//! writer per file): which side owns each family, as the front last said,
//! and the families of contract/owners/families.json, embedded.

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock, RwLock};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::protocol::{
    CoreState, Families, OwnerMap, ShadowSettings, Side, route_http, route_rpc, shadow_side,
};

const FAMILIES_JSON: &str = include_str!("../../../contract/owners/families.json");

#[derive(Deserialize)]
struct FamiliesFile {
    families: Families,
}

static FAMILIES: LazyLock<Families> = LazyLock::new(|| {
    serde_json::from_str::<FamiliesFile>(FAMILIES_JSON)
        .expect("contract/owners/families.json parses")
        .families
});

/// The declared families.
pub fn families() -> &'static Families {
    &FAMILIES
}

/// The names of the families this side may serve: the test family only
/// when tests are on.
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

/// A write of a family this side does not own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{side} does not own the {family} family: it may not write its files")]
pub struct WriteRefused {
    pub family: String,
    pub side: &'static str,
}

#[derive(Debug, Clone, Default)]
struct Table {
    owners: BTreeMap<String, Side>,
    shadow: ShadowSettings,
    core: CoreState,
}

/// The owners table as one side knows it; clones share it.
#[derive(Debug, Clone)]
pub struct Owners {
    side: Side,
    test: bool,
    table: Arc<RwLock<Table>>,
}

impl Owners {
    /// The table of `side`: empty (every family Bun's) until told.
    pub fn new(side: Side, test: bool) -> Self {
        Self {
            side,
            test,
            table: Arc::default(),
        }
    }

    /// The front said the table (`welcome` or `owner`).
    pub fn set(&self, owners: BTreeMap<String, Side>, shadow: ShadowSettings) {
        let mut table = self.table.write().unwrap();
        table.owners = owners;
        table.shadow = shadow;
    }

    /// What the front knows of the core (the front's side of the table).
    pub fn set_core(&self, core: CoreState) {
        self.table.write().unwrap().core = core;
    }

    pub fn shadow(&self) -> ShadowSettings {
        self.table.read().unwrap().shadow
    }

    /// The owner the table names for `family`: Bun unless it says Rust.
    pub fn owner(&self, family: &str) -> Side {
        self.table
            .read()
            .unwrap()
            .owners
            .get(family)
            .copied()
            .unwrap_or(Side::Bun)
    }

    /// Whether this side may write `family`'s files: it is a declared
    /// family and this side owns it.
    pub fn check_write(&self, family: &str) -> Result<(), WriteRefused> {
        let known = families()
            .get(family)
            .is_some_and(|declared| self.test || !declared.test);
        if known && self.owner(family) == self.side {
            Ok(())
        } else {
            Err(WriteRefused {
                family: family.to_owned(),
                side: self.side.as_str(),
            })
        }
    }

    fn owner_map(table: &Table) -> OwnerMap {
        table
            .owners
            .iter()
            .map(|(family, side)| (family.clone(), Value::String(side.as_str().into())))
            .collect::<Map<_, _>>()
    }

    /// The side a browser RPC goes to (the front's question).
    pub fn route_rpc(&self, method: &str) -> Side {
        let table = self.table.read().unwrap();
        route_rpc(
            method,
            families(),
            &Self::owner_map(&table),
            &table.core,
            self.test,
        )
    }

    /// The side an HTTP path goes to.
    pub fn route_http(&self, path: &str) -> Side {
        let table = self.table.read().unwrap();
        route_http(
            path,
            families(),
            &Self::owner_map(&table),
            &table.core,
            self.test,
        )
    }

    /// The side a read is shadowed on, if any.
    pub fn shadow_side(&self, method: &str) -> Option<Side> {
        let table = self.table.read().unwrap();
        shadow_side(
            method,
            families(),
            &Self::owner_map(&table),
            &table.core,
            self.test,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

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
    fn only_the_owner_writes() {
        let rust = Owners::new(Side::Rust, false);
        assert!(rust.check_write("limit_resume").is_err());
        rust.set(
            BTreeMap::from([("limit_resume".into(), Side::Rust)]),
            ShadowSettings::default(),
        );
        assert_eq!(rust.check_write("limit_resume"), Ok(()));
        assert!(rust.check_write("work").is_err());
        assert!(rust.check_write("no_such_family").is_err());
        rust.set(
            BTreeMap::from([("test.echo".into(), Side::Rust)]),
            ShadowSettings::default(),
        );
        assert!(rust.check_write("test.echo").is_err());
        assert!(rust.check_write("limit_resume").is_err());

        let bun = Owners::new(Side::Bun, false);
        assert_eq!(bun.check_write("work"), Ok(()));
        bun.set(
            BTreeMap::from([("work".into(), Side::Rust)]),
            ShadowSettings::default(),
        );
        let error = bun.check_write("work").unwrap_err();
        assert_eq!(
            error.to_string(),
            "bun does not own the work family: it may not write its files"
        );
    }

    #[test]
    fn routes_by_the_table_and_the_core() {
        let front = Owners::new(Side::Bun, false);
        front.set(
            BTreeMap::from([("limit_resume".into(), Side::Rust)]),
            ShadowSettings::default(),
        );
        assert_eq!(front.route_rpc("limit_resume.list"), Side::Bun);
        front.set_core(CoreState {
            connected: true,
            families: vec!["limit_resume".into()],
        });
        assert_eq!(front.route_rpc("limit_resume.list"), Side::Rust);
        assert_eq!(front.shadow_side("limit_resume.list"), Some(Side::Bun));
        assert_eq!(front.route_http("/api/file/download"), Side::Bun);
        assert_eq!(implemented(false, &["test.echo", "work"]), vec!["work"]);
        assert_eq!(implemented(true, &["test.echo"]), vec!["test.echo"]);
    }
}

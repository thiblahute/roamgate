//! `contract/tools/catalog.json` (its README): every tool Roamgate gives a
//! model, by table, with its name, its input's JSON Schema and its
//! description verbatim. The texts are the catalog's bytes: the Rust side
//! never writes a tool's description or schema of its own.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value};

/// The catalog as the build embeds it.
pub const CATALOG_JSON: &str = include_str!("../../../contract/tools/catalog.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    pub version: u64,
    /// Names both sides share (`MOD_VIA`).
    pub constants: Map<String, Value>,
    /// The tables, in the catalog's order.
    pub tables: Map<String, Value>,
}

/// A table: what it is, and its tools in order.
#[derive(Debug, Clone, Deserialize)]
pub struct Table {
    pub about: String,
    pub tools: Vec<Tool>,
}

/// A tool: its name, description and input schema, and what its table adds
/// (`writes`, `replay`, `sequential`, the mod's `command` and `deferred`).
#[derive(Debug, Clone, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// The rest of the tool's fields, in the catalog's order.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Tool {
    /// Whether the tool changes what it works on (`writes`, a board's).
    pub fn writes(&self) -> bool {
        self.extra.get("writes").and_then(Value::as_bool) == Some(true)
    }
}

impl Catalog {
    /// Parses a catalog (the embedded one is [`catalog`]).
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// A table by name.
    pub fn table(&self, name: &str) -> Option<Table> {
        serde_json::from_value(self.tables.get(name)?.clone()).ok()
    }

    /// The tables' names, in order.
    pub fn table_names(&self) -> impl Iterator<Item = &str> {
        self.tables.keys().map(String::as_str)
    }

    /// A shared name (`MOD_VIA`).
    pub fn constant(&self, name: &str) -> Option<&str> {
        self.constants.get(name).and_then(Value::as_str)
    }
}

/// The embedded catalog.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG
        .get_or_init(|| Catalog::parse(CATALOG_JSON).expect("contract/tools/catalog.json parses"))
}

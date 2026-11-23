//! The tools of the Reviews board and of the reviews agent as the tool
//! catalog (`contract/tools/catalog.json`, tables `board` and
//! `reviews-agent`) has them: names, descriptions and JSON Schemas, so what
//! a model or an agent session reads is Bun's text byte for byte.
//!
//! TODO(S23): `roamgate-claude::catalog` (on `rust/s23-adapters`, not yet
//! on `rust/main`) reads every table of the catalog; once it lands, this
//! reader goes and [`table`] reads through it.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

/// A tool of a catalog table.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogTool {
    pub name: String,
    pub description: String,
    /// Its JSON Schema, as typebox serialises it.
    pub input_schema: Value,
    /// The board's: whether it changes the user's lists.
    pub writes: Option<bool>,
    /// The agent's: `safe` or `unsafe` to run again after a crash.
    pub replay: Option<String>,
    /// The agent's: whether it runs alone.
    pub sequential: Option<bool>,
}

static TABLES: LazyLock<HashMap<String, Vec<CatalogTool>>> = LazyLock::new(|| {
    let catalog: Value = serde_json::from_str(include_str!("../../../contract/tools/catalog.json"))
        .expect("the tool catalog is JSON");
    let tables = catalog["tables"].as_object().expect("catalog tables");
    tables
        .iter()
        .map(|(name, table)| {
            let tools = table["tools"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|tool| CatalogTool {
                    name: tool["name"].as_str().unwrap_or_default().to_owned(),
                    description: tool["description"].as_str().unwrap_or_default().to_owned(),
                    input_schema: tool["input_schema"].clone(),
                    writes: tool.get("writes").and_then(Value::as_bool),
                    replay: tool
                        .get("replay")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    sequential: tool.get("sequential").and_then(Value::as_bool),
                })
                .collect();
            (name.clone(), tools)
        })
        .collect()
});

/// A table's tools, in the catalog's order (none for an unknown table).
pub fn table(name: &str) -> &'static [CatalogTool] {
    TABLES.get(name).map_or(&[], Vec::as_slice)
}

/// One tool of a table.
pub fn tool(table_name: &str, name: &str) -> Option<&'static CatalogTool> {
    table(table_name).iter().find(|tool| tool.name == name)
}

//! The tools of the Reviews board and of the reviews agent as the tool
//! catalog (`contract/tools/catalog.json`, tables `board` and
//! `reviews-agent`) has them: names, descriptions and JSON Schemas, so what
//! a model or an agent session reads is Bun's text byte for byte. Read
//! through `roamgate-claude`'s catalog, with the fields these tables add.

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
    let catalog = roamgate_claude::catalog::catalog();
    catalog
        .table_names()
        .map(|name| {
            let tools = catalog
                .table(name)
                .map(|table| table.tools)
                .unwrap_or_default()
                .into_iter()
                .map(|tool| CatalogTool {
                    writes: tool.extra.get("writes").and_then(Value::as_bool),
                    replay: tool
                        .extra
                        .get("replay")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    sequential: tool.extra.get("sequential").and_then(Value::as_bool),
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.input_schema,
                })
                .collect();
            (name.to_owned(), tools)
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

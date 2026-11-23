//! The tool registry (Rust migration plan, section 6.2): what each of the
//! catalog's tables gives, in each form a model or a client sees it.
//!
//! - Socket commands: an agent socket command's `help` (`{"tools": [{name,
//!   description, writes, params}]}`, as the TS server's `work help`
//!   writes it) and the check of a call's parameters ([`Table::check`]).
//! - MCP tools: `{name, description, inputSchema}` per tool, as a loopback
//!   MCP server lists them.
//! - The mod's catalog: `server/claude-mod/hooks/catalog.gen.ts`, the
//!   module the Claude Code mod reads, rendered byte for byte.
//! - SKILL tables: the tool names SKILL.md's "Tools:" lines name, each one
//!   a tool of its table.
//!
//! Every text comes from the catalog: descriptions and schemas are never
//! written here.

use serde_json::{Map, Value, json};

use crate::catalog::{Catalog, Table, Tool, catalog};
use crate::schema::{SchemaError, first_error};

/// Why a call is refused before it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolCallError {
    /// No such tool in the table: the table's tool names, in order.
    Unknown { tool: String, known: Vec<String> },
    /// Its parameters do not fit its schema: the first error, if any.
    Invalid {
        tool: String,
        first: Option<SchemaError>,
    },
}

impl ToolCallError {
    /// As the TS boards say it.
    pub fn message(&self) -> String {
        match self {
            Self::Unknown { tool, known } => format!(
                "unknown tool {}: {} (help: each one's parameters)",
                js_prefix(tool, 60),
                known.join(", ")
            ),
            Self::Invalid { tool, first } => format!(
                "invalid {tool} parameters{}",
                first
                    .as_ref()
                    .map(|error| format!(": {}", error.describe()))
                    .unwrap_or_default()
            ),
        }
    }
}

/// `text.slice(0, max)` in UTF-16 units, never splitting a character.
fn js_prefix(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for character in text.chars() {
        units += character.len_utf16();
        if units > max {
            break;
        }
        out.push(character);
    }
    out
}

impl Table {
    /// A tool by name.
    pub fn tool(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// The tools' names, in order.
    pub fn names(&self) -> Vec<String> {
        self.tools.iter().map(|tool| tool.name.clone()).collect()
    }

    /// The tool `name` and its parameters checked against its schema.
    pub fn check(&self, name: &str, params: &Value) -> Result<&Tool, ToolCallError> {
        let tool = self.tool(name).ok_or_else(|| ToolCallError::Unknown {
            tool: name.to_owned(),
            known: self.names(),
        })?;
        match first_error(&tool.input_schema, params) {
            None => Ok(tool),
            Some(first) => Err(ToolCallError::Invalid {
                tool: name.to_owned(),
                first: Some(first),
            }),
        }
    }

    /// An agent socket command's `help`: each tool's name, description,
    /// whether it writes, and its parameters' schema.
    pub fn socket_help(&self) -> Value {
        json!({
            "tools": self
                .tools
                .iter()
                .map(|tool| {
                    let mut line = Map::new();
                    line.insert("name".into(), json!(tool.name));
                    line.insert("description".into(), json!(tool.description));
                    line.insert("writes".into(), json!(tool.writes()));
                    line.insert("params".into(), tool.input_schema.clone());
                    Value::Object(line)
                })
                .collect::<Vec<_>>()
        })
    }

    /// The tools as an MCP server lists them.
    pub fn mcp_tools(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })
            })
            .collect()
    }
}

/// A table of the embedded catalog; panics on a name it does not have (the
/// names are the code's own).
pub fn table(name: &str) -> &'static Table {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static TABLES: OnceLock<HashMap<String, Table>> = OnceLock::new();
    TABLES
        .get_or_init(|| {
            let catalog = catalog();
            catalog
                .table_names()
                .filter_map(|name| Some((name.to_owned(), catalog.table(name)?)))
                .collect()
        })
        .get(name)
        .unwrap_or_else(|| panic!("the catalog has no table {name}"))
}

/// `JSON.stringify(value, null, 2)`: serde_json's pretty printer writes the
/// same text for JSON data.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON serialises")
}

/// The Claude Code mod's module (`server/claude-mod/hooks/catalog.gen.ts`),
/// as `scripts/contract/tools-catalog.ts` renders it from the catalog.
pub fn mod_catalog_module(catalog: &Catalog) -> String {
    let via = catalog.constant("MOD_VIA").unwrap_or_default();
    let tools: Vec<Value> = catalog
        .tables
        .get("claude-mod")
        .and_then(|table| table.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .map(|tool| {
                    let mut out = Map::new();
                    let mut schema = Value::Null;
                    for (key, value) in tool.as_object().into_iter().flatten() {
                        if key == "input_schema" {
                            schema = value.clone();
                        } else {
                            out.insert(key.clone(), value.clone());
                        }
                    }
                    out.insert("inputSchema".into(), schema);
                    Value::Object(out)
                })
                .collect()
        })
        .unwrap_or_default();
    format!(
        "// Generated from contract/tools/catalog.json by\n// scripts/contract/tools-catalog.ts --write: do not edit.\n\n/** The client's name in requests: the server names its agent from it. */\nexport const MOD_VIA = {};\n\n/** The mod's tools: what the model sees of each, and the command it runs. */\nexport const MOD_TOOLS: readonly {{\n  name: string;\n  command: string;\n  description: string;\n  inputSchema: Record<string, unknown>;\n  deferred?: boolean;\n}}[] = {};\n",
        serde_json::to_string(via).expect("a string serialises"),
        pretty(&Value::Array(tools)),
    )
}

/// The tool names SKILL.md gives a table on its `Tools:` lines (each in
/// backquotes, from `Tools:` to the paragraph's end), in order, once each,
/// keeping those that start with `prefix`.
pub fn skill_tool_names(skill: &str, prefix: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for paragraph in skill.split("\n\n") {
        let Some(at) = paragraph.find("Tools: ") else {
            continue;
        };
        let words = &paragraph[at..];
        for (index, part) in words.split('`').enumerate() {
            if index % 2 == 1
                && part.starts_with(prefix)
                && part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character == '_')
                && !out.iter().any(|known| known == part)
            {
                out.push(part.to_owned());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_file(path: &str) -> String {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        std::fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
    }

    #[test]
    fn every_table_parses_and_names_its_tools_once() {
        let catalog = catalog();
        assert_eq!(catalog.constant("MOD_VIA"), Some("claude-mod"));
        for name in catalog.table_names() {
            let table = table(name);
            let mut names = table.names();
            let count = names.len();
            names.sort();
            names.dedup();
            assert_eq!(names.len(), count, "{name} repeats a tool name");
        }
    }

    #[test]
    fn texts_are_the_catalogs_bytes() {
        // Each description and schema serialises to the very text the
        // catalog's JSON holds for it.
        let raw: Value = serde_json::from_str(crate::catalog::CATALOG_JSON).unwrap();
        for (name, value) in raw["tables"].as_object().unwrap() {
            let table = table(name);
            for (tool, raw) in table.tools.iter().zip(value["tools"].as_array().unwrap()) {
                assert_eq!(
                    serde_json::to_string(&tool.description).unwrap(),
                    serde_json::to_string(&raw["description"]).unwrap()
                );
                assert_eq!(
                    serde_json::to_string(&tool.input_schema).unwrap(),
                    serde_json::to_string(&raw["input_schema"]).unwrap()
                );
            }
        }
    }

    #[test]
    fn socket_help_lists_each_tool_with_its_schema() {
        let help = table("work").socket_help();
        let tools = help["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "work_list");
        assert_eq!(tools[0]["writes"], false);
        assert_eq!(tools[1]["writes"], true);
        let first: Vec<&String> = tools[0].as_object().unwrap().keys().collect();
        assert_eq!(first, ["name", "description", "writes", "params"]);
        let mcp = table("voice-work").mcp_tools();
        assert_eq!(mcp[0]["name"], "work_list");
        assert!(mcp[0]["inputSchema"].is_object());
    }

    #[test]
    fn the_mods_module_is_rendered_byte_for_byte() {
        assert_eq!(
            mod_catalog_module(catalog()),
            repo_file("server/claude-mod/hooks/catalog.gen.ts")
        );
    }

    #[test]
    fn the_skill_names_only_tools_of_their_tables() {
        let skill = repo_file("contract/assets/skill/SKILL.md");
        let work = skill_tool_names(&skill, "work_");
        assert!(work.len() >= 8, "{work:?}");
        let known = table("work").names();
        for name in &work {
            assert!(
                known.contains(name),
                "SKILL.md names {name}, not a work tool"
            );
        }
        let board = table("board").names();
        let named = skill_tool_names(&skill, "reviews_");
        assert!(!named.is_empty());
        for name in named {
            assert!(
                board.contains(&name),
                "SKILL.md names {name}, not a board tool"
            );
        }
    }

    #[test]
    fn refusals_read_as_the_boards_say_them() {
        let work = table("work");
        let unknown = work.check("work_nothing", &json!({})).unwrap_err();
        assert!(
            unknown
                .message()
                .starts_with("unknown tool work_nothing: work_list, work_add,")
        );
        let invalid = work.check("work_list", &json!({"state": 5})).unwrap_err();
        assert_eq!(
            invalid.message(),
            "invalid work_list parameters: /state must be string"
        );
        assert!(work.check("work_list", &json!({"open": true})).is_ok());
    }
}

#[cfg(test)]
mod vector_tests {
    use super::*;
    use roamgate_protocol::vectors;

    /// `{"$repeat": [character, count]}` back to its string.
    fn expand(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                if let Some(Value::Array(repeat)) = object.get("$repeat")
                    && object.len() == 1
                {
                    let text = repeat[0].as_str().unwrap_or_default();
                    let count = repeat[1].as_u64().unwrap_or(0) as usize;
                    return Value::String(text.repeat(count));
                }
                Value::Object(
                    object
                        .iter()
                        .map(|(key, each)| (key.clone(), expand(each)))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            other => other.clone(),
        }
    }

    #[test]
    fn every_tools_refusals_read_as_typebox_says_them() {
        let file = vectors::load_raw("tool-params");
        let cases = file["refusals"].as_array().unwrap();
        assert!(cases.len() > 1000);
        for case in cases {
            let table = table(case["table"].as_str().unwrap());
            let tool = case["tool"].as_str().unwrap();
            let params = expand(&case["params"]);
            let got = match table.check(tool, &params) {
                Ok(_) => None,
                Err(ToolCallError::Invalid { first, .. }) => {
                    Some(first.map(|error| error.describe()).unwrap_or_default())
                }
                Err(other) => panic!("{tool}: {}", other.message()),
            };
            assert_eq!(
                got.as_deref(),
                case["error"].as_str(),
                "{} {tool} {}",
                case["table"],
                case["params"]
            );
        }
    }
}

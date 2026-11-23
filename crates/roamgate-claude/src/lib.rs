//! Roamgate's headless Claude layer (Rust migration plan, section 6.2).
//! For now its tool registry: every tool Roamgate gives a model comes from
//! `contract/tools/catalog.json`, served as agent socket commands, MCP
//! tools, the Claude Code mod's catalog and SKILL.md's tool lists, with
//! the texts compared byte for byte (`registry`). The Claude drivers, the
//! loopback MCP server and the mod hub come with their subtasks (S19 to
//! S23).

pub mod catalog;
pub mod driver;
pub mod mcp;
pub mod registry;
pub mod schema;

pub use catalog::{Catalog, Table, Tool, catalog};
pub use driver::{
    ClaudeCodeDriver, ClaudeCodeOptions, ClaudeCommand, ClaudeProcess, ClaudeTurn, CommandSource,
    SpawnClaude, ToolStatus, TurnEvent,
};
pub use mcp::{ClaudeError, ClaudeMcp, McpLease, McpTool, McpToolResult, McpTurn};
pub use registry::{ToolCallError, mod_catalog_module, skill_tool_names, table};
pub use schema::{SchemaError, errors, first_error};

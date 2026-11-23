//! Roamgate's Claude side (Rust migration plan, section 6.2).
//!
//! Its tool registry: every tool Roamgate gives a model comes from
//! `contract/tools/catalog.json`, served as agent socket commands, MCP
//! tools, the Claude Code mod's catalog and SKILL.md's tool lists, with
//! the texts compared byte for byte (`registry`); conversation mode's
//! Claude drivers (`conversation`); Claude Code turns and their loopback
//! MCP server ([`driver`], [`mcp`]); the Claude mod's hub ([`mod_hub`])
//! and its plugin, written as a marketplace on each host and installed
//! through Claude Code's own plugin command ([`plugin`]).

pub mod catalog;
pub mod conversation;
pub mod driver;
pub mod mcp;
pub mod mod_hub;
pub mod plugin;
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

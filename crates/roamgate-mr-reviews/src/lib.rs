//! Roamgate's MR reviews (Rust migration plan, section 6.2): the inbox of
//! merge and pull requests, its order, pins, overrides and lanes, what is
//! inferred of one's own work, upstreaming efforts and their ledger, and
//! the reviews agent. Requests are JavaScript objects, as Bun holds them,
//! so what is written and answered is Bun's JSON text.
//!
//! | Module | Role | Replaces |
//! |---|---|---|
//! | [`shared`] | Order, search filter, merge bots and scheduled merges, keys and unread marks | shared/mrReviews*.ts |
//! | [`settings`] | The settings in effect and as settings.json keeps them | mr-reviews/settings.ts |
//! | [`fetchers`] | The forge reads the inbox asks | mr-reviews/fetchers.ts |
//! | [`board_tools`] | The Reviews board's tools, for the reviews agent and every agent session | mr-reviews/board-tools.ts, module.ts's `boardTool` |
//! | [`agent_tools`] | The reviews agent's own tools and its system prompt | mr-reviews/agent-tools.ts |
//! | [`agent`] | The reviews agent's chat over a driver of Claude Code turns | mr-reviews/agent.ts |
//! | [`tool_catalog`] | The board's and the agent's tools as the tool catalog has them | contract/tools/catalog.json |
//! | [`agent_search`] | The reviews agent's searches, and requests as the agent names them | mr-reviews/agent-search.ts |
//! | [`inbox`] | The inbox: refresh, merge, own requests, pins, snapshot | mr-reviews/inbox.ts |
//! | [`order`] | The user's order as the server keeps it, versions and Undo | mr-reviews/order.ts |
//! | [`rpc`] | `bridge.mr_reviews.*`: checks and the inbox, order and settings methods | mr-reviews/rpc.ts |
//! | [`clones`] | The user's clones of a project, found from their workspaces' folders | mr-reviews/clones.ts |
//! | [`worktree`] | The review worktree's scripts: create, prefetch, status, checkout | mr-reviews/worktree.ts |
//! | [`tree`] | Where a review workspace goes in the Workspaces tree | mr-reviews/tree.ts |
//! | [`links`] | The workspaces that are a request's | mr-reviews/links.ts |
//! | [`upstream`] | Branches headed upstream, read from their checkouts | mr-reviews/upstream.ts |
//! | [`effort_board`] | The inbox entry of each planned request of an effort | mr-reviews/effort-board.ts |
//! | [`open`] | Opening a request: clone, review worktree and workspace, review, checkout, prefetch | mr-reviews/open.ts |
//! | [`claude`] | The review workspace's Claude: one pane, a session per request | mr-reviews/claude.ts |
//! | [`home`] | A request's home: its own worktree workspace, review and agent | mr-reviews/home.ts |
//! | [`workspace_tree`] | The Workspaces tree's paths, ancestors and live resolution | shared/workspaceTree.ts (in part) |

pub mod agent;
pub mod agent_search;
pub mod agent_tools;
pub mod board_tools;
pub mod claude;
pub mod clones;
pub mod connection;
pub mod curation;
pub mod effort_board;
pub mod efforts;
pub mod fetchers;
pub mod forge_ref;
pub mod fuzzy;
pub mod home;
pub mod inbox;
pub mod inference;
pub mod lanes;
pub mod links;
pub mod open;
pub mod order;
pub mod overrides;
pub mod queries;
pub mod rpc;
pub mod settings;
pub mod shared;
pub mod store;
pub mod tool_catalog;
pub mod tree;
pub mod upstream;
pub mod workspace_tree;
pub mod worktree;

#[cfg(test)]
mod vectors_tests;

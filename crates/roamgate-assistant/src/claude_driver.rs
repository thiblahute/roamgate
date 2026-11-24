//! Ranger's Claude Code side (`createClaudeCodeDriver` with Ranger's
//! tools and system prompt): `roamgate-claude`'s generic driver, its turn
//! given Ranger's tools as MCP tools and its events as Ranger's.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use roamgate_base::paths::DataContext;
use roamgate_claude::mcp::RANGER_MCP_SERVER;
use roamgate_claude::{
    ClaudeCodeDriver, ClaudeCodeOptions, ClaudeError, ClaudeMcp, ClaudeTurn, CommandSource,
    McpTool, McpToolResult, TurnEvent,
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::driver::{AssistantDriver, LoginInteraction, RunEvent, RunInput};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{BoxFuture, RangerTool, ranger_system_prompt, ranger_tools};

/// `sharedMcp`: one loopback server for every Ranger directory.
fn shared_mcp() -> ClaudeMcp {
    static MCP: OnceLock<ClaudeMcp> = OnceLock::new();
    MCP.get_or_init(|| ClaudeMcp::new(RANGER_MCP_SERVER))
        .clone()
}

fn from_claude(error: ClaudeError) -> AssistantError {
    match error {
        ClaudeError::User(message) => AssistantError::User(message),
        ClaudeError::Internal(message) => AssistantError::Internal(message),
    }
}

fn to_claude(error: AssistantError) -> ClaudeError {
    if error.surfaced() {
        ClaudeError::User(error.message().to_owned())
    } else {
        ClaudeError::Internal(error.message().to_owned())
    }
}

/// A Ranger tool as the loopback MCP server lists and runs it.
pub(crate) fn mcp_tool(tool: RangerTool) -> McpTool {
    let ranger = tool.clone();
    McpTool {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        call: Arc::new(move |params, cancel| {
            let called = ranger.call(params, Some(cancel));
            Box::pin(async move {
                called
                    .await
                    .map(|result| McpToolResult {
                        text: result.text,
                        sources: result.sources,
                    })
                    .map_err(to_claude)
            })
        }),
    }
}

/// A Claude Code turn's event as Ranger's run reports it.
pub fn run_event(event: TurnEvent) -> RunEvent {
    match event {
        TurnEvent::Delta(text) => RunEvent::Delta(text),
        TurnEvent::Message(text) => RunEvent::Message(text),
        TurnEvent::Tool {
            id,
            name,
            status,
            arguments,
            output,
        } => {
            // The TS passes `{arguments, output}` with the absent ones left
            // out of the JSON.
            let mut details = Map::new();
            if let Some(arguments) = arguments {
                details.insert("arguments".into(), json!(arguments));
            }
            if let Some(output) = output {
                details.insert("output".into(), json!(output));
            }
            RunEvent::Tool {
                id,
                name,
                status: status.as_str().to_owned(),
                details: Some(Value::Object(details)),
            }
        }
        TurnEvent::Thinking(steps) => RunEvent::Thinking(steps),
        TurnEvent::Sources(sources) => RunEvent::Sources(Value::Array(sources)),
        TurnEvent::Error => RunEvent::Error,
    }
}

/// Ranger's driver for its own provider.
#[derive(Clone)]
pub struct RangerClaude(ClaudeCodeDriver);

impl RangerClaude {
    /// `createClaudeCodeDriver({directory, mcp: sharedMcp})`.
    pub fn new(directory: PathBuf, data: DataContext, command: CommandSource) -> Self {
        Self(ClaudeCodeDriver::new(ClaudeCodeOptions {
            directory,
            data,
            mcp: shared_mcp(),
            command,
            spawn: None,
            available: None,
            system_prompt: Arc::new(ranger_system_prompt),
        }))
    }

    /// Over a driver made elsewhere (tests).
    pub fn with(driver: ClaudeCodeDriver) -> Self {
        Self(driver)
    }
}

impl AssistantDriver for RangerClaude {
    fn catalog(&self, _source: &str) -> BoxFuture<AssistantResult<Value>> {
        let catalog = self.0.catalog();
        Box::pin(async move { Ok(catalog) })
    }

    fn login(
        &self,
        _provider: &str,
        _method: &str,
        _source: &str,
        _interaction: Arc<dyn LoginInteraction>,
        _cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async {
            Err(AssistantError::internal(
                "Claude Code signs in with `claude` on this machine",
            ))
        })
    }

    fn run(
        &self,
        input: RunInput,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let driver = self.0.clone();
        let handlers = input.handlers.clone();
        let events = input.events.clone();
        let checkpoint = input.checkpoint.clone().map(|checkpoint| {
            Arc::new(move |entries: Vec<Value>| {
                let saved = checkpoint(entries);
                Box::pin(async move { saved.await.map_err(to_claude) })
                    as futures_util::future::BoxFuture<'static, Result<(), ClaudeError>>
            }) as roamgate_claude::driver::Checkpoint
        });
        let turn = ClaudeTurn {
            config: input.config,
            entries: input.entries,
            text: input.text,
            recover: input.recover,
            tools: Box::new(move |automatic| {
                ranger_tools(&handlers, automatic)
                    .into_iter()
                    .map(mcp_tool)
                    .collect()
            }),
            checkpoint,
            events: Arc::new(move |event| events(run_event(event))),
        };
        Box::pin(async move { driver.run(turn, cancel).await.map_err(from_claude) })
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let driver = self.0.clone();
        Box::pin(async move {
            driver.stop().await;
            Ok(())
        })
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let driver = self.0.clone();
        Box::pin(async move {
            driver.dispose().await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_claude::ToolStatus;

    #[test]
    fn claude_events_reach_ranger_as_its_run_reports_them() {
        assert_eq!(
            run_event(TurnEvent::Tool {
                id: "t".into(),
                name: "workspace_list".into(),
                status: ToolStatus::Running,
                arguments: None,
                output: None,
            }),
            RunEvent::Tool {
                id: "t".into(),
                name: "workspace_list".into(),
                status: "running".into(),
                details: Some(json!({})),
            }
        );
        assert_eq!(
            run_event(TurnEvent::Tool {
                id: "t".into(),
                name: "workspace_list".into(),
                status: ToolStatus::Failed,
                arguments: Some("{}".into()),
                output: Some("no".into()),
            }),
            RunEvent::Tool {
                id: "t".into(),
                name: "workspace_list".into(),
                status: "failed".into(),
                details: Some(json!({"arguments": "{}", "output": "no"})),
            }
        );
        assert_eq!(
            run_event(TurnEvent::Sources(vec![json!({"kind": "terminal"})])),
            RunEvent::Sources(json!([{"kind": "terminal"}]))
        );
    }

    #[test]
    fn a_user_error_stays_one_both_ways_and_others_stay_masked() {
        assert_eq!(
            from_claude(ClaudeError::User("Pick one".into())),
            AssistantError::User("Pick one".into())
        );
        assert_eq!(
            to_claude(AssistantError::internal("/run/x.sock")),
            ClaudeError::Internal("/run/x.sock".into())
        );
        assert_eq!(
            to_claude(AssistantError::Platform("Not on Windows".into())),
            ClaudeError::User("Not on Windows".into())
        );
    }
}

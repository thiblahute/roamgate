//! Ranger's Pi side: `roamgate-pi`'s client of the Pi sidecar (S24), its
//! run's callbacks and tool handlers answered from Ranger's.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use roamgate_pi::{PiDriver, PiError, PiSidecar, SidecarConfig};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::driver::{AssistantDriver, LoginInteraction, RunEvent, RunInput, SaveModels};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{BoxFuture, Family, Handler, RangerHandlers, tools_of};

fn from_pi(error: PiError) -> AssistantError {
    match error {
        PiError::User(message) => AssistantError::User(message),
        other => AssistantError::Internal(other.to_string()),
    }
}

fn to_pi(error: AssistantError) -> PiError {
    if error.surfaced() {
        PiError::User(error.message().to_owned())
    } else {
        PiError::Failed(error.message().to_owned())
    }
}

fn run_event(event: roamgate_pi::RunEvent) -> RunEvent {
    use roamgate_pi::RunEvent as Pi;
    match event {
        Pi::Delta(text) => RunEvent::Delta(text),
        Pi::Message(text) => RunEvent::Message(text),
        Pi::Tool {
            id,
            name,
            status,
            details,
        } => RunEvent::Tool {
            id,
            name,
            status,
            details,
        },
        Pi::Error => RunEvent::Error,
        Pi::Replace(text) => RunEvent::Replace(text),
        Pi::Thinking(steps) => RunEvent::Thinking(steps),
        Pi::Sources(sources) => RunEvent::Sources(sources),
        Pi::Steered { request_id, text } => RunEvent::Steered { request_id, text },
    }
}

/// The handler of a run's tool family (`run.tool`'s `handler`), with the
/// family whose tools it runs.
fn handler_of<'a>(handlers: &'a RangerHandlers, name: &str) -> Option<(&'a Handler, Family)> {
    Some(match name {
        "read" => (&handlers.read, Family::Workspace),
        "propose" => (handlers.propose.as_ref()?, Family::Action),
        "task" => (handlers.task.as_ref()?, Family::Task),
        "notify" => (handlers.notify.as_ref()?, Family::Notification),
        "show" => (handlers.show.as_ref()?, Family::Show),
        "arrange" => (handlers.arrange.as_ref()?, Family::Tree),
        "threads" => (handlers.threads.as_ref()?, Family::Thread),
        "archive" => (handlers.archive.as_ref()?, Family::Archive),
        _ => return None,
    })
}

struct Handlers {
    input: RunInput,
}

impl roamgate_pi::RunHandler for Handlers {
    fn callbacks(&self) -> Vec<&'static str> {
        crate::driver::RUN_CALLBACKS
            .into_iter()
            .filter(|name| self.input.has(name))
            .collect()
    }

    fn handlers(&self) -> Vec<&'static str> {
        [
            "propose", "task", "notify", "show", "arrange", "threads", "archive",
        ]
        .into_iter()
        .filter(|name| handler_of(&self.input.handlers, name).is_some())
        .collect()
    }

    fn event(&self, event: roamgate_pi::RunEvent) {
        (self.input.events)(run_event(event));
    }

    fn checkpoint(&self, entries: Vec<Value>) -> roamgate_pi::BoxFuture<Result<(), PiError>> {
        let checkpoint = self.input.checkpoint.clone();
        Box::pin(async move {
            match checkpoint {
                Some(checkpoint) => checkpoint(entries).await.map_err(to_pi),
                None => Ok(()),
            }
        })
    }

    /// The handler with its arguments: a kind and parameters (`read`,
    /// `propose`, `task`, `arrange`, `archive`), or parameters alone (the
    /// families of one tool).
    fn tool(
        &self,
        handler: &str,
        args: Vec<Value>,
        cancel: CancellationToken,
    ) -> roamgate_pi::BoxFuture<Result<Value, PiError>> {
        let Some((run, family)) = handler_of(&self.input.handlers, handler) else {
            let message = format!("Unknown tool handler {handler}");
            return Box::pin(async move { Err(PiError::failed(message)) });
        };
        let tools = tools_of(family);
        let (kind, params) = match args.as_slice() {
            [Value::String(kind), params] => (
                tools
                    .iter()
                    .find(|tool| tool.kind == kind)
                    .map(|tool| tool.kind),
                params.clone(),
            ),
            [params] => (tools.first().map(|tool| tool.kind), params.clone()),
            _ => (None, Value::Null),
        };
        let Some(kind) = kind else {
            return Box::pin(async { Err(PiError::failed("Invalid tool call")) });
        };
        let called = run(kind, params, Some(cancel));
        Box::pin(async move {
            let result = called.await.map_err(to_pi)?;
            let mut value = json!({"text": result.text});
            if let Some(sources) = result.sources {
                value["sources"] = Value::Array(sources);
            }
            Ok(value)
        })
    }
}

struct Interaction(Arc<dyn LoginInteraction>);

impl roamgate_pi::LoginInteraction for Interaction {
    fn prompt(
        &self,
        prompt: Value,
        cancel: CancellationToken,
    ) -> roamgate_pi::BoxFuture<Result<String, PiError>> {
        let answer = self.0.prompt(prompt, cancel);
        Box::pin(async move { answer.await.map_err(to_pi) })
    }

    fn event(&self, event: Value) {
        self.0.event(event);
    }
}

/// Ranger's driver for every provider but its own: Pi in the sidecar, or,
/// where no sidecar is found, a Pi that says so (Claude Code still runs).
#[derive(Clone)]
pub struct RangerPi(Option<PiDriver>);

const NO_SIDECAR: &str = "Pi is not available: no Pi sidecar was found";

impl RangerPi {
    pub fn new(driver: Option<PiDriver>) -> Self {
        Self(driver)
    }

    /// Pi for a Ranger directory, in the server's one sidecar: the one
    /// `ROAMGATE_PI_SIDECAR` names, else `roamgate-pi` beside the
    /// executable.
    pub fn for_directory(directory: &str, credential_directory: &str) -> Self {
        static SIDECAR: OnceLock<Option<PiSidecar>> = OnceLock::new();
        let sidecar = SIDECAR.get_or_init(|| {
            let value = std::env::var("ROAMGATE_PI_SIDECAR").ok();
            let exe = std::env::current_exe().ok();
            SidecarConfig::from_env(value.as_deref(), exe.as_deref()).map(PiSidecar::new)
        });
        Self(
            sidecar
                .clone()
                .map(|sidecar| PiDriver::new(sidecar, directory, Some(credential_directory))),
        )
    }

    fn driver(&self) -> AssistantResult<PiDriver> {
        self.0
            .clone()
            .ok_or_else(|| AssistantError::internal(NO_SIDECAR))
    }
}

impl AssistantDriver for RangerPi {
    fn catalog(&self, source: &str) -> BoxFuture<AssistantResult<Value>> {
        let (driver, source) = (self.driver(), source.to_owned());
        Box::pin(async move { driver?.catalog(&source).await.map_err(from_pi) })
    }

    fn configures_models(&self) -> bool {
        true
    }

    fn configure_model(&self, input: Value, save: SaveModels) -> BoxFuture<AssistantResult<()>> {
        let driver = self.driver();
        Box::pin(async move {
            let save: roamgate_pi::SaveModels = Arc::new(move |path, value| {
                let saved = save(path, value).map_err(to_pi);
                Box::pin(async move { saved })
            });
            driver?.configure_model(input, save).await.map_err(from_pi)
        })
    }

    fn reads_tool_details(&self) -> bool {
        true
    }

    fn read_tool_details(
        &self,
        entries: Vec<Value>,
        messages: Value,
        source_directory: Option<PathBuf>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let driver = self.driver();
        Box::pin(async move {
            let source = source_directory.map(|path| path.to_string_lossy().into_owned());
            driver?
                .read_tool_details(entries, messages, source.as_deref())
                .await
                .map_err(from_pi)
        })
    }

    fn login(
        &self,
        provider: &str,
        method: &str,
        source: &str,
        interaction: Arc<dyn LoginInteraction>,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>> {
        let driver = self.driver();
        let (provider, method, source) =
            (provider.to_owned(), method.to_owned(), source.to_owned());
        Box::pin(async move {
            driver?
                .login(
                    &provider,
                    &method,
                    &source,
                    Arc::new(Interaction(interaction)),
                    cancel,
                )
                .await
                .map_err(from_pi)
        })
    }

    fn run(
        &self,
        input: RunInput,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let driver = self.driver();
        Box::pin(async move {
            let run = roamgate_pi::RunInput {
                config: input.config.clone(),
                entries: input.entries.clone(),
                text: input.text.clone(),
                request_id: input.request_id.clone(),
                recover: input.recover,
                steers: input.steers.clone(),
            };
            driver?
                .run(run, Arc::new(Handlers { input }), cancel)
                .await
                .map_err(from_pi)
        })
    }

    fn steers(&self) -> bool {
        true
    }

    fn steer(&self, text: &str, request_id: &str) -> BoxFuture<AssistantResult<()>> {
        let driver = self.driver();
        let (text, request_id) = (text.to_owned(), request_id.to_owned());
        Box::pin(async move { driver?.steer(&text, &request_id).await.map_err(from_pi) })
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let driver = self.0.clone();
        Box::pin(async move {
            match driver {
                Some(driver) => driver.stop().await.map_err(from_pi),
                None => Ok(()),
            }
        })
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let driver = self.0.clone();
        Box::pin(async move {
            match driver {
                Some(driver) => driver.dispose().await.map_err(from_pi),
                None => Ok(()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ToolResult;
    use roamgate_pi::RunHandler;
    use std::sync::Mutex;

    fn input(calls: Arc<Mutex<Vec<(String, Value)>>>) -> RunInput {
        let recorder = |calls: Arc<Mutex<Vec<(String, Value)>>>| -> Handler {
            Arc::new(move |kind, params, _| {
                calls.lock().unwrap().push((kind.to_owned(), params));
                Box::pin(async { Ok(ToolResult::text("done")) })
            })
        };
        let mut handlers = RangerHandlers::reading(recorder(calls.clone()));
        handlers.notify = Some(recorder(calls));
        RunInput {
            config: json!({}),
            entries: Vec::new(),
            text: "Hi".into(),
            request_id: None,
            recover: false,
            steers: None,
            callbacks: vec!["thinking"],
            checkpoint: None,
            events: Arc::new(|_| {}),
            handlers,
        }
    }

    #[tokio::test]
    async fn pi_reaches_the_handlers_the_run_has_with_their_kind() {
        let calls = Arc::default();
        let handlers = Handlers {
            input: input(Arc::clone(&calls)),
        };
        assert_eq!(handlers.handlers(), ["notify"]);
        assert_eq!(handlers.callbacks(), ["thinking"]);
        let kind = tools_of(Family::Workspace)[0].kind;
        let read = handlers
            .tool(
                "read",
                vec![json!(kind), json!({"a": 1})],
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(read, json!({"text": "done"}));
        handlers
            .tool(
                "notify",
                vec![json!({"title": "t"})],
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            handlers
                .tool("propose", vec![json!({})], CancellationToken::new())
                .await
                .is_err()
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls[0], (kind.to_owned(), json!({"a": 1})));
        assert_eq!(
            calls[1],
            (
                tools_of(Family::Notification)[0].kind.to_owned(),
                json!({"title": "t"})
            )
        );
    }

    #[tokio::test]
    async fn without_a_sidecar_pi_says_so_and_stops_quietly() {
        let pi = RangerPi::new(None);
        assert_eq!(pi.catalog("pi").await.unwrap_err().message(), NO_SIDECAR);
        assert!(pi.stop().await.is_ok());
        assert!(pi.dispose().await.is_ok());
    }
}

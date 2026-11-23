//! Ranger's model driver (`assistant/ranger-driver.ts`): Claude Code for
//! its own provider, Pi for every other. A chat that changes driver starts
//! afresh: neither can read the other's saved context.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::driver::{AssistantDriver, LoginInteraction, RunInput, SaveModels};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::BoxFuture;
use crate::wire::{CLAUDE_CODE_PROVIDER, is_uuid};

/// `isPiPointer`: Pi's saved context is one `ranger-durable` entry.
fn is_pi_pointer(entries: &[Value]) -> bool {
    entries.len() == 1 && entries[0].get("type").and_then(Value::as_str) == Some("ranger-durable")
}

/// `isClaudeCodePointer`: one `{type: "ranger-claude", session: <uuid>}`.
pub fn is_claude_code_pointer(entries: &[Value]) -> bool {
    entries.len() == 1
        && entries[0].get("type").and_then(Value::as_str) == Some("ranger-claude")
        && entries[0]
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|session| is_uuid(session) && session == session.to_lowercase())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Pi,
    Claude,
}

/// `createRangerDriver(directory, credentialDirectory, {pi, claude})`.
pub struct RangerDriver {
    pi: Arc<dyn AssistantDriver>,
    claude: Arc<dyn AssistantDriver>,
    running: Arc<Mutex<Option<Kind>>>,
}

impl RangerDriver {
    pub fn new(pi: Arc<dyn AssistantDriver>, claude: Arc<dyn AssistantDriver>) -> Self {
        Self {
            pi,
            claude,
            running: Arc::default(),
        }
    }
}

fn providers(catalog: &Value) -> Vec<Value> {
    catalog
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn models(catalog: &Value) -> Vec<Value> {
    catalog
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

impl AssistantDriver for RangerDriver {
    fn catalog(&self, source: &str) -> BoxFuture<AssistantResult<Value>> {
        let (pi, claude, source) = (self.pi.clone(), self.claude.clone(), source.to_owned());
        Box::pin(async move {
            let own = claude.catalog(&source).await?;
            let other = match pi.catalog(&source).await {
                Ok(other) => other,
                // Pi's models failing to load must not hide Claude Code.
                Err(error) => {
                    let configured = providers(&own)
                        .iter()
                        .any(|provider| provider.get("configured") == Some(&Value::Bool(true)));
                    if !configured {
                        return Err(error);
                    }
                    json!({"providers": [], "models": []})
                }
            };
            let mut all_providers = providers(&own);
            all_providers.extend(providers(&other));
            let mut all_models = models(&own);
            all_models.extend(models(&other));
            Ok(json!({"providers": all_providers, "models": all_models}))
        })
    }

    fn configures_models(&self) -> bool {
        true
    }

    fn configure_model(&self, input: Value, save: SaveModels) -> BoxFuture<AssistantResult<()>> {
        let pi = self.pi.clone();
        Box::pin(async move {
            if input.get("provider").and_then(Value::as_str) == Some(CLAUDE_CODE_PROVIDER) {
                return Err(AssistantError::internal(
                    "Use a distinct custom provider identifier",
                ));
            }
            if !pi.configures_models() {
                return Err(AssistantError::internal("Invalid model connection"));
            }
            pi.configure_model(input, save).await
        })
    }

    fn reads_tool_details(&self) -> bool {
        self.pi.reads_tool_details()
    }

    fn read_tool_details(
        &self,
        entries: Vec<Value>,
        messages: Value,
        source_directory: Option<PathBuf>,
    ) -> BoxFuture<AssistantResult<Value>> {
        if is_pi_pointer(&entries) {
            self.pi
                .read_tool_details(entries, messages, source_directory)
        } else {
            Box::pin(async move { Ok(messages) })
        }
    }

    fn login(
        &self,
        provider: &str,
        method: &str,
        source: &str,
        interaction: Arc<dyn LoginInteraction>,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>> {
        if provider == CLAUDE_CODE_PROVIDER {
            return Box::pin(async {
                Err(AssistantError::internal(
                    "Claude Code signs in with `claude` on this machine",
                ))
            });
        }
        self.pi.login(provider, method, source, interaction, cancel)
    }

    fn run(
        &self,
        mut input: RunInput,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let kind =
            if input.config.get("provider").and_then(Value::as_str) == Some(CLAUDE_CODE_PROVIDER) {
                Kind::Claude
            } else {
                Kind::Pi
            };
        let keep = match kind {
            Kind::Claude => is_claude_code_pointer(&input.entries),
            Kind::Pi => is_pi_pointer(&input.entries),
        };
        if !keep {
            input.entries = Vec::new();
        }
        *self.running.lock().unwrap() = Some(kind);
        let driver = match kind {
            Kind::Claude => self.claude.clone(),
            Kind::Pi => self.pi.clone(),
        };
        let running = self.running.clone();
        Box::pin(async move {
            let result = driver.run(input, cancel).await;
            let mut running = running.lock().unwrap();
            if *running == Some(kind) {
                *running = None;
            }
            result
        })
    }

    fn steers(&self) -> bool {
        true
    }

    fn steer(&self, text: &str, request_id: &str) -> BoxFuture<AssistantResult<()>> {
        // Claude Code takes no input into a running turn: the caller queues
        // it as a follow-up.
        if *self.running.lock().unwrap() != Some(Kind::Pi) || !self.pi.steers() {
            return Box::pin(async { Err(AssistantError::internal("Ranger is not running")) });
        }
        self.pi.steer(text, request_id)
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let (pi, claude) = (self.pi.stop(), self.claude.stop());
        Box::pin(async move {
            let (a, b) = tokio::join!(pi, claude);
            a.and(b)
        })
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let (pi, claude) = (self.pi.dispose(), self.claude.dispose());
        Box::pin(async move {
            let (a, b) = tokio::join!(pi, claude);
            a.and(b)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::RunEvent;
    use crate::tools::{RangerHandlers, ToolResult};
    use tokio::sync::Notify;

    type Runs = Arc<Mutex<Vec<(&'static str, Vec<Value>)>>>;

    struct Fake {
        name: &'static str,
        catalog: Option<Value>,
        fails: bool,
        steers: bool,
        runs: Runs,
        steered: Arc<Mutex<Vec<String>>>,
        gate: Option<Arc<Notify>>,
        result: Value,
    }

    impl AssistantDriver for Fake {
        fn catalog(&self, _source: &str) -> BoxFuture<AssistantResult<Value>> {
            let (catalog, fails) = (self.catalog.clone(), self.fails);
            Box::pin(async move {
                if fails {
                    return Err(AssistantError::internal("Invalid model configuration"));
                }
                Ok(catalog.unwrap_or(json!({"providers": [], "models": []})))
            })
        }
        fn configures_models(&self) -> bool {
            self.name == "pi"
        }
        fn configure_model(&self, _: Value, _: SaveModels) -> BoxFuture<AssistantResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn login(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: Arc<dyn LoginInteraction>,
            _: CancellationToken,
        ) -> BoxFuture<AssistantResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn run(
            &self,
            input: RunInput,
            _: CancellationToken,
        ) -> BoxFuture<AssistantResult<Vec<Value>>> {
            self.runs.lock().unwrap().push((self.name, input.entries));
            let (gate, result) = (self.gate.clone(), self.result.clone());
            Box::pin(async move {
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                Ok(vec![result])
            })
        }
        fn steers(&self) -> bool {
            self.steers
        }
        fn steer(&self, text: &str, _: &str) -> BoxFuture<AssistantResult<()>> {
            self.steered.lock().unwrap().push(text.to_owned());
            Box::pin(async { Ok(()) })
        }
        fn stop(&self) -> BoxFuture<AssistantResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct Fakes {
        driver: RangerDriver,
        runs: Runs,
        steered: Arc<Mutex<Vec<String>>>,
    }

    fn fakes(
        pi_fails: bool,
        claude_configured: bool,
        gates: Option<(Arc<Notify>, Arc<Notify>)>,
    ) -> Fakes {
        let runs: Runs = Arc::default();
        let steered: Arc<Mutex<Vec<String>>> = Arc::default();
        let pi = Fake {
            name: "pi",
            catalog: Some(json!({
                "providers": [{"id": "igalia", "label": "Igalia", "methods": [], "configured": true}],
                "models": [{"provider": "igalia", "id": "ember-1", "label": "ember-1", "thinking_levels": []}],
            })),
            fails: pi_fails,
            steers: true,
            runs: runs.clone(),
            steered: steered.clone(),
            gate: gates.as_ref().map(|gates| gates.0.clone()),
            result: json!({"type": "ranger-durable", "id": "d"}),
        };
        let claude = Fake {
            name: "claude",
            catalog: Some(json!({
                "providers": [{"id": CLAUDE_CODE_PROVIDER, "label": "Claude Code", "methods": [], "configured": claude_configured}],
                "models": [],
            })),
            fails: false,
            steers: false,
            runs: runs.clone(),
            steered: steered.clone(),
            gate: gates.map(|gates| gates.1),
            result: json!({"type": "ranger-claude", "session": "s"}),
        };
        Fakes {
            driver: RangerDriver::new(Arc::new(pi), Arc::new(claude)),
            runs,
            steered,
        }
    }

    fn input(provider: &str, entries: Vec<Value>) -> RunInput {
        RunInput {
            config: json!({"provider": provider, "model": "m", "credential_source": "pi", "allowed_workspaces": []}),
            entries,
            text: "Hi".into(),
            request_id: None,
            recover: false,
            steers: None,
            callbacks: Vec::new(),
            checkpoint: None,
            events: Arc::new(|_: RunEvent| {}),
            handlers: RangerHandlers::reading(Arc::new(|_, _, _| {
                Box::pin(async { Ok(ToolResult::text("")) })
            })),
        }
    }

    fn claude_pointer() -> Value {
        json!({"type": "ranger-claude", "session": "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10"})
    }

    fn pi_pointer() -> Value {
        json!({"type": "ranger-durable", "id": "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10"})
    }

    fn ids(catalog: &Value) -> Vec<String> {
        providers(catalog)
            .iter()
            .map(|provider| provider["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn offers_claude_code_next_to_pi_s_providers() {
        let catalog = fakes(false, true, None).driver.catalog("pi").await.unwrap();
        assert_eq!(ids(&catalog), [CLAUDE_CODE_PROVIDER, "igalia"]);
    }

    #[tokio::test]
    async fn pi_failing_to_load_does_not_hide_claude_code_unless_it_is_missing_too() {
        let catalog = fakes(true, true, None).driver.catalog("pi").await.unwrap();
        assert_eq!(ids(&catalog), [CLAUDE_CODE_PROVIDER]);
        let error = fakes(true, false, None)
            .driver
            .catalog("pi")
            .await
            .unwrap_err();
        assert_eq!(error.message(), "Invalid model configuration");
    }

    #[tokio::test]
    async fn each_turn_goes_to_its_provider_s_driver_with_only_its_own_context() {
        let Fakes { driver, runs, .. } = fakes(false, true, None);
        let token = CancellationToken::new;
        driver
            .run(input(CLAUDE_CODE_PROVIDER, vec![claude_pointer()]), token())
            .await
            .unwrap();
        driver
            .run(input(CLAUDE_CODE_PROVIDER, vec![pi_pointer()]), token())
            .await
            .unwrap();
        driver
            .run(input("igalia", vec![pi_pointer()]), token())
            .await
            .unwrap();
        driver
            .run(input("igalia", vec![claude_pointer()]), token())
            .await
            .unwrap();
        assert_eq!(
            *runs.lock().unwrap(),
            vec![
                ("claude", vec![claude_pointer()]),
                ("claude", vec![]),
                ("pi", vec![pi_pointer()]),
                ("pi", vec![]),
            ]
        );
    }

    #[tokio::test]
    async fn only_a_running_pi_turn_takes_steering_a_claude_turn_queues_it() {
        let (pi_gate, claude_gate) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let Fakes {
            driver, steered, ..
        } = fakes(false, true, Some((pi_gate.clone(), claude_gate.clone())));
        let driver = Arc::new(driver);
        let steer = |text: &str| driver.steer(text, text);
        assert_eq!(
            steer("idle").await.unwrap_err().message(),
            "Ranger is not running"
        );
        let pi_turn = tokio::spawn(driver.run(input("igalia", vec![]), CancellationToken::new()));
        steer("to pi").await.unwrap();
        pi_gate.notify_one();
        pi_turn.await.unwrap().unwrap();
        let claude_turn = tokio::spawn(driver.run(
            input(CLAUDE_CODE_PROVIDER, vec![]),
            CancellationToken::new(),
        ));
        assert_eq!(
            steer("to claude").await.unwrap_err().message(),
            "Ranger is not running"
        );
        claude_gate.notify_one();
        claude_turn.await.unwrap().unwrap();
        assert_eq!(*steered.lock().unwrap(), ["to pi"]);
    }

    struct NoInteraction;
    impl LoginInteraction for NoInteraction {
        fn prompt(&self, _: Value, _: CancellationToken) -> BoxFuture<AssistantResult<String>> {
            Box::pin(async { Ok(String::new()) })
        }
        fn event(&self, _: Value) {}
    }

    #[tokio::test]
    async fn claude_code_has_no_model_connection_or_sign_in_of_its_own() {
        let Fakes { driver, .. } = fakes(false, true, None);
        let save: SaveModels = Arc::new(|_, _| Ok(()));
        assert!(
            driver
                .configure_model(
                    json!({"provider": CLAUDE_CODE_PROVIDER, "model": "opus", "base_url": "https://x", "api": "anthropic-messages", "credential_source": "pi"}),
                    save,
                )
                .await
                .is_err()
        );
        let error = driver
            .login(
                CLAUDE_CODE_PROVIDER,
                "oauth",
                "pi",
                Arc::new(NoInteraction),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.message().contains("Claude Code signs in"));
    }
}

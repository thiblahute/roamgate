//! The forge CLIs as Bun ran them for these targets: glab and gh through
//! one forge gate (workspace/forge-calls.ts `forgeGate`, one per server),
//! on this machine or on a checkout's SSH host through the core's session
//! slots; and the inbox's forge reads (mr-reviews/fetchers.ts
//! `createInboxFetchers`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use roamgate_agents::js::{self, Obj};
use roamgate_base::clock::BoxFuture;
use roamgate_exec::process::ProcessRunner;
use roamgate_forge::gate::{ForgeCall, ForgeGate, ProcessOutput, Spawn};
use roamgate_forge::review::cli::{
    ForgeContext, ForgeProcess, ForgeRunner, ForgeTools, LocalForgeRunner, RunError,
};
use roamgate_forge::review::gitlab::{FieldKind, GlabCall, GlabHost, glab, glab_host_access};
use roamgate_forge::review::status::gh_host_login;
use roamgate_mr_reviews::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use serde_json::Value;

use super::Layer;
use super::connections::{SshRun, run_ssh};

/// The server's one forge gate: its per-host budgets, queues, rate-limit
/// pauses and shared answers hold for every feature, as Bun's did.
pub(crate) fn shared_gate(clock: &roamgate_base::clock::SharedClock) -> ForgeGate {
    static GATE: OnceLock<ForgeGate> = OnceLock::new();
    GATE.get_or_init(|| ForgeGate::new(clock.clone())).clone()
}

fn gate(layer: &Layer) -> ForgeGate {
    shared_gate(&layer.clock)
}

/// Runs the forge code's processes as Bun's `runProcessWithCodeTimeout`
/// did: here, or over the connection's SSH through the core's slots.
struct LayerRunner {
    layer: Arc<Layer>,
    local: LocalForgeRunner,
}

impl ForgeRunner for LayerRunner {
    fn run(
        &self,
        process: ForgeProcess,
        timeout_ms: u64,
    ) -> BoxFuture<Result<ProcessOutput, RunError>> {
        match process {
            ForgeProcess::Ssh {
                host,
                command,
                read,
                tag,
            } => {
                let layer = self.layer.clone();
                Box::pin(async move {
                    let ran = run_ssh(
                        &layer,
                        &host,
                        &command,
                        SshRun {
                            read,
                            tag: &tag,
                            connection: None,
                            stdin: None,
                            timeout_ms,
                            lane: roamgate_exec::lanes::current_lane(),
                        },
                    )
                    .await
                    .map_err(RunError::Failed)?;
                    Ok(ProcessOutput {
                        code: ran.code,
                        stdout: String::from_utf8_lossy(&ran.stdout).into_owned(),
                        stderr: ran.stderr,
                    })
                })
            }
            other => self.local.run(other, timeout_ms),
        }
    }
}

/// The forge tools every checkout's context shares (one gate scope, the
/// hosts' logins remembered a while).
fn tools(layer: &Arc<Layer>) -> ForgeTools {
    static TOOLS: OnceLock<ForgeTools> = OnceLock::new();
    TOOLS
        .get_or_init(|| {
            ForgeTools::new(
                Arc::new(LayerRunner {
                    layer: layer.clone(),
                    local: LocalForgeRunner::new(ProcessRunner::new(layer.clock.clone())),
                }),
                gate(layer),
                layer.clock.clone(),
                "server",
            )
        })
        .clone()
}

/// A checkout's context: `host` its connection's SSH destination.
pub(super) fn context(layer: &Arc<Layer>, root: &str, host: Option<&str>) -> ForgeContext {
    tools(layer).context(root, host.map(str::to_owned))
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// A gate log word as `&'static str` (glab's call takes them so): the
/// few the inbox and the reviews agent use, kept once each.
fn word(text: &str) -> &'static str {
    static WORDS: LazyLock<Mutex<HashSet<&'static str>>> = LazyLock::new(Mutex::default);
    let mut words = WORDS.lock().unwrap();
    if let Some(word) = words.get(text) {
        return word;
    }
    let word: &'static str = Box::leak(text.to_owned().into_boxed_str());
    words.insert(word);
    word
}

/// How long one forge CLI may take (fetchers.ts TIMEOUT_MS).
const TIMEOUT_MS: u64 = 30_000;

/// `createInboxFetchers(runProcessWithCodeTimeout)`: the user's own glab
/// and gh on this machine, from the home directory.
pub(super) struct LocalFetchers {
    pub layer: Arc<Layer>,
}

impl LocalFetchers {
    fn context(&self) -> ForgeContext {
        context(&self.layer, &home(), None)
    }

    async fn access(&self, context: &ForgeContext, host: &str) -> FetchResult<bool> {
        glab_host_access(context, host).await.map_err(|message| {
            let lower = message.to_lowercase();
            if lower.contains("not installed") {
                FetchError::ToolMissing("glab is not installed".into())
            } else if lower.contains("no login") {
                FetchError::NotSignedIn(format!(
                    "Not signed in to {host} (glab auth login --hostname {host})"
                ))
            } else {
                FetchError::Failed(message)
            }
        })
    }

    async fn glab_get(&self, item: &Obj, path: String, kind: &'static str) -> FetchResult<Value> {
        let host = item.get("host").and_then(Value::as_str).unwrap_or("");
        let context = self.context();
        let own = self.access(&context, host).await?;
        glab(
            &context,
            &GlabHost {
                host: host.to_owned(),
                own_login: Some(own),
            },
            "GET",
            &path,
            &[],
            Some(false),
            GlabCall {
                feature: Some("inbox"),
                kind: Some(kind),
                ..GlabCall::default()
            },
        )
        .await
        .map_err(FetchError::Failed)
    }
}

/// `projects/<encoded project>/merge_requests/<number>/<what>`.
fn request_path(item: &Obj, what: &str) -> String {
    let project = item.get("project").and_then(Value::as_str).unwrap_or("");
    let number = js::to_text(item.get("number").unwrap_or(&Value::Null));
    format!(
        "projects/{}/merge_requests/{number}/{what}?per_page=100",
        roamgate_agents::paths::encode_uri_component(project)
    )
}

impl InboxFetchers for LocalFetchers {
    fn gitlab<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> roamgate_mr_reviews::connection::BoxFuture<'a, FetchResult<Value>> {
        Box::pin(async move {
            let context = self.context();
            let own = self.access(&context, host).await?;
            glab(
                &context,
                &GlabHost {
                    host: host.to_owned(),
                    own_login: Some(own),
                },
                "POST",
                "graphql",
                &[("query".to_owned(), query.to_owned(), FieldKind::Raw)],
                Some(false),
                GlabCall {
                    feature: Some(word(&call.feature)),
                    kind: Some(word(&call.kind)),
                    reuse_ms: call.reuse_ms.map(|ms| ms as i64),
                    input: None,
                },
            )
            .await
            .map_err(FetchError::Failed)
        })
    }

    fn github<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> roamgate_mr_reviews::connection::BoxFuture<'a, FetchResult<Value>> {
        Box::pin(async move {
            let context = self.context();
            let code = gh_host_login(&context, host).await.unwrap_or(-1);
            if code == 127 {
                return Err(FetchError::ToolMissing("gh is not installed".into()));
            }
            if code != 0 {
                return Err(FetchError::NotSignedIn(format!(
                    "Not signed in to {host} (gh auth login --hostname {host})"
                )));
            }
            let mut argv = vec!["gh".to_owned(), "api".to_owned()];
            if host != "github.com" {
                argv.extend(["--hostname".to_owned(), host.to_owned()]);
            }
            argv.extend([
                "graphql".to_owned(),
                "-f".to_owned(),
                format!("query={query}"),
            ]);
            let root = home();
            let cwd = if Path::new(&root).exists() {
                root
            } else {
                String::new()
            };
            let runner = context.tools.runner.clone();
            let spawn: Spawn = Arc::new(move |full: Vec<String>| {
                let runner = runner.clone();
                let cwd = cwd.clone();
                Box::pin(async move {
                    let ran = runner
                        .run(
                            ForgeProcess::Cli {
                                argv: full,
                                cwd,
                                env: [
                                    ("GH_PROMPT_DISABLED", "1"),
                                    ("GIT_TERMINAL_PROMPT", "0"),
                                    ("NO_COLOR", "1"),
                                ]
                                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                                .to_vec(),
                                unset: Vec::new(),
                            },
                            TIMEOUT_MS,
                        )
                        .await;
                    match ran {
                        Ok(output) => Ok(output),
                        Err(RunError::Missing(_)) => Ok(ProcessOutput {
                            code: 127,
                            ..ProcessOutput::default()
                        }),
                        Err(RunError::Failed(message)) => Err(message),
                    }
                })
            });
            let output = context
                .tools
                .gate
                .run(
                    &context.tools.owner,
                    ForgeCall {
                        checkout: None,
                        host: host.to_owned(),
                        feature: call.feature.clone(),
                        kind: call.kind.clone(),
                        reuse_ms: call.reuse_ms.filter(|ms| *ms > 0).map(|ms| ms as i64),
                        ..ForgeCall::default()
                    },
                    argv,
                    spawn,
                )
                .await
                .map_err(|error| FetchError::Failed(error.to_string()))?;
            if output.code == 127 {
                return Err(FetchError::ToolMissing("gh is not installed".into()));
            }
            // A GraphQL answer with errors (a followed repository gone)
            // still has its data: gh exits 1 but prints it.
            let body = js::trim(&output.stdout);
            if body.starts_with('{')
                && let Some(parsed) = js::parse(body)
            {
                return Ok(parsed);
            }
            let reason = if output.stderr.is_empty() {
                "the request failed"
            } else {
                &output.stderr
            };
            Err(FetchError::Failed(format!(
                "GitHub: {}",
                js::head16(js::trim(reason), 300)
            )))
        })
    }

    fn gitlab_drafts<'a>(
        &'a self,
        item: &'a Obj,
    ) -> roamgate_mr_reviews::connection::BoxFuture<'a, FetchResult<usize>> {
        Box::pin(async move {
            let answer = self
                .glab_get(item, request_path(item, "draft_notes"), "drafts")
                .await?;
            Ok(answer.as_array().map_or(0, Vec::len))
        })
    }

    fn gitlab_label_events<'a>(
        &'a self,
        item: &'a Obj,
    ) -> Option<roamgate_mr_reviews::connection::BoxFuture<'a, FetchResult<Obj>>> {
        Some(Box::pin(async move {
            let answer = self
                .glab_get(
                    item,
                    request_path(item, "resource_label_events"),
                    "label-events",
                )
                .await?;
            Ok(roamgate_mr_reviews::queries::parse_label_events(&answer))
        }))
    }
}

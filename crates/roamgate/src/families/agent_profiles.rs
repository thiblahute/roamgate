//! The agent_profiles family in the core: roamgate-connections'
//! `agent_profiles` (contract/wire/core-channel.md, The agent_profiles
//! family).
//!
//! - Browser calls: `agent_profile.get`, `.switch`, `.launch`, `.retry`.
//! - The front's own calls: `internal.agent_profiles.store {op, ...}` (a
//!   change Bun's store made: `set`, `choose_model`, `settle_model`).
//! - Reverse calls: `profiles.host {op, connection_id?, ...}` (what the
//!   RPCs need of a connection, by Bun's code: its settings, Herdr's
//!   agent, conversation mode, the transcript tail, a typed launch, the
//!   Claude mod, its log), `profiles.sessions_changed {sessions}` (every
//!   choice after each write, in write order, before the write's answer),
//!   `connections.list`.
//!
//! While owned the core is session-profiles.json's one writer and runs the
//! return to the default profile after a limit's reset (every minute, as
//! Bun did).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::ProcessEnv;
use roamgate_base::log::{LogFields, Logger};
use roamgate_base::paths::DataContext;
use roamgate_channel::family::{CoreFamily, FamilyContext};
use roamgate_channel::peer::{BoxFuture as PeerFuture, IncomingCall};
use roamgate_channel::protocol::{Push, RpcError};
use roamgate_connections::agent_profiles::rpc::{
    HostFuture, ProfileRpcContext, ProfileRpcHost, ResetConnection, Restart, handle_profile_rpc,
    return_after_reset,
};
use roamgate_connections::agent_profiles::store::{LaunchSpec, SessionProfiles};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};

use super::limit_resume::scoped_logger;

pub const FAMILY: &str = "agent_profiles";

/// How often sessions due back on their default profile are looked at.
const RETURN_CHECK: Duration = Duration::from_secs(60);

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(AgentProfilesFamily::default()))
}

#[derive(Default)]
struct AgentProfilesFamily {
    running: Mutex<Option<Running>>,
}

/// Tells the front every choice after each write, one at a time in write
/// order; `flushed` is the last write it heard.
#[derive(Clone)]
struct Notifier {
    written: Arc<AtomicU64>,
    flushed: watch::Receiver<u64>,
}

impl Notifier {
    /// Waits until the front heard every write made so far.
    async fn flush(&self) {
        let upto = self.written.load(Ordering::SeqCst);
        let mut flushed = self.flushed.clone();
        let _ = flushed.wait_for(|done| *done >= upto).await;
    }
}

#[derive(Clone)]
struct Running {
    store: Arc<SessionProfiles>,
    notifier: Notifier,
    tasks: Arc<Vec<tokio::task::JoinHandle<()>>>,
    logger: Logger,
}

fn running_store(cx: &FamilyContext) -> Running {
    let (sender, mut receiver) = mpsc::unbounded_channel::<(u64, Map<String, Value>)>();
    let (flushed_tx, flushed) = watch::channel(0u64);
    let written = Arc::new(AtomicU64::new(0));
    let observer = {
        let written = written.clone();
        Arc::new(move |sessions: &Map<String, Value>| {
            let seq = written.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = sender.send((seq, sessions.clone()));
        })
    };
    let store = Arc::new(SessionProfiles::at_data_root(
        DataContext::from_env(&ProcessEnv),
        Some(observer),
        None,
    ));
    let teller = {
        let cx = cx.clone();
        tokio::spawn(async move {
            while let Some((seq, sessions)) = receiver.recv().await {
                let _ = cx
                    .reverse(
                        "profiles.sessions_changed",
                        json!({ "sessions": Value::Object(sessions) }),
                    )
                    .await;
                let _ = flushed_tx.send(seq);
            }
        })
    };
    let notifier = Notifier { written, flushed };
    let logger = scoped_logger(cx, "bridge.profiles");
    let returns = {
        let cx = cx.clone();
        let store = store.clone();
        let notifier = notifier.clone();
        let logger = logger.clone();
        tokio::spawn(async move {
            let mut ticks = cx.clock.interval(RETURN_CHECK);
            loop {
                ticks.tick().await;
                return_due(&cx, &store, &logger).await;
                account_upkeep(&cx, &logger).await;
                notifier.flush().await;
            }
        })
    };
    let usage = {
        let cx = cx.clone();
        tokio::spawn(async move {
            let mut ticks = cx.clock.interval(USAGE_CHECK);
            loop {
                ticks.tick().await;
                usage_due(&cx).await;
            }
        })
    };
    Running {
        store,
        notifier,
        tasks: Arc::new(vec![teller, returns, usage]),
        logger,
    }
}

/// The return after a reset, over every connection the front runs.
async fn return_due(cx: &FamilyContext, store: &Arc<SessionProfiles>, logger: &Logger) {
    let Ok(settings) = cx.reverse("profiles.host", json!({"op": "settings"})).await else {
        return;
    };
    let connections: Vec<Arc<dyn ResetConnection>> = cx
        .reverse("connections.list", json!({}))
        .await
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|status| status.get("id")?.as_str().map(str::to_owned))
        .map(|id| {
            Arc::new(ConnectionReset {
                host: ReverseHost::new(cx, Some(id), logger.clone()),
                store: store.clone(),
            }) as Arc<dyn ResetConnection>
        })
        .collect();
    let log = |message: &str, fields: Value| {
        let fields: LogFields = fields.as_object().cloned().unwrap_or_default();
        logger.info(message, Some(&fields));
    };
    return_after_reset(&settings, store, &connections, &log).await;
}

/// How often the usage scheduler looks for accounts due a reading (each
/// account is read about every 90 s, see roamgate_accounts::usage).
const USAGE_CHECK: Duration = Duration::from_secs(15);

/// Reads the accounts due a reading, and tells every browser what changed
/// once (`account_usage`, a keyed push): never computed per client.
async fn usage_due(cx: &FamilyContext) {
    use roamgate_connections::agent_profiles::shared::profile_account_id;
    use roamgate_connections::agent_profiles::store::{account_dir_of, profiles_list, profiles_of};
    let Ok(settings) = cx.reverse("profiles.host", json!({"op": "settings"})).await else {
        return;
    };
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let accounts: Vec<roamgate_accounts::PolledAccount> =
        profiles_list(&profiles_of(Some(&settings)))
            .iter()
            .filter_map(|profile| {
                let (agent, dir) = account_dir_of(profile, &home)?;
                Some(roamgate_accounts::PolledAccount {
                    agent,
                    id: profile_account_id(profile)?.to_owned(),
                    dir,
                })
            })
            .collect();
    let delta = USAGE.poll(&accounts, cx.clock.now()).await;
    if delta.is_empty() {
        return;
    }
    cx.push(Push {
        message: json!({"account_usage": {
            "accounts": delta.accounts,
            "removed": delta.removed,
        }}),
        key: Some("account_usage".into()),
        ..Push::default()
    });
}

/// The account profiles' upkeep (roamgate_accounts::maintain): tokens
/// refreshed before they expire, MCP logins shared, `.claude.json` kept
/// in step. Each minute, with the return after a reset.
async fn account_upkeep(cx: &FamilyContext, logger: &Logger) {
    use roamgate_connections::agent_profiles::store::{account_dir_of, profiles_list, profiles_of};
    let Ok(settings) = cx.reverse("profiles.host", json!({"op": "settings"})).await else {
        return;
    };
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let accounts: Vec<_> = profiles_list(&profiles_of(Some(&settings)))
        .iter()
        .filter_map(|profile| account_dir_of(profile, &home))
        .collect();
    if accounts.is_empty() {
        return;
    }
    let user = roamgate_accounts::UserDirs::of(&home, &|name| std::env::var(name).ok());
    let data_root = roamgate_connections::agent_profiles::store::data_root_for(&home);
    for line in
        roamgate_accounts::maintain(&LOGINS, &accounts, &user, &data_root, cx.clock.now()).await
    {
        logger.info(&format!("accounts: {line}"), None);
    }
}

/// A connection as the return after a reset sees it: Bun's panes, and the
/// core's own `agent_profile.switch`.
struct ConnectionReset {
    host: ReverseHost,
    store: Arc<SessionProfiles>,
}

impl ResetConnection for ConnectionReset {
    fn panes(&self) -> HostFuture<'_, Vec<(String, String)>> {
        Box::pin(async move {
            self.host
                .op("panes", json!({}))
                .await
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|pane| {
                    Some((
                        pane.get("paneId")?.as_str()?.to_owned(),
                        pane.get("sessionId")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
    }

    fn switch_pane<'a>(&'a self, pane_id: &'a str, profile: &'a str) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            let params = json!({"pane_id": pane_id, "profile": profile});
            let context = rpc_context(&self.host.cx, self.store.clone());
            match handle_profile_rpc(
                "agent_profile.switch",
                params.as_object().unwrap(),
                &self.host,
                &context,
            )
            .await
            {
                Ok(result) => Restart::from_value(&result),
                Err(error) => Restart::refused(error.0),
            }
        })
    }
}

fn rpc_context(cx: &FamilyContext, store: Arc<SessionProfiles>) -> ProfileRpcContext {
    let clock = cx.clock.clone();
    ProfileRpcContext {
        store,
        now: Arc::new(move || clock.now()),
        home: std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default(),
        logins: LOGINS.clone(),
        usage: Some(USAGE.clone()),
    }
}

/// The accounts' usage readings, one scheduler for the process.
static USAGE: std::sync::LazyLock<Arc<roamgate_accounts::UsagePoller>> =
    std::sync::LazyLock::new(|| {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        Arc::new(roamgate_accounts::UsagePoller::new(
            &roamgate_connections::agent_profiles::store::data_root_for(&home),
            roamgate_accounts::Endpoints::default(),
            "agy",
        ))
    });

/// The account sign-ins in progress, one set for the process.
static LOGINS: std::sync::LazyLock<Arc<roamgate_accounts::Logins>> =
    std::sync::LazyLock::new(Arc::default);

/// What the RPCs ask of Bun, by `profiles.host` reverse calls.
struct ReverseHost {
    cx: FamilyContext,
    connection_id: Option<String>,
    logger: Logger,
}

impl ReverseHost {
    fn new(cx: &FamilyContext, connection_id: Option<String>, logger: Logger) -> Self {
        Self {
            cx: cx.clone(),
            connection_id,
            logger,
        }
    }

    fn args(&self, op: &str, mut args: Value) -> Value {
        args["op"] = json!(op);
        if let Some(connection_id) = &self.connection_id {
            args["connection_id"] = json!(connection_id);
        }
        args
    }

    async fn op(&self, op: &str, args: Value) -> Result<Value, String> {
        self.cx
            .reverse("profiles.host", self.args(op, args))
            .await
            .map_err(|error| error.message)
    }

    async fn pane_op(&self, op: &str, pane_id: &str) -> Value {
        self.op(op, json!({ "pane_id": pane_id }))
            .await
            .unwrap_or(Value::Null)
    }
}

fn text_of(value: Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

impl ProfileRpcHost for ReverseHost {
    fn read_settings(&self) -> HostFuture<'_, Result<Value, String>> {
        Box::pin(self.op("settings", json!({})))
    }

    fn agent_get<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<Value>> {
        Box::pin(
            async move { Some(self.pane_op("agent_get", pane_id).await).filter(|v| !v.is_null()) },
        )
    }

    fn conversation_session<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async move { text_of(self.pane_op("conversation_session", pane_id).await) })
    }

    fn conversation_model<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async move { text_of(self.pane_op("conversation_model", pane_id).await) })
    }

    fn restart_process<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            match self
                .op("restart_process", json!({ "pane_id": pane_id }))
                .await
            {
                Ok(value) => Restart::from_value(&value),
                Err(error) => Restart::refused(error),
            }
        })
    }

    fn restart_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        session_id: Option<&'a str>,
    ) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            let mut args = json!({ "pane_id": pane_id });
            if let Some(session_id) = session_id {
                args["session_id"] = json!(session_id);
            }
            match self.op("restart_terminal", args).await {
                Ok(value) => Restart::from_value(&value),
                Err(error) => Restart::refused(error),
            }
        })
    }

    fn transcript_tail<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async move { text_of(self.pane_op("transcript_tail", pane_id).await) })
    }

    fn typed_launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> HostFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let value = self
                .op("typed_launch", json!({ "pane_id": pane_id, "spec": spec }))
                .await?;
            text_of(value).ok_or_else(|| "profiles.host: no launch text".to_owned())
        })
    }

    fn send_conversation<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.op(
                "send_conversation",
                json!({ "pane_id": pane_id, "text": text }),
            )
            .await
            .map(|_| ())
        })
    }

    fn prompt_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.op(
                "prompt_terminal",
                json!({ "pane_id": pane_id, "text": text }),
            )
            .await
            .map(|_| ())
        })
    }

    fn mod_usage<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<Value>> {
        Box::pin(
            async move { Some(self.pane_op("mod_usage", pane_id).await).filter(|v| !v.is_null()) },
        )
    }

    /// The connection's own log line, as Bun's runtime writes it.
    fn log(&self, message: &str, fields: Value) {
        let args = self.args("log", json!({ "message": message, "fields": fields }));
        let cx = self.cx.clone();
        let logger = self.logger.clone();
        let message = message.to_owned();
        tokio::spawn(async move {
            if cx.reverse("profiles.host", args).await.is_err() {
                logger.info(&message, None);
            }
        });
    }
}

impl AgentProfilesFamily {
    fn running(&self) -> Option<Running> {
        self.running.lock().unwrap().clone()
    }
}

fn not_owner() -> RpcError {
    RpcError::with_code("the agent_profiles family is not served here", "not_owner")
}

/// Applies a change Bun's store made (`internal.agent_profiles.store`).
fn apply(store: &SessionProfiles, params: &Value) -> Result<(), RpcError> {
    let text = |key: &str| params.get(key).and_then(Value::as_str);
    let session_id = text("session_id")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| RpcError::new("agent_profiles.store needs a session_id"))?;
    match text("op") {
        Some("set") => {
            let back = params.get("back").and_then(|back| {
                Some((back.get("at")?.as_f64()? as i64, back.get("to")?.as_str()?))
            });
            store.set(session_id, text("profile"), back, text("model"));
        }
        Some("choose_model") => store.choose_model(session_id, text("model"), text("resolved")),
        Some("settle_model") => store.settle_model(session_id),
        other => {
            return Err(RpcError::new(format!(
                "agent_profiles.store: unknown op {}",
                other.unwrap_or("")
            )));
        }
    }
    Ok(())
}

impl CoreFamily for AgentProfilesFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> PeerFuture<Result<Value, RpcError>> {
        let running = self.running();
        let cx = cx.clone();
        Box::pin(async move {
            let running = running.ok_or_else(not_owner)?;
            if call.method == "internal.agent_profiles.store" {
                apply(&running.store, &call.params)?;
                running.notifier.flush().await;
                return Ok(json!({ "ok": true }));
            }
            let empty = Map::new();
            let params = call.params.as_object().unwrap_or(&empty);
            let host =
                ReverseHost::new(&cx, call.ctx.connection_id.clone(), running.logger.clone());
            let context = rpc_context(&cx, running.store.clone());
            let result = handle_profile_rpc(&call.method, params, &host, &context).await;
            // The front's store hears each write before the answer goes out.
            running.notifier.flush().await;
            // As Bun's `<method>-error` reply: the message alone.
            result.map_err(|error| RpcError::new(error.0))
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.take() {
            for task in previous.tasks.iter() {
                task.abort();
            }
        }
        if owned {
            // The file as Bun left it, read with the first call.
            *running = Some(running_store(cx));
        }
    }
}

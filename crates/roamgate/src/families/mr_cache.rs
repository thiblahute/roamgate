//! The mr_cache family in the core: roamgate-forge's MR cache, owner of
//! `<data>/mr-cache/state.json` and of the `forge_cache` pushes.
//!
//! The reads that fill it stay where their processes run: glab and gh on
//! a connection's host, Bun's until the host layer moves (Phase 5), its
//! forge gate with them. So Bun's surfaces (`forge.status`,
//! `forge.session`, the PR card of `git.pull_request`) keep their code and,
//! while Rust owns the family, ask this cache through
//! `internal.mr_cache.get`; when the cache needs a read it asks the asker's
//! reader back with the `mr_cache.load` reverse call, by the token the
//! asker registered (contract/wire/core-channel.md).
//!
//! Hand-over: on taking the family the core first asks Bun to write and
//! drop its own cache (`mr_cache.release`), then reads the file; on giving
//! it back it writes the file at once and never again, and Bun reads it
//! after asking `internal.mr_cache.flush`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_base::settings::Settings;
use roamgate_forge::mr_cache::{
    LoadError, Loaded, MrCache, MrCacheSettings, Persist, SAVE_DELAY, mr_cache_path, reader_options,
};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BoxFuture, IncomingCall};
use roamgate_sidecar::protocol::{Push, RpcError};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::activity::settings_file;

pub const FAMILY: &str = "mr_cache";

/// How long a call waits for the cache to be read after a flip.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// settings.json is read again at most this often.
const SETTINGS_EVERY_MS: i64 = 5_000;

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    let family = MrCacheFamily::default();
    *LATEST.lock().unwrap() = Arc::downgrade(&family.slot);
    Some(Arc::new(family))
}

/// The slot of the family this process made last.
static LATEST: Mutex<std::sync::Weak<Mutex<Slot>>> = Mutex::new(std::sync::Weak::new());

/// The MR cache while the core holds it (it owns the family and the
/// cache is loaded), for the core's other readers of forge answers.
pub fn shared_cache() -> Option<MrCache> {
    let slot = LATEST.lock().unwrap().upgrade()?;
    let ready = slot.lock().unwrap().ready.clone()?;
    ready.borrow().clone()
}

#[derive(Default)]
struct Slot {
    epoch: u64,
    ready: Option<watch::Receiver<Option<MrCache>>>,
}

#[derive(Default)]
struct MrCacheFamily {
    slot: Arc<Mutex<Slot>>,
    /// When settings.json was last read, epoch ms.
    settings_read: Arc<Mutex<i64>>,
}

fn unknown(method: &str) -> RpcError {
    RpcError::with_code(format!("unknown method {method}"), "unknown_method")
}

fn finite(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n as i64)
}

async fn read_settings() -> MrCacheSettings {
    let raw = match tokio::fs::read(settings_file(&ProcessEnv)).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    Settings::normalize(&raw).mr_cache()
}

impl MrCacheFamily {
    async fn cache(&self, cx: &FamilyContext) -> Result<MrCache, RpcError> {
        let ready = self.slot.lock().unwrap().ready.clone();
        let Some(mut ready) = ready else {
            return Err(RpcError::with_code(
                "the MR cache is not served here now",
                "not_owner",
            ));
        };
        let not_ready = || RpcError::with_code("the MR cache is not ready", "not_ready");
        tokio::select! {
            cache = ready.wait_for(Option::is_some) => {
                cache.map(|cache| cache.clone().expect("waited for it")).map_err(|_| not_ready())
            }
            _ = cx.clock.sleep(READY_TIMEOUT) => Err(not_ready()),
        }
    }

    async fn get(&self, cx: &FamilyContext, params: Value) -> Result<Value, RpcError> {
        let cache = self.cache(cx).await?;
        let now = cx.clock.now();
        let due = {
            let mut read = self.settings_read.lock().unwrap();
            let due = now - *read >= SETTINGS_EVERY_MS;
            if due {
                *read = now;
            }
            due
        };
        if due {
            cache.set_settings(read_settings().await);
        }
        let key = params
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::with_code("key missing", "bad_params"))?
            .to_owned();
        let token = params
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let fresh = params.get("fresh") == Some(&Value::Bool(true));
        // `head` given (a string, or null when unknown): the asker's
        // answers are about a checkout's HEAD.
        let head = params
            .get("head")
            .map(|head| head.as_str().map(str::to_owned));
        // The pause the reader gives for the known answer, asked only
        // when that answer is old and could be read again.
        let mut known_paused = 0;
        if !fresh
            && let Some(known) = cache.peek(&key)
            && known.stale
            && let Ok(answer) = cx
                .reverse(
                    "mr_cache.load",
                    json!({"token": token, "op": "paused", "value": known.value.value}),
                )
                .await
        {
            known_paused = finite(answer.get("paused_until")).unwrap_or(0);
        }
        let load = {
            let cx = cx.clone();
            let token = token.clone();
            move || {
                let cx = cx.clone();
                let token = token.clone();
                Box::pin(async move {
                    let answer = cx
                        .reverse("mr_cache.load", json!({"token": token, "op": "load"}))
                        .await
                        .map_err(|error| LoadError {
                            message: error.message,
                            paused_until: None,
                        })?;
                    let paused_until = finite(answer.get("paused_until")).filter(|at| *at > 0);
                    if let Some(error) = answer.get("error") {
                        return Err(LoadError {
                            message: error.as_str().unwrap_or("forge read failed").to_owned(),
                            paused_until,
                        });
                    }
                    Ok(Loaded {
                        value: answer.get("value").cloned().unwrap_or(Value::Null),
                        ttl_ms: finite(answer.get("ttl_ms")).unwrap_or(0),
                        failed: answer.get("failed") == Some(&Value::Bool(true)),
                        paused_until,
                    })
                }) as roamgate_base::clock::BoxFuture<Result<Loaded, LoadError>>
            }
        };
        let options = reader_options(load, fresh, head, known_paused);
        let answer = cache
            .get(&key, &options)
            .await
            .map_err(|error| RpcError::with_code(error.message, "load_failed"))?;
        Ok(json!({
            "value": answer.value.value,
            "fetchedAt": answer.fetched_at,
            "stale": answer.stale,
        }))
    }
}

impl CoreFamily for MrCacheFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = MrCacheFamily {
            slot: self.slot.clone(),
            settings_read: self.settings_read.clone(),
        };
        let cx = cx.clone();
        Box::pin(async move {
            match call.method.as_str() {
                "internal.mr_cache.get" => {
                    // The front's surfaces are answered from this cache:
                    // the parity suite's proof that Rust served them.
                    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, &call.method);
                    this.get(&cx, call.params).await
                }
                "internal.mr_cache.flush" => {
                    let ready = this.slot.lock().unwrap().ready.clone();
                    let cache = ready.and_then(|ready| ready.borrow().clone());
                    if let Some(cache) = cache {
                        cache.flush().await;
                    }
                    Ok(json!({}))
                }
                other => Err(unknown(other)),
            }
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let mut slot = self.slot.lock().unwrap();
        slot.epoch += 1;
        let epoch = slot.epoch;
        if let Some(previous) = slot.ready.take() {
            tokio::spawn(async move {
                let cache = previous.borrow().clone();
                if let Some(cache) = cache {
                    cache.close().await;
                }
            });
        }
        if !owned {
            return;
        }
        let (ready, receiver) = watch::channel(None);
        slot.ready = Some(receiver);
        let cx = cx.clone();
        let slots = self.slot.clone();
        *self.settings_read.lock().unwrap() = 0;
        tokio::spawn(async move {
            // Bun writes and drops its own cache before this one reads the
            // file: one writer, nothing lost across the flip.
            if let Err(error) = cx.reverse("mr_cache.release", json!({})).await {
                tracing::debug!(scope = "mr-cache", error = %error.message, "release not answered");
            }
            let context = DataContext::from_env(&ProcessEnv);
            let path = mr_cache_path(&context.data_root());
            let owners = cx.owners.clone();
            let publisher = cx.clone();
            let cache = MrCache::open(
                cx.clock.clone(),
                Some(Persist {
                    context,
                    path,
                    may_write: Arc::new(move || owners.check_write(FAMILY).is_ok()),
                    delay: SAVE_DELAY,
                }),
                Some(Arc::new(move |message: Value| {
                    publisher.push(Push {
                        message,
                        ..Push::default()
                    })
                })),
            );
            cache.set_settings(read_settings().await);
            if slots.lock().unwrap().epoch == epoch {
                let _ = ready.send(Some(cache));
            } else {
                cache.close().await;
            }
        });
    }
}

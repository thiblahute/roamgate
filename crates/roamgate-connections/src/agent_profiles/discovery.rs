//! server/src/profiles/models.ts: the models a profile's server offers
//! (`GET <ANTHROPIC_BASE_URL>/v1/models`, Anthropic's list, with the
//! profile's token as both Bearer and x-api-key), kept an hour. A profile
//! without a base URL (Claude itself) gets the subscription's aliases.
//! The answer is Bun's `ProfileModels` object: `models`, `source`,
//! `fetched_at`, `missing`, `error?`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use super::shared::{MODEL_SLOTS, is_plain_profile, profile_name};
use super::store::{NowMs, profile_command};
use crate::BoxFuture;
use roamgate_base::settings::js_trim;

/// The aliases a Claude subscription takes; never asked of a server.
pub const CLAUDE_ALIASES: &[&str] = &["opus", "sonnet", "haiku", "opusplan"];

const CACHE_MS: i64 = 60 * 60_000;

/// A server's answer: its status and body.
#[derive(Clone, Debug)]
pub struct FetchResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// A GET with headers and a timeout; the error is what failed, in words.
pub type ModelFetch = Arc<
    dyn Fn(String, Vec<(String, String)>, Duration) -> BoxFuture<Result<FetchResponse, String>>
        + Send
        + Sync,
>;

/// The production fetch: reqwest with rustls.
pub fn http_fetch() -> ModelFetch {
    Arc::new(|url, headers, timeout| {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .map_err(|error| error.to_string())?;
            let mut request = client.get(&url);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(FetchResponse { status, body })
        })
    })
}

/// Embedding and rerank models answer no chat.
fn chat_model(id: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)embed|rerank").unwrap());
    !RE.is_match(id)
}

fn missing_of(profile: &Value, models: &[String]) -> Value {
    if models.is_empty() {
        return json!([]);
    }
    let known: Vec<String> = models.iter().map(|each| each.to_lowercase()).collect();
    let env = profile.get("env").and_then(Value::as_object);
    let missing: Vec<Value> = MODEL_SLOTS
        .iter()
        .filter_map(|(slot, _)| {
            let value = env?.get(*slot)?.as_str()?;
            let trimmed = js_trim(value);
            (!trimmed.is_empty() && !known.contains(&trimmed.to_lowercase()))
                .then(|| json!({"slot": slot, "model": trimmed}))
        })
        .collect();
    Value::Array(missing)
}

#[derive(Clone)]
struct Entry {
    models: Vec<String>,
    fetched_at: i64,
}

pub struct ModelDiscoveryOptions {
    pub fetch: Option<ModelFetch>,
    pub now: Option<NowMs>,
    pub timeout: Option<Duration>,
    /// Where `~` of a secret file leads.
    pub home: PathBuf,
}

/// The discovery with its cache (`createModelDiscovery`).
pub struct ModelDiscovery {
    fetch: ModelFetch,
    now: NowMs,
    timeout: Duration,
    home: PathBuf,
    cache: Mutex<HashMap<String, Entry>>,
}

impl ModelDiscovery {
    pub fn new(options: ModelDiscoveryOptions) -> Self {
        Self {
            fetch: options.fetch.unwrap_or_else(http_fetch),
            now: options.now.unwrap_or_else(|| {
                Arc::new(|| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_millis() as i64)
                        .unwrap_or(0)
                })
            }),
            timeout: options.timeout.unwrap_or(Duration::from_secs(15)),
            home: options.home,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The models of a profile; `refresh` asks its server again.
    pub async fn models(&self, profile: &Value, refresh: bool) -> Value {
        let base = profile
            .get("env")
            .and_then(Value::as_object)
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(Value::as_str)
            .filter(|base| !js_trim(base).is_empty());
        let Some(base) = base.filter(|_| !is_plain_profile(profile)) else {
            return json!({
                "models": CLAUDE_ALIASES,
                "source": "aliases",
                "fetched_at": (self.now)(),
                "missing": [],
            });
        };
        let key = format!("{}\n{base}", profile_name(profile));
        let cached = self
            .cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();
        if let Some(cached) = &cached
            && !refresh
            && (self.now)() - cached.fetched_at < CACHE_MS
        {
            return json!({
                "models": cached.models,
                "source": "server",
                "fetched_at": cached.fetched_at,
                "missing": missing_of(profile, &cached.models),
            });
        }
        match self.list(profile, base).await {
            Ok(models) => {
                let entry = Entry {
                    models,
                    fetched_at: (self.now)(),
                };
                self.cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key, entry.clone());
                json!({
                    "models": entry.models,
                    "source": "server",
                    "fetched_at": entry.fetched_at,
                    "missing": missing_of(profile, &entry.models),
                })
            }
            Err(message) => {
                // The token never reaches the message: only what failed.
                static BEARER: LazyLock<Regex> =
                    LazyLock::new(|| Regex::new(r"Bearer \S+").unwrap());
                let message = BEARER.replace_all(&message, "Bearer ...");
                json!({
                    "models": cached.as_ref().map(|c| c.models.clone()).unwrap_or_default(),
                    "source": "server",
                    "fetched_at": cached.as_ref().map_or_else(|| (self.now)(), |c| c.fetched_at),
                    "missing": cached.as_ref().map_or_else(|| json!([]), |c| missing_of(profile, &c.models)),
                    "error": format!("Could not list the models: {message}"),
                })
            }
        }
    }

    async fn list(&self, profile: &Value, base: &str) -> Result<Vec<String>, String> {
        let env = profile_command(profile, &self.home)?.env;
        let token = env
            .get("ANTHROPIC_AUTH_TOKEN")
            .or_else(|| env.get("ANTHROPIC_API_KEY"))
            .cloned()
            .unwrap_or_default();
        let url = format!(
            "{}/v1/models?limit=1000",
            js_trim(base).trim_end_matches('/')
        );
        let mut headers = Vec::new();
        if !token.is_empty() {
            headers.push(("authorization".to_owned(), format!("Bearer {token}")));
            headers.push(("x-api-key".to_owned(), token));
        }
        headers.push(("anthropic-version".to_owned(), "2023-06-01".to_owned()));
        let response = (self.fetch)(url, headers, self.timeout).await?;
        if !(200..300).contains(&response.status) {
            return Err(format!("the server answered {}", response.status));
        }
        let body: Value = serde_json::from_slice(&response.body)
            .map_err(|error| format!("the server's answer is not JSON: {error}"))?;
        let mut ids: Vec<String> = Vec::new();
        for each in body
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = each.get("id").and_then(Value::as_str)
                && !id.is_empty()
                && chat_model(id)
                && !ids.iter().any(|seen| seen == id)
            {
                ids.push(id.to_owned());
            }
        }
        ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(ids)
    }
}

#[cfg(all(test, unix))]
mod tests;

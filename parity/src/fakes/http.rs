//! The HTTP fakes, one server on 127.0.0.1 per run:
//!
//! - fake-models: `GET`/`HEAD /files/<path>` serves the run's `served/`
//!   directory with Range and If-Range, ETag and Content-Length, as the
//!   model hosts and release mirrors do (also the update mirror).
//! - fake-openai: `POST /v1/chat/completions` (streamed as server-sent
//!   events when asked, else one JSON) and `GET /v1/models`, answering
//!   from the scenario's script, as the Pi providers' OpenAI-compatible
//!   endpoints do.
//! - fake-push: `POST /push/<id>` is a push service: it checks the VAPID
//!   authorization (ES256 JWT, `k` the server's public key), decrypts the
//!   aes128gcm body (RFC 8291) with the subscription's keys, which
//!   `subscribe` made, and keeps the message.
//!
//! Every request is kept for the scenario's assertions.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use anyhow::{Context, Result, anyhow, bail};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use axum::routing::{any, get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::StreamExt;
use hkdf::Hkdf;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::task::JoinHandle;

/// One request any HTTP fake got.
#[derive(Debug, Clone, Serialize)]
pub struct HttpCall {
    pub fake: String,
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
    pub status: u16,
}

/// A subscription of fake-push: what a browser would hand the server.
#[derive(Debug, Clone)]
pub struct PushSubscription {
    pub id: String,
    pub secret: SecretKey,
    pub auth: [u8; 16],
}

impl PushSubscription {
    pub fn public_key(&self) -> Vec<u8> {
        self.secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    /// The browser's PushSubscription JSON for an endpoint base.
    pub fn json(&self, base: &str) -> Value {
        json!({
            "endpoint": format!("{base}/push/{}", self.id),
            "keys": {
                "p256dh": URL_SAFE_NO_PAD.encode(self.public_key()),
                "auth": URL_SAFE_NO_PAD.encode(self.auth),
            }
        })
    }
}

/// A push message fake-push accepted.
#[derive(Debug, Clone, Serialize)]
pub struct PushMessage {
    pub subscription: String,
    pub ttl: Option<String>,
    pub urgency: Option<String>,
    pub topic: Option<String>,
    pub vapid_subject: Option<String>,
    pub vapid_audience: Option<String>,
    pub payload: Value,
}

#[derive(Default)]
struct Shared {
    served: PathBuf,
    openai: Value,
    calls: Vec<HttpCall>,
    subscriptions: BTreeMap<String, PushSubscription>,
    pushes: Vec<PushMessage>,
    /// Statuses fake-push answers instead (410 Gone for an expired one).
    push_status: BTreeMap<String, u16>,
}

type AppState = Arc<Mutex<Shared>>;

pub struct FakeHttp {
    pub base: String,
    shared: AppState,
    task: JoinHandle<()>,
}

fn headers_map(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                value.to_str().unwrap_or("<binary>").to_owned(),
            )
        })
        .collect()
}

fn record(
    state: &AppState,
    fake: &str,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: Value,
    status: u16,
) {
    state.lock().expect("http fake state").calls.push(HttpCall {
        fake: fake.into(),
        method: method.to_string(),
        path: path.into(),
        headers: headers_map(headers),
        body,
        status,
    });
}

fn etag(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = Sha256::digest(bytes);
    format!("\"{}\"", URL_SAFE_NO_PAD.encode(&digest[..12]))
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` against a length.
pub fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (length.saturating_sub(suffix), length.checked_sub(1)?)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            length.checked_sub(1)?
        } else {
            end.parse::<u64>().ok()?.min(length.checked_sub(1)?)
        };
        (start, end)
    };
    (start <= end && start < length).then_some((start, end))
}

async fn files(
    State(state): State<AppState>,
    method: Method,
    UrlPath(path): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let served = state.lock().expect("http fake state").served.clone();
    let clean = !path.split('/').any(|part| part == ".." || part.is_empty());
    let bytes = if clean {
        std::fs::read(served.join(&path)).ok()
    } else {
        None
    };
    let path = format!("/files/{path}");
    let Some(bytes) = bytes else {
        record(&state, "models", &method, &path, &headers, Value::Null, 404);
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .expect("response");
    };
    let tag = etag(&bytes);
    let length = bytes.len() as u64;
    let if_range_ok = headers
        .get(header::IF_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| value == tag);
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|_| if_range_ok);
    let (status, start, end) = match range {
        Some(value) => match parse_range(value, length) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
            None => {
                record(&state, "models", &method, &path, &headers, Value::Null, 416);
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .body(Body::empty())
                    .expect("response");
            }
        },
        None => (StatusCode::OK, 0, length.saturating_sub(1)),
    };
    record(
        &state,
        "models",
        &method,
        &path,
        &headers,
        Value::Null,
        status.as_u16(),
    );
    let slice = if length == 0 {
        Vec::new()
    } else {
        bytes[start as usize..=end as usize].to_vec()
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::ETAG, tag)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, slice.len());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(slice)
    };
    builder.body(body).expect("response")
}

async fn openai_models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let script = state.lock().expect("http fake state").openai.clone();
    record(
        &state,
        "openai",
        &Method::GET,
        "/v1/models",
        &headers,
        Value::Null,
        200,
    );
    let models = script
        .get("models")
        .cloned()
        .unwrap_or_else(|| json!(["parity-model"]));
    let data: Vec<Value> = models
        .as_array()
        .into_iter()
        .flatten()
        .map(|id| json!({"id": id, "object": "model", "owned_by": "parity"}))
        .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"object": "list", "data": data}).to_string(),
        ))
        .expect("response")
}

/// Fills `{{n}}` (the request's number, from 1) in a reply's strings.
fn number_reply(value: &Value, n: usize) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("{{n}}", &n.to_string())),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| number_reply(item, n)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), number_reply(item, n)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The Anthropic Messages events of a scripted reply: `text`, `tools`
/// ([{name, id, input}]), or `partial` (a text that never ends: with
/// `hang`, the stream stays open, as a model cut off mid-answer).
fn anthropic_events(reply: &Value, n: usize) -> Vec<Value> {
    let mut events = vec![json!({
        "type": "message_start",
        "message": {"id": format!("parity-message-{n}"), "type": "message", "role": "assistant",
                    "model": "parity-model", "content": [], "stop_reason": null, "stop_sequence": null,
                    "usage": {"input_tokens": 10, "output_tokens": 0}}
    })];
    let mut index = 0;
    let text = reply
        .get("text")
        .or_else(|| reply.get("partial"))
        .and_then(Value::as_str);
    if let Some(text) = text {
        events.push(json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}));
        events.push(json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}}));
        if reply.get("partial").is_some() {
            return events;
        }
        events.push(json!({"type": "content_block_stop", "index": index}));
        index += 1;
    }
    let tools = reply
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for tool in &tools {
        events.push(json!({"type": "content_block_start", "index": index,
            "content_block": {"type": "tool_use", "id": tool["id"], "name": tool["name"], "input": {}}}));
        events.push(json!({"type": "content_block_delta", "index": index,
            "delta": {"type": "input_json_delta", "partial_json": tool.get("input").cloned().unwrap_or(json!({})).to_string()}}));
        events.push(json!({"type": "content_block_stop", "index": index}));
        index += 1;
    }
    let reason = if tools.is_empty() {
        "end_turn"
    } else {
        "tool_use"
    };
    events.push(json!({"type": "message_delta", "delta": {"stop_reason": reason, "stop_sequence": null}, "usage": {"output_tokens": 10}}));
    events.push(json!({"type": "message_stop"}));
    events
}

/// fake-anthropic: `POST /v1/messages`, streamed, from the script's
/// `anthropic`: request n gets `replies[n-1]`, then `cycle` in turn.
async fn anthropic_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    record(
        &state,
        "anthropic",
        &Method::POST,
        "/v1/messages",
        &headers,
        request,
        200,
    );
    let (script, n) = {
        let shared = state.lock().expect("http fake state");
        let n = shared
            .calls
            .iter()
            .filter(|call| call.fake == "anthropic")
            .count();
        (
            shared
                .openai
                .get("anthropic")
                .cloned()
                .unwrap_or(Value::Null),
            n,
        )
    };
    let replies = script
        .get("replies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cycle = script
        .get("cycle")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reply = replies
        .get(n - 1)
        .cloned()
        .or_else(|| {
            (!cycle.is_empty()).then(|| cycle[(n - 1 - replies.len()) % cycle.len()].clone())
        })
        .unwrap_or_else(|| json!({"text": "ok"}));
    let reply = number_reply(&reply, n);
    let text: String = anthropic_events(&reply, n)
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap_or("")
            )
        })
        .collect();
    let builder = Response::builder().header(header::CONTENT_TYPE, "text/event-stream");
    if reply.get("hang").and_then(Value::as_bool).unwrap_or(false) {
        let stream =
            futures_util::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(text)) })
                .chain(futures_util::stream::pending());
        return builder.body(Body::from_stream(stream)).expect("response");
    }
    builder.body(Body::from(text)).expect("response")
}

async fn openai_chat(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let script = state.lock().expect("http fake state").openai.clone();
    record(
        &state,
        "openai",
        &Method::POST,
        "/v1/chat/completions",
        &headers,
        request.clone(),
        200,
    );
    let model = request
        .get("model")
        .cloned()
        .unwrap_or(json!("parity-model"));
    // The script's `replies` are answered in turn; the last one repeats.
    let count = state
        .lock()
        .expect("http fake state")
        .calls
        .iter()
        .filter(|call| call.path == "/v1/chat/completions")
        .count();
    let replies = script
        .get("replies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reply = replies
        .get(count.saturating_sub(1))
        .or_else(|| replies.last())
        .cloned()
        .unwrap_or_else(|| json!({"content": ["ok"]}));
    let parts: Vec<String> = match reply.get("content") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::String(text)) => vec![text.clone()],
        _ => Vec::new(),
    };
    if request.get("stream").and_then(Value::as_bool) == Some(true) {
        let mut text = String::new();
        for part in &parts {
            let chunk = json!({
                "id": "chatcmpl-parity", "object": "chat.completion.chunk", "model": model,
                "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": null}]
            });
            text.push_str(&format!("data: {chunk}\n\n"));
        }
        let last = json!({
            "id": "chatcmpl-parity", "object": "chat.completion.chunk", "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": parts.len(), "total_tokens": 1 + parts.len()}
        });
        text.push_str(&format!("data: {last}\n\ndata: [DONE]\n\n"));
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(text))
            .expect("response");
    }
    let answer = json!({
        "id": "chatcmpl-parity", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": parts.concat()}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": parts.len(), "total_tokens": 1 + parts.len()}
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(answer.to_string()))
        .expect("response")
}

/// Checks a VAPID `Authorization: vapid t=<jwt>, k=<key>` header; gives
/// the JWT's claims.
pub fn verify_vapid(authorization: &str) -> Result<Value> {
    let rest = authorization
        .strip_prefix("vapid ")
        .ok_or_else(|| anyhow!("not a vapid authorization"))?;
    let mut token = None;
    let mut key = None;
    for part in rest.split(',') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("t=") {
            token = Some(value);
        } else if let Some(value) = part.strip_prefix("k=") {
            key = Some(value);
        }
    }
    let (token, key) = (token.context("no t=")?, key.context("no k=")?);
    let key = VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(key)?)?;
    let (signed, signature) = token.rsplit_once('.').context("a JWT")?;
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature)?)?;
    key.verify(signed.as_bytes(), &signature)
        .map_err(|_| anyhow!("bad VAPID signature"))?;
    let (header, claims) = signed.split_once('.').context("a JWT")?;
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header)?)?;
    if header.get("alg").and_then(Value::as_str) != Some("ES256") {
        bail!("VAPID alg is not ES256");
    }
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims)?)?)
}

fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .expect("valid length");
    out
}

/// Decrypts an aes128gcm Web Push body (RFC 8291, one record).
pub fn decrypt(subscription: &PushSubscription, body: &[u8]) -> Result<Vec<u8>> {
    if body.len() < 21 {
        bail!("body too short");
    }
    let salt = &body[..16];
    let id_length = body[20] as usize;
    let sender = &body[21..21 + id_length];
    let ciphertext = &body[21 + id_length..];
    let sender_key = PublicKey::from_sec1_bytes(sender)?;
    let shared = p256::ecdh::diffie_hellman(
        subscription.secret.to_nonzero_scalar(),
        sender_key.as_affine(),
    );
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&subscription.public_key());
    key_info.extend_from_slice(sender);
    let ikm = hkdf(&subscription.auth, shared.raw_secret_bytes(), &key_info, 32);
    let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12);
    let cipher = Aes128Gcm::new_from_slice(&cek)?;
    let mut plain = cipher
        .decrypt(
            &Nonce::from(<[u8; 12]>::try_from(nonce.as_slice())?),
            ciphertext,
        )
        .map_err(|_| anyhow!("aes128gcm decryption failed"))?;
    while plain.last() == Some(&0) {
        plain.pop();
    }
    if plain.pop() != Some(2) {
        bail!("no last-record delimiter");
    }
    Ok(plain)
}

/// Encrypts a Web Push body (RFC 8291) as a push sender does; for tests.
pub fn encrypt(
    receiver: &[u8],
    auth: &[u8],
    sender: &SecretKey,
    salt: [u8; 16],
    plain: &[u8],
) -> Result<Vec<u8>> {
    let receiver_key = PublicKey::from_sec1_bytes(receiver)?;
    let sender_public = sender
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), receiver_key.as_affine());
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(receiver);
    key_info.extend_from_slice(&sender_public);
    let ikm = hkdf(auth, shared.raw_secret_bytes(), &key_info, 32);
    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12);
    let mut record = plain.to_vec();
    record.push(2);
    let ciphertext = Aes128Gcm::new_from_slice(&cek)?
        .encrypt(
            &Nonce::from(<[u8; 12]>::try_from(nonce.as_slice())?),
            record.as_slice(),
        )
        .map_err(|_| anyhow!("encryption failed"))?;
    let mut body = salt.to_vec();
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(sender_public.len() as u8);
    body.extend_from_slice(&sender_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

async fn push(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = format!("/push/{id}");
    let (subscription, forced) = {
        let shared = state.lock().expect("http fake state");
        (
            shared.subscriptions.get(&id).cloned(),
            shared.push_status.get(&id).copied(),
        )
    };
    let header_text = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let outcome = (|| -> Result<PushMessage> {
        let subscription = subscription.context("unknown subscription")?;
        if header_text("content-encoding").as_deref() != Some("aes128gcm") {
            bail!("Content-Encoding is not aes128gcm");
        }
        let claims = verify_vapid(&header_text("authorization").context("no Authorization")?)?;
        let plain = decrypt(&subscription, &body)?;
        Ok(PushMessage {
            subscription: id.clone(),
            ttl: header_text("ttl"),
            urgency: header_text("urgency"),
            topic: header_text("topic"),
            vapid_subject: claims.get("sub").and_then(Value::as_str).map(str::to_owned),
            vapid_audience: claims.get("aud").and_then(Value::as_str).map(str::to_owned),
            payload: serde_json::from_slice(&plain)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&plain).into_owned())),
        })
    })();
    let (status, recorded) = match (forced, outcome) {
        (Some(status), _) => (status, json!({"forced": status})),
        (None, Ok(message)) => {
            let value = serde_json::to_value(&message).expect("serialises");
            state.lock().expect("http fake state").pushes.push(message);
            (201, value)
        }
        (None, Err(error)) => (400, json!({"error": error.to_string()})),
    };
    record(
        &state,
        "push",
        &Method::POST,
        &path,
        &headers,
        recorded,
        status,
    );
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST))
        .body(Body::empty())
        .expect("response")
}

async fn not_found(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    record(
        &state,
        "http",
        &method,
        uri.path(),
        &headers,
        Value::Null,
        404,
    );
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .expect("response")
}

impl FakeHttp {
    pub async fn start(served: PathBuf, openai: Value) -> Result<FakeHttp> {
        std::fs::create_dir_all(&served)?;
        let shared: AppState = Arc::new(Mutex::new(Shared {
            served,
            openai,
            ..Shared::default()
        }));
        let app = Router::new()
            .route("/files/{*path}", get(files).head(files))
            .route("/v1/models", get(openai_models))
            .route("/v1/chat/completions", post(openai_chat))
            .route("/v1/messages", post(anthropic_messages))
            .route("/push/{id}", post(push))
            .fallback(any(not_found))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(FakeHttp { base, shared, task })
    }

    /// A new push subscription, with fresh keys.
    pub fn subscribe(&self, id: &str) -> PushSubscription {
        let mut seed = [0u8; 32];
        use sha2::Digest;
        let digest = Sha256::digest(format!("parity-push-{id}").as_bytes());
        seed.copy_from_slice(&digest);
        let secret = SecretKey::from_slice(&seed).expect("a valid scalar");
        let mut auth = [0u8; 16];
        auth.copy_from_slice(&Sha256::digest(format!("parity-auth-{id}").as_bytes())[..16]);
        let subscription = PushSubscription {
            id: id.into(),
            secret,
            auth,
        };
        self.shared
            .lock()
            .expect("http fake state")
            .subscriptions
            .insert(id.into(), subscription.clone());
        subscription
    }

    pub fn set_push_status(&self, id: &str, status: u16) {
        self.shared
            .lock()
            .expect("http fake state")
            .push_status
            .insert(id.into(), status);
    }

    pub fn set_openai(&self, script: Value) {
        self.shared.lock().expect("http fake state").openai = script;
    }

    pub fn calls(&self) -> Vec<HttpCall> {
        self.shared.lock().expect("http fake state").calls.clone()
    }

    pub fn pushes(&self) -> Vec<PushMessage> {
        self.shared.lock().expect("http fake state").pushes.clone()
    }
}

impl Drop for FakeHttp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

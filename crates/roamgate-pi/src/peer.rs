//! One side of the wire: requests both ways with their replies,
//! notifications, and `$/cancel`, which cancels a request of the other
//! side. The server's side of server/src/assistant/pi-sidecar-peer.ts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::protocol::{
    ERROR_CODE, INVALID_REQUEST, Id, METHOD_NOT_FOUND, Message, WireError, encode_message,
    parse_line,
};
use crate::{BoxFuture, PiError};

/// What the other side's requests and notifications reach.
pub trait PeerHandlers: Send + Sync + 'static {
    /// A request; `cancel` fires on its `$/cancel` or when the peer closes.
    fn request(
        &self,
        method: String,
        params: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>>;
    fn notification(&self, method: &str, params: Value);
}

type Reply = oneshot::Sender<Result<Value, PiError>>;

struct Inner {
    next: AtomicI64,
    pending: Mutex<HashMap<Id, Reply>>,
    incoming: Mutex<HashMap<Id, CancellationToken>>,
    closed: Mutex<Option<PiError>>,
    out: mpsc::UnboundedSender<String>,
    handlers: Arc<dyn PeerHandlers>,
}

#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
}

impl Peer {
    /// A peer writing its lines (with their newline) to `out`.
    pub fn new(out: mpsc::UnboundedSender<String>, handlers: Arc<dyn PeerHandlers>) -> Self {
        Self {
            inner: Arc::new(Inner {
                next: AtomicI64::new(1),
                pending: Mutex::default(),
                incoming: Mutex::default(),
                closed: Mutex::default(),
                out,
                handlers,
            }),
        }
    }

    /// Requests in flight both ways.
    pub fn busy(&self) -> usize {
        self.inner.pending.lock().expect("pending").len()
            + self.inner.incoming.lock().expect("incoming").len()
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.lock().expect("closed").is_some()
    }

    /// The id the next request will have: what its reverse requests and
    /// notifications carry, known before it is sent.
    pub fn reserve(&self) -> Id {
        Id::Num(self.inner.next.fetch_add(1, Ordering::Relaxed))
    }

    /// Sends request `id` (from [`Peer::reserve`]) and waits for its reply.
    /// `cancel` sends `$/cancel` and goes on waiting: the other side
    /// answers a cancelled request too.
    pub async fn request_with(
        &self,
        id: Id,
        method: &str,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> Result<Value, PiError> {
        let (sender, mut receiver) = oneshot::channel();
        {
            let closed = self.inner.closed.lock().expect("closed");
            if let Some(error) = closed.as_ref() {
                return Err(error.clone());
            }
            if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Err(PiError::Cancelled);
            }
            self.inner
                .pending
                .lock()
                .expect("pending")
                .insert(id.clone(), sender);
        }
        self.send(&Message::Request {
            id: id.clone(),
            method: method.to_owned(),
            params,
        });
        if let Some(cancel) = cancel {
            tokio::select! {
                reply = &mut receiver => return reply.unwrap_or(Err(PiError::closed())),
                () = cancel.cancelled() => self.notify("$/cancel", json!({ "id": id.to_value() })),
            }
        }
        receiver.await.unwrap_or(Err(PiError::closed()))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, PiError> {
        let id = self.reserve();
        self.request_with(id, method, params, None).await
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(&Message::Notification {
            method: method.to_owned(),
            params,
        });
    }

    /// One line the other side wrote.
    pub fn receive(&self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Some(message) = parse_line(line) else {
            let head: String = line.chars().take(200).collect();
            tracing::warn!(target: "assistant", "Pi sidecar: not a message: {head}");
            return;
        };
        match message {
            Message::Result { id, result } => self.settle(Some(id), Ok(result)),
            Message::Error { id, error } => self.settle(id, Err(PiError::from_wire(error))),
            Message::Notification { method, params } => {
                if method == "$/cancel" {
                    if let Some(id) = params.get("id").and_then(|id| match id {
                        Value::Number(number) => number.as_i64().map(Id::Num),
                        Value::String(text) => Some(Id::Str(text.clone())),
                        _ => None,
                    }) && let Some(token) =
                        self.inner.incoming.lock().expect("incoming").get(&id)
                    {
                        token.cancel();
                    }
                    return;
                }
                self.inner.handlers.notification(&method, params);
            }
            Message::Request { id, method, params } => self.serve(id, method, params),
        }
    }

    fn settle(&self, id: Option<Id>, reply: Result<Value, PiError>) {
        let sender = id
            .as_ref()
            .and_then(|id| self.inner.pending.lock().expect("pending").remove(id));
        match sender {
            Some(sender) => {
                let _ = sender.send(reply);
            }
            None => {
                let id = id.map_or_else(|| "null".to_owned(), |id| id.to_string());
                tracing::warn!(target: "assistant", "Pi sidecar: a reply to no request: {id}");
            }
        }
    }

    fn serve(&self, id: Id, method: String, params: Value) {
        let token = CancellationToken::new();
        {
            let mut incoming = self.inner.incoming.lock().expect("incoming");
            if incoming.contains_key(&id) {
                drop(incoming);
                self.send(&Message::Error {
                    id: Some(id),
                    error: WireError {
                        code: INVALID_REQUEST,
                        message: "Duplicate request id".into(),
                        user: None,
                    },
                });
                return;
            }
            incoming.insert(id.clone(), token.clone());
        }
        let future = self.inner.handlers.request(method, params, token);
        let peer = self.clone();
        tokio::spawn(async move {
            let reply = future.await;
            peer.inner.incoming.lock().expect("incoming").remove(&id);
            peer.send(&match reply {
                Ok(result) => Message::Result { id, result },
                Err(error) => Message::Error {
                    id: Some(id),
                    error: error.to_wire(),
                },
            });
        });
    }

    /// The other side is gone: everything in flight fails with `error`.
    pub fn close(&self, error: PiError) {
        {
            let mut closed = self.inner.closed.lock().expect("closed");
            if closed.is_some() {
                return;
            }
            *closed = Some(error.clone());
        }
        let pending: Vec<Reply> = self
            .inner
            .pending
            .lock()
            .expect("pending")
            .drain()
            .map(|(_, sender)| sender)
            .collect();
        for sender in pending {
            let _ = sender.send(Err(error.clone()));
        }
        for token in self.inner.incoming.lock().expect("incoming").values() {
            token.cancel();
        }
    }

    fn send(&self, message: &Message) {
        if self.is_closed() {
            return;
        }
        let _ = self
            .inner
            .out
            .send(format!("{}\n", encode_message(message)));
    }
}

impl PiError {
    pub(crate) fn to_wire(&self) -> WireError {
        match self {
            Self::MethodNotFound(message) => WireError {
                code: METHOD_NOT_FOUND,
                message: message.clone(),
                user: None,
            },
            Self::User(message) => WireError {
                code: ERROR_CODE,
                message: message.clone(),
                user: Some(true),
            },
            other => WireError {
                code: ERROR_CODE,
                message: other.to_string(),
                user: None,
            },
        }
    }

    pub(crate) fn from_wire(error: WireError) -> Self {
        if error.user == Some(true) {
            Self::User(error.message)
        } else {
            Self::Failed(error.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use tracing_subscriber::layer::{Context, SubscriberExt};

    use super::{Peer, PeerHandlers};
    use crate::protocol::Id;
    use crate::{BoxFuture, PiError};

    struct Nothing;

    impl PeerHandlers for Nothing {
        fn request(
            &self,
            method: String,
            _params: Value,
            _cancel: CancellationToken,
        ) -> BoxFuture<Result<Value, PiError>> {
            Box::pin(
                async move { Err(PiError::MethodNotFound(format!("Unknown method {method}"))) },
            )
        }

        fn notification(&self, _method: &str, _params: Value) {}
    }

    /// The messages of the events logged while it is the default.
    #[derive(Clone, Default)]
    struct Logged(Arc<Mutex<Vec<String>>>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Logged {
        fn on_event(&self, event: &tracing::Event<'_>, _cx: Context<'_, S>) {
            struct Message<'a>(&'a mut String);
            impl tracing::field::Visit for Message<'_> {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() == "message" {
                        *self.0 = format!("{value:?}");
                    }
                }
            }
            let mut text = String::new();
            event.record(&mut Message(&mut text));
            self.0.lock().unwrap().push(text);
        }
    }

    #[tokio::test]
    async fn output_that_is_not_a_message_is_logged_and_skipped() {
        let logged = Logged::default();
        let _guard =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(logged.clone()));
        let (out, mut written) = mpsc::unbounded_channel();
        let peer = Peer::new(out, Arc::new(Nothing));
        peer.receive("Deprecation (warning): something");
        peer.receive("");
        peer.receive(r#"{"jsonrpc":"2.0","id":99,"result":1}"#);
        assert_eq!(
            *logged.0.lock().unwrap(),
            [
                "Pi sidecar: not a message: Deprecation (warning): something",
                "Pi sidecar: a reply to no request: 99",
            ]
        );
        assert!(written.try_recv().is_err());
        // A real reply still reaches its request.
        let id = peer.reserve();
        let waiting = tokio::spawn({
            let peer = peer.clone();
            let id = id.clone();
            async move { peer.request_with(id, "catalog", json!({}), None).await }
        });
        let line = written.recv().await.unwrap();
        assert_eq!(
            line,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"catalog\",\"params\":{}}\n"
        );
        assert_eq!(id, Id::Num(1));
        peer.receive(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#);
        assert_eq!(waiting.await.unwrap(), Ok(json!({ "ok": true })));
    }

    #[tokio::test]
    async fn an_unknown_method_is_refused_and_a_closed_peer_fails_what_is_in_flight() {
        let (out, mut written) = mpsc::unbounded_channel();
        let peer = Peer::new(out, Arc::new(Nothing));
        peer.receive(r#"{"jsonrpc":"2.0","id":"r1","method":"nope","params":{}}"#);
        assert_eq!(
            written.recv().await.unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"r1\",\"error\":{\"code\":-32601,\"message\":\"Unknown method nope\"}}\n"
        );
        // A closed peer fails what is in flight and sends nothing more.
        let id = peer.reserve();
        let waiting = tokio::spawn({
            let peer = peer.clone();
            async move { peer.request_with(id, "run", json!({}), None).await }
        });
        written.recv().await.unwrap();
        peer.close(PiError::Closed("The Pi sidecar exited (1)".into()));
        assert_eq!(
            waiting.await.unwrap(),
            Err(PiError::Closed("The Pi sidecar exited (1)".into()))
        );
        assert_eq!(
            peer.request("catalog", json!({})).await,
            Err(PiError::Closed("The Pi sidecar exited (1)".into()))
        );
        assert!(written.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_cancelled_request_sends_its_cancel_and_waits_for_the_answer() {
        let (out, mut written) = mpsc::unbounded_channel();
        let peer = Peer::new(out, Arc::new(Nothing));
        let cancel = CancellationToken::new();
        let id = peer.reserve();
        let waiting = tokio::spawn({
            let peer = peer.clone();
            let cancel = cancel.clone();
            async move { peer.request_with(id, "run", json!({}), Some(cancel)).await }
        });
        written.recv().await.unwrap();
        cancel.cancel();
        assert_eq!(
            written.recv().await.unwrap(),
            "{\"jsonrpc\":\"2.0\",\"method\":\"$/cancel\",\"params\":{\"id\":1}}\n"
        );
        peer.receive(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Ranger stopped"}}"#,
        );
        assert_eq!(
            waiting.await.unwrap(),
            Err(PiError::Failed("Ranger stopped".into()))
        );
    }
}

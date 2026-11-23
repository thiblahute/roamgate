//! The Rust front's router against a fake core on a real channel.

use std::sync::Mutex as StdMutex;

use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpResponse, PeerOptions};
use roamgate_sidecar::protocol::RpcError;
use serde_json::json;

use super::*;
use crate::auth::AuthConfig;
use crate::test_support::{ManualClock, NOW, shared};

const SECRET: &str = "test-login-secret";

/// A core that echoes HTTP requests and accepts `/ws` sockets, saying
/// hello on each and echoing their messages.
#[derive(Default)]
struct FakeCore {
    seen: StdMutex<Vec<Message>>,
}

impl Handler for FakeCore {
    fn http(
        &self,
        _peer: &Peer,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        Box::pin(async move {
            let body = match body {
                Some(body) => String::from_utf8(body.read_all().await).unwrap(),
                None => String::new(),
            };
            let echo = json!({
                "method": request.method,
                "url": request.url,
                "cookie": request.headers.iter().any(|(name, _)| name == "cookie"),
                "client_ip": request.ctx.client_ip,
                "session": request.ctx.session_id.is_some(),
                "body": body,
            });
            let mut response = HttpResponse::status(207);
            response.headers = vec![("x-core".into(), "bun".into())];
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tx.send(echo.to_string().into_bytes()).await.unwrap();
            response.body = Some(rx);
            Ok(response)
        })
    }

    fn ws_open(&self, peer: &Peer, open: WsOpen) -> BoxFuture<Result<Value, RpcError>> {
        let peer = peer.clone();
        Box::pin(async move {
            if !open.url.starts_with("/ws") {
                return Ok(
                    json!({"accepted": false, "status": 403, "headers": [["x-core", "bun"]], "body": "forbidden"}),
                );
            }
            // Sent before the handshake is done: held by the front.
            peer.send(&Message::WsSend {
                socket_id: open.socket_id,
                data: "hello".into(),
                binary: false,
                context: Some("message".into()),
                key: None,
            });
            Ok(json!({"accepted": true, "transport": "ws"}))
        })
    }

    fn socket(&self, peer: &Peer, message: Message) {
        if let Message::WsMessage {
            socket_id, data, ..
        } = &message
        {
            peer.send(&Message::WsSend {
                socket_id: *socket_id,
                data: format!("echo {data}"),
                binary: false,
                context: None,
                key: None,
            });
        }
        self.seen.lock().unwrap().push(message);
    }
}

struct Setup {
    front: Arc<Front>,
    core: Arc<FakeCore>,
    _link: watch::Sender<Option<Peer>>,
    _public: tempfile::TempDir,
}

async fn setup(with_core: bool) -> Setup {
    let clock = ManualClock::at(NOW);
    let auth = Auth::new(AuthConfig::new(SECRET, &"a".repeat(64)), shared(&clock)).unwrap();
    let public = tempfile::tempdir().unwrap();
    std::fs::write(public.path().join("index.html"), "<title>Roamgate</title>").unwrap();
    std::fs::write(public.path().join("app.js"), "export {};").unwrap();
    let (link, rx) = watch::channel(None);
    let sockets = Sockets::default();
    let core = Arc::new(FakeCore::default());
    if with_core {
        let (front_end, core_end) = tokio::io::duplex(1 << 20);
        let front_peer = Peer::start(
            Box::new(front_end),
            Arc::new(FrontHandler {
                sockets: sockets.clone(),
            }),
            PeerOptions::core(shared(&clock)),
        );
        let _core_peer = Peer::start(
            Box::new(core_end),
            core.clone(),
            PeerOptions::core(shared(&clock)),
        );
        std::mem::forget(_core_peer);
        link.send(Some(front_peer)).unwrap();
    }
    let front = Arc::new(Front::new(
        auth,
        static_dirs(public.path().to_owned(), None),
        Box::new(String::new),
        rx,
        sockets,
    ));
    Setup {
        front,
        core,
        _link: link,
        _public: public,
    }
}

fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> http::Request<Body> {
    let mut builder = http::Request::builder()
        .method(method)
        .uri(path)
        .header("host", "example.test");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_owned())).unwrap()
}

async fn text(response: http::Response<Body>) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

async fn login(front: &Arc<Front>) -> String {
    let response = front
        .handle(
            request(
                "POST",
                "/api/login",
                &[],
                &json!({"password": SECRET}).to_string(),
            ),
            "127.0.0.1".into(),
        )
        .await;
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    cookie.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn health_login_and_the_gate_are_the_front_s() {
    let setup = setup(false).await;
    let front = &setup.front;
    let health = front
        .handle(request("GET", "/healthz", &[], ""), "127.0.0.1".into())
        .await;
    assert_eq!(health.status(), 200);
    assert_eq!(text(health).await, "Ok");
    let page = front
        .handle(request("GET", "/login", &[], ""), "127.0.0.1".into())
        .await;
    assert!(text(page).await.contains("<title>Roamgate login</title>"));
    let api = front
        .handle(request("GET", "/api/anything", &[], ""), "127.0.0.1".into())
        .await;
    assert_eq!(api.status(), 401);
    let html = front
        .handle(
            request("GET", "/workspace", &[("accept", "text/html")], ""),
            "127.0.0.1".into(),
        )
        .await;
    assert_eq!(html.status(), 302);
    assert_eq!(html.headers()["location"], "/login");
    let cookie = login(front).await;
    // No core yet: the routes it serves wait for it.
    let waiting = front
        .handle(
            request("GET", "/api/anything", &[("cookie", &cookie)], ""),
            "127.0.0.1".into(),
        )
        .await;
    assert_eq!(waiting.status(), 503);
}

#[tokio::test]
async fn serves_the_web_app_itself_and_forwards_the_rest_to_the_core() {
    let setup = setup(true).await;
    let front = &setup.front;
    let cookie = login(front).await;
    let app = front
        .handle(
            request("GET", "/app.js", &[("cookie", &cookie)], ""),
            "127.0.0.1".into(),
        )
        .await;
    assert_eq!(app.status(), 200);
    assert_eq!(text(app).await, "export {};");
    let spa = front
        .handle(
            request(
                "GET",
                "/workspace/x",
                &[("cookie", &cookie), ("accept", "text/html")],
                "",
            ),
            "127.0.0.1".into(),
        )
        .await;
    assert!(text(spa).await.contains("<title>Roamgate</title>"));

    let forwarded = front
        .handle(
            request("POST", "/api/thing?a=1", &[("cookie", &cookie)], "payload"),
            "192.0.2.7".into(),
        )
        .await;
    assert_eq!(forwarded.status(), 207);
    assert_eq!(forwarded.headers()["x-core"], "bun");
    let echo: Value = serde_json::from_str(&text(forwarded).await).unwrap();
    assert_eq!(
        echo,
        json!({"method": "POST", "url": "/api/thing?a=1", "cookie": true, "client_ip": "192.0.2.7", "session": true, "body": "payload"})
    );
}

#[tokio::test]
async fn rendered_pages_and_cross_site_frames_go_to_the_core_before_the_gate() {
    let setup = setup(true).await;
    for (path, headers) in [
        ("/rendered/token/index.html", vec![]),
        ("/app.js", vec![("sec-fetch-site", "cross-site")]),
        ("/api/voice/call/handoff", vec![]),
    ] {
        let response = setup
            .front
            .handle(request("GET", path, &headers, ""), "127.0.0.1".into())
            .await;
        assert_eq!(response.status(), 207, "{path}");
    }
}

#[tokio::test]
async fn browser_sockets_are_terminated_here_and_driven_by_the_core() {
    let setup = setup(true).await;
    let cookie = login(&setup.front).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = app(setup.front.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let refused = {
        let cookie = cookie.clone();
        tokio::task::spawn_blocking(move || {
            let mut request = tungstenite::client::IntoClientRequest::into_client_request(format!(
                "ws://{address}/api/voice/ws"
            ))
            .unwrap();
            request
                .headers_mut()
                .insert("cookie", cookie.parse().unwrap());
            let stream = std::net::TcpStream::connect(address).unwrap();
            match tungstenite::client::client(request, stream) {
                Err(tungstenite::handshake::HandshakeError::Failure(tungstenite::Error::Http(
                    response,
                ))) => response.status().as_u16(),
                _ => 0,
            }
        })
        .await
        .unwrap()
    };
    assert_eq!(refused, 403);

    let (greeting, echo) = tokio::task::spawn_blocking(move || {
        let mut request = tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://{address}/ws"
        ))
        .unwrap();
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        let stream = std::net::TcpStream::connect(address).unwrap();
        let (mut socket, _) = tungstenite::client::client(request, stream).unwrap();
        let greeting = socket.read().unwrap().into_text().unwrap().to_string();
        socket.send(tungstenite::Message::text("ping")).unwrap();
        let echo = socket.read().unwrap().into_text().unwrap().to_string();
        socket
            .close(Some(tungstenite::protocol::CloseFrame {
                code: 1000.into(),
                reason: "bye".into(),
            }))
            .unwrap();
        while socket.read().is_ok() {}
        (greeting, echo)
    })
    .await
    .unwrap();
    assert_eq!(greeting, "hello");
    assert_eq!(echo, "echo ping");
    for _ in 0..200 {
        if setup
            .core
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|message| matches!(message, Message::WsClose { .. }))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let seen = setup.core.seen.lock().unwrap().clone();
    assert!(matches!(&seen[0], Message::WsMessage { data, .. } if data == "ping"));
    assert!(matches!(
        &seen[1],
        Message::WsClose {
            code: Some(1000),
            ..
        }
    ));
}

//! The S10 spike server: the Rust `/ws` transport (and, with the `yawc`
//! feature, the yawc one at `/ws-yawc`) behind a test page that a browser
//! runs on its own. The page checks every message the server sends, sends
//! compressible messages back, and posts a report the server prints as a
//! `REPORT` line and serves at `/reports`.
//!
//! `ws-spike [--listen 127.0.0.1:0] [--level 6]`, or `ws-spike --dump-plan FILE`
//! to write the run for `spike/bun-server.ts`.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use roamgate_ws::flow::utf16_len;
use roamgate_ws::{Config, Event, SocketHandle, upgrade};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const PAGE: &str = include_str!("../../spike/index.html");

#[derive(Clone)]
struct App {
    reports: Arc<Mutex<Vec<Value>>>,
    level: u32,
}

/// FNV-1a over UTF-16 code units, as the page computes it.
fn hash(text: &str) -> u32 {
    text.encode_utf16().fold(0x811c_9dc5u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
    })
}

/// A deterministic generator, so a run is the same in every browser.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

/// A terminal repaint: cursor moves, colours and text, mostly ASCII.
fn terminal_text(rng: &mut Rng, bytes: usize) -> String {
    let words = [
        "cargo",
        "build",
        "warning:",
        "unused",
        "variable",
        "error[E0308]:",
        "mismatched",
        "types",
        "-->",
        "src/main.rs",
        "|",
        "^^^^",
        "é",
        "日本語",
        "😀",
        "✓",
    ];
    let mut text = String::new();
    let mut row = 1;
    while text.len() < bytes {
        text.push_str(&format!("\u{1b}[{row};1H\u{1b}[3{}m", rng.below(8)));
        for _ in 0..rng.below(12) + 3 {
            text.push_str(words[rng.below(words.len() as u64) as usize]);
            text.push(' ');
        }
        text.push_str("\u{1b}[0m\r\n");
        row = row % 50 + 1;
    }
    text
}

struct Planned {
    seq: usize,
    context: &'static str,
    key: Option<String>,
    payload: String,
    /// One of a burst sharing a coalesce key: only the last must arrive.
    burst: bool,
}

fn add(planned: &mut Vec<Planned>, context: &'static str, key: Option<String>, data: String) {
    let seq = planned.len();
    let payload = json!({ "seq": seq, "ctx": context, "data": data }).to_string();
    planned.push(Planned {
        seq,
        context,
        key,
        payload,
        burst: false,
    });
}

/// What a run sends, in order.
fn plan() -> Vec<Planned> {
    let mut rng = Rng(0x5eed_1234_abcd_0001);
    let mut planned = Vec::new();
    for n in 0..40 {
        let size = 2_000 + rng.below(10_000) as usize;
        let text = terminal_text(&mut rng, size);
        add(
            &mut planned,
            "terminal-frame",
            Some(format!("terminal:t{n}")),
            text,
        );
        if n % 10 == 9 {
            add(&mut planned, "bridge-ping", None, "pong".into());
        }
    }
    for _ in 0..20 {
        let size = 100 + rng.below(800) as usize;
        let text = terminal_text(&mut rng, size);
        add(&mut planned, "terminal-frame", None, text);
    }
    for _ in 0..10 {
        let size = 1_500 + rng.below(4_500) as usize;
        let text = terminal_text(&mut rng, size);
        add(&mut planned, "message", None, text);
    }
    // A large reply: chunks, with characters of every UTF-8 width, and an
    // emoji across the first 64 Ki character chunk boundary.
    let envelope = format!(r#"{{"seq":{},"ctx":"review","data":""#, planned.len()).len();
    let mut review = "a".repeat(65_536 - envelope - 1);
    review.push('😀');
    while review.len() < 2_500_000 {
        review.push_str(&terminal_text(&mut rng, 4_000));
        review.push_str("é😀日本語");
    }
    add(&mut planned, "review", None, review);
    add(&mut planned, "bridge-ping", None, "pong".into());
    // A large terminal message: chunks that are compressed each.
    let terminal = terminal_text(&mut rng, 400_000);
    add(&mut planned, "terminal-frame", None, terminal);
    for _ in 0..60 {
        let text = terminal_text(&mut rng, 8_000);
        add(
            &mut planned,
            "terminal-frame",
            Some("terminal:burst".into()),
            text,
        );
        if let Some(last) = planned.last_mut() {
            last.burst = true;
        }
    }
    // The last of the burst must arrive: it is the current screen.
    if let Some(last) = planned.last_mut() {
        last.burst = false;
    }
    add(&mut planned, "bridge-ping", None, "pong".into());
    planned
}

fn manifest(planned: &[Planned]) -> Vec<Value> {
    planned
        .iter()
        .map(|item| {
            json!({
                "seq": item.seq,
                "ctx": item.context,
                "n": utf16_len(&item.payload),
                "h": hash(&item.payload),
                "burst": item.burst,
            })
        })
        .collect()
}

fn run_all(socket: &SocketHandle) {
    let planned = plan();
    let manifest = manifest(&planned);
    for item in planned {
        socket.send(item.payload, item.context, item.key.as_deref());
    }
    socket.send(
        json!({ "manifest": manifest }).to_string(),
        "manifest",
        None,
    );
}

/// The run as data, for `spike/bun-server.ts` to send through the Bun code.
fn dump_plan(path: &str) {
    let planned = plan();
    let items: Vec<Value> = planned
        .iter()
        .map(|item| json!({ "context": item.context, "key": item.key, "payload": item.payload }))
        .collect();
    let plan = json!({ "items": items, "manifest": manifest(&planned) });
    std::fs::write(path, plan.to_string()).expect("write the plan");
}

fn stats_json(stats: roamgate_ws::SocketStats) -> Value {
    json!({
        "extensions": stats.extensions,
        "flow": {
            "enabled": stats.flow.enabled,
            "sent": stats.flow.sent,
            "acked": stats.flow.acked,
            "window": stats.flow.window,
            "rate": stats.flow.rate,
            "heaviest": stats.flow.heaviest,
        },
        "wire": {
            "bytes_written": stats.wire.bytes_written,
            "frames": stats.wire.frames,
            "compressed_frames": stats.wire.compressed_frames,
            "deflate_in": stats.wire.deflate_in,
            "deflate_out": stats.wire.deflate_out,
            "messages_in": stats.wire.messages_in,
            "compressed_messages_in": stats.wire.compressed_messages_in,
            "max_buffered": stats.wire.max_buffered,
            "warnings": stats.wire.warnings,
        },
    })
}

async fn serve(
    app: App,
    socket: SocketHandle,
    mut events: mpsc::UnboundedReceiver<Event>,
    backend: &'static str,
) {
    let hello = json!({
        "hello": true,
        "bridge_protocol_version": 2,
        "backend": backend,
        "capabilities": { "flow_control": true },
    });
    socket.send(hello.to_string(), "hello", None);
    while let Some(event) = events.recv().await {
        let (text, compressed) = match event {
            Event::Text { text, compressed } => (text, compressed),
            Event::Closed { code, reason } => {
                eprintln!("[{backend}] closed {code:?} {reason}");
                break;
            }
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if message.get("run").is_some() {
            run_all(&socket);
        } else if let Some(echo) = message.get("echo").and_then(Value::as_str) {
            let reply = json!({
                "echoed": message["id"],
                "n": utf16_len(echo),
                "h": hash(echo),
                // yawc does not tell whether a message came compressed.
                "compressed": (backend != "yawc").then_some(compressed),
            });
            socket.send(reply.to_string(), "message", None);
        } else if message.get("stats").is_some() {
            let stats = socket.stats().await.map(stats_json);
            socket.send(json!({ "stats": stats }).to_string(), "message", None);
        } else if let Some(report) = message.get("report") {
            let mut report = report.clone();
            report["backend"] = json!(backend);
            println!("REPORT {report}");
            if let Ok(mut reports) = app.reports.lock() {
                reports.push(report);
            }
        }
    }
}

async fn ws(State(app): State<App>, mut request: Request) -> Response {
    match upgrade::accept(&mut request, true) {
        Err(response) => *response,
        Ok(accepted) => {
            let config = Config {
                compression_level: app.level,
                ..Config::default()
            };
            tokio::spawn(async move {
                let Ok(io) = upgrade::upgraded(accepted.on_upgrade).await else {
                    return;
                };
                let (socket, events) = roamgate_ws::socket::spawn(io, accepted.deflate, config);
                serve(app, socket, events, "roamgate").await;
            });
            accepted.response
        }
    }
}

#[cfg(feature = "yawc")]
async fn ws_yawc(State(app): State<App>, incoming: yawc::IncomingUpgrade) -> Response {
    match roamgate_ws::yawc_backend::accept(incoming, app.level) {
        Err(error) => (axum::http::StatusCode::BAD_REQUEST, error).into_response(),
        Ok((response, socket)) => {
            tokio::spawn(async move {
                if let Some((socket, events)) = socket.await {
                    serve(app, socket, events, "yawc").await;
                }
            });
            response
        }
    }
}

async fn page() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response()
}

async fn reports(State(app): State<App>) -> Response {
    let reports = app
        .reports
        .lock()
        .map(|reports| reports.clone())
        .unwrap_or_default();
    (
        [(header::CONTENT_TYPE, "application/json")],
        Value::Array(reports).to_string(),
    )
        .into_response()
}

#[tokio::main]
async fn main() {
    let mut listen = "127.0.0.1:0".to_owned();
    let mut level = 6;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => listen = args.next().expect("--listen ADDRESS"),
            "--dump-plan" => return dump_plan(&args.next().expect("--dump-plan FILE")),
            "--level" => {
                level = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .expect("--level 0-9")
            }
            other => panic!("unknown argument {other}"),
        }
    }
    let app = App {
        reports: Arc::default(),
        level,
    };
    let router = Router::new()
        .route("/", get(page))
        .route("/ws", get(ws))
        .route("/reports", get(reports));
    #[cfg(feature = "yawc")]
    let router = router.route("/ws-yawc", get(ws_yawc));
    let router = router.with_state(app);
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    println!(
        "listening on http://{}",
        listener.local_addr().expect("address")
    );
    axum::serve(listener, router).await.expect("serve");
}

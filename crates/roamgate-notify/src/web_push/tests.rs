use super::*;
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use roamgate_base::clock::SystemClock;
use roamgate_base::paths::Platform;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A push service of the test's: what it was sent, and its answer.
#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<PushRequest>>,
    /// Endpoints answered 410 Gone.
    gone: Mutex<Vec<String>>,
    /// Held until released, when set.
    gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    started: AtomicUsize,
}

impl PushSender for Arc<Fake> {
    fn send(&self, request: PushRequest) -> BoxFuture<Result<u16, SendError>> {
        let me = self.clone();
        Box::pin(async move {
            me.started.fetch_add(1, Ordering::SeqCst);
            let gate = me.gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let gone = me.gone.lock().unwrap().contains(&request.endpoint);
            me.sent.lock().unwrap().push(request);
            if gone {
                Err(SendError::Status(410))
            } else {
                Ok(201)
            }
        })
    }
}

struct Browser {
    key: SecretKey,
    auth: [u8; 16],
    value: Value,
}

fn device(id: &str) -> Browser {
    let key = SecretKey::random(&mut aes_gcm::aead::OsRng);
    let auth = [id.len() as u8; 16];
    let value = json!({
        "subscription": {
            "endpoint": format!("https://fcm.googleapis.com/fcm/send/{id}"),
            "keys": {
                "p256dh": crypto::base64url(key.public_key().to_encoded_point(false).as_bytes()),
                "auth": crypto::base64url(&auth),
            },
        },
        "preferences": { "completed": true, "blocked": true },
    });
    Browser { key, auth, value }
}

fn blocked() -> Map<String, Value> {
    json!({
        "kind": "blocked",
        "connectionId": "alpha",
        "runtimeGeneration": 3,
        "workspaceId": "w1",
        "paneId": "p1",
        "agent": "Example agent",
    })
    .as_object()
    .unwrap()
    .clone()
}

struct Fixture {
    _root: tempfile::TempDir,
    path: PathBuf,
    context: DataContext,
    fake: Arc<Fake>,
    warnings: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let context = DataContext::new(root.path(), Platform::Unix, None);
        Self {
            path: root.path().join("web-push.json"),
            _root: root,
            context,
            fake: Arc::new(Fake::default()),
            warnings: Arc::default(),
        }
    }

    fn open(&self, subject: &str) -> Arc<WebPush> {
        let warnings = self.warnings.clone();
        WebPush::open(
            self.context.clone(),
            self.path.clone(),
            subject.into(),
            Arc::new(SystemClock),
            Arc::new(self.fake.clone()),
            Arc::new(move |message: &str| warnings.lock().unwrap().push(message.into())),
        )
    }
}

fn post(push: &WebPush, method: &str, body: &Value) -> Answer {
    let headers = |name: &str| match name {
        "x-roamgate-push" => Some("1".to_owned()),
        "content-type" => Some("application/json".to_owned()),
        _ => None,
    };
    push.handle(method, &headers, Some(body.to_string().as_bytes()))
}

fn payload_of(push: &WebPush, task: &Map<String, Value>) -> Map<String, Value> {
    let _ = push;
    crate::payload::task_push_payload(task, None)
}

async fn settle(push: &WebPush) {
    for _ in 0..200 {
        if push.pending() == 0 {
            return;
        }
        tokio::task::yield_now().await;
    }
}

/// web-push.test.ts: "push subject %s uses the default, override, or
/// disables delivery".
#[tokio::test]
async fn push_subject_uses_the_default_override_or_disables_delivery() {
    let env = |pairs: &[(&str, &str)]| -> std::collections::BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    assert_eq!(web_push_subject(&env(&[])), DEFAULT_SUBJECT);
    assert_eq!(
        web_push_subject(&env(&[(
            "HERDR_GUI_WEB_PUSH_SUBJECT",
            "mailto:legacy@example.com"
        )])),
        "mailto:legacy@example.com"
    );
    assert_eq!(
        web_push_subject(&env(&[("ROAMGATE_WEB_PUSH_SUBJECT", "")])),
        ""
    );
    for (subject, available) in [
        (DEFAULT_SUBJECT, true),
        ("mailto:operator@example.com", true),
        ("", false),
        ("invalid-subject", false),
    ] {
        let f = Fixture::new();
        let push = f.open(subject);
        assert_eq!(push.available(), available, "{subject}");
        assert_eq!(f.path.exists(), available, "{subject}");
        let browser = device("one");
        let answer = post(&push, "POST", &browser.value);
        if available {
            assert_eq!(answer, Answer::Json(200, json!({ "ok": true })));
            push.notify(&blocked(), &payload_of(&push, &blocked()), false, None);
            settle(&push).await;
            let sent = f.fake.sent.lock().unwrap();
            assert_eq!(sent.len(), 1);
            let authorization = &sent[0]
                .headers
                .iter()
                .find(|(name, _)| name == "Authorization")
                .unwrap()
                .1;
            let jwt = authorization
                .strip_prefix("vapid t=")
                .unwrap()
                .split('.')
                .nth(1)
                .unwrap();
            let claims: Value = serde_json::from_slice(
                &base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, jwt)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(claims["sub"], subject);
            assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        } else {
            assert_eq!(
                answer,
                Answer::Json(
                    503,
                    json!({ "error": "Web Push is unavailable on this server" })
                )
            );
            assert_eq!(
                push.handle("GET", &|_| None, None),
                Answer::Json(200, json!({ "available": false, "publicKey": null }))
            );
        }
    }
}

/// The enrollment route's checks, as `handle` makes them.
#[test]
fn enrollment_needs_the_custom_header_json_and_a_same_site_request() {
    let f = Fixture::new();
    let push = f.open("mailto:operator@example.com");
    let browser = device("one");
    let body = browser.value.to_string();
    let ask = |method: &str, headers: &[(&str, &str)]| {
        let lookup = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        push.handle(method, &lookup, Some(body.as_bytes()))
    };
    assert_eq!(ask("PUT", &[]), Answer::Text(405, "Method not allowed"));
    assert_eq!(
        ask("POST", &[("content-type", "application/json")]),
        Answer::Text(403, "Forbidden")
    );
    assert_eq!(
        ask(
            "POST",
            &[
                ("x-roamgate-push", "1"),
                ("content-type", "application/json"),
                ("sec-fetch-site", "cross-site")
            ]
        ),
        Answer::Text(403, "Forbidden")
    );
    assert_eq!(
        ask(
            "POST",
            &[("x-roamgate-push", "1"), ("content-type", "text/plain")]
        ),
        Answer::Text(403, "Forbidden")
    );
    assert_eq!(
        ask(
            "POST",
            &[
                ("x-roamgate-push", "1"),
                ("content-type", "application/json; charset=utf-8")
            ]
        ),
        Answer::Json(200, json!({ "ok": true }))
    );
    let lookup = |name: &str| match name {
        "x-roamgate-push" => Some("1".to_owned()),
        "content-type" => Some("application/json".to_owned()),
        _ => None,
    };
    assert_eq!(
        push.handle("POST", &lookup, Some(&vec![b' '; MAX_BODY_BYTES + 1])),
        Answer::Json(400, json!({ "error": "Invalid push request" }))
    );
    assert_eq!(
        push.handle("POST", &lookup, Some(b"not json")),
        Answer::Json(400, json!({ "error": "Invalid push request" }))
    );
}

/// web-push.test.ts: "rejects SSRF destinations, credentials, malformed
/// keys and oversized endpoints" (the validation; the route is the
/// scenario's).
#[test]
fn rejects_ssrf_destinations_credentials_malformed_keys_and_oversized_endpoints() {
    let endpoint = |text: &str| validate_push_endpoint(Some(&json!(text)));
    assert_eq!(
        endpoint("https://FCM.googleapis.com/fcm/send/x").as_deref(),
        Some("https://fcm.googleapis.com/fcm/send/x")
    );
    assert!(endpoint("https://fcm.googleapis.com:443/x").is_some());
    assert!(endpoint("https://a.push.apple.com/x").is_some());
    assert!(endpoint("https://x.notify.windows.com/x").is_some());
    for bad in [
        "https://evil.example/push",
        "http://fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "https://user:pw@fcm.googleapis.com/x",
        "https://fcm.googleapis.com/x#frag",
        "https://push.apple.com.evil.example/x",
        "not a url",
    ] {
        assert!(endpoint(bad).is_none(), "{bad}");
    }
    assert!(endpoint(&format!("https://fcm.googleapis.com/{}", "x".repeat(4096))).is_none());
    assert!(validate_push_endpoint(Some(&json!(1))).is_none());
    let mut browser = device("one").value;
    assert!(validate_push_device(&browser).is_some());
    browser["subscription"]["keys"]["auth"] = json!("short");
    assert!(validate_push_device(&browser).is_none());
    let mut browser = device("one").value;
    browser["preferences"]["blocked"] = json!("yes");
    assert!(validate_push_device(&browser).is_none());
    let mut browser = device("one").value;
    browser["preferences"]["quietWithAndroidApp"] = json!(true);
    browser["extra"] = json!(1);
    assert_eq!(
        validate_push_device(&browser).unwrap()["preferences"],
        json!({ "completed": true, "blocked": true, "quietWithAndroidApp": true })
    );
}

/// web-push.test.ts: "completion and blocked preferences, stale runtimes
/// and expired endpoints are isolated".
#[tokio::test]
async fn completion_and_blocked_preferences_stale_runtimes_and_expired_endpoints_are_isolated() {
    let f = Fixture::new();
    let push = f.open("mailto:operator@example.com");
    let mut completed = device("completed");
    completed.value["preferences"]["blocked"] = json!(false);
    let mut blocked_device = device("blocked");
    blocked_device.value["preferences"]["completed"] = json!(false);
    let expired = device("expired");
    for item in [&completed, &blocked_device, &expired] {
        assert_eq!(
            post(&push, "POST", &item.value),
            Answer::Json(200, json!({ "ok": true }))
        );
    }
    f.fake
        .gone
        .lock()
        .unwrap()
        .push("https://fcm.googleapis.com/fcm/send/expired".into());
    let stale: IsCurrent = Arc::new(|| Box::pin(async { false }));
    push.notify(
        &blocked(),
        &payload_of(&push, &blocked()),
        false,
        Some(stale),
    );
    settle(&push).await;
    assert!(f.fake.sent.lock().unwrap().is_empty());
    push.notify(&blocked(), &payload_of(&push, &blocked()), false, None);
    settle(&push).await;
    {
        let sent = f.fake.sent.lock().unwrap();
        let ends: Vec<&str> = sent
            .iter()
            .map(|request| request.endpoint.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(ends, ["blocked", "expired"]);
        let request = &sent[0];
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(header("TTL"), Some("300"));
        assert_eq!(header("Urgency"), Some("high"));
        assert_eq!(header("Content-Encoding"), Some("aes128gcm"));
        let plain =
            crypto::decrypt(&request.body, &blocked_device.key, &blocked_device.auth).unwrap();
        let payload: Value = serde_json::from_slice(&plain).unwrap();
        assert!(payload["title"].as_str().unwrap().contains("needs input"));
        assert_eq!(
            payload["target"],
            json!({ "connectionId": "alpha", "runtimeGeneration": 3, "workspaceId": "w1", "paneId": "p1" })
        );
    }
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&f.path).unwrap()).unwrap();
    assert_eq!(saved["devices"].as_array().unwrap().len(), 2);
    let mut done = blocked();
    done.insert("kind".into(), json!("completed"));
    push.notify(&done, &payload_of(&push, &done), false, None);
    settle(&push).await;
    assert_eq!(
        f.fake.sent.lock().unwrap().last().unwrap().endpoint,
        "https://fcm.googleapis.com/fcm/send/completed"
    );
    post(
        &push,
        "DELETE",
        &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/completed" }),
    );
    push.notify(&done, &payload_of(&push, &done), false, None);
    settle(&push).await;
    assert_eq!(f.fake.sent.lock().unwrap().len(), 3);
}

/// web-push.test.ts: "bounded delivery concurrency discards revoked and
/// stale queued tasks".
#[tokio::test]
async fn bounded_delivery_concurrency_discards_revoked_and_stale_queued_tasks() {
    let f = Fixture::new();
    let push = f.open("mailto:operator@example.com");
    let gate = Arc::new(tokio::sync::Notify::new());
    *f.fake.gate.lock().unwrap() = Some(gate.clone());
    for index in 0..6 {
        post(&push, "POST", &device(&index.to_string()).value);
    }
    let current = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let check = current.clone();
    let is_current: IsCurrent = Arc::new(move || {
        let current = check.load(Ordering::SeqCst);
        Box::pin(async move { current })
    });
    push.notify(
        &blocked(),
        &payload_of(&push, &blocked()),
        false,
        Some(is_current),
    );
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(f.fake.started.load(Ordering::SeqCst), 4);
    post(
        &push,
        "DELETE",
        &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/4" }),
    );
    current.store(false, Ordering::SeqCst);
    gate.notify_waiters();
    settle(&push).await;
    assert_eq!(f.fake.started.load(Ordering::SeqCst), 4);
    push.stop();
    push.notify(&blocked(), &payload_of(&push, &blocked()), false, None);
    settle(&push).await;
    assert_eq!(f.fake.started.load(Ordering::SeqCst), 4);
}

/// web-push.test.ts: "corrupt private data is preserved and disables push
/// instead of rotating keys".
#[test]
fn corrupt_private_data_is_preserved_and_disables_push_instead_of_rotating_keys() {
    let f = Fixture::new();
    std::fs::write(&f.path, "invalid registry").unwrap();
    let push = f.open("mailto:operator@example.com");
    assert!(!push.available());
    assert_eq!(
        std::fs::read_to_string(&f.path).unwrap(),
        "invalid registry"
    );
    assert_eq!(f.warnings.lock().unwrap().as_slice(), [UNAVAILABLE_WARNING]);
    assert_eq!(
        post(&push, "POST", &device("one").value),
        Answer::Json(
            503,
            json!({ "error": "Web Push is unavailable on this server" })
        )
    );
    // A key pair that does not match is no better.
    let (public, _) = crypto::generate_vapid_keys();
    let (_, private) = crypto::generate_vapid_keys();
    let text = json!({ "version": 1, "publicKey": public, "privateKey": private, "devices": [] })
        .to_string();
    std::fs::write(&f.path, &text).unwrap();
    assert!(!f.open("mailto:operator@example.com").available());
    assert_eq!(std::fs::read_to_string(&f.path).unwrap(), text);
}

/// web-push.test.ts: "a device can stay quiet while the Android app is
/// connected; the feed's payload and skip apply".
#[tokio::test]
async fn a_device_can_stay_quiet_while_the_android_app_is_connected_the_feed_s_payload_and_skip_apply()
 {
    let f = Fixture::new();
    let push = f.open("mailto:operator@example.com");
    let mut quiet = device("quiet");
    quiet.value["preferences"]["quietWithAndroidApp"] = json!(true);
    post(&push, "POST", &quiet.value);
    post(&push, "POST", &device("loud").value);
    let mut payload = payload_of(&push, &blocked());
    payload.insert("path".into(), json!("/#roamgate-work=1"));
    push.notify(&blocked(), &payload, true, None);
    settle(&push).await;
    {
        let sent = f.fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].endpoint.ends_with("/loud"));
    }
    push.notify(&blocked(), &payload, false, None);
    settle(&push).await;
    let sent = f.fake.sent.lock().unwrap();
    assert_eq!(sent.len(), 3);
    let quiet_body = sent
        .iter()
        .find(|request| request.endpoint.ends_with("/quiet"))
        .unwrap();
    let plain = crypto::decrypt(&quiet_body.body, &quiet.key, &quiet.auth).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&plain).unwrap()["path"],
        "/#roamgate-work=1"
    );
}

/// web-push.test.ts: "native delivery uses encrypted fetch with a hard
/// deadline and no redirects": the HTTPS client posts the encrypted body
/// and takes a redirect as a failure.
#[tokio::test]
async fn native_delivery_uses_encrypted_fetch_with_a_hard_deadline_and_no_redirects() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut seen = Vec::new();
        for answer in [
            "HTTP/1.1 201 Created",
            "HTTP/1.1 301 Moved\r\nlocation: http://127.0.0.1:9/",
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 65536];
            let read = socket.read(&mut request).await.unwrap();
            seen.push(String::from_utf8_lossy(&request[..read]).into_owned());
            socket
                .write_all(
                    format!("{answer}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
        }
        seen
    });
    let browser = device("one");
    let (public, private) = crypto::generate_vapid_keys();
    let private = crypto::key_bytes(&private, 32).unwrap();
    let mut subscription = browser.value["subscription"].clone();
    subscription["endpoint"] = json!(format!("http://{address}/push"));
    let request = push_request(
        &subscription,
        "{\"title\":\"Example agent\"}",
        "mailto:a@b.c",
        &public,
        &private,
        0,
    )
    .unwrap();
    assert!(
        !request
            .body
            .windows(13)
            .any(|window| window == b"Example agent")
    );
    let sender = HttpsSender::new();
    assert_eq!(sender.send(request.clone()).await, Ok(201));
    assert!(matches!(
        sender.send(request).await,
        Err(SendError::Failed(_))
    ));
    let seen = server.await.unwrap();
    assert!(seen[0].starts_with("POST /push HTTP/1.1"));
    assert!(
        seen[0]
            .to_ascii_lowercase()
            .contains("content-encoding: aes128gcm")
    );
    assert!(
        seen[0]
            .to_ascii_lowercase()
            .contains(&"authorization: vapid t=".to_string())
    );
}

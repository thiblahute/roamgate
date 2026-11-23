//! notifications.json and web-push.json between the Bun server and this
//! crate (the plan's section 5.7): forward (files as Bun keeps them, old
//! registries included, read alike by both), backward (what Rust writes,
//! Bun reads and writes on from), coexistence (the family handed from Bun
//! to Rust and back, one writer at a time), and Web Push's encryption and
//! VAPID authorization read by the other side. Skipped, saying why, when
//! bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::SecretKey;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use roamgate_base::clock::SystemClock;
use roamgate_base::paths::{DataContext, Platform};
use roamgate_notify::crypto;
use roamgate_notify::feed::{Extra, Feed, load};
use roamgate_notify::service::{Notifications, Options};
use roamgate_notify::web_push::{
    Answer, BoxFuture, PushRequest, PushSender, SendError, read_push_registry,
};
use serde_json::{Map, Value, json};

const ORIGIN: &str = "https://roamgate.example";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the Bun side cannot run");
    }
    found
}

/// Runs a Bun script from server/ (its modules and `web-push`), its stdout
/// parsed as JSON.
fn run_bun(bun: &Path, home: &Path, source: &str, args: &[&str]) -> Value {
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_NOTIFICATIONS_PATH")
        .env_remove("ROAMGATE_WEB_PUSH_PATH")
        .env_remove("ROAMGATE_WEB_PUSH_SUBJECT")
        .arg("-e")
        .arg(source)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
}

/// Bun's feed on a file: what a client that says `since: 0` replays, the
/// feed's numbers, then (with a task) one more publish.
const BUN_FEED: &str = r#"
import { createNotificationFeed } from "./src/notifications/notification-feed";
const [path, task] = process.argv.slice(1);
const feed = createNotificationFeed({ path });
const sent = [];
const socket = { send: (text) => sent.push(JSON.parse(text)), close() {} };
feed.open(socket, "https://roamgate.example");
feed.message(socket, JSON.stringify({ op: "hello", since: 0, client: "android", preferences: { completed: true, blocked: true } }));
const replayed = sent.length;
const id = task ? feed.publish(JSON.parse(task)) : null;
sent.length = replayed;
const status = feed.status();
feed.stop();
console.log(JSON.stringify({ sent, last: status.last, events: status.events, id }));
"#;

/// Bun's reading of a registry, and its text written again as Bun writes it.
const BUN_REGISTRY: &str = r#"
import { readPushRegistry } from "./src/notifications/web-push";
import { readFileSync } from "node:fs";
const [path] = process.argv.slice(1);
let registry = null, error = null;
try { registry = readPushRegistry(path); } catch (e) { error = String(e.message); }
console.log(JSON.stringify({ registry, error }));
"#;

/// A file's JSON written again as JSON.stringify writes it.
const BUN_RESTRINGIFY: &str = r#"
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[1], "utf8");
console.log(JSON.stringify({ same: JSON.stringify(JSON.parse(text)) + "\n" === text }));
"#;

/// What a client is sent for a stored event (the Bun feed's `wire`).
fn wire(event: &Map<String, Value>) -> Value {
    if event["event"] == "notification_clear" {
        return json!({ "event": event["event"], "id": event["id"], "at": event["at"], "tag": event["tag"] });
    }
    let mut out = json!({
        "event": event["event"],
        "id": event["id"],
        "at": event["at"],
        "kind": event["kind"],
        "title": event["title"],
        "body": event["body"],
        "tag": event["tag"],
        "group": event["group"],
        "url": format!("{ORIGIN}{}", event["path"].as_str().unwrap()),
    });
    if event
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| !actions.is_empty())
    {
        out["actions"] = event["actions"].clone();
    }
    out
}

fn context(home: &Path) -> DataContext {
    DataContext::new(home, Platform::Unix, None)
}

fn task(kind: &str, pane: &str) -> Map<String, Value> {
    json!({
        "kind": kind,
        "connectionId": "alpha",
        "connectionLabel": "Desk",
        "runtimeGeneration": 3,
        "workspaceId": "w1",
        "workspaceLabel": "roamgate \u{1f680}",
        "paneId": pane,
        "agent": "Claude",
    })
    .as_object()
    .unwrap()
    .clone()
}

fn device(id: &str, quiet: Option<bool>) -> (Value, SecretKey) {
    let key = SecretKey::random(&mut aes_gcm::aead::OsRng);
    let mut preferences = json!({ "completed": true, "blocked": true });
    if let Some(quiet) = quiet {
        preferences["quietWithAndroidApp"] = json!(quiet);
    }
    (
        json!({
            "subscription": {
                "endpoint": format!("https://fcm.googleapis.com/fcm/send/{id}"),
                "keys": {
                    "p256dh": crypto::base64url(key.public_key().to_encoded_point(false).as_bytes()),
                    "auth": crypto::base64url(&[9u8; 16]),
                },
            },
            "preferences": preferences,
        }),
        key,
    )
}

/// The Rust side's reading of a registry, as Bun returns it.
fn rust_registry(home: &Path, path: &Path) -> Value {
    let mut ids = 0;
    match read_push_registry(&context(home), path, &mut || {
        ids += 1;
        ids
    }) {
        Ok(registry) => registry.to_value(&registry.devices),
        Err(_) => Value::Null,
    }
}

/// Forward: a feed and registries as the Bun server keeps them (an old
/// registry without `quietWithAndroidApp`, one with an unknown field, and
/// invalid ones) read alike by both.
#[test]
fn files_bun_keeps_are_read_alike() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let feed_path = home.path().join("notifications.json");
    std::fs::write(
        &feed_path,
        serde_json::to_string(&json!({
            "version": 1,
            "last": 7,
            "events": [
                { "event": "notification", "id": 4, "at": 2_000_000_000_000u64 - 1000, "kind": "blocked", "title": "Claude wants Bash", "body": "ls", "tag": "[\"roamgate-task\",\"alpha\",3,\"p1\"]", "group": "roamgate", "path": "/#roamgate-task=x", "actions": [{ "id": "allow", "label": "Allow" }], "prompt": { "connectionId": "alpha", "promptId": "q1" }, "pref": "blocked", "pane": "alpha\np1" },
                { "event": "notification", "id": 5, "at": 2_000_000_000_000u64 - 500, "kind": "work", "title": "For you: x", "body": "do", "tag": "w", "group": "Work", "path": "/#roamgate-work=1", "pref": "blocked", "pane": "alpha\nwork:1" },
                { "event": "notification_clear", "id": 6, "at": 2_000_000_000_000u64 - 400, "tag": "old" },
                { "event": "notification", "id": 7, "at": 2_000_000_000_000u64 - 300, "kind": "ranger_task", "title": "t", "body": "b", "tag": "r", "group": "Ranger", "path": "/", "pref": "completed" },
                { "event": "notification", "id": 3, "at": 2_000_000_000_000u64 - 200, "title": "no pref", "body": "", "tag": "z", "group": "g", "path": "/" }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let bun_feed = run_bun(&bun, home.path(), BUN_FEED, &[feed_path.to_str().unwrap()]);
    let saved = load(&context(home.path()), &feed_path);
    let mut expected: Vec<Value> = saved.events.iter().map(wire).collect();
    expected.push(json!({ "event": "ready", "last": saved.last }));
    assert_eq!(bun_feed["sent"], Value::Array(expected));
    assert_eq!(bun_feed["last"], saved.last);
    assert_eq!(bun_feed["events"], saved.events.len());

    let registry_path = home.path().join("web-push.json");
    let (public, private) = crypto::generate_vapid_keys();
    let (old, _) = device("old", None);
    let (quiet, _) = device("quiet", Some(true));
    let (loud, _) = device("loud", Some(false));
    let cases = [
        json!({ "version": 1, "publicKey": public, "privateKey": private, "devices": [old, quiet, loud] }),
        json!({ "version": 1, "publicKey": public, "privateKey": private, "devices": [], "note": "kept" }),
        json!({ "version": 2, "publicKey": public, "privateKey": private, "devices": [] }),
        json!({ "version": 1, "publicKey": public, "privateKey": crypto::generate_vapid_keys().1, "devices": [] }),
        json!({ "version": 1, "publicKey": public, "privateKey": private, "devices": [{ "subscription": { "endpoint": "https://evil.example/x" } }] }),
    ];
    for case in cases {
        std::fs::write(&registry_path, case.to_string()).unwrap();
        let bun_registry = run_bun(
            &bun,
            home.path(),
            BUN_REGISTRY,
            &[registry_path.to_str().unwrap()],
        );
        assert_eq!(
            bun_registry["registry"],
            rust_registry(home.path(), &registry_path),
            "{case}"
        );
    }
}

/// Never sends: the backward and coexistence checks do not deliver.
struct NoSend;

impl PushSender for NoSend {
    fn send(&self, _request: PushRequest) -> BoxFuture<Result<u16, SendError>> {
        Box::pin(async { Ok(201) })
    }
}

fn notifications(home: &Path) -> Notifications {
    Notifications::new(Options {
        context: context(home),
        feed_path: home.join("notifications.json"),
        push_path: home.join("web-push.json"),
        subject: "mailto:operator@example.com".into(),
        clock: Arc::new(SystemClock),
        sender: Arc::new(NoSend),
        warn: Arc::new(|message: &str| panic!("warned: {message}")),
    })
}

fn enroll(service: &Notifications, method: &str, body: &Value) -> Answer {
    let header = |name: &str| match name {
        "x-roamgate-push" => Some("1".to_owned()),
        "content-type" => Some("application/json".to_owned()),
        _ => None,
    };
    service
        .http(method, &header, Some(body.to_string().as_bytes()))
        .unwrap()
}

/// Backward: what the Rust side writes is what Bun would have written (the
/// same text for the same data), Bun replays it alike and numbers on from
/// it; the registry Rust wrote is the one Bun reads.
#[tokio::test]
async fn bun_reads_what_rust_writes_and_numbers_on() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let service = notifications(home.path());
    service.start();
    let (one, _) = device("one", Some(true));
    let (two, _) = device("two", None);
    assert_eq!(
        enroll(&service, "POST", &one),
        Answer::Json(200, json!({ "ok": true }))
    );
    assert_eq!(
        enroll(&service, "POST", &two),
        Answer::Json(200, json!({ "ok": true }))
    );
    assert_eq!(
        enroll(
            &service,
            "DELETE",
            &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/two" })
        ),
        Answer::Json(200, json!({ "ok": true }))
    );
    let extra = Extra {
        actions: Some(
            json!([{ "id": "allow", "label": "Allow" }, { "id": "deny", "label": "Deny" }]),
        ),
        prompt: Some(json!({ "connectionId": "alpha", "promptId": "q1" })),
        ..Extra::default()
    };
    service
        .publish(&task("blocked", "p1"), &extra, false, None)
        .unwrap();
    service
        .publish(&task("blocked", "p1"), &Extra::default(), false, None)
        .unwrap();
    service
        .publish(&task("completed", "p2"), &Extra::default(), false, None)
        .unwrap();
    service.clear_pane("alpha", "p2").unwrap();
    service.stop();

    let feed_path = home.path().join("notifications.json");
    let registry_path = home.path().join("web-push.json");
    for path in [&feed_path, &registry_path] {
        let same = run_bun(
            &bun,
            home.path(),
            BUN_RESTRINGIFY,
            &[path.to_str().unwrap()],
        );
        assert_eq!(same["same"], true, "{}", path.display());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let saved = load(&context(home.path()), &feed_path);
    let bun_feed = run_bun(
        &bun,
        home.path(),
        BUN_FEED,
        &[
            feed_path.to_str().unwrap(),
            &serde_json::to_string(&task("completed", "p3")).unwrap(),
        ],
    );
    let mut expected: Vec<Value> = saved.events.iter().map(wire).collect();
    expected.push(json!({ "event": "ready", "last": saved.last }));
    assert_eq!(bun_feed["sent"], Value::Array(expected));
    assert_eq!(bun_feed["id"], saved.last + 1);
    // What Bun wrote, Rust reads on.
    let after = load(&context(home.path()), &feed_path);
    assert_eq!(after.last, saved.last + 1);
    assert_eq!(after.events.last().unwrap()["pane"], "alpha\np3");

    let bun_registry = run_bun(
        &bun,
        home.path(),
        BUN_REGISTRY,
        &[registry_path.to_str().unwrap()],
    );
    assert_eq!(
        bun_registry["registry"],
        rust_registry(home.path(), &registry_path)
    );
    assert_eq!(bun_registry["registry"]["devices"], json!([one]));
}

/// Coexistence: the family goes from Bun to Rust and back; each side reads
/// the other's last write when it takes over, and the side that gave it up
/// writes nothing more.
#[tokio::test]
async fn the_family_goes_to_rust_and_back_with_one_writer() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let feed_path = home.path().join("notifications.json");
    // Bun owns it first.
    let first = run_bun(
        &bun,
        home.path(),
        BUN_FEED,
        &[
            feed_path.to_str().unwrap(),
            &serde_json::to_string(&task("blocked", "p1")).unwrap(),
        ],
    );
    assert_eq!(first["id"], 1);
    // Rust takes it.
    let service = notifications(home.path());
    service.start();
    let (id, change) = service
        .publish(&task("completed", "p2"), &Extra::default(), false, None)
        .unwrap();
    assert_eq!((id, change.deliver), (2, vec![2]));
    service.clear_pane("alpha", "p1").unwrap();
    // Rust gives it back: nothing more is written by it.
    service.stop();
    let written = std::fs::read_to_string(&feed_path).unwrap();
    assert!(
        service
            .publish(&task("blocked", "p9"), &Extra::default(), false, None)
            .is_err()
    );
    assert!(service.clear_tag("x").is_err());
    assert_eq!(std::fs::read_to_string(&feed_path).unwrap(), written);
    // Bun reads Rust's last write and numbers on.
    let back = run_bun(
        &bun,
        home.path(),
        BUN_FEED,
        &[
            feed_path.to_str().unwrap(),
            &serde_json::to_string(&task("blocked", "p4")).unwrap(),
        ],
    );
    assert_eq!(back["id"], 4);
    let ids: Vec<Value> = back["sent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["id"].clone())
        .collect();
    assert_eq!(ids, [json!(2), json!(3), Value::Null]);
    // And Rust again.
    let mut feed = Feed::open(context(home.path()), feed_path.clone());
    assert_eq!(feed.saved().last, 4);
    let (event, _, _) = feed.publish(&task("blocked", "p5"), &Extra::default(), 0);
    assert_eq!(event["id"], 5);
}

/// Bun's decryption of what Rust encrypts, with node:crypto (RFC 8291), and
/// the VAPID JWT verified with Bun's ES256.
const BUN_DECRYPT: &str = r#"
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify } from "node:crypto";
const [bodyB64, privateB64, publicB64, authB64, authorization] = process.argv.slice(1);
const body = Buffer.from(bodyB64, "base64url");
const hkdf = (salt, ikm, info, length) => {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
};
const salt = body.subarray(0, 16);
const idlen = body[20];
const serverKey = body.subarray(21, 21 + idlen);
const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(Buffer.from(privateB64, "base64url"));
const shared = ecdh.computeSecret(serverKey);
const userPublic = Buffer.from(publicB64, "base64url");
const ikm = hkdf(Buffer.from(authB64, "base64url"), shared, Buffer.concat([Buffer.from("WebPush: info\0"), userPublic, serverKey]), 32);
const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
const record = body.subarray(21 + idlen);
const decipher = createDecipheriv("aes-128-gcm", key, nonce);
decipher.setAuthTag(record.subarray(record.length - 16));
const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
const text = plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
const [h, c, s] = jwt.split(".");
const point = Buffer.from(k, "base64url");
const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
console.log(JSON.stringify({ text, verified: ok, claims: JSON.parse(Buffer.from(c, "base64url").toString()) }));
"#;

/// What Bun's web-push encrypts and signs, for Rust to read.
const BUN_ENCRYPT: &str = r#"
import webpush from "web-push";
const [endpoint, p256dh, auth, payload] = process.argv.slice(1);
const keys = webpush.generateVAPIDKeys();
const details = webpush.generateRequestDetails({ endpoint, keys: { p256dh, auth } }, payload, {
  TTL: 300, urgency: "high", vapidDetails: { subject: "mailto:operator@example.com", ...keys },
});
console.log(JSON.stringify({ body: Buffer.from(details.body).toString("base64url"), headers: details.headers, publicKey: keys.publicKey }));
"#;

#[test]
fn web_push_messages_read_on_the_other_side() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let user = SecretKey::random(&mut aes_gcm::aead::OsRng);
    let user_public = crypto::base64url(user.public_key().to_encoded_point(false).as_bytes());
    let auth = crypto::base64url(&[5u8; 16]);
    let payload =
        json!({ "title": "Roamgate agent needs input", "body": "Claude \u{b7} \u{1f680}" })
            .to_string();

    // Rust to Bun.
    let (vapid_public, vapid_private) = crypto::generate_vapid_keys();
    let subscription = json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": { "p256dh": user_public, "auth": auth } });
    let request = roamgate_notify::web_push::push_request(
        &subscription,
        &payload,
        "mailto:operator@example.com",
        &vapid_public,
        &crypto::key_bytes(&vapid_private, 32).unwrap(),
        2_000_000_000_000,
    )
    .unwrap();
    let authorization = request
        .headers
        .iter()
        .find(|(name, _)| name == "Authorization")
        .unwrap()
        .1
        .clone();
    let read = run_bun(
        &bun,
        home.path(),
        BUN_DECRYPT,
        &[
            &crypto::base64url(&request.body),
            &crypto::base64url(&user.to_bytes()),
            &user_public,
            &auth,
            &authorization,
        ],
    );
    assert_eq!(read["text"], payload);
    assert_eq!(read["verified"], true);
    assert_eq!(
        read["claims"],
        json!({ "aud": "https://fcm.googleapis.com", "exp": 2_000_000_000 + 43_200, "sub": "mailto:operator@example.com" })
    );

    // Bun to Rust.
    let sent = run_bun(
        &bun,
        home.path(),
        BUN_ENCRYPT,
        &[
            "https://fcm.googleapis.com/fcm/send/x",
            &user_public,
            &auth,
            &payload,
        ],
    );
    let body = URL_SAFE_NO_PAD
        .decode(sent["body"].as_str().unwrap())
        .unwrap();
    let plain = crypto::decrypt(&body, &user, &[5u8; 16]).unwrap();
    assert_eq!(String::from_utf8(plain).unwrap(), payload);
    let header = sent["headers"]["Authorization"].as_str().unwrap();
    let (jwt, key) = header
        .strip_prefix("vapid t=")
        .unwrap()
        .split_once(", k=")
        .unwrap();
    assert_eq!(key, sent["publicKey"]);
    let parts: Vec<&str> = jwt.split('.').collect();
    VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(key).unwrap())
        .unwrap()
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap(),
        )
        .unwrap();
    // The same headers as Rust's request, besides the values that differ by
    // message.
    let mut names: Vec<&str> = sent["headers"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut ours: Vec<&str> = request
        .headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    names.sort_unstable();
    ours.sort_unstable();
    assert_eq!(names, ours);
    assert_eq!(sent["headers"]["TTL"], 300);
    assert_eq!(sent["headers"]["Urgency"], "high");
}

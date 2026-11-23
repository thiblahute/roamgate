//! `roamgate push test` (cli/push.ts): one test notification to every
//! enrolled device with the service's VAPID keys, each push service's answer
//! reported. The registry is only read; the server removes expired
//! subscriptions on its next delivery.

use std::path::Path;
use std::sync::Arc;

use roamgate_base::paths::DataContext;
use serde_json::{Value, json};

use crate::web_push::{PushSender, SendError, push_request, read_push_registry};

/// The command's help, as the contract holds it (printed as is).
pub const PUSH_HELP: &str = include_str!("../../../contract/cli/help/push.txt");

/// The test message.
pub fn test_payload() -> String {
    serde_json::to_string(&json!({
        "title": "Roamgate test notification",
        "body": "Web Push delivery to this device works.",
        "tag": "roamgate-test",
        "target": null,
    }))
    .unwrap_or_default()
}

/// What `push test` found: the lines it prints and whether all succeeded.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// A reason to stop, printed on stderr (exit 1).
    Refused(String),
    /// Each device's result (`{provider, ok, status?, error?}`).
    Sent(Vec<Value>),
}

/// Sends the test message to every enrolled device of the registry at
/// `path` (`shown` is how the path is printed).
pub async fn push_test(
    context: &DataContext,
    subject: &str,
    path: &Path,
    shown: &str,
    sender: Arc<dyn PushSender>,
    now_ms: i64,
) -> Outcome {
    if subject.is_empty() {
        return Outcome::Refused(
            "roamgate push: Web Push is disabled because ROAMGATE_WEB_PUSH_SUBJECT is empty."
                .into(),
        );
    }
    if !path.exists() {
        return Outcome::Refused(format!(
            "roamgate push: no push registry at {shown}; enable Task notifications in a browser first."
        ));
    }
    let mut ids = 0;
    let registry = match read_push_registry(context, path, &mut || {
        ids += 1;
        ids
    }) {
        Ok(registry) => registry,
        Err(error) => return Outcome::Refused(format!("roamgate push: {}", error.0)),
    };
    if registry.devices.is_empty() {
        return Outcome::Refused(
            "roamgate push: no devices are enrolled; enable Task notifications in a browser first."
                .into(),
        );
    }
    let payload = test_payload();
    let sends = registry.devices.iter().map(|device| {
        let subscription = device.value["subscription"].clone();
        let provider = url::Url::parse(device.endpoint())
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_default();
        let request = push_request(
            &subscription,
            &payload,
            subject,
            &registry.public_key,
            &registry.private_key,
            now_ms,
        );
        let sender = sender.clone();
        async move {
            let result = match request {
                Ok(request) => sender.send(request).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(_) => json!({ "provider": provider, "ok": true }),
                Err(SendError::Status(status @ (404 | 410))) => json!({
                    "provider": provider,
                    "ok": false,
                    "status": status,
                    "error": "subscription expired; re-enable notifications on that device",
                }),
                Err(SendError::Status(status)) => json!({
                    "provider": provider,
                    "ok": false,
                    "status": status,
                    "error": format!("provider answered HTTP {status}"),
                }),
                Err(SendError::Failed(message)) => json!({
                    "provider": provider,
                    "ok": false,
                    "error": message,
                }),
            }
        }
    });
    let mut results = Vec::new();
    for result in futures_join(sends).await {
        results.push(result);
    }
    Outcome::Sent(results)
}

/// Runs the futures together, their results in order (`Promise.all`).
async fn futures_join<F: std::future::Future<Output = Value> + Send + 'static>(
    futures: impl Iterator<Item = F>,
) -> Vec<Value> {
    let handles: Vec<_> = futures.map(tokio::spawn).collect();
    let mut out = Vec::new();
    for handle in handles {
        out.push(handle.await.unwrap_or(Value::Null));
    }
    out
}

/// The human lines of the results.
pub fn result_lines(results: &[Value]) -> Vec<String> {
    results
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let provider = result["provider"].as_str().unwrap_or("");
            if result["ok"] == true {
                format!("ok    device {} ({provider})", index + 1)
            } else {
                format!(
                    "fail  device {} ({provider}): {}",
                    index + 1,
                    result["error"].as_str().unwrap_or("")
                )
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use crate::web_push::BoxFuture;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use roamgate_base::paths::Platform;
    use std::sync::Mutex;

    struct Fake {
        payloads: Mutex<Vec<(String, Vec<u8>)>>,
        keys: Vec<(p256::SecretKey, [u8; 16])>,
    }

    impl PushSender for Arc<Fake> {
        fn send(&self, request: crate::web_push::PushRequest) -> BoxFuture<Result<u16, SendError>> {
            let me = self.clone();
            Box::pin(async move {
                me.payloads
                    .lock()
                    .unwrap()
                    .push((request.endpoint.clone(), request.body));
                if request.endpoint.contains("apple") {
                    Err(SendError::Status(410))
                } else {
                    Ok(201)
                }
            })
        }
    }

    fn registry(root: &Path, endpoints: &[&str]) -> (std::path::PathBuf, Arc<Fake>) {
        let mut keys = Vec::new();
        let devices: Vec<Value> = endpoints
            .iter()
            .map(|endpoint| {
                let key = p256::SecretKey::random(&mut aes_gcm::aead::OsRng);
                let auth = [3u8; 16];
                let device = json!({
                    "subscription": {
                        "endpoint": endpoint,
                        "keys": {
                            "p256dh": crypto::base64url(key.public_key().to_encoded_point(false).as_bytes()),
                            "auth": crypto::base64url(&auth),
                        },
                    },
                    "preferences": { "completed": true, "blocked": false },
                });
                keys.push((key, auth));
                device
            })
            .collect();
        let (public, private) = crypto::generate_vapid_keys();
        let path = root.join("web-push.json");
        std::fs::write(
            &path,
            json!({ "version": 1, "publicKey": public, "privateKey": private, "devices": devices })
                .to_string(),
        )
        .unwrap();
        (
            path,
            Arc::new(Fake {
                payloads: Mutex::default(),
                keys,
            }),
        )
    }

    /// cli/push.test.ts: "sends one test message per device and reports
    /// expired ones".
    #[tokio::test]
    async fn sends_one_test_message_per_device_and_reports_expired_ones() {
        let root = tempfile::tempdir().unwrap();
        let context = DataContext::new(root.path(), Platform::Unix, None);
        let (path, fake) = registry(
            root.path(),
            &[
                "https://fcm.googleapis.com/fcm/send/one",
                "https://web.push.apple.com/two",
            ],
        );
        let before = std::fs::read_to_string(&path).unwrap();
        let outcome = push_test(
            &context,
            "mailto:a@b.c",
            &path,
            "~/x",
            Arc::new(fake.clone()),
            0,
        )
        .await;
        let Outcome::Sent(results) = outcome else {
            panic!("refused");
        };
        assert_eq!(
            result_lines(&results),
            [
                "ok    device 1 (fcm.googleapis.com)",
                "fail  device 2 (web.push.apple.com): subscription expired; re-enable notifications on that device",
            ]
        );
        let payloads = fake.payloads.lock().unwrap();
        let first = payloads
            .iter()
            .find(|(endpoint, _)| endpoint.contains("fcm"))
            .unwrap();
        let (key, auth) = &fake.keys[0];
        let plain = crypto::decrypt(&first.1, key, auth).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&plain).unwrap(),
            json!({
                "title": "Roamgate test notification",
                "body": "Web Push delivery to this device works.",
                "tag": "roamgate-test",
                "target": null,
            })
        );
        // The server owns the registry; the CLI never rewrites it.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    /// cli/push.test.ts: "explains disabled push and empty registries".
    #[tokio::test]
    async fn explains_disabled_push_and_empty_registries() {
        let root = tempfile::tempdir().unwrap();
        let context = DataContext::new(root.path(), Platform::Unix, None);
        let path = root.path().join("web-push.json");
        let fake: Arc<dyn PushSender> = Arc::new(Arc::new(Fake {
            payloads: Mutex::default(),
            keys: Vec::new(),
        }));
        let refused = |outcome: Outcome| match outcome {
            Outcome::Refused(message) => message,
            Outcome::Sent(_) => panic!("sent"),
        };
        assert!(
            refused(push_test(&context, "", &path, "p", fake.clone(), 0).await)
                .contains("disabled")
        );
        assert!(
            refused(push_test(&context, "mailto:a@b.c", &path, "p", fake.clone(), 0).await)
                .contains("no push registry at p")
        );
        registry(root.path(), &[]);
        assert!(
            refused(push_test(&context, "mailto:a@b.c", &path, "p", fake, 0).await)
                .contains("no devices are enrolled")
        );
    }

    /// cli/push.test.ts: "succeeds when every provider accepts".
    #[tokio::test]
    async fn succeeds_when_every_provider_accepts() {
        let root = tempfile::tempdir().unwrap();
        let context = DataContext::new(root.path(), Platform::Unix, None);
        let (path, fake) = registry(root.path(), &["https://fcm.googleapis.com/fcm/send/one"]);
        let Outcome::Sent(results) =
            push_test(&context, "mailto:a@b.c", &path, "p", Arc::new(fake), 0).await
        else {
            panic!("refused");
        };
        assert!(results.iter().all(|result| result["ok"] == true));
    }
}

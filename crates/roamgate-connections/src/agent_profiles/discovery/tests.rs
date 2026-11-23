//! server/src/profiles/profiles.test.ts, "model discovery".

use std::sync::atomic::{AtomicI64, Ordering};

use super::*;
use crate::agent_profiles::store::tests::settings_with;

type Seen = Arc<Mutex<Vec<(String, Vec<(String, String)>)>>>;

fn answering(status: u16, body: Value, seen: Seen) -> ModelFetch {
    Arc::new(move |url, headers, _| {
        seen.lock().unwrap().push((url, headers));
        let body = body.to_string().into_bytes();
        Box::pin(async move { Ok(FetchResponse { status, body }) })
    })
}

fn discovery(fetch: ModelFetch, now: Option<NowMs>) -> ModelDiscovery {
    ModelDiscovery::new(ModelDiscoveryOptions {
        fetch: Some(fetch),
        now,
        timeout: None,
        home: PathBuf::from("/nonexistent-home"),
    })
}

#[tokio::test]
async fn lists_a_gateways_chat_models_with_the_profiles_token() {
    let dir = tempfile::tempdir().unwrap();
    let profile = settings_with(dir.path(), "Claude")["profiles"]["list"][0].clone();
    let seen: Seen = Arc::default();
    let now = Arc::new(AtomicI64::new(0));
    let read = now.clone();
    let discover = discovery(
        answering(
            200,
            json!({"data": [{"id": "glm-5p3"}, {"id": "kimi-k3p1-pro"}, {"id": "qwen3-embedding-8b"}]}),
            seen.clone(),
        ),
        Some(Arc::new(move || read.load(Ordering::SeqCst))),
    );
    let first = discover.models(&profile, false).await;
    assert_eq!(first["models"], json!(["glm-5p3", "kimi-k3p1-pro"]));
    assert_eq!(first["source"], json!("server"));
    assert_eq!(first["missing"], json!([]));
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "https://gw.example/v1/models?limit=1000");
        let headers = &seen[0].1;
        assert!(headers.contains(&("authorization".into(), "Bearer s3cret".into())));
        assert!(headers.contains(&("x-api-key".into(), "s3cret".into())));
    }
    // Kept an hour.
    now.store(30 * 60_000, Ordering::SeqCst);
    discover.models(&profile, false).await;
    assert_eq!(seen.lock().unwrap().len(), 1);
    discover.models(&profile, true).await;
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn warns_about_a_configured_model_the_server_no_longer_has() {
    let dir = tempfile::tempdir().unwrap();
    let profile = settings_with(dir.path(), "Claude")["profiles"]["list"][0].clone();
    let discover = discovery(
        answering(200, json!({"data": [{"id": "kimi-k3"}]}), Seen::default()),
        None,
    );
    assert_eq!(
        discover.models(&profile, false).await["missing"],
        json!([{"slot": "ANTHROPIC_MODEL", "model": "glm-5p3"}])
    );
}

#[tokio::test]
async fn claude_itself_gets_its_aliases_asking_no_server() {
    let seen: Seen = Arc::default();
    let discover = discovery(answering(500, json!({}), seen.clone()), None);
    let result = discover
        .models(&json!({"name": "Claude", "agent": "claude"}), false)
        .await;
    assert_eq!(result["source"], json!("aliases"));
    assert_eq!(
        result["models"],
        json!(["opus", "sonnet", "haiku", "opusplan"])
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_list_keeps_the_token_out_of_its_message() {
    let dir = tempfile::tempdir().unwrap();
    let profile = settings_with(dir.path(), "Claude")["profiles"]["list"][0].clone();
    let discover = discovery(answering(401, json!("no"), Seen::default()), None);
    let result = discover.models(&profile, false).await;
    assert!(result["error"].as_str().unwrap().contains("401"));
    assert!(!result.to_string().contains("s3cret"));
}

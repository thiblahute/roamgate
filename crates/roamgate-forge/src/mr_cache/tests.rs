//! mr-cache/cache.test.ts, the same cases on the Rust cache.

use super::*;
use roamgate_base::clock::Clock;
use roamgate_base::clock::TestClock;
use roamgate_base::paths::Platform;
use std::sync::atomic::AtomicUsize;

/// A forge that counts the reads it is asked for.
#[derive(Clone)]
struct FakeForge {
    reads: Arc<AtomicUsize>,
    answer: Arc<dyn Fn(usize) -> Loaded + Send + Sync>,
}

impl FakeForge {
    fn new(answer: impl Fn(usize) -> Loaded + Send + Sync + 'static) -> Self {
        Self {
            reads: Arc::default(),
            answer: Arc::new(answer),
        }
    }

    fn counting(ttl: i64) -> Self {
        Self::new(move |n| Loaded::kept(json!(format!("v{n}")), ttl))
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn options(&self) -> SwrOptions<Loaded, LoadError> {
        self.options_with(false, None, 0)
    }

    fn options_with(
        &self,
        fresh: bool,
        head: Option<Option<String>>,
        known_paused: i64,
    ) -> SwrOptions<Loaded, LoadError> {
        let forge = self.clone();
        reader_options(
            move || {
                let n = forge.reads.fetch_add(1, Ordering::SeqCst) + 1;
                let answer = (forge.answer)(n);
                Box::pin(async move {
                    tokio::task::yield_now().await;
                    Ok(answer)
                })
            },
            fresh,
            head,
            known_paused,
        )
    }
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn setup() -> (TestClock, MrCache, Arc<Mutex<Vec<Value>>>) {
    let clock = TestClock::new(1_000_000);
    let pushes: Arc<Mutex<Vec<Value>>> = Arc::default();
    let cache = MrCache::open(
        Arc::new(clock.clone()),
        None,
        Some({
            let pushes = pushes.clone();
            Arc::new(move |push| pushes.lock().unwrap().push(push))
        }),
    );
    (clock, cache, pushes)
}

#[tokio::test]
async fn a_known_answer_is_served_without_a_forge_call() {
    let (clock, cache, pushes) = setup();
    let forge = FakeForge::counting(60_000);
    assert_eq!(
        cache.get("k", &forge.options()).await.unwrap().value.value,
        json!("v1")
    );
    clock.advance(30_000).await;
    let answer = cache.get("k", &forge.options()).await.unwrap();
    assert_eq!(answer.value.value, json!("v1"));
    assert!(!answer.stale);
    assert_eq!(forge.reads(), 1);
    // "k" is no chip, card or session: no client is told.
    assert!(pushes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_old_answer_is_served_at_once_and_read_again_once_in_the_background() {
    let (clock, cache, _) = setup();
    let forge = FakeForge::counting(60_000);
    cache.get("k", &forge.options()).await.unwrap();
    clock.advance(61_000).await;
    let (first, second) = (forge.options(), forge.options());
    let (one, two) = tokio::join!(cache.get("k", &first), cache.get("k", &second));
    assert!(one.unwrap().stale && two.unwrap().stale);
    settle().await;
    assert_eq!(forge.reads(), 2);
    assert_eq!(cache.peek("k").unwrap().value.value, json!("v2"));
}

#[test]
fn the_ttl_follows_the_state_running_short_open_at_rest_longer_settled_longest() {
    let s = normalize_mr_cache_settings(None);
    let card = |request: Value, ci: Option<&str>| json!({"state": "ready", "root": "/r", "branch": "b", "remotes": [], "refreshedAt": "", "request": request, "ci": ci});
    let open = json!({"state": "opened"});
    assert_eq!(
        card_answer_ttl(&card(open.clone(), Some("running")), &s),
        s.running_ms
    );
    assert_eq!(card_answer_ttl(&card(open, Some("success")), &s), s.open_ms);
    assert_eq!(
        card_answer_ttl(&card(json!({"state": "merged"}), None), &s),
        s.settled_ms
    );
    for (state, ttl) in [
        ("no_match", s.none_ms),
        ("unauthenticated", s.unavailable_ms),
        ("error", 0),
    ] {
        let mut status = card(Value::Null, None);
        status["state"] = json!(state);
        assert_eq!(card_answer_ttl(&status, &s), ttl, "{state}");
    }
    let chip = |request: Value| json!({"ref": {"provider": "gitlab", "host": "h", "project": "p/q", "number": 1}, "state": "ready", "fetchedAt": "", "request": request});
    assert_eq!(
        forge_cache_ttl(
            &chip(json!({"state": "open", "pipeline": {"status": "running"}})),
            &s
        ),
        s.running_ms
    );
    assert_eq!(
        forge_cache_ttl(
            &chip(json!({"state": "open", "pipeline": {"status": "failed"}})),
            &s
        ),
        s.open_ms
    );
    assert_eq!(
        forge_cache_ttl(&chip(json!({"state": "merged"})), &s),
        s.settled_ms
    );
    assert!(s.running_ms < s.open_ms && s.open_ms < s.settled_ms);
}

#[tokio::test]
async fn every_surface_asking_at_once_shares_one_read() {
    let (_, cache, _) = setup();
    let forge = FakeForge::counting(60_000);
    let options = forge.options();
    let answers = futures_util::future::join_all((0..5).map(|_| cache.get("k", &options))).await;
    assert!(
        answers
            .iter()
            .all(|a| a.as_ref().unwrap().value.value == json!("v1"))
    );
    assert_eq!(forge.reads(), 1);
}

#[tokio::test]
async fn a_negative_lookup_is_cached_then_read_again_after_a_commit_and_at_once_on_another_branch()
{
    let (clock, cache, _) = setup();
    let forge = FakeForge::new(|n| {
        Loaded::kept(
            json!(["", "no MR", "MR opened", "other branch"][n]),
            15 * 60_000,
        )
    });
    let ask = |head: &str| {
        let options = forge.options_with(false, Some(Some(head.to_owned())), 0);
        let cache = cache.clone();
        async move { cache.get("card", &options).await.unwrap() }
    };
    assert_eq!(
        ask("refs/heads/feature\nabc").await.value.value,
        json!("no MR")
    );
    clock.advance(60_000).await;
    assert_eq!(
        ask("refs/heads/feature\nabc").await.value.value,
        json!("no MR")
    );
    assert_eq!(forge.reads(), 1);
    // A new commit on the branch: the answer shows, a read follows.
    let answer = ask("refs/heads/feature\ndef").await;
    assert_eq!(answer.value.value, json!("no MR"));
    assert!(answer.stale);
    settle().await;
    assert_eq!(cache.peek("card").unwrap().value.value, json!("MR opened"));
    // Another branch in the checkout never gets the first one's answer.
    assert_eq!(
        ask("refs/heads/other\n123").await.value.value,
        json!("other branch")
    );
}

#[tokio::test]
async fn a_failed_read_keeps_the_answer_and_waits_before_the_next_one() {
    let (clock, cache, _) = setup();
    let forge = FakeForge::new(|n| Loaded {
        value: json!(format!("v{n}")),
        ttl_ms: 60_000,
        failed: n == 2,
        paused_until: None,
    });
    cache.get("k", &forge.options()).await.unwrap();
    clock.advance(61_000).await;
    cache.get("k", &forge.options()).await.unwrap();
    settle().await;
    assert_eq!(forge.reads(), 2);
    assert_eq!(cache.peek("k").unwrap().value.value, json!("v1"));
    // Within the backoff (30 s): no read.
    clock.advance(10_000).await;
    cache.get("k", &forge.options()).await.unwrap();
    settle().await;
    assert_eq!(forge.reads(), 2);
    clock.advance(30_000).await;
    cache.get("k", &forge.options()).await.unwrap();
    settle().await;
    assert_eq!(forge.reads(), 3);
    assert_eq!(cache.peek("k").unwrap().value.value, json!("v3"));
}

#[tokio::test]
async fn a_forge_that_asked_to_be_left_alone_is_not_read_before_its_pause() {
    let (clock, cache, _) = setup();
    let forge = FakeForge::counting(60_000);
    cache.get("k", &forge.options()).await.unwrap();
    clock.advance(61_000).await;
    let paused = clock.now() + 120_000;
    cache
        .get("k", &forge.options_with(false, None, paused))
        .await
        .unwrap();
    settle().await;
    assert_eq!(forge.reads(), 1);
    clock.advance(121_000).await;
    cache
        .get("k", &forge.options_with(false, None, paused))
        .await
        .unwrap();
    settle().await;
    assert_eq!(forge.reads(), 2);
}

#[tokio::test]
async fn background_reads_stay_within_the_budget_per_minute() {
    let (clock, cache, _) = setup();
    cache.set_settings(normalize_mr_cache_settings(Some(
        &json!({"budget_per_minute": 2}),
    )));
    let forge = FakeForge::counting(5_000);
    for key in ["a", "b", "c"] {
        cache.get(key, &forge.options()).await.unwrap();
    }
    assert_eq!(forge.reads(), 3);
    clock.advance(61_000).await;
    for key in ["a", "b", "c"] {
        cache.get(key, &forge.options()).await.unwrap();
    }
    settle().await;
    assert_eq!(forge.reads(), 5);
}

#[tokio::test]
async fn a_click_on_refresh_reads_at_once_for_that_key_only() {
    let (_, cache, _) = setup();
    let forge = FakeForge::counting(60_000);
    cache.get("a", &forge.options()).await.unwrap();
    cache.get("b", &forge.options()).await.unwrap();
    let answer = cache
        .get("a", &forge.options_with(true, None, 0))
        .await
        .unwrap();
    assert_eq!(answer.value.value, json!("v3"));
    assert!(!answer.stale);
    assert_eq!(
        cache.get("b", &forge.options()).await.unwrap().value.value,
        json!("v2")
    );
    assert_eq!(forge.reads(), 3);
}

#[tokio::test]
async fn a_failed_refresh_does_not_take_the_known_answer_away() {
    let (_, cache, _) = setup();
    let forge = FakeForge::new(|n| Loaded {
        value: json!(format!("v{n}")),
        ttl_ms: 60_000,
        failed: n == 2,
        paused_until: None,
    });
    cache.get("k", &forge.options()).await.unwrap();
    let answer = cache
        .get("k", &forge.options_with(true, None, 0))
        .await
        .unwrap();
    assert_eq!(answer.value.value, json!("v1"));
    assert!(answer.stale);
}

#[tokio::test]
async fn an_invalidated_key_is_read_again() {
    let (_, cache, _) = setup();
    let forge = FakeForge::counting(60_000);
    cache.get("k", &forge.options()).await.unwrap();
    cache.invalidate(|key| key == "k");
    assert_eq!(
        cache.get("k", &forge.options()).await.unwrap().value.value,
        json!("v2")
    );
}

#[tokio::test]
async fn answers_survive_a_restart_and_a_cap_forgets_the_oldest() {
    let dir = tempfile::tempdir().unwrap();
    let path = mr_cache_path(dir.path());
    let clock = TestClock::new(1_000_000);
    let persist = || Persist {
        context: DataContext::new(dir.path(), Platform::current(), None),
        path: path.clone(),
        may_write: Arc::new(|| true),
        delay: Duration::ZERO,
    };
    let forge = FakeForge::counting(60_000);
    let first = MrCache::open(Arc::new(clock.clone()), Some(persist()), None);
    first.get("k", &forge.options()).await.unwrap();
    first.flush().await;
    clock.advance(1000).await;
    let second = MrCache::open(Arc::new(clock.clone()), Some(persist()), None);
    let answer = second.get("k", &forge.options()).await.unwrap();
    assert_eq!(answer.value.value, json!("v1"));
    assert!(!answer.stale);
    assert_eq!(forge.reads(), 1);

    let (clock, small, _) = setup();
    small.set_settings(normalize_mr_cache_settings(Some(
        &json!({"max_entries": 50}),
    )));
    for i in 0..60 {
        clock.advance(1).await;
        small.get(&format!("k{i}"), &forge.options()).await.unwrap();
    }
    assert_eq!(small.len(), 50);
    assert!(small.peek("k0").is_none());
    assert!(small.peek("k59").is_some());
}

#[test]
fn settings_seconds_bounded_defaults_for_what_is_invalid() {
    let s = normalize_mr_cache_settings(Some(&json!({
        "running_seconds": 30, "open_seconds": "soon", "budget_per_minute": 0, "max_entries": 200
    })));
    assert_eq!(s.running_ms, 30_000);
    assert_eq!(s.open_ms, DEFAULT_MR_CACHE_SETTINGS.open_ms);
    assert_eq!(
        s.budget_per_minute,
        DEFAULT_MR_CACHE_SETTINGS.budget_per_minute
    );
    assert_eq!(s.max_entries, 200);
}

#[test]
fn a_chip_a_card_and_a_session_are_pushed_nothing_else() {
    let status = json!({"ref": {}, "state": "ready"});
    assert_eq!(
        mr_cache_push("chip\0h\0r", &status, 5),
        Some(json!({"kind": "status", "status": status}))
    );
    let card = json!({"state": "ready", "root": "/r", "branch": "b"});
    assert_eq!(
        mr_cache_push("card\0x", &card, 5),
        Some(json!({"kind": "card", "status": card, "fetchedAt": "1970-01-01T00:00:00.005Z"}))
    );
    let session = json!({"repos": []});
    assert_eq!(
        mr_cache_push("session\0x", &session, 5),
        Some(json!({"kind": "session", "session": session}))
    );
    assert_eq!(mr_cache_push("other", &json!({}), 5), None);
}

#[test]
fn the_file_reads_as_bun_writes_it_and_back() {
    let text = "{\"version\":1,\"entries\":[[\"card\\u0000x\",{\"value\":{\"state\":\"ready\"},\"fetchedAt\":5,\"ttlMs\":60000,\"head\":\"refs/heads/a\\nabc\"}],[\"bad\",{\"value\":1,\"fetchedAt\":\"x\",\"ttlMs\":1}],[\"chip\\u0000h\\u0000r\",{\"value\":null,\"fetchedAt\":7,\"ttlMs\":1000}]]}\n";
    let entries = parse_state(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].1.head.as_deref(), Some("refs/heads/a\nabc"));
    assert_eq!(
        state_json(&entries),
        text.replace(
            ",[\"bad\",{\"value\":1,\"fetchedAt\":\"x\",\"ttlMs\":1}]",
            ""
        )
    );
    assert!(parse_state("{broken").is_empty());
    assert_eq!(iso_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
}

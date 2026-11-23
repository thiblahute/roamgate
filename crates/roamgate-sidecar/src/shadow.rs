//! Shadow reads (contract/wire/core-channel.md, Shadow reads): which
//! eligible calls are shadowed, the comparison, and the log of differences.
//! The front does this; in stage 1 the front is Bun, so the Rust side's is
//! for stage 2 and is exercised by its tests until then.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, timeout};
use roamgate_base::log::iso_millis;
use serde_json::{Value, json};

use crate::peer::BoxFuture;
use crate::protocol::{RpcError, ShadowSettings, shadow_diff};

/// At most one shadow call per method this often.
pub const PER_METHOD_MS: i64 = 5_000;
/// At most this many shadow calls at a time.
pub const MAX_IN_FLIGHT: usize = 2;
/// Params and results larger than this (as JSON) are not shadowed.
pub const MAX_JSON_BYTES: usize = 256 * 1024;
/// A shadow call abandoned after this long.
pub const SHADOW_TIMEOUT: Duration = Duration::from_secs(10);
/// GameMode is asked at most this often.
pub const GAME_CHECK_MS: i64 = 30_000;
/// The differences kept per call.
pub const DIFF_LIMIT: usize = 20;
/// shadow.jsonl is rotated past this size.
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Whether a game runs: Some(true) yes, None cannot tell.
pub type GameProbe = Arc<dyn Fn() -> BoxFuture<Option<bool>> + Send + Sync>;
/// A number in [0, 1).
pub type Random = Arc<dyn Fn() -> f64 + Send + Sync>;

/// The probe asking `gamemoded -s` (through host-spawn in a toolbox).
pub fn gamemoded_probe() -> GameProbe {
    Arc::new(|| {
        Box::pin(async {
            let runner = roamgate_exec::process::ProcessRunner::system();
            roamgate_exec::gamemode::game_mode_active(
                &runner,
                roamgate_exec::gamemode::default_game_mode_command(),
                roamgate_exec::gamemode::GAME_MODE_TIMEOUT,
            )
            .await
        })
    })
}

#[derive(Default)]
struct SamplerState {
    last_by_method: HashMap<String, i64>,
    in_flight: usize,
    /// The last answer and when it was asked.
    game: Option<(bool, i64)>,
}

/// Decides which eligible calls are shadowed.
#[derive(Clone)]
pub struct Sampler {
    clock: SharedClock,
    random: Random,
    game: GameProbe,
    state: Arc<Mutex<SamplerState>>,
}

/// A shadow call let through; it counts as in flight until dropped.
pub struct Permit {
    state: Arc<Mutex<SamplerState>>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.in_flight = state.in_flight.saturating_sub(1);
    }
}

impl Sampler {
    pub fn new(clock: SharedClock, random: Random, game: GameProbe) -> Self {
        Self {
            clock,
            random,
            game,
            state: Arc::default(),
        }
    }

    /// The production sampler: rand's numbers, gamemoded.
    pub fn system(clock: SharedClock) -> Self {
        Self::new(clock, Arc::new(rand::random::<f64>), gamemoded_probe())
    }

    async fn gaming(&self) -> bool {
        let now = self.clock.now();
        if let Some((active, at)) = self.state.lock().unwrap().game
            && now - at < GAME_CHECK_MS
        {
            return active;
        }
        let active = (self.game)().await.unwrap_or(false);
        self.state.lock().unwrap().game = Some((active, self.clock.now()));
        active
    }

    /// Whether to shadow this call: sampled at the table's rate, at most
    /// once per method every 5 s and 2 at a time, only cheap reads, never
    /// while a game runs.
    pub async fn admit(
        &self,
        method: &str,
        settings: ShadowSettings,
        params_bytes: usize,
        result_bytes: usize,
    ) -> Option<Permit> {
        if !settings.enabled || params_bytes > MAX_JSON_BYTES || result_bytes > MAX_JSON_BYTES {
            return None;
        }
        if (self.random)() >= settings.rate {
            return None;
        }
        {
            let state = self.state.lock().unwrap();
            if state.in_flight >= MAX_IN_FLIGHT {
                return None;
            }
            if let Some(last) = state.last_by_method.get(method)
                && self.clock.now() - last < PER_METHOD_MS
            {
                return None;
            }
        }
        if self.gaming().await {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        if state.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let now = self.clock.now();
        if let Some(last) = state.last_by_method.get(method)
            && now - last < PER_METHOD_MS
        {
            return None;
        }
        state.last_by_method.insert(method.to_owned(), now);
        state.in_flight += 1;
        Some(Permit {
            state: self.state.clone(),
        })
    }
}

/// `<data>/runtime/shadow.jsonl`, written by the front alone.
#[derive(Clone)]
pub struct ShadowLog {
    path: PathBuf,
    clock: SharedClock,
    lock: Arc<Mutex<()>>,
}

impl ShadowLog {
    pub fn new(path: PathBuf, clock: SharedClock) -> Self {
        Self {
            path,
            clock,
            lock: Arc::default(),
        }
    }

    /// Appends one record, rotating to `.1` past 5 MiB.
    pub fn append(&self, mut record: serde_json::Map<String, Value>) -> std::io::Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut line = serde_json::Map::new();
        line.insert("at".into(), iso_millis(self.clock.now()).into());
        line.append(&mut record);
        if std::fs::metadata(&self.path).is_ok_and(|meta| meta.len() > LOG_ROTATE_BYTES) {
            let mut rotated = self.path.clone().into_os_string();
            rotated.push(".1");
            std::fs::rename(&self.path, rotated)?;
        }
        if let Some(parent) = self.path.parent() {
            roamgate_base::private::create_private_dir(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        let mut text = serde_json::to_string(&Value::Object(line))?;
        text.push('\n');
        file.write_all(text.as_bytes())
    }
}

/// Runs one admitted shadow call and logs what differs: `other` is the
/// call to the side that did not answer, `owner_result` what the owner
/// answered. Returns the record written, if any.
pub async fn compare(
    clock: &SharedClock,
    log: &ShadowLog,
    family: &str,
    method: &str,
    owner: &str,
    owner_result: &Value,
    other: impl std::future::Future<Output = Result<Value, RpcError>>,
) -> Option<Value> {
    let record = match timeout(clock.as_ref(), SHADOW_TIMEOUT, other).await {
        Ok(Ok(theirs)) => {
            let diff = shadow_diff(owner_result, &theirs, DIFF_LIMIT);
            if diff.diffs.is_empty() {
                return None;
            }
            json!({"method": method, "family": family, "owner": owner, "diffs": diff.diffs, "truncated": diff.truncated})
        }
        Ok(Err(error)) => {
            json!({"method": method, "family": family, "owner": owner, "error": error.message})
        }
        Err(_) => {
            json!({"method": method, "family": family, "owner": owner, "error": "shadow call timed out"})
        }
    };
    tracing::warn!(scope = "shadow", method, family, record = %record, "[shadow] {method} differs");
    let Value::Object(map) = record.clone() else {
        return None;
    };
    if let Err(error) = log.append(map) {
        tracing::warn!(scope = "shadow", %error, "shadow.jsonl not written");
    }
    Some(record)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use roamgate_base::clock::TokioClock;

    use super::*;

    fn sampler(random: f64, game: Option<bool>, asked: Arc<AtomicUsize>) -> (Sampler, SharedClock) {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(1_000_000));
        let probe: GameProbe = Arc::new(move || {
            asked.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { game })
        });
        (
            Sampler::new(clock.clone(), Arc::new(move || random), probe),
            clock,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn samples_cheap_reads_spaced_and_bounded() {
        let asked = Arc::new(AtomicUsize::new(0));
        let (sampler, clock) = sampler(0.05, Some(false), asked.clone());
        let on = ShadowSettings::default();
        assert!(sampler.admit("a", on, 10, 10).await.is_some());
        // Five seconds per method.
        assert!(sampler.admit("a", on, 10, 10).await.is_none());
        let b = sampler.admit("b", on, 10, 10).await;
        assert!(b.is_some());
        let c = sampler.admit("c", on, 10, 10).await;
        assert!(c.is_some());
        // Two at a time.
        assert!(sampler.admit("d", on, 10, 10).await.is_none());
        drop(b);
        assert!(sampler.admit("d", on, 10, 10).await.is_some());
        // Off, too big, or not drawn.
        let off = ShadowSettings {
            enabled: false,
            rate: 1.0,
        };
        assert!(sampler.admit("e", off, 10, 10).await.is_none());
        assert!(
            sampler
                .admit("e", on, MAX_JSON_BYTES + 1, 10)
                .await
                .is_none()
        );
        let rare = ShadowSettings {
            enabled: true,
            rate: 0.01,
        };
        assert!(sampler.admit("e", rare, 10, 10).await.is_none());
        clock.sleep(Duration::from_millis(5_000)).await;
        drop(c);
        assert!(sampler.admit("a", on, 10, 10).await.is_some());
        // GameMode asked once for all of these: cached 30 s.
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn pauses_while_a_game_runs() {
        let asked = Arc::new(AtomicUsize::new(0));
        let (sampler, clock) = sampler(0.0, Some(true), asked.clone());
        let on = ShadowSettings::default();
        assert!(sampler.admit("a", on, 1, 1).await.is_none());
        assert!(sampler.admit("b", on, 1, 1).await.is_none());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        clock.sleep(Duration::from_millis(30_000)).await;
        assert!(sampler.admit("a", on, 1, 1).await.is_none());
        assert_eq!(asked.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn logs_differences_and_failures_and_rotates() {
        let root = tempfile::tempdir().unwrap();
        let clock: SharedClock = Arc::new(TokioClock::starting_at(1_767_225_600_000));
        let path = root.path().join("runtime").join("shadow.jsonl");
        let log = ShadowLog::new(path.clone(), clock.clone());
        let same = compare(
            &clock,
            &log,
            "work",
            "bridge.work.list",
            "bun",
            &json!({"a": 1}),
            async { Ok(json!({"a": 1})) },
        )
        .await;
        assert_eq!(same, None);
        assert!(!path.exists());
        let differs = compare(
            &clock,
            &log,
            "work",
            "bridge.work.list",
            "bun",
            &json!({"a": 1}),
            async { Ok(json!({"a": 2})) },
        )
        .await
        .unwrap();
        assert_eq!(differs["diffs"], json!([{"path": "$.a", "kind": "value"}]));
        let failed = compare(
            &clock,
            &log,
            "work",
            "bridge.work.board",
            "bun",
            &json!(null),
            async { Err(RpcError::new("boom")) },
        )
        .await
        .unwrap();
        assert_eq!(failed["error"], "boom");
        let slow = compare(
            &clock,
            &log,
            "work",
            "bridge.work.board",
            "bun",
            &json!(null),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(slow["error"], "shadow call timed out");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["at"], "2026-01-01T00:00:00.000Z");
        assert_eq!(lines[0]["method"], "bridge.work.list");
        // Past 5 MiB, the next record starts a new file.
        std::fs::write(&path, vec![b'x'; LOG_ROTATE_BYTES as usize + 1]).unwrap();
        log.append(serde_json::Map::from_iter([("method".into(), json!("m"))]))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
        assert!(root.path().join("runtime").join("shadow.jsonl.1").exists());
    }
}

//! One bounded, opt-in CPU capture of the server (utils/cpu-profile.ts,
//! `--profile`): a `roamgate-<random>` directory (0700) under the profile
//! directory gets `cpu.json` and `summary.txt` (0600, never overwritten)
//! when the duration ends or the server stops. It never opens a debugger or
//! a network endpoint. Bun samples with JSC's profiler; Rust samples its
//! threads with pprof's signal sampler on Unix (Linux and macOS). CPU time
//! and resident memory come from Linux's /proc only. Windows has no
//! sampler: the capture keeps its timing and a profile that says so.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use roamgate_base::log::{LogFields, Logger, iso_millis};
use serde_json::{Value, json};

/// Samples per second.
const FREQUENCY: i32 = 1000;

/// A running capture.
pub struct CpuProfile {
    release: mpsc::Sender<()>,
    done: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl CpuProfile {
    /// Ends the capture now and waits for its files; idempotent, also after
    /// it ended on its own.
    pub async fn stop(&self) {
        let _ = self.release.send(());
        let mut done = self.done.lock().await;
        if let Some(receiver) = done.take() {
            let _ = receiver.await;
        }
    }
}

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn write_new_private(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

/// The process's CPU time (user, system) in ms and resident bytes, where
/// the system tells them without unsafe code (Linux's /proc).
fn usage() -> (Option<(f64, f64)>, Option<u64>) {
    #[cfg(target_os = "linux")]
    {
        let ticks = rustix::param::clock_ticks_per_second() as f64;
        let cpu = std::fs::read_to_string("/proc/self/stat")
            .ok()
            .and_then(|stat| {
                // The fields after the command name, which may hold spaces.
                let rest = stat.rsplit_once(") ")?.1;
                let fields: Vec<&str> = rest.split(' ').collect();
                let user: f64 = fields.get(11)?.parse().ok()?;
                let system: f64 = fields.get(12)?.parse().ok()?;
                Some((user * 1000.0 / ticks, system * 1000.0 / ticks))
            });
        let rss = std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|statm| statm.split(' ').nth(1)?.parse::<u64>().ok())
            .map(|pages| pages * rustix::param::page_size() as u64);
        (cpu, rss)
    }
    #[cfg(not(target_os = "linux"))]
    {
        (None, None)
    }
}

/// What the sampler saw: `functions` (a text summary) and `stackTraces`.
#[cfg(unix)]
struct Sampler(pprof::ProfilerGuard<'static>);

#[cfg(unix)]
impl Sampler {
    fn start() -> Result<Self, String> {
        pprof::ProfilerGuardBuilder::default()
            .frequency(FREQUENCY)
            .blocklist(&["libc", "libgcc", "pthread", "vdso"])
            .build()
            .map(Self)
            .map_err(|error| error.to_string())
    }

    fn finish(self) -> Result<Value, String> {
        let report = self.0.report().build().map_err(|error| error.to_string())?;
        let mut traces: Vec<(Vec<String>, isize)> = report
            .data
            .iter()
            .map(|(frames, count)| {
                let names = frames
                    .frames
                    .iter()
                    .flat_map(|symbols| symbols.iter().map(|symbol| symbol.name()))
                    .collect();
                (names, *count)
            })
            .collect();
        traces.sort_by_key(|trace| std::cmp::Reverse(trace.1));
        Ok(profile_json(traces))
    }
}

#[cfg(not(unix))]
struct Sampler;

#[cfg(not(unix))]
impl Sampler {
    fn start() -> Result<Self, String> {
        Ok(Self)
    }

    fn finish(self) -> Result<Value, String> {
        let mut profile = profile_json(Vec::new());
        profile["functions"] =
            "CPU sampling is not available on Windows: this capture has its timing only.\n".into();
        Ok(profile)
    }
}

/// The profile: each stack (innermost first) with its sample count, and a
/// text summary of the functions most often on top.
fn profile_json(traces: Vec<(Vec<String>, isize)>) -> Value {
    let total: isize = traces.iter().map(|(_, count)| count).sum();
    let mut top: Vec<(String, isize)> = Vec::new();
    for (frames, count) in &traces {
        let Some(name) = frames.first() else { continue };
        match top.iter_mut().find(|(seen, _)| seen == name) {
            Some(entry) => entry.1 += count,
            None => top.push((name.clone(), *count)),
        }
    }
    top.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut functions = format!(
        "Sampling rate: {} microseconds. Total samples: {total}\nTop functions as <numSamples  'functionName'>:\n",
        1_000_000 / FREQUENCY
    );
    for (name, count) in top.iter().take(40) {
        functions.push_str(&format!("{count:>6}  '{name}'\n"));
    }
    json!({
        "functions": functions,
        "stackTraces": {
            "traces": traces
                .iter()
                .map(|(frames, count)| json!({ "frames": frames, "count": count }))
                .collect::<Vec<_>>(),
        },
    })
}

/// Starts a capture of `duration` into a new directory under `directory`;
/// fails, before sampling, when that directory is unusable.
pub fn start_cpu_profile(
    directory: &Path,
    duration: Duration,
    app_version: &str,
    logger: &Logger,
) -> std::io::Result<CpuProfile> {
    create_private_dir(directory)?;
    let output: PathBuf = tempfile::Builder::new()
        .prefix("roamgate-")
        .rand_bytes(6)
        .tempdir_in(directory)?
        .keep();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o700))?;
    }
    let (release, released) = mpsc::channel::<()>();
    let (finished, done) = tokio::sync::oneshot::channel();
    let started_at = iso_millis(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64),
    );
    let (cpu_start, _) = usage();
    let start = Instant::now();
    let sampler = Sampler::start();
    let logger_thread = logger.clone();
    let output_text = output.display().to_string();
    let directory_text = output_text.clone();
    let version = app_version.to_owned();
    std::thread::Builder::new()
        .name("cpu-profile".into())
        .spawn(move || {
            let _ = released.recv_timeout(duration);
            let result = sampler.and_then(Sampler::finish).and_then(|profile| {
                let (cpu, rss) = usage();
                let cpu_ms = match (cpu_start, cpu) {
                    (Some((user0, system0)), Some((user, system))) => {
                        json!({ "user": user - user0, "system": system - system0 })
                    }
                    _ => Value::Null,
                };
                let metrics = json!({
                    "appVersion": version,
                    "runtime": "rust",
                    "startedAt": started_at,
                    "elapsedMs": start.elapsed().as_secs_f64() * 1000.0,
                    "cpuMs": cpu_ms,
                    "rssBytes": rss,
                });
                let summary = format!(
                    "{}\n{}\n",
                    serde_json::to_string_pretty(&metrics).unwrap_or_default(),
                    profile["functions"].as_str().unwrap_or_default()
                );
                write_new_private(&output.join("cpu.json"), &profile.to_string())
                    .and_then(|()| write_new_private(&output.join("summary.txt"), &summary))
                    .map_err(|error| error.to_string())
            });
            match result {
                Ok(()) => logger_thread.info(
                    "CPU profile saved",
                    Some(&fields(&[("directory", directory_text.clone().into())])),
                ),
                Err(error) => logger_thread.error(
                    "CPU profile failed",
                    Some(&fields(&[
                        ("directory", directory_text.clone().into()),
                        ("error", error.into()),
                    ])),
                ),
            }
            let _ = finished.send(());
        })?;
    logger.info(
        "CPU profiling enabled",
        Some(&fields(&[
            ("directory", output_text.into()),
            ("seconds", json!(duration.as_secs_f64())),
            (
                "note",
                "sampling adds overhead; capture stops automatically".into(),
            ),
        ])),
    );
    Ok(CpuProfile {
        release,
        done: tokio::sync::Mutex::new(Some(done)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy(ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            std::hint::black_box(serde_json::to_string(&json!([1, 2, 3])).unwrap());
        }
    }

    fn entries(directory: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
    }

    /// The modes of utils/cpu-profile.test.ts: the timer ends it, stop
    /// ends it (twice), and a directory gone before the write is reported.
    #[tokio::test(flavor = "multi_thread")]
    async fn cpu_profile_timer_stop_and_write_error() {
        for mode in ["timer", "stop", "write-error"] {
            let scratch = tempfile::tempdir().unwrap();
            let directory = scratch.path().join("profiles");
            let duration = Duration::from_millis(if mode == "timer" { 100 } else { 30_000 });
            let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let sink = lines.clone();
            let logger = Logger::with(roamgate_base::log::LoggerOptions {
                stdout: Some(std::sync::Arc::new(move |line: &str| {
                    sink.lock().unwrap().push(line.to_owned())
                })),
                stderr: Some({
                    let sink = lines.clone();
                    std::sync::Arc::new(move |line: &str| {
                        sink.lock().unwrap().push(line.to_owned())
                    })
                }),
                ..Default::default()
            });
            let capture = start_cpu_profile(&directory, duration, "test", &logger).unwrap();
            busy(150);
            if mode == "write-error" {
                std::fs::remove_dir_all(&entries(&directory)[0]).unwrap();
            }
            capture.stop().await;
            capture.stop().await;
            let text = lines.lock().unwrap().join("\n");
            assert!(text.contains("CPU profiling enabled"), "{mode}: {text}");
            if mode == "write-error" {
                assert!(text.contains("CPU profile failed"), "{mode}: {text}");
                continue;
            }
            assert!(text.contains("CPU profile saved"), "{mode}: {text}");
            let folders = entries(&directory);
            assert_eq!(folders.len(), 1, "{mode}");
            let output = &folders[0];
            assert!(
                output
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("roamgate-")
            );
            let profile: Value =
                serde_json::from_str(&std::fs::read_to_string(output.join("cpu.json")).unwrap())
                    .unwrap();
            // Windows has no sampler: the capture says so.
            assert!(
                profile["functions"]
                    .as_str()
                    .unwrap()
                    .contains(if cfg!(unix) {
                        "Sampling rate:"
                    } else {
                        "CPU sampling is not available on Windows"
                    })
            );
            assert!(profile["stackTraces"]["traces"].is_array());
            let summary = std::fs::read_to_string(output.join("summary.txt")).unwrap();
            assert!(summary.contains("\"appVersion\": \"test\""));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode_of =
                    |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode_of(output), 0o700);
                assert_eq!(mode_of(&output.join("cpu.json")), 0o600);
                assert_eq!(mode_of(&output.join("summary.txt")), 0o600);
            }
        }
    }

    #[test]
    fn cpu_profile_rejects_an_unusable_output_directory_before_sampling() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("file");
        std::fs::write(&file, "occupied").unwrap();
        assert!(
            start_cpu_profile(&file, Duration::from_millis(100), "test", &Logger::silent())
                .is_err()
        );
    }
}

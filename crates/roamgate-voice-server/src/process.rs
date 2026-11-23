//! The helper's process (spawnVoiceHelper of voice-helper.ts): its
//! command line from voice.json, GStreamer's plugin path and registry
//! when `gst_prefix` is set, frames on its stdin and stdout, its stderr
//! the server's. A wrapped helper is stopped by closing its input, its
//! wrapper signalled only if it still runs WRAPPED_EXIT_MS later.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_protocol::frames::FrameReader;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use crate::config::{VoiceConfig, WRAPPED_EXIT_MS};
use crate::helper::{ErrorSink, HelperProcess, Spawned};

struct ChildProcess {
    input: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    pid: Option<u32>,
    wrapped: bool,
    exited: watch::Receiver<bool>,
}

#[cfg(unix)]
fn signal(pid: u32, kill: bool) {
    use rustix::process::{Pid, Signal, kill_process};
    if let Some(pid) = Pid::from_raw(pid as i32) {
        let _ = kill_process(pid, if kill { Signal::KILL } else { Signal::TERM });
    }
}

#[cfg(not(unix))]
fn signal(pid: u32, _kill: bool) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

impl HelperProcess for ChildProcess {
    fn write(&self, frame: Vec<u8>) {
        if let Some(input) = self
            .input
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_ref()
        {
            let _ = input.send(frame);
        }
    }

    fn kill(&self) {
        let Some(pid) = self.pid else {
            return;
        };
        if !self.wrapped {
            // Bun's `child.kill()`: SIGTERM.
            signal(pid, false);
            return;
        }
        // The helper ends at the end of its input; the wrapper is
        // signalled only if it still runs WRAPPED_EXIT_MS later.
        self.input
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        let mut exited = self.exited.clone();
        tokio::spawn(async move {
            let ended = tokio::time::timeout(
                Duration::from_millis(WRAPPED_EXIT_MS),
                exited.wait_for(|done| *done),
            )
            .await;
            if ended.is_err() {
                signal(pid, false);
            }
        });
    }

    fn pid(&self) -> Option<u32> {
        if self.wrapped { None } else { self.pid }
    }
}

/// Spawns the helper voice.json names; `data_root` holds GStreamer's
/// registry when `gst_prefix` is set.
pub fn spawn_voice_helper(
    config: &VoiceConfig,
    data_root: &Path,
    errors: ErrorSink,
) -> Result<Spawned, String> {
    let command = config.helper_command();
    let (program, args) = command.split_first().ok_or("no helper")?;
    let mut child = tokio::process::Command::new(program);
    child
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(false);
    if let Some(prefix) = config.str("gst_prefix").filter(|prefix| !prefix.is_empty()) {
        child.env(
            "GST_PLUGIN_SYSTEM_PATH",
            Path::new(prefix).join("lib").join("gstreamer-1.0"),
        );
        child.env("GST_REGISTRY", data_root.join("voice-gst-registry.bin"));
    }
    let mut child = child.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("Executable not found in $PATH: \"{program}\"")
        } else {
            error.to_string()
        }
    })?;
    let pid = child.id();
    if let (Some(nice), Some(pid)) = (config.yield_cpu_priority(), pid) {
        renice(pid, nice, &errors);
    }
    let mut stdin = child.stdin.take().ok_or("no helper input")?;
    let mut stdout = child.stdout.take().ok_or("no helper output")?;
    let (input, mut writes) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(frame) = writes.recv().await {
            if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
        // Dropped: the helper's input ends.
    });
    let (frames, received) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut reader = FrameReader::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = match stdout.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            for frame in reader.push(&buffer[..read]) {
                if frames.send(Ok(frame)).is_err() {
                    return;
                }
            }
            if let Some(error) = reader.error.take() {
                let _ = frames.send(Err(error));
                return;
            }
        }
    });
    let (done, exited) = watch::channel(false);
    tokio::spawn(async move {
        let _ = child.wait().await;
        let _ = done.send(true);
    });
    let wrapped = !config.helper_wrapper().is_empty();
    Ok(Spawned {
        process: Arc::new(ChildProcess {
            input: Mutex::new(Some(input)),
            pid,
            wrapped,
            exited: exited.clone(),
        }),
        frames: received,
        exited,
    })
}

/// Never higher than the server's own (an unprivileged process cannot
/// raise it).
#[cfg(unix)]
fn renice(pid: u32, nice: i32, errors: &ErrorSink) {
    use rustix::process::{Pid, getpriority_process, setpriority_process};
    let Some(target) = Pid::from_raw(pid as i32) else {
        return;
    };
    let result = getpriority_process(Some(target))
        .and_then(|current| setpriority_process(Some(target), nice.max(current)));
    if let Err(error) = result {
        errors(&format!(
            "[voice] the helper's priority was not lowered: {error}"
        ));
    }
}

#[cfg(not(unix))]
fn renice(_pid: u32, _nice: i32, _errors: &ErrorSink) {}

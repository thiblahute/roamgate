//! A connection's uploads (connections/runtime.ts `handleImageUpload`,
//! `handleTerminalUpload`): `/api/upload-image` and `/api/terminal-upload`
//! staged privately here (roamgate-http `terminal_upload`) and, on an SSH
//! connection, copied to its host through a held session slot; the expired
//! ones swept here and on the host every hour while the generation runs
//! (Unix hosts only).

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use roamgate_channel::family::FamilyContext;
use roamgate_channel::peer::{BodyReceiver, HttpResponse};
use roamgate_http::terminal_upload::{
    RemoteOutput, TerminalUploads, UploadConfig, UploadRemote, image_upload_config,
    terminal_upload_max_bytes, terminal_upload_retention_hours,
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use super::{call, logger, tell};

/// One generation's upload handlers and their sweeper (stopped with it).
pub(crate) struct Uploads {
    terminal: Arc<TerminalUploads>,
    image: Arc<TerminalUploads>,
    sweeper: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for Uploads {
    fn drop(&mut self) {
        if let Some(sweeper) = self.sweeper.take() {
            sweeper.abort();
        }
    }
}

/// The connection's SSH side, through the core's session slots.
struct ConnectionRemote {
    cx: FamilyContext,
    connection_id: String,
    ssh_host: Option<String>,
}

impl UploadRemote for ConnectionRemote {
    fn host(&self) -> Option<String> {
        self.ssh_host.clone()
    }

    fn run(
        &self,
        host: String,
        script: String,
        stdin: Option<PathBuf>,
        timeout: Duration,
        purpose: &'static str,
    ) -> roamgate_base::clock::BoxFuture<Result<RemoteOutput, String>> {
        let cx = self.cx.clone();
        let connection = self.connection_id.clone();
        Box::pin(async move {
            run_held(&cx, &connection, &host, &script, stdin, timeout, purpose).await
        })
    }
}

/// `sh -c <script>` on `host` in a held session slot (the wait counts
/// against `timeout`), its stdin the local file, killed (SIGKILL) when the
/// time is up or the request goes.
async fn run_held(
    cx: &FamilyContext,
    connection: &str,
    host: &str,
    script: &str,
    stdin: Option<PathBuf>,
    timeout: Duration,
    purpose: &'static str,
) -> Result<RemoteOutput, String> {
    let held = call(
        cx,
        "internal.host.ssh_hold",
        json!({
            "destination": host,
            "command": format!("sh -c {}", roamgate_exec::quote::shell_quote(script)),
            "tag": purpose,
            "connection_id": connection,
            "timeout_ms": timeout.as_millis() as u64,
        }),
    )
    .await
    .map_err(|error| error.message)?;
    let lease = held.get("lease").and_then(Value::as_u64).unwrap_or(0);
    let _release = Release {
        cx: cx.clone(),
        lease,
    };
    let argv: Vec<String> = held
        .get("argv")
        .and_then(Value::as_array)
        .map(|argv| {
            argv.iter()
                .filter_map(|part| part.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let remaining = held
        .get("remaining_ms")
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
        .unwrap_or(timeout);
    let Some((program, rest)) = argv.split_first() else {
        return Err("no SSH command to run".into());
    };
    let input = match &stdin {
        Some(path) => std::fs::File::open(path)
            .map(std::process::Stdio::from)
            .map_err(|error| error.to_string())?,
        None => std::process::Stdio::null(),
    };
    let mut child = tokio::process::Command::new(program)
        .args(rest)
        .stdin(input)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (_, _) = tokio::join!(
            async {
                if let Some(stdout) = &mut stdout {
                    let _ = stdout.read_to_end(&mut out).await;
                }
            },
            async {
                if let Some(stderr) = &mut stderr {
                    let _ = stderr.read_to_end(&mut err).await;
                }
            },
        );
        let status = child.wait().await;
        (status, out, err)
    };
    match tokio::time::timeout(remaining, read).await {
        Ok((status, out, err)) => {
            let status = status.map_err(|error| error.to_string())?;
            Ok(RemoteOutput {
                code: exit_code(status),
                stdout: String::from_utf8_lossy(&out).into_owned(),
                stderr: String::from_utf8_lossy(&err).into_owned(),
            })
        }
        // Bun's spawn timeout: killed, its exit the signal's.
        Err(_) => Ok(RemoteOutput {
            code: 137,
            stdout: String::new(),
            stderr: String::new(),
        }),
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

/// Gives a held session back when the run ends or is dropped.
struct Release {
    cx: FamilyContext,
    lease: u64,
}

impl Drop for Release {
    fn drop(&mut self) {
        tell(
            &self.cx,
            "internal.host.ssh_release",
            json!({"lease": self.lease}),
        );
    }
}

/// A generation's handlers; its sweeper started on a Unix host.
pub(crate) fn start(
    cx: &FamilyContext,
    connection_id: &str,
    ssh_host: Option<String>,
    windows: bool,
) -> Uploads {
    let remote: Arc<dyn UploadRemote> = Arc::new(ConnectionRemote {
        cx: cx.clone(),
        connection_id: connection_id.to_owned(),
        ssh_host,
    });
    let env = roamgate_base::env::ProcessEnv;
    let temp = std::env::temp_dir();
    let terminal = Arc::new(TerminalUploads::new(
        UploadConfig {
            max_bytes: terminal_upload_max_bytes(&env),
            retention_hours: terminal_upload_retention_hours(&env),
            ..UploadConfig::new(temp.clone())
        },
        remote.clone(),
        cx.clock.clone(),
    ));
    let image = Arc::new(TerminalUploads::new(
        UploadConfig {
            retention_hours: terminal_upload_retention_hours(&env),
            ..image_upload_config(temp)
        },
        remote,
        cx.clock.clone(),
    ));
    let sweeper = (!windows).then(|| {
        let log = logger(&cx.clock, "bridge");
        let connection = connection_id.to_owned();
        terminal.start_cleanup(move |error| {
            log.warn(
                "terminal upload cleanup failed",
                Some(&super::fields(json!({
                    "connection": connection,
                    "error": roamgate_connections::manager::sanitize_connection_error(&error),
                }))),
            );
        })
    });
    Uploads {
        terminal,
        image,
        sweeper,
    }
}

/// The request body as the handlers read it.
fn body_stream(
    body: BodyReceiver,
) -> impl futures_util::Stream<Item = Result<Bytes, Infallible>> + Unpin {
    Box::pin(futures_util::stream::unfold(body, |mut body| async move {
        body.chunk()
            .await
            .map(|chunk| (Ok(Bytes::from(chunk)), body))
    }))
}

fn channel_response(response: roamgate_http::response::Response) -> HttpResponse {
    let (parts, body) = response.into_parts();
    let headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let _ = tx.try_send(body.to_vec());
    HttpResponse {
        status: parts.status.as_u16(),
        headers,
        body: Some(rx),
    }
}

/// `upload-image` (`image`) or `terminal-upload` of a generation.
pub(crate) async fn handle(
    uploads: &Uploads,
    image: bool,
    body: Option<BodyReceiver>,
    filename: Option<&str>,
    image_ext: Option<&str>,
) -> HttpResponse {
    let body = body.map(body_stream);
    let response = if image {
        uploads.image.handle_image(body, image_ext).await
    } else {
        uploads.terminal.handle(body, filename).await
    };
    channel_response(response)
}

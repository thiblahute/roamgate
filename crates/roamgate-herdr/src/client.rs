//! The Herdr control socket's one-shot request (bridge/herdr-client
//! `request`): connect, write one NDJSON request, read one response line,
//! close. The start of roamgate-herdr's client; setup and status only ping.

use std::time::Duration;

use rand::Rng;
use roamgate_base::clock::{Clock, SharedClock, timeout};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// The longest response line read (1 MiB).
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// A control socket path as the platform opens it: a Windows path that is
/// not already a pipe becomes `\\.\pipe\<path>` (config nativeSocketPath).
pub fn native_socket_path(path: &str, platform: &str) -> String {
    let lower = path.to_lowercase();
    if platform != "win32"
        || lower.starts_with("\\\\.\\pipe\\")
        || lower.starts_with("\\\\?\\pipe\\")
    {
        return path.to_owned();
    }
    format!("\\\\.\\pipe\\{path}")
}

pub(crate) fn request_id(clock: &dyn Clock) -> String {
    let now = clock.now().max(0) as u64;
    let mut rng = rand::rng();
    let suffix: String = (0..4)
        .map(|_| char::from_digit(rng.random_range(0..36), 36).unwrap())
        .collect();
    format!("r_{}_{suffix}", radix36(now))
}

fn radix36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(char::from_digit((value % 36) as u32, 36).unwrap());
        value /= 36;
    }
    digits.iter().rev().collect()
}

/// The base-36 time an id starts with now (tests size request lines).
#[cfg(all(test, unix))]
pub(crate) fn radix36_now_for_tests() -> String {
    radix36(roamgate_base::clock::Clock::now(&roamgate_base::clock::SystemClock) as u64)
}

/// The result of an answer line, or why it is not one.
pub(crate) fn read_answer(line: &str, id: &str) -> Result<Value, String> {
    let line = line.trim();
    let message: Value =
        serde_json::from_str(line).map_err(|_| "bad JSON from Herdr".to_owned())?;
    let Value::Object(envelope) = message else {
        return Err("invalid response envelope from Herdr".into());
    };
    let has_result = envelope.contains_key("result");
    let has_error = envelope.contains_key("error");
    let invalid = envelope.get("id").and_then(Value::as_str) != Some(id)
        || has_result == has_error
        || (has_error && !envelope.get("error").is_some_and(Value::is_object));
    if invalid {
        return Err("invalid response envelope from Herdr".into());
    }
    if has_error {
        let error = envelope
            .get("error")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Herdr request failed");
        return Err(format!("{code}: {message}"));
    }
    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
}

async fn exchange<S>(stream: S, request: String, id: &str) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    writer
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(reader.take(MAX_LINE_BYTES as u64 + 2));
    let mut line = Vec::new();
    let read = reader
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| error.to_string())?;
    if read == 0 {
        return Err("Herdr closed the connection".into());
    }
    if line.last() != Some(&b'\n') && line.len() > MAX_LINE_BYTES {
        return Err("Herdr response line is too large".into());
    }
    let text = String::from_utf8_lossy(&line);
    if text.trim().len() > MAX_LINE_BYTES {
        return Err("Herdr response line is too large".into());
    }
    read_answer(&text, id)
}

/// Why the socket at `path` could not be reached, in the TS client's words:
/// Bun.connect's `<CODE>: Failed to connect` on Unix, node:net's
/// `connect <CODE> <path>` on Windows' named pipes.
pub fn connect_error(error: &std::io::Error, path: &str) -> String {
    use std::io::ErrorKind;
    let code = match error.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::ConnectionRefused => "ECONNREFUSED",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::TimedOut => "ETIMEDOUT",
        _ => return error.to_string(),
    };
    if cfg!(windows) {
        format!("connect {code} {path}")
    } else {
        format!("{code}: Failed to connect")
    }
}

/// One request to the control socket at `path`, answered within
/// `limit` (8 s for a ping).
pub async fn request(
    clock: &SharedClock,
    path: &str,
    method: &str,
    params: Map<String, Value>,
    limit: Duration,
) -> Result<Value, String> {
    let id = request_id(clock.as_ref());
    let request = format!(
        "{}\n",
        json!({"id": id, "method": method, "params": params})
    );
    let work = async {
        #[cfg(unix)]
        {
            let stream = tokio::net::UnixStream::connect(path)
                .await
                .map_err(|error| connect_error(&error, path))?;
            exchange(stream, request, &id).await
        }
        #[cfg(windows)]
        {
            let stream = roamgate_base::local_socket::connect_pipe(path)
                .await
                .map_err(|error| connect_error(&error, path))?;
            exchange(stream, request, &id).await
        }
    };
    timeout(clock.as_ref(), limit, work)
        .await
        .unwrap_or_else(|_| Err(format!("timeout: {method}")))
}

/// `ping`: the server's identity (`version`, `protocol`, ...).
pub async fn ping(clock: &SharedClock, path: &str) -> Result<Value, String> {
    request(clock, path, "ping", Map::new(), Duration::from_millis(8000)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As `new HerdrClient(path).call("ping")` rejects in Bun.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_socket_that_is_missing_or_refuses_fails_as_buns_client_does() {
        let scratch = tempfile::tempdir().unwrap();
        let clock: SharedClock = std::sync::Arc::new(roamgate_base::clock::SystemClock);
        let missing = scratch.path().join("none");
        assert_eq!(
            ping(&clock, &missing.display().to_string()).await,
            Err("ENOENT: Failed to connect".into())
        );
        let dead = scratch.path().join("dead");
        drop(std::os::unix::net::UnixListener::bind(&dead).unwrap());
        assert_eq!(
            ping(&clock, &dead.display().to_string()).await,
            Err("ECONNREFUSED: Failed to connect".into())
        );
    }

    #[test]
    fn reads_answers_and_refuses_what_is_not_one() {
        assert_eq!(
            read_answer(r#"{"id":"a","result":{"x":1}}"#, "a"),
            Ok(json!({"x": 1}))
        );
        assert_eq!(
            read_answer(r#"{"id":"a","error":{"code":"nope","message":"no"}}"#, "a"),
            Err("nope: no".into())
        );
        assert_eq!(read_answer("{", "a"), Err("bad JSON from Herdr".into()));
        for bad in [
            r#"{"id":"b","result":1}"#,
            r#"{"id":"a"}"#,
            r#"[1]"#,
            r#"{"id":"a","error":"x"}"#,
        ] {
            assert_eq!(
                read_answer(bad, "a"),
                Err("invalid response envelope from Herdr".into()),
                "{bad}"
            );
        }
        assert_eq!(native_socket_path("herdr", "win32"), "\\\\.\\pipe\\herdr");
        assert_eq!(native_socket_path("/a.sock", "linux"), "/a.sock");
        assert_eq!(radix36(35), "z");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pings_a_control_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("herdr.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = tokio::io::split(stream);
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "ping");
            let answer =
                json!({"id": request["id"], "result": {"version": "0.9.4", "protocol": 22}});
            writer
                .write_all(format!("{answer}\n").as_bytes())
                .await
                .unwrap();
        });
        let clock: SharedClock = std::sync::Arc::new(roamgate_base::clock::SystemClock);
        assert_eq!(
            ping(&clock, path.to_str().unwrap()).await,
            Ok(json!({"version": "0.9.4", "protocol": 22}))
        );
        assert!(
            ping(&clock, dir.path().join("none.sock").to_str().unwrap())
                .await
                .is_err()
        );
    }
}

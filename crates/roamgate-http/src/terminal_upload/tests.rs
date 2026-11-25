//! http/terminal-upload.test.ts and http/image-upload.test.ts, case for case.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::stream::{self, BoxStream};

use super::*;
use crate::test_support::{ManualClock, NOW, shared};

type Body = BoxStream<'static, Result<Bytes, String>>;

fn chunks(parts: &[&[u8]]) -> Option<Body> {
    let parts: Vec<Result<Bytes, String>> = parts
        .iter()
        .map(|part| Ok(Bytes::copy_from_slice(part)))
        .collect();
    Some(stream::iter(parts).boxed())
}

fn uploads(temp: &Path, configure: impl FnOnce(&mut UploadConfig)) -> TerminalUploads {
    let mut config = UploadConfig::new(temp.to_owned());
    config.windows = false;
    configure(&mut config);
    TerminalUploads::new(config, Arc::new(LocalOnly), shared(&ManualClock::at(NOW)))
}

fn real_clock() -> SharedClock {
    Arc::new(roamgate_base::clock::SystemClock)
}

fn json(response: &Response) -> serde_json::Value {
    serde_json::from_slice(response.body()).unwrap()
}

fn age(path: &Path, hours: u64) {
    let old = std::time::SystemTime::now() - Duration::from_secs(hours * 3600);
    filetime::set_file_mtime(path, filetime::FileTime::from_system_time(old)).unwrap();
}

fn listing(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn sanitizes_terminal_filenames() {
    for (input, expected) in [
        ("../../secret.txt".to_owned(), "secret.txt".to_owned()),
        ("C:\\dir\\some file.txt".into(), "some_file.txt".into()),
        ("'$(touch x)'.sh".into(), "___touch_x__.sh".into()),
        ("line\nname \u{fc}.txt".into(), "line_name__.txt".into()),
        (
            format!("{}.md", "a".repeat(150)),
            format!("{}.md", "a".repeat(117)),
        ),
    ] {
        assert_eq!(
            sanitize_terminal_upload_name(&input, false),
            expected,
            "{input:?}"
        );
    }
}

#[test]
fn keeps_windows_upload_names_usable() {
    for (input, expected) in [
        ("CON.txt", "_CON.txt"),
        ("nul.tar.gz", "_nul.tar.gz"),
        ("COM1.log", "_COM1.log"),
        ("LPT9", "_LPT9"),
        ("report.", "report"),
        ("normal.txt", "normal.txt"),
    ] {
        assert_eq!(
            sanitize_terminal_upload_name(input, true),
            expected,
            "{input}"
        );
    }
}

#[tokio::test]
async fn streams_a_file_to_a_private_directory_and_retains_an_empty_file() {
    let temp = tempfile::tempdir().unwrap();
    let handler = uploads(temp.path(), |_| {});
    let response = handler
        .handle(chunks(&[b"hel", b"lo"]), Some("a file.txt"))
        .await;
    assert_eq!(response.status(), 200);
    let body = json(&response);
    let path = PathBuf::from(body["path"].as_str().unwrap());
    assert_eq!(path.file_name().unwrap(), "a_file.txt");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    assert_eq!(body["remote"], false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(handler.root()), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
    let empty = handler.handle(chunks(&[]), Some("empty.txt")).await;
    assert_eq!(empty.status(), 200);
    assert_eq!(
        Path::new(json(&empty)["path"].as_str().unwrap()).file_name(),
        Some("empty.txt".as_ref())
    );
    assert_eq!(handler.handle(chunks(&[]), None).await.status(), 400);
    assert_eq!(handler.handle(None::<Body>, Some("x")).await.status(), 400);
}

#[tokio::test]
async fn size_cap_removes_the_partial_file() {
    let temp = tempfile::tempdir().unwrap();
    let handler = uploads(temp.path(), |config| config.max_bytes = 3);
    let response = handler
        .handle(chunks(&[b"123", b"4"]), Some("too-big.txt"))
        .await;
    assert_eq!(response.status(), 413);
    assert_eq!(json(&response)["error"], "file too large (>3 bytes)");
    assert!(listing(handler.root()).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_a_symlinked_root_and_sweeps_expired_uploads() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = UploadConfig::new(temp.path().to_owned());
    config.retention_hours = 1;
    let handler = TerminalUploads::new(config, Arc::new(LocalOnly), real_clock());
    let first = json(&handler.handle(chunks(&[b"old"]), Some("old.txt")).await);
    let first = PathBuf::from(first["path"].as_str().unwrap());
    age(first.parent().unwrap(), 2);
    handler.handle(chunks(&[b"new"]), Some("new.txt")).await;
    assert!(!first.exists());

    std::fs::remove_dir_all(handler.root()).unwrap();
    std::os::unix::fs::symlink(temp.path(), handler.root()).unwrap();
    assert_eq!(
        handler
            .handle(chunks(&[b"blocked"]), Some("blocked.txt"))
            .await
            .status(),
        500
    );
    assert_eq!(
        listing(temp.path()),
        [handler
            .root()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()]
    );
}

#[tokio::test]
async fn sweeps_expired_uploads_at_startup_and_without_a_later_upload() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = UploadConfig::new(temp.path().to_owned());
    config.retention_hours = 1;
    let handler = Arc::new(TerminalUploads::new(
        config,
        Arc::new(LocalOnly),
        real_clock(),
    ));
    let first = json(&handler.handle(chunks(&[b"first"]), Some("first.txt")).await);
    let first = PathBuf::from(first["path"].as_str().unwrap());
    age(first.parent().unwrap(), 2);
    let errors = Arc::new(Mutex::new(Vec::new()));
    let seen = errors.clone();
    let task = handler.start_cleanup(move |error| seen.lock().unwrap().push(error));
    for _ in 0..200 {
        if !first.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!first.exists());
    let second = json(
        &handler
            .handle(chunks(&[b"second"]), Some("second.txt"))
            .await,
    );
    let second = PathBuf::from(second["path"].as_str().unwrap());
    age(second.parent().unwrap(), 2);
    handler.sweep_expired().await.unwrap();
    assert!(!second.exists());
    task.abort();
    assert!(errors.lock().unwrap().is_empty());
}

#[cfg(unix)]
fn run_script(script: &str, tmpdir: &str, stdin: &[u8]) -> (i32, String, String) {
    use std::process::{Command, Stdio};
    let mut child = Command::new("sh")
        .args(["-c", script])
        .env("TMPDIR", tmpdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[cfg(unix)]
#[test]
fn remote_scripts_create_a_private_staged_file_and_sweep_it_later() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let tmpdir = temp.path().to_str().unwrap();
    let (code, path, stderr) = run_script(
        &remote_terminal_upload_script("a_file.txt", 60),
        tmpdir,
        b"remote bytes",
    );
    assert_eq!(code, 0);
    assert_eq!(stderr, "");
    let path = PathBuf::from(path);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "remote bytes");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    age(path.parent().unwrap(), 2);
    let (code, _, _) = run_script(&remote_terminal_cleanup_script(60), tmpdir, b"");
    assert_eq!(code, 0);
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn the_remote_script_s_path_has_no_doubled_slash_when_tmpdir_ends_with_one() {
    let temp = tempfile::tempdir().unwrap();
    let tmpdir = temp.path().to_str().unwrap();
    let (code, path, _) = run_script(
        &remote_terminal_upload_script("img-1-a.png", 60),
        &format!("{tmpdir}//"),
        b"png",
    );
    assert_eq!(code, 0);
    assert!(path.starts_with(&format!("{tmpdir}/roamgate-uploads-")));
    assert!(!path.contains("//"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "png");
}

#[tokio::test]
async fn a_failed_request_stream_removes_the_partial_upload() {
    let temp = tempfile::tempdir().unwrap();
    let handler = uploads(temp.path(), |_| {});
    let failing: Body = stream::iter([
        Ok(Bytes::from_static(b"partial")),
        Err("client disconnected".to_owned()),
    ])
    .boxed();
    let response = handler.handle(Some(failing), Some("interrupted.txt")).await;
    assert_eq!(response.status(), 500);
    assert_eq!(json(&response)["error"], "client disconnected");
    assert!(listing(handler.root()).is_empty());
}

#[tokio::test]
async fn uploads_honor_a_configured_cap_above_the_default_body_limit() {
    let env: HashMap<String, String> = [(
        "ROAMGATE_UPLOAD_MAX_BYTES".to_owned(),
        (140 * 1024 * 1024).to_string(),
    )]
    .into();
    assert_eq!(terminal_upload_max_bytes(&env), 140 * 1024 * 1024);
    assert_eq!(terminal_upload_request_body_limit(&env), 140 * 1024 * 1024);
    let temp = tempfile::tempdir().unwrap();
    let handler = uploads(temp.path(), |config| {
        config.max_bytes = terminal_upload_max_bytes(&env)
    });
    let megabyte = vec![0u8; 1024 * 1024];
    let parts: Vec<Result<Bytes, String>> = (0..129)
        .map(|_| Ok(Bytes::from(megabyte.clone())))
        .collect();
    let response = handler
        .handle(Some(stream::iter(parts).boxed()), Some("large.bin"))
        .await;
    assert_eq!(response.status(), 200);
    let path = PathBuf::from(json(&response)["path"].as_str().unwrap().to_owned());
    assert_eq!(std::fs::metadata(path).unwrap().len(), 129 * 1024 * 1024);
    for value in ["1", "0", "-3", "1.5", "abc", ""] {
        let env: HashMap<String, String> =
            [("ROAMGATE_UPLOAD_MAX_BYTES".to_owned(), value.to_owned())].into();
        assert_eq!(
            terminal_upload_request_body_limit(&env),
            128 * 1024 * 1024,
            "{value:?}"
        );
    }
    let unset: HashMap<String, String> = HashMap::new();
    assert_eq!(terminal_upload_max_bytes(&unset), DEFAULT_MAX_BYTES);
    assert_eq!(
        terminal_upload_retention_hours(&unset),
        DEFAULT_RETENTION_HOURS
    );
}

/// An SSH side that hangs until dropped, noting that it was.
struct Hanging {
    started: tokio::sync::Notify,
    dropped: Arc<AtomicBool>,
}

impl UploadRemote for Hanging {
    fn host(&self) -> Option<String> {
        Some("test-host".into())
    }
    fn run(
        &self,
        _host: String,
        _script: String,
        _stdin: Option<PathBuf>,
        timeout: Duration,
        _purpose: &'static str,
    ) -> BoxFuture<Result<RemoteOutput, String>> {
        struct Kill(Arc<AtomicBool>);
        impl Drop for Kill {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let kill = Kill(self.dropped.clone());
        self.started.notify_one();
        Box::pin(async move {
            let _kill = kill;
            tokio::time::sleep(timeout).await;
            Err(format!("timed out after {}ms", timeout.as_millis()))
        })
    }
}

#[tokio::test]
async fn ssh_upload_abort_or_timeout_ends_the_copy_and_removes_local_staging() {
    for timeout in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let remote = Arc::new(Hanging {
            started: tokio::sync::Notify::new(),
            dropped: dropped.clone(),
        });
        let mut config = UploadConfig::new(temp.path().to_owned());
        config.upload_timeout = Duration::from_millis(if timeout { 25 } else { 5_000 });
        let handler = Arc::new(TerminalUploads::new(
            config,
            remote.clone(),
            shared(&ManualClock::at(NOW)),
        ));
        let task = {
            let handler = handler.clone();
            tokio::spawn(async move {
                handler
                    .handle(chunks(&[b"partial transfer"]), Some("file.txt"))
                    .await
            })
        };
        remote.started.notified().await;
        if timeout {
            let response = task.await.unwrap();
            assert_eq!(response.status(), 502);
            assert!(
                json(&response)["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("ssh upload failed:")
            );
        } else {
            // The browser went away: the request's future is dropped.
            task.abort();
            let _ = task.await;
        }
        assert!(dropped.load(Ordering::SeqCst));
        assert!(listing(handler.root()).is_empty());
    }
}

/// A run the fake SSH side saw: script, stdin bytes, purpose.
type SeenRun = (String, Option<Vec<u8>>, &'static str);

/// An SSH side that answers with this output.
struct Answering(RemoteOutput, Mutex<Vec<SeenRun>>);

impl UploadRemote for Answering {
    fn host(&self) -> Option<String> {
        Some("box".into())
    }
    fn run(
        &self,
        host: String,
        script: String,
        stdin: Option<PathBuf>,
        _timeout: Duration,
        purpose: &'static str,
    ) -> BoxFuture<Result<RemoteOutput, String>> {
        assert_eq!(host, "box");
        let bytes = stdin.map(|path| std::fs::read(path).unwrap());
        self.1.lock().unwrap().push((script, bytes, purpose));
        let output = self.0.clone();
        Box::pin(async move { Ok(output) })
    }
}

#[tokio::test]
async fn ssh_uploads_answer_the_host_path_and_keep_no_local_copy() {
    let temp = tempfile::tempdir().unwrap();
    let remote = Arc::new(Answering(
        RemoteOutput {
            code: 0,
            stdout: "/tmp/roamgate-uploads-1000/upload-x/a b.txt".into(),
            stderr: String::new(),
        },
        Mutex::new(Vec::new()),
    ));
    let handler = TerminalUploads::new(
        UploadConfig::new(temp.path().to_owned()),
        remote.clone(),
        real_clock(),
    );
    let response = handler.handle(chunks(&[b"data"]), Some("a b.txt")).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        json(&response),
        json!({"path": "/tmp/roamgate-uploads-1000/upload-x/a b.txt", "text": "'/tmp/roamgate-uploads-1000/upload-x/a b.txt'", "remote": true})
    );
    let calls = remote.1.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].0,
        remote_terminal_upload_script("a_b.txt", 24 * 60)
    );
    assert_eq!(calls[0].1.as_deref(), Some(&b"data"[..]));
    assert_eq!(calls[0].2, "upload");
    assert!(listing(handler.root()).is_empty());

    let failing = TerminalUploads::new(
        UploadConfig::new(temp.path().to_owned()),
        Arc::new(Answering(
            RemoteOutput {
                code: 1,
                stdout: String::new(),
                stderr: " no space \n".into(),
            },
            Mutex::new(Vec::new()),
        )),
        real_clock(),
    );
    let response = failing.handle(chunks(&[b"data"]), Some("x")).await;
    assert_eq!(response.status(), 502);
    assert_eq!(json(&response)["error"], "ssh upload failed: no space");
    let cleanup = failing.sweep_expired().await.unwrap_err();
    assert_eq!(cleanup, "ssh upload cleanup failed: no space");
}

// http/image-upload.test.ts

fn images(temp: &Path) -> TerminalUploads {
    let mut config = image_upload_config(temp.to_owned());
    config.windows = false;
    TerminalUploads::new(config, Arc::new(LocalOnly), real_clock())
}

async fn image_ok(handler: &TerminalUploads, bytes: &[u8], ext: Option<&str>) -> PathBuf {
    let response = handler.handle_image(chunks(&[bytes]), ext).await;
    assert_eq!(response.status(), 200);
    let body = json(&response);
    assert_eq!(body["remote"], false);
    let path = PathBuf::from(body["path"].as_str().unwrap());
    assert_eq!(
        body["text"],
        terminal_path_text(path.to_str().unwrap(), PathStyle::Posix)
    );
    path
}

fn is_image_name(path: &Path, ext: &str) -> bool {
    let name = path.file_name().unwrap().to_string_lossy();
    let Some(rest) = name.strip_prefix("img-") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(&format!(".{ext}")) else {
        return false;
    };
    let Some((millis, random)) = rest.split_once('-') else {
        return false;
    };
    !millis.is_empty()
        && millis.bytes().all(|b| b.is_ascii_digit())
        && !random.is_empty()
        && random
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

#[tokio::test]
async fn local_pastes_are_written_to_a_private_folder_under_the_temp_root() {
    let temp = tempfile::tempdir().unwrap();
    let path = image_ok(&images(temp.path()), &[137, 80, 78, 71], Some("PNG")).await;
    assert!(path.is_absolute());
    assert_eq!(
        path.parent().unwrap().parent().unwrap().parent().unwrap(),
        temp.path()
    );
    assert!(
        path.parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("upload-")
    );
    assert!(is_image_name(&path, "png"), "{path:?}");
    assert_eq!(std::fs::read(&path).unwrap(), [137, 80, 78, 71]);
}

#[cfg(unix)]
#[tokio::test]
async fn the_folder_and_files_are_readable_only_by_the_current_user() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let path = image_ok(&images(temp.path()), &[1], None).await;
    let folder = std::fs::metadata(path.parent().unwrap()).unwrap();
    assert_eq!(folder.uid(), rustix::process::getuid().as_raw());
    assert_eq!(folder.permissions().mode() & 0o777, 0o700);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn each_image_gets_a_separate_upload_folder() {
    let temp = tempfile::tempdir().unwrap();
    let first = images(temp.path());
    let second = images(temp.path());
    let a = image_ok(&first, &[1], None).await;
    let b = image_ok(&first, &[1], None).await;
    let c = image_ok(&second, &[1], None).await;
    assert_ne!(b.parent(), a.parent());
    assert_ne!(c.parent(), a.parent());
}

#[tokio::test]
async fn a_deleted_folder_is_replaced_with_a_new_private_folder() {
    let temp = tempfile::tempdir().unwrap();
    let handler = images(temp.path());
    let first = image_ok(&handler, &[1], None).await;
    std::fs::remove_dir_all(first.parent().unwrap()).unwrap();
    let second = image_ok(&handler, &[1], None).await;
    assert_ne!(second.parent(), first.parent());
    assert!(second.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_swapped_for_a_link_is_not_followed() {
    let temp = tempfile::tempdir().unwrap();
    let handler = images(temp.path());
    let first = image_ok(&handler, &[1], None).await;
    let folder = first.parent().unwrap().to_owned();
    let target = temp.path().join("attacker");
    std::fs::create_dir(&target).unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(&target, &folder).unwrap();
    let second = image_ok(&handler, &[1], None).await;
    assert_ne!(second.parent().unwrap(), folder);
    assert!(listing(&target).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_staging_root_whose_permissions_were_loosened_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let handler = images(temp.path());
    let first = image_ok(&handler, &[1], None).await;
    let root = first.parent().unwrap().parent().unwrap();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o777)).unwrap();
    let response = handler.handle_image(chunks(&[&[1]]), None).await;
    assert_eq!(response.status(), 500);
    assert_eq!(json(&response)["error"], "unsafe terminal upload directory");
}

#[tokio::test]
async fn unsafe_extension_characters_are_dropped_from_the_file_name() {
    let temp = tempfile::tempdir().unwrap();
    let path = image_ok(&images(temp.path()), &[1], Some("../j.p-g")).await;
    assert_eq!(
        path.parent().unwrap().parent().unwrap().parent().unwrap(),
        temp.path()
    );
    assert!(is_image_name(&path, "jpg"), "{path:?}");
}

#[tokio::test]
async fn empty_image_uploads_are_rejected_without_retaining_a_folder() {
    let temp = tempfile::tempdir().unwrap();
    let handler = images(temp.path());
    let response = handler.handle_image(chunks(&[]), None).await;
    assert_eq!(response.status(), 400);
    assert!(listing(handler.root()).is_empty());
}

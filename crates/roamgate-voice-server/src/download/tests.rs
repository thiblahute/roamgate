use std::sync::Mutex;

use super::*;
use crate::testing::{ModelServer, serve_models};

/// The fixture's Parakeet encoder, to `dir`.
fn target(server: &ModelServer, dir: &Path) -> (DownloadTarget, Vec<u8>, String) {
    let entry = server
        .packages
        .iter()
        .find(|p| p.id == "parakeet-tdt-0.6b-v3")
        .unwrap();
    let file = entry
        .files
        .iter()
        .find(|f| f.path == "encoder-model.int8.onnx")
        .unwrap();
    let path = format!("/{}/{}", entry.id, file.path);
    (
        DownloadTarget {
            url: file.url.clone(),
            path: dir.join("sub").join(&file.path),
            size: file.size,
            sha256: file.sha256.clone(),
        },
        server.body(&path),
        path,
    )
}

fn progress() -> (Progress, Arc<Mutex<Vec<f64>>>) {
    let seen: Arc<Mutex<Vec<f64>>> = Arc::default();
    let kept = seen.clone();
    (Arc::new(move |done| kept.lock().unwrap().push(done)), seen)
}

#[tokio::test]
async fn downloads_into_part_checks_it_and_puts_it_in_place() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, body, path) = target(&server, dir.path());
    let (on_progress, seen) = progress();
    let options = DownloadOptions {
        on_progress: Some(on_progress),
        ..Default::default()
    };
    assert_eq!(download_file(&file, &options).await, Ok("downloaded"));
    assert_eq!(std::fs::read(&file.path).unwrap(), body);
    assert!(!part_path(&file.path).exists());
    assert_eq!(*seen.lock().unwrap().last().unwrap(), file.size);
    assert_eq!(server.requests(), vec![(path, None)]);
}

#[tokio::test]
async fn resumes_a_part_with_a_range_request() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, body, _) = target(&server, dir.path());
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::fs::write(part_path(&file.path), &body[..100]).unwrap();
    let (on_progress, seen) = progress();
    let options = DownloadOptions {
        on_progress: Some(on_progress),
        ..Default::default()
    };
    download_file(&file, &options).await.unwrap();
    assert_eq!(
        server
            .requests()
            .into_iter()
            .map(|(_, range)| range)
            .collect::<Vec<_>>(),
        vec![Some("bytes=100-".to_owned())]
    );
    assert_eq!(seen.lock().unwrap()[0], 100.0);
    assert_eq!(std::fs::read(&file.path).unwrap(), body);
}

#[tokio::test]
async fn a_server_ignoring_range_sends_it_whole_written_over_the_part() {
    let server = serve_models().await;
    server.set_ignore_range(true);
    let dir = tempfile::tempdir().unwrap();
    let (file, body, _) = target(&server, dir.path());
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::fs::write(part_path(&file.path), &body[..100]).unwrap();
    download_file(&file, &DownloadOptions::default())
        .await
        .unwrap();
    assert_eq!(std::fs::read(&file.path).unwrap(), body);
}

#[tokio::test]
async fn a_connection_lost_halfway_is_resumed_where_it_stopped() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, body, path) = target(&server, dir.path());
    server.cut_once(&path);
    let options = DownloadOptions {
        retry_delay_ms: Some(0),
        fetch: Some(server.fetch()),
        ..Default::default()
    };
    download_file(&file, &options).await.unwrap();
    let requests = server.requests();
    assert_eq!(requests[0].1, None);
    let second = requests[1].1.clone().unwrap();
    assert!(
        second.starts_with("bytes=") && second.ends_with('-') && !second.starts_with("bytes=0")
    );
    assert_eq!(std::fs::read(&file.path).unwrap(), body);
}

#[tokio::test]
async fn a_wrong_checksum_fails_nothing_left_behind() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (mut file, _, _) = target(&server, dir.path());
    file.sha256 = "0".repeat(64);
    let options = DownloadOptions {
        retry_delay_ms: Some(0),
        ..Default::default()
    };
    assert!(matches!(
        download_file(&file, &options).await,
        Err(DownloadError::Checksum(_))
    ));
    assert!(!file.path.exists());
    assert!(!part_path(&file.path).exists());
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn a_complete_part_is_checked_without_asking_the_server() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, body, _) = target(&server, dir.path());
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::fs::write(part_path(&file.path), &body).unwrap();
    download_file(&file, &DownloadOptions::default())
        .await
        .unwrap();
    assert!(server.requests().is_empty());
    assert!(file.path.exists());
}

#[tokio::test]
async fn a_file_in_place_is_kept_verify_downloads_a_corrupted_one_again() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, body, _) = target(&server, dir.path());
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    let mut corrupted = body.clone();
    corrupted[0] ^= 0xff;
    std::fs::write(&file.path, &corrupted).unwrap();
    assert_eq!(
        download_file(&file, &DownloadOptions::default()).await,
        Ok("present")
    );
    assert!(server.requests().is_empty());
    let verify = DownloadOptions {
        verify: true,
        ..Default::default()
    };
    assert_eq!(download_file(&file, &verify).await, Ok("downloaded"));
    assert_eq!(std::fs::read(&file.path).unwrap(), body);
}

#[tokio::test]
async fn a_missing_file_fails_after_its_attempts() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (mut file, _, _) = target(&server, dir.path());
    file.url = format!("{}/nothing", server.url);
    let options = DownloadOptions {
        retry_delay_ms: Some(0),
        attempts: Some(2),
        ..Default::default()
    };
    let error = download_file(&file, &options).await.unwrap_err();
    assert!(error.to_string().contains("HTTP 404"));
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn an_abort_stops_it_the_part_kept_for_later() {
    let server = serve_models().await;
    let dir = tempfile::tempdir().unwrap();
    let (file, _, path) = target(&server, dir.path());
    server.cut_once(&path);
    let (abort, signal) = watch::channel(false);
    let abort = Arc::new(abort);
    let stop = abort.clone();
    let options = DownloadOptions {
        fetch: Some(server.fetch()),
        signal: Some(signal),
        retry_delay_ms: Some(60_000),
        on_progress: Some(Arc::new(move |bytes| {
            if bytes > 0.0 {
                let _ = stop.send(true);
            }
        })),
        ..Default::default()
    };
    assert!(download_file(&file, &options).await.is_err());
    assert!(!file.path.exists());
    assert!(part_path(&file.path).exists());
}

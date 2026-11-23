//! The skeleton server over a real socket.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn get(address: std::net::SocketAddr, path: &str) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let response = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head.to_ascii_lowercase(), body.to_owned())
}

#[tokio::test]
async fn serves_healthz_and_the_web_app() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(roamgate::serve(listener, async {
        let _ = stopped.await;
    }));

    let (status, head, body) = get(address, "/healthz").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: text/plain; charset=utf-8"));
    assert_eq!(body, "Ok");
    assert_eq!(get(address, "/health").await.2, "Ok");

    let (status, _, _) = get(address, "/missing.js").await;
    assert_eq!(status, 404);

    let (status, head, body) = get(address, "/").await;
    if roamgate::has_web() {
        assert_eq!(status, 200);
        assert!(head.contains("content-type: text/html"));
        assert!(
            body.contains("<html") || body.contains("<!doctype"),
            "{body}"
        );
        // An app route gets the app.
        assert_eq!(get(address, "/settings/profiles").await.2, body);
    } else {
        assert_eq!(status, 404);
    }

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

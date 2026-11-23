//! The HTTP side of a WebSocket upgrade, on axum and hyper.

use axum::body::Body;
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;

use crate::deflate::{self, Negotiated};

/// An upgrade the server accepted: answer with `response`, then await
/// `on_upgrade` for the connection.
pub struct Accepted {
    pub response: Response<Body>,
    pub on_upgrade: OnUpgrade,
    pub deflate: Option<Negotiated>,
}

fn has_token(request: &Request<impl Sized>, name: header::HeaderName, token: &str) -> bool {
    request.headers().get_all(name).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    })
}

fn refuse(status: StatusCode, message: &'static str) -> Box<Response<Body>> {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    Box::new(response)
}

/// Checks a request for a WebSocket upgrade (RFC 6455 section 4.2.1) and
/// builds the 101 answer, with permessage-deflate when `compression` and the
/// client offered something this server honours.
/// The refusal is boxed: a response is large next to what success carries.
pub fn accept<B>(
    request: &mut Request<B>,
    compression: bool,
) -> Result<Accepted, Box<Response<Body>>> {
    if request.method() != Method::GET
        || !has_token(request, header::CONNECTION, "upgrade")
        || !has_token(request, header::UPGRADE, "websocket")
    {
        return Err(refuse(StatusCode::BAD_REQUEST, "upgrade failed"));
    }
    if request.headers().get(header::SEC_WEBSOCKET_VERSION) != Some(&HeaderValue::from_static("13"))
    {
        let mut response = refuse(
            StatusCode::UPGRADE_REQUIRED,
            "unsupported WebSocket version",
        );
        response.headers_mut().insert(
            header::SEC_WEBSOCKET_VERSION,
            HeaderValue::from_static("13"),
        );
        return Err(response);
    }
    let Some(key) = request.headers().get(header::SEC_WEBSOCKET_KEY) else {
        return Err(refuse(StatusCode::BAD_REQUEST, "upgrade failed"));
    };
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let deflate = if compression {
        deflate::negotiate(
            request
                .headers()
                .get_all(header::SEC_WEBSOCKET_EXTENSIONS)
                .iter()
                .filter_map(|value| value.to_str().ok()),
        )
    } else {
        None
    };
    let Some(on_upgrade) = request.extensions_mut().remove::<OnUpgrade>() else {
        return Err(refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connection cannot upgrade",
        ));
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = response.headers_mut();
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    if let Ok(value) = HeaderValue::from_str(&accept) {
        headers.insert(header::SEC_WEBSOCKET_ACCEPT, value);
    }
    if let Some(negotiated) = &deflate
        && let Ok(value) = HeaderValue::from_str(&negotiated.response)
    {
        headers.insert(header::SEC_WEBSOCKET_EXTENSIONS, value);
    }
    Ok(Accepted {
        response,
        on_upgrade,
        deflate,
    })
}

/// The connection once the 101 answer went out.
pub async fn upgraded(on_upgrade: OnUpgrade) -> hyper::Result<TokioIo<hyper::upgrade::Upgraded>> {
    on_upgrade.await.map(TokioIo::new)
}

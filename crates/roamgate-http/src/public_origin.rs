//! The origin a client reached Roamgate on (http/public-origin.ts), for
//! absolute links the server hands out (the notification socket's `url`).
//! Behind a reverse proxy on this machine, such as `tailscale serve`, the
//! request Roamgate sees is plain http on the public host name: the
//! proxy's `X-Forwarded-Proto` and `X-Forwarded-Host` say what the client
//! used. Those headers are trusted only from a loopback peer; anyone else
//! could forge them. A `*.ts.net` host on the default port is HTTPS anyway:
//! Tailscale only serves those names with TLS, and Android refuses
//! cleartext links to them.

use http::HeaderMap;
use url::{Position, Url};

use crate::response::header;

/// `isLoopbackAddress` (workspace/file-manager.ts).
pub fn is_loopback_address(address: &str) -> bool {
    address.starts_with("127.") || address == "::1" || address.starts_with("::ffff:127.")
}

fn first(value: Option<String>) -> Option<String> {
    let value = value?;
    let head = value.split(',').next().unwrap_or("").trim();
    (!head.is_empty()).then(|| head.to_owned())
}

fn proto_of(value: Option<String>) -> Option<&'static str> {
    match first(value)?.to_lowercase().as_str() {
        "https" => Some("https:"),
        "http" => Some("http:"),
        _ => None,
    }
}

/// `url.host`: the host and a port that is not the scheme's default.
pub fn host_of_url(url: &Url) -> String {
    url[Position::BeforeHost..Position::AfterPort].to_owned()
}

/// A bare `host[:port]`, nothing a URL could smuggle in after it.
fn host_of(value: Option<String>) -> Option<String> {
    let host = first(value)?;
    if host
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '?' | '#' | '@'))
    {
        return None;
    }
    let url = Url::parse(&format!("http://{host}")).ok()?;
    let host = host_of_url(&url);
    (!host.is_empty()).then_some(host)
}

/// A Tailscale MagicDNS name on its default port: served over HTTPS only.
fn is_tailscale_name(host: &str) -> bool {
    let Ok(url) = Url::parse(&format!("http://{host}")) else {
        return false;
    };
    let name = url.host_str().unwrap_or("").to_lowercase();
    url.port().is_none() && (name.ends_with(".ts.net") || name.ends_with(".ts.net."))
}

fn parse_origin(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

pub fn public_origin(url: &Url, headers: &HeaderMap, peer: Option<&str>) -> String {
    let trusted = peer.is_some_and(is_loopback_address);
    let forwarded_host = if trusted {
        host_of(header(headers, "x-forwarded-host"))
    } else {
        None
    };
    let forwarded_proto = if trusted {
        proto_of(header(headers, "x-forwarded-proto"))
    } else {
        None
    };
    let host = forwarded_host.unwrap_or_else(|| host_of_url(url));
    let protocol = forwarded_proto.map(str::to_owned).unwrap_or_else(|| {
        if is_tailscale_name(&host) {
            "https:".into()
        } else {
            format!("{}:", url.scheme())
        }
    });
    parse_origin(&format!("{protocol}//{host}"))
        .unwrap_or_else(|| url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::parts;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        parts("GET", "/", pairs).headers
    }

    fn proxied() -> Url {
        Url::parse("http://roamgate.example.ts.net/api/notifications/ws").unwrap()
    }

    fn local() -> Url {
        Url::parse("http://127.0.0.1:8787/api/notifications/ws").unwrap()
    }

    #[test]
    fn tailscale_serve_s_forwarded_scheme_and_host_count_from_loopback() {
        let forwarded = headers(&[
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "roamgate.example.ts.net"),
            ("x-forwarded-for", "100.64.0.7"),
        ]);
        for peer in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            assert_eq!(
                public_origin(&proxied(), &forwarded, Some(peer)),
                "https://roamgate.example.ts.net"
            );
        }
        assert_eq!(
            public_origin(&local(), &forwarded, Some("127.0.0.1")),
            "https://roamgate.example.ts.net"
        );
        assert_eq!(
            public_origin(
                &local(),
                &headers(&[
                    ("x-forwarded-proto", "HTTPS, http"),
                    ("x-forwarded-host", "box.example.com:8443, other"),
                ]),
                Some("127.0.0.1")
            ),
            "https://box.example.com:8443"
        );
    }

    #[test]
    fn forwarded_headers_from_another_peer_are_ignored() {
        let forwarded = headers(&[
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "evil.example"),
        ]);
        assert_eq!(
            public_origin(&local(), &forwarded, Some("192.0.2.7")),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            public_origin(&local(), &forwarded, None),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            public_origin(&local(), &forwarded, Some("unknown")),
            "http://127.0.0.1:8787"
        );
    }

    #[test]
    fn a_ts_net_name_on_the_default_port_is_https() {
        assert_eq!(
            public_origin(&proxied(), &headers(&[]), Some("100.64.0.7")),
            "https://roamgate.example.ts.net"
        );
        assert_eq!(
            public_origin(&proxied(), &headers(&[]), Some("127.0.0.1")),
            "https://roamgate.example.ts.net"
        );
        // Roamgate's own port on the tailnet is its plain listener.
        let direct = Url::parse("http://box.example.ts.net:8787/").unwrap();
        assert_eq!(
            public_origin(&direct, &headers(&[]), Some("100.64.0.7")),
            "http://box.example.ts.net:8787"
        );
        // A local proxy that says http is believed.
        assert_eq!(
            public_origin(
                &proxied(),
                &headers(&[("x-forwarded-proto", "http")]),
                Some("127.0.0.1")
            ),
            "http://roamgate.example.ts.net"
        );
    }

    #[test]
    fn malformed_forwarded_values_fall_back_to_the_request() {
        for host in ["a.example/evil", "user@a.example", "a b", ""] {
            assert_eq!(
                public_origin(
                    &local(),
                    &headers(&[("x-forwarded-host", host), ("x-forwarded-proto", "ftp")]),
                    Some("127.0.0.1")
                ),
                "http://127.0.0.1:8787",
                "{host:?}"
            );
        }
    }
}

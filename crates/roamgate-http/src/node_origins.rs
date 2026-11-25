//! The Roamgate nodes whose pages fetch the home's `/api/` routes: a page a
//! node served (the Mac's, on its own tailnet name) runs on another origin
//! than the home's, and reads and writes the home's shared state from there
//! with the home's cookie. The home answers those origins, and only those,
//! with CORS headers that let the page read the answers, and their
//! preflights before any login (a preflight carries no cookie). Configured
//! by `ROAMGATE_NODE_ORIGINS`: origins separated by commas or spaces.

/// The node origins the home answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeOrigins(Vec<String>);

const ALLOWED_METHODS: &str = "GET, HEAD, POST, PUT, PATCH, DELETE";

impl NodeOrigins {
    /// The origins of `raw`, each `http(s)://host[:port]` without a path;
    /// anything else is ignored.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        let mut origins = Vec::new();
        for item in raw.split([',', ' ', '\n', '\t']) {
            let item = item.trim().trim_end_matches('/');
            let Some((scheme, rest)) = item.split_once("://") else {
                continue;
            };
            if !matches!(scheme, "https" | "http")
                || rest.is_empty()
                || rest.contains(['/', '?', '#', '@'])
            {
                continue;
            }
            let origin = format!("{scheme}://{}", rest.to_ascii_lowercase());
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        Self(origins)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The origin a request came from, when it is a node's and the request
    /// is for an `/api/` route.
    pub fn matching(&self, origin: Option<&str>, path: &str) -> Option<String> {
        let origin = origin?;
        if !(path == "/api" || path.starts_with("/api/")) {
            return None;
        }
        self.0.iter().find(|item| item.as_str() == origin).cloned()
    }

    /// The headers of a node's request's answer.
    pub fn headers(origin: &str) -> Vec<(&'static str, String)> {
        vec![
            ("access-control-allow-origin", origin.to_owned()),
            ("access-control-allow-credentials", "true".to_owned()),
            ("vary", "Origin".to_owned()),
        ]
    }

    /// The headers of a node's preflight's answer: the methods and the
    /// headers it asked for.
    pub fn preflight_headers(
        origin: &str,
        requested_headers: Option<&str>,
    ) -> Vec<(&'static str, String)> {
        let mut headers = Self::headers(origin);
        headers.push(("access-control-allow-methods", ALLOWED_METHODS.to_owned()));
        if let Some(requested) = requested_headers.filter(|value| !value.trim().is_empty()) {
            headers.push(("access-control-allow-headers", requested.to_owned()));
        }
        headers.push(("access-control-max-age", "600".to_owned()));
        headers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_origins_and_ignores_the_rest() {
        let origins = NodeOrigins::parse(Some(
            "https://Mac-Roamgate.example.ts.net/, http://127.0.0.1:8787 ftp://x https://a/b https://u@h",
        ));
        assert_eq!(
            origins,
            NodeOrigins(vec![
                "https://mac-roamgate.example.ts.net".to_owned(),
                "http://127.0.0.1:8787".to_owned(),
            ])
        );
        assert!(NodeOrigins::parse(None).is_empty());
        assert!(NodeOrigins::parse(Some("")).is_empty());
    }

    #[test]
    fn answers_only_its_origins_on_api_routes() {
        let origins = NodeOrigins::parse(Some("https://mac.example.ts.net"));
        let mac = Some("https://mac.example.ts.net");
        assert_eq!(
            origins.matching(mac, "/api/history").as_deref(),
            Some("https://mac.example.ts.net")
        );
        assert_eq!(origins.matching(mac, "/ws"), None);
        assert_eq!(origins.matching(mac, "/"), None);
        assert_eq!(
            origins.matching(Some("https://evil.example"), "/api/history"),
            None
        );
        assert_eq!(origins.matching(None, "/api/history"), None);
    }

    #[test]
    fn a_preflight_allows_what_it_asked_for() {
        let headers =
            NodeOrigins::preflight_headers("https://mac.example.ts.net", Some("content-type"));
        assert!(headers.contains(&("access-control-allow-headers", "content-type".to_owned())));
        assert!(headers.contains(&("access-control-allow-credentials", "true".to_owned())));
    }
}

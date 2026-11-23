//! Local history for Settings' "History and backup" (http/history.ts):
//!
//! - `GET  /api/history`: its status.
//! - `PUT  /api/history` `{location?: string | null, enabled?: boolean}`:
//!   where the repository is (null: the default) and whether it is written.
//! - `POST /api/history/commit`: a pass now, every area.
//!
//! Writes need the settings header and JSON, as the instance settings do,
//! so a cross-origin page cannot make them. The history itself is a
//! [`HistoryBackend`].

use std::sync::Arc;

use bytes::Bytes;
use futures_util::Stream;
use http::request::Parts;
use roamgate_base::clock::BoxFuture;
use roamgate_base::settings::js_trim;
use serde_json::{Value, json};

use crate::body::read_json_body;
use crate::response::{self, Response};

pub const HISTORY_PATH: &str = "/api/history";
pub const HISTORY_COMMIT_PATH: &str = "/api/history/commit";
/// The largest write body.
pub const HISTORY_MAX_BYTES: usize = 8192;

/// A settings change: each field is set only when the body gave it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryChange {
    /// `Some(None)`: back to the default location.
    pub location: Option<Option<String>>,
    pub enabled: Option<bool>,
}

/// The local history the route reports on and drives.
pub trait HistoryBackend: Send + Sync + 'static {
    /// The status as the page reads it (shared/history `HistoryStatus`).
    fn status(&self) -> BoxFuture<Value>;
    /// Applies a change; an error (a relative location, say) is the 400's
    /// message.
    fn configure(&self, change: HistoryChange) -> BoxFuture<Result<(), String>>;
    /// A pass now, every area.
    fn commit(&self) -> BoxFuture<()>;
}

fn json(status: u16, body: &Value) -> Response {
    response::json(status, &[("cache-control", "no-store")], body)
}

/// The settings header, not cross-site, and a JSON body.
fn trusted(head: &Parts) -> bool {
    let header = |name: &str| response::header(&head.headers, name);
    let content_type = header("content-type")
        .map(|value| js_trim(value.split(';').next().unwrap_or_default()).to_lowercase());
    header("x-roamgate-settings").as_deref() == Some("1")
        && header("sec-fetch-site").as_deref() != Some("cross-site")
        && content_type.as_deref() == Some("application/json")
}

fn change_of(body: &Value) -> Result<HistoryChange, &'static str> {
    let empty = serde_json::Map::new();
    let fields = body.as_object().unwrap_or(&empty);
    let mut change = HistoryChange::default();
    if let Some(location) = fields.get("location") {
        change.location = Some(match location {
            Value::Null => None,
            Value::String(text) if !js_trim(text).is_empty() => Some(text.clone()),
            Value::String(_) => None,
            _ => return Err("location is a path or null"),
        });
    }
    if let Some(enabled) = fields.get("enabled") {
        let Value::Bool(enabled) = enabled else {
            return Err("enabled is true or false");
        };
        change.enabled = Some(*enabled);
    }
    Ok(change)
}

/// The `/api/history` routes (called after the front's authentication gate).
#[derive(Clone)]
pub struct HistoryRoute {
    backend: Arc<dyn HistoryBackend>,
}

impl HistoryRoute {
    pub fn new(backend: Arc<dyn HistoryBackend>) -> Self {
        Self { backend }
    }

    /// The answer for `pathname`, or `None` when it is not the route's.
    pub async fn handle<S, E>(
        &self,
        head: &Parts,
        pathname: &str,
        body: Option<S>,
    ) -> Option<Response>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        if pathname != HISTORY_PATH && pathname != HISTORY_COMMIT_PATH {
            return None;
        }
        let method = head.method.as_str();
        if pathname == HISTORY_PATH && method == "GET" {
            return Some(json(200, &self.backend.status().await));
        }
        let expected = if pathname == HISTORY_PATH {
            "PUT"
        } else {
            "POST"
        };
        if method != expected {
            return Some(json(405, &json!({ "error": "method not allowed" })));
        }
        if !trusted(head) {
            return Some(json(403, &json!({ "error": "Forbidden" })));
        }
        let Ok(body) = read_json_body(body, HISTORY_MAX_BYTES).await else {
            return Some(json(400, &json!({ "error": "Invalid history request" })));
        };
        if pathname == HISTORY_COMMIT_PATH {
            self.backend.commit().await;
            return Some(json(200, &self.backend.status().await));
        }
        let change = match change_of(&body) {
            Ok(change) => change,
            Err(error) => return Some(json(400, &json!({ "error": error }))),
        };
        if let Err(error) = self.backend.configure(change).await {
            return Some(json(400, &json!({ "error": error })));
        }
        Some(json(200, &self.backend.status().await))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::test_support::{Body, body, parts};

    /// What the backend was asked: a change, or `None` for a commit.
    #[derive(Default)]
    struct Recorded(Mutex<Vec<Option<HistoryChange>>>);

    impl HistoryBackend for Recorded {
        fn status(&self) -> BoxFuture<Value> {
            Box::pin(async { json!({"enabled": true, "location": "/h"}) })
        }
        fn configure(&self, change: HistoryChange) -> BoxFuture<Result<(), String>> {
            let refused = change.location == Some(Some("relative".into()));
            if !refused {
                self.0.lock().unwrap().push(Some(change));
            }
            Box::pin(async move {
                if refused {
                    Err("must be absolute".to_owned())
                } else {
                    Ok(())
                }
            })
        }
        fn commit(&self) -> BoxFuture<()> {
            self.0.lock().unwrap().push(None);
            Box::pin(async {})
        }
    }

    fn route() -> (HistoryRoute, Arc<Recorded>) {
        let recorded = Arc::new(Recorded::default());
        (HistoryRoute::new(recorded.clone()), recorded)
    }

    async fn write(
        route: &HistoryRoute,
        method: &str,
        pathname: &str,
        value: Value,
        headers: &[(&str, &str)],
    ) -> Response {
        let mut all = vec![
            ("content-type", "application/json"),
            ("x-roamgate-settings", "1"),
        ];
        for (name, value) in headers {
            all.retain(|(each, _)| each != name);
            all.push((name, value));
        }
        let head = parts(method, &format!("http://x{pathname}"), &all);
        route
            .handle(&head, pathname, body(value.to_string()))
            .await
            .unwrap()
    }

    fn json_of(response: &Response) -> Value {
        serde_json::from_slice(response.body()).unwrap()
    }

    #[tokio::test]
    async fn get_is_the_status_other_paths_are_not_the_routes() {
        let (route, _) = route();
        let response = route
            .handle(
                &parts("GET", "http://x/api/history", &[]),
                "/api/history",
                None::<Body>,
            )
            .await
            .unwrap();
        assert_eq!(
            json_of(&response),
            json!({"enabled": true, "location": "/h"})
        );
        assert_eq!(
            response::header(response.headers(), "cache-control").as_deref(),
            Some("no-store")
        );
        assert!(
            route
                .handle(
                    &parts("GET", "http://x/api/historyx", &[]),
                    "/api/historyx",
                    None::<Body>,
                )
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn put_sets_the_location_and_the_switch_post_commit_runs_a_pass() {
        let (route, recorded) = route();
        let put = |value: Value| {
            let route = route.clone();
            async move { write(&route, "PUT", "/api/history", value, &[]).await }
        };
        assert_eq!(
            put(json!({"location": "/data/h", "enabled": false}))
                .await
                .status(),
            200
        );
        assert_eq!(put(json!({"location": ""})).await.status(), 200);
        assert_eq!(
            write(&route, "POST", "/api/history/commit", json!({}), &[])
                .await
                .status(),
            200
        );
        assert_eq!(
            *recorded.0.lock().unwrap(),
            [
                Some(HistoryChange {
                    location: Some(Some("/data/h".into())),
                    enabled: Some(false),
                }),
                Some(HistoryChange {
                    location: Some(None),
                    enabled: None,
                }),
                None,
            ]
        );
        let bad = put(json!({"location": "relative"})).await;
        assert_eq!(bad.status(), 400);
        assert_eq!(json_of(&bad), json!({"error": "must be absolute"}));
        assert_eq!(put(json!({"enabled": "yes"})).await.status(), 400);
    }

    #[tokio::test]
    async fn a_write_without_the_settings_header_or_cross_site_is_refused() {
        let (route, recorded) = route();
        assert_eq!(
            write(
                &route,
                "PUT",
                "/api/history",
                json!({}),
                &[("x-roamgate-settings", "0")]
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            write(
                &route,
                "POST",
                "/api/history/commit",
                json!({}),
                &[("sec-fetch-site", "cross-site")]
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            write(&route, "POST", "/api/history", json!({}), &[])
                .await
                .status(),
            405
        );
        assert!(recorded.0.lock().unwrap().is_empty());
    }
}

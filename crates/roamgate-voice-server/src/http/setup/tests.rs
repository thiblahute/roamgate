//! http/voice-setup.test.ts.

use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::models::recommended_choices;
use crate::testing::{ModelServer, SetupHome, cpu_laptop, serve_models, setup_home};

async fn route() -> (ModelServer, SetupHome, VoiceSetupRunner, SetupRoute) {
    let server = serve_models().await;
    let home = setup_home(&server, cpu_laptop());
    let runner = VoiceSetupRunner::new(home.deps.clone(), None);
    let route = SetupRoute::new(runner.clone());
    (server, home, runner, route)
}

fn post(route: &SetupRoute, path: &str, body: Value, header: bool) -> Answer {
    let mut request = Request::new("POST", path).json(&body);
    if header {
        request = request.header("x-roamgate-voice", "1");
    }
    route.handle(&request).expect("an answer")
}

fn get(route: &SetupRoute) -> Answer {
    route
        .handle(&Request::new("GET", "/api/voice/setup"))
        .expect("an answer")
}

#[tokio::test]
async fn get_is_the_assistant_s_state_not_cached() {
    let (_server, _home, _runner, route) = route().await;
    let response = get(&route);
    assert_eq!(response.get("cache-control"), Some("no-store"));
    let state = response.body_json();
    assert_eq!(state["tier"], "light");
    assert_eq!(state["job"], Value::Null);
}

#[tokio::test]
async fn post_starts_the_download_followed_by_get_until_done() {
    let (_server, _home, runner, route) = route().await;
    let choices = Value::Object(
        recommended_choices(&cpu_laptop())["light"]
            .iter()
            .map(|(part, id)| (part.clone(), json!(id)))
            .collect(),
    );
    let response = post(
        &route,
        "/api/voice/setup",
        json!({"choices": choices}),
        true,
    );
    assert_eq!(response.status, 202);
    assert_eq!(response.body_json()["job"]["state"], "downloading");
    let again = post(
        &route,
        "/api/voice/setup",
        json!({"choices": choices}),
        true,
    );
    assert_eq!(again.status, 409);
    while runner.running() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let state = get(&route).body_json();
    assert_eq!(state["job"]["state"], "done");
    assert_eq!(state["current"]["tts"], choices["tts"]);
}

#[tokio::test]
async fn changes_need_the_voice_header_and_valid_choices() {
    let (_server, _home, _runner, route) = route().await;
    let path = "/api/voice/setup";
    assert_eq!(
        post(&route, path, json!({"choices": {}}), false).status,
        403
    );
    assert_eq!(
        post(&route, path, json!({"choices": {"tts": 3}}), true).status,
        400
    );
    assert_eq!(
        post(&route, path, json!({"choices": {"wings": "x"}}), true).status,
        400
    );
    let unknown = post(&route, path, json!({"choices": {"tts": "nope"}}), true);
    assert_eq!(unknown.status, 400);
    assert!(
        unknown.body_json()["error"]
            .as_str()
            .unwrap()
            .contains("nope")
    );
    let remove = post(&route, "/api/voice/setup/remove", json!({"ids": 3}), true);
    assert_eq!(remove.status, 400);
}

#[tokio::test]
async fn remove_answers_what_it_freed_cancel_with_nothing_running_is_fine() {
    let (_server, _home, _runner, route) = route().await;
    let removed = post(
        &route,
        "/api/voice/setup/remove",
        json!({"ids": "all"}),
        true,
    );
    assert_eq!(removed.body_json()["freedBytes"], 0);
    let cancel = post(&route, "/api/voice/setup/cancel", json!({}), true);
    assert_eq!(cancel.status, 200);
}

#[tokio::test]
async fn other_paths_are_not_its() {
    let (_server, _home, _runner, route) = route().await;
    assert!(route.handle(&Request::new("GET", "/api/voice")).is_none());
}

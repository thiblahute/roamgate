use std::collections::HashSet;
use std::sync::Arc;

use roamgate_base::clock::TokioClock;

use crate::companion::claude::fake;

use super::*;

fn ids() -> HashSet<String> {
    ["local/w2:p2", "desktop/w1J:p1"].map(String::from).into()
}

#[test]
fn reads_each_kind_of_answer() {
    assert_eq!(
        parse_voice_route(r#"{"to": "current"}"#, &ids()),
        VoiceRoute::Current
    );
    assert_eq!(
        parse_voice_route(r#"Sure: {"to": "nobody"}"#, &ids()),
        VoiceRoute::Nobody
    );
    assert_eq!(
        parse_voice_route(
            r#"{"to": "send", "pane": "desktop/w1J:p1", "say": "IGA-184"}"#,
            &ids()
        ),
        VoiceRoute::Send {
            pane: "desktop/w1J:p1".into(),
            say: "IGA-184".into()
        }
    );
    assert_eq!(
        parse_voice_route(
            r#"{"to": "ask", "panes": ["local/w2:p2", "nope"], "question": "Which?"}"#,
            &ids()
        ),
        VoiceRoute::Ask {
            panes: vec!["local/w2:p2".into()],
            question: "Which?".into()
        }
    );
}

#[test]
fn reads_a_question_for_ranger() {
    assert_eq!(
        parse_voice_route(r#"{"to": "ranger"}"#, &ids()),
        VoiceRoute::Ranger
    );
    assert_eq!(
        parse_voice_route(r#"{"to": "reviews"}"#, &ids()),
        VoiceRoute::Reviews
    );
    assert_eq!(
        parse_voice_route(r#"{"to": "status", "pane": "desktop/w1J:p1"}"#, &ids()),
        VoiceRoute::Current
    );
}

#[test]
fn anything_unclear_goes_to_the_agent_on_screen() {
    assert_eq!(parse_voice_route("no idea", &ids()), VoiceRoute::Current);
    assert_eq!(
        parse_voice_route(r#"{"to": "open", "pane": "local/w9:p9"}"#, &ids()),
        VoiceRoute::Current
    );
    assert_eq!(
        parse_voice_route(r#"{"to": "ask", "panes": []}"#, &ids()),
        VoiceRoute::Current
    );
}

#[test]
fn reads_an_answer_given_as_a_tool_call() {
    assert_eq!(
        parse_voice_route(
            "<invoke name=\"open\">\n<parameter name=\"pane\">desktop/w1J:p1</parameter>\n<parameter name=\"say\">IGA-184</parameter>\n</invoke>",
            &ids()
        ),
        VoiceRoute::Open {
            pane: "desktop/w1J:p1".into(),
            say: "IGA-184".into()
        }
    );
}

pub(crate) fn sessions() -> Vec<VoiceSessionInfo> {
    vec![
        VoiceSessionInfo {
            id: "local/w2:p2".into(),
            machine: "Mac".into(),
            workspace: "roamgate".into(),
            title: "roamgate".into(),
            folder: "/src/roamgate".into(),
            agent: "claude".into(),
            status: "idle".into(),
            ..VoiceSessionInfo::default()
        },
        VoiceSessionInfo {
            id: "desktop/w1J:p1".into(),
            machine: "desktop".into(),
            workspace: "iga-184".into(),
            title: "IGA-184 video direction".into(),
            folder: "/src/cps-iga-184".into(),
            agent: "claude".into(),
            status: "idle".into(),
            ..VoiceSessionInfo::default()
        },
    ]
}

fn request(said: &str, sessions: Vec<VoiceSessionInfo>) -> RouteRequest {
    RouteRequest {
        current: "local/w2:p2".into(),
        said: said.into(),
        sessions,
        ..RouteRequest::default()
    }
}

#[tokio::test]
async fn gives_the_session_list_once_and_again_when_it_changes() {
    let claude = fake::Claude::new(|_| r#"{"to": "current"}"#.into());
    let router = VoiceRouter::new(claude.spawn());
    assert_eq!(
        router.route(request("Push it.", sessions())).await,
        VoiceRoute::Current
    );
    router.route(request("Run the tests.", sessions())).await;
    router
        .route(request("Okay.", sessions()[..1].to_vec()))
        .await;
    let written = claude.written(0);
    assert!(written[0].starts_with("Sessions:\nlocal/w2:p2 | Mac |"));
    assert!(written[0].ends_with("Current: local/w2:p2\nSaid: \"Push it.\""));
    assert_eq!(written[1], "Current: local/w2:p2\nSaid: \"Run the tests.\"");
    assert!(written[2].starts_with("Sessions:\nlocal/w2:p2 | Mac |"));
}

#[tokio::test]
async fn the_words_come_with_who_said_them_when_the_voices_are_told_apart() {
    let claude = fake::Claude::new(|_| r#"{"to": "nobody"}"#.into());
    let router = VoiceRouter::new(claude.spawn());
    router
        .route(RouteRequest {
            voice: Some("voice B, 0.05 like you".into()),
            ..request("Et maintenant la météo.", sessions())
        })
        .await;
    assert!(
        claude.written(0)[0]
            .ends_with("Said [voice B, 0.05 like you]: \"Et maintenant la météo.\"")
    );
    assert!(
        ROUTER_SYSTEM_PROMPT.contains(
            "Words of another voice are \"nobody\" unless they clearly speak to an agent"
        )
    );
}

#[tokio::test]
async fn a_new_background_session_gets_the_list_again() {
    let claude = fake::Claude::new(|_| {
        r#"{"to": "open", "pane": "desktop/w1J:p1", "say": "IGA-184"}"#.into()
    });
    let router = VoiceRouter::new(claude.spawn());
    router.route(request("Go to 184.", sessions())).await;
    // The session ends: the next request starts another one.
    claude.exit(0);
    while router.0.worker.running() {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        router.route(request("Go to 184.", sessions())).await,
        VoiceRoute::Open {
            pane: "desktop/w1J:p1".into(),
            say: "IGA-184".into()
        }
    );
    assert!(claude.written(1)[0].starts_with("Sessions:\n"));
}

#[tokio::test(start_paused = true)]
async fn a_router_too_slow_to_answer_leaves_it_to_the_agent_on_screen() {
    let router = VoiceRouter::with(fake::silent(), Arc::new(TokioClock::starting_at(0)));
    assert_eq!(
        router
            .route(RouteRequest {
                timeout_ms: Some(20),
                ..request("Go to 184.", sessions())
            })
            .await,
        VoiceRoute::Current
    );
}

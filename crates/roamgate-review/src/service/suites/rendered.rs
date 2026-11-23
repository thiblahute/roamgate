//! server/src/review/service.rendered.test.ts: a file or a site shown
//! rendered, and threads on it.

use serde_json::json;

use super::*;
use crate::model::ReviewTarget;
use crate::parse::{describe_target, parse_render_part, parse_review_target, rendered_place};

fn setup() -> Kit {
    let host = Host {
        diff: Some(Box::new(|_, _, _| {
            Box::pin(async { Err(LoadError::Failed("a rendered review has no diff".into())) })
        })),
        ..Host::default()
    };
    kit(
        host,
        Options {
            delivery_delay_ms: Some(10),
            ..Options::default()
        },
    )
}

#[test]
fn a_rendered_review_shows_a_relative_path_or_an_http_url() {
    let parse = |value: serde_json::Value| parse_review_target(Some(&value));
    assert_eq!(
        parse(json!({"kind": "rendered", "path": "docs/plan.md"}))
            .unwrap()
            .to_value(),
        json!({"kind": "rendered", "path": "docs/plan.md"})
    );
    assert_eq!(
        parse(json!({"kind": "rendered", "url": "http://localhost:8080/docs/#top"}))
            .unwrap()
            .to_value(),
        json!({"kind": "rendered", "url": "http://localhost:8080/docs/"})
    );
    for bad in [
        json!({"kind": "rendered"}),
        json!({"kind": "rendered", "path": "a.md", "url": "http://x/"}),
        json!({"kind": "rendered", "path": "/etc/passwd"}),
        json!({"kind": "rendered", "path": "../out.md"}),
        json!({"kind": "rendered", "url": "javascript:alert(1)"}),
        json!({"kind": "rendered", "url": "file:///etc/passwd"}),
        json!({"kind": "rendered", "url": "http://user:pw@host/"}),
    ] {
        assert!(parse(bad.clone()).is_err(), "{bad}");
    }
    let plan = parse(json!({"kind": "rendered", "path": "docs/plan.md"})).unwrap();
    assert!(matches!(plan, ReviewTarget::Rendered { .. }));
    assert_eq!(describe_target(&plan), "docs/plan.md");
}

#[tokio::test]
async fn the_same_file_is_one_review_another_file_is_another() {
    let Kit { service, .. } = setup();
    let open = |path: &str| {
        service
            .open(&json!({"connectionId": "local", "root": "/repo",
                "target": {"kind": "rendered", "path": path}, "raise": false}))
            .unwrap()
            .session
            .id
    };
    assert_eq!(open("a.md"), open("a.md"));
    assert_ne!(open("a.md"), open("b.md"));
}

#[test]
fn a_rendered_part_is_checked_fractions_a_saved_snapshot() {
    let snapshot = "/home/u/.config/roamgate/reviews/images/0123456789abcdef/fedcba9876543210.png";
    let part = parse_render_part(&json!({"quote": " the words ",
        "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}, "graphic": "diagram 1",
        "element": "queue2", "moment": "2.4 s", "snapshot": snapshot}))
    .unwrap();
    assert_eq!(
        to_json(&part),
        json!({"quote": "the words", "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
            "graphic": "diagram 1", "element": "queue2", "moment": "2.4 s", "snapshot": snapshot})
    );
    for bad in [
        json!({"region": {"x": 1.5, "y": 0}}),
        json!({"region": {"x": 0.8, "y": 0, "w": 0.5, "h": 0}}),
        json!({"snapshot": "/etc/passwd"}),
        json!({}),
    ] {
        assert!(parse_render_part(&bad).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn the_agent_gets_the_source_lines_the_region_the_moment_and_the_snapshot() {
    let Kit { service, host, .. } = setup();
    let session = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "rendered", "path": "docs/design.md"}, "agent": "Claude", "paneId": "w1:p2"}))
        .unwrap()
        .session;
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "docs/design.md", "line": 12,
            "endLine": 30, "side": "new", "text": "```mermaid", "render": {"graphic": "diagram 1",
            "region": {"x": 0.25, "y": 0.5, "w": 0.1, "h": 0.2}, "element": "decoder", "moment": "1.5 s",
            "snapshot": "/r/images/0123456789abcdef/fedcba9876543210.png"}},
            "text": "This arrow is backwards."}))
        .await
        .unwrap();
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "docs/design.md", "line": 3,
            "side": "new", "render": {"quote": "the words I mean"}}, "text": "Say why."}))
        .await
        .unwrap();
    sleep(60).await;
    let prompt = host.texts().join("\n");
    assert!(prompt.contains("on docs/design.md:12-30 as rendered (diagram 1, region x 25% y 50% w 10% h 20% of it, element \"decoder\", at 1.5 s):"), "{prompt}");
    assert!(prompt.contains("(what I saw there: /r/images/0123456789abcdef/fedcba9876543210.png)"));
    assert!(prompt.contains("on docs/design.md:3 as rendered, about this part:\n  > the words I mean"));
    assert!(prompt.contains("This arrow is backwards."));
}

#[test]
fn a_page_of_a_site_is_named_by_its_url() {
    let part = |value: serde_json::Value| serde_json::from_value(value).unwrap();
    assert_eq!(
        rendered_place(&part(json!({"url": "/tutorials/basic.html", "selector": "main > h2:nth-of-type(3)"}))),
        "page /tutorials/basic.html, at `main > h2:nth-of-type(3)`"
    );
    assert_eq!(
        rendered_place(&part(json!({"region": {"x": 0.5, "y": 0.5, "w": 0, "h": 0}}))),
        "point x 50% y 50% of it"
    );
}

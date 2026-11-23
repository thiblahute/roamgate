//! The chat itself: comments, tool details, turns kept on disk, sessions.

use super::*;

#[tokio::test]
async fn comments_on_a_ranger_chat_come_as_a_message_in_it_answered_in_their_threads() {
    let replies = list::<Value>();
    let hold = flag();
    let release = Arc::new(tokio::sync::Notify::new());
    let recorded = replies.clone();
    let threads: ChatThreads = Arc::new(move |session, params, _signal| {
        recorded.lock().unwrap().push(json!({
            "session": session,
            "comment": params["comment_id"],
            "text": params["text"],
        }));
        ok(ToolResult::text("Answered in thread [abcd1234]."))
    });
    let (held, released) = (hold.clone(), release.clone());
    let f = setup_with(
        move |d| {
            d.set_run(move |input| {
                let (hold, release) = (held.clone(), released.clone());
                async move {
                    if hold.load(Ordering::SeqCst) {
                        release.notified().await;
                    }
                    if input.text().contains("[Roamgate review")
                        && input.input.handlers.threads.is_some()
                    {
                        let receipt = input
                            .threads(
                                json!({"comment_id": "abcd1234", "text": "The one in index.ts."}),
                            )
                            .await?;
                        input.message(&format!("Answered. {}", receipt.text));
                    } else {
                        input.message("Hello");
                    }
                    Ok(vec![json!({"persisted": true})])
                }
            });
        },
        Setup {
            chat_threads: Some(threads),
            ..Setup::default()
        },
    );
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let session = f.peek()["session_id"].as_str().unwrap().to_owned();
    assert!(!session.is_empty());
    let comments = "[Roamgate review \"Chat with Ranger\" (chat)]\nA comment from me on parts of your messages in this chat:\n\n- [abcd1234] on your message, about this part:\n  > It waits.\n  Which conflict?";
    f.service
        .deliver_chat_comments(&session, comments)
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    let messages = f.peek()["messages"].as_array().unwrap().clone();
    assert_matches(
        &messages[messages.len() - 2],
        json!({"role": "user", "text": comments}),
    );
    assert_eq!(
        messages.last().unwrap()["text"],
        "Answered. Answered in thread [abcd1234]."
    );
    assert_eq!(
        *replies.lock().unwrap(),
        vec![json!({"session": session, "comment": "abcd1234", "text": "The one in index.ts."})]
    );
    // Another chat's comments wait until it shows: "busy" makes the review
    // try again.
    assert_err(
        f.service
            .deliver_chat_comments("another-chat", comments)
            .await,
        "busy",
    );
    // While Ranger answers, they wait in its queue for the next turn.
    hold.store(true, Ordering::SeqCst);
    f.handle("send", json!({"text": "Status?", "request_id": "slow"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == true).await;
    f.service
        .deliver_chat_comments(&session, comments)
        .await
        .unwrap();
    let queue = f.peek()["queue"].clone();
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_matches(&queue[0], json!({"mode": "follow_up", "text": comments}));
    hold.store(false, Ordering::SeqCst);
    release.notify_waiters();
    until(|| {
        let peek = f.peek();
        peek["running"] == false && peek["queue"].as_array().is_none_or(Vec::is_empty)
    })
    .await;
    assert_eq!(replies.lock().unwrap().len(), 2);
    f.finish().await;
}

#[tokio::test]
async fn a_turn_without_chat_threads_offers_ranger_no_thread_tool() {
    let offered = slot::<bool>();
    let seen = offered.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap() = Some(input.input.handlers.threads.is_some());
                input.message("Hello");
                Ok(vec![json!({"persisted": true})])
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "Hi", "request_id": "plain"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(*offered.lock().unwrap(), Some(false));
    f.finish().await;
}

#[tokio::test]
async fn persists_finalized_turns_privately_and_restores_deduplication_after_reconnect_restart() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "persisted", "text": "Remember this"}),
    )
    .await
    .unwrap();
    until(|| f.last_snapshot()["running"] == false).await;
    let saved = f.saved();
    assert_eq!(saved["entries"], json!([{"persisted": true}]));
    assert_eq!(saved["messages"][1]["text"], "Hello");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&f.directory), 0o700);
        assert_eq!(mode(&f.state_path()), 0o600);
    }
    f.service.dispose().await;
    let restored = f.restart(f.driver.clone());
    let snapshot = restored
        .handle(
            "send",
            json!({"request_id": "persisted", "text": "duplicate after restart"}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
    assert_err(
        restored
            .handle(
                "send",
                json!({
                    "request_id": "escape",
                    "text": "read outside",
                    "scope": [{"connection_id": "local", "workspace_id": "outside"}],
                }),
            )
            .await,
        "authorized",
    );
    restored.handle("new_session", json!({})).await.unwrap();
    assert_eq!(restored.snapshot().await.unwrap()["messages"], json!([]));
    f.finish().await;
}

//! The cases of `server/src/bridge/websocket-send.test.ts`, one for one,
//! against the Rust flow.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};

use roamgate_ws::flow::*;

/// The TS `createWebSocket()` mock.
#[derive(Default)]
struct Mock {
    sent: Vec<String>,
    compressed: Vec<bool>,
    closes: Vec<Option<(u16, String)>>,
    /// Successive buffered amounts, one per read; the last one repeats.
    buffered: RefCell<VecDeque<usize>>,
    last_buffered: Cell<usize>,
    send_result: Option<Result<SendStatus, String>>,
    now: u64,
    cleanups: usize,
    warnings: Vec<String>,
    /// The socket's `readyState` (0 is taken as open).
    ready_state: u8,
}

impl Mock {
    fn with_buffered(amounts: &[usize]) -> Self {
        let mock = Mock::default();
        mock.buffered.replace(amounts.iter().copied().collect());
        mock
    }

    fn set_buffered(&self, amount: usize) {
        self.buffered.borrow_mut().clear();
        self.last_buffered.set(amount);
    }

    fn sent_chars(&self) -> usize {
        self.sent.iter().map(|frame| utf16_len(frame)).sum()
    }
}

impl Target for Mock {
    fn buffered_amount(&self) -> usize {
        if let Some(next) = self.buffered.borrow_mut().pop_front() {
            self.last_buffered.set(next);
        }
        self.last_buffered.get()
    }

    fn send(&mut self, payload: &str, compress: bool) -> Result<SendStatus, String> {
        self.sent.push(payload.to_owned());
        self.compressed.push(compress);
        self.send_result.clone().unwrap_or(Ok(SendStatus::Sent))
    }

    fn close(&mut self, close: Option<(u16, &str)>) -> Result<(), String> {
        self.closes
            .push(close.map(|(code, reason)| (code, reason.to_owned())));
        Ok(())
    }

    fn closing(&self) -> bool {
        self.ready_state >= 2
    }

    fn now_ms(&self) -> u64 {
        self.now
    }

    fn cleanup(&mut self) {
        self.cleanups += 1;
    }

    fn warn(&mut self, message: String) {
        self.warnings.push(message);
    }
}

fn send(flow: &mut Flow, mock: &mut Mock, payload: &str, context: &str, key: Option<&str>) -> bool {
    flow.send(mock, payload.to_owned(), context, key)
}

/// `sendWithObservability`: one "payload" in context "terminal frame".
fn observe(flow: &mut Flow, mock: &mut Mock, context: &str) -> (usize, bool, Vec<String>) {
    let cleanups = mock.cleanups;
    let warnings = mock.warnings.len();
    let result = send(flow, mock, "payload", context, None);
    (
        mock.cleanups - cleanups,
        result,
        mock.warnings[warnings..].to_vec(),
    )
}

fn slow() -> Option<(u16, String)> {
    Some((SLOW_CLOSE.0, SLOW_CLOSE.1.to_owned()))
}

#[test]
fn compresses_only_terminal_frames_at_or_above_the_byte_threshold() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    let cases = [
        ("terminal-frame", "a".repeat(COMPRESSION_MIN_BYTES - 1)),
        ("terminal-frame", "a".repeat(COMPRESSION_MIN_BYTES)),
        ("terminal-frame", "\u{e9}".repeat(COMPRESSION_MIN_BYTES / 2)),
        ("terminal-clipboard", "a".repeat(COMPRESSION_MIN_BYTES)),
        ("message", "a".repeat(COMPRESSION_MIN_BYTES)),
    ];
    for (context, payload) in cases {
        assert!(send(&mut flow, &mut mock, &payload, context, None));
    }
    assert_eq!(mock.compressed, [false, true, true, false, false]);
}

#[test]
fn keeps_the_connection_open_when_a_message_is_queued_under_backpressure() {
    for status in [SendStatus::Backpressure, SendStatus::Sent] {
        let mut mock = Mock {
            send_result: Some(Ok(status)),
            ..Mock::default()
        };
        let mut flow = Flow::new(0);
        assert_eq!(
            observe(&mut flow, &mut mock, "terminal frame"),
            (0, true, vec![])
        );
        assert_eq!(mock.sent, ["payload"]);
        assert!(mock.closes.is_empty());
    }
}

#[test]
fn closes_a_slow_connection_when_a_queued_send_crosses_the_hard_limit() {
    let buffered = BACKPRESSURE_HARD_LIMIT_BYTES + 1;
    let mut mock = Mock::with_buffered(&[0, buffered]);
    mock.send_result = Some(Ok(SendStatus::Backpressure));
    let mut flow = Flow::new(0);
    assert_eq!(
        observe(&mut flow, &mut mock, "terminal frame"),
        (
            1,
            false,
            vec![format!(
                "[bridge] closing slow websocket during terminal frame: {buffered}B buffered"
            )]
        )
    );
    assert_eq!(mock.sent, ["payload"]);
    assert_eq!(mock.closes, [slow()]);
}

#[test]
fn cleans_up_when_a_message_is_dropped_because_of_a_connection_issue() {
    let mut mock = Mock {
        send_result: Some(Ok(SendStatus::Dropped)),
        ..Mock::default()
    };
    let mut flow = Flow::new(0);
    assert_eq!(
        observe(&mut flow, &mut mock, "workspace event"),
        (
            1,
            false,
            vec!["[bridge] websocket send dropped during workspace event".to_owned()]
        )
    );
    assert_eq!(mock.sent, ["payload"]);
    assert_eq!(mock.closes, [None]);
}

#[test]
fn a_reply_made_after_the_browser_left_is_skipped_quietly() {
    // A connection error answered once its page had closed: Bun would drop
    // it (send gives 0); it is not a send failure.
    for ready_state in [2, 3] {
        let mut mock = Mock {
            send_result: Some(Ok(SendStatus::Dropped)),
            ready_state,
            ..Mock::default()
        };
        let mut flow = Flow::new(0);
        assert_eq!(
            observe(&mut flow, &mut mock, "connections-mutation-error"),
            (1, false, vec![])
        );
        assert!(mock.sent.is_empty());
        assert!(mock.closes.is_empty());
    }
    let mut open = Mock {
        ready_state: 1,
        ..Mock::default()
    };
    let mut flow = Flow::new(0);
    assert!(observe(&mut flow, &mut open, "terminal frame").1);
    assert_eq!(open.sent, ["payload"]);
}

#[test]
fn uses_the_buffered_amount_to_close_a_client_past_the_hard_limit() {
    let buffered = BACKPRESSURE_HARD_LIMIT_BYTES + 1;
    let mut mock = Mock::with_buffered(&[buffered]);
    let mut flow = Flow::new(0);
    assert_eq!(
        observe(&mut flow, &mut mock, "terminal frame"),
        (
            1,
            false,
            vec![format!(
                "[bridge] closing slow websocket during terminal frame: {buffered}B buffered"
            )]
        )
    );
    assert!(mock.sent.is_empty());
    assert_eq!(mock.closes, [slow()]);
}

#[test]
fn logs_and_cleans_up_when_sending_fails() {
    let mut mock = Mock {
        send_result: Some(Err("socket closed".into())),
        ..Mock::default()
    };
    let mut flow = Flow::new(0);
    assert_eq!(
        observe(&mut flow, &mut mock, "terminal frame"),
        (
            1,
            false,
            vec!["[bridge] websocket send failed during terminal frame: socket closed".to_owned()]
        )
    );
    assert_eq!(mock.sent, ["payload"]);
    assert_eq!(mock.closes, [None]);
}

// Terminal frame coalescing under backpressure.

fn frame(flow: &mut Flow, mock: &mut Mock, payload: &str, key: &str) -> bool {
    send(flow, mock, payload, "terminal-frame", Some(key))
}

#[test]
fn holds_a_frame_back_instead_of_queueing_it_once_the_socket_is_behind() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1]);
    let mut flow = Flow::new(0);
    assert!(frame(&mut flow, &mut mock, "frame-1", "terminal:t1"));
    assert!(mock.sent.is_empty());
    assert!(mock.closes.is_empty());
}

#[test]
fn keeps_only_the_newest_held_frame_per_key() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1, COALESCE_LIMIT_BYTES + 1, 0]);
    let mut flow = Flow::new(0);
    frame(&mut flow, &mut mock, "frame-1", "terminal:t1");
    frame(&mut flow, &mut mock, "frame-2", "terminal:t1");
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    assert_eq!(mock.sent, ["frame-2"]);
}

#[test]
fn compresses_the_newest_held_repaint_when_the_socket_drains() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1, COALESCE_LIMIT_BYTES + 1, 0]);
    let mut flow = Flow::new(0);
    let newest = "b".repeat(COMPRESSION_MIN_BYTES);
    frame(
        &mut flow,
        &mut mock,
        &"a".repeat(COMPRESSION_MIN_BYTES),
        "terminal:t1",
    );
    frame(&mut flow, &mut mock, &newest, "terminal:t1");
    assert!(mock.sent.is_empty());
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    assert_eq!(mock.sent, [newest]);
    assert_eq!(mock.compressed, [true]);
}

#[test]
fn keeps_held_frames_for_different_terminals_apart() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1, COALESCE_LIMIT_BYTES + 1, 0, 0]);
    let mut flow = Flow::new(0);
    frame(&mut flow, &mut mock, "frame-a", "terminal:t1");
    frame(&mut flow, &mut mock, "frame-b", "terminal:t2");
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    mock.sent.sort();
    assert_eq!(mock.sent, ["frame-a", "frame-b"]);
}

#[test]
fn sends_immediately_while_the_socket_keeps_up() {
    let mut mock = Mock::with_buffered(&[0]);
    let mut flow = Flow::new(0);
    assert!(frame(&mut flow, &mut mock, "frame-1", "terminal:t1"));
    assert_eq!(mock.sent, ["frame-1"]);
    assert!(mock.closes.is_empty());
}

#[test]
fn leaves_messages_without_a_coalesce_key_alone() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1]);
    let mut flow = Flow::new(0);
    // An RPC reply is not a repaint; dropping it would lose the answer.
    assert!(send(&mut flow, &mut mock, "rpc-reply", "file-list", None));
    assert_eq!(mock.sent, ["rpc-reply"]);
}

// Dropping a held frame when it goes stale.

#[test]
fn a_dropped_payload_is_never_sent_on_drain() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1]);
    let mut flow = Flow::new(0);
    send(
        &mut flow,
        &mut mock,
        "stale-100x30",
        "message",
        Some("terminal:t1"),
    );
    flow.drop_coalesced("terminal:t1");
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    assert!(mock.sent.is_empty());
}

#[test]
fn dropping_one_terminal_leaves_another_terminals_held_frame_alone() {
    let mut mock = Mock::with_buffered(&[COALESCE_LIMIT_BYTES + 1]);
    let mut flow = Flow::new(0);
    send(
        &mut flow,
        &mut mock,
        "t1-frame",
        "message",
        Some("terminal:t1"),
    );
    send(
        &mut flow,
        &mut mock,
        "t2-frame",
        "message",
        Some("terminal:t2"),
    );
    flow.drop_coalesced("terminal:t1");
    mock.set_buffered(0);
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    assert_eq!(mock.sent, ["t2-frame"]);
}

// A large buffer on a slow link.

#[test]
fn keeps_the_socket_while_one_large_reply_drains() {
    let buffered = BACKPRESSURE_LIMIT_BYTES * 14 / 10;
    let mut mock = Mock::with_buffered(&[buffered]);
    let mut flow = Flow::new(0);
    assert!(observe(&mut flow, &mut mock, "terminal frame").1);
    for second in 1..=40 {
        mock.now = second * 1000;
        mock.set_buffered(buffered - second as usize * 1000);
        assert!(observe(&mut flow, &mut mock, "terminal frame").1);
    }
    assert!(mock.closes.is_empty());
}

#[test]
fn closes_a_socket_whose_buffer_stops_draining() {
    let buffered = BACKPRESSURE_LIMIT_BYTES + 1;
    let mut mock = Mock::with_buffered(&[buffered]);
    let mut flow = Flow::new(0);
    assert!(observe(&mut flow, &mut mock, "terminal frame").1);
    mock.now = STALL_TIMEOUT_MS;
    assert!(observe(&mut flow, &mut mock, "terminal frame").1);
    mock.now = STALL_TIMEOUT_MS + 1000;
    let (_, result, warnings) = observe(&mut flow, &mut mock, "terminal frame");
    assert!(!result);
    assert_eq!(
        warnings,
        [format!(
            "[bridge] closing slow websocket during terminal frame: {buffered}B buffered, not draining for 31s"
        )]
    );
    assert_eq!(mock.closes, [slow()]);
}

#[test]
fn a_drain_counts_as_progress() {
    let buffered = BACKPRESSURE_LIMIT_BYTES + 1;
    let mut mock = Mock::with_buffered(&[buffered]);
    let mut flow = Flow::new(0);
    observe(&mut flow, &mut mock, "terminal frame");
    mock.now = STALL_TIMEOUT_MS - 1000;
    flow.flush_coalesced(&mut mock, COMPRESSED_CONTEXT);
    mock.now = STALL_TIMEOUT_MS + 1000;
    assert!(observe(&mut flow, &mut mock, "terminal frame").1);
    assert!(mock.closes.is_empty());
}

/// Reassembles what a browser would hand to its message handler.
fn reassemble(frames: &[String]) -> Vec<String> {
    let mut parts: HashMap<String, String> = HashMap::new();
    let mut messages = Vec::new();
    for frame in frames {
        let Some(rest) = frame.strip_prefix(CHUNK_MARKER) else {
            messages.push(frame.clone());
            continue;
        };
        let (id, rest) = rest.split_once(':').unwrap();
        let (last, text) = rest.split_once(':').unwrap();
        parts.entry(id.to_owned()).or_default().push_str(text);
        if last == "1" {
            messages.push(parts.remove(id).unwrap());
        }
    }
    messages
}

// Flow control.

fn ack_all(flow: &mut Flow, mock: &mut Mock) -> bool {
    let text = format!("{{\"ack\":{}}}", mock.sent_chars());
    flow.receive_ack(mock, &text)
}

#[test]
fn stays_off_until_the_browser_acknowledges_for_older_pages() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    let large = "x".repeat(FLOW_INITIAL_WINDOW_CHARS as usize * 3);
    send(&mut flow, &mut mock, &large, "message", None);
    assert_eq!(mock.sent, [large]);
}

#[test]
fn tells_which_contexts_a_socket_was_sent_the_most_for() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    send(&mut flow, &mut mock, &"a".repeat(30), "review", None);
    send(&mut flow, &mut mock, &"b".repeat(10), "agent-list", None);
    send(
        &mut flow,
        &mut mock,
        &"c".repeat(20),
        "terminal-frame",
        Some("t1"),
    );
    send(&mut flow, &mut mock, &"d".repeat(5), "bridge-ping", None);
    assert_eq!(
        flow.stats(0).heaviest,
        "review:30,terminal-frame:20,agent-list:10"
    );
}

#[test]
fn treats_only_acknowledgements_as_acknowledgements() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    assert!(!flow.receive_ack(&mut mock, r#"{"id":"1","method":"bridge.ping"}"#));
    assert!(flow.receive_ack(&mut mock, r#"{"ack":0}"#));
    assert!(flow.stats(0).enabled);
}

#[test]
fn keeps_about_a_window_in_flight_and_sends_a_large_message_in_chunks() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let large = format!(r#"{{"id":"r","result":"{}"}}"#, "y".repeat(2_000_000));
    assert!(send(&mut flow, &mut mock, &large, "review", None));
    assert!(
        mock.sent
            .iter()
            .all(|frame| utf16_len(frame) <= FLOW_CHUNK_CHARS + 16)
    );
    assert!(mock.sent_chars() < FLOW_INITIAL_WINDOW_CHARS as usize + FLOW_CHUNK_CHARS + 16);
    // A pong goes out at once, between the chunks.
    let pong = r#"{"id":"ping","result":{"ok":true}}"#;
    send(&mut flow, &mut mock, pong, "bridge-ping", None);
    assert_eq!(mock.sent.last().unwrap(), pong);
    while reassemble(&mock.sent).len() < 2 {
        ack_all(&mut flow, &mut mock);
    }
    assert_eq!(reassemble(&mock.sent), [pong.to_owned(), large]);
}

#[test]
fn never_splits_a_surrogate_pair_across_chunks() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let large = format!(
        "{}\u{1f600}{}",
        "a".repeat(FLOW_CHUNK_CHARS - 1),
        "b".repeat(FLOW_CHUNK_CHARS)
    );
    send(&mut flow, &mut mock, &large, "message", None);
    while reassemble(&mock.sent).is_empty() {
        ack_all(&mut flow, &mut mock);
    }
    // The pair would straddle the first boundary, so that chunk stops short.
    let first = mock.sent[0].strip_prefix(CHUNK_MARKER).unwrap();
    assert_eq!(
        utf16_len(first.split_once(':').unwrap().1) - 2,
        FLOW_CHUNK_CHARS - 1
    );
    assert_eq!(reassemble(&mock.sent), [large]);
}

#[test]
fn keeps_a_contexts_messages_in_order_behind_a_queued_one() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let large = "L".repeat(FLOW_INITIAL_WINDOW_CHARS as usize * 2);
    send(&mut flow, &mut mock, &large, "review", None);
    send(&mut flow, &mut mock, "small review update", "review", None);
    send(&mut flow, &mut mock, "other", "agent-list", None);
    assert_eq!(mock.sent.last().unwrap(), "other");
    while reassemble(&mock.sent).len() < 3 {
        ack_all(&mut flow, &mut mock);
    }
    assert_eq!(
        reassemble(&mock.sent),
        ["other".to_owned(), large, "small review update".to_owned()]
    );
}

#[test]
fn interleaves_a_queued_reply_of_another_context_with_a_large_one() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let large = "L".repeat(FLOW_INITIAL_WINDOW_CHARS as usize * 4);
    let medium = "M".repeat(FLOW_URGENT_CHARS * 2);
    send(&mut flow, &mut mock, &large, "review", None);
    send(&mut flow, &mut mock, &medium, "agent-list", None);
    ack_all(&mut flow, &mut mock);
    ack_all(&mut flow, &mut mock);
    assert_eq!(reassemble(&mock.sent), [medium]);
}

#[test]
fn holds_terminal_repaints_while_the_window_is_full_and_sends_the_newest_on_ack() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    send(
        &mut flow,
        &mut mock,
        &"x".repeat(FLOW_INITIAL_WINDOW_CHARS as usize * 2),
        "review",
        None,
    );
    let before = mock.sent.len();
    send(
        &mut flow,
        &mut mock,
        "frame 1",
        "terminal-frame",
        Some("t1"),
    );
    send(
        &mut flow,
        &mut mock,
        "frame 2",
        "terminal-frame",
        Some("t1"),
    );
    assert_eq!(mock.sent.len(), before);
    while !mock.sent.iter().any(|frame| frame == "frame 2") {
        ack_all(&mut flow, &mut mock);
    }
    assert!(!mock.sent.iter().any(|frame| frame == "frame 1"));
}

#[test]
fn replaces_a_queued_large_snapshot_with_a_newer_one_that_has_the_same_key() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    send(
        &mut flow,
        &mut mock,
        &"x".repeat(FLOW_INITIAL_WINDOW_CHARS as usize * 2),
        "terminal-output",
        None,
    );
    let first = format!(r#"{{"review":"{}"}}"#, "1".repeat(FLOW_CHUNK_CHARS * 2));
    let second = format!(r#"{{"review":"{}"}}"#, "2".repeat(FLOW_CHUNK_CHARS * 2));
    send(&mut flow, &mut mock, &first, "review", Some("review:s1"));
    send(&mut flow, &mut mock, &second, "review", Some("review:s1"));
    while reassemble(&mock.sent).len() < 2 {
        ack_all(&mut flow, &mut mock);
    }
    assert_eq!(reassemble(&mock.sent)[1..], [second]);
}

#[test]
fn a_large_snapshot_sent_while_the_window_has_room_still_leaves_in_chunks() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let snapshot = format!(r#"{{"review":"{}"}}"#, "s".repeat(FLOW_CHUNK_CHARS * 3));
    send(&mut flow, &mut mock, &snapshot, "review", Some("review:s1"));
    assert!(mock.sent.last().unwrap().starts_with(CHUNK_MARKER));
    while reassemble(&mock.sent).is_empty() {
        ack_all(&mut flow, &mut mock);
    }
    assert_eq!(reassemble(&mock.sent), [snapshot]);
}

#[test]
fn closes_a_browser_that_stops_reading_past_the_queue_limit() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    let chunk = "q".repeat(8 * 1024 * 1024);
    let mut result = true;
    for _ in 0..=FLOW_QUEUE_LIMIT_CHARS / chunk.len() {
        result = send(&mut flow, &mut mock, &chunk, "review", None);
    }
    assert!(!result);
    assert_eq!(mock.closes, [slow()]);
}

// Beyond the TS cases: the window follows the measured rate.

#[test]
fn sizes_the_window_to_a_second_of_the_measured_rate() {
    let mut mock = Mock::default();
    let mut flow = Flow::new(0);
    ack_all(&mut flow, &mut mock);
    send(
        &mut flow,
        &mut mock,
        &"r".repeat(20_000_000),
        "review",
        None,
    );
    // A link taking 2 MB a second: acknowledge what it would have received.
    let mut received = 0usize;
    for step in 1..=40u64 {
        mock.now = step * 100;
        received = (received + 200_000).min(mock.sent_chars());
        let ack = format!("{{\"ack\":{received}}}");
        flow.receive_ack(&mut mock, &ack);
    }
    let window = flow.stats(mock.now).window;
    assert!((1_500_000.0..=2_500_000.0).contains(&window), "{window}");
    assert!(ack_all(&mut flow, &mut mock));
    assert!(!flow.receive_ack(&mut mock, "{\"acknowledged\":1}"));
    assert!(flow.receive_ack(&mut mock, "{\"ack\":Infinity}"));
}

#[test]
fn preserves_the_first_cleanup_snapshot_until_close_handling_completes() {
    use std::sync::Arc;
    let socket = 1u64;
    let cleanups = Cell::new(0);
    let mut cleanup = CleanupTracker::new(|cleaned: &u64| {
        assert_eq!(*cleaned, socket);
        cleanups.set(cleanups.get() + 1);
        ("c1", vec!["term_1"])
    });
    let first = cleanup.cleanup(&socket);
    assert!(Arc::ptr_eq(&cleanup.cleanup(&socket), &first));
    assert!(Arc::ptr_eq(&cleanup.complete(&socket), &first));
    assert_eq!(cleanups.get(), 1);
    assert!(!Arc::ptr_eq(&cleanup.cleanup(&socket), &first));
    assert_eq!(cleanups.get(), 2);
}

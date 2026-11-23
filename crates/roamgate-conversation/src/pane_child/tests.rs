//! pane-child.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_agents::{js, obj};
use serde_json::{Value, json};

use super::*;
use crate::testing::claude_input_kind;
use crate::time::TokioClock;

fn holder() -> String {
    "a".repeat(32)
}

fn status() -> HolderStatus {
    HolderStatus {
        holder_id: holder(),
        applied: 0,
        child: 0,
        child_alive: false,
        child_pid: 0,
        log_size: 0,
        epoch_offset: 0,
        api_key: None,
    }
}

/// A holder's log, as the holder writes it: whole lines, byte offsets.
#[derive(Default, Clone)]
struct HolderLog {
    text: Arc<Mutex<String>>,
}

impl HolderLog {
    fn size(&self) -> i64 {
        self.text.lock().unwrap().len() as i64
    }
    fn add(&self, values: &[Value]) -> i64 {
        let mut text = self.text.lock().unwrap();
        let start = text.len() as i64;
        for value in values {
            match value {
                Value::String(line) => text.push_str(line),
                other => text.push_str(&js::stringify(other)),
            }
            text.push('\n');
        }
        start
    }
    fn from(&self, offset: i64) -> String {
        self.text.lock().unwrap()[offset as usize..].to_owned()
    }
}

struct Setup {
    channel: HolderChannel,
    log: HolderLog,
    work: Arc<AtomicUsize>,
    offsets: Arc<Mutex<Vec<u64>>>,
}

impl Setup {
    /// The holder sends what Roamgate asks for, from where it asks.
    fn send(&self, offset: i64) -> Option<i64> {
        let data = self.log.from(offset);
        self.channel.receive(HolderOutput {
            holder_id: &holder(),
            offset,
            end: self.log.size(),
            data: &data,
        })
    }
}

fn setup(saved: Option<HolderSaved>) -> Setup {
    let work = Arc::new(AtomicUsize::new(0));
    let offsets = Arc::new(Mutex::new(Vec::new()));
    let counted = work.clone();
    let noted = offsets.clone();
    let channel = HolderChannel::new(HolderChannelOptions {
        pane_id: "p1".into(),
        saved,
        on_work: Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
        on_offset: Some(Arc::new(move |_id: &str, offset| {
            noted.lock().unwrap().push(offset)
        })),
        on_pending: None,
        input_kind: Arc::new(claude_input_kind),
        log: None,
        clock: Arc::new(TokioClock::starting_at(0)),
    });
    Setup {
        channel,
        log: HolderLog::default(),
        work,
        offsets,
    }
}

async fn collect(child: &Arc<dyn HeadlessProcess>, count: usize) -> Vec<String> {
    let mut out = Vec::new();
    while out.len() < count {
        match child.next_line().await {
            Some(line) => out.push(line),
            None => break,
        }
    }
    out
}

fn commands(channel: &HolderChannel) -> Option<Vec<Value>> {
    channel
        .work()
        .commands
        .map(|commands| commands.into_iter().map(Value::Object).collect())
}

fn attach() -> HolderSpawn {
    HolderSpawn {
        command: Obj::new(),
        attach_only: true,
        signal: None,
        timeout_ms: None,
    }
}

fn start(command: Value, timeout_ms: Option<u64>) -> HolderSpawn {
    HolderSpawn {
        command: command.as_object().cloned().unwrap_or_default(),
        attach_only: false,
        signal: None,
        timeout_ms,
    }
}

async fn settle() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

#[test]
fn is_read_from_the_poll_s_fields_none_from_an_older_holder() {
    let form = Form::from_pairs(&[
        ("holder_id", &holder()),
        ("applied", "3"),
        ("child", "2"),
        ("child_alive", "1"),
        ("child_pid", "77"),
        ("log_size", "1200"),
        ("epoch_offset", "800"),
    ]);
    assert_eq!(
        parse_holder_status(&form),
        Some(HolderStatus {
            holder_id: holder(),
            applied: 3,
            child: 2,
            child_alive: true,
            child_pid: 77,
            log_size: 1200,
            epoch_offset: 800,
            api_key: None,
        })
    );
    assert_eq!(
        parse_holder_status(&Form::from_pairs(&[("pane", "p1")])),
        None
    );
    assert_eq!(
        parse_holder_status(&Form::from_pairs(&[
            ("holder_id", &holder()),
            ("applied", "-1")
        ])),
        None
    );
}

#[test]
fn says_what_claude_code_answered_about_the_pane_s_api_key_never_the_key() {
    let id = holder();
    let api_key = |value: Option<&str>| {
        let mut pairs = vec![
            ("holder_id", id.as_str()),
            ("applied", "0"),
            ("child", "0"),
            ("log_size", "0"),
            ("epoch_offset", "0"),
        ];
        if let Some(value) = value {
            pairs.push(("api_key", value));
        }
        parse_holder_status(&Form::from_pairs(&pairs))
            .unwrap()
            .api_key
    };
    assert_eq!(api_key(Some("")), Some(HolderApiKey::None));
    assert_eq!(api_key(Some("approved")), Some(HolderApiKey::Approved));
    assert_eq!(api_key(Some("rejected")), Some(HolderApiKey::Rejected));
    assert_eq!(api_key(Some("new")), Some(HolderApiKey::New));
    // An older holder (or anything else): unknown, nothing asked.
    assert_eq!(api_key(None), None);
    assert_eq!(api_key(Some("sk-ant-api03-xyz")), None);
}

#[tokio::test(start_paused = true)]
async fn starts_a_child_through_the_holder_and_relays_both_ways() {
    let s = setup(None);
    s.channel.update(status());
    assert!(s.channel.has_work());
    assert_eq!(
        s.channel.work(),
        HolderWork {
            commands: None,
            output_from: Some(0)
        }
    );
    let channel = s.channel.clone();
    let spawning = tokio::spawn(async move {
        channel
            .spawn(start(json!({"argv": ["claude"]}), None))
            .await
    });
    settle().await;
    assert_eq!(s.work.load(Ordering::SeqCst), 1);
    assert_eq!(
        commands(&s.channel),
        Some(vec![json!({"op": "start", "argv": ["claude"], "seq": 1})])
    );
    // The holder applied it and says so: it is not sent again.
    s.channel.update(HolderStatus {
        applied: 1,
        child: 1,
        child_alive: true,
        ..status()
    });
    assert_eq!(commands(&s.channel), None);
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 99})]);
    s.log.add(&[json!({"type": "system", "subtype": "init"})]);
    assert_eq!(s.send(0), Some(s.log.size()));
    let child = spawning.await.unwrap().unwrap().unwrap();
    assert_eq!(child.pid(), Some(99));
    assert_eq!(child.replayed(), 0);
    child
        .write("{\"type\":\"user\",\"message\":\"hi\"}\n")
        .unwrap();
    child
        .write("{\"type\":\"control_response\",\"response\":{\"request_id\":\"r1\"}}")
        .unwrap();
    assert_eq!(
        commands(&s.channel),
        Some(vec![
            json!({"op": "input", "child": 1, "line": "{\"type\":\"user\",\"message\":\"hi\"}", "kind": "user", "seq": 2}),
            json!({"op": "input", "child": 1, "line": "{\"type\":\"control_response\",\"response\":{\"request_id\":\"r1\"}}", "kind": "control_response", "request_id": "r1", "seq": 3}),
        ])
    );
    assert_eq!(
        collect(&child, 1).await,
        ["{\"type\":\"system\",\"subtype\":\"init\"}"]
    );
    child.end();
    assert!(child.write("{}").unwrap_err().contains("closing"));
    assert_eq!(
        commands(&s.channel).unwrap().last().cloned(),
        Some(json!({"op": "end", "child": 1, "seq": 4}))
    );
    let at = s.log.size();
    s.log.add(&[
        json!({"type": "result"}),
        json!({"type": "roamgate_child", "event": "exit", "child": 1, "code": 0}),
    ]);
    s.send(at);
    assert_eq!(child.exited().await, 0);
}

#[test]
fn takes_each_line_once_a_resend_or_a_gap_is_refused() {
    let s = setup(None);
    s.channel.update(status());
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 1})]);
    let second = s.log.add(&[json!({"type": "a"})]);
    assert_eq!(s.send(0), Some(s.log.size()));
    // Sent again (its answer was lost): refused, told where to go on.
    assert_eq!(s.send(second), Some(s.log.size()));
    let third = s.log.add(&[json!({"type": "b"})]);
    s.log.add(&[json!({"type": "c"})]);
    // Ahead of what was read: refused too.
    assert_eq!(
        s.channel.receive(HolderOutput {
            holder_id: &holder(),
            offset: third + 10,
            end: s.log.size(),
            data: ""
        }),
        Some(third)
    );
    // Another holder's log: nothing to do with this one.
    assert_eq!(
        s.channel.receive(HolderOutput {
            holder_id: &"b".repeat(32),
            offset: 0,
            end: 0,
            data: ""
        }),
        None
    );
}

#[tokio::test(start_paused = true)]
async fn a_new_reader_reads_on_from_where_the_one_before_stopped() {
    // The runtime before read the child's start and two lines.
    let first = setup(None);
    first.channel.update(status());
    first.log.add(&[
        json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5}),
        json!({"type": "user", "text": "work"}),
        json!({"type": "system", "subtype": "status", "status": "requesting"}),
    ]);
    first.send(0);
    let read = first.log.size();
    assert!(first.channel.spawn(attach()).await.unwrap().is_some());
    first.channel.update(HolderStatus {
        child: 1,
        child_alive: true,
        log_size: read as u64,
        ..status()
    });
    let saved = first.channel.save().unwrap();
    assert_eq!(saved.to_value(), json!({"id": holder(), "offset": read}));
    // Meanwhile the child went on.
    let carried = HolderSaved {
        pending: vec![obj! {"seq" => 7i64, "op" => "input", "child" => 1i64, "line" => "{}"}],
        ..saved
    };
    let second = setup(Some(carried));
    second.log.add(&[Value::String(
        first.log.from(0).trim_end_matches('\n').to_owned(),
    )]);
    second
        .log
        .add(&[json!({"type": "stream_event", "text": "more"})]);
    second.channel.update(HolderStatus {
        applied: 6,
        child: 1,
        child_alive: true,
        log_size: second.log.size() as u64,
        epoch_offset: 0,
        ..status()
    });
    // Asked from the child's start; the unconfirmed write is sent again
    // under its own number (the holder takes it once).
    let work = second.channel.work();
    assert_eq!(work.output_from, Some(0));
    assert_eq!(
        work.commands
            .map(|commands| commands.into_iter().map(Value::Object).collect::<Vec<_>>()),
        Some(vec![
            json!({"seq": 7, "op": "input", "child": 1, "line": "{}"})
        ])
    );
    let channel = second.channel.clone();
    let attaching = tokio::spawn(async move { channel.spawn(attach()).await });
    settle().await;
    second.send(0);
    let child = attaching.await.unwrap().unwrap().unwrap();
    assert_eq!(child.replayed(), 2);
    assert_eq!(
        collect(&child, 3).await,
        [
            "{\"type\":\"user\",\"text\":\"work\"}",
            "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\"}",
            "{\"type\":\"stream_event\",\"text\":\"more\"}",
        ]
    );
    // New commands number on after the carried one.
    child.kill();
    let last = commands(&second.channel).unwrap().last().cloned().unwrap();
    assert_eq!(last["seq"], 8);
    assert_eq!(last["op"], "kill");
}

#[tokio::test(start_paused = true)]
async fn a_reader_with_a_saved_state_reads_on_from_where_its_lines_were_handled() {
    let first = setup(None);
    first.channel.update(status());
    let epoch = first
        .log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5})]);
    first.log.add(&[
        json!({"type": "user", "text": "work"}),
        json!({"type": "system", "subtype": "status", "status": "requesting"}),
    ]);
    first.send(0);
    let child = first.channel.spawn(attach()).await.unwrap().unwrap();
    let start_line = "{\"type\":\"roamgate_child\",\"event\":\"start\",\"child\":1,\"pid\":5}\n";
    // Nothing handled yet but its start line.
    assert_eq!(
        child.position(),
        Some(Some(HolderPosition {
            child: 1,
            epoch_offset: epoch as u64,
            offset: start_line.len() as u64
        }))
    );
    // Only once the next line is asked for is the one before handled.
    let handled = (start_line.len() + "{\"type\":\"user\",\"text\":\"work\"}\n".len()) as u64;
    child.next_line().await;
    child.next_line().await;
    let position = child.position().unwrap().unwrap();
    assert_eq!(position.offset, handled);
    let saved = HolderSaved {
        resume: Some(HolderResume {
            child: position.child,
            epoch_offset: position.epoch_offset,
            offset: position.offset,
            state: json!({"said": "work"}),
        }),
        ..first.channel.save().unwrap()
    };
    let second = setup(Some(saved));
    second.log.add(&[Value::String(
        first.log.from(0).trim_end_matches('\n').to_owned(),
    )]);
    second
        .log
        .add(&[json!({"type": "stream_event", "text": "more"})]);
    second.channel.update(HolderStatus {
        child: 1,
        child_alive: true,
        child_pid: 5,
        log_size: second.log.size() as u64,
        epoch_offset: epoch as u64,
        ..status()
    });
    // Asked from the first line not handled: nothing is read again.
    assert_eq!(
        second.channel.work(),
        HolderWork {
            commands: None,
            output_from: Some(handled as i64)
        }
    );
    let channel = second.channel.clone();
    let attaching = tokio::spawn(async move { channel.spawn(attach()).await });
    settle().await;
    second.send(handled as i64);
    let next = attaching.await.unwrap().unwrap().unwrap();
    assert_eq!(next.replayed(), 0);
    assert_eq!(next.resume(), Some(json!({"said": "work"})));
    assert_eq!(next.pid(), Some(5));
    assert_eq!(
        collect(&next, 2).await,
        [
            "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\"}",
            "{\"type\":\"stream_event\",\"text\":\"more\"}",
        ]
    );
}

#[test]
fn a_saved_state_of_another_child_or_a_log_cut_short_is_read_again_from_the_child_s_start() {
    let resume = HolderResume {
        child: 1,
        epoch_offset: 0,
        offset: 40,
        state: json!({}),
    };
    let saved = |id: String| HolderSaved {
        id,
        offset: 40,
        pending: vec![],
        resume: Some(resume.clone()),
    };
    for (child, epoch_offset, log_size) in [(2, 0, 100), (1, 10, 100), (1, 0, 20)] {
        let s = setup(Some(saved(holder())));
        s.channel.update(HolderStatus {
            child_alive: true,
            child,
            epoch_offset,
            log_size,
            ..status()
        });
        assert_eq!(s.channel.work().output_from, Some(epoch_offset as i64));
    }
    // Another holder: its own log, from its child's start.
    let other = setup(Some(saved("b".repeat(32))));
    other.channel.update(HolderStatus {
        child: 1,
        child_alive: true,
        log_size: 100,
        epoch_offset: 0,
        ..status()
    });
    assert_eq!(other.channel.work().output_from, Some(0));
}

#[tokio::test(start_paused = true)]
async fn a_child_that_ended_unread_is_handed_over_one_read_already_is_not() {
    let log = HolderLog::default();
    log.add(&[
        json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5}),
        json!({"type": "roamgate_child", "event": "exit", "child": 1, "code": 0}),
    ]);
    let seen = log.size();
    log.add(&[
        json!({"type": "roamgate_child", "event": "start", "child": 2, "pid": 6}),
        json!({"type": "user", "text": "work"}),
        json!({"type": "roamgate_child", "event": "exit", "child": 2, "code": 137}),
    ]);
    let ready = setup(Some(HolderSaved {
        id: holder(),
        offset: seen as u64,
        pending: vec![],
        resume: None,
    }));
    ready
        .log
        .add(&[Value::String(log.from(0).trim_end_matches('\n').to_owned())]);
    ready.channel.update(HolderStatus {
        child: 2,
        log_size: ready.log.size() as u64,
        epoch_offset: seen as u64,
        ..status()
    });
    let channel = ready.channel.clone();
    let attaching = tokio::spawn(async move { channel.spawn(attach()).await });
    settle().await;
    ready.send(seen);
    let child = attaching.await.unwrap().unwrap().unwrap();
    assert_eq!(child.replayed(), 0);
    assert_eq!(child.exited().await, 137);
    assert_eq!(
        collect(&child, 1).await,
        ["{\"type\":\"user\",\"text\":\"work\"}"]
    );
    // Nothing else unread: an attach finds nothing.
    assert!(ready.channel.spawn(attach()).await.unwrap().is_none());
}

#[tokio::test(start_paused = true)]
async fn a_line_longer_than_a_chunk_comes_in_pieces_put_back_together() {
    let s = setup(None);
    s.channel.update(status());
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 3})]);
    // A tool result with screenshots: past the socket's 1 MiB, with
    // characters of several bytes where the pieces are cut.
    let big = js::stringify(&json!({"type": "user", "text": "é€😀".repeat(200_000)}));
    let big_start = s.log.add(&[Value::String(big.clone())]);
    s.log.add(&[json!({"type": "after"})]);
    let bytes = s.log.from(0).into_bytes();
    // As the holder cuts: whole lines, else a piece between characters.
    let holder_piece = |from: usize, size: usize| -> &[u8] {
        let mut piece = &bytes[from..bytes.len().min(from + size)];
        if let Some(newline) = piece.iter().rposition(|byte| *byte == b'\n') {
            piece = &piece[..=newline];
        } else {
            let mut back = 1;
            while piece[piece.len() - back] & 0xc0 == 0x80 {
                back += 1;
            }
            let lead = piece[piece.len() - back];
            let size = if lead >= 0xf0 {
                4
            } else if lead >= 0xe0 {
                3
            } else if lead >= 0xc0 {
                2
            } else {
                1
            };
            if back < size {
                piece = &piece[..piece.len() - back];
            }
        }
        piece
    };
    let mut at = 0usize;
    let mut pieces = 0;
    let mut mid_line = None;
    while at < bytes.len() {
        let piece = holder_piece(at, 256 * 1024 + 1);
        let answer = s.channel.receive(HolderOutput {
            holder_id: &holder(),
            offset: at as i64,
            end: (at + piece.len()) as i64,
            data: std::str::from_utf8(piece).unwrap(),
        });
        at += piece.len();
        assert_eq!(answer, Some(at as i64));
        pieces += 1;
        if at as i64 > big_start && (at as i64) < big_start + big.len() as i64 && mid_line.is_none()
        {
            mid_line = Some(s.channel.save().unwrap().offset);
        }
    }
    assert!(pieces > 4);
    // Saved mid-line, a later reader starts at that line, not inside it.
    assert_eq!(mid_line, Some(big_start as u64));
    assert_eq!(s.channel.save().unwrap().offset, s.log.size() as u64);
    assert_eq!(
        s.offsets.lock().unwrap().last().copied(),
        Some(s.log.size() as u64)
    );
    let child = s.channel.spawn(attach()).await.unwrap().unwrap();
    assert_eq!(
        collect(&child, 2).await,
        [big, "{\"type\":\"after\"}".to_owned()]
    );
}

#[tokio::test(start_paused = true)]
async fn a_log_that_cannot_be_read_is_given_up_its_child_ends_reading_starts_at_its_end() {
    let s = setup(None);
    s.log.add(&[
        json!({"type": "roamgate_child", "event": "start", "child": 3, "pid": 9}),
        json!({"type": "stream_event", "text": "stuck here"}),
    ]);
    s.channel.update(HolderStatus {
        applied: 4,
        child: 3,
        child_alive: true,
        log_size: s.log.size() as u64,
        ..status()
    });
    // Nothing of the log comes through: the attach gives up.
    let error = s
        .channel
        .spawn(HolderSpawn {
            timeout_ms: Some(20),
            ..attach()
        })
        .await
        .err()
        .unwrap();
    assert_eq!(error.message, "The pane holder's log could not be read");
    let before = s.work.load(Ordering::SeqCst);
    let channel = s.channel.clone();
    let abandoning = tokio::spawn(async move { channel.abandon(1000, None).await });
    settle().await;
    assert!(s.work.load(Ordering::SeqCst) > before);
    assert_eq!(
        commands(&s.channel),
        Some(vec![json!({"op": "kill", "child": 3, "seq": 5})])
    );
    // The holder killed it: its exit is in the log, which goes on.
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "exit", "child": 3, "code": -9})]);
    s.channel.update(HolderStatus {
        applied: 5,
        child: 3,
        child_alive: false,
        log_size: s.log.size() as u64,
        ..status()
    });
    abandoning.await.unwrap().unwrap();
    assert_eq!(
        s.channel.work(),
        HolderWork {
            commands: None,
            output_from: Some(s.log.size())
        }
    );
    assert_eq!(
        s.channel.save().unwrap().to_value(),
        json!({"id": holder(), "offset": s.log.size()})
    );
    // A new child starts on the session.
    let channel = s.channel.clone();
    let spawning = tokio::spawn(async move {
        channel
            .spawn(start(json!({"argv": ["claude"]}), None))
            .await
    });
    settle().await;
    assert_eq!(
        commands(&s.channel),
        Some(vec![json!({"op": "start", "argv": ["claude"], "seq": 6})])
    );
    let at = s.log.size();
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 4, "pid": 10})]);
    s.channel.update(HolderStatus {
        applied: 6,
        child: 4,
        child_alive: true,
        log_size: s.log.size() as u64,
        ..status()
    });
    s.send(at);
    assert_eq!(spawning.await.unwrap().unwrap().unwrap().pid(), Some(10));
}

#[tokio::test(start_paused = true)]
async fn a_start_the_holder_refuses_fails_at_once() {
    let s = setup(None);
    s.channel.update(status());
    let channel = s.channel.clone();
    let spawning = tokio::spawn(async move {
        channel
            .spawn(start(json!({"argv": ["claude"]}), None))
            .await
    });
    settle().await;
    s.log.add(&[json!({"type": "roamgate_child", "event": "refused", "reason": "claude did not start: not found"})]);
    s.send(0);
    assert_eq!(
        spawning.await.unwrap().err().unwrap().message,
        "claude did not start: not found"
    );
}

#[tokio::test(start_paused = true)]
async fn another_holder_in_the_pane_ends_the_children_of_the_one_before() {
    let s = setup(None);
    s.channel.update(status());
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5})]);
    s.send(0);
    let child = s.channel.spawn(attach()).await.unwrap().unwrap();
    s.channel.update(HolderStatus {
        holder_id: "c".repeat(32),
        ..status()
    });
    assert_eq!(child.exited().await, -1);
}

#[tokio::test(start_paused = true)]
async fn the_user_messages_its_child_never_got_are_handed_back_at_its_exit() {
    let s = setup(None);
    s.channel.update(status());
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5})]);
    s.send(0);
    let child = s.channel.spawn(attach()).await.unwrap().unwrap();
    let user = |text: &str| js::stringify(&json!({"type": "user", "uuid": text, "message": text}));
    // Applied; dropped (its stdin closed); and one still unconfirmed when
    // the child exits (the holder drops it too, after the exit line).
    child.write(&user("applied")).unwrap();
    child.write(&user("dropped")).unwrap();
    child.write(&user("late")).unwrap();
    s.channel.update(HolderStatus {
        applied: 2,
        child: 1,
        child_alive: true,
        ..status()
    });
    let at = s.log.size();
    s.log.add(&[
        json!({"type": "roamgate_input", "seq": 1, "child": 1, "kind": "user"}),
        json!({"type": "roamgate_input", "seq": 2, "child": 1, "kind": "user", "dropped": true}),
        json!({"type": "roamgate_child", "event": "exit", "child": 1, "code": 0}),
    ]);
    s.send(at);
    assert_eq!(child.exited().await, 0);
    assert_eq!(
        child.undelivered(),
        Some(vec![user("dropped"), user("late")])
    );
    // Nothing more goes to a child that is gone.
    assert_eq!(commands(&s.channel), None);
}

#[tokio::test(start_paused = true)]
async fn each_new_command_is_saved_at_once() {
    let saves = Arc::new(AtomicUsize::new(0));
    let counted = saves.clone();
    let channel = HolderChannel::new(HolderChannelOptions {
        pane_id: "p1".into(),
        saved: None,
        on_work: Arc::new(|| {}),
        on_offset: None,
        on_pending: Some(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        })),
        input_kind: Arc::new(claude_input_kind),
        log: None,
        clock: Arc::new(TokioClock::starting_at(0)),
    });
    let log = HolderLog::default();
    channel.update(status());
    log.add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5})]);
    let data = log.from(0);
    channel.receive(HolderOutput {
        holder_id: &holder(),
        offset: 0,
        end: log.size(),
        data: &data,
    });
    let child = channel.spawn(attach()).await.unwrap().unwrap();
    child
        .write("{\"type\":\"user\",\"message\":\"hi\"}")
        .unwrap();
    assert_eq!(saves.load(Ordering::SeqCst), 1);
    assert_eq!(channel.save().unwrap().pending.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_long_log_read_slowly_is_waited_for_while_it_comes_in() {
    let s = setup(None);
    s.log
        .add(&[json!({"type": "roamgate_child", "event": "start", "child": 1, "pid": 5})]);
    for index in 0..6 {
        s.log.add(&[json!({"type": "line", "index": index})]);
    }
    s.channel.update(HolderStatus {
        log_size: s.log.size() as u64,
        child: 1,
        child_alive: true,
        ..status()
    });
    let channel = s.channel.clone();
    let attaching = tokio::spawn(async move {
        channel
            .spawn(HolderSpawn {
                timeout_ms: Some(40),
                ..attach()
            })
            .await
    });
    // One line every 25 ms: more than the timeout in all, never stalled.
    let text = s.log.from(0);
    let mut offset = 0i64;
    for line in text.split('\n').filter(|line| !line.is_empty()) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let end = offset + line.len() as i64 + 1;
        let data = format!("{line}\n");
        s.channel.receive(HolderOutput {
            holder_id: &holder(),
            offset,
            end,
            data: &data,
        });
        offset = end;
    }
    let child = attaching.await.unwrap().unwrap().unwrap();
    assert_eq!(child.catch_up(), 6);
}

#[tokio::test(start_paused = true)]
async fn a_holder_that_never_answers_is_no_process() {
    let s = setup(None);
    let error = s
        .channel
        .spawn(start(json!({}), Some(5)))
        .await
        .err()
        .unwrap();
    assert!(error.message.contains("not connected"));
}

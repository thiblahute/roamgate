//! Sending to one browser socket: coalescing, flow control with chunks and
//! acknowledgements, and the slow-socket rules.
//!
//! This is the behaviour of `server/src/bridge/websocket-send.ts`, kept
//! decision for decision so both servers put the same frames on the wire.
//! It is a plain state machine: the socket it writes to is a [`Target`], and
//! time comes from [`Target::now_ms`], so tests drive it without a socket.
//!
//! Counts of characters are UTF-16 code units, as the browser counts them in
//! its acknowledgements (`{"ack":n}`).

use std::collections::VecDeque;

/// A send buffer past this limit is only a problem once it stops draining.
pub const BACKPRESSURE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
/// Past this the socket is closed regardless.
pub const BACKPRESSURE_HARD_LIMIT_BYTES: usize = 64 * 1024 * 1024;
pub const STALL_TIMEOUT_MS: u64 = 30_000;
pub const COALESCE_LIMIT_BYTES: usize = 1024 * 1024;
/// Terminal frames this size (UTF-8 bytes) or larger are compressed.
pub const COMPRESSION_MIN_BYTES: usize = 1024;
/// The only context whose messages are compressed.
pub const COMPRESSED_CONTEXT: &str = "terminal-frame";
pub const FLOW_INITIAL_WINDOW_CHARS: f64 = 256.0 * 1024.0;
pub const FLOW_MIN_WINDOW_CHARS: f64 = 64.0 * 1024.0;
pub const FLOW_MAX_WINDOW_CHARS: f64 = 8.0 * 1024.0 * 1024.0;
/// How long the data in flight may take to arrive, at the measured rate.
pub const FLOW_TARGET_DELAY_MS: f64 = 1000.0;
/// A rate sample spans at least this much time.
pub const FLOW_RATE_SAMPLE_MS: u64 = 250;
/// Messages up to this size skip the queue.
pub const FLOW_URGENT_CHARS: usize = 16 * 1024;
/// Queued messages leave in chunks of this size.
pub const FLOW_CHUNK_CHARS: usize = 64 * 1024;
/// A browser this far behind is not reading: close instead of queueing more.
pub const FLOW_QUEUE_LIMIT_CHARS: usize = 64 * 1024 * 1024;
/// First character of a chunk frame; no JSON message starts with it.
pub const CHUNK_MARKER: char = '\u{1}';
const ACK_PREFIX: &str = "{\"ack\":";
/// Close code and reason for a socket that does not keep up.
pub const SLOW_CLOSE: (u16, &str) = (1013, "client too slow");

/// What a write did, as Bun's `ServerWebSocket.send` reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendStatus {
    /// Written without waiting.
    Sent,
    /// Accepted, but queued behind earlier data.
    Backpressure,
    /// Not accepted: the connection is gone.
    Dropped,
}

/// The socket a [`Flow`] writes to.
pub trait Target {
    /// Bytes accepted by [`Target::send`] and not yet written to the peer.
    fn buffered_amount(&self) -> usize;
    /// Writes one text frame, compressed when `compress` and the extension
    /// was negotiated.
    fn send(&mut self, payload: &str, compress: bool) -> Result<SendStatus, String>;
    /// Starts the close handshake; `None` closes without a status code.
    fn close(&mut self, close: Option<(u16, &str)>) -> Result<(), String>;
    /// Closing or closed (`readyState` 2 or 3): a send is skipped quietly.
    fn closing(&self) -> bool {
        false
    }
    /// Milliseconds on a monotonic clock.
    fn now_ms(&self) -> u64;
    /// The owner's teardown for this socket; may be called more than once.
    fn cleanup(&mut self);
    fn warn(&mut self, message: String);
    fn debug(&mut self, _message: &str, _gap_ms: u64, _unacked: f64) {}
}

#[derive(Debug)]
struct Item {
    /// Set when the payload leaves in chunks.
    chunk_id: Option<u64>,
    /// A newer payload with this key replaces this one until it starts.
    coalesce_key: Option<String>,
    /// Byte offset of what is still to send.
    offset: usize,
    payload: String,
    /// UTF-16 length of `payload`.
    chars: usize,
}

/// What a socket sent and what its browser confirmed, for close logs.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowStats {
    pub acked: f64,
    pub enabled: bool,
    /// The three contexts the bridge asked to send the most for.
    pub heaviest: String,
    /// Since the browser last acknowledged; `None` when it never did.
    pub last_ack_age_ms: Option<u64>,
    pub queued: usize,
    pub rate: u64,
    pub sent: u64,
    pub window: f64,
}

/// The sending state of one socket.
#[derive(Debug)]
pub struct Flow {
    acked: f64,
    /// Characters asked to send, by context, in first-asked order.
    asked: Vec<(String, u64)>,
    last_ack_at: Option<u64>,
    /// In flight was at least half the window at the last acknowledgement.
    busy: bool,
    enabled: bool,
    last_buffered: usize,
    last_progress_at: u64,
    next_chunk_id: u64,
    /// Per context, so a context's messages stay in order; served in turn.
    queues: VecDeque<(String, VecDeque<Item>)>,
    queued_chars: usize,
    /// Characters per second, 0 until measured.
    rate: f64,
    sample_acked: f64,
    sample_at: u64,
    sent: u64,
    window: f64,
    /// Terminal repaints held back while the socket is behind, newest per key.
    held: Vec<(String, String)>,
}

/// Runs a socket's teardown once however many paths ask for it (a failed
/// send, the close handler), and gives every caller the same snapshot
/// until the close handling completes.
pub struct CleanupTracker<K, S, F> {
    snapshots: std::collections::HashMap<K, std::sync::Arc<S>>,
    perform: F,
}

impl<K, S, F> CleanupTracker<K, S, F>
where
    K: Eq + std::hash::Hash + Clone,
    F: FnMut(&K) -> S,
{
    pub fn new(perform: F) -> Self {
        Self {
            snapshots: std::collections::HashMap::new(),
            perform,
        }
    }

    /// The socket's teardown, run the first time only.
    pub fn cleanup(&mut self, socket: &K) -> std::sync::Arc<S> {
        if let Some(snapshot) = self.snapshots.get(socket) {
            return snapshot.clone();
        }
        let snapshot = std::sync::Arc::new((self.perform)(socket));
        self.snapshots.insert(socket.clone(), snapshot.clone());
        snapshot
    }

    /// The close handling is done: the snapshot, then forgotten.
    pub fn complete(&mut self, socket: &K) -> std::sync::Arc<S> {
        let snapshot = self.cleanup(socket);
        self.snapshots.remove(socket);
        snapshot
    }
}

/// UTF-16 length of a string, as JavaScript's `length` gives it.
pub fn utf16_len(text: &str) -> usize {
    text.bytes()
        .map(|byte| match byte {
            0x80..=0xbf => 0,
            0xf0..=0xff => 2,
            _ => 1,
        })
        .sum()
}

/// The end (byte offset) of the longest run from `start` that fits in
/// `max_chars` UTF-16 units without splitting a character, and its length.
fn chunk_end(text: &str, start: usize, max_chars: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut end = start;
    let mut chars = 0;
    while end < bytes.len() {
        let (width, units) = match bytes[end] {
            0x00..=0x7f => (1, 1),
            0xf0..=0xff => (4, 2),
            0xe0..=0xef => (3, 1),
            _ => (2, 1),
        };
        if chars + units > max_chars {
            break;
        }
        chars += units;
        end += width;
    }
    (end, chars)
}

/// `Math.round` for the non-negative values used here.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Number(text)` for an acknowledgement count: blank is 0, anything that is
/// not a decimal number is NaN.
fn js_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    let valid = trimmed
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}

impl Flow {
    pub fn new(now_ms: u64) -> Self {
        Flow {
            acked: 0.0,
            asked: Vec::new(),
            last_ack_at: None,
            busy: false,
            enabled: false,
            last_buffered: 0,
            last_progress_at: now_ms,
            next_chunk_id: 1,
            queues: VecDeque::new(),
            queued_chars: 0,
            rate: 0.0,
            sample_acked: 0.0,
            sample_at: now_ms,
            sent: 0,
            window: FLOW_INITIAL_WINDOW_CHARS,
            held: Vec::new(),
        }
    }

    fn in_flight(&self) -> f64 {
        self.sent as f64 - self.acked
    }

    fn congested(&self) -> bool {
        self.enabled && self.in_flight() >= self.window
    }

    /// Characters waiting in the queues.
    pub fn queued_chars(&self) -> usize {
        self.queued_chars
    }

    pub fn stats(&self, now_ms: u64) -> FlowStats {
        let mut asked: Vec<&(String, u64)> = self.asked.iter().collect();
        // Stable, like Array.prototype.sort: ties keep first-asked order.
        asked.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        FlowStats {
            acked: self.acked,
            enabled: self.enabled,
            heaviest: asked
                .iter()
                .take(3)
                .map(|(context, chars)| format!("{context}:{chars}"))
                .collect::<Vec<_>>()
                .join(","),
            last_ack_age_ms: self.last_ack_at.map(|at| now_ms.saturating_sub(at)),
            queued: self.queued_chars,
            rate: js_round(self.rate) as u64,
            sent: self.sent,
            window: self.window,
        }
    }

    fn has_queue(&self, context: &str) -> bool {
        self.queues.iter().any(|(name, _)| name == context)
    }

    fn hold(&mut self, key: &str, payload: String) {
        match self.held.iter_mut().find(|(held, _)| held == key) {
            Some(entry) => entry.1 = payload,
            None => self.held.push((key.to_owned(), payload)),
        }
    }

    /// Sends one message. `coalesce_key` marks a payload that fully replaces
    /// an earlier one with the same key, so a backlogged socket keeps only
    /// the newest. Returns false once the socket was closed.
    pub fn send(
        &mut self,
        target: &mut impl Target,
        payload: String,
        context: &str,
        coalesce_key: Option<&str>,
    ) -> bool {
        // A reply made after the browser left (a connection error answered
        // once its page closed) is not a send failure.
        if target.closing() {
            target.cleanup();
            return false;
        }
        let chars = utf16_len(&payload);
        match self.asked.iter_mut().find(|(name, _)| name == context) {
            Some(entry) => entry.1 += chars as u64,
            None => self.asked.push((context.to_owned(), chars as u64)),
        }
        if let Some(key) = coalesce_key {
            if target.buffered_amount() > COALESCE_LIMIT_BYTES || self.congested() {
                self.hold(key, payload);
                return true;
            }
            self.held.retain(|(held, _)| held != key);
            // A large replacement (a review's snapshot) still leaves in chunks.
            if self.enabled && chars > FLOW_CHUNK_CHARS {
                return self.enqueue(target, payload, chars, context, Some(key));
            }
            return self.write_frame(target, &payload, chars, context);
        }
        if self.enabled && (chars > FLOW_URGENT_CHARS || self.has_queue(context)) {
            return self.enqueue(target, payload, chars, context, None);
        }
        self.write_frame(target, &payload, chars, context)
    }

    fn enqueue(
        &mut self,
        target: &mut impl Target,
        payload: String,
        chars: usize,
        context: &str,
        coalesce_key: Option<&str>,
    ) -> bool {
        let position = self.queues.iter().position(|(name, _)| name == context);
        if let (Some(key), Some(index)) = (coalesce_key, position) {
            let waiting = self.queues[index]
                .1
                .iter_mut()
                .find(|item| item.coalesce_key.as_deref() == Some(key) && item.offset == 0);
            if let Some(item) = waiting {
                self.queued_chars = self.queued_chars + chars - item.chars;
                item.payload = payload;
                item.chars = chars;
                if item.chunk_id.is_none() && chars > FLOW_CHUNK_CHARS {
                    item.chunk_id = Some(self.next_chunk_id);
                    self.next_chunk_id += 1;
                }
                return self.pump(target);
            }
        }
        let chunk_id = (chars > FLOW_CHUNK_CHARS).then(|| {
            self.next_chunk_id += 1;
            self.next_chunk_id - 1
        });
        let item = Item {
            chunk_id,
            coalesce_key: coalesce_key.map(str::to_owned),
            offset: 0,
            payload,
            chars,
        };
        match position {
            Some(index) => self.queues[index].1.push_back(item),
            None => self
                .queues
                .push_back((context.to_owned(), VecDeque::from([item]))),
        }
        self.queued_chars += chars;
        if self.queued_chars > FLOW_QUEUE_LIMIT_CHARS {
            let in_flight = self.in_flight();
            target.warn(format!(
                "[bridge] closing slow websocket during {context}: {} characters queued, {in_flight} unacknowledged",
                self.queued_chars
            ));
            self.queues.clear();
            self.queued_chars = 0;
            target.cleanup();
            close_socket(target, Some(SLOW_CLOSE), context);
            return false;
        }
        self.pump(target)
    }

    /// The next frame of a queued item, its UTF-16 length, the characters of
    /// the payload it carries, and whether the item is done.
    fn take_frame(item: &mut Item) -> (String, usize, usize, bool) {
        let Some(chunk_id) = item.chunk_id else {
            item.offset = item.payload.len();
            return (item.payload.clone(), item.chars, item.chars, true);
        };
        // A character is never split: a surrogate pair split across two text
        // frames would reach the browser as two replacement characters.
        let start = item.offset;
        let (end, chars) = chunk_end(&item.payload, start, FLOW_CHUNK_CHARS);
        let done = end == item.payload.len();
        let frame = format!(
            "{CHUNK_MARKER}{chunk_id}:{}:{}",
            u8::from(done),
            &item.payload[start..end]
        );
        item.offset = end;
        // The marker, the decimal id and ":d:" are ASCII: one unit a byte.
        let prefix_chars = frame.len() - (end - start);
        (frame, prefix_chars + chars, chars, done)
    }

    /// Sends queued frames while the window has room, one frame per context
    /// in turn so a small reply is not stuck behind a large one of another.
    fn pump(&mut self, target: &mut impl Target) -> bool {
        while self.queued_chars > 0 && self.in_flight() < self.window {
            let Some((context, mut items)) = self.queues.pop_front() else {
                break;
            };
            let Some(item) = items.front_mut() else {
                continue;
            };
            let (frame, frame_chars, payload_chars, done) = Self::take_frame(item);
            self.queued_chars -= payload_chars;
            if done {
                items.pop_front();
            }
            if !items.is_empty() {
                self.queues.push_back((context.clone(), items));
            }
            if !self.write_frame(target, &frame, frame_chars, &context) {
                self.queues.clear();
                self.queued_chars = 0;
                return false;
            }
        }
        true
    }

    fn write_frame(
        &mut self,
        target: &mut impl Target,
        payload: &str,
        chars: usize,
        context: &str,
    ) -> bool {
        if self.close_slow(target, context) {
            return false;
        }
        let compress = context == COMPRESSED_CONTEXT && payload.len() >= COMPRESSION_MIN_BYTES;
        match target.send(payload, compress) {
            Ok(SendStatus::Dropped) => {
                target.cleanup();
                target.warn(format!("[bridge] websocket send dropped during {context}"));
                close_socket(target, None, context);
                false
            }
            Ok(status) => {
                self.sent += chars as u64;
                !(status == SendStatus::Backpressure && self.close_slow(target, context))
            }
            Err(error) => {
                target.cleanup();
                target.warn(format!(
                    "[bridge] websocket send failed during {context}: {error}"
                ));
                close_socket(target, None, context);
                false
            }
        }
    }

    /// Closes a socket whose buffer stopped draining, or grew past the hard
    /// limit. A buffer that is large but shrinking belongs to a slow link
    /// catching up.
    fn close_slow(&mut self, target: &mut impl Target, context: &str) -> bool {
        let buffered = target.buffered_amount();
        let now = target.now_ms();
        if buffered <= BACKPRESSURE_LIMIT_BYTES || buffered < self.last_buffered {
            self.last_progress_at = now;
        }
        self.last_buffered = buffered;
        let stalled = now.saturating_sub(self.last_progress_at);
        if buffered <= BACKPRESSURE_HARD_LIMIT_BYTES && stalled <= STALL_TIMEOUT_MS {
            return false;
        }
        target.warn(if buffered > BACKPRESSURE_HARD_LIMIT_BYTES {
            format!("[bridge] closing slow websocket during {context}: {buffered}B buffered")
        } else {
            format!(
                "[bridge] closing slow websocket during {context}: {buffered}B buffered, not draining for {}s",
                js_round(stalled as f64 / 1000.0)
            )
        });
        target.cleanup();
        close_socket(target, Some(SLOW_CLOSE), context);
        true
    }

    /// Drops a held payload that went stale (its terminal resized).
    pub fn drop_coalesced(&mut self, key: &str) {
        self.held.retain(|(held, _)| held != key);
    }

    /// Sends the frames held back while the socket was behind. Called when
    /// the socket drains; a drain is progress, whatever the buffer reads next.
    pub fn flush_coalesced(&mut self, target: &mut impl Target, context: &str) {
        self.last_progress_at = target.now_ms();
        if self.held.is_empty() {
            return;
        }
        for (key, payload) in std::mem::take(&mut self.held) {
            // A failed send has already closed the socket; stop there.
            if !self.send(target, payload, context, Some(&key)) {
                return;
            }
        }
    }

    /// Handles a browser's acknowledgement (`{"ack":<characters received>}`),
    /// which also turns flow control on. Returns false for any other message.
    pub fn receive_ack(&mut self, target: &mut impl Target, text: &str) -> bool {
        let Some(rest) = text.strip_prefix(ACK_PREFIX) else {
            return false;
        };
        let mut digits = rest.chars();
        digits.next_back();
        let received = js_number(digits.as_str());
        if !received.is_finite() {
            return true;
        }
        let now = target.now_ms();
        if let Some(last) = self.last_ack_at
            && now.saturating_sub(last) > 5_000
            && self.in_flight() > 0.0
        {
            let unacked = self.in_flight();
            target.debug("acknowledgements resumed", now - last, unacked);
        }
        self.last_ack_at = Some(now);
        if !self.enabled {
            self.enabled = true;
            self.sample_at = now;
            self.sample_acked = self.acked;
        }
        self.acked = self.acked.max(received.min(self.sent as f64));
        if !self.busy {
            self.sample_at = now;
            self.sample_acked = self.acked;
        } else if now.saturating_sub(self.sample_at) >= FLOW_RATE_SAMPLE_MS {
            // Only a link kept busy shows its rate. Sizing the window to a
            // fixed delay at that rate lets it grow while data arrives faster
            // than the target and shrink once queueing delay builds up.
            let sample = (self.acked - self.sample_acked) * 1000.0 / (now - self.sample_at) as f64;
            self.rate = if self.rate != 0.0 {
                self.rate * 0.75 + sample * 0.25
            } else {
                sample
            };
            self.window = FLOW_MAX_WINDOW_CHARS.min(
                FLOW_MIN_WINDOW_CHARS.max(js_round(self.rate * FLOW_TARGET_DELAY_MS / 1000.0)),
            );
            self.sample_at = now;
            self.sample_acked = self.acked;
        }
        if self.pump(target) && !self.congested() {
            self.flush_coalesced(target, COMPRESSED_CONTEXT);
        }
        self.busy = self.in_flight() >= self.window / 2.0;
        true
    }
}

fn close_socket(target: &mut impl Target, close: Option<(u16, &str)>, context: &str) {
    if let Err(error) = target.close(close) {
        target.warn(format!(
            "[bridge] websocket close failed during {context}: {error}"
        ));
    }
}

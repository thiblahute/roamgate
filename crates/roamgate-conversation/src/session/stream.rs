//! A session's reply on its way to the browsers (`session-stream.ts`):
//! deltas sent together about once a frame, per block, and the reply text
//! sent so far of the turn that runs, for a browser that subscribes in the
//! middle of it (a reload). The timer is the session's: [`ReplyStream`]
//! only says when one is due ([`ReplyStream::delta`]) and which one is
//! current ([`ReplyStream::timer`]).

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::shared::Obj;

fn key_of(message_id: &str, index: &Value) -> String {
    format!("{message_id}:{}", roamgate_agents::js::to_text(index))
}

fn s(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

#[derive(Default)]
pub struct ReplyStream {
    /// Deltas waiting for about a frame, per block (`{message_id, index,
    /// text}`).
    pending: IndexMap<String, Obj>,
    /// The armed timer's number, if one is.
    timer: Option<u64>,
    timers: u64,
    /// The reply text the browsers were sent of the turn that runs, by
    /// block (`AgentChatStreamedText`).
    streamed: IndexMap<String, Obj>,
}

impl ReplyStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// The armed timer, if any: a flush it runs is due only while it is
    /// the current one.
    pub fn timer(&self) -> Option<u64> {
        self.timer
    }

    fn track(&mut self, event: &Obj) {
        match s(event.get("type")) {
            "delta" => {
                let key = key_of(s(event.get("message_id")), &event["index"]);
                if let Some(block) = self.streamed.get_mut(&key) {
                    let text = format!("{}{}", s(block.get("text")), s(event.get("text")));
                    block.insert("text".into(), Value::from(text));
                } else {
                    let block = json!({
                        "message_id": event["message_id"],
                        "index": event["index"],
                        "text": event["text"],
                        "done": false,
                    });
                    self.streamed.insert(key, into_obj(block));
                }
            }
            "block_stop" => {
                let key = key_of(s(event.get("message_id")), &event["index"]);
                if let Some(text) = event.get("text") {
                    let block = json!({
                        "message_id": event["message_id"],
                        "index": event["index"],
                        "text": text,
                        "done": true,
                    });
                    self.streamed.insert(key, into_obj(block));
                } else if let Some(block) = self.streamed.get_mut(&key) {
                    block.insert("done".into(), Value::Bool(true));
                }
            }
            "abandoned" => {
                let message_id = s(event.get("message_id")).to_owned();
                let from = event
                    .get("from_index")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                self.streamed.retain(|_, block| {
                    !(s(block.get("message_id")) == message_id
                        && block.get("index").and_then(Value::as_f64).unwrap_or(0.0) >= from)
                });
            }
            "result" | "session" => self.streamed.clear(),
            _ => {}
        }
    }

    /// The deltas that wait now, as events, in order; the timer is
    /// disarmed. `muted`: tracked, not returned.
    pub fn flush(&mut self, muted: bool) -> Vec<Obj> {
        self.timer = None;
        let mut out = Vec::new();
        for (_, delta) in std::mem::take(&mut self.pending) {
            let mut event = Obj::new();
            event.insert("type".into(), Value::from("delta"));
            event.extend(delta);
            self.track(&event);
            if !muted {
                out.push(event);
            }
        }
        out
    }

    /// An event to send, after the deltas waiting before it: what goes to
    /// the browsers, in order (nothing while muted).
    pub fn emit(&mut self, event: Obj, muted: bool) -> Vec<Obj> {
        let mut out = self.flush(muted);
        self.track(&event);
        if !muted {
            out.push(event);
        }
        out
    }

    /// A delta of reply text, sent with the others of its frame: the
    /// number of a timer to arm when none is.
    pub fn delta(&mut self, message_id: &str, index: &Value, text: &str) -> Option<u64> {
        let key = key_of(message_id, index);
        if let Some(held) = self.pending.get_mut(&key) {
            let joined = format!("{}{text}", s(held.get("text")));
            held.insert("text".into(), Value::from(joined));
        } else {
            let mut delta = Obj::new();
            delta.insert("message_id".into(), Value::from(message_id));
            delta.insert("index".into(), index.clone());
            delta.insert("text".into(), Value::from(text));
            self.pending.insert(key, delta);
        }
        if self.timer.is_some() {
            return None;
        }
        self.timers += 1;
        self.timer = Some(self.timers);
        self.timer
    }

    /// A retry's blocks: their deltas never reach the browser.
    pub fn drop_pending(&mut self, message_id: &str, from_index: f64) {
        self.pending.retain(|_, held| {
            !(s(held.get("message_id")) == message_id
                && held.get("index").and_then(Value::as_f64).unwrap_or(0.0) >= from_index)
        });
    }

    /// The reply text sent so far of the turn that runs, by block.
    pub fn streamed(&self) -> Vec<Obj> {
        self.streamed.values().cloned().collect()
    }

    /// The reply text so far, the deltas not sent yet included.
    pub fn snapshot(&self) -> Vec<Obj> {
        let mut blocks = self.streamed.clone();
        for (key, held) in &self.pending {
            if let Some(block) = blocks.get_mut(key) {
                let text = format!("{}{}", s(block.get("text")), s(held.get("text")));
                block.insert("text".into(), Value::from(text));
            } else {
                let block = json!({
                    "message_id": held["message_id"],
                    "index": held["index"],
                    "text": held["text"],
                    "done": false,
                });
                blocks.insert(key.clone(), into_obj(block));
            }
        }
        blocks.into_values().collect()
    }

    /// Takes up the reply text a reader before this one saved.
    pub fn restore(&mut self, blocks: &[Value]) {
        self.streamed.clear();
        for block in blocks {
            let Some(object) = block.as_object() else {
                continue;
            };
            let Some(message_id) = object.get("message_id").and_then(Value::as_str) else {
                continue;
            };
            let key = key_of(message_id, object.get("index").unwrap_or(&Value::Null));
            self.streamed.insert(key, object.clone());
        }
    }
}

fn into_obj(value: Value) -> Obj {
    match value {
        Value::Object(object) => object,
        _ => Obj::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deltas_of_a_block_go_as_one_with_the_streamed_text_kept() {
        let mut reply = ReplyStream::new();
        assert_eq!(reply.delta("m", &json!(0), "Hel"), Some(1));
        assert_eq!(reply.delta("m", &json!(0), "lo"), None);
        assert_eq!(
            reply.snapshot(),
            vec![into_obj(
                json!({"message_id": "m", "index": 0, "text": "Hello", "done": false})
            )]
        );
        let sent = reply.flush(false);
        assert_eq!(
            sent,
            vec![into_obj(
                json!({"type": "delta", "message_id": "m", "index": 0, "text": "Hello"})
            )]
        );
        assert_eq!(reply.timer(), None);
        let stop = into_obj(json!({"type": "block_stop", "message_id": "m", "index": 0}));
        reply.emit(stop, false);
        assert_eq!(
            reply.streamed(),
            vec![into_obj(
                json!({"message_id": "m", "index": 0, "text": "Hello", "done": true})
            )]
        );
        reply.emit(into_obj(json!({"type": "result"})), false);
        assert!(reply.streamed().is_empty());
    }
}

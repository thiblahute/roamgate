//! The feed and Web Push together (index.ts's `notifications` and
//! `webPush`): opened from their files when the family is owned, dropped
//! (Web Push's queue with it) when it is not, so that only the owner
//! writes `notifications.json` and `web-push.json`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use roamgate_base::clock::SharedClock;
use roamgate_base::paths::DataContext;
use serde_json::{Map, Value};

use crate::feed::{Change, Extra, Feed};
use crate::web_push::{Answer, IsCurrent, PushSender, WebPush};

/// Where the files are and how push is sent.
pub struct Options {
    pub context: DataContext,
    pub feed_path: PathBuf,
    pub push_path: PathBuf,
    /// The VAPID subject; empty disables push.
    pub subject: String,
    pub clock: SharedClock,
    pub sender: Arc<dyn PushSender>,
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
}

struct Running {
    feed: Feed,
    push: Arc<WebPush>,
}

/// The notifications of a server that owns them.
pub struct Notifications {
    options: Options,
    running: Mutex<Option<Running>>,
}

/// Not owned: nothing is read or written.
#[derive(Debug, Clone, PartialEq)]
pub struct NotOwned;

impl Notifications {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            running: Mutex::new(None),
        }
    }

    /// Starts owning the files: both read afresh (the other side may have
    /// written them).
    pub fn start(&self) {
        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.take() {
            previous.push.stop();
        }
        let options = &self.options;
        *running = Some(Running {
            feed: Feed::open(options.context.clone(), options.feed_path.clone()),
            push: WebPush::open(
                options.context.clone(),
                options.push_path.clone(),
                options.subject.clone(),
                options.clock.clone(),
                options.sender.clone(),
                options.warn.clone(),
            ),
        });
    }

    /// Stops owning them: Web Push's queue is dropped.
    pub fn stop(&self) {
        if let Some(running) = self.running.lock().unwrap().take() {
            running.push.stop();
        }
    }

    pub fn owned(&self) -> bool {
        self.running.lock().unwrap().is_some()
    }

    fn with<T>(&self, run: impl FnOnce(&mut Running) -> T) -> Result<T, NotOwned> {
        let mut running = self.running.lock().unwrap();
        running.as_mut().map(run).ok_or(NotOwned)
    }

    /// The feed as the front's copy holds it (`{version, last, events}`).
    pub fn state(&self) -> Result<Value, NotOwned> {
        self.with(|running| running.feed.saved().to_value())
    }

    /// One notification: kept, given to Web Push, and its events to send.
    pub fn publish(
        &self,
        task: &Map<String, Value>,
        extra: &Extra,
        android_connected: bool,
        is_current: Option<IsCurrent>,
    ) -> Result<(i64, Change), NotOwned> {
        let now = self.options.clock.now();
        let (result, push, payload) = self.with(|running| {
            let (event, payload, change) = running.feed.publish(task, extra, now);
            let id = event["id"].as_i64().unwrap_or(0);
            ((id, change), running.push.clone(), payload)
        })?;
        if result.1.save_failed {
            self.save_warning();
        }
        push.notify(task, &payload, android_connected, is_current);
        Ok(result)
    }

    fn save_warning(&self) {
        (self.options.warn)("Unable to save the notification feed; events stay in memory.");
    }

    fn change(&self, run: impl FnOnce(&mut Feed, i64) -> Change) -> Result<Change, NotOwned> {
        let now = self.options.clock.now();
        let change = self.with(|running| run(&mut running.feed, now))?;
        if change.save_failed {
            self.save_warning();
        }
        Ok(change)
    }

    pub fn clear_tag(&self, tag: &str) -> Result<Change, NotOwned> {
        self.change(|feed, now| feed.clear_tag(tag, now))
    }

    pub fn clear_pane(&self, connection_id: &str, pane_id: &str) -> Result<Change, NotOwned> {
        self.change(|feed, now| feed.clear_pane(connection_id, pane_id, now))
    }

    pub fn clear_blocked_pane(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> Result<Change, NotOwned> {
        self.change(|feed, now| feed.clear_blocked_pane(connection_id, pane_id, now))
    }

    pub fn clear_prompt(&self, prompt_id: &str) -> Result<Change, NotOwned> {
        self.change(|feed, now| feed.clear_prompt(prompt_id, now))
    }

    /// The feed's numbers for `bridge.notifications.status`.
    pub fn counts(&self) -> Result<(i64, usize), NotOwned> {
        self.with(|running| {
            let saved = running.feed.saved();
            (saved.last, saved.events.len())
        })
    }

    /// The enrollment route.
    pub fn http(
        &self,
        method: &str,
        header: &dyn Fn(&str) -> Option<String>,
        body: Option<&[u8]>,
    ) -> Result<Answer, NotOwned> {
        let push = self.with(|running| running.push.clone())?;
        Ok(push.handle(method, header, body))
    }

    /// Web Push now (tests and the data checks).
    pub fn web_push(&self) -> Option<Arc<WebPush>> {
        self.with(|running| running.push.clone()).ok()
    }
}

//! The conversations whose process cannot be read or whose holder is gone
//! (`service-recover.ts`): what was queued meanwhile, kept aside; reading
//! again those a runtime before this one owned; and Recover.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use indexmap::IndexSet;
use roamgate_agents::js;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::{Inner, obj_of, sv};
use crate::driver::BoxFuture;
use crate::holder::resume_reply;
use crate::shared::{Obj, lease_headless_ids, lease_str};
use crate::time::sleep_ms;

type Recovering = Shared<BoxFuture<'static, bool>>;

pub(crate) struct RecoveryState {
    pub(crate) parked: Mutex<HashMap<String, Vec<Obj>>>,
    recovering: Mutex<HashMap<String, Recovering>>,
    pub(crate) lost: Mutex<HashMap<String, Obj>>,
    pub(crate) unread: Mutex<IndexSet<String>>,
    reattaching: Mutex<HashSet<String>>,
    slots: Arc<Semaphore>,
}

impl RecoveryState {
    pub(crate) fn new(unread: IndexSet<String>, limit: usize) -> Self {
        Self {
            parked: Mutex::new(HashMap::new()),
            recovering: Mutex::new(HashMap::new()),
            lost: Mutex::new(HashMap::new()),
            unread: Mutex::new(unread),
            reattaching: Mutex::new(HashSet::new()),
            slots: Arc::new(Semaphore::new(limit.max(1))),
        }
    }
}

fn ids_of(lease: &Obj) -> Vec<String> {
    let mut ids = vec![lease_str(lease, "session_id").unwrap_or("").to_owned()];
    for id in lease_headless_ids(lease) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn queue_of(lease: &Obj) -> Vec<Obj> {
    lease
        .get("queue")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

impl Inner {
    /// The chat says the conversation process cannot be read, and why.
    pub(crate) fn set_lost(&self, pane_id: &str, reason: &str) {
        if self.closed() || !self.owns(pane_id) {
            return;
        }
        let next = {
            let mut lost = self.recovery.lost.lock().unwrap();
            if lost
                .get(pane_id)
                .is_some_and(|current| sv(current.get("reason")) == reason)
            {
                return;
            }
            let at = lost
                .get(pane_id)
                .and_then(|current| current.get("at").cloned())
                .unwrap_or_else(|| json!(js::iso(self.now() as f64)));
            let next = obj_of(json!({"at": at, "reason": reason}));
            lost.insert(pane_id.to_owned(), next.clone());
            next
        };
        self.log(
            "the conversation process is lost",
            json!({"pane": pane_id, "reason": reason}),
        );
        self.emit(
            pane_id,
            obj_of(json!({"type": "lost", "lost": Value::Object(next)})),
        );
    }

    pub(crate) fn clear_lost(&self, pane_id: &str) {
        if self.recovery.lost.lock().unwrap().remove(pane_id).is_none() {
            return;
        }
        self.emit(pane_id, obj_of(json!({"type": "lost", "lost": null})));
    }

    /// What waited while the terminal had the session goes out now.
    pub(crate) fn carry_parked(&self, pane_id: &str) {
        let waiting = self.recovery.parked.lock().unwrap().get(pane_id).cloned();
        let Some(waiting) = waiting.filter(|waiting| !waiting.is_empty()) else {
            return;
        };
        let Some(lease) = self.lease(pane_id) else {
            return;
        };
        if lease_str(&lease, "phase") != Some("conversation") {
            return;
        }
        self.recovery.parked.lock().unwrap().remove(pane_id);
        if let Some(session) = self.session(pane_id) {
            for item in waiting {
                let session = session.clone();
                tokio::spawn(async move {
                    let images: Vec<String> = item
                        .get("images")
                        .and_then(Value::as_array)
                        .map(|images| {
                            images
                                .iter()
                                .filter_map(|image| image.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    let _ = session
                        .send(
                            sv(item.get("text")),
                            images,
                            Some(sv(item.get("id")).to_owned()),
                        )
                        .await;
                });
            }
            return;
        }
        let mut queue = queue_of(&lease);
        queue.extend(waiting);
        let mut next = lease;
        next.insert(
            "queue".into(),
            Value::Array(queue.into_iter().map(Value::Object).collect()),
        );
        self.set_lease(next);
    }

    fn emit_parked(&self, pane_id: &str) {
        let queue = self
            .recovery
            .parked
            .lock()
            .unwrap()
            .get(pane_id)
            .cloned()
            .unwrap_or_default();
        self.emit(
            pane_id,
            obj_of(json!({
                "type": "queue",
                "queue": Value::Array(queue.into_iter().map(Value::Object).collect()),
            })),
        );
    }

    pub(crate) fn park(&self, pane_id: &str, item: Obj) {
        self.recovery
            .parked
            .lock()
            .unwrap()
            .entry(pane_id.to_owned())
            .or_default()
            .push(item);
        self.emit_parked(pane_id);
    }

    pub(crate) fn edit_parked(&self, pane_id: &str, id: &str, text: &str) -> bool {
        {
            let mut parked = self.recovery.parked.lock().unwrap();
            let Some(item) = parked
                .get_mut(pane_id)
                .and_then(|items| items.iter_mut().find(|item| sv(item.get("id")) == id))
            else {
                return false;
            };
            item.insert("text".into(), json!(js::trim(text)));
        }
        self.emit_parked(pane_id);
        true
    }

    pub(crate) fn remove_parked(&self, pane_id: &str, id: &str) -> Option<Obj> {
        let item = {
            let mut parked = self.recovery.parked.lock().unwrap();
            let items = parked.get_mut(pane_id)?;
            let at = items.iter().position(|item| sv(item.get("id")) == id)?;
            let item = items.remove(at);
            if items.is_empty() {
                parked.remove(pane_id);
            }
            item
        };
        self.emit_parked(pane_id);
        Some(item)
    }

    /// Once the current call is done with the pane, checks whether the
    /// holder is gone, and recovers if so.
    pub(crate) fn recover_later(&self, pane_id: &str) -> Recovering {
        let mut recovering = self.recovery.recovering.lock().unwrap();
        if let Some(pending) = recovering.get(pane_id) {
            return pending.clone();
        }
        let me = self.me();
        let pane = pane_id.to_owned();
        let future: BoxFuture<'static, bool> = Box::pin(async move {
            tokio::task::yield_now().await;
            let gone = me.recover_holder_gone(&pane).await;
            me.recovery.recovering.lock().unwrap().remove(&pane);
            gone
        });
        let shared = future.shared();
        recovering.insert(pane_id.to_owned(), shared.clone());
        shared
    }

    /// The pane holder is gone and nothing headless works on the session:
    /// the lease falls back to the terminal, with what was queued kept.
    async fn recover_holder_gone(&self, pane_id: &str) -> bool {
        let Some(lease) = self.lease(pane_id) else {
            return false;
        };
        if self.closed() || lease_str(&lease, "phase") != Some("conversation") {
            return false;
        }
        let unheld = || {
            self.session(pane_id).is_some_and(|session| session.alive())
                && !self.has_channel(pane_id)
        };
        if self.handover.running(pane_id) || unheld() {
            return false;
        }
        if !self.holder_gone(pane_id).await {
            return false;
        }
        let ids = ids_of(&lease);
        if self
            .options
            .herdr
            .headless_running(&ids)
            .await
            .unwrap_or(true)
        {
            return false;
        }
        if self.closed()
            || self.lease(pane_id).as_ref() != Some(&lease)
            || self.handover.running(pane_id)
            || self.holders.connected(pane_id, None, None)
            || unheld()
        {
            return false;
        }
        let mut queued = self
            .recovery
            .parked
            .lock()
            .unwrap()
            .get(pane_id)
            .cloned()
            .unwrap_or_default();
        queued.extend(queue_of(&lease));
        let orphan = self.sessions.lock().unwrap().remove(pane_id);
        if let Some(orphan) = &orphan {
            queued.extend(orphan.take_queue());
            orphan.dispose(true);
        }
        self.drop_channel(pane_id);
        self.clear_stuck(pane_id);
        self.log(
            "the pane holder is gone; the terminal has the session",
            json!({"pane": pane_id, "queued": queued.len()}),
        );
        self.recovery.unread.lock().unwrap().shift_remove(pane_id);
        self.delete_lease(pane_id);
        let any = !queued.is_empty();
        if any {
            self.recovery
                .parked
                .lock()
                .unwrap()
                .insert(pane_id.to_owned(), queued);
        }
        self.emit_lease(pane_id);
        if any {
            self.emit_parked(pane_id);
        }
        true
    }

    /// Recovers a conversation whose process cannot be read.
    pub(crate) async fn recover(&self, pane_id: &str) -> Result<(), String> {
        if !self.owns(pane_id) {
            return Err("Conversation mode does not own this session".into());
        }
        if self.handover.running(pane_id) {
            return Err("The session is being handed over".into());
        }
        if !self.holders.connected(pane_id, None, None) {
            if self.recover_later(pane_id).await {
                return Ok(());
            }
            return Err("The pane holder is not connected; try again once it is".into());
        }
        let Some(channel) = self
            .channel(pane_id)
            .filter(|channel| channel.holder_id().is_some())
        else {
            return Err("The pane holder is not connected".into());
        };
        let mut fields = json!({"pane": pane_id});
        if let Some(lost) = self.recovery.lost.lock().unwrap().get(pane_id) {
            fields["reason"] = lost.get("reason").cloned().unwrap_or(Value::Null);
        }
        self.log("recovering the conversation process", fields);
        if let Err(error) = channel
            .abandon(
                self.options.hold_poll_ms + self.options.recover_wait_ms,
                None,
            )
            .await
        {
            if error.stuck {
                return self.restart_through_terminal(pane_id, &error.message).await;
            }
            self.set_lost(pane_id, &error.message);
            return Err(error.message);
        }
        if self.closed() || !self.owns(pane_id) {
            return Err("Conversation mode does not own this session".into());
        }
        self.recovery.unread.lock().unwrap().shift_remove(pane_id);
        self.clear_lost(pane_id);
        self.clear_stuck(pane_id);
        if self
            .lease(pane_id)
            .is_some_and(|lease| lease.contains_key("turn_started_at"))
        {
            self.mark_turn(pane_id, "restart");
        }
        self.start_again(pane_id).await
    }

    /// Starts the process a recover ends with, or the chat says why not.
    pub(crate) async fn start_again(&self, pane_id: &str) -> Result<(), String> {
        let result = match self.session_for(pane_id) {
            Ok(session) => session.warm().await,
            Err(error) => Err(error),
        };
        result.map_err(|error| {
            let reason = format!("Claude did not start again: {error}");
            self.log(
                "conversation process did not start",
                json!({"pane": pane_id, "reason": reason}),
            );
            self.set_lost(pane_id, &reason);
            reason
        })
    }

    /// The holder cannot end its child: claude resumes in the terminal, and
    /// conversation mode takes the session over again.
    async fn restart_through_terminal(&self, pane_id: &str, why: &str) -> Result<(), String> {
        let Some(lease) = self
            .lease(pane_id)
            .filter(|lease| lease_str(lease, "phase") == Some("conversation"))
        else {
            return Err("Conversation mode does not own this session".into());
        };
        let ids = ids_of(&lease);
        if self
            .options
            .herdr
            .headless_running(&ids)
            .await
            .unwrap_or(true)
        {
            let reason = format!(
                "{why}, and a conversation process still runs on the session; end it on the host, then recover again"
            );
            self.set_lost(pane_id, &reason);
            return Err(reason);
        }
        if self.closed()
            || self.lease(pane_id).as_ref() != Some(&lease)
            || self.handover.running(pane_id)
        {
            return Err("The session changed meanwhile; try again".into());
        }
        let mut queued = self
            .recovery
            .parked
            .lock()
            .unwrap()
            .get(pane_id)
            .cloned()
            .unwrap_or_default();
        queued.extend(queue_of(&lease));
        let orphan = self.sessions.lock().unwrap().remove(pane_id);
        if let Some(orphan) = &orphan {
            queued.extend(orphan.take_queue());
        }
        self.log(
            "the pane holder cannot end its process; Claude restarts",
            json!({"pane": pane_id, "queued": queued.len()}),
        );
        if let Some(orphan) = orphan {
            orphan.dispose(true);
        }
        self.drop_channel(pane_id);
        self.recovery.unread.lock().unwrap().shift_remove(pane_id);
        self.clear_lost(pane_id);
        self.clear_stuck(pane_id);
        self.delete_lease(pane_id);
        {
            let mut parked = self.recovery.parked.lock().unwrap();
            if queued.is_empty() {
                parked.remove(pane_id);
            } else {
                parked.insert(pane_id.to_owned(), queued);
            }
        }
        self.emit_lease(pane_id);
        self.emit_parked(pane_id);
        let profile = self.resume_profile(lease_str(&lease, "session_id").unwrap_or(""));
        self.holders.send(
            pane_id,
            &resume_reply(&lease, profile.as_ref(), &self.options.drivers),
        );
        let mut reason = "Claude did not come back in the terminal".to_owned();
        for _ in 0..self.options.recover_attempts {
            if self.closed() {
                break;
            }
            sleep_ms(&*self.options.clock, self.options.recover_retry_ms).await;
            if self.closed() {
                break;
            }
            if self.owns(pane_id) {
                return self.start_again(pane_id).await;
            }
            let result = self.to_conversation(pane_id, None, None).await;
            if result.get("ok") == Some(&Value::Bool(true)) {
                return self.start_again(pane_id).await;
            }
            reason = sv(result.get("reason")).to_owned();
        }
        let waiting = self
            .recovery
            .parked
            .lock()
            .unwrap()
            .get(pane_id)
            .map_or(0, Vec::len);
        Err(format!(
            "Claude restarted in the terminal, but the chat could not take it over again ({reason}){}",
            if waiting > 0 {
                "; the queued messages wait for it"
            } else {
                ""
            }
        ))
    }

    /// Reads again what the holder runs for a session a runtime before this
    /// one owned (`reattach`).
    pub(crate) fn reattach(&self, pane_id: &str) {
        if self.closed()
            || !self
                .recovery
                .reattaching
                .lock()
                .unwrap()
                .insert(pane_id.to_owned())
        {
            return;
        }
        let me = self.me();
        let pane = pane_id.to_owned();
        tokio::spawn(async move {
            let slot = me.recovery.slots.clone().acquire_owned().await;
            let cut_short = |me: &Inner| {
                if me.session(&pane).is_some_and(|session| session.alive()) {
                    return;
                }
                if me
                    .lease(&pane)
                    .is_some_and(|lease| lease.contains_key("turn_started_at"))
                {
                    me.mark_turn(&pane, "restart");
                }
            };
            let result: Result<(), String> = async {
                if me.closed() {
                    return Ok(());
                }
                let session = me.session_for(&pane)?;
                let attached = session.attach().await?;
                me.recovery.unread.lock().unwrap().shift_remove(&pane);
                me.clear_lost(&pane);
                if attached {
                    return Ok(());
                }
                cut_short(&me);
                if session.queue_length() > 0 {
                    session.warm().await?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                me.log(
                    "conversation process not read again",
                    json!({"pane": pane, "error": error}),
                );
                if me.lease(&pane).is_none() || me.holder_gone(&pane).await {
                    me.recovery.unread.lock().unwrap().shift_remove(&pane);
                    cut_short(&me);
                    let later = me.recover_later(&pane);
                    tokio::spawn(later);
                } else if me.holders.connected(&pane, None, None) {
                    me.set_lost(&pane, &error);
                }
            }
            drop(slot);
            me.recovery.reattaching.lock().unwrap().remove(&pane);
        });
    }

    /// Owned panes whose holder stopped polling (`holderWatch`).
    pub(crate) async fn watch_holders(&self) {
        for lease in self.options.leases.all() {
            let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
            if lease_str(&lease, "phase") == Some("conversation")
                && !self.handover.running(&pane)
                && !self.holders.connected(
                    &pane,
                    Some(self.options.hold_poll_ms as i64 + 10_000),
                    None,
                )
            {
                let later = self.recover_later(&pane);
                tokio::spawn(later);
            }
        }
    }
}

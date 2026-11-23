//! A remembered answer (review/memo.ts `memo`): shared while it is asked,
//! then for its TTL; a failure is forgotten at once, so that the next
//! caller asks again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_base::clock::{BoxFuture, SharedClock};

type Flight<T> = Shared<BoxFuture<Result<T, String>>>;

struct Entry<T> {
    id: u64,
    /// Epoch ms it stands until; `i64::MAX` while it is asked.
    until: i64,
    value: Flight<T>,
}

struct Map<T> {
    next: u64,
    entries: HashMap<String, Entry<T>>,
}

impl<T> Default for Map<T> {
    fn default() -> Self {
        Self {
            next: 0,
            entries: HashMap::new(),
        }
    }
}

/// Answers by key.
pub struct Memo<T> {
    map: Arc<Mutex<Map<T>>>,
}

impl<T> Clone for Memo<T> {
    fn clone(&self) -> Self {
        Self {
            map: self.map.clone(),
        }
    }
}

impl<T> Default for Memo<T> {
    fn default() -> Self {
        Self {
            map: Arc::default(),
        }
    }
}

impl<T: Clone + Send + Sync + 'static> Memo<T> {
    /// `load`'s answer for `key`, shared by every caller until it settles
    /// and then for what `ttl` says of it (ms).
    pub fn get(
        &self,
        clock: &SharedClock,
        key: &str,
        ttl: impl Fn(&T) -> i64 + Send + 'static,
        load: impl FnOnce() -> BoxFuture<Result<T, String>>,
    ) -> BoxFuture<Result<T, String>> {
        let now = clock.now();
        let mut map = self.map.lock().unwrap();
        if let Some(entry) = map.entries.get(key)
            && entry.until > now
        {
            return Box::pin(entry.value.clone());
        }
        map.next += 1;
        let id = map.next;
        let loading = load();
        let shared = self.map.clone();
        let clock = clock.clone();
        let owned = key.to_owned();
        let task: BoxFuture<Result<T, String>> = Box::pin(async move {
            let result = loading.await;
            let mut map = shared.lock().unwrap();
            let mine = map.entries.get(&owned).is_some_and(|entry| entry.id == id);
            match &result {
                Ok(value) if mine => {
                    let until = clock.now() + ttl(value);
                    if let Some(entry) = map.entries.get_mut(&owned) {
                        entry.until = until;
                    }
                }
                Err(_) if mine => {
                    map.entries.remove(&owned);
                }
                _ => {}
            }
            result
        });
        let value = task.shared();
        map.entries.insert(
            key.to_owned(),
            Entry {
                id,
                until: i64::MAX,
                value: value.clone(),
            },
        );
        Box::pin(value)
    }

    /// Drops the expired answers once there are more than `limit`
    /// (forge.ts `remember`: the map stays small).
    pub fn prune(&self, clock: &SharedClock, key: &str, limit: usize) {
        let now = clock.now();
        let mut map = self.map.lock().unwrap();
        if map.entries.len() > limit && !map.entries.get(key).is_some_and(|entry| entry.until > now)
        {
            map.entries.retain(|_, entry| entry.until > now);
        }
    }
}

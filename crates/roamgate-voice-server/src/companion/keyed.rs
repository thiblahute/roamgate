//! The keyed singleton of the companion's `configured*` factories (the
//! cleaner, router, research, dictation, front and tools): one instance
//! kept while its key (model, command...) stays the same, the old one
//! stopped when it changes.

use std::sync::Mutex;

pub struct Keyed<T: Clone> {
    current: Mutex<Option<(String, Option<T>)>>,
}

impl<T: Clone> Default for Keyed<T> {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

impl<T: Clone> Keyed<T> {
    /// The instance for `key`: the one kept when the key is the same, else
    /// `make()`'s (None for none), the old one stopped.
    pub fn get(&self, key: &str, make: impl FnOnce() -> Option<T>, stop: impl Fn(&T)) -> Option<T> {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().map(|(k, _)| k.as_str()) != Some(key) {
            if let Some((_, Some(old))) = current.take() {
                stop(&old);
            }
            *current = Some((key.to_owned(), make()));
        }
        current.as_ref().and_then(|(_, value)| value.clone())
    }

    /// The instance kept now, if any.
    pub fn peek(&self) -> Option<T> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|(_, value)| value.clone())
    }
}

//! A file written behind its changes (`dataFileWriter` of
//! `config/data-paths.ts`): changes made one after another go in one
//! write, off the caller, and `flush` waits for the file to be as it is
//! now. Without a tokio runtime the write is made at once.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use roamgate_base::paths::DataContext;
use tokio::sync::Notify;

/// What the file holds, made when it is written.
pub type Contents = Box<dyn Fn() -> String + Send + Sync>;

struct State {
    next: Option<Arc<Contents>>,
    writing: bool,
}

pub struct BehindWriter {
    path: PathBuf,
    data: DataContext,
    mode: u32,
    state: Mutex<State>,
    done: Notify,
}

impl BehindWriter {
    pub fn new(path: PathBuf, data: DataContext) -> Arc<Self> {
        Arc::new(Self {
            path,
            data,
            mode: 0o600,
            state: Mutex::new(State {
                next: None,
                writing: false,
            }),
            done: Notify::new(),
        })
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Asks for a write of what `contents` makes then.
    pub fn write(self: &Arc<Self>, contents: Contents) {
        let contents = Arc::new(contents);
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            // Kept in memory if it fails; the next change writes it again.
            let _ = self
                .data
                .replace_data_file(&self.path, contents().as_bytes(), self.mode);
            return;
        };
        let start = {
            let mut state = self.state.lock().unwrap();
            state.next = Some(contents);
            !std::mem::replace(&mut state.writing, true)
        };
        if start {
            let writer = self.clone();
            handle.spawn(async move { writer.drain().await });
        }
    }

    async fn drain(self: Arc<Self>) {
        // Changes made in this same run of code go in the first write.
        tokio::task::yield_now().await;
        loop {
            let next = {
                let mut state = self.state.lock().unwrap();
                match state.next.take() {
                    Some(next) => next,
                    None => {
                        state.writing = false;
                        drop(state);
                        self.done.notify_waiters();
                        return;
                    }
                }
            };
            let text = next();
            let _ = self
                .data
                .replace_data_file_async(&self.path, text.into_bytes(), self.mode)
                .await;
        }
    }

    /// Waits until what was asked for is written.
    pub async fn flush(&self) {
        loop {
            let notified = self.done.notified();
            if !self.state.lock().unwrap().writing {
                return;
            }
            notified.await;
        }
    }
}

//! The voice companion layer (`server/src/voice`'s turn causes, answers,
//! waiting answers, images, YouTube, memory, taste, errands,
//! research, router, cleaner, dictation, front and tools): plain structs
//! and functions the voice socket and HTTP routes call, the Claude-driven
//! parts behind [`claude::ClaudeProcess`].

pub mod answers;
pub mod claude;
pub mod cleaner;
pub mod dictation;
pub mod errands;
pub mod front;
pub mod images;
pub mod keyed;
pub mod memory;
pub mod memory_files;
pub mod research;
pub mod router;
pub mod seam;
pub mod taste;
pub mod test_env;
pub mod tools;
pub mod turn_causes;
pub mod waiting;
pub mod youtube;

use std::path::Path;
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use roamgate_base::env::ProcessEnv;
use roamgate_base::json_store::WriteBehindFile;
use roamgate_base::paths::DataContext;

/// A companion file rewritten whole, written behind by roamgate-base's
/// writer: off the async runtime's threads, at once, the changes made
/// while one is written coalesced into the next. Its owner keeps the value
/// in memory; `flush` it before reading the file.
pub(crate) fn written_behind(path: &Path, clock: SharedClock) -> WriteBehindFile {
    WriteBehindFile::new(
        DataContext::from_env(&ProcessEnv),
        path,
        0o600,
        clock,
        Duration::ZERO,
    )
}

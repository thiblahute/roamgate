//! The voice companion layer (`server/src/voice`'s turn causes, answers,
//! waiting answers, images, YouTube, memory, taste, errands,
//! research, router, cleaner, dictation, front and tools): plain structs
//! and functions the voice socket and HTTP routes call, the Claude-driven
//! parts behind [`claude::ClaudeProcess`].

pub mod answers;
pub mod claude;
pub mod cleaner;
pub mod images;
pub mod keyed;
pub mod test_env;
pub mod turn_causes;
pub mod waiting;

//! An agent's long answer, for the voice companion (`voice/voice-answers.ts`):
//! given whole, it would fill the front's context, and cut, it leaves the
//! front with the start only. So an answer longer than
//! [`LONG_ANSWER_CHARS`] is written whole to a file of [`answers_dir`] and
//! the front is given its start, the file's path and its length: it reads
//! the file (Read, confined to that folder) when it needs more. Files older
//! than a day go when a new one is written.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::companion::images::upload_root;
use crate::js::{len16, slice16};

/// Past this, an answer reaches the front as its start and a file.
pub const LONG_ANSWER_CHARS: usize = 4000;
/// Of a long answer, about this much is given inline.
const START_CHARS: usize = 3000;
/// Far beyond any real answer: past this, the rest is dropped.
pub const MAX_ANSWER_CHARS: usize = 1_000_000;
/// How long an answer's file is kept.
pub const ANSWER_FILE_MS: f64 = 24.0 * 60.0 * 60_000.0;

/// Where long answers are written: the voice uploads' folder.
pub fn answers_dir(root: &Path) -> PathBuf {
    root.join("voice-answers")
}

/// The default answers' folder, under [`upload_root`].
pub fn default_answers_dir() -> PathBuf {
    answers_dir(&upload_root())
}

/// The answers' folder, made (only the user reads it).
pub fn ensure_answers_dir(dir: &Path) -> std::io::Result<()> {
    roamgate_base::private::create_dir_all_mode(dir)?;
    // Not ours to change: it still works.
    let _ = roamgate_base::private::set_mode(dir, 0o700);
    Ok(())
}

/// The UTF-16 offset of the last `needle` in `text`, as `lastIndexOf`.
fn last_index16(text: &str, needle: &str) -> Option<usize> {
    text.rfind(needle).map(|at| len16(&text[..at]))
}

/// The start of `text`, cut where a paragraph or a sentence ends.
pub fn answer_start(text: &str, chars: usize) -> String {
    if len16(text) <= chars {
        return text.to_owned();
    }
    let head = slice16(text, 0, Some(chars as i64));
    let half = chars as f64 / 2.0;
    if let Some(paragraph) = last_index16(&head, "\n\n")
        && paragraph as f64 > half
    {
        return crate::js::trim_end(&slice16(&head, 0, Some(paragraph as i64))).to_owned();
    }
    let sentence = [". ", ".\n", "? ", "! "]
        .iter()
        .filter_map(|needle| last_index16(&head, needle))
        .max();
    if let Some(sentence) = sentence
        && sentence as f64 > half
    {
        return slice16(&head, 0, Some(sentence as i64 + 1));
    }
    crate::js::trim_end(&head).to_owned()
}

fn sweep(dir: &Path, now: f64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
            continue;
        };
        let mtime = modified
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if now - mtime > ANSWER_FILE_MS {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// What the front is given of an agent's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontAnswer {
    pub text: String,
    /// Where it is whole, when it was too long to give.
    pub file: Option<PathBuf>,
}

fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    std::fs::write(file, text)?;
    roamgate_base::private::set_mode(file, 0o600)
}

/// What the front is given of an agent's answer: the answer itself, or,
/// past [`LONG_ANSWER_CHARS`], its start and where it is whole (`file`).
/// The same answer told twice keeps its file.
pub fn answer_for_front(answer: &str, dir: &Path, now: f64) -> FrontAnswer {
    let text = slice16(answer, 0, Some(MAX_ANSWER_CHARS as i64));
    let length = len16(&text);
    if length <= LONG_ANSWER_CHARS {
        return FrontAnswer { text, file: None };
    }
    let written = (|| -> std::io::Result<PathBuf> {
        ensure_answers_dir(dir)?;
        sweep(dir, now);
        let digest = hex::encode(Sha256::digest(text.as_bytes()));
        let file = dir.join(format!("answer-{}.md", &digest[..16]));
        write_private(&file, &text)?;
        Ok(file)
    })();
    match written {
        Ok(file) => FrontAnswer {
            text: format!(
                "{}\n\n[The answer goes on: {length} characters in all, given here only to that point. It is whole in {}: Read it there when you need more.]",
                answer_start(&text, START_CHARS),
                file.display()
            ),
            file: Some(file),
        },
        // No file: the start, said to be one.
        Err(_) => FrontAnswer {
            text: format!(
                "{}\n\n[The answer goes on: {length} characters in all; only this start is given.]",
                answer_start(&text, START_CHARS)
            ),
            file: None,
        },
    }
}

#[cfg(test)]
mod tests;

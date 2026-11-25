//! `roamgate node --stdio`: the home's link to this machine's node over
//! ssh (phase 2), served on stdin and stdout.

/// Serves the link until stdin closes; returns the exit code.
pub async fn run_stdio(_args: &[String]) -> u8 {
    eprintln!("roamgate node: --stdio is not available in this build");
    2
}

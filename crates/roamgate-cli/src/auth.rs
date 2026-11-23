//! `roamgate auth` (cli/auth.ts): stub, being ported.

use crate::args::Failure;
use crate::context::CliContext;
use crate::index::Outcome;

pub async fn run(_args: &[String], _context: &CliContext) -> Result<Outcome, Failure> {
    Err(Failure::Failed("not ported yet".into()))
}

//! Who a command is for (bridge/ssh-sessions.ts `SshLane`): interactive
//! work, the default, is what the user waits on; background work (badges,
//! polls, prefetches) yields to it and is shed rather than failed loudly.
//! The lane is a task local, as the TS kept it in an AsyncLocalStorage:
//! every command started inside [`run_in_lane`] runs in that lane.
//!
//! Long-lived sessions (file streams, bridges) are not a lane: they are
//! held, not queued (the `longLived` option of holdSshSession).

use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Lane {
    #[default]
    Interactive,
    Background,
}

tokio::task_local! {
    static LANE: Lane;
}

/// Runs `future`, and every command it starts, in `lane`.
pub async fn run_in_lane<F: Future>(lane: Lane, future: F) -> F::Output {
    LANE.scope(lane, future).await
}

/// The lane of the work running now: interactive unless said otherwise.
pub fn current_lane() -> Lane {
    LANE.try_with(|lane| *lane).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lanes_follow_the_work_they_scope() {
        assert_eq!(current_lane(), Lane::Interactive);
        let inner = run_in_lane(Lane::Background, async {
            let nested = run_in_lane(Lane::Interactive, async { current_lane() }).await;
            (current_lane(), nested)
        })
        .await;
        assert_eq!(inner, (Lane::Background, Lane::Interactive));
        assert_eq!(current_lane(), Lane::Interactive);
    }
}
